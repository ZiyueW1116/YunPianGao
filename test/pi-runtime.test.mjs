import test, { after } from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { ModelRuntime, SettingsManager, SessionManager } from "@earendil-works/pi-coding-agent"
import { createPiSession } from "../dist/adapters/pi.js"

// Pi 的主题与辅助二进制路径使用全局函数；SDK 的 agentDir 不覆盖这些路径。
const isolated = await mkdtemp(join(tmpdir(), "yunpiangao-pi-global-"))
const saved = ["PI_CODING_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR", "PI_OFFLINE"].map((key) => [key, process.env[key]])
process.env.PI_CODING_AGENT_DIR = join(isolated, "agent")
process.env.PI_CODING_AGENT_SESSION_DIR = join(isolated, "sessions")
process.env.PI_OFFLINE = "true"
after(async () => {
  for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
  await rm(isolated, { recursive: true, force: true })

})

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const until = async (check) => {
  for (let i = 0; i < 1000; i++) { if (check()) return; await sleep(5) }
  assert.fail("Pi 真实入口没有在期限内到达预期状态")
}
const gate = () => { let resolve; const promise = new Promise((r) => { resolve = r }); return { promise, resolve } }

async function fixture(name, scheduling = { thresholdTokens: 999999 }) {
  const root = await mkdtemp(join(tmpdir(), "yunpiangao-pi-"))
  const cwd = join(root, "project"), agentDir = join(root, "agent")
  await mkdir(cwd); await mkdir(agentDir)
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ compaction: { enabled: false, keepRecentTokens: 0 }, retry: { enabled: false }, packages: [] }))
  let harness, parent = 0, child = 0, summaries = 0, completedAt, resumedAt
  const calls = [], releaseChild = gate(), releaseSummary = gate(), releaseWait = gate(), errors = []
  const choose = (n) => {
    const state = harness.snapshot(), handle = state.tasks[0]?.handle.id
    const wait = (timeout = 10) => ["wait_for", { handle, timeout }]
    if (name.startsWith("summary")) return
    if (n === 1) {
      if (name.startsWith("child")) return ["start_subagent", { prompt: "CHILD_MARKER：返回合成结果。", description: "合成子任务" }]
      const code = name === "before" ? 'console.log("DONE")' : name === "failure" ? 'process.exit(7)' :
        'const fs=require("node:fs");const t=setInterval(()=>{if(fs.existsSync("release")){clearInterval(t);console.log("DONE")}},5)'
      return ["start_process", { command: process.execPath, args: ["-e", code] }]
    }
    if (n === 2) return wait(name === "timeout" ? .03 : 10)
    if (name === "timeout" && n === 3) return wait()
    if ((name === "input" || name === "child-input") && n === 4) return wait()
    if (name.endsWith("cancel") && n === 3) return ["cancel_task", { handle }]
    if (name.endsWith("cancel") && n === 4) return wait()
  }
  const server = createServer(async (req, res) => {
    try {
      let raw = ""; for await (const chunk of req) raw += chunk
      const body = JSON.parse(raw)
      const kind = !body.tools?.length ? "summary" : body.messages.some((message) => message.role === "user" && JSON.stringify(message.content).includes("CHILD_MARKER")) ? "child" : "parent"
      calls.push({ kind, at: Date.now(), body })
      let tool, text = "合成任务已完成。"
      if (kind === "summary") {
        summaries++
        if (name === "summary-stale" || name === "compact-race") await releaseSummary.promise
        text = "## 目标\n完成合成任务。\n## 状态\n保留任务依赖和精确标识。"
      } else if (kind === "child") {
        child++; await releaseChild.promise; completedAt = Date.now()
        if (name === "child-failure") { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: { message: "合成子任务失败" } })); return }
      } else {
        tool = choose(++parent)
        if (!tool && !name.startsWith("summary")) resumedAt = Date.now()
      }
      if (res.destroyed) return
      if (name === "before" && kind === "parent" && parent === 2) await until(() => harness.snapshot().tasks[0].status === "succeeded")
      if (name === "input-stream" && kind === "parent" && parent === 2) await releaseWait.promise
      const n = calls.length
      const delta = tool ? { role: "assistant", tool_calls: [{ index: 0, id: `call_${n}`, type: "function", function: { name: tool[0], arguments: JSON.stringify(tool[1]) } }] } : { role: "assistant", content: text }
      if (name === "batch" && kind === "parent" && parent === 2) delta.tool_calls.push({ index: 1, id: `extra_${n}`, type: "function", function: { name: "start_process", arguments: JSON.stringify({ command: process.execPath, args: ["-e", "console.log('BATCH_DONE')"] }) } })
      res.writeHead(200, { "Content-Type": "text/event-stream" })
      for (const [part, finish] of [[delta, null], [{}, tool ? "tool_calls" : "stop"]])
        res.write(`data: ${JSON.stringify({ id: `fixture_${n}`, object: "chat.completion.chunk", model: "fixture", choices: [{ index: 0, delta: part, finish_reason: finish }] })}\n\n`)
      const tokens = name.startsWith("summary") && parent === 1 ? 1000 : 10
      res.end(`data: ${JSON.stringify({ id: `fixture_${n}`, choices: [], usage: { prompt_tokens: tokens, completion_tokens: 10, total_tokens: tokens + 10 } })}\n\ndata: [DONE]\n\n`)
    } catch (error) { errors.push(error); res.destroy() }
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"), modelsStorePath: join(agentDir, "models-store.json"), refreshOnCreate: false })
  runtime.registerProvider("fixture", { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: "synthetic-only", api: "openai-completions", models: [{ id: "fixture", name: "合成模型替身", contextWindow: 100000, maxTokens: 4096, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] })
  harness = await createPiSession({ cwd, agentDir, modelRuntime: runtime, model: runtime.getModel("fixture", "fixture"), sessionManager: SessionManager.create(cwd, join(root, "sessions")), settingsManager: SettingsManager.create(cwd, agentDir), tools: ["start_process", "start_subagent", "wait_for", "cancel_task"] }, scheduling)
  await harness.session.bindExtensions({ mode: "json", onError(error) { errors.push(error) } })
  return { ...harness, calls, errors, root, cwd, releaseSummary, releaseWait,
    counts: () => ({ parent, child, summaries, completedAt, resumedAt }),
    async release() { completedAt = Date.now(); releaseChild.resolve(); await writeFile(join(cwd, "release"), "") },
    async close() {
      releaseChild.resolve(); releaseSummary.resolve(); releaseWait.resolve(); await writeFile(join(cwd, "release"), "")
      await until(() => harness.snapshot().tasks.every((task) => task.status !== "working"))
      await harness.close(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); await rm(root, { recursive: true, force: true })
    },
  }
}

