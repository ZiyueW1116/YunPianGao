"""本机模型替身经真实 OpenHands Conversation 与产品入口验收。"""

import json
import os
import re
from pathlib import Path
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

ROOT = Path(__file__).resolve().parents[1]
ISOLATED = tempfile.TemporaryDirectory(prefix="ypg-openhands-global-")
os.environ["OH_PERSISTENCE_DIR"] = str(Path(ISOLATED.name) / "openhands")
os.environ["LOG_DIR"] = str(Path(ISOLATED.name) / "logs")
os.environ["LOG_LEVEL"] = "ERROR"
os.environ["LITELLM_LOCAL_MODEL_COST_MAP"] = "True"
os.environ["TIKTOKEN_CACHE_DIR"] = str(Path(ISOLATED.name) / "tokens")
os.environ["HF_HOME"] = str(Path(ISOLATED.name) / "hf")
for key in ("LMNR_PROJECT_API_KEY", "OTEL_ENDPOINT", "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "OTEL_EXPORTER_OTLP_ENDPOINT"):
    os.environ.pop(key, None)
sys.path.insert(0, str(ROOT / "python"))

from openhands.sdk import Action, Agent, LLM, Observation, TextContent, Tool, ToolDefinition
from openhands.sdk.tool import ToolExecutor, register_tool
from openhands.sdk.context.condenser import LLMSummarizingCondenser
from openhands.sdk.event import ActionEvent, Condensation, MessageEvent, ObservationEvent
from openhands.sdk.conversation.impl.local_conversation import LocalConversation
from openhands.sdk.security.confirmation_policy import AlwaysConfirm, NeverConfirm
from yunpiangao_openhands import OpenHandsSession
from yunpiangao_openhands.session import ManagedConversation



class ProofAction(Action):
    text: str


class ProofObservation(Observation):
    @property
    def to_llm_content(self):
        return [TextContent(text="权限检查已通过。")]


class ProofExecutor(ToolExecutor):
    def __call__(self, action, conversation=None):
        (Path(conversation.workspace.working_dir) / "permission-proof").write_text(action.text)
        return ProofObservation()


class ProofTool(ToolDefinition):
    name = "proof"

    @classmethod
    def create(cls, conv_state, **params):
        return [cls(description="写入合成权限检查标记。", action_type=ProofAction,
                    observation_type=ProofObservation, executor=ProofExecutor())]


register_tool(ProofTool.name, ProofTool)


def until(check, timeout=12):
    start = time.monotonic()
    while not check():
        if time.monotonic() - start > timeout:
            raise AssertionError("OpenHands 真实入口没有到达预期状态")
        time.sleep(.005)


class Fixture:
    def __init__(self, name, scheduling=None, native_max_size=20, conversation_settings=None):
        self.name = name
        self.tmp = tempfile.TemporaryDirectory(prefix="ypg-openhands-")
        self.root = Path(self.tmp.name)
        self.cwd = self.root / "project"
        self.cwd.mkdir()
        self.parent = self.child = self.summaries = 0
        self.calls = []
        self.errors = []
        self.release_child = threading.Event()
        self.release_summary = threading.Event()
        self.release_wait = threading.Event()
        fixture = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                try:
                    body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                    kind = "summary" if not body.get("tools") else "child" if any(message["role"] == "user" and "CHILD_MARKER" in json.dumps(message.get("content")) for message in body["messages"]) else "parent"
                    fixture.calls.append({"kind": kind, "at": int(time.time() * 1000), "body": body})
                    tool = None
                    text = "合成任务已完成。"
                    if kind == "summary":
                        fixture.summaries += 1
                        if name in ("summary-stale", "compact-race", "close-compact"):
                            fixture.release_summary.wait(15)
                        text = "## 目标\n完成合成任务。\n## 状态\n精确标识与依赖由运行时复核。"
                    elif kind == "child":
                        fixture.child += 1
                        fixture.release_child.wait(15)
                        if name == "child-failure":
                            self.send_response(400); self.end_headers(); self.wfile.write(b'{"error":{"message":"synthetic failure","type":"invalid_request_error"}}'); return
                        if name == "child-confirm" and fixture.child == 1:
                            tool = ("proof", {"text": "合成权限检查"})
                        if name == "child-finish":
                            tool = ("finish", {"message": "合成子任务完成。"})
                    else:
                        fixture.parent += 1
                        tool = fixture.choose(fixture.parent)
                        if name == "before" and fixture.parent == 2:
                            until(lambda: fixture.session.snapshot()["tasks"][0]["status"] == "succeeded")
                        if name == "input-stream" and fixture.parent == 2:
                            fixture.release_wait.wait(15)
                    message = {"role": "assistant", "content": text}
                    if tool:
                        message["content"] = None
                        message["tool_calls"] = [{"id": "call_" + str(len(fixture.calls)), "type": "function", "function": {"name": tool[0], "arguments": json.dumps(tool[1])}}]
                        if name == "batch" and kind == "parent" and fixture.parent == 2:
                            message["tool_calls"].append({"id": "batch_extra", "type": "function", "function": {"name": "start_process", "arguments": json.dumps({"command": sys.executable, "args": ["-c", "print('BATCH')"]})}})
                    tokens = 1000 if name.startswith("summary") and fixture.parent == 1 else 10
                    response = {"id": "fixture_" + str(len(fixture.calls)), "object": "chat.completion", "created": int(time.time()), "model": "fixture", "choices": [{"index": 0, "message": message, "finish_reason": "tool_calls" if tool else "stop"}], "usage": {"prompt_tokens": tokens, "completion_tokens": 10, "total_tokens": tokens + 10}}
                    raw = json.dumps(response).encode()
                    self.send_response(200); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(raw))); self.end_headers(); self.wfile.write(raw)
                except (BrokenPipeError, ConnectionResetError):
                    pass
                except BaseException as error:
                    fixture.errors.append(error)
                    self.send_error(500)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        llm = LLM(model="openai/fixture", api_key="synthetic-only", base_url="http://127.0.0.1:" + str(self.server.server_port) + "/v1", stream=False, num_retries=0, timeout=20, max_input_tokens=100000, max_output_tokens=4096, caching_prompt=False, input_cost_per_token=0, output_cost_per_token=0)
        self.agent = Agent(llm=llm, tools=[Tool(name=ProofTool.name)], condenser=LLMSummarizingCondenser(llm=llm.model_copy(update={"usage_id": "condenser"}), max_size=native_max_size, keep_first=1))
        self.options = {"agent": self.agent, "workspace": str(self.cwd), "core_entry": ROOT / "dist/adapters/openhands-core.js", "persistence_dir": self.root / "sessions", "profile_store_dir": self.root / "profiles", "visualizer": None, "stuck_detection": False, "poll_interval_ms": 10, "scheduling": scheduling or {"thresholdTokens": 999999}}
        self.options.update(conversation_settings or {})
        self.session = OpenHandsSession(**self.options)

    def choose(self, n):
        if self.name.startswith("summary"):
            return None
        if n == 1:
            if self.name.startswith("child"):
                return "start_subagent", {"prompt": "CHILD_MARKER：返回合成结果。", "description": "合成子任务"}
            code = "print('DONE')" if self.name == "before" else "raise SystemExit(7)" if self.name == "failure" else "import pathlib,time\np=pathlib.Path('release')\nwhile not p.exists(): time.sleep(.005)\nprint('DONE')"
            return "start_process", {"command": sys.executable, "args": ["-c", code]}
        state = self.session.snapshot()
        handle = state["tasks"][0]["handle"]["id"]
        wait = lambda timeout=10: ("wait_for", {"handle": handle, "timeout": timeout})
        if n == 2:
            return wait(.04 if self.name in ("timeout", "race") else 10)
        if self.name == "timeout" and n == 3:
            return wait()
        if self.name in ("input", "child-input", "child-confirm") and n == 4:
            return wait()
        if self.name.endswith("cancel") and n == 3:
            return "cancel_task", {"handle": handle}
        if self.name.endswith("cancel") and n == 4:
            return wait()

    def release(self):
        self.release_child.set()
        (self.cwd / "release").touch()

    def close(self):
        self.release(); self.release_summary.set(); self.release_wait.set()
        if not self.session._closed:
            until(lambda: all(task["status"] != "working" for task in self.session.snapshot()["tasks"]))
        self.session.close().result(25)
        self.server.shutdown(); self.server.server_close(); self.thread.join()
        self.session._core.process.wait(5)
        self.tmp.cleanup()


