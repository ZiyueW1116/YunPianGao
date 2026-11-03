import test from "node:test"
import assert from "node:assert/strict"
import { binary, fixture, until, sleep } from "./codex-runtime.mjs"
import { CodexRpc } from "../dist/adapters/codex-rpc.js"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { spawn } from "node:child_process"

for (const name of ["complete", "before", "failure", "spawn-failure", "timeout", "input", "cancel", "child", "child-input", "child-cancel", "child-failure", "interrupt", "batch", "compact-boundary"]) {
  test(`Codex 真实 app-server：${name}`, { skip: !binary, timeout: 30000 }, async () => {
    const f = await fixture(name)
    try {
      const running = await f.prompt("启动合成任务并等待。")
      await until(() => f.snapshot().waits.length === 1)
      if (!["before", "failure", "spawn-failure"].includes(name)) {
        await sleep(30); assert.equal(f.counts().parent, 2); assert.equal(f.snapshot().tasks[0].status, "working")
      }
      if (name === "timeout") await until(() => f.snapshot().waits.length === 2)
      if (name.includes("input") || name.endsWith("cancel")) {
        const steered = await f.prompt("用户介入：先处理当前输入。")
        await steered.completed
        assert.equal(f.snapshot().waits[0].reason, "user_input")
        if (name.includes("input")) {
          assert.equal(f.snapshot().tasks[0].status, "working")
          await f.prompt("继续等待同一任务。")
          await until(() => f.snapshot().waits.length === 2)
        }
      }
      if (name === "compact-boundary") {
        await assert.rejects(f.compact(), /不支持保留待回包等待/)
        assert.equal(f.snapshot().waits[0].state, "waiting")
        assert.equal(f.counts().summaries, 0)
      }
      if (name === "interrupt") {
        await f.interrupt(); await running.completed; await f.release(); await sleep(100)
        assert.equal(f.snapshot().waits[0].reason, "interrupted"); assert.equal(f.counts().parent, 2); return
      }
      await f.release()
      const expected = name === "timeout" ? 4 : name.includes("input") || name.endsWith("cancel") ? 5 : 3
      await until(() => f.counts().parent === expected && f.events.some((event) => event.method === "turn/completed" && event.params.threadId === f.threadId))
      await until(() => f.snapshot().waits.at(-1).state === "delivered")
      await sleep(40)
      assert.equal(f.counts().parent, expected)
      const state = f.snapshot(), last = state.waits.at(-1)
      assert.equal(last.reason, name.endsWith("cancel") ? "cancelled" : ["failure", "spawn-failure", "child-failure"].includes(name) ? "failed" : "succeeded")
      if (name === "before") assert.ok(last.snapshot.finishedAt <= last.createdAt)
      if (name === "timeout") { assert.equal(state.waits[0].reason, "timeout"); assert.equal(state.waits[0].handle.id, last.handle.id) }
      const final = f.requests.filter((request) => request.kind === "parent").at(-1)
      assert.ok(JSON.stringify(final.body.input).includes(last.id))
      assert.ok(!final.body.input.some((item) => ["system", "developer"].includes(item.role) && JSON.stringify(item).includes('"output":"DONE')))
      assert.ok(!JSON.stringify(final.body).includes("### Available skills"))
      if (name === "child") assert.equal(last.snapshot.result.text, "合成任务已完成。")
      const completedCalls = f.events.filter((event) => event.method === "item/completed" && event.params.item.type === "dynamicToolCall" && event.params.item.tool === "wait_for")
      assert.equal(completedCalls.length, name === "timeout" || name.includes("input") ? 2 : name.endsWith("cancel") ? 2 : 1)
      assert.ok(completedCalls.every((event) => event.params.item.success === true))
      assert.deepEqual(f.errors, [])
      const toolCalls = f.events.filter((event) => event.method === "item/tool/call")
      const longSleepCalls = toolCalls.filter((event) => /\bsleep\s+(?:[6-9]\d|\d{3,})(?:\D|$)/.test(JSON.stringify(event.params.arguments))).length
      assert.equal(longSleepCalls, 0)
      console.log(JSON.stringify({ scenario: name, parentRequests: expected, childRequests: f.counts().child, extraWakeups: f.counts().parent - expected, longSleepCalls, completionToResumeMs: last.snapshot?.finishedAt === undefined ? null : final.at - last.snapshot.finishedAt }))
    } finally { await f.close() }
  })
}

