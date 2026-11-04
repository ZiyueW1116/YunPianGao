import test from "node:test"
import assert from "node:assert/strict"
import { createYunPianGao, StaleSummaryError } from "../dist/index.js"

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
async function until(check) {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > 2000) throw new Error("测试等待超时")
    await sleep(2)
  }
}
function fixture(overrides = {}, options = {}) {
  const calls = { prepare: 0, compact: 0, used: [], errors: [] }
  let source = { messageID: "answer-one", tokens: 200 }
  let signature = "context-one"
  let engine
  const port = {
    async latestCompleted() { return source },
    async prepare() { calls.prepare += 1; return { text: "合成摘要", fingerprint: signature } },
    async compact(id) {
      calls.compact += 1
      engine.onExecution(id, "started")
      calls.used.push(engine.takePrepared(id, signature))
      source = undefined
      engine.onExecution(id, "succeeded")
    },
    async wait() {},
    onError(error) { calls.errors.push(error) },
    ...overrides,
  }
  engine = createYunPianGao(port, { thresholdTokens: 100, idleDelayMs: 1, ...options })
  return { engine, calls, setSource(value) { source = value }, setSignature(value) { signature = value } }
}

test("最终回答达到阈值后只提交一次，压缩自身的完成事件不形成循环", async () => {
  const f = fixture()
  try {
    f.engine.onExecution("one", "succeeded")
    await until(() => f.calls.used.length === 1)
    await sleep(20)
    assert.equal(f.calls.prepare, 1)
    assert.deepEqual(f.calls.used, ["合成摘要"])
  } finally { await f.engine.close() }
})

test("低于阈值时保留原上下文", async () => {
  const f = fixture()
  f.setSource({ messageID: "short-answer", tokens: 99 })
  try { f.engine.onExecution("one", "succeeded"); await sleep(20); assert.equal(f.calls.prepare, 0) }
  finally { await f.engine.close() }
})

test("失败、中断以及启动事件不触发压缩", async () => {
  for (const phase of ["failed", "interrupted", "started"]) {
    const f = fixture()
    try { f.engine.onExecution("one", phase); await sleep(10); assert.equal(f.calls.prepare, 0) }
    finally { await f.engine.close() }
  }
})

test("延迟窗口里的新输入撤销计划", async () => {
  const f = fixture({}, { idleDelayMs: 30 })
  try {
    f.engine.onExecution("one", "succeeded")
    f.engine.onInput("one")
    await sleep(45)
    assert.equal(f.calls.prepare, 0)
  } finally { await f.engine.close() }
})

test("摘要生成期间到达的新输入使旧结果失效", async () => {
  const gate = deferred()
  let preparing = false
  const f = fixture({ async prepare() { preparing = true; return gate.promise } })
  try {
    f.engine.onExecution("one", "succeeded")
    await until(() => preparing)
    f.engine.onInput("one")
    gate.resolve({ text: "过期摘要", fingerprint: "context-one" })
    await sleep(15)
    assert.equal(f.calls.compact, 0)
  } finally { gate.resolve({ text: "", fingerprint: "" }); await f.engine.close() }
})

test("新轮已完成时，丢弃旧摘要后为新上下文重新准备", async () => {
  const gate = deferred()
  let count = 0
  const f = fixture({ async prepare() {
    count += 1
    return count === 1 ? gate.promise : { text: "新一轮摘要", fingerprint: "context-two" }
  } })
  try {
    f.engine.onExecution("one", "succeeded")
    await until(() => count === 1)
    f.engine.onInput("one")
    f.setSource({ messageID: "answer-two", tokens: 250 })
    f.setSignature("context-two")
    f.engine.onExecution("one", "succeeded")
    gate.resolve({ text: "旧一轮摘要", fingerprint: "context-one" })
    await until(() => f.calls.used.length === 1)
    assert.deepEqual(f.calls.used, ["新一轮摘要"])
    assert.equal(count, 2)
  } finally { gate.resolve({ text: "", fingerprint: "" }); await f.engine.close() }
})

