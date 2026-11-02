import test from "node:test"
import assert from "node:assert/strict"
import adapter from "../dist/adapters/opencode.js"

test("事件流结束或断开时取消待执行计划，卸载仍释放全部钩子", async () => {
  for (const fails of [false, true]) {
    let finish, ready, reads = 0, disposed = 0
    const started = new Promise((resolve) => { ready = resolve })
    const stopped = new Promise((resolve) => { finish = resolve })
    const ctx = {
      options: { idleDelayMs: 50 },
      location: { directory: "synthetic-workspace" },
      session: {
        async hook() { return { async dispose() { disposed += 1 } } },
        async get() { reads += 1 },
      },
      event: { async *subscribe() {
        yield { type: "session.execution.succeeded", data: { sessionID: "synthetic-session" } }
        ready()
        await stopped
        if (fails) throw new Error("合成事件流中断")
      } },
    }
    const cleanup = await adapter.setup(ctx)
    await started
    finish()
    await new Promise((resolve) => setTimeout(resolve, 80))
    assert.equal(reads, 0)
    await cleanup()
    assert.equal(disposed, 3)
  }
})

test("部分钩子注册失败时释放已经注册的钩子", async () => {
  let disposed = 0
  await assert.rejects(adapter.setup({
    options: {},
    session: { async hook(kind) {
      if (kind === "generate") throw new Error("合成注册失败")
      return { async dispose() { disposed += 1 } }
    } },
  }), /合成注册失败/)
  assert.equal(disposed, 1)
})
