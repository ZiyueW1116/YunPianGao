"""合成模型仅预设响应；宿主工具、执行循环、压缩与数据库均为真实 Hermes。"""
import asyncio
import json
import os
import re
from pathlib import Path
import shutil
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = Path(tempfile.mkdtemp(prefix="ypg-hermes-"))
os.environ["HERMES_HOME"] = str(ROOT / "home")
os.environ["HERMES_RUNTIME_DIR"] = str(ROOT / "runtime")
os.environ["TERMINAL_CWD"] = str(ROOT)
# 只禁用与目标入口无关的原生外部后台工作；测试不连接已有模型或服务。
(ROOT / "home").mkdir()
ACTIVE = None


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        return

    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps({"data": [{"id": "fixture"}]}).encode())

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        fixture = ACTIVE
        summary = not body.get("tools")
        child = any("CHILD_MARKER" in json.dumps(message.get("content"), ensure_ascii=False) for message in body.get("messages", []) if message.get("role") == "user") and not summary
        kind = "summary" if summary else "child" if child else "seed" if fixture.seeding else "parent"
        fixture.calls.append({"kind": kind, "at": time.time() * 1000, "body": body})
        tool = None
        if summary:
            fixture.summaries += 1
            fixture.summary_started.set()
            if fixture.block_summary:
                fixture.release_summary.wait(15)
            text = "## 用户目标\n完成合成后台任务并保持精确 handle。\n## 当前状态\n任务结果由结构化运行时提供。\n" + "保留约束、待完成事项及测试事实。" * 20
        elif kind == "seed":
            text = "合成历史已记录。" * 1000
        elif child:
            fixture.child += 1
            fixture.child_started.set()
            fixture.release_child.wait(15)
            if fixture.name == "child-failure":
                self.send_response(400); self.send_header("Content-Type", "application/json"); self.end_headers()
                self.wfile.write(b'{"error":{"message":"synthetic child failure"}}')
                return
            text = "合成子任务已完成。"
        else:
            fixture.parent += 1
            tool = fixture.choose(fixture.parent)
            text = "合成任务已完成。" + ("合成历史" * 800 if fixture.name.startswith("summary") else "")
            if fixture.name == "before" and fixture.parent == 2:
                fixture.wait_terminal()
            if fixture.name == "input-stream" and fixture.parent == 2:
                fixture.wait_started.set(); fixture.release_wait.wait(15)
        n = len(fixture.calls)
        message = {"role": "assistant", "content": None if tool else text}
        if tool:
            message["tool_calls"] = [{"id": "call_" + str(n), "type": "function", "function": {"name": tool[0], "arguments": json.dumps(tool[1])}}]
        if fixture.name == "batch" and kind == "parent" and fixture.parent == 2:
            message["tool_calls"].append({"id": "extra_" + str(n), "type": "function", "function": {"name": "start_process", "arguments": json.dumps({"command": "printf BATCH_DONE"})}})
        response = {"id": "fixture_" + str(n), "object": "chat.completion", "model": body.get("model", "fixture"),
                    "choices": [{"index": 0, "message": message, "finish_reason": "tool_calls" if tool else "stop"}],
                    "usage": {"prompt_tokens": 2000 if fixture.name.startswith("summary") and kind == "parent" and fixture.parent == 1 else 100, "completion_tokens": 10, "total_tokens": 2010 if fixture.name.startswith("summary") and kind == "parent" and fixture.parent == 1 else 110}}
        try:
            if body.get("stream"):
                self.send_response(200); self.send_header("Content-Type", "text/event-stream"); self.end_headers()
                delta = {"role": "assistant", "content": text} if not tool else {"role": "assistant", "tool_calls": [{"index": i, **call} for i, call in enumerate(message["tool_calls"])]}
                for data in [{"id": response["id"], "choices": [{"index": 0, "delta": delta, "finish_reason": None}]},
                             {"id": response["id"], "choices": [{"index": 0, "delta": {}, "finish_reason": response["choices"][0]["finish_reason"]}]},
                             {"id": response["id"], "choices": [], "usage": response["usage"]}]:
                    self.wfile.write(("data: " + json.dumps(data, ensure_ascii=False) + "\n\n").encode())
                self.wfile.write(b"data: [DONE]\n\n")
            else:
                self.send_response(200); self.send_header("Content-Type", "application/json"); self.end_headers()
                self.wfile.write(json.dumps(response, ensure_ascii=False).encode())
        except (BrokenPipeError, ConnectionResetError):
            pass


SERVER = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
threading.Thread(target=SERVER.serve_forever, daemon=True).start()
BASE = f"http://127.0.0.1:{SERVER.server_port}/v1"
config = {
    "model": {"default": "fixture", "provider": "custom", "base_url": BASE, "context_length": 100000},
    "compression": {"enabled": False, "in_place": True, "threshold": 0.95, "protect_first_n": 0, "protect_last_n": 0, "tail_mode": "legacy", "target_ratio": 0.1, "prepare_ahead": False, "abort_on_summary_failure": True},
    "auxiliary": {"title_generation": {"enabled": False}, "compression": {"provider": "custom", "base_url": BASE, "api_key": "synthetic-only", "model": "fixture-summary", "context_length": 100000}},
    "terminal": {"backend": "local", "cwd": str(ROOT), "timeout": 10},
    "memory": {"memory_enabled": False, "user_profile_enabled": False},
    "delegation": {"subagent_auto_approve": False, "worktree": False},
    "security": {"allow_lazy_installs": False},
}
# JSON 是合法 YAML；仅写测试 home。
(ROOT / "home/config.yaml").write_text(json.dumps(config), encoding="utf-8")
from yunpiangao_hermes import create_hermes_session
from hermes_state import SessionDB
from agent.subagent_lifecycle import SubagentLifecycleError
from run_agent import AIAgent
from yunpiangao_hermes.bridge import CoreBridge
from yunpiangao_hermes.session import HermesAgent


