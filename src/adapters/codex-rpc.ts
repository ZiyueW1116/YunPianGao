import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { createInterface } from "node:readline"

export class CodexRpcError extends Error {
  constructor(readonly code: number, message: string) { super(message); this.name = "CodexRpcError" }
}
export interface RpcMessage { id?: number | string; method?: string; params?: any; result?: any; error?: { code: number; message: string } }

/** 一条 stdio 连接拥有请求标识；断线后不重放工具回包或用户输入。 */
export class CodexRpc {
  private child: ChildProcessWithoutNullStreams
  private sequence = 0
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>()
  private listeners = new Set<(message: RpcMessage) => void>()
  private dead = false
  private closing?: Promise<void>
  private exited: Promise<void>
  private readonly errors: string[] = []

  constructor(binary: string, cwd: string, env: NodeJS.ProcessEnv) {
    this.child = spawn(binary, ["app-server"], { cwd, env, stdio: ["pipe", "pipe", "pipe"] })
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.errors.push(chunk.toString()); if (this.errors.length > 20) this.errors.shift()
    })
    const lines = createInterface({ input: this.child.stdout })
    lines.on("line", (line) => {
      let message: RpcMessage
      try { message = JSON.parse(line) } catch { this.fail(new Error("Codex app-server 返回了无效 JSON。")); return }
      if (message.id !== undefined && !message.method) {
        const pending = this.pending.get(Number(message.id))
        if (!pending) return
        this.pending.delete(Number(message.id))
        if (message.error) pending.reject(new CodexRpcError(message.error.code, message.error.message))
        else pending.resolve(message.result)
      } else {
        for (const listener of [...this.listeners]) listener(message)
      }
    })
    this.exited = new Promise((resolve) => {
      this.child.once("close", () => { lines.close(); this.fail(new Error("Codex app-server 连接已关闭。")); resolve() })
    })
    this.child.once("error", (error) => this.fail(error))
    this.child.stdin.on("error", (error) => this.fail(error))
  }

  private fail(error: Error) {
    if (this.dead) return
    this.dead = true
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
    for (const listener of [...this.listeners]) listener({ method: "connection/closed" })
  }

  private send(message: RpcMessage) {
    if (this.dead) throw new Error("Codex app-server 连接已关闭。")
    this.child.stdin.write(JSON.stringify(message) + "\n")
  }

  request(method: string, params: unknown = {}, signal?: AbortSignal): Promise<any> {
    if (this.dead) return Promise.reject(new Error("Codex app-server 连接已关闭。"))
    if (signal?.aborted) return Promise.reject(signal.reason)
    const id = ++this.sequence
    let abort: (() => void) | undefined
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      if (signal) {
        abort = () => { this.pending.delete(id); reject(signal.reason) }
        signal.addEventListener("abort", abort, { once: true })
      }
      try { this.send({ id, method, params }) }
      catch (error) { this.pending.delete(id); reject(error) }
    }).finally(() => { if (abort) signal!.removeEventListener("abort", abort) })
  }
  notify(method: string) { this.send({ method }) }
  respond(id: number | string, result: unknown) { this.send({ id, result }) }
  subscribe(listener: (message: RpcMessage) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  diagnostics() { return this.errors.join("").slice(-16_384) }

  close(): Promise<void> {
    if (this.closing) return this.closing
    // 先发布 Promise，连接关闭的同步监听器可重入 close。
    this.closing = Promise.resolve().then(async () => {
      this.child.stdin.end()
      const timer = setTimeout(() => this.child.kill("SIGTERM"), 2_000)
      const force = setTimeout(() => this.child.kill("SIGKILL"), 5_000)
      try { await this.exited } finally { clearTimeout(timer); clearTimeout(force) }
    })
    return this.closing
  }
}