test("Codex 真实 app-server：模型流期间的新输入拒绝过期等待意图", { skip: !binary, timeout: 30000 }, async () => {
  const f = await fixture("input-stream")
  try {
    const initial = await f.prompt("启动任务。")
    await until(() => f.counts().parent === 2)
    const next = await f.prompt("用户在模型流期间介入。")
    f.releaseWait.resolve()
    await next.completed; await initial.completed
    assert.equal(f.snapshot().waits.length, 0)
    assert.equal(f.snapshot().tasks[0].status, "working")
    await f.release(); await sleep(80); assert.equal(f.counts().parent, 3)
  } finally { await f.close() }
})

test("Codex 真实 app-server：空闲时原生 compact", { skip: !binary, timeout: 30000 }, async () => {
  const f = await fixture("summary")
  try {
    await (await f.prompt("返回一段合成回答。" )).completed
    const result = await f.compact()
    assert.equal(result.status, "completed")
    assert.equal(f.counts().summaries, 1)
    await (await f.prompt("读取压缩后的运行状态。" )).completed
    assert.ok(JSON.stringify(f.requests.at(-1).body).includes("云片糕任务运行时状态"))
  } finally { await f.close() }
})

test("Codex 真实 app-server：close 收尾在途原生 compact", { skip: !binary, timeout: 30000 }, async () => {
  const f = await fixture("summary-close")
  try {
    await (await f.prompt("合成回答。" )).completed
    const compacting = f.compact()
    await until(() => f.counts().summaries === 1)
    await f.closeAdapter()
    assert.equal((await compacting).status, "interrupted")
    await assert.rejects(f.compact(), /已关闭/)
    assert.equal(f.counts().parent, 1)
  } finally { await f.close() }
})

test("Codex 真实 app-server：结束等待后原生压缩，依赖可重新等待", { skip: !binary, timeout: 30000 }, async () => {
  const f = await fixture("input")
  try {
    await f.prompt("启动任务。")
    await until(() => f.snapshot().waits.length === 1)
    await (await f.prompt("先处理用户输入。" )).completed
    const id = f.snapshot().tasks[0].handle.id
    await f.compact()
    await f.prompt("继续等待原任务。")
    await until(() => f.snapshot().waits.length === 2)
    assert.equal(f.snapshot().tasks[0].status, "working")
    const waiting = f.requests.filter((request) => request.kind === "parent").at(-1)
    assert.ok(JSON.stringify(waiting.body.input).includes(id))
    assert.ok(JSON.stringify(waiting.body.input).includes("云片糕任务运行时状态"))
    await f.release(); await until(() => f.counts().parent === 5)
    assert.equal(f.counts().summaries, 1)
  } finally { await f.close() }
})

test("Codex 真实 app-server：子任务创建失败不发布 handle", { skip: !binary, timeout: 30000 }, async () => {
  const f = await fixture("child")
  try {
    f.options.modelProvider = "missing-fixture-provider"
    await (await f.prompt("启动子任务。" )).completed
    assert.equal(f.snapshot().tasks.length, 0)
    assert.equal(f.counts().child, 0)
    const failed = f.events.find((event) => event.method === "item/completed" && event.params.item.tool === "start_subagent")
    assert.equal(failed.params.item.success, false)
  } finally { await f.close() }
})

