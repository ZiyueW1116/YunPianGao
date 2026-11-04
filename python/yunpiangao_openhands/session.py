"""OpenHands 1.59.0 原生 Conversation 入口；不复制 Node 核心业务规则。"""

import hashlib
import json
import math
import threading
import time
import uuid
from concurrent.futures import Future, ThreadPoolExecutor
from pathlib import Path

from pydantic import PrivateAttr
from openhands.sdk import Agent, Message, TextContent, Tool
from openhands.sdk.context.condenser import CondenserBase, LLMSummarizingCondenser
from openhands.sdk.context.view import View
from openhands.sdk.conversation import ConversationExecutionStatus, get_agent_final_response
from openhands.sdk.conversation.impl.local_conversation import LocalConversation
from openhands.sdk.event import Condensation, MessageEvent, ObservationEvent

from .bridge import CoreBridge
from .tools import TOOLS, _owners, _owners_lock


def _copy_agent(agent):
    return type(agent).model_validate(agent.model_dump(context={"expose_secrets": True}))


class PreparedCondenser(CondenserBase):
    native: LLMSummarizingCondenser
    _owner = PrivateAttr(default=None)

    def get_llm(self):
        return self.native.llm

    def handles_condensation_requests(self):
        return True

    def condense(self, view, agent_llm=None):
        owner = self._owner
        if owner is None:
            raise RuntimeError("摘要实例没有进程内归属，请重新创建云片糕入口。")
        with owner._admission:
            owner._require_open()
            if view.unhandled_condensation_request and owner._committing:
                text = owner._core.call("take_prepared", {"hostFingerprint": owner._host_fingerprint(view)})
                if text is None or owner._prepared is None:
                    raise RuntimeError("原生提交没有合格的预备摘要，保留完整历史。")
                return owner._prepared.model_copy(update={"summary": text})
        native = self.native.condense(view, agent_llm=agent_llm)
        if isinstance(native, Condensation) or view.unhandled_condensation_request:
            return native
        with owner._admission:
            owner._require_open()
            owner._model_epoch = owner._delivered_epoch
            state = owner._core.call("dependencies")
            if not state["tasks"]:
                return native
            dependency = MessageEvent(source="environment", llm_message=Message(
                role="user", content=[TextContent(text="云片糕任务运行时状态（依赖以此为准；结果可重等同一 handle 获取）：\n" + json.dumps(state, ensure_ascii=False))],
            ))
            # View 属于宿主缓存；只返回独立投影，不修改它或聊天库。
            return View(events=[*native.events, dependency])


class ManagedConversation(LocalConversation):
    """公开变更操作回到入口队列；原生执行仍调用固定 SDK 方法。"""

    owner = None

    def send_message(self, message, sender=None):
        if self.owner is None:
            return super().send_message(message, sender)
        return self.owner.send_message(message, sender).result()

    def run(self):
        return self.owner.run().result()

    def condense(self):
        return self.owner.condense().result()

    def pause(self):
        self.owner.interrupt()

    def close(self):
        if self.owner is None:
            return super().close()
        self.owner.close()

    def fork(self, **options):
        return self.owner.fork(**options).result()

    def navigate_to(self, event_id):
        if self.owner is None:
            return super().navigate_to(event_id)

        def operation():
            self.owner._require_open()
            return LocalConversation.navigate_to(self, event_id)
        return self.owner._submit(operation).result()

    def switch_llm(self, llm):
        result = super().switch_llm(llm)
        if self.owner is not None:
            self.owner.close()
        return result

    def load_plugin(self, plugin_ref):
        result = super().load_plugin(plugin_ref)
        if self.owner is not None:
            self.owner.close()
        return result


