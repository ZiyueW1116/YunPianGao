import test from "node:test"
import assert from "node:assert/strict"
import { setupWaitTools } from "../dist/adapters/opencode-wait.js"

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const until = async (check) => {
  for (let i = 0; i < 200; i++) { if (check()) return; await sleep(5) }
  assert.fail("适配器接续超时")
}
async function fixture() {
  const tools = new Map(), hooks = new Map(), resumes = [], interrupts = [], controller = new AbortController()
  let answer = false, fail = false, disposed = 0, childOutcome, parentOutcome, childMessages, childIdle = 2
  const childController = new AbortController()
  let message = { id: "assistant-wait", type: "assistant", time: { streamed: 1 }, content: [{ type: "tool", id: "wait-call", name: "wait_for" }] }
  const context = { sessionID: "parent", agent: "build", messageID: message.id, id: "wait-call", signal: controller.signal }
  const ctx = {
    location: { directory: process.cwd() },
    tool: { async transform(transform) { transform({ add(tool) { tools.set(tool.name, tool) } }); return { async dispose() { disposed++ } } } },
    agent: { async list() { return { data: [{ id: "general", mode: "subagent" }] } } },
    permission: { async assert() {}, async list() { return [] } },
    session: {
      async hook(name, hook) { hooks.set(name, hook); return { async dispose() { disposed++ } } },
      async get({ sessionID }) {
        const outcome = sessionID === "child" ? childOutcome ?? (answer ? "succeeded" : undefined) : parentOutcome
        return { id: sessionID, ...(outcome ? { outcome } : {}), time: { idle: outcome ? childIdle : undefined } }
      },
      async create() { return { id: "child" } },
      async prompt() { return { id: "child-prompt" } },
      async wait() {},
      async context({ sessionID }) {
        if (sessionID === "parent") return [message]
        if (childMessages) return childMessages
        return [{ id: "child-prompt", type: "user" }, ...(answer ? [{ id: "child-answer", type: "assistant", time: { completed: 2 }, content: [{ type: "text", text: "合成子任务结果" }] }] : [])]
      },
      async interrupt(input) {
        interrupts.push(input)
        if (input.sessionID === "child") childOutcome = "interrupted"
        else parentOutcome = "interrupted"
        const target = input.sessionID === "child" ? childController : controller
        target.abort()
        return { interrupted: true }
      },
      async synthetic(input) { resumes.push(input); if (fail && resumes.length === 1) throw new Error("合成响应丢失") },
    },
  }
  const plugin = await setupWaitTools(ctx)
  const output = await tools.get("start_subagent").execute({ agent: "general", description: "合成任务", prompt: "合成输入" }, { ...context, id: "start-call" })
  const handle = JSON.parse(output.content).handle
  return { plugin, tools, context, ctx, hooks, handle, resumes, interrupts, childController,
    complete() { answer = true; plugin.onEvent({ type: "session.execution.succeeded", data: { sessionID: "child" } }) },
    setMessage(value) { message = value },
    setChild(outcome, messages, idle = 2) { childOutcome = outcome; childMessages = messages; childIdle = idle },
    setResponseLoss() { fail = true },
    disposed() { return disposed },
  }
}

test("宿主中断事件晚到仍不撤销等待；实际接续使用固定的 synthetic 标识", async () => {
  const f = await fixture()
  try {
    const waiting = f.tools.get("wait_for").execute({ handle: f.handle.id, timeout: 10 }, f.context)
    await until(() => f.interrupts.length === 1)
    assert.equal(f.interrupts[0].resume, true)
    await waiting
    f.plugin.onEvent({ type: "session.execution.interrupted", data: { sessionID: "parent" } })
    f.setResponseLoss(); f.complete()
    await until(() => f.resumes.length === 2)
    assert.equal(f.resumes[0].id, f.resumes[1].id)
    assert.equal(f.resumes[0].metadata.reason, "succeeded")
    const event = { sessionID: "parent", system: [] }
    f.hooks.get("context")(event)
    assert.doesNotMatch(event.system[0].text, /合成子任务结果/)
    assert.match(event.system[0].text, new RegExp(f.handle.id))
    assert.match(f.resumes[0].text, /合成子任务结果/)
    assert.match(event.system[0].text, /deadline/)
  } finally { await f.plugin.close() }
  assert.equal(f.disposed(), 2)
})

