"""Hermes 专用双向管道；状态机仅运行于 Node 子进程。"""
import asyncio
import json
from pathlib import Path


class CoreBridge:
    def __init__(self, process, dispatch):
        self.process = process
        self.dispatch = dispatch
        self.sequence = 0
        self.pending = {}
        self.calls = {}
        self.reader = asyncio.create_task(self._read())

    @classmethod
    async def create(cls, dispatch, *, node="node", core=None):
        core = Path(core) if core else Path(__file__).resolve().parents[4] / "dist/adapters/hermes/core.js"
        process = await asyncio.create_subprocess_exec(
            node, str(core), stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
            limit=16 * 1024 * 1024,
        )
        return cls(process, dispatch)

    async def _send(self, message):
        self.process.stdin.write((json.dumps(message, ensure_ascii=False) + "\n").encode())
        await self.process.stdin.drain()

    async def request(self, method, args=None):
        if self.reader.done() or self.process.returncode is not None:
            raise RuntimeError("Hermes 核心管道已关闭。")
        self.sequence += 1
        ident = self.sequence
        future = asyncio.get_running_loop().create_future()
        self.pending[ident] = future
        try:
            await self._send({"id": ident, "method": method, "args": args or {}})
            return await future
        finally:
            self.pending.pop(ident, None)

    async def _dispatch(self, message):
        ident = message["id"]
        try:
            value = await self.dispatch(message["method"], message.get("args", {}))
            await self._send({"reply": ident, "value": value})
        except asyncio.CancelledError:
            await self._send({"reply": ident, "error": "Hermes 操作已取消。"})
        except Exception as error:
            await self._send({"reply": ident, "error": str(error)})
        finally:
            self.calls.pop(ident, None)

    async def _read(self):
        try:
            while line := await self.process.stdout.readline():
                message = json.loads(line)
                if "reply" in message:
                    future = self.pending.get(message["reply"])
                    if future and not future.done():
                        if message.get("error"):
                            future.set_exception(RuntimeError(message["error"]))
                        else:
                            future.set_result(message.get("value"))
                elif "abort" in message:
                    task = self.calls.get(message["abort"])
                    if task:
                        task.cancel()
                else:
                    self.calls[message["id"]] = asyncio.create_task(self._dispatch(message))
        finally:
            for future in self.pending.values():
                if not future.done():
                    future.set_exception(RuntimeError("Hermes 核心管道已关闭。"))

    async def close(self, *, snapshot=False):
        state = None
        try:
            if not self.reader.done() and self.process.returncode is None:
                await self.request("close")
                if snapshot:
                    state = await self.request("snapshot")
        finally:
            self.process.stdin.close()
            await self.process.wait()
            await self.reader
            await asyncio.gather(*self.calls.values(), return_exceptions=True)
        return state