test("Codex 真实 app-server：子任务原生权限介入，拒绝后同 handle 重等", { skip: !binary, timeout: 30000 }, async () => {
  const f = await fixture("child-permission")
  try {
    f.releaseChild.resolve()
    await (await f.prompt("启动子任务并等待。" )).completed
    assert.equal(f.snapshot().waits[0].reason, "input_required")
    const request = f.events.find((event) => event.method === "item/commandExecution/requestApproval")
    assert.ok(request)
    f.respondToRequest(request.id, { decision: "decline" })
    await until(() => f.snapshot().tasks[0].status === "succeeded")
    await (await f.prompt("继续等待同一子任务。" )).completed
    assert.equal(f.snapshot().waits.at(-1).reason, "succeeded")
    assert.equal(f.counts().parent, 5)
  } finally { await f.close() }
})

test("Codex 真实 app-server：command/exec 保留原生 read-only 权限", { skip: !binary, timeout: 30000 }, async () => {
  const f = await fixture("sandbox")
  try {
    await (await f.prompt("启动合成写入命令。" )).completed
    assert.equal(f.snapshot().waits[0].reason, "failed")
    assert.equal(existsSync(join(f.cwd, "denied")), false)
  } finally { await f.close() }
})

test("Codex 真实 app-server：零期限与进程完成竞争只接续一次", { skip: !binary, timeout: 30000 }, async () => {
  const f = await fixture("race")
  try {
    await (await f.prompt("启动任务并等待。" )).completed
    await sleep(80)
    const waits = f.snapshot().waits
    assert.equal(waits.length, 1); assert.equal(waits[0].state, "delivered")
    assert.ok(["succeeded", "timeout"].includes(waits[0].reason))
    assert.equal(f.counts().parent, 3)
  } finally { await f.close() }
})

test("Codex 真实 app-server：原生命令输出保留 64 KiB 尾部", { skip: !binary, timeout: 30000 }, async () => {
  const f = await fixture("output")
  try {
    await (await f.prompt("启动合成输出任务。" )).completed
    const result = f.snapshot().tasks[0].result
    assert.equal(result.truncated, true)
    assert.equal(Buffer.byteLength(result.output), 65_536)
    assert.ok(result.output.endsWith("TAIL\n"))
    assert.equal(f.counts().parent, 3)
  } finally { await f.close() }
})

test("Codex 终端入口：实际启动任务并完成接续", { skip: !binary, timeout: 30000 }, async () => {
  const f = await fixture("complete")
  let cli, exited
  try {
    await f.closeAdapter()
    cli = spawn(process.execPath, ["dist/codex-cli.js", binary, f.options.codexHome, f.cwd], { cwd: process.cwd(), env: { ...process.env, ...f.options.env }, stdio: ["pipe", "pipe", "pipe"] })
    let stdout = "", stderr = ""
    cli.stdout.on("data", (data) => { stdout += data })
    cli.stderr.on("data", (data) => { stderr += data })
    exited = new Promise((done) => cli.once("close", done))
    await until(() => stdout.includes("已启动"))
    cli.stdin.write("启动合成任务并等待。\n")
    await until(() => f.counts().parent === 2)
    await f.release()
    await until(() => f.counts().parent === 3 && stdout.includes("合成任务已完成。"))
    cli.stdin.write("/close\n")
    assert.equal(await exited, 0)
    assert.equal(f.counts().parent, 3); assert.equal(stderr, "")
  } finally {
    if (cli && cli.exitCode === null) { cli.stdin.end("/close\n"); await exited }
    await f.close()
  }
})

for (const method of ["reload", "fork", "switchThread"]) {
  test(`Codex 真实 app-server：${method} 使旧实例失效`, { skip: !binary, timeout: 40000 }, async () => {
    const f = await fixture("complete")
    try {
      await f.prompt("启动合成任务。")
      await until(() => f.snapshot().waits.length === 1)
      const next = await (method === "switchThread" ? f.switchThread(f.threadId) : f[method]())
      f.replace(next)
      assert.deepEqual(next.snapshot(), { tasks: [], waits: [] })
      await assert.rejects(f.prompt("旧实例输入。"), /已关闭/)
      await assert.rejects(f.interrupt(), /已关闭/)
      await f.release(); await sleep(80)
      assert.equal(f.counts().parent, 2)
      await next.close()
    } finally { await f.close() }
  })
}