test("流结束后复核完整工具列表，不中断同一步晚到的其他工具", async () => {
  const f = await fixture()
  try {
    const message = { id: "assistant-wait", type: "assistant", time: {}, content: [{ type: "tool", name: "wait_for" }] }
    f.setMessage(message)
    const waiting = f.tools.get("wait_for").execute({ handle: f.handle.id }, f.context)
    await sleep(5)
    message.content.push({ type: "tool", name: "shell" }); message.time.streamed = 1
    await assert.rejects(waiting, /独立步骤/)
    assert.equal(f.interrupts.length, 0)
    assert.equal(f.resumes.length, 0)
  } finally { await f.plugin.close() }
})

test("模型流结束前收到用户新输入时不再停放该轮执行", async () => {
  const f = await fixture()
  try {
    const message = { id: "assistant-wait", type: "assistant", time: {}, content: [{ type: "tool", name: "wait_for" }] }
    f.setMessage(message)
    f.hooks.get("context")({ sessionID: "parent", system: [] })
    const waiting = f.tools.get("wait_for").execute({ handle: f.handle.id }, f.context)
    f.plugin.onInput("parent")
    message.time.streamed = 1
    assert.equal(JSON.parse((await waiting).content).reason, "user_input")
    assert.equal(f.interrupts.length, 0)
    assert.equal(f.resumes.length, 0)
  } finally { await f.plugin.close() }
})

test("等待期间用户输入结束等待，底层子 Agent 完成后不再额外唤醒", async () => {
  const f = await fixture()
  try {
    await f.tools.get("wait_for").execute({ handle: f.handle.id }, f.context)
    f.plugin.onInput("parent")
    f.complete()
    await f.plugin.reconcile()
    assert.equal(f.resumes.length, 0)
    const event = { sessionID: "parent", system: [] }
    f.hooks.get("context")(event)
    assert.match(event.system[0].text, /user_input/)
    assert.match(event.system[0].text, /succeeded/)
  } finally { await f.plugin.close() }
})

test("取消请求只返回目标 handle 的回执", async () => {
  const f = await fixture()
  try {
    f.complete(); await f.plugin.reconcile()
    const other = await f.tools.get("start_process").execute({ command: process.execPath, args: ["-e", "setTimeout(() => {}, 10000)"] }, { ...f.context, id: "other-process" })
    const handle = JSON.parse(other.content).handle
    const result = JSON.parse((await f.tools.get("cancel_task").execute({ handle: handle.id }, f.context)).content)
    assert.deepEqual(result, { handle: handle.id, cancellationRequested: true })
  } finally { await f.plugin.close() }
})

test("子会话压缩移除原始输入后仍按独立会话归属读取完成结果", async () => {
  const f = await fixture()
  try {
    f.setChild("succeeded", [{ id: "compressed-answer", type: "assistant", time: { completed: 2 }, content: [{ type: "text", text: "压缩后结果" }] }])
    await f.tools.get("wait_for").execute({ handle: f.handle.id, timeout: .05 }, f.context)
    await until(() => f.resumes.length === 1)
    assert.equal(f.resumes[0].metadata.reason, "succeeded")
    assert.match(f.resumes[0].text, /压缩后结果/)
  } finally { await f.plugin.close() }
})