@pytest.mark.parametrize("name", ["complete", "before", "failure", "timeout", "input", "cancel", "compact", "compact-race", "child", "child-input", "child-cancel", "child-failure", "child-finish", "interrupt", "batch", "child-compact"])
def test_runtime(name):
    f = Fixture(name)
    try:
        f.session.prompt("启动合成任务并等待。").result(15)
        until(lambda: len(f.session.snapshot()["waits"]) == 1)
        if name not in ("before", "failure"):
            time.sleep(.02)
            assert f.parent == 2
            assert f.session.snapshot()["tasks"][0]["status"] == "working"
        if name == "timeout":
            until(lambda: len(f.session.snapshot()["waits"]) == 2)
        if "input" in name or name.endswith("cancel"):
            f.session.prompt("用户介入：先处理本次输入。").result(15)
            assert f.session.snapshot()["waits"][0]["reason"] == "user_input"
            if "input" in name:
                assert f.session.snapshot()["tasks"][0]["status"] == "working"
                f.session.prompt("继续等待同一任务。").result(15)
        if name in ("compact", "compact-race", "child-compact"):
            compacting = f.session.condense()
            if name == "compact-race":
                until(lambda: f.summaries == 1)
                f.release()
                until(lambda: f.session._core.call("snapshot")["waits"][0].get("reason") == "succeeded")
                assert f.parent == 2
                f.release_summary.set()
            compacting.result(15)
            assert any(isinstance(event, Condensation) for event in f.session.conversation.state.events)
            if name != "compact-race":
                assert f.parent == 2
        if name == "interrupt":
            f.session.interrupt().result(15); f.release(); time.sleep(.08)
            assert f.session.snapshot()["waits"][0]["reason"] == "interrupted"
            assert f.parent == 2
            return
        f.release()
        expected = 4 if name == "timeout" else 5 if "input" in name or name.endswith("cancel") else 3
        until(lambda: f.parent == expected)
        until(lambda: f.session.snapshot()["waits"][-1]["state"] == "delivered")
        f.session._worker.submit(lambda: None).result(15)
        time.sleep(.03)
        state = f.session.snapshot(); last = state["waits"][-1]
        assert f.parent == expected
        assert last["reason"] == ("cancelled" if name.endswith("cancel") else "failed" if name in ("failure", "child-failure") else "succeeded")
        if name == "before":
            assert last["snapshot"]["finishedAt"] <= last["createdAt"]
        if name == "timeout":
            assert state["waits"][0]["reason"] == "timeout"
            assert state["waits"][0]["handle"] == last["handle"]
        resumes = [event for event in f.session.conversation.state.events if isinstance(event, MessageEvent) and (event.sender or "").startswith("yunpiangao.resume:")]
        assert len(resumes) == (2 if name == "timeout" else 1)
        final = [call for call in f.calls if call["kind"] == "parent"][-1]
        assert "云片糕任务运行时状态" in json.dumps(final["body"], ensure_ascii=False)
        assert all('"output": "DONE' not in json.dumps(message) for call in f.calls for message in call["body"]["messages"] if message["role"] == "system")
        if name == "child-finish":
            assert last["snapshot"]["result"]["text"] == "合成子任务完成。"
        assert not f.errors
        assert not f.session.diagnostics
        long_sleep = [event for event in f.session.conversation.state.events if isinstance(event, ActionEvent)
            and re.search(r"(?:\bsleep\s+|\b(?:time\.)?sleep\()(?:[6-9]\d|\d{3,})(?:\D|$)", json.dumps(event.action.model_dump()))]
        assert not long_sleep
        print(json.dumps({"scenario": name, "parentRequests": f.parent, "childRequests": f.child, "extraWakeups": f.parent - expected, "longSleepCalls": len(long_sleep), "completionToResumeMs": final["at"] - last["snapshot"].get("finishedAt", final["at"])}, ensure_ascii=False))
    finally:
        f.close()


