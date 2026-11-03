import { createInterface } from "node:readline"
import { createYunPianGao, type Options } from "../scheduler.js"
import { createWaitRuntime } from "../wait.js"
import { launchProcess } from "./process.js"

// 此入口只连接 OpenHands Python 宿主；业务状态仍由现有核心拥有。
const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>()
const changed = new Map<string, () => void>()
let sequence = 0, initialized = false, closed = false, sessionID: string, cwd: string
let runtime: ReturnType<typeof createWaitRuntime>, engine: ReturnType<typeof createYunPianGao>
const send = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`)
function call(method: string, params: unknown = {}, signal?: AbortSignal): Promise<any> {
  signal?.throwIfAborted()
  const id = ++sequence
  return new Promise((resolve, reject) => {
    const abort = () => { pending.delete(id); reject(new Error("OpenHands 宿主请求已取消。")) }
    pending.set(id, {
      resolve(value) { signal?.removeEventListener("abort", abort); resolve(value) },
      reject(error) { signal?.removeEventListener("abort", abort); reject(error) },
    })
    signal?.addEventListener("abort", abort, { once: true })
    send({ request: id, method, params })
  })
}
const report = () => send({ diagnostic: "云片糕宿主操作未完成；请检查当前实例状态。" })
async function dispatch(method: string, p: any) {
  if (method === "init") {
    if (initialized) throw new Error("OpenHands 核心桥接不可重复初始化。")
    sessionID = p.sessionID; cwd = p.cwd
    if (p.scheduling?.strategy === "direct") throw new Error("OpenHands 仅支持预备摘要复核提交。")
    runtime = createWaitRuntime({ resume: (record, signal) => call("resume", record, signal), onError: report }, { pollIntervalMs: p.pollIntervalMs })
    engine = createYunPianGao({
      latestCompleted: (_, signal) => call("latest", {}, signal),
      prepare: (_, source, signal) => call("prepare", source, signal),
      compact: (_, source, signal) => call("compact", source, signal),
      async wait() {}, onError: report,
    }, p.scheduling as Options)
    initialized = true
    return null
  }
  if (method === "close") {
    closed = true
    await Promise.all([engine?.close(), runtime?.close()])
    return runtime?.snapshot(sessionID) ?? { tasks: [], waits: [] }
  }
  if (!initialized) throw new Error("OpenHands 核心桥接尚未初始化。")
  if (method === "snapshot") return runtime.snapshot(sessionID)
  if (closed) throw new Error("OpenHands 核心桥接已关闭。")
  switch (method) {
    case "input": engine.onInput(sessionID); runtime.onInput(sessionID); return null
    case "execution": engine.onExecution(sessionID, p.phase); return null
    case "start_process": {
      const task = launchProcess(p.command, p.args, cwd)
      return runtime.register(sessionID, "process", task.executionID, task.source)
    }
    case "register_child": return runtime.register(sessionID, "subagent", p.executionID, {
      read: (signal) => call("read_child", p, signal),
      cancel: (signal) => call("cancel_child", p, signal),
      subscribe(fn) { changed.set(p.executionID, fn); return () => { changed.delete(p.executionID) } },
    })
    case "child_changed": changed.get(p.executionID)?.(); return null
    case "begin": return runtime.begin(sessionID, p.handle, p.timeoutMs)
    case "activate": runtime.activate(p.waitID); return null
    case "interrupt": engine.onExecution(sessionID, "interrupted"); runtime.onInterrupt(sessionID); return null
    case "stop": runtime.stopWaits(sessionID, p.waitID); return null
    case "cancel": await runtime.cancel(sessionID, p.handle); return null
    case "refresh": await runtime.refresh(p.handle); return null
    case "take_prepared": return engine.takePrepared(sessionID, p.fingerprint) ?? null
    default: throw new Error("未知的 OpenHands 核心操作。")
  }
}
const input = createInterface({ input: process.stdin, crlfDelay: Infinity })
input.on("line", (line) => {
  try {
    const frame = JSON.parse(line)
    if (frame.response !== undefined) {
      const waiter = pending.get(frame.response)
      pending.delete(frame.response)
      if (frame.error) waiter?.reject(new Error(frame.error)); else waiter?.resolve(frame.result)
    } else if (frame.request !== undefined) {
      void dispatch(frame.method, frame.params ?? {}).then(
        (result) => send({ response: frame.request, result }),
        (error) => send({ response: frame.request, error: error instanceof Error ? error.message : "核心操作失败。" }),
      )
    }
  } catch { report() }
})
input.on("close", () => {
  for (const waiter of pending.values()) waiter.reject(new Error("OpenHands 宿主连接已关闭。"))
  pending.clear()
  if (initialized) void Promise.allSettled([engine.close(), runtime.close()])
})
