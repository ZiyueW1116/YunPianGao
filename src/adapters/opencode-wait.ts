import { spawn, type ChildProcess } from "node:child_process"
import { setTimeout as delay } from "node:timers/promises"
import type { Plugin } from "@opencode/plugin"
import { Error as ToolError, type ToolContext } from "@opencode/plugin/promise/tool"
import { createWaitRuntime, type TaskSnapshot } from "../wait.js"

type Context = Plugin.Context
type SessionID = Parameters<Context["session"]["get"]>[0]["sessionID"]
type Event = Awaited<ReturnType<Context["event"]["subscribe"]>> extends AsyncIterable<infer T> ? T : never
type Child = { changed: Set<() => void>; accepted: boolean; launchError?: string; cancelRequested?: boolean; deletedAt?: number; forms: Map<string, Extract<Event, { type: "form.created" }>["data"]["form"]> }
const textResult = (value: unknown) => ({ content: JSON.stringify(value), metadata: { yunpiangao: true } })
const schema = (properties: Record<string, unknown>, required: string[]) => ({ type: "object", properties, required, additionalProperties: false })
const string = { type: "string", minLength: 1 }
const missingSession = (error: unknown, sessionID: string) => typeof error === "object" && error !== null &&
  "_tag" in error && error._tag === "Session.NotFoundError" && "sessionID" in error && error.sessionID === sessionID

// 2.1.4 的进程内 Promise 适配器未转发 RequestOptions.signal；只结束本地等待，不撤销宿主已接纳的工作。
function request<T>(signal: AbortSignal, run: () => Promise<T>): Promise<T> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason)
    signal.addEventListener("abort", aborted, { once: true })
    Promise.resolve().then(() => { signal.throwIfAborted(); return run() }).then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted))
  })
}

