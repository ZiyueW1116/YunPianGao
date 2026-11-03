import test, { after } from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { existsSync } from "node:fs"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { AgentSession, AgentSessionRuntime, DefaultResourceLoader, ModelRuntime, SettingsManager, SessionManager } from "@earendil-works/pi-coding-agent"
import { registerSessionResourceCleanup } from "@earendil-works/pi-ai"
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

async function fixture(name, scheduling = { thresholdTokens: 999999 }, inMemory = false) {
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
        'const fs=require("node:fs");const t=setInterval(()=>{if(fs.existsSync("release")){clearInterval(t);fs.writeFileSync("finished", "");console.log("DONE")}},5)'
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
  const options = { cwd, agentDir, modelRuntime: runtime, model: runtime.getModel("fixture", "fixture"), sessionManager: inMemory ? SessionManager.inMemory(cwd) : SessionManager.create(cwd, join(root, "sessions")), settingsManager: SettingsManager.create(cwd, agentDir), tools: ["start_process", "start_subagent", "wait_for", "cancel_task"] }
  harness = await createPiSession(options, scheduling)
  await harness.session.bindExtensions({ mode: "json", onError(error) { errors.push(error) } })
  return { ...harness, closeAdapter: harness.close, options, calls, errors, root, cwd, releaseSummary, releaseWait,
    counts: () => ({ parent, child, summaries, completedAt, resumedAt }),
    async release() { completedAt = Date.now(); releaseChild.resolve(); await writeFile(join(cwd, "release"), "") },
    async close({ stopped = false } = {}) {
      releaseChild.resolve(); releaseSummary.resolve(); releaseWait.resolve(); await writeFile(join(cwd, "release"), "")
      if (!stopped) await until(() => harness.snapshot().tasks.every((task) => task.status !== "working"))
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

// 只在资源加载、SDK 创建或绑定边界注入故障；工具、session 与执行循环仍来自正式入口。
const invoke = (f, name, args, signal = new AbortController().signal) =>
  f.session.agent.state.tools.find((tool) => tool.name === name).execute(`lifecycle_${name}`, args, signal)
const childInput = { prompt: "CHILD_MARKER：返回合成结果。", description: "生命周期合成子任务" }

for (const phase of ["load", "create", "subscribe"]) {
  test(`Pi 生命周期：父实例创建失败清理 ${phase}`, { timeout: 15000 }, async (t) => {
    const f = await fixture("summary-lifecycle")
    const failure = new Error(`合成父实例 ${phase} 失败`)
    let created, disposed = 0, next
    const dispose = AgentSession.prototype.dispose
    t.mock.method(AgentSession.prototype, "dispose", function () { if (this === created) disposed++; return dispose.call(this) })
    let fault
    if (phase === "load") fault = t.mock.method(DefaultResourceLoader.prototype, "reload", async () => { throw failure })
    if (phase === "create") fault = t.mock.method(f.options.sessionManager, "buildSessionContext", () => { throw failure })
    if (phase === "subscribe") fault = t.mock.method(AgentSession.prototype, "subscribe", function () { created = this; throw failure })
    try {
      await assert.rejects(createPiSession(f.options), (error) => error === failure)
      if (created) assert.equal(disposed, 1)
      assert.equal(f.calls.length, 0)
      fault.mock.restore()
      next = await createPiSession({ ...f.options, sessionManager: SessionManager.inMemory(f.cwd) })
      await next.session.bindExtensions({ mode: "json" })
      await next.session.prompt("创建失败后使用独立新实例。")
      assert.equal(f.calls.length, 1)
    } finally { fault.mock.restore(); await next?.close(); await f.close() }
  })
}

for (const phase of ["load", "create", "bind"]) {
  test(`Pi 生命周期：子实例创建失败清理 ${phase}`, { timeout: 15000 }, async (t) => {
    const f = await fixture("summary-lifecycle")
    const failure = new Error(`合成子实例 ${phase} 失败`)
    let child, disposed = 0
    const dispose = AgentSession.prototype.dispose
    t.mock.method(AgentSession.prototype, "dispose", function () { if (this === child) disposed++; return dispose.call(this) })
    let fault
    if (phase === "load") fault = t.mock.method(DefaultResourceLoader.prototype, "reload", async () => { throw failure })
    if (phase === "create") {
      const build = SessionManager.prototype.buildSessionContext
      fault = t.mock.method(SessionManager.prototype, "buildSessionContext", function () { if (this !== f.options.sessionManager) throw failure; return build.call(this) })
    }
    if (phase === "bind") fault = t.mock.method(AgentSession.prototype, "bindExtensions", async function () { child = this; throw failure })
    try {
      await assert.rejects(invoke(f, "start_subagent", childInput), (error) => error === failure)
      assert.equal(f.snapshot().tasks.length, 0)
      assert.equal(f.calls.length, 0)
      if (child) assert.equal(disposed, 1)
      fault.mock.restore()
      const result = await invoke(f, "start_subagent", childInput)
      assert.ok(result.details.handle.id)
      await f.release()
      await until(() => f.snapshot().tasks[0].status === "succeeded")
    } finally { fault.mock.restore(); await f.close() }
  })
}

for (const phase of ["load", "created", "bound"]) {
  test(`Pi 生命周期：close 与在途子实例 ${phase} 交错`, { timeout: 15000 }, async (t) => {
    const f = await fixture("child-lifecycle")
    const entered = gate(), release = gate()
    let child, disposed = 0
    const bind = AgentSession.prototype.bindExtensions, reload = DefaultResourceLoader.prototype.reload, dispose = AgentSession.prototype.dispose
    t.mock.method(AgentSession.prototype, "dispose", function () { if (this === child) disposed++; return dispose.call(this) })
    if (phase === "load") t.mock.method(DefaultResourceLoader.prototype, "reload", async function (...args) {
      await reload.apply(this, args); entered.resolve(); await release.promise
    })
    else t.mock.method(AgentSession.prototype, "bindExtensions", async function (...args) {
      child = this
      if (phase === "bound") await bind.apply(this, args)
      entered.resolve(); await release.promise
      if (phase === "created") return bind.apply(this, args)
    })
    let running, closing, second
    try {
      running = f.session.prompt("创建子任务。")
      await entered.promise
      let firstDone = false, secondDone = false
      closing = f.closeAdapter().then(() => { firstDone = true })
      second = f.closeAdapter().then(() => { secondDone = true })
      await sleep(20)
      assert.equal(firstDone, false)
      assert.equal(secondDone, false, "并发 close 必须等待同一次完整清理")
      release.resolve()
      await Promise.all([running, closing, second])
      assert.equal(f.snapshot().tasks.length, 0, "关闭开始后不得再发布执行 handle")
      assert.equal(f.counts().child, 0, "迟到的创建不得启动子模型")
      if (child) assert.equal(disposed, 1)
      assert.equal(f.counts().parent, 1)
    } finally { release.resolve(); await Promise.allSettled([running, closing, second]); await f.close({ stopped: true }) }
  })
}

test("Pi 生命周期：独立调用工具创建也被 close 等待", { timeout: 15000 }, async (t) => {
  const f = await fixture("summary-lifecycle")
  const entered = gate(), release = gate(), reload = DefaultResourceLoader.prototype.reload
  t.mock.method(DefaultResourceLoader.prototype, "reload", async function (...args) { await reload.apply(this, args); entered.resolve(); await release.promise })
  const starting = invoke(f, "start_subagent", childInput)
  const rejected = assert.rejects(starting, /关闭/)
  let closing
  try {
    await entered.promise
    let done = false
    closing = f.closeAdapter().then(() => { done = true })
    await sleep(20)
    assert.equal(done, false)
    release.resolve(); await Promise.all([rejected, closing])
    assert.equal(f.snapshot().tasks.length, 0)
    assert.equal(f.counts().child, 0)
  } finally { release.resolve(); await Promise.allSettled([rejected, closing]); await f.close({ stopped: true }) }
})

for (const transition of ["shutdown", "fork", "fork-memory", "reload"]) {
  test(`Pi 生命周期：${transition} 使旧实例失效`, { timeout: 15000 }, async () => {
    const f = await fixture("child-lifecycle", undefined, transition === "fork-memory")
    let replacement
    try {
      await f.session.prompt("创建并等待子任务。")
      await until(() => f.counts().child === 1 && f.snapshot().waits.length === 1)
      const staleTools = [...f.session.agent.state.tools]
      const runtime = new AgentSessionRuntime(f.session, { cwd: f.cwd, agentDir: f.options.agentDir }, async (target) => {
        replacement = await createPiSession({ ...f.options, sessionManager: target.sessionManager, sessionStartEvent: target.sessionStartEvent })
        await replacement.session.bindExtensions({ mode: "json" })
        return { session: replacement.session, services: { cwd: f.cwd, agentDir: f.options.agentDir }, diagnostics: [] }
      })
      if (transition === "shutdown") await runtime.dispose()
      if (transition.startsWith("fork")) {
        const entry = f.session.sessionManager.getEntries().find((item) => item.type === "message" && item.message.role === "user")
        assert.equal((await runtime.fork(entry.id)).cancelled, false)
        assert.deepEqual(replacement.snapshot(), { tasks: [], waits: [] })
      }
      if (transition === "reload") {
        await f.session.reload()
        assert.equal(f.session.getAllTools().some((tool) => ["start_process", "start_subagent", "wait_for", "cancel_task"].includes(tool.name)), false)
      }
      const after = f.snapshot(), requestCount = f.calls.length
      assert.equal(after.waits[0].reason, "closed")
      await f.release(); await sleep(40)
      assert.equal(f.calls.length, requestCount, "旧任务结束后不得向旧或新 session 接续")
      assert.equal(f.session.sessionManager.getEntries().filter((entry) => entry.type === "custom_message" && entry.customType === "yunpiangao.resume").length, 0)
      for (const tool of staleTools) {
        const args = tool.name === "start_process" ? { command: process.execPath, args: ["-e", "console.log('不应执行')"] } : tool.name === "start_subagent" ? childInput : { handle: after.tasks[0].handle.id }
        await assert.rejects(tool.execute(`stale_${tool.name}`, args, new AbortController().signal), /关闭/)
      }
      await assert.rejects(f.interrupt(), /关闭/)
      assert.deepEqual(f.snapshot(), after)
    } finally { await replacement?.close(); await f.close({ stopped: true }) }
  })
}

for (const phase of ["load", "bound"]) {
  test(`Pi 生命周期：创建期间的取消信号 ${phase}`, { timeout: 15000 }, async (t) => {
    const f = await fixture("summary-lifecycle"), entered = gate(), release = gate(), controller = new AbortController()
    let child, disposed = 0
    const reload = DefaultResourceLoader.prototype.reload, bind = AgentSession.prototype.bindExtensions, dispose = AgentSession.prototype.dispose
    t.mock.method(AgentSession.prototype, "dispose", function () { if (this === child) disposed++; return dispose.call(this) })
    const fault = phase === "load"
      ? t.mock.method(DefaultResourceLoader.prototype, "reload", async function (...args) { await reload.apply(this, args); entered.resolve(); await release.promise })
      : t.mock.method(AgentSession.prototype, "bindExtensions", async function (...args) { child = this; await bind.apply(this, args); entered.resolve(); await release.promise })
    const starting = invoke(f, "start_subagent", childInput, controller.signal)
    const rejected = assert.rejects(starting, (error) => error === controller.signal.reason)
    try {
      await entered.promise; controller.abort(); release.resolve(); await rejected
      assert.equal(f.snapshot().tasks.length, 0)
      assert.equal(f.counts().child, 0)
      if (child) assert.equal(disposed, 1)
      fault.mock.restore()
      await invoke(f, "start_subagent", childInput)
      await f.release(); await until(() => f.snapshot().tasks[0].status === "succeeded")
    } finally { release.resolve(); await rejected; fault.mock.restore(); await f.close() }
  })
}

test("Pi 生命周期：SDK 创建回执迟于 close", { timeout: 15000 }, async (t) => {
  const f = await fixture("summary-lifecycle")
  let closing, disposed = 0
  const get = DefaultResourceLoader.prototype.getExtensions, dispose = AgentSession.prototype.dispose
  t.mock.method(AgentSession.prototype, "dispose", function () { if (this !== f.session) disposed++; return dispose.call(this) })
  // SDK 创建在这里尚未返回 session；微任务使 close 先于适配器的 await 接续。
  t.mock.method(DefaultResourceLoader.prototype, "getExtensions", function (...args) {
    const value = get.apply(this, args)
    queueMicrotask(() => { closing ??= f.closeAdapter() })
    return value
  })
  try {
    await assert.rejects(invoke(f, "start_subagent", childInput), /关闭/)
    await closing
    assert.equal(disposed, 1)
    assert.equal(f.snapshot().tasks.length, 0)
    assert.equal(f.calls.length, 0)
  } finally { await closing; await f.close({ stopped: true }) }
})

test("Pi 生命周期：close 等待运行中子推理退出且只释放一次", { timeout: 15000 }, async (t) => {
  const f = await fixture("child-lifecycle")
  let child, disposed = 0
  const bind = AgentSession.prototype.bindExtensions, dispose = AgentSession.prototype.dispose
  t.mock.method(AgentSession.prototype, "bindExtensions", function (...args) { child = this; return bind.apply(this, args) })
  t.mock.method(AgentSession.prototype, "dispose", function () { if (this === child) disposed++; return dispose.call(this) })
  try {
    await f.session.prompt("启动并等待子任务。")
    await until(() => f.counts().child === 1)
    await Promise.all([f.closeAdapter(), f.closeAdapter()])
    assert.equal(child.isIdle, true)
    assert.equal(disposed, 1)
    assert.equal(f.snapshot().waits[0].reason, "closed")
    assert.equal(f.counts().parent, 2)
    await f.release(); await sleep(30)
    assert.equal(f.counts().parent, 2)
    assert.equal(disposed, 1)
  } finally { await f.close({ stopped: true }) }
})

test("Pi 生命周期：close 不取消独立进程且停止接续", { timeout: 15000 }, async () => {
  const f = await fixture("close-process")
  try {
    await f.session.prompt("启动并等待独立进程。")
    await f.closeAdapter()
    assert.equal(f.snapshot().waits[0].reason, "closed")
    await f.release(); await until(() => existsSync(join(f.cwd, "finished")))
    await sleep(30)
    assert.equal(f.counts().parent, 2)
    assert.equal(f.session.sessionManager.getEntries().some((entry) => entry.type === "custom_message" && entry.customType === "yunpiangao.resume"), false)
  } finally { await f.close({ stopped: true }) }
})

test("Pi 生命周期：close 打断压缩屏障中的就绪投递", { timeout: 15000 }, async () => {
  const f = await fixture("compact-race")
  let compacting
  try {
    await f.session.prompt("启动并等待进程。")
    compacting = f.session.compact().catch(() => {})
    await until(() => f.counts().summaries === 1)
    await f.release(); await until(() => f.snapshot().waits[0].reason === "succeeded")
    await f.closeAdapter(); await compacting
    f.releaseSummary.resolve(); await sleep(30)
    assert.equal(f.snapshot().waits[0].reason, "succeeded", "关闭保留已确定的结束原因")
    assert.equal(f.counts().parent, 2)
    assert.equal(f.session.sessionManager.getEntries().some((entry) => entry.type === "custom_message" && entry.customType === "yunpiangao.resume"), false)
  } finally { f.releaseSummary.resolve(); await compacting; await f.close({ stopped: true }) }
})

test("Pi 生命周期：abort 同步重入 close 只清理一次", { timeout: 15000 }, async (t) => {
  const f = await fixture("input-stream")
  let nested, disposed = 0, cleanups = 0, attached = false
  const sessionID = f.session.sessionManager.getSessionId(), dispose = f.session.dispose
  const unregister = registerSessionResourceCleanup((id) => { if (id === sessionID) cleanups++ })
  t.mock.method(f.session, "dispose", function () { disposed++; return dispose.call(this) })
  const unsubscribe = f.session.agent.subscribe((_event, signal) => {
    if (attached) return
    attached = true
    signal.addEventListener("abort", () => { nested = f.closeAdapter() }, { once: true })
  })
  let running, outer
  try {
    running = f.session.prompt("启动并等待任务。")
    await until(() => f.counts().parent === 2)
    outer = f.closeAdapter()
    await Promise.all([outer, nested, running])
    assert.equal(disposed, 1)
    assert.equal(cleanups, 1, "原生 session 资源清理不得重复")
    assert.equal(nested, outer, "同步重入必须拿到已经公布的同一个清理 Promise")
    assert.equal(f.counts().parent, 2)
  } finally {
    f.releaseWait.resolve(); await Promise.allSettled([outer, nested, running])
    await f.release(); await until(() => existsSync(join(f.cwd, "finished")))
    unsubscribe(); unregister(); await f.close({ stopped: true })
  }
})