test("Codex 真实 app-server：并发 close 与同步重入只关闭一次", { skip: !binary, timeout: 30000 }, async () => {
  const f = await fixture("child")
  try {
    await f.prompt("启动子任务。")
    await until(() => f.snapshot().waits.length === 1)
    let reentrant
    const original = f.options.onEvent
    f.options.onEvent = (message) => { original(message); if (message.method === "connection/closed") reentrant = f.closeAdapter() }
    const first = f.closeAdapter(), second = f.closeAdapter()
    assert.equal(first, second)
    await Promise.all([first, second])
    assert.equal(reentrant, first)
    await assert.rejects(f.prompt("关闭后输入。"), /已关闭/)
  } finally { await f.close() }
})

for (const stage of ["initialize", "thread/start"]) {
  test(`Codex 真实 app-server：${stage} 回执处理失败释放连接`, { skip: !binary, timeout: 30000 }, async () => {
    const native = CodexRpc.prototype.request
    let target, once = false
    CodexRpc.prototype.request = async function(method, ...args) {
      const value = await native.call(this, method, ...args)
      if (method === stage && !once) { target = this; once = true; throw new Error("合成回执处理失败") }
      return value
    }
    try {
      await assert.rejects(fixture("complete"), /合成回执处理失败/)
      assert.throws(() => process.kill(target.child.pid, 0), /ESRCH/)
    } finally { CodexRpc.prototype.request = native }
    const valid = await fixture("summary"); await valid.close()
  })
}

test("Codex 真实 app-server：close 等待在途子 thread 创建并拒绝发布 handle", { skip: !binary, timeout: 30000 }, async () => {
  const native = CodexRpc.prototype.request
  let release, captured = false, calls = 0, unsubscribe = 0
  const boundary = new Promise((done) => { release = done })
  CodexRpc.prototype.request = async function(method, ...args) {
    const result = await native.call(this, method, ...args)
    if (method === "thread/unsubscribe") unsubscribe++
    if (method === "thread/start" && ++calls === 2) { captured = true; await boundary }
    return result
  }
  let f
  try {
    f = await fixture("child")
    await f.prompt("创建子任务。")
    await until(() => captured)
    const closing = f.closeAdapter()
    let ended = false; void closing.then(() => { ended = true })
    await sleep(30); assert.equal(ended, false)
    release(); await closing
    assert.equal(f.snapshot().tasks.length, 0); assert.equal(f.counts().child, 0); assert.ok(unsubscribe >= 1)
  } finally { release(); CodexRpc.prototype.request = native; await f?.close() }
})

for (const stage of ["fork", "reload"]) {
  test(`Codex 真实 app-server：close 与在途 ${stage} 竞争不发布替换实例`, { skip: !binary, timeout: 30000 }, async () => {
    const native = CodexRpc.prototype.request
    let release, captured = false, target
    const boundary = new Promise((done) => { release = done })
    let f
    try {
      f = await fixture("complete")
      await f.prompt("启动合成任务。")
      await until(() => f.snapshot().waits.length === 1)
      CodexRpc.prototype.request = async function(method, ...args) {
        const result = await native.call(this, method, ...args)
        if (method === (stage === "fork" ? "thread/fork" : "thread/resume")) { target = this; captured = true; await boundary }
        return result
      }
      const replacing = f[stage]()
      const rejected = assert.rejects(replacing, /已关闭|被 close 取消/)
      await until(() => captured)
      const closing = f.closeAdapter()
      release(); await rejected; await closing
      assert.throws(() => process.kill(target.child.pid, 0), /ESRCH/)
      await f.release(); await sleep(40); assert.equal(f.counts().parent, 2)
    } finally { release(); CodexRpc.prototype.request = native; await f?.close() }
  })
}