export async function setupWaitTools(ctx: Context) {
  const lifetime = new AbortController()
  const registrations: Array<{ dispose(): Promise<void> }> = []
  const pending = new Set<Promise<unknown>>()
  const children = new Map<string, Child>()
  // 仅记录已注册任务的 owner，供事件重连时复核。
  const owners = new Set<string>()
  const parking = new Map<string, { idle?: number; messageID: string }>()
  const inputEpochs = new Map<string, number>()
  const modelEpochs = new Map<string, number>()
  let closed = false
  const report = () => { if (!closed) console.warn("云片糕（YunPianGao）任务状态或接续请求暂未完成；运行时将复核或重试。") }
  const track = <T>(work: Promise<T>) => {
    pending.add(work)
    void work.catch(report).finally(() => pending.delete(work))
    return work
  }
  const runtime = createWaitRuntime({
    async resume(record, signal) {
      try {
        await request(signal, () => ctx.session.synthetic({
          sessionID: record.sessionID as SessionID,
          id: `msg_${record.id}`,
          text: `云片糕任务等待已结束，请结合最新用户输入继续。\n${JSON.stringify(record)}`,
          description: "任务等待结果",
          metadata: { source: "yunpiangao.wait", waitID: record.id, handle: record.handle.id, reason: record.reason! },
          delivery: "steer",
        }, { signal }))
      } catch (error) {
        if (!missingSession(error, record.sessionID)) throw error
        endDeletedSession(record.sessionID)
      }
    },
    onError: report,
  })
  const allow = (context: ToolContext, action: string, resource: string) => ctx.permission.assert({
    sessionID: context.sessionID, agent: context.agent, action, resources: [resource],
    source: { type: "tool", messageID: context.messageID, id: context.id },
  })
  const notifyChild = (child: Child) => {
    for (const notify of child.changed) notify()
  }
  const endDeletedSession = (sessionID: string, deletedAt = Date.now()) => {
    runtime.stopWaits(sessionID)
    owners.delete(sessionID)
    const child = children.get(sessionID)
    if (child) {
      child.deletedAt = deletedAt
      children.delete(sessionID)
      notifyChild(child)
    }
    parking.delete(sessionID)
    inputEpochs.delete(sessionID)
    modelEpochs.delete(sessionID)
  }
  const refreshChild = async (childID: string, child: Child, signal: AbortSignal): Promise<TaskSnapshot> => {
    if (child.deletedAt !== undefined) return { status: "cancelled", finishedAt: child.deletedAt }
    if (child.launchError) return { status: "failed", error: child.launchError }
    if (!child.accepted) return { status: "working" }
    const sessionID = childID as SessionID
    if (child.cancelRequested) {
      await request(signal, () => ctx.session.interrupt({ sessionID }, { signal }))
      await request(signal, () => ctx.session.wait({ sessionID }, { signal }))
    } else {
      // permission.asked 是瞬时事件；断线后从宿主当前待处理请求复核。
      const permissions = await request(signal, () => ctx.permission.list({ sessionID }, { signal }))
      if (permissions.length) return { status: "input_required", intervention: { permissions } }
      if (child.forms.size) return { status: "input_required", intervention: { forms: [...child.forms.values()] } }
    }
    const session = await request(signal, () => ctx.session.get({ sessionID }, { signal }))
    const messages = await request(signal, () => ctx.session.context({ sessionID }, { signal }))
    const answer = messages.findLast((message) => message.type === "assistant")
    if (!child.cancelRequested && answer?.type === "assistant") {
      const question = answer.content.find((part) => part.type === "tool" && part.name === "question" && part.state.status === "running")
      if (question) return { status: "input_required", intervention: { question } }
    }
    const parked = parking.get(childID)
    let outcome = session.outcome, finishedAt = session.time.idle
    let failure = answer?.type === "assistant" ? answer.error : undefined
    const ownWait = runtime.snapshot(childID).waits.at(-1)
    // 控制项也会产生 idle；新回答之后的第一个 idle 确认其终态，后续控制项不能覆盖。
    const completed = ownWait?.state === "delivered" && answer?.type === "assistant" && answer.time.completed && answer.id !== parked?.messageID
      ? messages.slice(messages.indexOf(answer) + 1).find((message) => message.type === "idle") : undefined
    const finalAnswer = answer?.type === "assistant" && answer.finish !== undefined && !["tool-calls", "length"].includes(answer.finish)
    if (completed && (completed.outcome === "failed" || (completed.outcome === "succeeded" && finalAnswer))) {
      outcome = completed.outcome
      finishedAt = completed.time.created
      failure = completed.error ?? failure
    } else {
      // 原生 outcome 在下一次执行开始后仍保留；只忽略内部停车对应的那一次 idle。
      if (outcome === "interrupted" && parked && (parked.idle === undefined || parked.idle === finishedAt) && !child.cancelRequested) return { status: "working" }
      if (ownWait && outcome !== "interrupted")
        return child.cancelRequested ? { status: "cancelled", finishedAt: Date.now() } : { status: "working" }
    }
    // 新会话只有这次任务，输入接纳状态独立于可能被压缩移除的原始消息。
    if (outcome && finishedAt) {
      const status = outcome === "succeeded" ? "succeeded" : outcome === "failed" ? "failed" : "cancelled"
      return { status, finishedAt, result: answer?.type === "assistant" ? answer.content.filter((part) => part.type === "text").map((part) => part.text).join("\n") : "", ...(failure ? { error: failure.message } : {}) }
    }
    return { status: "working" }
  }

  try {
    registrations.push(await ctx.tool.transform((editor) => {
      editor.add({
        name: "start_process", options: { codemode: false, permission: "yunpiangao.process" },
        description: "启动后台进程，立即返回对应这次执行的 handle。command 为可执行文件，args 为参数数组，不通过 shell 解释。需要结果时在后续步骤单独调用 wait_for；不要用长 sleep 或反复查询等待。进程默认在当前工作目录运行。",
        input: schema({ command: string, args: { type: "array", items: { type: "string" } } }, ["command", "args"]),
        async execute(raw, context) {
          const input = raw as { command: string; args: string[] }
          await allow(context, "yunpiangao.process", JSON.stringify([input.command, ...input.args]))
          context.signal.throwIfAborted()
          let snapshot: TaskSnapshot = { status: "working" }
          let output = Buffer.alloc(0), truncated = false
          let cancelRequested = false
          const changed = new Set<() => void>()
          const child: ChildProcess = spawn(input.command, input.args, { cwd: ctx.location.directory, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] })
          const collect = (chunk: Buffer) => {
            const combined = Buffer.concat([output, chunk])
            truncated ||= combined.length > 65536
            output = combined.subarray(Math.max(0, combined.length - 65536))
          }
          child.stdout?.on("data", collect)
          child.stderr?.on("data", collect)
          const changedState = () => { for (const notify of changed) notify() }
          child.once("error", () => { snapshot = { status: "failed", finishedAt: Date.now(), error: "无法启动进程。" }; changedState() })
          child.once("close", (exitCode, signal) => {
            if (snapshot.status !== "failed") snapshot = {
              status: cancelRequested && signal === "SIGTERM" ? "cancelled" : exitCode === 0 ? "succeeded" : "failed",
              finishedAt: Date.now(),
              result: { exitCode, signal, output: output.toString("utf8"), truncated },
            }
            changedState()
          })
          child.unref()
          owners.add(context.sessionID)
          const handle = runtime.register(context.sessionID, "process", `${context.id}:${child.pid ?? "spawn-error"}`, {
            async read() { return snapshot },
            subscribe(notify) { changed.add(notify); return () => { changed.delete(notify) } },
            async cancel() {
              if (snapshot.status !== "working") return
              cancelRequested = true
              try {
                if (process.platform === "win32") child.kill("SIGTERM")
                else if (child.pid) process.kill(-child.pid, "SIGTERM")
              } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error }
            },
          })
          return textResult({ handle, instruction: "需要结果时单独调用 wait_for。取消等待不会取消进程；取消任务请调用 cancel_task。" })
        },
      })
      editor.add({
        name: "start_subagent", options: { codemode: false, permission: "subagent" },
        description: "启动独立子 Agent 任务并立即返回这次执行的 handle。需要结果时在后续步骤单独调用 wait_for。agent 使用宿主已有的子 Agent 标识；首版只允许顶层 session 启动，不复用已有子会话。",
        input: schema({ agent: string, prompt: string, description: string }, ["agent", "prompt", "description"]),
        async execute(raw, context) {
          const input = raw as { agent: string; prompt: string; description: string }
          const parent = await ctx.session.get({ sessionID: context.sessionID }, { signal: context.signal })
          if (parent.parentID) throw new ToolError({ message: "首版任务等待不支持嵌套启动子 Agent。" })
          const agent = (await ctx.agent.list()).data.find((agent) => agent.id === input.agent || agent.name === input.agent)
          if (!agent || agent.mode === "primary" || agent.hidden) throw new ToolError({ message: "请选择宿主可用的子 Agent。" })
          await allow(context, "subagent", agent.id)
          context.signal.throwIfAborted()
          const session = await ctx.session.create({ parentID: context.sessionID, agent: agent.id, model: agent.model ?? parent.model, title: input.description, location: { directory: ctx.location.directory } }, { signal: lifetime.signal })
          const child: Child = { changed: new Set(), accepted: false, forms: new Map() }
          children.set(session.id, child)
          owners.add(context.sessionID)
          const handle = runtime.register(context.sessionID, "subagent", session.id, {
            async read(signal) {
              try { return await refreshChild(session.id, child, signal) }
              catch (error) {
                if (missingSession(error, session.id)) endDeletedSession(session.id)
                if (child.deletedAt !== undefined) return { status: "cancelled", finishedAt: child.deletedAt }
                throw error
              }
            },
            subscribe(notify) { child.changed.add(notify); return () => { child.changed.delete(notify) } },
            async cancel(signal) {
              child.cancelRequested = true
              runtime.stopWaits(session.id)
              await request(signal, () => ctx.session.interrupt({ sessionID: session.id }, { signal }))
            },
          })
          try {
            await ctx.session.prompt({ sessionID: session.id, text: input.prompt }, { signal: lifetime.signal })
            child.accepted = true
            notifyChild(child)
          } catch {
            child.launchError = "子 Agent 输入未成功接纳。"
            notifyChild(child)
          }
          return textResult({ handle, instruction: "需要结果时单独调用 wait_for；需要介入时返回宿主请求标识。" })
        },
      })
      editor.add({
        name: "wait_for", options: { codemode: false },
        description: "等待 start_process 或 start_subagent 返回的 handle。timeout 为秒数，是本次等待上限，默认 600；超时、用户介入或停止等待不取消任务，可再次等待。必须在独立步骤中单独调用，不与其他工具并行。运行时暂停当前 session 推理，在成功、失败、取消、需要介入或超时时自动接续；不要额外 sleep 或查询。",
        input: schema({ handle: string, timeout: { type: "number", minimum: 0, maximum: 2147483, default: 600 } }, ["handle"]),
        async execute(raw, context) {
          const input = raw as { handle: string; timeout?: number }
          const epoch = modelEpochs.get(context.sessionID) ?? 0
          let message
          // 工具可在模型流结束前执行；必须等完整工具列表，避免漏掉晚到的并行调用。
          do {
            const messages = await ctx.session.context({ sessionID: context.sessionID }, { signal: context.signal })
            message = messages.find((message) => message.id === context.messageID)
            if (message?.type !== "assistant" || message.time.streamed) break
            await delay(20, undefined, { signal: context.signal })
          } while (!context.signal.aborted)
          if (message?.type !== "assistant" || message.content.filter((part) => part.type === "tool").length !== 1)
            throw new ToolError({ message: "wait_for 必须在独立步骤中单独调用，避免中断同一步的其他工具。" })
          context.signal.throwIfAborted()
          if (epoch !== (inputEpochs.get(context.sessionID) ?? 0)) return textResult({ reason: "user_input", instruction: "等待未开始，请先处理新输入。" })
          const record = runtime.begin(context.sessionID, input.handle, Math.ceil((input.timeout ?? 600) * 1000))
          const parked: { idle?: number; messageID: string } = { messageID: context.messageID }
          parking.set(context.sessionID, parked)
          let rejectPause: (error: unknown) => void = () => {}
          const paused = new Promise<void>((resolve, reject) => {
            rejectPause = reject
            if (context.signal.aborted) resolve()
            else context.signal.addEventListener("abort", () => resolve(), { once: true })
          })
          // resume:true 保留并发到达的新输入；确认中断之后的新唤醒由原生队列接纳。
          track((async () => {
            try {
              const interrupted = await request(lifetime.signal, () => ctx.session.interrupt({ sessionID: context.sessionID, resume: true }, { signal: lifetime.signal }))
              if (!interrupted.interrupted) throw new Error("宿主未确认暂停当前执行。")
              // interrupt 只确认接纳；原生清理和终态提交完成后才能记录停车代次。
              await request(lifetime.signal, () => ctx.session.wait({ sessionID: context.sessionID }, { signal: lifetime.signal }))
              const session = await request(lifetime.signal, () => ctx.session.get({ sessionID: context.sessionID }, { signal: lifetime.signal }))
              parked.idle = session.time.idle
              runtime.activate(record.id)
            } catch (error) {
              runtime.stopWaits(context.sessionID, record.id)
              if (parking.get(context.sessionID) === parked) parking.delete(context.sessionID)
              rejectPause(error)
              throw error
            }
          })())
          // 保持工具未返回，直至宿主确认中断，阻止模型在等待注册后多跑一轮。
          await paused
          return textResult(record)
        },
      })
      editor.add({
        name: "cancel_task", options: { codemode: false },
        description: "独立请求取消当前 session 的任务 handle。该操作与等待超时或取消等待分开；进程发送 SIGTERM，子 Agent 使用宿主中断接口。取消是协作式的，不保证任务立刻结束。",
        input: schema({ handle: string }, ["handle"]),
        async execute(raw, context) {
          const { handle } = raw as { handle: string }
          await runtime.cancel(context.sessionID, handle)
          return textResult({ handle, cancellationRequested: true })
        },
      })
    }))
    registrations.push(await ctx.session.hook("context", (event) => {
      modelEpochs.set(event.sessionID, inputEpochs.get(event.sessionID) ?? 0)
      const state = runtime.snapshot(event.sessionID)
      // 任务输出只经 synthetic 或工具结果传递，不能提升为系统指令。
      const dependencies = {
        tasks: state.tasks.map(({ handle, status, finishedAt }) => ({ handle, status, finishedAt })),
        waits: state.waits.map(({ snapshot: _snapshot, ...record }) => record),
      }
      if (state.tasks.length) event.system.push({ type: "text", text: `云片糕任务运行时状态（以此状态复核摘要中的等待依赖；新用户输入优先；需要任务结果时可再次等待同一 handle）：\n${JSON.stringify(dependencies)}` })
    }))
    return {
      onInput(sessionID: string) {
        inputEpochs.set(sessionID, (inputEpochs.get(sessionID) ?? 0) + 1)
        runtime.onInput(sessionID)
      },
      onEvent(event: Event) {
        if (event.type === "session.deleted") {
          endDeletedSession(event.data.sessionID, event.created)
        }
        if (event.type === "session.execution.interrupted") {
          const sessionID = event.data.sessionID
          const parked = parking.get(sessionID)
          if (!parked) runtime.onInterrupt(sessionID)
          else if (parked.idle !== undefined) track((async () => {
            const session = await request(lifetime.signal, () => ctx.session.get({ sessionID }, { signal: lifetime.signal }))
            if (parking.get(sessionID) === parked && session.outcome === "interrupted" && session.time.idle !== parked.idle) runtime.onInterrupt(sessionID)
          })())
        }
        if (event.type === "form.created") {
          const child = children.get(event.data.form.sessionID)
          if (child) { child.forms.set(event.data.form.id, event.data.form); notifyChild(child) }
        }
        if (event.type === "form.replied" || event.type === "form.cancelled") {
          const child = children.get(event.data.sessionID)
          if (child) { child.forms.delete(event.data.id); notifyChild(child) }
        }
        if ("sessionID" in event.data) {
          const child = children.get(event.data.sessionID as string)
          if (child && /^session\.execution\.|^permission\./.test(event.type)) notifyChild(child)
        }
      },
      reconcile() {
        return track((async () => {
          await Promise.all([...owners].map(async (sessionID) => {
            try { await request(lifetime.signal, () => ctx.session.get({ sessionID: sessionID as SessionID }, { signal: lifetime.signal })) }
            catch (error) {
              if (missingSession(error, sessionID)) endDeletedSession(sessionID)
              else report()
            }
          }))
          await runtime.refresh()
        })())
      },
      async close() {
        closed = true
        lifetime.abort()
        await runtime.close()
        await Promise.allSettled([...pending])
        for (const registration of registrations.reverse()) await registration.dispose()
      },
    }
  } catch (error) {
    closed = true
    lifetime.abort()
    await runtime.close()
    for (const registration of registrations.reverse()) await registration.dispose()
    throw error
  }
}
