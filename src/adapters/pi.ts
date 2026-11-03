import { createHash } from "node:crypto"
import { addAbortListener } from "node:events"
import {
  createAgentSession, DefaultResourceLoader, generateSummaryWithUsage, getAgentDir,
  type AgentSession, type CreateAgentSessionOptions, type ExtensionFactory,
} from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import { createYunPianGao, type Options } from "../scheduler.js"
import { createWaitRuntime, type TaskSnapshot } from "../wait.js"
import { launchProcess } from "./process.js"

export type PiSessionOptions = Omit<CreateAgentSessionOptions, "resourceLoader">
const result = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }], details: value })
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")

/** SDK 入口拥有一个 session 的工具、边界回调与清理；请用 close 释放。 */
export async function createPiSession(options: PiSessionOptions = {}, scheduling: Options = {}) {
  if (scheduling.strategy === "direct") throw new Error("Pi 适配器只支持提前准备并复核提交。")
  const cwd = options.cwd ?? process.cwd(), agentDir = options.agentDir ?? getAgentDir()
  let session: AgentSession
  let sessionID: string
  let epoch = 0, modelEpoch = 0, parked: string | undefined, closed = false
  let closing: Promise<void> | undefined
  const waitingCalls = new Map<string, string>()
  const children = new Map<AgentSession, Promise<void> | undefined>()
  const starting = new Set<Promise<unknown>>()
  const requireOpen = (signal?: AbortSignal) => {
    if (closed) throw new Error("Pi 适配实例已关闭，请创建新实例。")
    signal?.throwIfAborted()
  }
  let compactionDone = Promise.resolve(), endCompaction: (() => void) | undefined
  const report = () => { if (!closed) console.warn("云片糕操作未完成；请在当前 session 检查状态。") }
  // Pi 的内存 fork 会复用并改写 SessionManager；任务归属固定为创建时的 session。
  const id = () => sessionID
  const dependencies = () => {
    const state = runtime.snapshot(id())
    return {
      tasks: state.tasks.map(({ handle, status, finishedAt }) => ({ handle, status, finishedAt })),
      waits: state.waits.map(({ snapshot: _snapshot, ...record }) => record),
    }
  }
  const fingerprint = () => digest([epoch, session.model, session.systemPrompt, session.sessionManager.getBranch(), dependencies()])
  const runtime = createWaitRuntime({
    async resume(record, signal) {
      requireOpen(signal)
      // Pi 在 compact 期间拒绝 prompt；接续须等原生提交结束，且关闭可以打断这次等待。
      let listener: ReturnType<typeof addAbortListener> | undefined
      try {
        await Promise.race([compactionDone, new Promise<never>((_, reject) => {
          listener = addAbortListener(signal, () => reject(signal.reason))
        })])
      } finally { listener?.[Symbol.dispose]() }
      requireOpen(signal)
      const accepted = () => session.sessionManager.getEntries().some((entry) => entry.type === "custom_message" &&
        entry.customType === "yunpiangao.resume" && (entry.details as { id?: string })?.id === record.id)
      if (accepted()) return
      try {
        await session.sendCustomMessage({ customType: "yunpiangao.resume", content: JSON.stringify(record), display: true, details: { id: record.id } }, { triggerTurn: true, deliverAs: "followUp" })
      } catch (error) { if (!accepted()) throw error }
    },
    onError: report,
  })
  const engine = createYunPianGao({
    async latestCompleted() {
      if (!session.isIdle) return
      const branch = session.sessionManager.getBranch()
      const last = branch.findLast((entry) => entry.type === "message" || entry.type === "compaction")
      if (last?.type !== "message" || last.message.role !== "assistant" || last.message.stopReason !== "stop") return
      const usage = last.message.usage
      return { messageID: last.id, tokens: usage.input + usage.output + usage.cacheRead + usage.cacheWrite }
    },
    async prepare(_id, _source, signal) {
      if (!session.model) throw new Error("当前 session 未选择模型。")
      const signature = fingerprint()
      const summary = await generateSummaryWithUsage(session.sessionManager.buildSessionContext().messages, session.model,
        undefined, undefined, undefined, signal, "保留用户目标、约束、精确标识及未完成事项；区分已验证事实和推测。", undefined,
        session.thinkingLevel, (model, context, request) => session.modelRuntime.streamSimple(model, context, request))
      return { text: summary.text, fingerprint: signature }
    },
    async compact(_id, _source, signal) {
      signal.throwIfAborted()
      if (!session.isIdle || session.pendingMessageCount > 0) throw new Error("session 已离开空闲边界。")
      const abort = () => session.abortCompaction()
      signal.addEventListener("abort", abort, { once: true })
      try { await session.compact() } finally { signal.removeEventListener("abort", abort) }
    },
    async wait() {},
    onError: report,
  }, scheduling)

  const extension: ExtensionFactory = (pi) => {
    // reload 会再次调用同一个工厂；关闭的实例不向新运行时注册工具或回调。
    if (closed) return
    pi.registerTool({
      name: "start_process", label: "启动后台进程", executionMode: "sequential",
      description: "启动独立后台进程，立即返回本次执行的 handle。command 与 args 不经过 shell；需要结果时调用 wait_for，不要长 sleep 或反复查询。",
      parameters: Type.Object({ command: Type.String(), args: Type.Array(Type.String()) }),
      async execute(_call, input, signal) {
        requireOpen(signal)
        const task = launchProcess(input.command, input.args, cwd)
        return result({ handle: runtime.register(id(), "process", task.executionID, task.source) })
      },
    })
    pi.registerTool({
      name: "start_subagent", label: "启动子 Agent", executionMode: "sequential",
      description: "在当前目录创建独立 Pi 子 session，沿用当前模型和认证。立即返回本次执行的 handle；需要结果时调用 wait_for。子 session 使用原生工具，不加载扩展。",
      parameters: Type.Object({ prompt: Type.String(), description: Type.String() }),
      async execute(_call, input, signal) {
        requireOpen(signal)
        const creation = (async () => {
          const loader = new DefaultResourceLoader({ cwd, agentDir, noExtensions: true })
          await loader.reload()
          requireOpen(signal)
          const child = (await createAgentSession({ cwd, agentDir, modelRuntime: session.modelRuntime, model: session.model,
            thinkingLevel: session.thinkingLevel, resourceLoader: loader })).session
          children.set(child, undefined)
          try {
            requireOpen(signal)
            await child.bindExtensions({ mode: "json" })
            requireOpen(signal)
            let snapshot: TaskSnapshot = { status: "working" }, cancelled = false
            const changed = new Set<() => void>()
            const notify = () => { for (const fn of changed) fn() }
            const handle = runtime.register(id(), "subagent", child.sessionManager.getSessionId(), {
              async read() { return snapshot },
              subscribe(fn) { changed.add(fn); return () => { changed.delete(fn) } },
              async cancel() { cancelled = true; await child.abort() },
            })
            const completed = child.prompt(input.prompt).then(() => {
              const last = child.messages.findLast((message) => message.role === "assistant")
              snapshot = cancelled ? { status: "cancelled" } : last?.role === "assistant" && last.stopReason === "stop"
                ? { status: "succeeded", result: { description: input.description, text: child.getLastAssistantText() } }
                : { status: "failed", error: last?.role === "assistant" ? last.errorMessage ?? "子 Agent 未正常完成。" : "子 Agent 没有完成回答。" }
            }, () => { snapshot = { status: cancelled ? "cancelled" : "failed", error: "子 Agent 执行未完成。" } }).finally(() => {
              snapshot.finishedAt = Date.now(); notify(); child.dispose(); children.delete(child)
            })
            children.set(child, completed)
            return result({ handle })
          } catch (error) {
            try { await child.abort() } finally { child.dispose(); children.delete(child) }
            throw error
          }
        })()
        starting.add(creation)
        try { return await creation } finally { starting.delete(creation) }
      },
    })
    pi.registerTool({
      name: "wait_for", label: "等待任务", executionMode: "sequential",
      description: "等待具体 handle，一轮只调用一次。timeout 为秒数，默认 600。runtime 停放当前 session，在完成、失败、取消、介入或超时时接续。超时和用户输入只结束这次等待，任务继续，可再次等待。",
      parameters: Type.Object({ handle: Type.String(), timeout: Type.Optional(Type.Number({ minimum: 0, maximum: 2147483 })) }),
      async execute(call, input) {
        requireOpen()
        if (waitingCalls.size) throw new Error("同一轮只能注册一次等待。")
        if (modelEpoch !== epoch) return result({ reason: "user_input", instruction: "请先处理新输入。" })
        const record = runtime.begin(id(), input.handle, Math.ceil((input.timeout ?? 600) * 1000))
        waitingCalls.set(call, record.id)
        parked = record.id
        return result(record)
      },
    })
    pi.registerTool({
      name: "cancel_task", label: "取消任务", executionMode: "sequential",
      description: "独立请求取消具体 handle。进程发送 SIGTERM；子 Agent 调用 Pi abort。与结束一次等待分开，不级联取消独立任务。",
      parameters: Type.Object({ handle: Type.String() }),
      async execute(_call, input) { requireOpen(); await runtime.cancel(id(), input.handle); return result({ handle: input.handle, cancellationRequested: true }) },
    })
    pi.on("input", () => { if (closed) return; epoch++; engine.onInput(id()); runtime.onInput(id()) })
    pi.on("context", (event) => {
      if (closed) return
      modelEpoch = epoch
      const state = dependencies()
      if (state.tasks.length) event.messages.push({ role: "custom", customType: "yunpiangao.dependencies",
        content: `云片糕任务运行时状态（以此复核摘要中的依赖；结果可再次等待同一 handle 获取）：\n${JSON.stringify(state)}`, display: false, timestamp: Date.now() })
    })
    pi.on("agent_start", () => { if (!closed) engine.onExecution(id(), "started") })
    pi.on("agent_settled", (event) => {
      if (closed) return
      waitingCalls.clear()
      if (event.aborted) runtime.onInterrupt(id())
      if (parked) { const wait = parked; parked = undefined; runtime.activate(wait) }
      engine.onExecution(id(), event.aborted ? "interrupted" : "succeeded")
    })
    pi.on("model_select", () => { if (closed) return; epoch++; engine.onInput(id()); session.abortCompaction() })
    pi.on("session_before_compact", (event) => {
      if (closed) return { cancel: true }
      try {
        const summary = engine.takePrepared(id(), fingerprint())
        if (summary === undefined) return
        // 摘要覆盖完整投影，保留原生选定的尾部；依赖状态另外由 runtime 提供。
        return { compaction: { summary, firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore } }
      } catch { return { cancel: true } }
    })
    pi.on("session_shutdown", () => close())
  }
  const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: options.settingsManager, extensionFactories: [extension] })
  try {
    await loader.reload()
    const created = await createAgentSession({ ...options, cwd, agentDir, resourceLoader: loader })
    session = created.session
    sessionID = session.sessionManager.getSessionId()
    const nativeFinish = session.agent.finishTurn
    session.agent.finishTurn = async (turn, signal) => {
      const decision = (await nativeFinish?.(turn, signal)) || undefined
      if (closed) return decision
      const call = turn.toolResults.find((item) => waitingCalls.has(item.toolCallId))
      if (!call) return decision
      const waitID = waitingCalls.get(call.toolCallId)!
      waitingCalls.delete(call.toolCallId)
      const wait = runtime.snapshot(id()).waits.find((item) => item.id === waitID)
      if (wait?.reason === "user_input") {
        runtime.activate(waitID)
        if (parked === waitID) parked = undefined
        return decision
      }
      return { action: "end" }
    }
    session.subscribe((event) => {
      if (event.type === "compaction_start") compactionDone = new Promise<void>((resolve) => { endCompaction = resolve })
      if (event.type === "compaction_end") { endCompaction?.(); endCompaction = undefined }
    })
    return { ...created, snapshot: () => runtime.snapshot(id()),
      async interrupt() { requireOpen(); runtime.onInterrupt(id()); await session.abort() }, close }
  } catch (error) { await close(); throw error }

  function close(): Promise<void> {
    if (closing) return closing
    // abort 会同步调用宿主监听器；先公布 Promise，重入才能复用同一次清理。
    let resolveClose!: () => void, rejectClose!: (reason: unknown) => void
    closing = new Promise<void>((resolve, reject) => { resolveClose = resolve; rejectClose = reject })
    closed = true
    void (async () => {
      // 先撤销核心的投递资格，再 abort；终止子推理不能在关闭途中产生新的接续。
      const stopped = Promise.allSettled([engine.close(), runtime.close(), session?.abort(), ...[...children.keys()].map((child) => child.abort())])
      try {
        // 在途创建会在下一个边界看到 closed，并自行释放迟到的 session。
        await Promise.allSettled([...starting])
        for (const result of await stopped) if (result.status === "rejected") throw result.reason
      } finally {
        await Promise.allSettled([...children.values()])
        for (const child of children.keys()) child.dispose()
        children.clear()
        waitingCalls.clear()
        parked = undefined
        session?.dispose()
      }
    })().then(resolveClose, rejectClose)
    return closing
  }
}