test("内部停车只忽略同一 idle，started 已到或遗漏均不误读残留 outcome", async () => {
  for (const started of [true, false]) for (const outcome of ["succeeded", "interrupted"]) {
    const f = await fixture()
    try {
      const context = { ...f.context, sessionID: "child", messageID: "child-wait", signal: f.childController.signal }
      const processResult = await f.tools.get("start_process").execute({ command: process.execPath, args: ["-e", "setTimeout(() => {}, 100)"] }, { ...context, id: "child-process" })
      const handle = JSON.parse(processResult.content).handle
      f.setChild(undefined, [{ id: "child-prompt", type: "user" }, { id: context.messageID, type: "assistant", time: { streamed: 1 }, content: [{ type: "tool", name: "wait_for" }] }])
      await f.tools.get("wait_for").execute({ handle: handle.id }, context)
      f.setChild("interrupted")
      f.plugin.onEvent({ type: "session.execution.interrupted", data: { sessionID: "child" } })
      await f.tools.get("wait_for").execute({ handle: f.handle.id }, f.context)
      await f.plugin.reconcile()
      assert.equal(f.resumes.filter((r) => r.sessionID === "parent").length, 0)
      await until(() => f.resumes.some((r) => r.sessionID === "child"))
      await f.plugin.reconcile()
      assert.equal(f.resumes.filter((r) => r.sessionID === "parent").length, 0)
      if (started) f.plugin.onEvent({ type: "session.execution.started", data: { sessionID: "child" } })
      await f.plugin.reconcile()
      assert.equal(f.resumes.filter((r) => r.sessionID === "parent").length, 0)
      f.setChild(outcome, outcome === "succeeded" ? [
        { id: "child-final", type: "assistant", finish: "stop", time: { completed: 3 }, content: [{ type: "text", text: "合成子任务结果" }] },
        { id: "child-idle", type: "idle", outcome, time: { created: 3 } },
      ] : undefined, 3)
      f.plugin.onEvent({ type: `session.execution.${outcome}`, data: { sessionID: "child" } })
      await until(() => f.resumes.some((r) => r.sessionID === "parent"))
      assert.equal(f.resumes.find((r) => r.sessionID === "parent").metadata.reason, outcome === "succeeded" ? "succeeded" : "cancelled")
    } finally { await f.plugin.close() }
  }
})

test("非 question 表单触发介入，回答或取消后清除事件状态", async () => {
  for (const ending of ["replied", "cancelled"]) {
    const f = await fixture()
    try {
      f.plugin.onEvent({ type: "form.created", data: { form: { id: "provider-form", sessionID: "child", title: "选择搜索提供者", metadata: { kind: "websearch.provider" }, fields: [] } } })
      await f.tools.get("wait_for").execute({ handle: f.handle.id, timeout: .05 }, f.context)
      await until(() => f.resumes.length === 1)
      assert.equal(f.resumes[0].metadata.reason, "input_required")
      assert.match(f.resumes[0].text, /provider-form/)
      f.plugin.onEvent({ type: `form.${ending}`, data: { id: "provider-form", sessionID: "child", answer: {} } })
      await f.plugin.reconcile()
      const event = { sessionID: "parent", system: [] }
      f.hooks.get("context")(event)
      const state = JSON.parse(event.system[0].text.split("\n", 2)[1])
      assert.equal(state.tasks[0].status, "working")
    } finally { await f.plugin.close() }
  }
})

test("会话删除事件停止 owner 接续，后台任务仍可完成", async () => {
  const f = await fixture()
  try {
    await f.tools.get("wait_for").execute({ handle: f.handle.id }, f.context)
    f.plugin.onEvent({ type: "session.deleted", data: { sessionID: "parent" } })
    f.complete(); await f.plugin.reconcile(); await sleep(20)
    assert.equal(f.resumes.length, 0)
    const event = { sessionID: "parent", system: [] }
    f.hooks.get("context")(event)
    assert.match(event.system[0].text, /succeeded/)
  } finally { await f.plugin.close() }
})

test("取消内部停车的子任务终止其等待，进程成功或等待到期均不再接续", async () => {
  for (const timeout of [.02, 1]) {
    const f = await fixture()
    try {
      const context = { ...f.context, sessionID: "child", messageID: "child-wait", signal: f.childController.signal }
      const launched = await f.tools.get("start_process").execute({ command: process.execPath, args: ["-e", "setTimeout(() => {}, 80)"] }, { ...context, id: "child-process" })
      const handle = JSON.parse(launched.content).handle
      f.setChild(undefined, [{ id: "child-prompt", type: "user" }, { id: context.messageID, type: "assistant", time: { streamed: 1 }, content: [{ type: "tool", name: "wait_for" }] }])
      await f.tools.get("wait_for").execute({ handle: handle.id, timeout }, context)
      await f.tools.get("cancel_task").execute({ handle: f.handle.id }, f.context)
      await sleep(160); await f.plugin.reconcile()
      assert.equal(f.resumes.filter((r) => r.sessionID === "child").length, 0)
      const event = { sessionID: "child", system: [] }
      f.hooks.get("context")(event)
      assert.equal(JSON.parse(event.system[0].text.split("\n", 2)[1]).tasks[0].status, "succeeded")
    } finally { await f.plugin.close() }
  }
})

