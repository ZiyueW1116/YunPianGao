"""使用原生压缩器准备候选；提交仍经过 Hermes 的压缩事务。"""
import copy
import json

from agent.context_compressor import ContextCompressor


class PreparedEngine(ContextCompressor):
    @property
    def name(self):
        return "yunpiangao"

    def get_tool_schemas(self):
        specifications = [
            ("start_process", "通过 Hermes 原生 terminal 启动后台命令，立即返回具体执行 handle。权限与执行环境由 Hermes 管理。", {"command": {"type": "string"}}, ["command"]),
            ("start_subagent", "启动原生 Hermes 独立子 Agent，立即返回 handle；需要结果时使用 wait_for。", {"prompt": {"type": "string"}}, ["prompt"]),
            ("wait_for", "等待具体 handle，一轮只调用一次。timeout 单位秒，默认600。运行时停放并在完成、失败、取消或超时时接续；超时与新输入不取消任务，可重等同一 handle。不要长 sleep 或轮询。", {"handle": {"type": "string"}, "timeout": {"type": "number", "minimum": 0, "maximum": 2147483}}, ["handle"]),
            ("cancel_task", "独立请求取消指定 handle；结束一次等待不等于取消任务。", {"handle": {"type": "string"}}, ["handle"]),
        ]
        return [{"type": "function", "function": {"name": name, "description": description, "parameters": {"type": "object", "properties": properties, "required": required, "additionalProperties": False}}} for name, description, properties, required in specifications]

    def handle_tool_call(self, name, args, **kwargs):
        return json.dumps(self.owner.tool(name, args), ensure_ascii=False)

    def compress(self, messages, current_tokens=None, focus_topic=None, force=False, memory_context="", **kwargs):
        if not self.owner.committing:
            return super().compress(messages, current_tokens=current_tokens, focus_topic=focus_topic,
                                    force=force, memory_context=memory_context, **kwargs)
        # 当前 messages 属于原生压缩 lease；owner 的提交锁一直持有到事务返回。
        text = self.owner.sync("takePrepared", {"fingerprint": self.owner.fingerprint(messages)})
        if not text or self.owner.candidate is None or text != self.owner.candidate["text"]:
            raise RuntimeError("待提交摘要失效；保留完整上下文。")
        candidate = self.owner.candidate
        for key, value in candidate["state"].items():
            setattr(self, key, value)
        return copy.deepcopy(candidate["messages"])

    def on_session_reset(self):
        super().on_session_reset()
        self.owner.invalidate()

    def update_model(self, *args, **kwargs):
        super().update_model(*args, **kwargs)
        self.owner.invalidate()