@pytest.mark.parametrize("name", ["summary-commit", "summary-stale", "summary-recheck"])
def test_idle_summary(name, monkeypatch):
    f = Fixture(name, {"thresholdTokens": 100, "idleDelayMs": 5})
    try:
        if name == "summary-recheck":
            native = LocalConversation.condense
            def changed(conversation):
                f.session._epoch += 1
                return native(conversation)
            monkeypatch.setattr(LocalConversation, "condense", changed)
        f.session.prompt("合成摘要检查。").result(15)
        until(lambda: f.summaries == 1)
        if name == "summary-stale":
            f.session.prompt("新输入使摘要失效。").result(15)
            f.release_summary.set()
            time.sleep(.15)
        elif name == "summary-commit":
            until(lambda: any(isinstance(event, Condensation) for event in f.session.conversation.state.events))
        else:
            until(lambda: bool(f.session.diagnostics))
        condensed = [event for event in f.session.conversation.state.events if isinstance(event, Condensation)]
        assert len(condensed) == (1 if name == "summary-commit" else 0)
        assert f.summaries == 1
    finally:
        f.close()


def test_input_during_model():
    f = Fixture("input-stream")
    try:
        first = f.session.prompt("启动任务。")
        until(lambda: f.parent == 2)
        second = f.session.prompt("新输入先处理。")
        f.release_wait.set()
        first.result(15); second.result(15)
        assert not f.session.snapshot()["waits"]
        assert f.session.snapshot()["tasks"][0]["status"] == "working"
        assert f.parent == 4
    finally:
        f.close()


