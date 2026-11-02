import test from "node:test"
import assert from "node:assert/strict"
import { createWaitRuntime } from "../dist/index.js"

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const until = async (check) => {
  for (let i = 0; i < 200; i++) { if (check()) return; await sleep(2) }
  assert.fail("等待状态未在期限内变化")
}
function fixture(port = {}) {
  const delivered = [], errors = []
  let snapshot = { status: "working" }, notify = () => {}, cancels = 0, reads = 0, disconnected = false, stops = 0
  const runtime = createWaitRuntime({ async resume(record) { delivered.push(record) }, onError(error) { errors.push(error) }, ...port }, { pollIntervalMs: 5 })
  const handle = runtime.register("parent", "process", "call-one", {
    async read() { reads++; if (disconnected) throw new Error("合成断线"); return snapshot },
    subscribe(changed) { notify = changed; return () => { stops++ } },
    async cancel() { cancels++; snapshot = { status: "cancelled" } },
  })
  return { runtime, handle, delivered, errors,
    change(value, event = true) { snapshot = value; if (event) notify() },
    disconnect(value) { disconnected = value },
    counts() { return { cancels, reads, stops } },
  }
}

test("成功、失败、取消和介入各接续一次；重复通知不改变终态", async () => {
  for (const status of ["succeeded", "failed", "cancelled", "input_required"]) {
    const f = fixture()
    try {
      const wait = f.runtime.begin("parent", f.handle.id, 1000)
      f.runtime.activate(wait.id)
      f.change({ status, result: { output: "合成结果" }, error: status === "failed" ? "合成故障" : undefined })
      await until(() => f.delivered.length === 1)
      for (let i = 0; i < 3; i++) f.change({ status })
      await f.runtime.refresh()
      await sleep(10)
      assert.equal(f.delivered.length, 1)
      assert.equal(f.delivered[0].reason, status)
      assert.equal(f.delivered[0].handle.executionID, "call-one")
      assert.equal(f.counts().cancels, 0)
    } finally { await f.runtime.close() }
  }
})

test("先完成后注册，仍在宿主释放旧循环后接续", async () => {
  const f = fixture()
  try {
    f.change({ status: "succeeded", result: "提前完成" })
    await f.runtime.refresh()
    const wait = f.runtime.begin("parent", f.handle.id, 1000)
    assert.equal(wait.reason, "succeeded")
    await sleep(10); assert.equal(f.delivered.length, 0)
    f.runtime.activate(wait.id)
    await until(() => f.delivered.length === 1)
  } finally { await f.runtime.close() }
})

test("超时仅结束等待，任务可再次等待，取消任务使用独立操作", async () => {
  const f = fixture()
  try {
    const first = f.runtime.begin("parent", f.handle.id, 0)
    f.runtime.activate(first.id)
    await until(() => f.delivered.length === 1)
    assert.equal(f.delivered[0].reason, "timeout")
    assert.equal(f.counts().cancels, 0)
    const second = f.runtime.begin("parent", f.handle.id, 1000)
    f.runtime.activate(second.id)
    await f.runtime.cancel("parent", f.handle.id)
    await until(() => f.delivered.length === 2)
    assert.equal(f.delivered[1].reason, "cancelled")
    assert.equal(f.counts().cancels, 1)
    assert.notEqual(first.id, second.id)
  } finally { await f.runtime.close() }
})

test("完成与超时竞争只有一个接续，已结束等待不被迟到通知覆盖", async () => {
  for (const completedFirst of [true, false]) {
    const f = fixture()
    try {
      if (completedFirst) { f.change({ status: "succeeded" }); await f.runtime.refresh() }
      const wait = f.runtime.begin("parent", f.handle.id, 0)
      f.runtime.activate(wait.id)
      if (!completedFirst) f.change({ status: "succeeded" })
      await until(() => f.delivered.length === 1)
      await f.runtime.refresh(); await sleep(10)
      assert.equal(f.delivered.length, 1)
      assert.equal(f.delivered[0].reason, completedFirst ? "succeeded" : "timeout")
    } finally { await f.runtime.close() }
  }
})

