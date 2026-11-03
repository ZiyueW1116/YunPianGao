import { createInterface } from "node:readline"
import { createYunPianGao, type Options, type ExecutionPhase } from "../../scheduler.js"
import { createWaitRuntime, type TaskHandle, type TaskSnapshot } from "../../wait.js"

// 仅供 Hermes 子进程入口使用；Python 拥有宿主对象，业务状态仍由 TypeScript 核心维护。
let sequence = 0
const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; dispose(): void }>()
const send = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`)
const remote = (method: string, args: unknown, signal?: AbortSignal): Promise<any> => {
  signal?.throwIfAborted()
  const id = ++sequence
  return new Promise((resolve, reject) => {
    const abort = () => { pending.delete(id); send({ abort: id }); reject(new Error("Hermes 操作已取消。")) }
    pending.set(id, { resolve, reject, dispose: () => signal?.removeEventListener("abort", abort) })
    signal?.addEventListener("abort", abort, { once: true })
    send({ id, method, args })
  })
}
let sessionID: string, closed = false
let runtime: ReturnType<typeof createWaitRuntime>
let scheduler: ReturnType<typeof createYunPianGao>
const diagnostic = () => process.stderr.write("云片糕 Hermes 操作未完成；运行时将复核状态。\n")
const handlers: Record<string, (args: any) => any> = {
  open(args: { sessionID: string; scheduling?: Options; pollIntervalMs?: number }) {
    if (runtime) throw new Error("Hermes 核心实例已初始化。")
    if (args.scheduling?.strategy === "direct") throw new Error("Hermes 只支持提前准备并复核提交。")
    sessionID = args.sessionID
    runtime = createWaitRuntime({ resume: (record, signal) => remote("resume", record, signal), onError: diagnostic }, { pollIntervalMs: args.pollIntervalMs })
    scheduler = createYunPianGao({
      latestCompleted: (_id, signal) => remote("latestCompleted", {}, signal),
      prepare: (_id, source, signal) => remote("prepare", source, signal),
      compact: (_id, source, signal) => remote("compact", source, signal),
      async wait() {}, onError: diagnostic,
    }, args.scheduling)
  },
  input() { scheduler.onInput(sessionID); runtime.onInput(sessionID) },
  execution(args: { phase: ExecutionPhase }) { scheduler.onExecution(sessionID, args.phase) },
  register(args: { kind: TaskHandle["kind"]; executionID: string }) {
    return runtime.register(sessionID, args.kind, args.executionID, {
      read: (signal): Promise<TaskSnapshot> => remote("read", args, signal),
      cancel: (signal) => remote("cancel", args, signal),
    })
  },
  begin(args: { handle: string; timeoutMs: number }) { return runtime.begin(sessionID, args.handle, args.timeoutMs) },
  activate(args: { id: string }) { runtime.activate(args.id) },
  interrupt() { runtime.onInterrupt(sessionID) },
  cancel(args: { handle: string }) { return runtime.cancel(sessionID, args.handle) },
  refresh(args: { handle?: string }) { return runtime.refresh(args.handle) },
  snapshot() { return runtime.snapshot(sessionID) },
  takePrepared(args: { fingerprint: string }) { return scheduler.takePrepared(sessionID, args.fingerprint) },
  async close() { closed = true; await Promise.all([scheduler?.close(), runtime?.close()]) },
}
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
lines.on("line", (line) => {
  void (async () => {
    const message = JSON.parse(line)
    if ("reply" in message) {
      const call = pending.get(message.reply)
      if (!call) return
      pending.delete(message.reply); call.dispose()
      if (message.error) call.reject(new Error(message.error)); else call.resolve(message.value)
      return
    }
    try {
      if (closed && message.method !== "snapshot" && message.method !== "close") throw new Error("Hermes 核心实例已关闭。")
      const handler = handlers[message.method]
      if (!handler) throw new Error("Hermes 核心方法不存在。")
      const value = await handler(message.args ?? {})
      send({ reply: message.id, value: value ?? null })
    } catch (error) { send({ reply: message.id, error: error instanceof Error ? error.message : "Hermes 核心操作失败。" }) }
  })().catch(() => { diagnostic(); process.exitCode = 1; lines.close() })
})
lines.on("close", () => { void handlers.close({}).finally(() => { process.exitCode ??= 0 }) })
