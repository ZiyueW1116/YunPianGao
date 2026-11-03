"""固定版本 Hermes 嵌入入口：串行宿主轮次，独立的核心调度与执行。"""
import asyncio
import copy
import hashlib
import json
import math
import threading
import uuid

from agent.context_compressor import ContextCompressor
from run_agent import AIAgent
from agent.conversation_compression_manual import CompressRequest, compress_now
from agent.conversation_compression import finalize_context_engine_compression_notification
from agent.prepared_compaction import _worker_copy
from agent.subagent_lifecycle import SubagentLaunchRequest, SubagentLifecycleService
from tools.process_registry import process_registry

from .bridge import CoreBridge
from .context import PreparedEngine
from .tasks import ChildTask, ProcessTask


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False, default=str).encode()).hexdigest()


class HermesAgent(AIAgent):
    def __init__(self, **options):
        self.ypg_closed = False
        self.ypg_owner = None
        try:
            super().__init__(**options)
        except BaseException:
            self.close()
            raise

    def close(self):
        if self.ypg_closed:
            return
        self.ypg_closed = True
        if self.ypg_owner is not None:
            self.ypg_owner.invalidate()
        super().close()

    def reset_session_state(self, *args, **kwargs):
        if self.ypg_owner is not None:
            self.ypg_owner.invalidate()
        return super().reset_session_state(*args, **kwargs)