class OpenHandsSession:
    """拥有主 Conversation、子 Conversation 与一个专用 Node 核心进程。

    prompt/run/condense/fork 返回 Future；close 返回可重复等待的同一 Future。
    新输入立即撤销旧等待及摘要资格，原生消息按提交顺序进入串行 SDK 队列。
    只支持本地进程存续期间的 handle，不恢复保存会话中的执行对象。
    """

    def __init__(self, *, agent: Agent, workspace: str, core_entry: str | Path,
                 persistence_dir: str | Path, profile_store_dir: str | Path,
                 scheduling=None, poll_interval_ms=500, node="node", **conversation_options):
        if not isinstance(agent, Agent):
            raise TypeError("入口只支持本地 OpenHands Agent。")
        if not isinstance(agent.condenser, LLMSummarizingCondenser):
            raise TypeError("agent.condenser 必须为 LLMSummarizingCondenser。")
        if agent.mcp_config:
            raise ValueError("首版入口不接管 MCP 配置；请使用独立本地工具。")
        if "file_store" in conversation_options:
            raise ValueError("入口使用独立 persistence_dir，不接收共享 file_store。")
        if "conversation_id" in conversation_options:
            raise ValueError("首版入口只创建新的 Conversation，不恢复持久化执行 handle。")
        if "callbacks" in conversation_options or "agent" in conversation_options:
            raise ValueError("入口拥有 Conversation 回调及 Agent 绑定。")
        self._admission = threading.RLock()
        self._worker = ThreadPoolExecutor(max_workers=1, thread_name_prefix="ypg-main")
        self._child_workers = ThreadPoolExecutor(thread_name_prefix="ypg-child")
        self._controls = ThreadPoolExecutor(thread_name_prefix="ypg-control")
        self._closed = False
        self._closing = None
        self._epoch = self._model_epoch = self._delivered_epoch = 0
        self._parked = None
        self._prepared = None
        self._committing = False
        self._latest = None
        self._children = {}
        self._starting = set()
        self._accepted = set()
        self._resumed = set()
        self._snapshot = {"tasks": [], "waits": []}
        self._core = None
        self.conversation = None
        self.workspace = str(Path(workspace).resolve())
        self._persistence = str(persistence_dir)
        self._profiles = str(profile_store_dir)
        self._options = conversation_options
        self._id = str(uuid.uuid4())
        self._base_agent = _copy_agent(agent)
        condenser = PreparedCondenser(native=_copy_agent(agent).condenser)
        condenser._owner = self
        owned_agent = _copy_agent(agent)
        owned_agent = owned_agent.model_copy(update={"condenser": condenser,
            "tools": [*owned_agent.tools, *(Tool(name=tool.name, params={"owner_id": self._id}) for tool in TOOLS)]})
        with _owners_lock:
            _owners[self._id] = self
        try:
            self._core = CoreBridge(Path(core_entry).resolve(), self._port, node)
            self._core.call("init", {"sessionID": self._id, "cwd": self.workspace,
                "scheduling": scheduling or {}, "pollIntervalMs": poll_interval_ms})
            self.conversation = ManagedConversation.__new__(ManagedConversation)
            ManagedConversation.__init__(self.conversation, agent=owned_agent, workspace=self.workspace,
                persistence_dir=self._persistence, profile_store_dir=self._profiles,
                callbacks=[self._on_event], **conversation_options)
            self.conversation.owner = self
        except BaseException:
            self.close().result()
            raise

    def _require_open(self):
        if self._closed:
            raise RuntimeError("OpenHands 适配实例已关闭，请创建新实例。")

    def _submit(self, function):
        with self._admission:
            self._require_open()
            return self._worker.submit(function)

    def _input(self):
        self._require_open()
        self._epoch += 1
        self._core.call("input")

    def send_message(self, message, sender=None):
        with self._admission:
            self._input()
            epoch = self._epoch
            return self._worker.submit(lambda: self._send(message, sender, epoch))

    def _send(self, message, sender=None, epoch=None):
        self._require_open()
        LocalConversation.send_message(self.conversation, message, sender)
        with self._admission:
            self._delivered_epoch = self._epoch if epoch is None else epoch

    def _pending_action_ids(self):
        state = self.conversation.state
        return tuple(action.id for action in state.get_unmatched_actions(state.active_branch()))

    def _require_no_pending_actions(self):
        if self._pending_action_ids():
            raise RuntimeError("主会话有待确认工具，请先调用 confirm(approved=...) 作出决定。")

    def prompt(self, message):
        with self._admission:
            self._input()
            epoch = self._epoch
            def operation():
                self._require_no_pending_actions()
                self._send(message, epoch=epoch)
                self._run()
            return self._worker.submit(operation)

    def run(self):
        def operation():
            self._require_no_pending_actions()
            self._run()
        return self._submit(operation)

    def confirm(self, *, approved: bool):
        """批准或拒绝调用时主会话的待确认工具，然后继续执行。"""
        if type(approved) is not bool:
            raise TypeError("approved 必须是布尔值。")
        state = self.conversation.state
        leaf = state.leaf_event_id
        with state:
            self._require_open()
            if state.leaf_event_id != leaf:
                raise RuntimeError("主会话在确认期间已变化，请核对后重试。")
            pending = self._pending_action_ids()
        if not pending:
            raise RuntimeError("主会话没有待确认工具。")

        def operation():
            with state:
                self._require_open()
                if self._pending_action_ids() != pending:
                    raise RuntimeError("待确认工具已变化，请核对后重新确认。")
                if not approved:
                    self.conversation.reject_pending_actions()
            self._run()
        return self._submit(operation)

    def _run(self):
        self._require_open()
        self._core.call("execution", {"phase": "started"})
        try:
            LocalConversation.run(self.conversation)
        finally:
            with self._admission:
                if not self._closed:
                    status = self.conversation.state.execution_status
                    parked, self._parked = self._parked, None
                    if parked:
                        # pause 只是请求；这里已经越过完整原生 run 的返回边界。
                        self._core.call("activate", {"waitID": parked})
                    finished = status == ConversationExecutionStatus.FINISHED
                    if finished:
                        usages = self.conversation.agent.llm.metrics.token_usages
                        usage = usages[-1] if usages else None
                        self._latest = {"messageID": self.conversation.state.leaf_event_id,
                            "tokens": sum(getattr(usage, key, 0) for key in (
                                "prompt_tokens", "completion_tokens", "cache_read_tokens", "cache_write_tokens"))}
                    self._core.call("execution", {"phase": "succeeded" if finished else "interrupted"})

    def _on_event(self, event):
        if isinstance(event, ObservationEvent) and event.tool_name == "wait_for":
            with self._admission:
                if self._parked:
                    LocalConversation.pause(self.conversation)
        if self._closed:
            LocalConversation.pause(self.conversation)

    def _tool(self, operation, action):
        with self._admission:
            self._require_open()
            if operation == "start_process":
                return {"handle": self._core.call("start_process", {"command": action.command, "args": action.args})}
            if operation == "wait_for":
                if self._parked:
                    raise RuntimeError("同一原生步骤只能注册一次等待。")
                if self._model_epoch != self._epoch:
                    return {"reason": "user_input", "instruction": "请先处理已排队的新输入。"}
                record = self._core.call("begin", {"handle": action.handle, "timeoutMs": math.ceil(action.timeout * 1000)})
                self._parked = record["id"]
                return record
        if operation == "cancel_task":
            self._core.call("cancel", {"handle": action.handle})
            return {"handle": action.handle, "cancellationRequested": True}
        return self._start_child(action)

    def _start_child(self, action):
        # 创建纳入在途集合；close 等其返回并释放迟到的对象。
        child_id = str(uuid.uuid4())
        with self._admission:
            self._require_open()
            child = {"conversation": None, "snapshot": {"status": "working"}, "cancelled": False}
            self._children[child_id] = child
            creation = Future()
            self._starting.add(creation)
        try:
            conversation = LocalConversation.__new__(LocalConversation)
            with self._admission:
                child["conversation"] = conversation
            child_options = {**self._options, "visualizer": None}
            LocalConversation.__init__(conversation, agent=_copy_agent(self._base_agent), workspace=self.workspace,
                persistence_dir=self._persistence, profile_store_dir=self._profiles, **child_options)
            with self._admission:
                child["conversation"] = conversation
                self._require_open()
            conversation.set_confirmation_policy(self.conversation.state.confirmation_policy.model_copy(deep=True))
            analyzer = self.conversation.state.security_analyzer
            conversation.set_security_analyzer(type(analyzer).model_validate(analyzer.model_dump(context={"expose_secrets": True})) if analyzer else None)
            conversation.send_message(action.prompt)
            with self._admission:
                self._require_open()
                handle = self._core.call("register_child", {"executionID": child_id})
                child["future"] = self._child_workers.submit(self._run_child, child_id, action.description)
            return {"handle": handle}
        except BaseException:
            if child["conversation"] and hasattr(child["conversation"], "_cleanup_complete"):
                child["conversation"].close()
            with self._admission:
                self._children.pop(child_id, None)
            raise
        finally:
            with self._admission:
                self._starting.discard(creation)
                creation.set_result(None)

    def _run_child(self, child_id, description):
        child = self._children[child_id]
        conversation = child["conversation"]
        try:
            with self._admission:
                if self._closed or child["cancelled"]:
                    child["cancelled"] = True
                    return
            conversation.run()
            events = conversation.state.active_branch()
            text = get_agent_final_response(events)
            if conversation.state.execution_status == ConversationExecutionStatus.WAITING_FOR_CONFIRMATION:
                child["snapshot"] = {"status": "input_required", "intervention": {"kind": "confirmation", "conversationID": str(conversation.state.id)}}
                return
            child["snapshot"] = {"status": "succeeded", "result": {"description": description, "text": text}} if conversation.state.execution_status == ConversationExecutionStatus.FINISHED and text else {"status": "failed", "error": "子 Conversation 没有最终回答；请检查原生 hook、执行限制或错误。"}
        except Exception:
            child["snapshot"] = {"status": "failed", "error": "子 Conversation 执行失败。"}
        finally:
            if child["cancelled"]:
                child["snapshot"] = {"status": "cancelled"}
            if child["snapshot"]["status"] != "input_required":
                child["snapshot"]["finishedAt"] = int(time.time() * 1000)
                conversation.close()
            if not self._closed:
                self._core.call("child_changed", {"executionID": child_id})

    def confirm_subagent(self, handle, *, approved):
        """由嵌入方转交原生确认决定；模型工具不能自行批准子会话权限。"""
        with self._admission:
            self._require_open()
            task = next((task for task in self._core.call("snapshot")["tasks"] if task["handle"]["id"] == handle), None)
            if not task or task["handle"]["kind"] != "subagent":
                raise ValueError("子任务 handle 不属于当前实例。")
            child_id = task["handle"]["executionID"]
            child = self._children[child_id]
            if child["snapshot"]["status"] != "input_required":
                raise ValueError("子 Conversation 没有等待权限确认。")
            if not approved:
                child["conversation"].reject_pending_actions()
            child["snapshot"] = {"status": "working"}
            child["future"] = self._child_workers.submit(self._run_child, child_id, "已确认的子任务")
        self._core.call("child_changed", {"executionID": child_id})

    def _host_fingerprint(self, view):
        value = [self._epoch, self.conversation.agent.model_dump(mode="json"),
            [event.model_dump(mode="json") for event in view.events]]
        return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode()).hexdigest()

    def _port(self, operation, value):
        if operation == "read_child":
            return self._children[value["executionID"]]["snapshot"].copy()
        if operation == "cancel_child":
            child = self._children[value["executionID"]]
            child["cancelled"] = True
            if child["snapshot"]["status"] == "input_required":
                child["snapshot"] = {"status": "cancelled", "finishedAt": int(time.time() * 1000)}
                child["conversation"].close()
            # sync run 持有步骤锁；暂停在独立线程请求，不阻塞取消回执。
            self._controls.submit(child["conversation"].pause)
            return None
        if operation == "latest":
            return self._latest
        if operation == "prepare":
            with self.conversation.state, self._admission:
                self._require_open()
                view = View.model_validate(self.conversation.state.view.model_dump(mode="json"))
                fingerprint = self._core.call("summary_fingerprint", {"hostFingerprint": self._host_fingerprint(view)})
                native = self.conversation.agent.condenser.native
            prepared = native.condense(view.model_copy(update={"unhandled_condensation_request": True}), agent_llm=self.conversation.agent.llm)
            if not isinstance(prepared, Condensation):
                raise RuntimeError("原生 Condenser 没有生成 Condensation。")
            with self._admission:
                self._prepared = prepared
            return {"text": prepared.summary, "fingerprint": fingerprint}
        if operation == "compact":
            def commit():
                with self.conversation.state, self._admission:
                    self._require_open()
                    self._committing = True
                    try:
                        self._condense()
                        self._latest = None
                    finally:
                        self._committing = False
                        self._prepared = None
            return self._submit(commit).result()
        if operation == "resume":
            wait_id = value["id"]
            def resume():
                with self.conversation.state, self._admission:
                    self._require_open()
                    sender = "yunpiangao.resume:" + wait_id
                    accepted = wait_id in self._accepted or any(isinstance(event, MessageEvent) and event.sender == sender
                        for event in self.conversation.state.events)
                    if not accepted:
                        LocalConversation.send_message(self.conversation,
                            "云片糕等待已结束：\n" + json.dumps(value, ensure_ascii=False), sender=sender)
                    self._accepted.add(wait_id)
                    if wait_id not in self._resumed:
                        self._resumed.add(wait_id)
                        self._worker.submit(self._resume_run)
            return self._submit(resume).result()
        raise RuntimeError("未知的 OpenHands 宿主端口。")

    def _resume_run(self):
        if not self._pending_action_ids():
            self._run()

    def _condense(self):
        with self.conversation.state:
            self._require_open()
            self._require_no_pending_actions()
            LocalConversation.condense(self.conversation)

    def condense(self):
        return self._submit(self._condense)

    def interrupt(self):
        with self._admission:
            self._require_open()
            self._epoch += 1
            self._delivered_epoch = self._epoch
            self._core.call("interrupt")
            return self._controls.submit(LocalConversation.pause, self.conversation)

    def fork(self, **options):
        def operation():
            self._require_open()
            forked = LocalConversation.fork(self.conversation, agent=self._base_agent, **options)
            self.close()
            return forked
        return self._submit(operation)

    def snapshot(self):
        with self._admission:
            if not self._closed:
                self._snapshot = self._core.call("snapshot")
            return json.loads(json.dumps(self._snapshot))

    @property
    def diagnostics(self):
        return list(self._core.diagnostics) if self._core else []

    def close(self):
        with self._admission:
            if self._closing is not None:
                return self._closing
            # 先公布 Future；原生 close 的同步重入复用同一次清理。
            self._closing = Future()
            self._closed = True
            def cleanup():
                errors = []
                def finish(operation):
                    try:
                        return operation()
                    except BaseException as error:
                        errors.append(error)
                if self._core:
                    snapshot = finish(lambda: self._core.call("close"))
                    if snapshot is not None:
                        self._snapshot = snapshot
                if self.conversation and hasattr(self.conversation, "_state"):
                    finish(lambda: self._controls.submit(LocalConversation.pause, self.conversation))
                finish(lambda: self._worker.shutdown(wait=True))
                with self._admission:
                    starting = list(self._starting)
                for creation in starting:
                    finish(creation.result)
                for child in list(self._children.values()):
                    child["cancelled"] = True
                    if child["conversation"]:
                        finish(child["conversation"].pause)
                finish(lambda: self._child_workers.shutdown(wait=True))
                finish(lambda: self._controls.shutdown(wait=True))
                for child in list(self._children.values()):
                    if child["conversation"]:
                        finish(child["conversation"].close)
                if self.conversation and hasattr(self.conversation, "_cleanup_complete"):
                    finish(lambda: LocalConversation.close(self.conversation))
                if self._core:
                    finish(self._core.disconnect)
                with _owners_lock:
                    _owners.pop(self._id, None)
                if errors:
                    self._closing.set_exception(errors[0])
                else:
                    self._closing.set_result(None)
            threading.Thread(target=cleanup, name="ypg-close", daemon=True).start()
            return self._closing
