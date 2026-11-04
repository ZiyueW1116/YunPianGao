"""把原生进程与生命周期 handle 转为核心 TaskSnapshot。"""
import time

from tools.process_registry import process_registry


class ProcessTask:
    def __init__(self, session):
        self.session = session
        self.cancelled = False
        self.cancelling = False

    def read(self):
        # 持有具体对象，不按可缩写 ID 重新查找，也不受原生完成缓存过期影响。
        session = self.session
        with session._lock:
            if self.cancelling or not session.exited or not session._completion_event.is_set():
                return {"status": "working"}
            return {"status": "cancelled" if self.cancelled and session.completion_reason == "killed" else "succeeded" if session.exit_code == 0 else "failed",
                    "finishedAt": int((session.exited_at or time.time()) * 1000),
                    "result": {"exitCode": session.exit_code, "completionReason": session.completion_reason, "output": session.output_buffer[-65536:]}}

    def cancel(self):
        if not self.session.exited:
            self.cancelled = self.cancelling = True
            try:
                process_registry.kill_process(self.session.id)
            finally:
                self.cancelling = False


class ChildTask:
    def __init__(self, service, handle):
        self.service, self.handle = service, handle

    def read(self):
        value = self.service.result(self.handle)
        if not value.ready:
            if value.error_classification == "UNKNOWN_HANDLE":
                raise RuntimeError("原生子 Agent handle 已失效。")
            return {"status": "working"}
        state = value.terminal_state.value
        return {"status": "succeeded" if state == "SUCCEEDED" else "cancelled" if state in ("CANCELLED", "INTERRUPTED") else "failed",
                "finishedAt": int(value.completed_at * 1000), "result": {"summary": value.summary, "resultHash": value.result_hash},
                **({"error": value.error_message} if value.error_message else {})}

    def cancel(self):
        self.service.cancel(self.handle, reason="用户独立取消任务")

    def wait(self):
        return self.service.wait(self.handle)
