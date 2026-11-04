import { createHash, randomUUID } from "node:crypto"
import { Context } from "@deepseek-ai/cordis"
import z from "@deepseek-ai/schemastery"
import { BasicCompactionEngine, type BasicCompactionConfig, type SummarizationInput, type SummaryResult } from "@deepseek-ai/dsh-compaction-basic"
import type { Agent } from "@deepseek-ai/dsh-agent"
import { createUserMessage, freezeMessage, MessageId } from "@deepseek-ai/dsh-llm"
import { defineTool, type ToolDefinition } from "@deepseek-ai/dsh-tools"
import type { SubagentActivation } from "@deepseek-ai/dsh-subagent"
import type {} from "@deepseek-ai/dsh-subprocess"
import type {} from "@deepseek-ai/dsh-sandbox"
import type {} from "@deepseek-ai/dsh-sandbox-policy"
import type {} from "@deepseek-ai/dsh-working-directory"
import { createYunPianGao, type Options } from "../scheduler.js"
import { createWaitRuntime, type TaskSnapshot } from "../wait.js"

declare module "@deepseek-ai/dsh-llm" {
  interface MessageSourceMap {
    yunpiangao: { kind: "yunpiangao"; form: "snapshot" | "notice"; summary?: string; sections?: readonly { name: string; text: string }[] }
  }
}

export interface DeepSeekConfig extends BasicCompactionConfig {
  thresholdTokens?: number
  idleDelayMs?: number
  pollIntervalMs?: number
  graceMs?: number
  subagentProvider?: string
}
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
const json = (value: unknown) => JSON.parse(JSON.stringify(value))
const output = { schema: { type: "json" as const }, render: (_args: unknown, value: unknown) => [{ type: "text" as const, text: JSON.stringify(value) }] }
type Adapter = ReturnType<typeof attachAgent>

/** 替换原生 compaction-basic 行；拥有根 Agent 的适配实例，子 Agent 使用宿主 activation。 */
export class DeepSeekCompactionEngine extends BasicCompactionEngine {
  static inject = [...BasicCompactionEngine.inject, "tools", "subprocess", "subagents", "sandbox", "sandboxPolicy", "workingDirectory"]
  static Config: z<DeepSeekConfig> = z.intersect([BasicCompactionEngine.Config, z.object({
    thresholdTokens: z.number().min(1).default(100000),
    idleDelayMs: z.number().min(0).default(1500),
    pollIntervalMs: z.number().min(1).default(500),
    graceMs: z.number().min(1).max(2147483647).default(1000),
    subagentProvider: z.string().default("spawn"),
  })])
  private readonly adapters = new WeakMap<Agent, Adapter>()
  private readonly live = new Set<Adapter>()
  private closing?: Promise<void>

  constructor(ctx: Context, config: DeepSeekConfig = {}) {
    if (typeof BasicCompactionEngine.prototype.prepareSummary !== "function") throw new Error("请先为 DeepSeek 0.2.2-alpha.3 安装云片糕摘要补丁。")
    const { thresholdTokens: _threshold, idleDelayMs: _idle, pollIntervalMs: _poll, graceMs: _grace, subagentProvider: _provider, ...nativeConfig } = config
    super(ctx, nativeConfig)
    ctx.on("agent/created", ({ agent }) => {
      if (this.closing || agent.session.header.origin === "subagent") return
      const adapter = attachAgent(agent, this, config, ctx)
      this.adapters.set(agent, adapter)
      this.live.add(adapter)
      return undefined
    })
    ctx.on("agent/disposed", ({ agent }) => {
      const adapter = this.adapters.get(agent)
      if (adapter) { this.live.delete(adapter); return adapter.close() }
    })
    ctx.effect(() => () => this.close())
  }

  /** 获取具体 Agent 的进程内状态；已关闭实例仍可读取快照。 */
  forAgent(agent: Agent) { return this.adapters.get(agent) }

