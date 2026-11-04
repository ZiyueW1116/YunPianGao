"""通过 OpenHands 原生工具调度及安全检查进入适配层。"""

import json
import threading
import weakref

from pydantic import Field
from openhands.sdk import Action, Observation, TextContent, ToolDefinition
from openhands.sdk.tool import ToolExecutor, register_tool


_owners = weakref.WeakValueDictionary()
_owners_lock = threading.Lock()


class ProcessAction(Action):
    command: str
    args: list[str] = Field(default_factory=list)


class SubagentAction(Action):
    prompt: str
    description: str


class WaitAction(Action):
    handle: str
    timeout: float = Field(default=600, ge=0, le=2147483)


class CancelAction(Action):
    handle: str


class Result(Observation):
    value: dict

    @property
    def to_llm_content(self):
        return [TextContent(text=json.dumps(self.value, ensure_ascii=False))]


class Executor(ToolExecutor):
    def __init__(self, owner, operation):
        self.owner, self.operation = owner, operation

    def __call__(self, action, conversation=None):
        self.owner._require_open()
        if conversation is not self.owner.conversation:
            raise RuntimeError("工具不属于这个 Conversation，请创建新的云片糕实例。")
        return Result(value=self.owner._tool(self.operation, action))


class StartProcess(ToolDefinition):
    name = "start_process"

    @classmethod
    def create(cls, conv_state, owner_id):
        return _create(cls, owner_id, "start_process", ProcessAction,
            "启动当前目录下的具体进程，不经 shell；立即返回执行 handle。原生工具权限检查仍适用。")


class StartSubagent(ToolDefinition):
    name = "start_subagent"

    @classmethod
    def create(cls, conv_state, owner_id):
        return _create(cls, owner_id, "start_subagent", SubagentAction,
            "启动独立 OpenHands Conversation，返回本次执行 handle。子会话使用相同模型、原生工具与安全配置，不加载云片糕工具。")


class WaitFor(ToolDefinition):
    name = "wait_for"
    conversation_local = True

    @classmethod
    def create(cls, conv_state, owner_id):
        return _create(cls, owner_id, "wait_for", WaitAction,
            "等待具体执行 handle，一轮只调用一次。timeout 单位为秒；runtime 在步骤收尾后停放，在结果或期限到达时接续。超时或用户输入只结束这次等待，任务继续，可重等。")


class CancelTask(ToolDefinition):
    name = "cancel_task"

    @classmethod
    def create(cls, conv_state, owner_id):
        return _create(cls, owner_id, "cancel_task", CancelAction,
            "独立请求取消 handle 对应的执行。进程发送 SIGTERM；子 Conversation 在下一步骤边界暂停。回执不表示已经完成取消。")


def _create(cls, owner_id, operation, action, description):
    with _owners_lock:
        owner = _owners.get(owner_id)
    if owner is None:
        raise RuntimeError("云片糕工具的实例已释放，请创建新的入口。")
    owner._require_open()
    return [cls(description=description, action_type=action,
                observation_type=Result, executor=Executor(owner, operation))]


TOOLS = [StartProcess, StartSubagent, WaitFor, CancelTask]
for tool in TOOLS:
    register_tool(tool.name, tool)