def test_resume_ack_lost(monkeypatch):
    f = Fixture("complete")
    try:
        native = LocalConversation.send_message
        thrown = False
        def send(conversation, message, sender=None):
            nonlocal thrown
            native(conversation, message, sender)
            if sender and sender.startswith("yunpiangao.resume:") and not thrown:
                thrown = True
                raise RuntimeError("合成接纳回执丢失")
        monkeypatch.setattr(LocalConversation, "send_message", send)
        f.session.prompt("启动合成任务。").result(15)
        f.release()
        until(lambda: f.session.snapshot()["waits"][0]["state"] == "delivered")
        # 已写入的输入仍需启动一次原生执行；回执丢失不允许重复追加。
        until(lambda: f.parent == 3)
        resumed = [event for event in f.session.conversation.state.events if isinstance(event, MessageEvent) and event.sender]
        assert len(resumed) == 1
        assert thrown
    finally:
        f.close()


def test_child_permission(monkeypatch):
    f = Fixture("child-confirm")
    try:
        native = LocalConversation.send_message
        def send(conversation, *args, **kwargs):
            if not isinstance(conversation, ManagedConversation):
                conversation.set_confirmation_policy(AlwaysConfirm())
            return native(conversation, *args, **kwargs)
        monkeypatch.setattr(LocalConversation, "send_message", send)
        f.session.prompt("启动合成子任务。").result(15)
        child = next(iter(f.session._children.values()))
        f.release_child.set()
        until(lambda: f.session.snapshot()["waits"][0].get("reason") == "input_required")
        until(lambda: f.parent == 3)
        assert child["snapshot"]["status"] == "input_required"
        assert not (f.cwd / "permission-proof").exists()
        handle = f.session.snapshot()["tasks"][0]["handle"]["id"]
        f.session.confirm_subagent(handle, approved=True)
        f.session.prompt("继续等待相同 handle。").result(15)
        until(lambda: f.parent == 5)
        assert f.session.snapshot()["waits"][-1]["reason"] == "succeeded"
        assert (f.cwd / "permission-proof").read_text() == "合成权限检查"
    finally:
        f.close()