test("独立删除子会话后父 handle 返回取消，不继续查询已删除会话", async () => {
  const f = await fixture()
  try {
    await f.tools.get("wait_for").execute({ handle: f.handle.id, timeout: .05 }, f.context)
    f.plugin.onEvent({ type: "session.deleted", created: 3, data: { sessionID: "child" } })
    const get = f.ctx.session.get
    f.ctx.session.get = async (input) => {
      assert.notEqual(input.sessionID, "child", "删除后不应继续查询子会话")
      return get(input)
    }
    await f.plugin.reconcile()
    await until(() => f.resumes.length === 1)
    assert.equal(f.resumes[0].metadata.reason, "cancelled")
  } finally { await f.plugin.close() }
})

test("停车后新 busy period 的外部中断结束旧等待", async () => {
  const f = await fixture()
  try {
    await f.tools.get("wait_for").execute({ handle: f.handle.id }, f.context)
    await sleep(5)
    const get = f.ctx.session.get
    f.ctx.session.get = async (input) => input.sessionID === "parent" ? { id: "parent", outcome: "interrupted", time: { idle: 3 } } : get(input)
    f.plugin.onEvent({ type: "session.execution.interrupted", data: { sessionID: "parent" } })
    await sleep(10)
    f.complete(); await f.plugin.reconcile()
    assert.equal(f.resumes.length, 0)
    const event = { sessionID: "parent", system: [] }
    f.hooks.get("context")(event)
    assert.equal(JSON.parse(event.system[0].text.split("\n", 2)[1]).waits[0].reason, "interrupted")
  } finally { await f.plugin.close() }
})

test("宿主拒绝停车时已 ready 的等待也完成收尾", async () => {
  const f = await fixture()
  try {
    f.complete(); await f.plugin.reconcile()
    f.ctx.session.interrupt = async () => ({ interrupted: false })
    await assert.rejects(f.tools.get("wait_for").execute({ handle: f.handle.id }, f.context), /未确认暂停/)
    const event = { sessionID: "parent", system: [] }
    f.hooks.get("context")(event)
    const wait = JSON.parse(event.system[0].text.split("\n", 2)[1]).waits[0]
    assert.equal(wait.state, "delivered")
    assert.equal(wait.reason, "succeeded")
    assert.equal(f.resumes.length, 0)
  } finally { await f.plugin.close() }
})

test("旧停车请求晚到的失败只收尾本次等待，保留新等待及其停车归属", async () => {
  const f = await fixture()
  let rejectOld
  try {
    let attempts = 0
    const controller = new AbortController()
    f.ctx.session.interrupt = async () => {
      if (++attempts === 1) return new Promise((_resolve, reject) => { rejectOld = reject })
      controller.abort()
      return { interrupted: true }
    }
    f.ctx.session.get = async ({ sessionID }) => ({ id: sessionID, ...(sessionID === "parent" ? { outcome: "interrupted" } : {}), time: { idle: sessionID === "parent" ? 3 : undefined } })
    const old = f.tools.get("wait_for").execute({ handle: f.handle.id }, f.context)
    await until(() => rejectOld)
    f.plugin.onInput("parent")
    f.hooks.get("context")({ sessionID: "parent", system: [] })
    await f.tools.get("wait_for").execute({ handle: f.handle.id }, { ...f.context, signal: controller.signal })
    rejectOld(new Error("合成旧停车失败"))
    await assert.rejects(old, /旧停车失败/)
    const event = { sessionID: "parent", system: [] }
    f.hooks.get("context")(event)
    assert.equal(JSON.parse(event.system[0].text.split("\n", 2)[1]).waits[1].state, "waiting")
    f.plugin.onEvent({ type: "session.execution.interrupted", data: { sessionID: "parent" } })
    await sleep(10)
    const get = f.ctx.session.get
    f.ctx.session.get = async (input) => input.sessionID === "child" ? { id: "child", outcome: "succeeded", time: { idle: 4 } } : get(input)
    f.complete(); await f.plugin.reconcile()
    await until(() => f.resumes.length === 1)
    assert.equal(f.resumes[0].metadata.reason, "succeeded")
  } finally { rejectOld?.(new Error("合成清理")); await f.plugin.close() }
})