class HermesSession:
    def __init__(self):
        self.loop = asyncio.get_running_loop()
        self.closed = False
        self._closing = None
        self.agent = None
        self.core = None
        self._opened = False
        self._owned_db = None
        self.history = []
        self.epoch = self.model_epoch = 0
        self.parked = None
        self.committing = False
        self.candidate = None
        self.latest = None
        self.sources = {}
        self.accepted = set()
        self.wait_versions = {}
        self._tools = set()
        self._runs = set()
        self._native_tasks = set()
        self._queue = asyncio.Lock()
        # 输入接纳与原生压缩事务共用此锁；准备阶段不持有它。
        self._commit_lock = threading.Lock()
        self.events = asyncio.Queue()
        self.errors = []
        self._closed_snapshot = {"tasks": [], "waits": []}

    @classmethod
    async def create(cls, agent_options=None, *, scheduling=None, poll_interval_ms=500, node="node", core_path=None):
        self = cls()
        options = dict(agent_options or {})
        if options.get("session_id") in (None, ""):
            options["session_id"] = "ypg-hermes-" + uuid.uuid4().hex
        if not isinstance(options["session_id"], str):
            raise TypeError("session_id 必须是字符串或 None。")
        options.setdefault("skip_memory", True)
        options.setdefault("skip_background_review", True)
        if not options["skip_memory"] or not options["skip_background_review"]:
            raise ValueError("Hermes 首版入口要求关闭独立记忆与后台复盘。")
        self.session_id = options["session_id"]
        try:
            self.core = await CoreBridge.create(self._dispatch, node=node, core=core_path)
            await self.core.request("open", {"sessionID": self.session_id, "scheduling": scheduling or {}, "pollIntervalMs": poll_interval_ms})
            self._opened = True
            if options.get("session_db") is None:
                from hermes_state_registry import acquire
                acquiring = asyncio.create_task(asyncio.to_thread(acquire))
                try:
                    self._owned_db = await asyncio.shield(acquiring)
                except asyncio.CancelledError:
                    self._owned_db = await acquiring
                    raise
                options["session_db"] = self._owned_db
            creation = asyncio.create_task(asyncio.to_thread(HermesAgent, **options))
            try:
                self.agent = await asyncio.shield(creation)
            except asyncio.CancelledError:
                self.agent = await creation
                raise
            from agent.turn_tool_round import RUNTIME_BOUNDARY_CONTRACT
            if RUNTIME_BOUNDARY_CONTRACT != 1:
                raise RuntimeError("Hermes 宿主补丁版本不匹配。")
            self.agent.ypg_owner = self
            self.session_id = self.agent.session_id
            if not self.session_id:
                raise RuntimeError("Hermes 未创建 session ID。")
            self.service = SubagentLifecycleService(lambda: self.agent)
            native = self.agent.context_compressor
            if (not self.agent.compression_in_place or self.agent.compression_checkpoint_required
                    or self.agent.api_mode == "codex_app_server" or self.agent.codex_responses_native_compaction
                    or getattr(native, "_micro_compact_enabled", False) or native.prepared_compaction is not None):
                raise RuntimeError("Hermes 首版要求原地文本压缩；请关闭 checkpoint、micro-compaction、prepare-ahead 与不透明原生压缩。")
            if type(native).__name__ != "ContextCompressor":
                raise RuntimeError("当前入口要求原生 ContextCompressor；请使用独立的 Hermes 配置。")
            engine = PreparedEngine.__new__(PreparedEngine)
            engine.__dict__.update(native.__dict__)
            engine.owner = self
            self.agent.context_compressor = engine
            self.agent.tool_round_boundary = self._boundary
            from agent.agent_init import _inject_context_engine_tools
            _inject_context_engine_tools(self.agent)
            if "wait_for" not in self.agent.valid_tool_names:
                raise RuntimeError("Hermes enabled_toolsets 必须包含 context_engine。")
            return self
        except BaseException:
            await asyncio.gather(self.close(), return_exceptions=True)
            raise

    def _open(self):
        if self.closed:
            raise RuntimeError("Hermes 适配实例已关闭，请创建新实例。")
        if self.agent and self.agent.session_id != self.session_id:
            self.invalidate()
            raise RuntimeError("Hermes 会话已切换，旧适配实例失效。")

    def sync(self, method, args=None):
        return asyncio.run_coroutine_threadsafe(self.core.request(method, args), self.loop).result()

    def invalidate(self):
        self.loop.call_soon_threadsafe(self.close)

    async def snapshot(self):
        if self._closing and self._closing.done():
            return copy.deepcopy(self._closed_snapshot)
        return await self.core.request("snapshot")

    def _dependencies(self):
        state = self.sync("snapshot")
        return {"tasks": [{key: task[key] for key in ("handle", "status", "finishedAt") if key in task} for task in state["tasks"]],
                "waits": [{key: value for key, value in wait.items() if key != "snapshot"} for wait in state["waits"]]}

    def fingerprint(self, messages):
        return digest([self.epoch, self.agent.session_id, self.agent.model, self.agent.provider,
                       self.agent.api_mode, self.agent.base_url, self.agent._cached_system_prompt,
                       self.agent.tools, messages, self._dependencies(),
                       {key: getattr(self.agent.context_compressor, key) for key in
                        ("protect_first_n", "protect_last_n", "tail_token_budget", "summary_target_ratio", "max_summary_tokens", "summary_model", "_previous_summary")}])

    def _boundary(self, messages):
        if not self.parked:
            return None
        if self.model_epoch != self.epoch or self.closed:
            self.parked = None
            return None
        return "已进入运行时等待；任务状态变化或期限到达后自动接续。"

    def tool(self, name, args):
        return asyncio.run_coroutine_threadsafe(self._tool(name, args), self.loop).result()

    async def _tool(self, name, args):
        self._open()
        current = asyncio.current_task()
        self._tools.add(current)
        try:
            if name == "start_process":
                if "terminal" not in self.agent.valid_tool_names:
                    raise RuntimeError("当前 Hermes 工具范围未启用 terminal。")
                raw = await asyncio.to_thread(self.agent._invoke_tool, "terminal",
                                              {"command": args["command"], "background": True,
                                               "workdir": self.agent.session_cwd, "notify": False}, self.session_id)
                payload = json.loads(raw)
                if not payload.get("session_id"):
                    raise RuntimeError("Hermes 未启动后台进程：" + raw)
                native = process_registry.get(payload["session_id"])
                if native is None:
                    raise RuntimeError("Hermes 未返回具体后台执行。")
                execution_id, source, kind = native.id, ProcessTask(native), "process"
            elif name == "start_subagent":
                handle = await asyncio.to_thread(self.service.launch, SubagentLaunchRequest(goal=args["prompt"], independent=True), cancel_check=lambda: self.closed)
                execution_id, source, kind = handle.subagent_id, ChildTask(self.service, handle), "subagent"
            elif name == "wait_for":
                if self.parked:
                    raise RuntimeError("同一轮只能注册一次等待。")
                if self.model_epoch != self.epoch:
                    return {"reason": "user_input"}
                timeout = args.get("timeout", 600)
                if isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or not math.isfinite(timeout) or not 0 <= timeout <= 2147483:
                    raise ValueError("timeout 必须是 0 至 2147483 之间的有限秒数。")
                record = await self.core.request("begin", {"handle": args["handle"], "timeoutMs": math.ceil(timeout * 1000)})
                self.wait_versions[record["id"]] = self.model_epoch
                self.parked = record["id"]
                return record
            elif name == "cancel_task":
                await self.core.request("cancel", {"handle": args["handle"]})
                return {"handle": args["handle"], "cancellationRequested": True}
            else:
                raise RuntimeError("Hermes 工具不存在。")
            self.sources[execution_id] = source
            if self.closed:
                if isinstance(source, ChildTask):
                    await asyncio.to_thread(source.cancel)
                    await asyncio.to_thread(source.wait)
                raise RuntimeError("Hermes 创建期间实例已关闭，未发布 handle。")
            handle = await self.core.request("register", {"kind": kind, "executionID": execution_id})
            return {"handle": handle}
        finally:
            self._tools.discard(current)

    def _admit(self):
        with self._commit_lock:
            self._open()
            self.epoch += 1
            self.candidate = None
            return self.epoch

    async def prompt(self, text):
        self._open()
        version = await asyncio.to_thread(self._admit)
        await self.core.request("input")
        return await self._run(text, version)

    async def _run(self, text, version):
        current = asyncio.current_task()
        self._runs.add(current)
        try:
            async with self._queue:
                self._open()
                self.model_epoch = version
                self.parked = None
                await self.core.request("execution", {"phase": "started"})
                state = await self.core.request("snapshot")
                dependencies = {"tasks": [{key: value for key, value in task.items() if key not in ("result", "error", "intervention")} for task in state["tasks"]],
                                "waits": [{key: value for key, value in wait.items() if key != "snapshot"} for wait in state["waits"]]}
                if dependencies["tasks"]:
                    text += "\n云片糕结构化依赖（普通运行时数据）：\n" + json.dumps(dependencies, ensure_ascii=False)
                result = await self._native(self.agent.run_conversation, text, conversation_history=self.history, task_id=self.session_id)
                self.history = result["messages"]
                parked, self.parked = self.parked, None
                self.latest = None
                if not self.closed:
                    if parked and result.get("turn_exit_reason") == "runtime_parked":
                        await self.core.request("activate", {"id": parked})
                    elif result.get("completed") and not result.get("failed") and not result.get("interrupted"):
                        self.latest = {"messageID": digest(self.history), "tokens": self.agent.context_compressor.last_total_tokens}
                    phase = "interrupted" if result.get("interrupted") else "failed" if result.get("failed") else "succeeded"
                    await self.core.request("execution", {"phase": phase})
                await self.events.put(result)
                return result
        except BaseException:
            if not self.closed:
                await self.core.request("interrupt")
                await self.core.request("execution", {"phase": "failed"})
            raise
        finally:
            self._runs.discard(current)

    async def _dispatch(self, method, args):
        if method in ("read", "cancel"):
            source = self.sources[args["executionID"]]
            return await self._native(source.read if method == "read" else source.cancel)
        if method == "resume":
            self._open()
            if args["id"] in self.accepted:
                return
            self.accepted.add(args["id"])
            # 接纳与排队无 await 间隙；保留原等待的输入版本，旧接续不能在新输入后重建过期等待。
            task = asyncio.create_task(self._run("云片糕等待结果（普通任务数据）：\n" + json.dumps(args, ensure_ascii=False), self.wait_versions[args["id"]]))
            task.add_done_callback(self._report_run)
            return
        if method == "latestCompleted":
            return self.latest if not self._queue.locked() and not self.closed else None
        if method == "prepare":
            return await self._prepare()
        if method == "compact":
            return await self.compact(prepared=True)
        raise RuntimeError("Hermes 端口方法不存在。")

    def _report_run(self, task):
        if not task.cancelled() and task.exception() is not None:
            self.errors.append(task.exception())

    async def _native(self, function, *args, cancel_event=None, **kwargs):
        # 取消管道请求不能把仍持有原生对象的工作线程遗留给 close。
        task = asyncio.create_task(asyncio.to_thread(function, *args, **kwargs))
        self._native_tasks.add(task)
        try:
            return await asyncio.shield(task)
        except asyncio.CancelledError:
            if cancel_event is not None:
                cancel_event.set()
            if cancel_event is None and self.agent is not None:
                await asyncio.to_thread(self.agent.interrupt)
            await asyncio.gather(task, return_exceptions=True)
            raise
        finally:
            self._native_tasks.discard(task)

    async def _prepare(self):
        self._open()
        messages = copy.deepcopy(self.history)
        epoch = self.epoch
        fingerprint = await asyncio.to_thread(self.fingerprint, messages)
        # Hermes 原生 prepare worker 禁用自己的 prepared_compaction，且不写主会话。
        worker = _worker_copy(self.agent.context_compressor)
        worker.__class__ = ContextCompressor
        worker.prepared_compaction = None
        cancelled = threading.Event()
        def prepare_native():
            from agent.auxiliary_client import aux_interrupt_protection
            with aux_interrupt_protection(cancel_event=cancelled):
                return worker.compress(copy.deepcopy(messages), force=True)
        candidate = await self._native(prepare_native, cancel_event=cancelled)
        if self.closed or self.epoch != epoch or worker.compression_count <= self.agent.context_compressor.compression_count or not worker._previous_summary:
            self.candidate = None
            return {"text": "", "fingerprint": fingerprint}
        text = worker._previous_summary
        self.candidate = {"messages": candidate, "text": text, "state": {key: copy.deepcopy(getattr(worker, key, None)) for key in
                          ("compression_count", "last_prompt_tokens", "last_completion_tokens", "last_total_tokens", "_previous_summary", "_last_compression_made_progress")}}
        return {"text": text, "fingerprint": fingerprint}

    async def compact(self, *, prepared=False):
        self._open()
        async with self._queue:
            self._open()
            self.committing = prepared
            try:
                result = await self._native(self._compact_native)
                self.history = result.after_messages
                self.latest = None
                return {"status": result.status, "messages": len(self.history)}
            finally:
                self.committing = False
                self.candidate = None

    def _compact_native(self):
        with self._commit_lock:
            self._open()
            result = compress_now(self.agent, self.history, CompressRequest(), task_id=self.session_id)
            finalize_context_engine_compression_notification(self.agent, committed=True)
            return result

    async def interrupt(self):
        self._open()
        await self.core.request("interrupt")
        if self._queue.locked():
            await asyncio.to_thread(self.agent.interrupt)

    def close(self):
        if self._closing is None:
            self.closed = True
            self._closing = asyncio.create_task(self._close())
        return self._closing

    async def _close(self):
        failures = []
        async def cleanup(awaitable):
            try:
                return await awaitable
            except Exception as error:
                failures.append(error)
        interrupting = asyncio.create_task(asyncio.to_thread(self.agent.interrupt)) if self.agent else None
        if self.core:
            if self._opened:
                state = await cleanup(self.core.request("snapshot"))
                if state is not None:
                    self._closed_snapshot = state
            state = await cleanup(self.core.close(snapshot=self._opened))
            if state is not None:
                self._closed_snapshot = state
        if interrupting:
            await cleanup(interrupting)
        await asyncio.gather(*self._tools, return_exceptions=True)
        children = [source for source in self.sources.values() if isinstance(source, ChildTask)]
        await cleanup(asyncio.gather(*(asyncio.to_thread(child.cancel) for child in children)))
        await cleanup(asyncio.gather(*(asyncio.to_thread(child.wait) for child in children)))
        await asyncio.gather(*self._runs, return_exceptions=True)
        await asyncio.gather(*self._native_tasks, return_exceptions=True)
        if self.agent:
            await cleanup(asyncio.to_thread(self.agent.close))
        if self._owned_db is not None:
            from hermes_state_registry import release_or_close
            await cleanup(asyncio.to_thread(release_or_close, self._owned_db))
            self._owned_db = None
        if failures:
            raise failures[0]


create_hermes_session = HermesSession.create