test("用户输入或停止等待不取消任务，不另发模型接续", async () => {
  for (const method of ["onInput", "onInterrupt"]) {
    const f = fixture()
    try {
      const wait = f.runtime.begin("parent", f.handle.id, 1000)
      f.runtime[method]("parent")
      f.runtime.activate(wait.id)
      f.change({ status: "succeeded" })
      await f.runtime.refresh()
      assert.equal(f.delivered.length, 0)
      assert.equal(f.counts().cancels, 0)
      assert.equal(f.runtime.snapshot("parent").waits[0].reason, method === "onInput" ? "user_input" : "interrupted")
    } finally { await f.runtime.close() }
  }
})

test("调整等待期限替代前一次等待，任务保持同一执行标识", async () => {
  const f = fixture()
  try {
    const first = f.runtime.begin("parent", f.handle.id, 1000)
    f.runtime.activate(first.id)
    const second = f.runtime.begin("parent", f.handle.id, 2000)
    f.runtime.activate(second.id)
    f.change({ status: "succeeded" }); await f.runtime.refresh()
    await until(() => f.delivered.length === 1)
    assert.equal(f.delivered[0].id, second.id)
    assert.equal(f.runtime.snapshot("parent").waits[0].reason, "interrupted")
  } finally { await f.runtime.close() }
})

test("断线或遗漏通知后由运行时查询恢复，无模型参与轮询", async () => {
  const f = fixture()
  try {
    f.disconnect(true)
    const wait = f.runtime.begin("parent", f.handle.id, 1000)
    f.runtime.activate(wait.id)
    await until(() => f.errors.length > 0)
    f.change({ status: "succeeded", result: "重连结果" }, false)
    f.disconnect(false)
    await until(() => f.delivered.length === 1)
    assert.equal(f.delivered[0].snapshot.result, "重连结果")
    assert.ok(f.counts().reads >= 2)
  } finally { await f.runtime.close() }
})

test("接续请求响应丢失后保留同一等待标识重试", async () => {
  const accepted = new Set(), attempts = []
  const f = fixture({ async resume(record) {
    accepted.add(record.id); attempts.push(record.id)
    if (attempts.length === 1) throw new Error("合成响应丢失")
  } })
  try {
    const wait = f.runtime.begin("parent", f.handle.id, 0)
    f.runtime.activate(wait.id)
    await until(() => f.runtime.snapshot("parent").waits[0].state === "delivered")
    assert.deepEqual(attempts, [wait.id, wait.id])
    assert.equal(accepted.size, 1)
  } finally { await f.runtime.close() }
})

test("只有查询接口的任务由运行时轮询接续", async () => {
  let status = "working", delivered = 0
  const runtime = createWaitRuntime({ async resume(record) { assert.equal(record.reason, "succeeded"); delivered++ } }, { pollIntervalMs: 5 })
  try {
    const handle = runtime.register("parent", "process", "poll-only", { async read() { return { status } }, async cancel() {} })
    const wait = runtime.begin("parent", handle.id, 1000)
    runtime.activate(wait.id)
    status = "succeeded"
    await until(() => delivered === 1)
  } finally { await runtime.close() }
})

test("上下文之外保存结构化依赖、期限及原因，快照修改不影响运行时", async () => {
  const f = fixture()
  try {
    const wait = f.runtime.begin("parent", f.handle.id, 1234)
    const state = JSON.parse(JSON.stringify(f.runtime.snapshot("parent")))
    assert.equal(state.waits[0].deadline - state.waits[0].createdAt, 1234)
    state.tasks[0].handle.executionID = "伪造"
    state.waits.length = 0
    assert.equal(f.runtime.snapshot("parent").tasks[0].handle.executionID, "call-one")
    f.runtime.onInput("parent")
    assert.equal(f.runtime.snapshot("parent").waits[0].reason, "user_input")
    f.runtime.activate(wait.id)
  } finally { await f.runtime.close() }
})

