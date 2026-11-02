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
      f.setChild(outcome, undefined, 3)
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
