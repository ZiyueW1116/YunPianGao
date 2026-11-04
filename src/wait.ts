import { randomUUID } from "node:crypto"

export type TaskStatus = "working" | "input_required" | "succeeded" | "failed" | "cancelled"
/** 包括 result 与 intervention 在内的载荷须可由 structuredClone 复制。 */
export interface TaskSnapshot {
  status: TaskStatus
  result?: unknown
  error?: string
  intervention?: unknown
  /** 执行源报告的终态时间，使用 Unix 毫秒。 */
  finishedAt?: number
}
export interface TaskHandle {
  id: string
  kind: "process" | "subagent"
  sessionID: string
  executionID: string
}
export interface TaskSource {
  read(signal: AbortSignal): Promise<TaskSnapshot>
  /** 事件用于及时复核；read 也用于断线期间的运行时查询。 */
  subscribe?(changed: () => void): () => void
  cancel(signal: AbortSignal): Promise<void>
}
export type ResumeReason = Exclude<TaskStatus, "working"> | "timeout" | "user_input" | "interrupted" | "closed"
export interface WaitRecord {
  id: string
  sessionID: string
  handle: TaskHandle
  createdAt: number
  deadline: number
  state: "waiting" | "ready" | "delivered" | "discarded"
  reason?: ResumeReason
  resolvedAt?: number
  snapshot?: TaskSnapshot
}
export interface WaitPort {
  /** 宿主按 record.id 幂等接纳重试，确认无法接纳时返回 discarded。 */
  resume(record: Readonly<WaitRecord>, signal: AbortSignal): Promise<void | "discarded">
  onError?(error: unknown): void
}

type Task = { handle: TaskHandle; source: TaskSource; snapshot: TaskSnapshot; stop?: () => void; reading?: Promise<void>; dirty: boolean }
type Waiting = { record: WaitRecord; active: boolean; sending: boolean; delivery?: AbortController; timer?: ReturnType<typeof setTimeout> }