test("Codex 真实 app-server：重复工具回包只接续一次", { skip: !binary, timeout: 30000 }, async () => {
  const native = CodexRpc.prototype.respond
  CodexRpc.prototype.respond = function(id, result) { native.call(this, id, result); native.call(this, id, result) }
  let f
  try {
    f = await fixture("complete")
    const running = await f.prompt("启动任务并等待。")
    await until(() => f.snapshot().waits.length === 1)
    await f.release(); await running.completed; await sleep(80)
    assert.equal(f.counts().parent, 3); assert.equal(f.snapshot().waits[0].state, "delivered")
  } finally { CodexRpc.prototype.respond = native; await f?.close() }
})

test("Codex 真实 app-server：遗漏完成通知后通过原生读取确认工具已接纳", { skip: !binary, timeout: 30000 }, async () => {
  const native = CodexRpc.prototype.subscribe
  CodexRpc.prototype.subscribe = function(listener) {
    return native.call(this, (message) => {
      if (message.method === "item/completed" && message.params.item.type === "dynamicToolCall" && message.params.item.tool === "wait_for") return
      listener(message)
    })
  }
  let f
  try {
    f = await fixture("complete")
    const running = await f.prompt("启动任务并等待。")
    await until(() => f.snapshot().waits.length === 1)
    await f.release(); await running.completed
    await until(() => f.snapshot().waits[0].state === "delivered")
    assert.equal(f.counts().parent, 3)
  } finally { CodexRpc.prototype.subscribe = native; await f?.close() }
})

test("Codex 真实 app-server：遗漏子任务终态与回答事件后按具体 turn 查询接续", { skip: !binary, timeout: 30000 }, async () => {
  const native = CodexRpc.prototype.subscribe
  let f
  CodexRpc.prototype.subscribe = function(listener) {
    return native.call(this, (message) => {
      if (f && message.params?.threadId !== f.threadId && (message.method === "turn/completed" || (message.method === "item/completed" && message.params.item.type === "agentMessage" && message.params.item.text === "合成任务已完成。"))) return
      listener(message)
    })
  }
  try {
    f = await fixture("child")
    const running = await f.prompt("启动子任务并等待。")
    await until(() => f.snapshot().waits.length === 1)
    await f.release(); await running.completed
    const wait = f.snapshot().waits[0]
    assert.equal(wait.reason, "succeeded")
    assert.ok(wait.snapshot.result.text.includes("合成任务已完成。"))
    assert.equal(f.counts().parent, 3); assert.equal(f.counts().child, 1)
    assert.deepEqual(f.errors, [])
  } finally { CodexRpc.prototype.subscribe = native; await f?.close() }
})

test("Codex 真实 app-server：原生 compact 中断待回包工具的能力缺口", { skip: !binary, timeout: 30000 }, async () => {
  const native = CodexRpc.prototype.request
  let connection
  CodexRpc.prototype.request = function(...args) { connection = this; return native.apply(this, args) }
  const f = await fixture("complete")
  try {
    const running = await f.prompt("启动任务并等待。")
    await until(() => f.snapshot().waits.length === 1)
    await native.call(connection, "thread/compact/start", { threadId: f.threadId })
    const ended = await running.completed
    assert.equal(ended.status, "interrupted")
    await until(() => f.counts().summaries === 1)
    assert.equal(f.snapshot().tasks[0].status, "working")
    await f.release(); await sleep(80)
    assert.equal(f.counts().parent, 2)
    const failed = f.events.find((event) => event.method === "item/completed" && event.params.item.tool === "wait_for")
    assert.equal(failed.params.item.success, false)
  } finally { CodexRpc.prototype.request = native; await f.close() }
})