test("句柄归属隔离、非法期限与关闭后的调用被拒绝", async () => {
  const f = fixture()
  assert.throws(() => f.runtime.begin("other", f.handle.id, 10), /不属于/)
  await assert.rejects(f.runtime.cancel("other", f.handle.id), /不属于/)
  for (const timeout of [-1, NaN, Infinity, Number.MAX_SAFE_INTEGER]) assert.throws(() => f.runtime.begin("parent", f.handle.id, timeout), TypeError)
  await f.runtime.close()
  assert.equal(f.counts().stops, 1)
  assert.equal(f.counts().cancels, 0)
  assert.throws(() => f.runtime.begin("parent", f.handle.id, 10), /关闭/)
})

test("卸载取消接续请求与本地定时器，不取消任务", async () => {
  let started = false, aborted = false
  const f = fixture({ resume(_record, signal) {
    started = true
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => { aborted = true; reject(new Error("已关闭")) }, { once: true }))
  } })
  const wait = f.runtime.begin("parent", f.handle.id, 0)
  f.runtime.activate(wait.id)
  await until(() => started)
  await f.runtime.close()
  assert.equal(aborted, true)
  assert.equal(f.counts().cancels, 0)
})

test("介入解除且未通知时，再次等待重新查询来源", async () => {
  const f = fixture()
  try {
    f.change({ status: "input_required", intervention: { id: "form-one" } })
    await f.runtime.refresh()
    const first = f.runtime.begin("parent", f.handle.id, 1000)
    f.runtime.activate(first.id)
    await until(() => f.delivered.length === 1)
    const reads = f.counts().reads
    f.change({ status: "succeeded", result: "介入后结果" }, false)
    const second = f.runtime.begin("parent", f.handle.id, 1000)
    f.runtime.activate(second.id)
    await until(() => f.delivered.length === 2)
    assert.equal(f.delivered[1].reason, "succeeded")
    assert.equal(f.delivered[1].snapshot.result, "介入后结果")
    assert.ok(f.counts().reads > reads)
  } finally { await f.runtime.close() }
})

test("卸载等待已发起的取消请求响应信号后完成清理", async () => {
  let cancelling = false, cleaned = false
  const runtime = createWaitRuntime({ async resume() {} })
  const handle = runtime.register("parent", "process", "cancel-cleanup", {
    async read() { return { status: "working" } },
    async cancel(signal) {
      cancelling = true
      await new Promise((resolve) => signal.addEventListener("abort", () => setTimeout(() => { cleaned = true; resolve() }, 30), { once: true }))
    },
  })
  const cancellation = runtime.cancel("parent", handle.id)
  await until(() => cancelling)
  await runtime.close()
  assert.equal(cleaned, true)
  await cancellation
})

test("删除 owner 结束未激活等待、重试和在途投递，不取消后台任务", async () => {
  for (const phase of ["inactive", "retry", "sending-success", "sending-failure"]) {
    let release, attempts = 0
    const f = fixture({ async resume() {
      attempts++
      if (phase === "retry") throw new Error("合成投递失败")
      await new Promise((resolve) => { release = resolve })
      if (phase === "sending-failure") throw new Error("合成在途失败")
    } })
    try {
      const wait = f.runtime.begin("parent", f.handle.id, phase === "inactive" ? 1000 : 0)
      if (phase !== "inactive") {
        f.runtime.activate(wait.id)
        await until(() => attempts === 1)
      }
      f.runtime.onDelete("parent")
      const errors = f.errors.length
      release?.()
      f.runtime.activate(wait.id)
      f.change({ status: "succeeded" })
      await f.runtime.refresh(); await sleep(20)
      assert.equal(attempts, phase === "inactive" ? 0 : 1)
      assert.equal(f.errors.length, errors)
      assert.equal(f.runtime.snapshot("parent").waits[0].state, "delivered")
      assert.equal(f.counts().cancels, 0)
    } finally { release?.(); await f.runtime.close() }
  }
})