/** 进程内保存任务与等待；结束等待不调用任务的 cancel。 */
export function createWaitRuntime(port: WaitPort, options: { pollIntervalMs?: number; resumeOnInput?: boolean } = {}) {
  const interval = options.pollIntervalMs ?? 500
  if (!Number.isFinite(interval) || interval < 1) throw new TypeError("pollIntervalMs 必须是正数。")
  const tasks = new Map<string, Task>()
  const waits = new Map<string, Waiting>()
  const controller = new AbortController()
  const pending = new Set<Promise<unknown>>()
  let closed = false
  const track = <T>(promise: Promise<T>) => {
    pending.add(promise)
    void promise.finally(() => pending.delete(promise)).catch(() => {})
    return promise
  }
  const report = (error: unknown) => { if (!closed) { try { port.onError?.(error) } catch { /* 诊断不能影响等待。 */ } } }
  const lookup = (sessionID: string, id: string) => {
    const task = tasks.get(id)
    if (!task || task.handle.sessionID !== sessionID) throw new Error("任务 handle 不存在或不属于当前 session。")
    return task
  }
  const terminal = (snapshot: TaskSnapshot) => ["succeeded", "failed", "cancelled"].includes(snapshot.status)
  const copy = <T>(value: T): T => structuredClone(value)

  const confirmDelivery = (waitID: string, outcome: "delivered" | "discarded") => {
    const wait = waits.get(waitID)
    if (wait?.sending && wait.record.state === "ready") wait.record.state = outcome
  }
  const deliver = (wait: Waiting) => {
    if (closed || !wait.active || wait.sending || wait.record.state !== "ready") return
    if (wait.record.reason === "interrupted" || (wait.record.reason === "user_input" && !options.resumeOnInput)) {
      wait.record.state = "delivered"
      return
    }
    wait.sending = true
    const delivery = new AbortController()
    wait.delivery = delivery
    track(Promise.resolve().then(() => {
      const signal = AbortSignal.any([controller.signal, delivery.signal])
      signal.throwIfAborted()
      return port.resume(copy(wait.record), signal)
    }).then((outcome) => {
      confirmDelivery(wait.record.id, outcome === "discarded" ? outcome : "delivered")
    }).catch((error) => { if (wait.record.state === "ready") report(error) }).finally(() => {
      wait.delivery = undefined
      wait.sending = false
      if (!closed && wait.record.state === "ready") wait.timer = setTimeout(() => deliver(wait), interval)
    }))
  }
  const settle = (wait: Waiting, reason: ResumeReason, snapshot?: TaskSnapshot) => {
    if (wait.record.state !== "waiting") return
    if (wait.timer) clearTimeout(wait.timer)
    Object.assign(wait.record, { state: "ready", reason, resolvedAt: Date.now(), snapshot: copy(snapshot) })
    deliver(wait)
  }
  const observe = (task: Task, snapshot: TaskSnapshot) => {
    if (closed || terminal(task.snapshot)) return
    const previous = task.snapshot
    task.snapshot = copy(snapshot)
    if (snapshot.status === "working") return
    const observedAt = Date.now()
    const outcomeAt = terminal(snapshot) ? snapshot.finishedAt ?? observedAt : observedAt
    for (const wait of waits.values()) {
      if (wait.record.handle.id !== task.handle.id) continue
      if (outcomeAt >= wait.record.deadline) settle(wait, "timeout", previous)
      else settle(wait, snapshot.status, snapshot)
    }
  }
  const refresh = (task: Task): Promise<void> => {
    task.dirty = true
    if (task.reading) return task.reading
    task.reading = track((async () => {
      while (!closed && task.dirty && !terminal(task.snapshot)) {
        task.dirty = false
        observe(task, await task.source.read(controller.signal))
      }
    })().catch(report).finally(() => { task.reading = undefined }))
    return task.reading
  }
  const tick = (wait: Waiting) => {
    if (closed || wait.record.state !== "waiting") return
    if (Date.now() >= wait.record.deadline) { settle(wait, "timeout", tasks.get(wait.record.handle.id)?.snapshot); return }
    void refresh(tasks.get(wait.record.handle.id)!)
    wait.timer = setTimeout(() => tick(wait), Math.min(interval, wait.record.deadline - Date.now()))
  }
  const endSessionWait = (sessionID: string, reason: "user_input" | "interrupted") => {
    for (const wait of waits.values()) if (wait.record.sessionID === sessionID) settle(wait, reason, tasks.get(wait.record.handle.id)?.snapshot)
  }

  const prepareTask = (sessionID: string, kind: TaskHandle["kind"], executionID: string, source: TaskSource) => {
    if (closed) throw new Error("等待 runtime 已关闭。")
    const handle = { id: `ypg_${randomUUID()}`, kind, sessionID, executionID }
    return {
      handle: copy(handle),
      publish() {
        if (closed) throw new Error("等待 runtime 已关闭。")
        if (tasks.has(handle.id)) return
        const task: Task = { handle, source, snapshot: { status: "working" }, dirty: false }
        tasks.set(handle.id, task)
        task.stop = source.subscribe?.(() => { void refresh(task) })
        void refresh(task)
      },
    }
  }
  return {
    /** 预留执行身份，宿主接纳工具结果后再使 handle 可查询和等待。 */
    prepareTask,
    register(sessionID: string, kind: TaskHandle["kind"], executionID: string, source: TaskSource): TaskHandle {
      const task = prepareTask(sessionID, kind, executionID, source)
      task.publish()
      return task.handle
    },
    begin(sessionID: string, handleID: string, timeoutMs: number): WaitRecord {
      if (closed) throw new Error("等待 runtime 已关闭。")
      if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || !Number.isSafeInteger(Date.now() + timeoutMs))
        throw new TypeError("timeoutMs 必须是非负有限数，且期限不超过安全整数范围。")
      const task = lookup(sessionID, handleID)
      endSessionWait(sessionID, "interrupted")
      const now = Date.now()
      const wait: Waiting = { record: { id: `ypgw_${randomUUID()}`, sessionID, handle: task.handle, createdAt: now, deadline: now + timeoutMs, state: "waiting" }, active: false, sending: false }
      waits.set(wait.record.id, wait)
      if (terminal(task.snapshot)) settle(wait, task.snapshot.status as ResumeReason, task.snapshot)
      else tick(wait)
      return copy(wait.record)
    },
    /** 原工具调用可接收已结算结果时，直接交付尚未激活的等待。 */
    takeReady(waitID: string): WaitRecord | undefined {
      const wait = waits.get(waitID)
      if (closed || !wait || wait.active || wait.record.state !== "ready") return
      wait.record.state = "delivered"
      return copy(wait.record)
    },
    /** 宿主确认暂停且不再丢弃新唤醒之后激活，避免接续输入被同一次中断吞掉。 */
    activate(waitID: string) {
      const wait = waits.get(waitID)
      if (!wait || closed) return
      wait.active = true
      deliver(wait)
    },
    /** 在向外转发宿主回执前同步记录投递结果，防止重入关闭覆盖已确认状态。 */
    confirmDelivery,
    onInput(sessionID: string) { endSessionWait(sessionID, "user_input") },
    onInterrupt(sessionID: string) { endSessionWait(sessionID, "interrupted") },
    /** 停止已注册等待与本地投递；指定 waitID 时只收尾该次等待，不取消任务。 */
    stopWaits(sessionID: string, waitID?: string, outcome: "delivered" | "discarded" = "delivered") {
      for (const wait of waits.values()) {
        if (wait.record.sessionID !== sessionID || (waitID && wait.record.id !== waitID)) continue
        if (wait.timer) clearTimeout(wait.timer)
        const undelivered = wait.record.state === "waiting" || wait.record.state === "ready"
        settle(wait, "interrupted")
        if (undelivered) wait.record.state = outcome
        wait.delivery?.abort()
      }
    },
    async cancel(sessionID: string, handleID: string) {
      if (closed) throw new Error("等待 runtime 已关闭。")
      const task = lookup(sessionID, handleID)
      if (terminal(task.snapshot)) return
      await track(Promise.resolve().then(() => task.source.cancel(controller.signal)))
      await refresh(task)
    },
    async refresh(handleID?: string) {
      await Promise.all([...tasks.values()].filter((task) => handleID === undefined || task.handle.id === handleID).map(refresh))
    },
    snapshot(sessionID: string) {
      return copy({ tasks: [...tasks.values()].filter((task) => task.handle.sessionID === sessionID).map(({ handle, snapshot }) => ({ handle, ...snapshot })), waits: [...waits.values()].filter((wait) => wait.record.sessionID === sessionID).map((wait) => wait.record) })
    },
    async close() {
      closed = true
      controller.abort()
      for (const task of tasks.values()) task.stop?.()
      for (const wait of waits.values()) {
        if (wait.timer) clearTimeout(wait.timer)
        settle(wait, "closed")
      }
      await Promise.allSettled([...pending])
    },
  }
}