test("旧中断事件的查询晚于新等待时不结束新等待", async () => {
  const f = await fixture()
  let resolveOld
  try {
    await f.tools.get("wait_for").execute({ handle: f.handle.id }, f.context)
    await sleep(5)
    const get = f.ctx.session.get
    let requests = 0
    f.ctx.session.get = async (input) => {
      if (input.sessionID !== "parent") return get(input)
      if (++requests === 1) return new Promise((resolve) => { resolveOld = resolve })
      return { id: "parent", outcome: "interrupted", time: { idle: 4 } }
    }
    f.plugin.onEvent({ type: "session.execution.interrupted", data: { sessionID: "parent" } })
    await until(() => resolveOld)
    f.plugin.onInput("parent")
    f.hooks.get("context")({ sessionID: "parent", system: [] })
    const controller = new AbortController()
    f.ctx.session.interrupt = async () => { controller.abort(); return { interrupted: true } }
    await f.tools.get("wait_for").execute({ handle: f.handle.id }, { ...f.context, signal: controller.signal })
    resolveOld({ id: "parent", outcome: "interrupted", time: { idle: 3 } })
    await sleep(10)
    f.complete(); await f.plugin.reconcile()
    await until(() => f.resumes.length === 1)
    assert.equal(f.resumes[0].metadata.reason, "succeeded")
  } finally { resolveOld?.({ id: "parent", time: {} }); await f.plugin.close() }
})

for (const previousIdle of [undefined, 2]) test(`停车等待原生清理完成后记录 idle（旧值 ${previousIdle}）`, async () => {
  const f = await fixture()
  let returned
  try {
    const context = { ...f.context, sessionID: "child", messageID: "child-wait", signal: f.childController.signal }
    const launched = await f.tools.get("start_process").execute({ command: process.execPath, args: ["-e", "setTimeout(() => {}, 200)"] }, { ...context, id: "child-process" })
    const handle = JSON.parse(launched.content).handle
    const get = f.ctx.session.get, interrupt = f.ctx.session.interrupt
    let idle = previousIdle, settling, waitCalls = 0
    const toolReturned = new Promise((resolve) => { returned = resolve })
    f.ctx.session.get = async (input) => input.sessionID === "child" ? { id: "child", outcome: idle === undefined ? undefined : "interrupted", time: { idle } } : get(input)
    f.ctx.session.interrupt = async (input) => {
      if (input.sessionID !== "child") return interrupt(input)
      f.childController.abort()
      settling = (async () => {
        await toolReturned
        await sleep(10)
        idle = 3
        f.plugin.onEvent({ type: "session.execution.interrupted", data: { sessionID: "child" } })
      })()
      return { interrupted: true }
    }
    f.ctx.session.wait = async ({ sessionID }) => { if (sessionID === "child") { waitCalls++; await settling } }
    f.setChild(undefined, [{ id: "child-prompt", type: "user" }, { id: context.messageID, type: "assistant", time: { streamed: 1 }, content: [{ type: "tool", name: "wait_for" }] }])
    await f.tools.get("wait_for").execute({ handle: handle.id }, context)
    returned()
    await settling; await sleep(5)
    await f.tools.get("wait_for").execute({ handle: f.handle.id, timeout: .07 }, f.context)
    await f.plugin.reconcile(); await sleep(5)
    assert.equal(f.resumes.filter((r) => r.sessionID === "parent").length, 0)
    idle = 4
    f.plugin.onEvent({ type: "session.execution.interrupted", data: { sessionID: "child" } })
    await f.plugin.reconcile()
    await until(() => f.resumes.some((r) => r.sessionID === "parent"))
    assert.equal(f.resumes.find((r) => r.sessionID === "parent").metadata.reason, "cancelled")
    assert.equal(waitCalls, 1)
  } finally { returned?.(); await f.plugin.close() }
})