for (const name of ["complete", "before", "failure", "timeout", "input", "cancel", "compact", "compact-race", "child", "child-input", "child-cancel", "child-failure", "interrupt", "resume-ack", "batch", "child-compact"]) {
  test(`Pi 真实 SDK：${name}`, { timeout: 15000 }, async () => {
    const f = await fixture(name)
    try {
      await f.session.prompt("启动合成任务并等待。")
      await until(() => f.snapshot().waits.length === 1)
      if (!["before", "failure"].includes(name)) {
        await sleep(20); assert.equal(f.counts().parent, 2)
        assert.equal(f.snapshot().tasks[0].status, "working")
      }
      if (name === "timeout") await until(() => f.snapshot().waits.length === 2)
      if (name.includes("input") || name.endsWith("cancel")) {
        await f.session.prompt("用户介入：先处理当前输入。")
        assert.equal(f.snapshot().waits[0].reason, "user_input")
        if (name.includes("input")) {
          assert.equal(f.snapshot().tasks[0].status, "working")
          await f.session.prompt("继续等待同一任务。")
        }
      }
      if (name === "compact" || name === "compact-race" || name === "child-compact") {
        const compacting = f.session.compact()
        if (name === "compact-race") { await until(() => f.counts().summaries === 1); await f.release(); await until(() => f.snapshot().waits[0].reason === "succeeded"); assert.equal(f.counts().parent, 2); f.releaseSummary.resolve() }
        await compacting
        assert.ok(f.session.sessionManager.getBranch().some((entry) => entry.type === "compaction"))
        if (name !== "compact-race") assert.equal(f.counts().parent, 2)
      }
      if (name === "interrupt") {
        await f.interrupt(); await f.release(); await sleep(60)
        assert.equal(f.snapshot().waits[0].reason, "interrupted")
        assert.equal(f.counts().parent, 2)
        return
      }
      if (name === "resume-ack") {
        const native = f.session.sendCustomMessage.bind(f.session)
        f.session.sendCustomMessage = async (...args) => { await native(...args); throw new Error("合成接纳回执丢失") }
      }
      await f.release()
      const expected = name === "timeout" ? 4 : name.includes("input") || name.endsWith("cancel") ? 5 : 3
      await until(() => f.counts().parent === expected && f.session.isIdle)
      await sleep(30)
      assert.equal(f.counts().parent, expected)
      const state = f.snapshot(), last = state.waits.at(-1)
      assert.equal(last.state, "delivered")
      assert.equal(last.reason, name.endsWith("cancel") ? "cancelled" : ["failure", "child-failure"].includes(name) ? "failed" : "succeeded")
      if (name === "before") assert.ok(last.snapshot.finishedAt <= last.createdAt)
      if (name === "timeout") { assert.equal(state.waits[0].reason, "timeout"); assert.equal(state.waits[0].handle.id, last.handle.id) }
      const resumed = f.session.sessionManager.getEntries().filter((entry) => entry.type === "custom_message" && entry.customType === "yunpiangao.resume")
      assert.equal(resumed.length, name === "timeout" ? 2 : 1)
      const final = f.calls.filter((call) => call.kind === "parent").at(-1)
      assert.ok(JSON.stringify(final.body).includes("云片糕任务运行时状态"))
      assert.equal(f.calls.filter((call) => call.kind === "parent").flatMap((call) => call.body.messages).filter((message) => message.role === "system" && JSON.stringify(message).includes('"output":"DONE')).length, 0)
      assert.deepEqual(f.errors, [])
      const latency = last.snapshot?.finishedAt === undefined ? null : final.at - last.snapshot.finishedAt
      const longSleepCalls = f.session.sessionManager.getEntries().filter((entry) => entry.type === "message" && entry.message.role === "assistant").flatMap((entry) => entry.message.content).filter((part) => part.type === "toolCall" && /\bsleep\s+(?:[6-9]\d|\d{3,})(?:\D|$)/.test(JSON.stringify(part.arguments))).length
      assert.equal(longSleepCalls, 0)
      console.log(JSON.stringify({ scenario: name, parentRequests: expected, childRequests: f.counts().child, extraWakeups: f.counts().parent - expected, longSleepCalls, completionToResumeMs: latency }))
    } finally { await f.close() }
  })
}