async def until(check, timeout=10):
    deadline = asyncio.get_running_loop().time() + timeout
    while asyncio.get_running_loop().time() < deadline:
        value = check()
        if asyncio.iscoroutine(value):
            value = await value
        if value:
            return
        await asyncio.sleep(.005)
    raise AssertionError("Hermes 真实入口未在期限内到达预期状态")


class Fixture:
    async def open(self, name, scheduling=None):
        global ACTIVE
        self.name, self.parent, self.child, self.summaries = name, 0, 0, 0
        self.calls = []
        self.block_summary = False
        self.seeding = False
        self.summary_started, self.release_summary, self.child_started, self.release_child = [threading.Event() for _ in range(4)]
        self.wait_started, self.release_wait = threading.Event(), threading.Event()
        self.cwd = ROOT / (name + "-" + str(time.time_ns()))
        self.cwd.mkdir()
        self.loop = asyncio.get_running_loop()
        self.db = SessionDB(self.cwd / "session.sqlite")
        ACTIVE = self
        options = {"model": "fixture", "provider": "custom", "base_url": BASE, "api_key": "synthetic-only", "api_mode": "chat_completions",
                   "enabled_toolsets": ["terminal", "context_engine"], "quiet_mode": True, "skip_context_files": True,
                   "cwd": str(self.cwd), "session_db": self.db, "max_iterations": 30, "max_tokens": 4096}
        self.options = options
        self.session = await create_hermes_session(options, scheduling=scheduling or {"thresholdTokens": 999999}, poll_interval_ms=10)
        return self

    def snapshot(self):
        return asyncio.run_coroutine_threadsafe(self.session.snapshot(), self.loop).result(5)

    def wait_terminal(self):
        deadline = time.time() + 5
        while time.time() < deadline:
            asyncio.run_coroutine_threadsafe(self.session.core.request("refresh"), self.loop).result(5)
            if self.snapshot()["tasks"][0]["status"] != "working":
                return
            time.sleep(.005)
        raise AssertionError("原生进程未完成")

    def choose(self, n):
        if self.name.startswith("summary") or self.name.startswith("lifecycle"):
            return
        if n == 1:
            if self.name.startswith("child"):
                return "start_subagent", {"prompt": "CHILD_MARKER：完成合成任务。"}
            if self.name == "before":
                command = "printf DONE"
            elif self.name == "failure":
                command = "exit 7"
            else:
                # 测试进程用文件门闩；运行时等待与模型均不执行这段轮询。
                command = "while [ ! -f release ]; do sleep 0.02; done; printf DONE"
            return "start_process", {"command": command}
        state = self.snapshot()
        handle = state["tasks"][0]["handle"]["id"]
        if n == 2 or (self.name == "timeout" and n == 3) or (self.name in ("input", "child-input", "resume-input") and n == 4) or (self.name.endswith("cancel") and n == 4):
            return "wait_for", {"handle": handle, "timeout": .04 if self.name == "timeout" and n == 2 else .02 if self.name == "race" else 10}
        if self.name.endswith("cancel") and n == 3:
            return "cancel_task", {"handle": handle}

    async def release(self):
        self.release_child.set()
        (self.cwd / "release").touch()

    async def close(self):
        await self.release()
        self.release_summary.set(); self.release_wait.set()
        await self.session.close()
        self.db.close()