test("漏掉 owner 删除事件时，接续确认会话不存在后停止重试", async () => {
  const f = await fixture()
  try {
    f.ctx.session.synthetic = async (input) => {
      f.resumes.push(input)
      throw Object.assign(new Error("合成会话不存在"), { _tag: "Session.NotFoundError", sessionID: input.sessionID })
    }
    f.complete(); await f.plugin.reconcile()
    await f.tools.get("wait_for").execute({ handle: f.handle.id }, f.context)
    await until(() => f.resumes.length > 0)
    await sleep(550)
    assert.equal(f.resumes.length, 1)
    const event = { sessionID: "parent", system: [] }
    f.hooks.get("context")(event)
    assert.equal(JSON.parse(event.system[0].text.split("\n", 2)[1]).waits[0].state, "delivered")
  } finally { await f.plugin.close() }
})

test("重连复核在任务未完成时发现 owner 已删除并结束等待", async () => {
  const f = await fixture()
  try {
    await f.tools.get("wait_for").execute({ handle: f.handle.id }, f.context)
    await sleep(5)
    const get = f.ctx.session.get
    f.ctx.session.get = async (input) => {
      if (input.sessionID === "parent") throw { _tag: "Session.NotFoundError", sessionID: "parent" }
      return get(input)
    }
    await f.plugin.reconcile()
    const event = { sessionID: "parent", system: [] }
    f.hooks.get("context")(event)
    const state = JSON.parse(event.system[0].text.split("\n", 2)[1])
    assert.equal(state.tasks[0].status, "working")
    assert.equal(state.waits[0].state, "delivered")
    f.complete(); await f.plugin.reconcile()
    assert.equal(f.resumes.length, 0)
  } finally { await f.plugin.close() }
})

test("漏掉子会话删除事件时，查询确认不存在后父 handle 返回取消", async () => {
  const f = await fixture()
  try {
    const get = f.ctx.session.get
    f.ctx.session.get = async (input) => {
      if (input.sessionID === "child") throw { _tag: "Session.NotFoundError", sessionID: "child" }
      return get(input)
    }
    await f.tools.get("wait_for").execute({ handle: f.handle.id, timeout: .05 }, f.context)
    await f.plugin.reconcile()
    await until(() => f.resumes.length === 1)
    assert.equal(f.resumes[0].metadata.reason, "cancelled")
  } finally { await f.plugin.close() }
})

test("普通查询失败、错误标签或其他 session 的缺失不当作删除，恢复后仍可成功", async () => {
  for (const target of ["parent", "child"]) for (const error of [new Error("合成临时错误"), { _tag: "Session.NotFoundError", sessionID: "other" }, { _tag: "Other.NotFoundError", sessionID: target }]) {
    const f = await fixture()
    try {
      await f.tools.get("wait_for").execute({ handle: f.handle.id }, f.context)
      await sleep(5)
      const get = f.ctx.session.get
      f.ctx.session.get = async (input) => { if (input.sessionID === target) throw error; return get(input) }
      await assert.doesNotReject(f.plugin.reconcile())
      const event = { sessionID: "parent", system: [] }
      f.hooks.get("context")(event)
      assert.equal(JSON.parse(event.system[0].text.split("\n", 2)[1]).waits[0].state, "waiting")
      f.ctx.session.get = get
      f.complete(); await f.plugin.reconcile()
      await until(() => f.resumes.length === 1)
      assert.equal(f.resumes[0].metadata.reason, "succeeded")
    } finally { await f.plugin.close() }
  }
})