@pytest.mark.parametrize("method", ["close", "switch", "fork", "branch"])
def test_native_lifecycle(method):
    f = Fixture("complete")
    forked = None
    try:
        f.session.prompt("启动任务。").result(15)
        tools = list(f.session.conversation.agent.tools_map.values())
        if method == "close":
            f.session.conversation.close()
        elif method == "switch":
            f.session.conversation.switch_llm(f.agent.llm.model_copy(update={"temperature": .2}))
        else:
            options = {"from_event_id": f.session.conversation.state.active_branch()[1].id} if method == "branch" else {}
            forked = f.session.conversation.fork(**options)
            assert all(tool.name not in ["start_process", "start_subagent", "wait_for", "cancel_task"] for tool in forked.agent.tools)
        close = f.session.close()
        assert close is f.session.close()
        close.result(15)
        f.release(); time.sleep(.05)
        assert f.parent == 2
        with pytest.raises(RuntimeError):
            f.session.interrupt()
        with pytest.raises(RuntimeError):
            f.session.prompt("旧实例不能复用。")
        old = next(tool for tool in tools if tool.name == "start_process")
        with pytest.raises(RuntimeError):
            old.executor(old.action_type(command=sys.executable, args=["-c", "print('unreachable')"]), f.session.conversation)
    finally:
        if forked:
            forked.close()
        f.close()


def test_reload_is_new_instance():
    f = Fixture("complete")
    try:
        f.session.prompt("启动任务。").result(15)
        f.session.close().result(15)
        replacement = OpenHandsSession(**f.options)
        try:
            assert replacement.snapshot() == {"tasks": [], "waits": []}
            assert f.session.snapshot()["tasks"]
            with pytest.raises(RuntimeError):
                f.session.run()
        finally:
            replacement.close().result(15)
            replacement._core.process.wait(5)
    finally:
        f.close()


@pytest.mark.parametrize("boundary", ["create", "initialize"])
def test_parent_creation_cleanup(boundary, monkeypatch):
    f = Fixture("summary-commit")
    try:
        f.session.close().result(15)
        native = ManagedConversation.__init__
        created = []
        def failed(self, *args, **kwargs):
            if boundary == "initialize":
                native(self, *args, **kwargs)
                created.append(self)
                raise RuntimeError("合成构造回执失败")
            raise RuntimeError("合成创建失败")
        monkeypatch.setattr(ManagedConversation, "__init__", failed)
        with pytest.raises(RuntimeError):
            OpenHandsSession(**f.options)
        assert all(conversation._cleanup_complete for conversation in created)
        monkeypatch.setattr(ManagedConversation, "__init__", native)
        replacement = OpenHandsSession(**f.options)
        replacement.close().result(15)
        replacement._core.process.wait(5)
    finally:
        f.close()


@pytest.mark.parametrize("boundary", ["constructor", "send"])
def test_child_creation_close(boundary, monkeypatch):
    f = Fixture("child")
    entered, release = threading.Event(), threading.Event()
    created = []
    original_init, original_send = LocalConversation.__init__, LocalConversation.send_message
    try:
        def init(conversation, *args, **kwargs):
            original_init(conversation, *args, **kwargs)
            if not isinstance(conversation, ManagedConversation):
                created.append(conversation)
                if boundary == "constructor":
                    entered.set(); assert release.wait(10)
        def send(conversation, *args, **kwargs):
            if not isinstance(conversation, ManagedConversation) and boundary == "send":
                entered.set(); assert release.wait(10)
            return original_send(conversation, *args, **kwargs)
        monkeypatch.setattr(LocalConversation, "__init__", init)
        monkeypatch.setattr(LocalConversation, "send_message", send)
        task = f.session.prompt("创建子任务。")
        assert entered.wait(10)
        closing = f.session.close()
        assert closing is f.session.close()
        assert not closing.done()
        release.set()
        closing.result(15); task.result(15)
        assert not f.session.snapshot()["tasks"]
        assert f.child == 0
        assert all(conversation._cleanup_complete for conversation in created)
    finally:
        release.set()
        f.close()


def test_close_reentrant(monkeypatch):
    f = Fixture("summary-commit")
    reentered = []
    original = LocalConversation.close
    try:
        def close(conversation):
            if conversation is f.session.conversation:
                reentered.append(f.session.close())
            return original(conversation)
        monkeypatch.setattr(LocalConversation, "close", close)
        closing = f.session.close()
        closing.result(15)
        assert reentered == [closing]
    finally:
        f.close()