test("提交边界的指纹变化拒绝旧摘要", async () => {
  const f = fixture({ async prepare() { return { text: "旧摘要", fingerprint: "old-context" } } })
  try {
    f.engine.onExecution("one", "succeeded")
    await until(() => f.calls.errors.length === 1)
    assert.ok(f.calls.errors[0] instanceof StaleSummaryError)
    assert.deepEqual(f.calls.used, [])
  } finally { await f.engine.close() }
})

test("摘要入队后收到新输入，即使提交指纹不变也拒绝旧摘要", async () => {
  const gate = deferred()
  let queued = false
  const f = fixture({
    async compact() {},
    async wait() { queued = true; await gate.promise },
  })
  try {
    f.engine.onExecution("one", "succeeded")
    await until(() => queued)
    f.engine.onInput("one")
    f.engine.onExecution("one", "started")
    assert.throws(() => f.engine.takePrepared("one", "context-one"), StaleSummaryError)
  } finally { gate.resolve(); await f.engine.close() }
})

test("生成失败不提交，后续最终回答仍可触发", async () => {
  let attempt = 0
  const f = fixture({ async prepare() {
    if (++attempt === 1) throw new Error("合成故障")
    return { text: "重试摘要", fingerprint: "context-one" }
  } })
  try {
    f.engine.onExecution("one", "succeeded")
    await until(() => f.calls.errors.length === 1)
    assert.equal(f.calls.compact, 0)
    f.engine.onExecution("one", "succeeded")
    await until(() => f.calls.used.length === 1)
    assert.deepEqual(f.calls.used, ["重试摘要"])
  } finally { await f.engine.close() }
})

test("独立会话的准备状态互不覆盖", async () => {
  const used = []
  let engine
  const completed = new Set()
  engine = createYunPianGao({
    async latestCompleted(id) { if (!completed.has(id)) return { messageID: id, tokens: 200 } },
    async prepare(id) { return { text: id, fingerprint: id } },
    async compact(id) { used.push(engine.takePrepared(id, id)); completed.add(id) },
    async wait() {},
  }, { thresholdTokens: 100, idleDelayMs: 0 })
  try {
    engine.onExecution("one", "succeeded"); engine.onExecution("two", "succeeded")
    await until(() => used.length === 2)
    assert.deepEqual(used.sort(), ["one", "two"])
  } finally { await engine.close() }
})

test("direct 策略只调用原生压缩，不准备自定义摘要", async () => {
  const f = fixture({}, { strategy: "direct" })
  try {
    f.engine.onExecution("one", "succeeded")
    await until(() => f.calls.compact === 1)
    assert.equal(f.calls.prepare, 0)
    assert.deepEqual(f.calls.used, [undefined])
  } finally { await f.engine.close() }
})

test("卸载会取消尚未触发的定时器", async () => {
  const f = fixture({}, { idleDelayMs: 30 })
  f.engine.onExecution("one", "succeeded")
  await f.engine.close(); await sleep(45)
  assert.equal(f.calls.prepare, 0)
})

test("卸载将取消信号传给进行中的准备请求", async () => {
  let started = false, aborted = false
  const f = fixture({ prepare(_id, _source, signal) {
    started = true
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => { aborted = true; reject(new Error("已取消")) }, { once: true }))
  } })
  f.engine.onExecution("one", "succeeded")
  await until(() => started)
  await f.engine.close()
  assert.equal(aborted, true)
  assert.equal(f.calls.compact, 0)
  assert.deepEqual(f.calls.errors, [])
})

test("无效选项在启动调度前被拒绝", () => {
  const port = {}
  for (const thresholdTokens of [0, -1, NaN, Infinity, "100"])
    assert.throws(() => createYunPianGao(port, { thresholdTokens }), TypeError)
  assert.throws(() => createYunPianGao(port, { idleDelayMs: -1 }), TypeError)
  assert.throws(() => createYunPianGao(port, { strategy: "unknown" }), TypeError)
})