  protected override summarize(input: SummarizationInput, agent: Agent, signal?: AbortSignal): Promise<SummaryResult> {
    const cached = this.adapters.get(agent)?.summaryForCommit(input)
    return cached ? Promise.resolve(cached) : super.summarize(input, agent, signal)
  }

  protected override beforeCommit(input: SummarizationInput, agent: Agent) {
    this.adapters.get(agent)?.validateCommit(input)
  }

  /** 只生成原生完整结果，不登记为主会话输入或占用维护锁。 */
  generatePrepared(agent: Agent, signal: AbortSignal) { return super.prepareSummary(agent, signal) }

  /** 关闭所有适配实例；重复与同步重入调用共用一次清理。 */
  close(): Promise<void> {
    if (this.closing) return this.closing
    let resolveClose!: () => void, rejectClose!: (reason: unknown) => void
    this.closing = new Promise<void>((resolve, reject) => { resolveClose = resolve; rejectClose = reject })
    void Promise.allSettled([...this.live].map((adapter) => adapter.close())).then((results) => {
      const failure = results.find((result) => result.status === "rejected")
      if (failure?.status === "rejected") rejectClose(failure.reason)
      else resolveClose()
    })
    return this.closing
  }
}

function attachAgent(agent: Agent, compaction: DeepSeekCompactionEngine, config: DeepSeekConfig, services: Context) {
  const ctx = agent.ctx, id = agent.id, lifetime = new AbortController()
  let closed = false, closing: Promise<void> | undefined, epoch = 0, modelEpoch = 0
  let parked: string | undefined, parkedCall: string | undefined, compacting: Promise<unknown> | undefined
  let prepared: { result: SummaryResult; fingerprint: string } | undefined
  let submitting = false
  const starting = new Set<Promise<unknown>>()
  const children = new Map<SubagentActivation, Promise<void>>()
  const disposers: (() => unknown)[] = []
  const requireOpen = (signal?: AbortSignal) => {
    if (closed) throw new Error("DeepSeek 适配实例已关闭，请创建新 Agent。")
    signal?.throwIfAborted()
  }
  const report = () => { if (!closed) ctx.logger.warn("云片糕操作未完成；请检查当前 Agent 的任务与压缩状态。") }
  const dependencies = () => {
    const state = runtime.snapshot(id)
    return { tasks: state.tasks.map(({ handle, status, finishedAt }) => ({ handle, status, finishedAt })), waits: state.waits.map(({ snapshot: _snapshot, ...record }) => record) }
  }
  const fingerprint = (input: SummarizationInput) => digest([epoch, agent.model.current(), agent.session.requestHeader(), input, agent.session.surface.nodes, dependencies()])
  const message = (text: string, messageId: string = randomUUID()) => freezeMessage({ ...createUserMessage({ content: [{ type: "text", text }], source: { kind: "yunpiangao" as const, form: "notice" as const, summary: "云片糕任务状态" } }), id: MessageId(messageId) })
  const runtime = createWaitRuntime({
    async resume(record, signal) {
      requireOpen(signal)
      // maintenance 期间 send 会保留输入，按原生顺序在提交后驱动；无需推断 idle。
      const accepted = () => agent.session.snapshotEvents().some((event) => event.type === "agent/inbox/spliced" && event.data.inserted.some((item) => item.id === record.id))
      if (accepted()) return
      try { agent.followup(message(JSON.stringify(record), record.id)) }
      catch (error) { if (!accepted()) throw error }
    }, onError: report,
  }, { pollIntervalMs: config.pollIntervalMs })
  type PendingStart = ReturnType<typeof runtime.prepareTask> & { stop(): Promise<void> }
  // 宿主可屏蔽或改写工具结果，执行仅在外层结果提交后发布。
  const pendingStarts = new Map<string, PendingStart[]>()
  const stageStart = (callID: string, task: ReturnType<typeof runtime.prepareTask>, stop: PendingStart["stop"]) => {
    const pending = pendingStarts.get(callID) ?? []
    pending.push({ ...task, stop })
    pendingStarts.set(callID, pending)
    return json({ handle: task.handle })
  }
  const stopStart = (task: PendingStart) => {
    const stopping = task.stop()
    starting.add(stopping)
    void stopping.catch(report).finally(() => starting.delete(stopping))
  }
  const engine = createYunPianGao({
    async latestCompleted() {
      if (agent.status !== "idle") return
      const events = agent.session.snapshotEvents()
      const end = events.findLast((event) => event.type === "turn/end")
      if (end?.type !== "turn/end" || end.data.reason.kind !== "completed") return
      const last = events.findLast((event) => event.type === "assistant/message" || event.type === "compaction/summary")
      if (last?.type !== "assistant/message" || last.data.turn !== end.data.turn || last.data.message.content.some((block) => block.type === "tool-call")) return
      const usage = last.data.usage
      return { messageID: last.data.message.id, tokens: usage ? usage.inputTokens + usage.outputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0) : 0 }
    },
    async prepare(_id, _source, signal) {
      prepared = undefined
      const generation = epoch
      const state = digest([agent.model.current(), agent.session.requestHeader(), agent.session.surface.nodes, dependencies()])
      const native = await compaction.generatePrepared(agent, signal)
      if (!native || generation !== epoch || state !== digest([agent.model.current(), agent.session.requestHeader(), agent.session.surface.nodes, dependencies()])) throw new Error("摘要生成期间上下文变化，本次结果已失效。")
      const signature = fingerprint(native.input)
      prepared = { result: native.result, fingerprint: signature }
      return { text: JSON.stringify(native.result.summary), fingerprint: signature }
    },
    async compact(_id, _source, signal) {
      requireOpen(signal)
      submitting = true
      try {
        compacting = compaction.compactNow(agent, signal)
        await compacting
      } finally { compacting = undefined; submitting = false; prepared = undefined }
    },
    async wait() {}, onError: report,
  }, { thresholdTokens: config.thresholdTokens, idleDelayMs: config.idleDelayMs } satisfies Options)

  const register = (tool: ToolDefinition) => { disposers.push(ctx.tools.register(tool)) }
  register(defineTool({
    name: "start_process", description: "启动后台进程，返回本次执行的 handle。command 与 args 不经过 shell，沿用宿主执行策略；需要结果时使用 wait_for，不要长 sleep 或反复查询。",
    parameters: { command: { type: "string", required: true }, args: { type: "array", items: { type: "string" }, required: true } }, output,
    async execute(input, exec) {
      requireOpen(exec.signal)
      const creation = (async () => {
        const signal = AbortSignal.any([exec.signal, lifetime.signal])
        const cwd = await services.workingDirectory.ensure(agent, signal)
        const command = await services.subprocess.resolveExecutable(input.command, undefined, signal)
        const policy = services.sandboxPolicy.resolve({ session: agent.session })
        const argv = [command, ...input.args]
        const launch = policy.mode === "danger-full-access" ? argv : (await services.sandbox.confine(argv, { ...policy, mode: policy.mode }, signal)).argv
        requireOpen(signal)
        const process = services.subprocess.spawn({ argv: launch, cwd, stdio: { stdin: "ignore", stdout: { maxBytes: 65536 }, stderr: { maxBytes: 65536 } }, graceMs: config.graceMs ?? 1000 })
        const stop = async () => {
          process.terminate()
          await Promise.allSettled([process.done, process.waitForExit()])
        }
        if (closed || signal.aborted) {
          await stop()
          requireOpen(signal)
        }
        let snapshot: TaskSnapshot = { status: "working" }, cancelled = false
        const listeners = new Set<() => void>()
        void process.done.then((outcome) => {
          const stdout = process.collected.stdout!.readFrom(0), stderr = process.collected.stderr!.readFrom(0)
          snapshot = { status: cancelled && outcome.signal !== null ? "cancelled" : outcome.exitCode === 0 ? "succeeded" : "failed", finishedAt: Date.now(), result: { ...outcome, stdout: stdout.text, stderr: stderr.text, truncated: stdout.lossy || stderr.lossy } }
        }, () => { snapshot = { status: "failed", finishedAt: Date.now(), error: "宿主进程执行失败。" } }).finally(() => { for (const changed of listeners) changed() })
        const task = runtime.prepareTask(id, "process", randomUUID(), { async read() { return snapshot }, subscribe(fn) { listeners.add(fn); return () => { listeners.delete(fn) } }, async cancel() { cancelled = true; process.terminate() } })
        return stageStart(exec.rootCallId, task, stop)
      })()
      starting.add(creation)
      try { return await creation } finally { starting.delete(creation) }
    },
  }))
  register(defineTool({
    name: "start_subagent", description: "通过宿主 activation 启动独立子 Agent，返回具体执行 handle；需要结果时使用 wait_for。",
    parameters: { prompt: { type: "string", required: true }, description: { type: "string", required: true } }, output,
    async execute(input, exec) {
      requireOpen(exec.signal)
      const creation = (async () => {
        const activation = await services.subagents.startActivation({ provider: config.subagentProvider ?? "spawn", label: input.description, delivery: "caller", signal: AbortSignal.any([exec.signal, lifetime.signal]), request: { parent: agent, prompt: [{ type: "text", text: input.prompt }] } })
        if (closed || exec.signal.aborted) { await activation.dispose(); requireOpen(exec.signal) }
        let snapshot: TaskSnapshot = { status: "working" }
        const listeners = new Set<() => void>()
        const completed = activation.result.then((result) => {
          snapshot = { status: result.stopReason === "completed" ? "succeeded" : result.stopReason === "aborted" ? "cancelled" : "failed", result: json(result), finishedAt: Date.now() }
        }, () => { snapshot = { status: "failed", error: "宿主子 Agent 执行失败。", finishedAt: Date.now() } }).finally(() => { for (const changed of listeners) changed(); children.delete(activation) })
        children.set(activation, completed)
        const task = runtime.prepareTask(id, "subagent", `${activation.childId}:${activation.messageId ?? randomUUID()}`, { async read() { return snapshot }, subscribe(fn) { listeners.add(fn); return () => { listeners.delete(fn) } }, async cancel() { await activation.dispose() } })
        return stageStart(exec.rootCallId, task, () => activation.dispose())
      })()
      starting.add(creation)
      try { return await creation } finally { starting.delete(creation) }
    },
  }))
  register(defineTool({
    name: "wait_for", description: "等待具体 handle，一轮一次；timeout 为秒，默认 600。正常返回后由 runtime 停放与接续。超时、新输入只结束这次等待，任务继续，同 handle 可重等；取消用 cancel_task。",
    parameters: { handle: { type: "string", required: true }, timeout: { type: "number" } }, output,
    async execute(input, exec) {
      requireOpen(exec.signal)
      const inputPending = [...agent.inbox.nextStep, ...agent.inbox.nextTurn].some((input) => input.source.kind !== "yunpiangao")
      if (modelEpoch !== epoch || inputPending) {
        if (inputPending) exec.concludeTurn()
        return { reason: "user_input" }
      }
      if (parked) throw new Error("同一轮只能注册一次等待。")
      const timeout = input.timeout ?? 600
      if (!Number.isFinite(timeout) || timeout < 0 || timeout > 2147483) throw new Error("timeout 必须在 0–2147483 秒之间。")
      const record = runtime.begin(id, input.handle, Math.ceil(timeout * 1000))
      parked = record.id
      parkedCall = exec.callId
      exec.concludeTurn()
      return json(record)
    },
  }))
  register(defineTool({
    name: "cancel_task", description: "独立取消具体执行 handle；结束一次等待不会取消任务。", parameters: { handle: { type: "string", required: true } }, output,
    async execute(input, exec) { requireOpen(exec.signal); await runtime.cancel(id, input.handle); return { handle: input.handle, cancellationRequested: true } },
  }))
  disposers.push(ctx.on("agent/inbox/inserted", ({ message }) => {
    if (closed || message.source.kind === "yunpiangao") return
    epoch++; prepared = undefined; engine.onInput(id); runtime.onInput(id)
    if (parked) { runtime.activate(parked); parked = undefined; parkedCall = undefined }
  }))
  disposers.push(ctx.on("agent/pre-step", async (_event, next) => {
    const stepEpoch = epoch
    const decision = await next()
    if (closed || decision.kind !== "enter") return decision
    modelEpoch = stepEpoch
    const state = dependencies()
    return state.tasks.length ? { ...decision, messages: [...decision.messages, message(`云片糕任务运行时状态（复核摘要中的依赖，结果可重等同一 handle 获取）：\n${JSON.stringify(state)}`)] } : decision
  }))
  disposers.push(ctx.on("agent/status", ({ status }) => {
    if (closed) return
    if (status === "running") { epoch++; prepared = undefined; engine.onExecution(id, "started") }
    else {
      if (parked) { const wait = parked; parked = undefined; parkedCall = undefined; runtime.activate(wait) }
      engine.onExecution(id, "succeeded")
    }
  }))
  const invalidate = () => { if (!closed) { epoch++; prepared = undefined; engine.onInput(id) } }
  disposers.push(ctx.on("system-prompt/change", invalidate))
  disposers.push(ctx.on("tools/change", invalidate))
  disposers.push(ctx.on("session/event", (_session, event) => {
    if (closed) return
    if (event.type === "tool/result") {
      const { toolCallId, isError, content } = event.data.message
      const pending = pendingStarts.get(toolCallId)
      if (pending) {
        pendingStarts.delete(toolCallId)
        for (const task of pending) {
          if (!isError && content.some((block) => block.type === "text" && block.text.includes(task.handle.id))) task.publish()
          else stopStart(task)
        }
      }
      if (toolCallId === parkedCall && isError) {
        runtime.stopWaits(id, parked); parked = undefined; parkedCall = undefined
      }
    }
    if (event.type === "step/end") {
      for (const tasks of pendingStarts.values()) for (const task of tasks) stopStart(task)
      pendingStarts.clear()
    }
    if (event.type === "model/selection") { epoch++; engine.onInput(id) }
    if (event.type === "turn/end" && event.data.reason.kind === "aborted") runtime.onInterrupt(id)
  }))
  ctx.effect(() => () => close())
  return {
    snapshot: () => runtime.snapshot(id),
    summaryForCommit(input: SummarizationInput) {
      if (!submitting) return
      requireOpen()
      if (!prepared || prepared.fingerprint !== fingerprint(input)) throw new Error("预备摘要已失效，保留完整历史。")
      return prepared.result
    },
    validateCommit(input: SummarizationInput) {
      if (!submitting) return
      requireOpen()
      if (!prepared || engine.takePrepared(id, fingerprint(input)) === undefined) throw new Error("预备摘要没有提交资格。")
    },
    async interrupt() { requireOpen(); runtime.onInterrupt(id); agent.cancel({ kind: "user" }); await agent.whenIdle() },
    close,
  }

  function close(): Promise<void> {
    if (closing) return closing
    closing = Promise.resolve().then(async () => {
      const stopped = Promise.allSettled([engine.close(), runtime.close(), (async () => {
        agent.cancel({ kind: "disposed" }, { keepInbox: true })
        await agent.whenIdle()
      })()])
      await stopped
      await Promise.allSettled([...starting])
      const unpublished = await Promise.allSettled([...pendingStarts.values()].flat().map((task) => task.stop()))
      pendingStarts.clear()
      const disposed = await Promise.allSettled([...children.keys()].map((child) => child.dispose()))
      await Promise.allSettled([...children.values()])
      await compacting?.catch(() => {})
      const released = await Promise.allSettled(disposers.reverse().map(async (dispose) => { await dispose() }))
      const failure = [...await stopped, ...unpublished, ...disposed, ...released].find((result) => result.status === "rejected")
      if (failure?.status === "rejected") throw failure.reason
    })
    closed = true
    prepared = undefined
    lifetime.abort()
    return closing
  }
}

export default DeepSeekCompactionEngine