@pytest.mark.parametrize("notifications", ["missing", "duplicate"])
def test_child_notification_compensation(notifications, monkeypatch):
    f = Fixture("child")
    try:
        native = f.session._core.call
        def call(method, params=None):
            if method == "child_changed":
                if notifications == "missing":
                    return None
                native(method, params)
                native(method, params)
            return native(method, params)
        monkeypatch.setattr(f.session._core, "call", call)
        f.session.prompt("启动子任务。").result(15)
        f.release()
        until(lambda: f.parent == 3)
        time.sleep(.05)
        assert f.parent == 3
        assert f.session.snapshot()["waits"][0]["reason"] == "succeeded"
        resumes = [event for event in f.session.conversation.state.events if isinstance(event, MessageEvent) and event.sender]
        assert len(resumes) == 1
    finally:
        f.close()


def test_close_during_manual_compaction():
    f = Fixture("close-compact")
    try:
        f.session.prompt("启动任务。").result(15)
        compacting = f.session.condense()
        until(lambda: f.summaries == 1)
        closing = f.session.close()
        f.release()
        f.release_summary.set()
        closing.result(15)
        compacting.result(15)
        assert f.parent == 2
    finally:
        f.close()


@pytest.mark.parametrize("boundary", ["create", "initialize", "send"])
def test_child_creation_failure(boundary, monkeypatch):
    f = Fixture("child")
    created = []
    try:
        f.session.send_message("初始化原生工具。").result(10)
        tool = f.session.conversation.agent.tools_map["start_subagent"]
        native_init, native_send = LocalConversation.__init__, LocalConversation.send_message
        def init(conversation, *args, **kwargs):
            if boundary == "create":
                raise RuntimeError("合成子创建失败")
            native_init(conversation, *args, **kwargs)
            created.append(conversation)
            if boundary == "initialize":
                raise RuntimeError("合成子构造回执失败")
        def send(conversation, *args, **kwargs):
            raise RuntimeError("合成子初始化失败")
        monkeypatch.setattr(LocalConversation, "__init__", init)
        if boundary == "send":
            monkeypatch.setattr(LocalConversation, "send_message", send)
        with pytest.raises(RuntimeError):
            tool.executor(tool.action_type(prompt="CHILD_MARKER", description="失败清理"), f.session.conversation)
        assert not f.session.snapshot()["tasks"]
        assert all(conversation._cleanup_complete for conversation in created)
        monkeypatch.setattr(LocalConversation, "__init__", native_init)
        monkeypatch.setattr(LocalConversation, "send_message", native_send)
        result = tool.executor(tool.action_type(prompt="CHILD_MARKER", description="恢复后创建"), f.session.conversation)
        assert result.value["handle"]["id"]
        f.release()
        until(lambda: f.session.snapshot()["tasks"][0]["status"] == "succeeded")
    finally:
        f.close()


