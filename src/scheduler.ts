export interface CompletedSource {
  messageID: string
  tokens: number
}

export interface PreparedSummary {
  text: string
  fingerprint: string
}

export interface CompactionPort {
  latestCompleted(sessionID: string, signal: AbortSignal): Promise<CompletedSource | undefined>
  /** 生成临时摘要，不增加用户消息、不持有主执行循环的锁。 */
  prepare(sessionID: string, source: CompletedSource, signal: AbortSignal): Promise<PreparedSummary>
  /** 入队后，在原生持久化边界调用 takePrepared，复核提交资格与当前上下文指纹。 */
  compact(sessionID: string, source: CompletedSource, signal: AbortSignal): Promise<void>
  wait(sessionID: string, signal: AbortSignal): Promise<void>
  onError?(error: unknown): void
}

export interface Options {
  thresholdTokens?: number
  idleDelayMs?: number
  strategy?: "prepare-then-commit" | "direct"
}

export type ExecutionPhase = "started" | "succeeded" | "failed" | "interrupted"
type State = { epoch: number; idle: boolean; timer?: ReturnType<typeof setTimeout> }
type Job = { prepared?: PreparedSummary; committing: boolean }

export class StaleSummaryError extends Error {
  constructor() {
    super("待提交摘要与当前上下文不一致；本次压缩取消，保留完整历史。")
    this.name = "StaleSummaryError"
  }
}

function positive(value: unknown, fallback: number, name: string, allowZero = false) {
  const selected = value ?? fallback
  if (typeof selected !== "number" || !Number.isFinite(selected) || selected < (allowZero ? 0 : 1))
    throw new TypeError(`${name} 必须是${allowZero ? "非负" : "正"}数。`)
  return selected
}

export function createYunPianGao(port: CompactionPort, options: Options = {}) {
  const threshold = positive(options.thresholdTokens, 100_000, "thresholdTokens")
  const delay = positive(options.idleDelayMs, 1_500, "idleDelayMs", true)
  const strategy = options.strategy ?? "prepare-then-commit"
  if (strategy !== "prepare-then-commit" && strategy !== "direct") throw new TypeError("strategy 不受支持。")
  const controller = new AbortController()
  const states = new Map<string, State>()
  const jobs = new Map<string, Job>()
  const pending = new Set<Promise<void>>()
  let closed = false

  const current = (sessionID: string, epoch: number) => {
    const state = states.get(sessionID)
    return !closed && state?.idle === true && state.epoch === epoch
  }
  const report = (error: unknown) => {
    if (closed) return
    try { port.onError?.(error) } catch { /* 诊断输出不能改变压缩状态。 */ }
  }

  const schedule = (sessionID: string, state: State) => {
    if (state.timer) clearTimeout(state.timer)
    const epoch = state.epoch
    state.timer = setTimeout(() => {
      state.timer = undefined
      const task = compactIfIdle(sessionID, epoch).catch(report)
      pending.add(task)
      void task.finally(() => pending.delete(task))
    }, delay)
  }

  const compactIfIdle = async (sessionID: string, epoch: number) => {
    if (!current(sessionID, epoch)) return
    const source = await port.latestCompleted(sessionID, controller.signal)
    if (!source || !current(sessionID, epoch) || source.tokens < threshold) return
    if (strategy === "direct") {
      await port.compact(sessionID, source, controller.signal)
      return
    }
    if (jobs.has(sessionID)) return
    const job: Job = { committing: false }
    jobs.set(sessionID, job)
    try {
      const prepared = await port.prepare(sessionID, source, controller.signal)
      if (!current(sessionID, epoch) || !prepared.text.trim()) return
      job.prepared = prepared
      job.committing = true
      await port.compact(sessionID, source, controller.signal)
      // 入队确认不等于控制项执行结束；复核回调消费摘要前不能释放它。
      await port.wait(sessionID, controller.signal)
    } finally {
      jobs.delete(sessionID)
      const state = states.get(sessionID)
      if (!closed && state?.idle && state.epoch !== epoch) schedule(sessionID, state)
    }
  }

  return {
    onInput(sessionID: string) {
      if (closed) return
      const state = states.get(sessionID)
      if (!state) return
      state.epoch += 1
      state.idle = false
      if (state.timer) clearTimeout(state.timer)
      const job = jobs.get(sessionID)
      // 保留提交标记，让原生回调收到过期错误。
      if (job?.committing) job.prepared = undefined
    },
    onExecution(sessionID: string, phase: ExecutionPhase) {
      if (closed) return
      const state = states.get(sessionID) ?? { epoch: 0, idle: false }
      if (state.timer) clearTimeout(state.timer)
      state.epoch += 1
      state.idle = phase === "succeeded"
      states.set(sessionID, state)
      if (state.idle) schedule(sessionID, state)
    },
    takePrepared(sessionID: string, fingerprint: string) {
      const job = jobs.get(sessionID)
      if (!job?.committing) return undefined
      job.committing = false
      if (!job.prepared || job.prepared.fingerprint !== fingerprint) throw new StaleSummaryError()
      return job.prepared.text
    },
    async close() {
      closed = true
      controller.abort()
      for (const state of states.values()) if (state.timer) clearTimeout(state.timer)
      await Promise.allSettled([...pending])
      jobs.clear()
      states.clear()
    },
  }
}