for (const name of ["summary-commit", "summary-stale", "summary-recheck"]) {
  test(`Pi 空闲摘要：${name}`, { timeout: 15000 }, async () => {
    const f = await fixture(name, { thresholdTokens: 100, idleDelayMs: 5 })
    try {
      if (name === "summary-recheck") {
        const compact = f.session.compact.bind(f.session)
        f.session.compact = async (...args) => { f.session.agent.setSystemPrompt("提交边界的合成变化"); return compact(...args) }
      }
      await f.session.prompt("合成摘要检查。")
      await until(() => f.counts().summaries === 1)
      if (name === "summary-stale") { await f.session.prompt("新输入使摘要失效。"); f.releaseSummary.resolve(); await sleep(80) }
      else if (name === "summary-commit") await until(() => f.session.sessionManager.getEntries().some((entry) => entry.type === "compaction"))
      else await sleep(80)
      const compacted = f.session.sessionManager.getEntries().filter((entry) => entry.type === "compaction")
      assert.equal(compacted.length, name === "summary-commit" ? 1 : 0)
      assert.equal(f.counts().summaries, 1)
      assert.deepEqual(f.errors, [])
    } finally { await f.close() }
  })
}


test("Pi 模型请求期间的新输入使旧等待意图失效", { timeout: 15000 }, async () => {
  const f = await fixture("input-stream")
  try {
    const running = f.session.prompt("启动任务。")
    await until(() => f.counts().parent === 2)
    await f.session.prompt("用户介入，先处理这条输入。", { streamingBehavior: "steer" })
    f.releaseWait.resolve()
    await running
    assert.equal(f.counts().parent, 3)
    assert.equal(f.snapshot().waits.length, 0)
    assert.equal(f.snapshot().tasks[0].status, "working")
    await f.release()
    await sleep(30)
    assert.equal(f.counts().parent, 3)
    assert.deepEqual(f.errors, [])
  } finally { await f.close() }
})