def test_direct_creation_close(monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    f = Fixture("child")
    entered, release = threading.Event(), threading.Event()
    pool = ThreadPoolExecutor(max_workers=1)
    created = []
    try:
        f.session.send_message("初始化原生工具。").result(10)
        tool = f.session.conversation.agent.tools_map["start_subagent"]
        native = LocalConversation.__init__
        def init(conversation, *args, **kwargs):
            native(conversation, *args, **kwargs)
            created.append(conversation)
            entered.set(); assert release.wait(10)
        monkeypatch.setattr(LocalConversation, "__init__", init)
        creating = pool.submit(tool.executor, tool.action_type(prompt="CHILD_MARKER", description="独立创建"), f.session.conversation)
        assert entered.wait(10)
        closing = f.session.close()
        time.sleep(.02)
        assert not closing.done()
        release.set()
        with pytest.raises(RuntimeError):
            creating.result(10)
        closing.result(10)
        assert all(conversation._cleanup_complete for conversation in created)
        assert not f.session.snapshot()["tasks"]
        assert f.child == 0
    finally:
        release.set(); pool.shutdown(wait=True); f.close()


def test_native_automatic_condensation():
    f = Fixture("complete", native_max_size=6)
    try:
        f.session.prompt("启动任务。").result(15)
        f.release()
        until(lambda: f.parent == 3)
        f.session._worker.submit(lambda: None).result(15)
        assert f.summaries == 1
        assert any(isinstance(event, Condensation) for event in f.session.conversation.state.events)
        assert f.session.snapshot()["waits"][0]["reason"] == "succeeded"
        assert "云片糕任务运行时状态" in json.dumps(f.calls[-1]["body"], ensure_ascii=False)
    finally:
        f.close()


def test_completion_deadline_race():
    f = Fixture("race")
    try:
        f.session.prompt("启动任务。").result(15)
        deadline = f.session.snapshot()["waits"][0]["deadline"]
        time.sleep(max(0, (deadline - int(time.time() * 1000) - 5) / 1000))
        f.release()
        until(lambda: f.parent == 3)
        until(lambda: f.session.snapshot()["tasks"][0]["status"] == "succeeded")
        time.sleep(.05)
        state = f.session.snapshot()
        assert state["waits"][0]["reason"] in ("timeout", "succeeded")
        assert state["waits"][0]["state"] == "delivered"
        assert f.parent == 3
        assert len([event for event in f.session.conversation.state.events if isinstance(event, MessageEvent) and event.sender]) == 1
    finally:
        f.close()


def test_cli_entry():
    import subprocess
    f = Fixture("summary-cli")
    try:
        environment = dict(os.environ)
        environment.update({"PYTHONPATH": str(ROOT / "python"), "LLM_MODEL": "openai/fixture",
            "LLM_API_KEY": "synthetic-only", "LLM_BASE_URL": "http://127.0.0.1:" + str(f.server.server_port) + "/v1"})
        result = subprocess.run([sys.executable, "-m", "yunpiangao_openhands", "--core-entry", str(ROOT / "dist/adapters/openhands-core.js"),
            "--workspace", str(f.cwd), "--state-dir", str(f.root / "cli-state"), "--prompt", "合成 CLI 检查。"],
            input="/quit\n", capture_output=True, text=True, env=environment, timeout=20)
        assert result.returncode == 0, result.stderr
        assert "合成任务已完成" in result.stdout
        assert "入口保持运行" in result.stdout
        assert f.parent == 1
    finally:
        f.close()


def test_child_inherits_hooks_and_limits():
    from openhands.sdk.hooks import HookConfig
    hooks = HookConfig(user_prompt_submit=[{"matcher": "*", "hooks": [{"command": "printf '{\"decision\":\"deny\",\"reason\":\"合成输入限制\"}'; exit 2"}]}])
    f = Fixture("child", conversation_settings={"hook_config": hooks, "max_iteration_per_run": 7})
    try:
        f.session.send_message("初始化原生工具。").result(10)
        tool = f.session.conversation.agent.tools_map["start_subagent"]
        result = tool.executor(tool.action_type(prompt="CHILD_MARKER", description="原生限制"), f.session.conversation)
        handle = result.value["handle"]["id"]
        until(lambda: f.session.snapshot()["tasks"][0]["status"] != "working")
        child = next(iter(f.session._children.values()))["conversation"]
        assert child.max_iteration_per_run == 7
        assert child.state.hook_config == hooks
        assert f.child == 0
        assert f.session.snapshot()["tasks"][0]["handle"]["id"] == handle
        assert f.session.snapshot()["tasks"][0]["status"] == "failed"
    finally:
        f.close()


def test_close_during_idle_preparation():
    f = Fixture("summary-stale", {"thresholdTokens": 100, "idleDelayMs": 5})
    try:
        f.session.prompt("准备空闲摘要。").result(15)
        until(lambda: f.summaries == 1)
        closing = f.session.close()
        time.sleep(.02)
        assert not closing.done()
        f.release_summary.set()
        closing.result(15)
        assert f.parent == 1
        assert not any(isinstance(event, Condensation) for event in f.session.conversation.state.events)
    finally:
        f.close()
