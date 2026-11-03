import test from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createInterface } from "node:readline"
import { fileURLToPath } from "node:url"

async function bridge(dispatch) {
  const child = spawn(process.execPath, [fileURLToPath(new URL("../dist/adapters/hermes/core.js", import.meta.url))], { stdio: ["pipe", "pipe", "pipe"] })
  let sequence = 0
  const pending = new Map()
  const diagnostics = []
  child.stderr.on("data", (data) => diagnostics.push(data.toString()))
  const send = (value) => child.stdin.write(JSON.stringify(value) + "\n")
  const lines = createInterface({ input: child.stdout })
  lines.on("line", async (line) => {
    const message = JSON.parse(line)
    if ("reply" in message) {
      const call = pending.get(message.reply)
      pending.delete(message.reply)
      if (message.error) call.reject(new Error(message.error)); else call.resolve(message.value)
    } else if (!message.abort) {
      try { send({ reply: message.id, value: await dispatch(message.method, message.args) }) }
      catch (error) { send({ reply: message.id, error: error.message }) }
    }
  })
  const request = (method, args = {}) => new Promise((resolve, reject) => {
    const id = ++sequence
    pending.set(id, { resolve, reject }); send({ id, method, args })
  })
  return { request, diagnostics, async close() { await request("close"); child.stdin.end(); await new Promise((resolve) => child.once("exit", resolve)); lines.close() } }
}
const until = async (check) => {
  for (let count = 0; count < 1000; count++) { if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 2)) }
  assert.fail("Hermes 核心管道未在期限内完成")
}

test("Hermes 管道：具体执行查询、零期限、重复回执与关闭", async () => {
  let status = "working", attempts = 0
  const ids = []
  const core = await bridge(async (method, args) => {
    if (method === "read") return { status, result: "合成结果" }
    if (method === "resume") { ids.push(args.id); if (++attempts === 1) throw new Error("合成回执丢失") }
    return null
  })
  try {
    await core.request("open", { sessionID: "synthetic-session", pollIntervalMs: 5 })
    const handle = await core.request("register", { kind: "process", executionID: "synthetic-execution" })
    const first = await core.request("begin", { handle: handle.id, timeoutMs: 0 })
    await core.request("activate", { id: first.id })
    await until(() => attempts === 2)
    assert.deepEqual(ids, [first.id, first.id])
    status = "succeeded"
    await core.request("refresh", { handle: handle.id })
    const second = await core.request("begin", { handle: handle.id, timeoutMs: 1000 })
    await core.request("activate", { id: second.id })
    await until(async () => (await core.request("snapshot")).waits[1].state === "delivered")
    const state = await core.request("snapshot")
    assert.deepEqual(state.waits.map((wait) => wait.reason), ["timeout", "succeeded"])
    await core.request("close")
    await assert.rejects(core.request("begin", { handle: handle.id, timeoutMs: 1 }), /已关闭/)
  } finally { await core.close() }
})

test("Hermes 管道：原生提交回调可重入核心消费摘要", async () => {
  let compacted
  const core = await bridge(async (method) => {
    if (method === "latestCompleted") return { messageID: "synthetic-answer", tokens: 100 }
    if (method === "prepare") return { text: "合成摘要", fingerprint: "synthetic-fingerprint" }
    if (method === "compact") compacted = await core.request("takePrepared", { fingerprint: "synthetic-fingerprint" })
    return null
  })
  try {
    await core.request("open", { sessionID: "synthetic-session", scheduling: { thresholdTokens: 1, idleDelayMs: 0 } })
    await core.request("execution", { phase: "succeeded" })
    await until(() => compacted !== undefined)
    assert.equal(compacted, "合成摘要")
    assert.equal(await core.request("takePrepared", { fingerprint: "synthetic-fingerprint" }), null)
  } finally { await core.close() }
})