class RuntimeTests(unittest.IsolatedAsyncioTestCase):
    async def scenario(self, name):
        f = await Fixture().open(name)
        try:
            if name in ("compact", "compact-race", "child-compact"):
                f.session.agent.context_compressor.tail_token_budget = 1
                f.seeding = True
                await f.session.prompt("合成历史用户目标。" * 1000)
                f.seeding = False
            if name == "before":
                native_request = f.session.core.request
                async def completed_before_register(method, args=None):
                    if method == "register":
                        source = f.session.sources[args["executionID"]]
                        await until(lambda: source.read()["status"] == "succeeded")
                    return await native_request(method, args)
                f.session.core.request = completed_before_register
            result = await f.session.prompt("启动合成后台任务并等待。" + "保留精确任务信息。" * 100)
            self.assertEqual(result["turn_exit_reason"], "runtime_parked")
            self.assertFalse(result.get("failed"))
            if name not in ("before", "failure"):
                self.assertEqual(f.parent, 2)
                state = await f.session.snapshot()
                self.assertEqual(state["tasks"][0]["status"], "working")
            if name == "timeout":
                await until(lambda: f.parent == 3)
                await until(lambda: not f.session._queue.locked())
                self.assertEqual((await f.session.snapshot())["tasks"][0]["status"], "working")
            if name in ("input", "child-input") or name.endswith("cancel"):
                await f.session.prompt("用户介入，先处理此输入。")
                self.assertEqual((await f.session.snapshot())["waits"][0]["reason"], "user_input")
                if name in ("input", "child-input"):
                    self.assertEqual((await f.session.snapshot())["tasks"][0]["status"], "working")
                    await f.session.prompt("继续等待同一 handle。")
            if name in ("compact", "compact-race", "child-compact"):
                before = f.db.get_messages(f.session.session_id)
                if name == "compact-race":
                    f.block_summary = True
                    compacting = asyncio.create_task(f.session.compact())
                    await until(f.summary_started.is_set)
                    await f.release()
                    async def ready():
                        return (await f.session.snapshot())["waits"][0].get("reason") == "succeeded"
                    await until(ready)
                    self.assertEqual(f.parent, 2)
                    f.release_summary.set()
                    await compacting
                else:
                    await f.session.compact()
                after = f.db.get_messages(f.session.session_id)
                self.assertTrue(any(message.get("compacted") or message.get("_compressed_summary") or "context summary" in str(message.get("content", "")).lower() for message in after), str(after)[:300])
                self.assertNotEqual(before, after)
                self.assertGreater(f.summaries, 0)
                self.assertFalse(f.session.closed)
            if name == "interrupt":
                await f.session.interrupt()
                await f.release()
                await asyncio.sleep(.08)
                self.assertEqual(f.parent, 2)
                self.assertEqual((await f.session.snapshot())["waits"][0]["reason"], "interrupted")
                return
            if name == "resume-ack":
                native = f.session._dispatch
                lost = False
                async def lose_ack(method, args):
                    nonlocal lost
                    value = await native(method, args)
                    if method == "resume" and not lost:
                        lost = True
                        raise RuntimeError("合成接纳回执丢失")
                    return value
                f.session.core.dispatch = lose_ack
            if name == "race":
                await asyncio.sleep(.02)
            await f.release()
            expected = 4 if name == "timeout" else 5 if name in ("input", "child-input") or name.endswith("cancel") else 3
            await until(lambda: f.parent == expected)
            await until(lambda: not f.session._queue.locked())
            await asyncio.sleep(.04)
            state = await f.session.snapshot()
            last = state["waits"][-1]
            if name == "race":
                self.assertIn(last["reason"], ("timeout", "succeeded"))
            else:
                self.assertEqual(last["reason"], "cancelled" if name.endswith("cancel") else "failed" if name in ("failure", "child-failure") else "succeeded")
            self.assertEqual(last["state"], "delivered")
            self.assertEqual(f.parent, expected)
            self.assertEqual(len(f.session.accepted), 2 if name == "timeout" else 1)
            if name == "before":
                self.assertLessEqual(last["snapshot"]["finishedAt"], last["createdAt"])
            if name == "timeout":
                self.assertEqual(state["waits"][0]["reason"], "timeout")
                self.assertEqual(last["handle"], state["waits"][0]["handle"])
            final = [call for call in f.calls if call["kind"] == "parent"][-1]
            self.assertIn("云片糕结构化依赖", json.dumps(final["body"], ensure_ascii=False))
            self.assertFalse(any('"output": "DONE"' in json.dumps(message, ensure_ascii=False) for message in final["body"]["messages"] if message["role"] == "system"))
            self.assertEqual(f.session.errors, [])
            long_sleeps = set()
            for call in f.calls:
                for message in call["body"].get("messages", []):
                    for tool in message.get("tool_calls") or []:
                        function = tool.get("function", {})
                        if function.get("name") not in ("terminal", "start_process"):
                            continue
                        arguments = json.loads(function.get("arguments") or "{}")
                        if any(float(seconds) >= 60 for seconds in re.findall(r"\bsleep\s+([0-9.]+)", arguments.get("command", ""))):
                            long_sleeps.add(tool["id"])
            self.assertEqual(long_sleeps, set())
            latency = None if not last.get("snapshot", {}).get("finishedAt") else round(final["at"] - last["snapshot"]["finishedAt"], 2)
            print(json.dumps({"scenario": name, "parentRequests": f.parent, "seedRequests": len([call for call in f.calls if call["kind"] == "seed"]), "childRequests": f.child, "summaryRequests": f.summaries, "extraWakeups": f.parent - expected, "longSleepCalls": len(long_sleeps), "completionToResumeMs": latency}), flush=True)
        finally:
            await f.close()


    async def test_terminal_entry_requires_approval(self):
        f = await Fixture().open("lifecycle-cli-approval")
        process = None
        try:
            from tools.approval import detect_dangerous_command

            marker = f.cwd / "approval-probe"
            marker.write_text("合成审批测试", encoding="utf-8")
            marker.chmod(0o600)
            command = "chmod 777 approval-probe"
            self.assertTrue(detect_dangerous_command(command)[0])
            def choose(n):
                if n == 1:
                    return "start_process", {"command": command}
                if n == 2:
                    return "terminal", {"command": command}

            f.choose = choose
            path = f.cwd / "options.json"
            path.write_text(json.dumps({key: value for key, value in f.options.items() if key != "session_db"}), encoding="utf-8")
            process = await asyncio.create_subprocess_exec(
                sys.executable, "-m", "yunpiangao_hermes", "--agent-options", str(path),
                stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            )
            while True:
                line = await asyncio.wait_for(process.stdout.readline(), 10)
                self.assertTrue(line)
                if b"/close" in line:
                    break
            process.stdin.write("执行合成审批测试。\n".encode())
            await process.stdin.drain()
            await until(lambda: f.parent == 3)
            await asyncio.wait_for(process.stdout.readline(), 10)
            process.stdin.write(b"/close\n")
            await process.stdin.drain()
            _, errors = await process.communicate()
            self.assertEqual(process.returncode, 0, errors.decode())
            self.assertEqual(marker.stat().st_mode & 0o777, 0o600)
            tool_result = [message["content"] for message in f.calls[-1]["body"]["messages"] if message["role"] == "tool"]
            self.assertEqual(sum("BLOCKED" in result for result in tool_result), 2, tool_result)
        finally:
            if process is not None and process.returncode is None:
                process.kill()
                await process.wait()
            await f.close()

    async def test_settled_wait_survives_input_before_parking(self):
        f = await Fixture().open("complete")
        began, release, admitted = asyncio.Event(), asyncio.Event(), asyncio.Event()
        native = f.session.core.request
        prompts = []

        async def gate(method, args=None):
            value = await native(method, args)
            if method == "begin":
                self.assertEqual(value["state"], "waiting")
                began.set()
                await release.wait()
            if method == "input" and f.session.epoch == 2:
                admitted.set()
            return value

        async def settled():
            return (await f.session.snapshot())["waits"][0]["state"] == "ready"

        f.session.core.request = gate
        try:
            prompts.append(asyncio.create_task(f.session.prompt("启动并等待合成任务。")))
            await asyncio.wait_for(began.wait(), 5)
            await f.release()
            await until(settled)
            prompts.append(asyncio.create_task(f.session.prompt("合成新输入。")))
            await asyncio.wait_for(admitted.wait(), 5)
            release.set()
            await asyncio.gather(*prompts)
            await until(lambda: f.parent == 4 and not f.session._queue.locked())
            self.assertEqual(len(f.session.accepted), 1)
            wait = (await f.session.snapshot())["waits"][0]
            self.assertEqual((wait["state"], wait["reason"]), ("delivered", "succeeded"))
            deliveries = [
                message["content"] for call in f.calls for message in call["body"]["messages"]
                if message["role"] == "user" and str(message.get("content", "")).startswith("云片糕等待结果")
            ]
            self.assertEqual(len(set(deliveries)), 1)
            self.assertIn('"output": "DONE"', deliveries[0])
        finally:
            release.set()
            await asyncio.gather(*prompts, return_exceptions=True)
            await f.close()

    async def test_rewait_child_after_native_retention(self):
        from agent import subagent_lifecycle as lifecycle

        f = await Fixture().open("child-retention")
        original = f.choose
        f.choose = lambda n: original(n) if n == 1 else None
        try:
            await f.session.prompt("启动子任务，稍后等待。")
            child = next(iter(f.session.sources.values()))
            handle = (await f.session.snapshot())["tasks"][0]["handle"]["id"]
            await f.release()
            await until(lambda: child.service.result(child.handle).ready)
            with patch.object(lifecycle, "_TERMINAL_RETENTION_SECONDS", 0):
                await asyncio.to_thread(f.session.tool, "start_subagent", {"prompt": "CHILD_MARKER：触发宿主过期清理。"})
            self.assertNotIn(child.handle.subagent_id, lifecycle._REGISTRY.records)
            f.choose = lambda n: ("wait_for", {"handle": handle, "timeout": .2}) if n == 3 else None
            await f.session.prompt("现在等待第一个子任务。")
            await until(lambda: f.parent == 4 and not f.session._queue.locked())
            wait = (await f.session.snapshot())["waits"][0]
            self.assertEqual(wait["reason"], "succeeded")
            self.assertIn("合成子任务已完成", wait["snapshot"]["result"]["summary"])
        finally:
            await f.close()

    async def test_cancelled_prompt_keeps_native_history(self):
        f = await Fixture().open("input-stream")
        try:
            running = asyncio.create_task(f.session.prompt("CANCEL_HISTORY_MARKER"))
            await until(f.wait_started.is_set)
            running.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await running
            persisted = f.db.get_messages(f.session.session_id)
            self.assertTrue(any("CANCEL_HISTORY_MARKER" in str(m["content"]) for m in persisted))
            installed = any("CANCEL_HISTORY_MARKER" in str(m["content"]) for m in f.session.history)
            f.release_wait.set()
            await f.session.prompt("FOLLOW_UP_MARKER")
            self.assertTrue(any("CANCEL_HISTORY_MARKER" in str(m.get("content")) for m in f.calls[-1]["body"]["messages"]))
            self.assertTrue(installed)
        finally:
            await f.close()

    async def test_close_survives_caller_timeout(self):
        f = await Fixture().open("lifecycle-close-timeout")
        entered, release = asyncio.Event(), asyncio.Event()
        native = f.session.core.request

        async def gate(method, args=None):
            if method == "snapshot":
                entered.set()
                await release.wait()
            return await native(method, args)

        f.session.core.request = gate
        try:
            closing = f.session.close()
            await asyncio.wait_for(entered.wait(), 5)
            with self.assertRaises(TimeoutError):
                await asyncio.wait_for(closing, .01)
            release.set()
            await asyncio.wait_for(f.session.close(), 5)
            self.assertTrue(f.session.agent.ypg_closed)
            self.assertEqual(f.session.core.process.returncode, 0)
        finally:
            release.set()
            if f.session._closing.cancelled():
                await f.session._close()
                f.db.close()
            else:
                await f.close()

    async def test_close_before_child_executor_admission(self):
        from agent import subagent_lifecycle as lifecycle

        f = await Fixture().open("child-submit-close")
        entered, release = threading.Event(), threading.Event()
        native = lifecycle._EXECUTOR.submit

        def gate(*args, **kwargs):
            entered.set()
            release.wait(5)
            future = native(*args, **kwargs)
            future.result(timeout=5)
            return future

        try:
            await f.release()
            with patch.object(lifecycle._EXECUTOR, "submit", gate):
                running = asyncio.create_task(f.session.prompt("启动合成子 Agent。"))
                await until(entered.is_set)
                closing = f.session.close()
                release.set()
                await asyncio.gather(running, return_exceptions=True)
                await closing
            self.assertEqual(f.child, 0)
            self.assertEqual((await f.session.snapshot())["tasks"], [])
        finally:
            release.set()
            await f.close()

    async def test_bridge_keeps_large_multibyte_snapshot_readable(self):
        output = "😀" * 65536

        async def dispatch(method, args):
            self.assertEqual(method, "read")
            return {"status": "succeeded", "result": {"output": output}}

        core = await CoreBridge.create(dispatch)
        try:
            await core.request("open", {"sessionID": "合成大快照"})
            for i in range(64):
                await core.request("register", {"kind": "process", "executionID": str(i)})
            await core.request("refresh")
            state = await core.request("snapshot")
            self.assertEqual(len(state["tasks"]), 64)
            self.assertTrue(all(task["result"]["output"] == output for task in state["tasks"]))
            self.assertEqual((await core.request("snapshot"))["tasks"][-1]["result"]["output"], output)
        finally:
            closed = await core.close(snapshot=True)
        self.assertEqual(closed["tasks"][-1]["result"]["output"], output)
        self.assertEqual(core.process.returncode, 0)


    async def test_failed_parking_stops_only_its_wait(self):
        f = await Fixture().open("complete")
        native = f.session.agent._flush_messages_to_session_db
        refused = threading.Event()

        def reject_wait_result(messages, *args, **kwargs):
            if not refused.is_set() and f.session.parked and any(
                message.get("role") == "tool" and message.get("name") == "wait_for" for message in messages
            ):
                refused.set()
                return False
            return native(messages, *args, **kwargs)

        try:
            with patch.object(f.session.agent, "_flush_messages_to_session_db", reject_wait_result):
                result = await f.session.prompt("启动并等待合成任务。")
            self.assertTrue(refused.is_set())
            self.assertTrue(result["failed"])
            state = await f.session.snapshot()
            wait = state["waits"][0]
            self.assertEqual(state["tasks"][0]["status"], "working")
            self.assertEqual((wait["state"], wait["reason"]), ("delivered", "interrupted"))
            await f.release()

            async def completed():
                await f.session.core.request("refresh", {"handle": wait["handle"]["id"]})
                return (await f.session.snapshot())["tasks"][0]["status"] == "succeeded"

            await until(completed)
            self.assertEqual((await f.session.snapshot())["waits"][0], wait)
            self.assertEqual(f.parent, 2)
            self.assertEqual(f.session.accepted, set())
        finally:
            await f.close()

    async def test_zero_wait_rechecks_child_after_native_retention(self):
        from agent import subagent_lifecycle as lifecycle

        f = await Fixture().open("child-zero")
        original = f.choose
        f.choose = lambda n: original(n) if n == 1 else None
        try:
            await f.session.prompt("启动子任务，稍后复核。")
            child = next(iter(f.session.sources.values()))
            await f.release()
            await until(lambda: child.service.result(child.handle).ready)
            with patch.object(lifecycle, "_TERMINAL_RETENTION_SECONDS", 0):
                await asyncio.to_thread(f.session.tool, "start_subagent", {"prompt": "CHILD_MARKER：触发宿主清理。"})
            self.assertNotIn(child.handle.subagent_id, lifecycle._REGISTRY.records)
            state = await f.session.snapshot()
            handle = state["tasks"][0]["handle"]["id"]
            self.assertEqual(state["tasks"][0]["status"], "working")
            f.choose = lambda n: ("wait_for", {"handle": handle, "timeout": 0}) if n == 3 else None
            await f.session.prompt("用零秒期限复核第一个子任务。")
            await until(lambda: f.parent == 4 and not f.session._queue.locked())
            wait = (await f.session.snapshot())["waits"][0]
            self.assertEqual(wait["deadline"], wait["createdAt"])
            self.assertEqual(wait["reason"], "succeeded")
            self.assertIn("合成子任务已完成", wait["snapshot"]["result"]["summary"])
        finally:
            await f.close()

    async def test_input_during_zero_wait_refresh_rejects_stale_wait(self):
        f = await Fixture().open("complete")
        original_choose = f.choose
        checking, release, admitted = asyncio.Event(), asyncio.Event(), asyncio.Event()
        native = f.session.core.request
        prompts = []

        def choose(n):
            call = original_choose(n)
            if n == 2:
                return call[0], {**call[1], "timeout": 0}
            return call

        async def gate(method, args=None):
            value = await native(method, args)
            if method == "refresh":
                checking.set()
                await release.wait()
            if method == "input" and f.session.epoch == 2:
                admitted.set()
            return value

        f.choose = choose
        f.session.core.request = gate
        try:
            prompts.append(asyncio.create_task(f.session.prompt("启动任务并执行零秒等待。")))
            await asyncio.wait_for(checking.wait(), 5)
            prompts.append(asyncio.create_task(f.session.prompt("替换过期的等待意图。")))
            await asyncio.wait_for(admitted.wait(), 5)
            release.set()
            await asyncio.gather(*prompts)
            self.assertEqual((await f.session.snapshot())["waits"], [])
            self.assertEqual(f.parent, 4)
            self.assertEqual(f.session.accepted, set())
        finally:
            release.set()
            await asyncio.gather(*prompts, return_exceptions=True)
            await f.close()

    async def test_cancelled_compact_keeps_committed_history(self):
        f = await Fixture().open("lifecycle-cancelled-compact")
        committed, release = threading.Event(), threading.Event()
        native = f.session._compact_native
        operation = None

        def gate():
            result = native()
            committed.set()
            release.wait(5)
            return result

        def has_summary(messages):
            return any("context summary" in str(m.get("content", "")).lower() or m.get("_compressed_summary") for m in messages)

        try:
            f.session.agent.context_compressor.tail_token_budget = 1
            f.seeding = True
            for _ in range(3):
                await f.session.prompt("合成待压缩记录。" * 1000)
            f.seeding = False
            with patch.object(f.session, "_compact_native", gate):
                operation = asyncio.create_task(f.session.compact())
                await until(committed.is_set)
                self.assertTrue(has_summary(f.db.get_messages(f.session.session_id)))
                operation.cancel()
                release.set()
                with self.assertRaises(asyncio.CancelledError):
                    await operation
            await f.session.prompt("压缩提交后的合成追问。")
            self.assertEqual(f.parent, 1)
            messages = f.calls[-1]["body"]["messages"]
            self.assertTrue(any("任务结果由结构化运行时提供" in str(m.get("content", "")) for m in messages))
        finally:
            release.set()
            if operation is not None:
                await asyncio.gather(operation, return_exceptions=True)
            await f.close()

    async def test_close_cancels_running_child_with_executor_full(self):
        from agent import subagent_lifecycle as lifecycle

        f = await Fixture().open("lifecycle-close-saturated")
        pool = lifecycle._DaemonExecutor(max_workers=1)
        submitted, release = threading.Event(), threading.Event()
        native_launch, native_cancel = f.session.service.launch, f.session.service.cancel
        children, cancelled = [], []
        queued = None

        def launch(*args, **kwargs):
            handle = native_launch(*args, **kwargs)
            children.append(handle)
            if len(children) == 2:
                submitted.set()
                release.wait(5)
            return handle

        def cancel(handle, **kwargs):
            result = native_cancel(handle, **kwargs)
            cancelled.append(handle)
            if handle == children[0]:
                f.release_child.set()
            return result

        try:
            with patch.object(lifecycle, "_EXECUTOR", pool), patch.object(f.session.service, "launch", launch), patch.object(f.session.service, "cancel", cancel):
                await asyncio.to_thread(f.session.tool, "start_subagent", {"prompt": "CHILD_MARKER：占用唯一工作线程。"})
                await until(f.child_started.is_set)
                queued = asyncio.create_task(asyncio.to_thread(f.session.tool, "start_subagent", {"prompt": "CHILD_MARKER：在 executor 排队。"}))
                await until(submitted.is_set)
                closing = f.session.close()
                release.set()
                await asyncio.wait_for(closing, 3)
                with self.assertRaisesRegex(RuntimeError, "未发布 handle"):
                    await queued
                self.assertIn(children[0], cancelled)
                self.assertEqual(f.child, 1)
                self.assertTrue(f.session.agent.ypg_closed)
        finally:
            release.set()
            await f.release()
            if queued is not None:
                await asyncio.gather(queued, return_exceptions=True)
            await f.close()
            pool.shutdown(wait=True)


    async def test_queued_resume_preserves_input_version(self):
        f = await Fixture().open("resume-input")
        entered, release = asyncio.Event(), asyncio.Event()
        native_dispatch = f.session.core.dispatch
        async def delayed_resume(method, args):
            if method == "resume":
                entered.set()
                await release.wait()
            return await native_dispatch(method, args)
        f.session.core.dispatch = delayed_resume
        try:
            await f.session.prompt("启动合成任务并等待。")
            await f.release()
            await asyncio.wait_for(entered.wait(), 5)
            await f.session.prompt("已结算结果尚未接纳时的新输入。")
            self.assertEqual(f.parent, 3)
            release.set()
            await until(lambda: f.parent == 5 and not f.session._queue.locked())
            state = await f.session.snapshot()
            self.assertEqual(len(state["waits"]), 1)
            self.assertEqual(state["waits"][0]["reason"], "succeeded")
            self.assertEqual(len(f.session.accepted), 1)
        finally:
            release.set()
            await f.close()

    async def test_default_native_persistence(self):
        f = await Fixture().open("lifecycle-persistence")
        other = None
        try:
            options = {key: value for key, value in f.options.items() if key != "session_db"}
            other = await create_hermes_session({**options, "session_id": None}, scheduling={"thresholdTokens": 999999})
            await other.prompt("合成默认持久化检查。")
            await asyncio.to_thread(other.tool, "start_process", {"command": "printf IDENTITY"})
            state = await other.snapshot()
            self.assertEqual(state["tasks"][0]["handle"]["sessionID"], other.agent.session_id)
            self.assertIsNotNone(other._owned_db)
            self.assertTrue(other._owned_db.get_messages(other.session_id))
            await other.close()
            self.assertIsNone(other._owned_db)
        finally:
            if other:
                await other.close()
            await f.close()

    async def test_terminal_entry(self):
        f = await Fixture().open("lifecycle-cli")
        process = None
        try:
            options = {key: value for key, value in f.options.items() if key != "session_db"}
            path = f.cwd / "options.json"
            path.write_text(json.dumps(options), encoding="utf-8")
            process = await asyncio.create_subprocess_exec(sys.executable, "-m", "yunpiangao_hermes", "--agent-options", str(path),
                                                          stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
            while b"/close" not in await process.stdout.readline():
                self.assertIsNone(process.returncode)
            process.stdin.write("合成终端入口检查。\n".encode())
            await process.stdin.drain()
            await until(lambda: f.parent == 1)
            line = await process.stdout.readline()
            self.assertIn("合成任务已完成", line.decode())
            process.stdin.write(b"/close\n"); await process.stdin.drain()
            _, errors = await process.communicate()
            self.assertEqual(process.returncode, 0, errors.decode())
        finally:
            if process is not None and process.returncode is None:
                process.kill(); await process.wait()
            await f.close()

    async def test_input_during_model_request(self):
        f = await Fixture().open("input-stream")
        try:
            running = asyncio.create_task(f.session.prompt("启动合成任务并等待。"))
            await until(f.wait_started.is_set)
            newer = asyncio.create_task(f.session.prompt("等待工具尚未返回时到达的新输入。"))
            await until(lambda: f.session.epoch == 2)
            f.release_wait.set()
            await running
            await newer
            self.assertEqual(f.parent, 4)
            self.assertEqual((await f.session.snapshot())["waits"], [])
            self.assertEqual((await f.session.snapshot())["tasks"][0]["status"], "working")
            await f.release()
            await asyncio.sleep(.05)
            self.assertEqual(f.parent, 4)
            self.assertEqual(f.session.accepted, set())
        finally:
            await f.close()

    async def test_terminal_scope_is_preserved(self):
        f = await Fixture().open("lifecycle-scope")
        other = None
        try:
            other = await create_hermes_session({**f.options, "enabled_toolsets": ["context_engine"], "disabled_toolsets": ["terminal"]})
            self.assertNotIn("terminal", other.agent.valid_tool_names)
            with self.assertRaisesRegex(RuntimeError, "terminal"):
                await asyncio.to_thread(other.tool, "start_process", {"command": "printf BAD"})
            self.assertEqual((await other.snapshot())["tasks"], [])
            self.assertEqual(f.calls, [])
        finally:
            if other:
                await other.close()
            await f.close()

    async def test_close_during_native_compaction(self):
        f = await Fixture().open("compact-race")
        compacting = None
        try:
            f.session.agent.context_compressor.tail_token_budget = 1
            f.seeding = True
            await f.session.prompt("合成历史用户目标。" * 1000)
            f.seeding = False
            await f.session.prompt("启动合成任务并等待。")
            f.block_summary = True
            compacting = asyncio.create_task(f.session.compact())
            await until(f.summary_started.is_set)
            closing = f.session.close()
            await f.release()
            f.release_summary.set()
            await closing
            await asyncio.gather(compacting, return_exceptions=True)
            self.assertEqual(f.parent, 2)
            self.assertEqual(f.session.accepted, set())
            self.assertTrue(f.session.agent.ypg_closed)
            self.assertEqual((await f.session.snapshot())["waits"][0]["reason"], "closed")
        finally:
            f.release_summary.set()
            if compacting:
                await asyncio.gather(compacting, return_exceptions=True)
            await f.close()

    async def test_independent_child_survives_parent_interrupt(self):
        f = await Fixture().open("child")
        try:
            await f.session.prompt("启动原生子 Agent 并等待。")
            await f.session.interrupt()
            await asyncio.to_thread(f.session.agent.interrupt)
            self.assertEqual((await f.session.snapshot())["waits"][0]["reason"], "interrupted")
            await f.release()
            await f.session.core.request("refresh")
            async def completed():
                await f.session.core.request("refresh")
                return (await f.session.snapshot())["tasks"][0]["status"] == "succeeded"
            await until(completed)
            self.assertEqual(f.parent, 2)
        finally:
            await f.close()

    async def test_parent_creation_failure(self):
        f = await Fixture().open("lifecycle-parent-failure")
        original = AIAgent.close
        closed = []
        bridges = []
        native_bridge = CoreBridge.create
        async def record_bridge(*args, **kwargs):
            bridge = await native_bridge(*args, **kwargs)
            bridges.append(bridge)
            return bridge
        def record_close(agent):
            closed.append(agent)
            return original(agent)
        try:
            with patch.object(AIAgent, "close", record_close), patch.object(CoreBridge, "create", record_bridge), patch("agent.agent_init._build_context_engine", side_effect=RuntimeError("合成创建失败")):
                with self.assertRaisesRegex(RuntimeError, "合成创建失败"):
                    await create_hermes_session(f.options)
            self.assertEqual(len(closed), 1)
            self.assertTrue(all(bridge.process.returncode == 0 for bridge in bridges))
            self.assertEqual(len(f.calls), 0)
        finally:
            await f.close()

    async def test_parent_creation_cancellation(self):
        f = await Fixture().open("lifecycle-parent-cancel")
        entered, release = threading.Event(), threading.Event()
        original = HermesAgent.__init__
        created = []
        def blocked(agent, **kwargs):
            original(agent, **kwargs)
            created.append(agent)
            entered.set(); release.wait(10)
        try:
            with patch.object(HermesAgent, "__init__", blocked):
                creation = asyncio.create_task(create_hermes_session(f.options))
                await until(entered.is_set)
                creation.cancel()
                await asyncio.sleep(.01)
                self.assertFalse(creation.done())
                release.set()
                with self.assertRaises(asyncio.CancelledError):
                    await creation
            self.assertEqual(len(created), 1)
            self.assertTrue(created[0].ypg_closed)
            self.assertEqual(len(f.calls), 0)
        finally:
            release.set()
            await f.close()

    async def test_child_publish_failure(self):
        f = await Fixture().open("lifecycle-child-failure")
        import agent.subagent_lifecycle as lifecycle
        import tools.delegate_tool as delegate
        original = delegate._close_child
        closed = []
        def record_close(child, message):
            closed.append(child)
            return original(child, message)
        try:
            with patch.object(lifecycle._EXECUTOR, "submit", side_effect=RuntimeError("合成发布失败")), patch.object(delegate, "_close_child", record_close):
                with self.assertRaisesRegex(RuntimeError, "合成发布失败"):
                    await asyncio.to_thread(f.session.tool, "start_subagent", {"prompt": "CHILD_MARKER：创建失败。"})
            self.assertEqual(len(closed), 1)
            self.assertEqual((await f.session.snapshot())["tasks"], [])
            self.assertEqual(f.child, 0)
            self.assertFalse(any(record.handle.parent_session_id == f.session.session_id for record in lifecycle._REGISTRY.records.values()))
        finally:
            await f.close()

    async def child_creation_close(self, phase):
        f = await Fixture().open("lifecycle-child-close-" + phase)
        import tools.delegate_tool as delegate
        original = delegate._build_child_preserving_parent_tools
        entered, release = threading.Event(), threading.Event()
        created = []
        def blocked(**kwargs):
            if phase == "before":
                entered.set(); release.wait(10)
            child = original(**kwargs)
            created.append(child)
            if phase == "after":
                entered.set(); release.wait(10)
            return child
        try:
            with patch.object(delegate, "_build_child_preserving_parent_tools", blocked):
                creation = asyncio.create_task(asyncio.to_thread(f.session.tool, "start_subagent", {"prompt": "CHILD_MARKER：关闭竞争。"}))
                await until(entered.is_set)
                closing = f.session.close()
                await asyncio.sleep(.02)
                self.assertFalse(closing.done())
                release.set()
                result = await asyncio.gather(creation, return_exceptions=True)
                self.assertIsInstance(result[0], SubagentLifecycleError)
                await closing
            self.assertEqual(f.child, 0)
            self.assertEqual((await f.session.snapshot())["tasks"], [])
            self.assertTrue(created)
        finally:
            release.set()
            await f.close()

    async def test_child_close_before_create(self):
        await self.child_creation_close("before")

    async def test_child_close_after_create(self):
        await self.child_creation_close("after")

    async def test_native_reset_invalidates(self):
        f = await Fixture().open("lifecycle-reset")
        try:
            await asyncio.to_thread(f.session.agent.reset_session_state)
            await until(lambda: f.session.closed)
            await f.session.close()
            with self.assertRaisesRegex(RuntimeError, "已关闭"):
                await f.session.prompt("旧实例不可继续。")
            with self.assertRaisesRegex(RuntimeError, "已关闭"):
                await asyncio.to_thread(f.session.tool, "start_process", {"command": "printf BAD"})
            self.assertEqual(len(f.calls), 0)
        finally:
            await f.close()

    async def test_native_close_invalidates(self):
        f = await Fixture().open("lifecycle-native-close")
        try:
            await asyncio.to_thread(f.session.agent.close)
            await until(lambda: f.session.closed)
            await f.session.close()
            with self.assertRaisesRegex(RuntimeError, "已关闭"):
                await f.session.interrupt()
        finally:
            await f.close()

    async def test_session_identity_invalidates(self):
        f = await Fixture().open("lifecycle-branch")
        try:
            # 嵌入入口不接管 fork/branch；直接切换身份必须使旧实例失败。
            f.session.agent.session_id = "synthetic-new-session"
            with self.assertRaisesRegex(RuntimeError, "已切换"):
                await f.session.prompt("旧 handle 不可迁移。")
            await until(lambda: f.session.closed)
            await f.session.close()
            self.assertEqual(len(f.calls), 0)
        finally:
            await f.close()

    async def test_reentrant_close(self):
        f = await Fixture().open("lifecycle-reentry")
        original = f.session.agent.interrupt
        observed = []
        def reenter(*args, **kwargs):
            f.loop.call_soon_threadsafe(lambda: observed.append(f.session.close()))
            return original(*args, **kwargs)
        try:
            with patch.object(f.session.agent, "interrupt", reenter):
                first = f.session.close()
                cleanup = f.session._closing
                await asyncio.gather(first, f.session.close())
            self.assertEqual(len(observed), 1)
            await observed[0]
            self.assertIs(f.session._closing, cleanup)
        finally:
            await f.close()

    async def summary_scenario(self, name):
        f = await Fixture().open(name, {"thresholdTokens": 1000, "idleDelayMs": 5})
        try:
            f.session.agent.context_compressor.tail_token_budget = 1
            f.seeding = True
            for _ in range(3):
                await f.session.prompt("合成历史用户目标。" * 1000)
            f.seeding = False
            before = f.db.get_messages(f.session.session_id)
            if name == "summary-stale":
                f.block_summary = True
            if name == "summary-recheck":
                native = f.session._compact_native
                def change_prompt():
                    f.session.agent._cached_system_prompt += "提交边界的合成变化。"
                    return native()
                f.session._compact_native = change_prompt
            await f.session.prompt("生成完整合成回答，以触发空闲摘要。")
            await until(f.summary_started.is_set)
            if name == "summary-stale":
                await f.session.prompt("用户新输入使正在准备的旧摘要失效。")
                f.release_summary.set()
            if name == "summary-commit":
                await until(lambda: any("context summary" in str(m.get("content", "")).lower() for m in f.db.get_messages(f.session.session_id)))
            else:
                await asyncio.sleep(.15)
            after = f.db.get_messages(f.session.session_id)
            compacted = any("context summary" in str(m.get("content", "")).lower() for m in after)
            self.assertEqual(compacted, name == "summary-commit")
            self.assertEqual(f.summaries, 1)
            self.assertFalse(f.session.closed)
            if name == "summary-commit":
                self.assertLess(len(json.dumps(after)), len(json.dumps(before)))
        finally:
            await f.close()

    async def test_summary_commit(self):
        await self.summary_scenario("summary-commit")

    async def test_summary_stale(self):
        await self.summary_scenario("summary-stale")

    async def test_summary_recheck(self):
        await self.summary_scenario("summary-recheck")


for name in ("complete", "race", "before", "failure", "timeout", "input", "cancel", "compact", "compact-race", "child", "child-input", "child-cancel", "child-failure", "interrupt", "resume-ack", "batch", "child-compact"):
    def scenario_test(name):
        async def run(self):
            await self.scenario(name)
        return run
    setattr(RuntimeTests, "test_" + name.replace("-", "_"), scenario_test(name))


if __name__ == "__main__":
    try:
        unittest.main()
    finally:
        SERVER.shutdown()
        SERVER.server_close()
        shutil.rmtree(ROOT)
