"""OpenHands 专用管道：Node 拥有核心状态，Python 拥有 SDK 对象。"""

import json
import subprocess
import threading
from concurrent.futures import Future, ThreadPoolExecutor
from pathlib import Path


class CoreBridge:
    def __init__(self, entry: Path, dispatch, node: str = "node"):
        self._dispatch = dispatch
        self._lock = threading.Lock()
        self._pending = {}
        self._sequence = 0
        self._disconnected = False
        self._handlers = ThreadPoolExecutor(thread_name_prefix="ypg-port")
        self.diagnostics = []
        self.process = subprocess.Popen(
            [node, str(entry)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            text=True, encoding="utf-8", bufsize=1,
        )
        self._reader = threading.Thread(target=self._read, daemon=True)
        self._reader.start()

    def _write(self, frame):
        with self._lock:
            self.process.stdin.write(json.dumps(frame, ensure_ascii=False) + "\n")
            self.process.stdin.flush()

    def call(self, method, params=None):
        future = Future()
        with self._lock:
            if self._disconnected:
                raise RuntimeError("OpenHands 核心管道已断开。")
            self._sequence += 1
            request = self._sequence
            self._pending[request] = future
        try:
            self._write({"request": request, "method": method, "params": params or {}})
        except BaseException:
            with self._lock:
                self._pending.pop(request, None)
            raise
        return future.result()

    def _handle(self, frame):
        try:
            value = self._dispatch(frame["method"], frame["params"])
            reply = {"response": frame["request"], "result": value}
        except Exception as error:
            reply = {"response": frame["request"], "error": str(error)}
        try:
            self._write(reply)
        except (BrokenPipeError, ValueError):
            pass

    def _read(self):
        try:
            for line in self.process.stdout:
                frame = json.loads(line)
                if "response" in frame:
                    with self._lock:
                        future = self._pending.pop(frame["response"], None)
                    if future:
                        if "error" in frame:
                            future.set_exception(RuntimeError(frame["error"]))
                        else:
                            future.set_result(frame.get("result"))
                elif "request" in frame:
                    self._handlers.submit(self._handle, frame)
                elif "diagnostic" in frame:
                    self.diagnostics.append(frame["diagnostic"])
        finally:
            with self._lock:
                self._disconnected = True
                pending, self._pending = self._pending, {}
            for future in pending.values():
                future.set_exception(RuntimeError("OpenHands 核心管道已断开。"))

    def disconnect(self):
        # 独立进程仍由 Node 消费输出；不因适配实例关闭向任务发取消信号。
        self._handlers.shutdown(wait=True)
        self.process.stdin.close()
