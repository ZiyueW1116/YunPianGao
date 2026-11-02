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
  let answer = false, fail = false, disposed = 0
  let message = { id: "assistant-wait", type: "assistant", time: { streamed: 1 }, content: [{ type: "tool", id: "wait-call", name: "wait_for" }] }
  const context = { sessionID: "parent", agent: "build", messageID: message.id, id: "wait-call", signal: controller.signal }
  const ctx = {
    location: { directory: "synthetic-workspace" },
    tool: { async transform(transform) { transform({ add(tool) { tools.set(tool.name, tool) } }); return { async dispose() { disposed++ } } } },
    agent: { async list() { return { data: [{ id: "general", mode: "subagent" }] } } },
    permission: { async assert() {}, async list() { return [] } },
    session: {
      async hook(name, hook) { hooks.set(name, hook); return { async dispose() { disposed++ } } },
      async get({ sessionID }) { return { id: sessionID, ...(sessionID === "child" && answer ? { outcome: "succeeded" } : {}), time: { idle: answer ? 2 : undefined } } },
      async create() { return { id: "child" } },
      async prompt() { return { id: "child-prompt" } },
      async context({ sessionID }) {
        if (sessionID === "parent") return [message]
        return [{ id: "child-prompt", type: "user" }, ...(answer ? [{ id: "child-answer", type: "assistant", time: { completed: 2 }, content: [{ type: "text", text: "合成子任务结果" }] }] : [])]
      },
      async interrupt(input) { interrupts.push(input); controller.abort(); return { interrupted: true } },
      async synthetic(input) { resumes.push(input); if (fail && resumes.length === 1) throw new Error("合成响应丢失") },
    },
  }
  const plugin = await setupWaitTools(ctx)
  const output = await tools.get("start_subagent").execute({ agent: "general", description: "合成任务", prompt: "合成输入" }, { ...context, id: "start-call" })
  const handle = JSON.parse(output.content).handle
  return { plugin, tools, context, ctx, hooks, handle, resumes, interrupts,
    complete() { answer = true; plugin.onEvent({ type: "session.execution.succeeded", data: { sessionID: "child" } }) },
    setMessage(value) { message = value },
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