test("卸载取消重连时的 owner 本地复核并等待收尾", async () => {
  const f = await fixture()
  let resolveQuery
  const get = f.ctx.session.get
  f.ctx.session.get = async (input) => input.sessionID === "parent" ? new Promise((resolve) => { resolveQuery = resolve }) : get(input)
  const reconciling = f.plugin.reconcile()
  try {
    await until(() => resolveQuery)
    await f.plugin.close()
    await reconciling
  } finally { resolveQuery?.({ id: "parent", time: {} }); await f.plugin.close() }
})

for (const outcome of ["succeeded", "failed"]) test(`内部等待仍在进行时，控制项 ${outcome} 不结束子任务`, async () => {
  const f = await fixture()
  try {
    const context = { ...f.context, sessionID: "child", messageID: "child-wait", signal: f.childController.signal }
    const launched = await f.tools.get("start_process").execute({ command: process.execPath, args: ["-e", "setTimeout(() => {}, 150)"] }, { ...context, id: "child-process" })
    const handle = JSON.parse(launched.content).handle
    f.setChild(undefined, [{ id: context.messageID, type: "assistant", time: { streamed: 1 }, content: [{ type: "tool", name: "wait_for" }] }])
    await f.tools.get("wait_for").execute({ handle: handle.id }, context)
    await sleep(5)
    f.setChild(outcome, [{ id: "control", type: "compaction", status: outcome === "failed" ? "failed" : "completed", time: { created: 3 } }, { id: "control-idle", type: "idle", outcome, time: { created: 3 } }], 3)
    await f.tools.get("wait_for").execute({ handle: f.handle.id }, f.context)
    await f.plugin.reconcile(); await sleep(10)
    assert.equal(f.resumes.filter((r) => r.sessionID === "parent").length, 0)
  } finally { await f.plugin.close() }
})

for (const completedAt of [2, 1]) test(`内部结果已投递后等待真正回答及其后 idle，回答时间 ${completedAt} 不必大于停车代次`, async () => {
  const f = await fixture()
  try {
    const context = { ...f.context, sessionID: "child", messageID: "child-wait", signal: f.childController.signal }
    const launched = await f.tools.get("start_process").execute({ command: process.execPath, args: ["-e", "setTimeout(() => {}, 10)"] }, { ...context, id: "child-process" })
    const handle = JSON.parse(launched.content).handle
    f.setChild(undefined, [{ id: context.messageID, type: "assistant", time: { streamed: 1 }, content: [{ type: "tool", name: "wait_for" }] }])
    await f.tools.get("wait_for").execute({ handle: handle.id }, context)
    await until(() => f.resumes.some((r) => r.sessionID === "child"))
    const oldAnswer = { id: context.messageID, type: "assistant", finish: "error", error: { type: "aborted", message: "Step interrupted" }, time: { completed: 2 }, content: [] }
    const controlIdle = { id: "control-idle", type: "idle", outcome: "failed", time: { created: 3 } }
    f.setChild("failed", [oldAnswer, { id: "control", type: "compaction", status: "failed", time: { created: 3 } }, controlIdle], 3)
    await f.tools.get("wait_for").execute({ handle: f.handle.id }, f.context)
    await f.plugin.reconcile(); await sleep(5)
    assert.equal(f.resumes.filter((r) => r.sessionID === "parent").length, 0)
    const answer = { id: "real-answer", type: "assistant", finish: "stop", time: { created: completedAt }, content: [{ type: "text", text: "真正任务结果" }] }
    f.setChild("failed", [controlIdle, answer], 3)
    await f.plugin.reconcile()
    assert.equal(f.resumes.filter((r) => r.sessionID === "parent").length, 0)
    answer.time.completed = completedAt
    await f.plugin.reconcile()
    assert.equal(f.resumes.filter((r) => r.sessionID === "parent").length, 0)
    f.setChild("failed", [answer,
      { id: "real-idle", type: "idle", outcome: "succeeded", time: { created: completedAt } },
      { id: "later-control", type: "compaction", status: "failed", time: { created: 4 } },
      { id: "later-control-idle", type: "idle", outcome: "failed", time: { created: 4 } },
    ], 4)
    await f.plugin.reconcile()
    await until(() => f.resumes.some((r) => r.sessionID === "parent"))
    const result = f.resumes.find((r) => r.sessionID === "parent")
    assert.equal(result.metadata.reason, "succeeded")
    assert.match(result.text, /真正任务结果/)
    assert.equal(JSON.parse(result.text.split("\n", 2)[1]).snapshot.finishedAt, completedAt)
  } finally { await f.plugin.close() }
})

test("compact 后取消内部等待的子任务，原生 interrupt 为 no-op 仍取消逻辑任务", async () => {
  const f = await fixture()
  try {
    const context = { ...f.context, sessionID: "child", messageID: "child-wait", signal: f.childController.signal }
    const launched = await f.tools.get("start_process").execute({ command: process.execPath, args: ["-e", "setTimeout(() => {}, 80)"] }, { ...context, id: "child-process" })
    const handle = JSON.parse(launched.content).handle
    f.setChild(undefined, [{ id: context.messageID, type: "assistant", time: { streamed: 1 }, content: [{ type: "tool", name: "wait_for" }] }])
    await f.tools.get("wait_for").execute({ handle: handle.id }, context)
    await sleep(5)
    f.setChild("succeeded", [{ id: "control", type: "compaction", status: "completed", time: { created: 3 } }, { id: "control-idle", type: "idle", outcome: "succeeded", time: { created: 3 } }], 3)
    const interrupt = f.ctx.session.interrupt
    f.ctx.session.interrupt = async (input) => input.sessionID === "child" ? { interrupted: false } : interrupt(input)
    await f.plugin.reconcile()
    await f.tools.get("cancel_task").execute({ handle: f.handle.id }, f.context)
    await f.tools.get("wait_for").execute({ handle: f.handle.id }, f.context)
    await until(() => f.resumes.some((r) => r.sessionID === "parent"))
    assert.equal(f.resumes.find((r) => r.sessionID === "parent").metadata.reason, "cancelled")
    await sleep(150); await f.plugin.reconcile()
    assert.equal(f.resumes.filter((r) => r.sessionID === "child").length, 0)
    const event = { sessionID: "child", system: [] }
    f.hooks.get("context")(event)
    assert.equal(JSON.parse(event.system[0].text.split("\n", 2)[1]).tasks[0].status, "succeeded")
  } finally { await f.plugin.close() }
})

for (const first of ["succeeded", "failed"]) for (const later of ["succeeded", "failed", "interrupted"]) test(`新回答的首个 idle ${first} 不受后续控制项 ${later} 覆盖`, async () => {
  const f = await fixture()
  try {
    const context = { ...f.context, sessionID: "child", messageID: "child-wait", signal: f.childController.signal }
    const launched = await f.tools.get("start_process").execute({ command: process.execPath, args: ["-e", "setTimeout(() => {}, 10)"] }, { ...context, id: "child-process" })
    const handle = JSON.parse(launched.content).handle
    f.setChild(undefined, [{ id: context.messageID, type: "assistant", time: { streamed: 1 }, content: [{ type: "tool", name: "wait_for" }] }])
    await f.tools.get("wait_for").execute({ handle: handle.id }, context)
    await until(() => f.resumes.some((r) => r.sessionID === "child"))
    f.setChild(later, [
      { id: "real-answer", type: "assistant", finish: "stop", time: { completed: 2 }, content: [{ type: "text", text: "真实回答" }] },
      { id: "real-idle", type: "idle", outcome: first, error: first === "failed" ? { type: "synthetic.failure", message: "合成执行失败" } : undefined, time: { created: 2 } },
      { id: "later-control", type: "compaction", status: "completed", time: { created: 3 } },
      { id: "later-idle", type: "idle", outcome: later, time: { created: 4 } },
    ], 4)
    await f.tools.get("wait_for").execute({ handle: f.handle.id, timeout: .08 }, f.context)
    await until(() => f.resumes.some((r) => r.sessionID === "parent"))
    const result = f.resumes.find((r) => r.sessionID === "parent")
    assert.equal(result.metadata.reason, first)
    const snapshot = JSON.parse(result.text.split("\n", 2)[1]).snapshot
    assert.equal(snapshot.finishedAt, 2)
    if (first === "failed") assert.equal(snapshot.error, "合成执行失败")
  } finally { await f.plugin.close() }
})
