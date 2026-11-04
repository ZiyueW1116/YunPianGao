import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { randomUUID } from "node:crypto"
import { isAbsolute, resolve } from "node:path"
import { homedir, userInfo } from "node:os"
import { realpath, stat } from "node:fs/promises"
import { createWaitRuntime, type TaskSnapshot, type TaskSource, type WaitRecord } from "../wait.js"
import { CodexRpc, CodexRpcError, type RpcMessage } from "./codex-rpc.js"

export const CODEX_VERSION = "0.166.0"
export interface CodexSessionOptions {
  codexPath: string
  /** 专用于此集成的 CODEX_HOME；不接受用户默认目录。 */
  codexHome: string
  cwd: string
  model?: string
  modelProvider?: string
  sandbox?: "read-only" | "workspace-write" | "danger-full-access"
  approvalPolicy?: "untrusted" | "on-failure" | "on-request" | "never"
  env?: NodeJS.ProcessEnv
  threadId?: string
  pollIntervalMs?: number
  onEvent?: (message: RpcMessage) => void
  onError?: (error: unknown) => void
}
export interface CodexTurnResult { id: string; status: string; error?: unknown }
export interface CodexTurn { id: string; completed: Promise<CodexTurnResult> }
export type CodexRuntimeSnapshot = ReturnType<ReturnType<typeof createWaitRuntime>["snapshot"]>
export interface CodexSession {
  threadId: string
  snapshot(): CodexRuntimeSnapshot
  prompt(text: string): Promise<CodexTurn>
  interrupt(): Promise<void>
  compact(): Promise<CodexTurnResult>
  fork(): Promise<CodexSession>
  reload(): Promise<CodexSession>
  switchThread(id: string): Promise<CodexSession>
  respondToRequest(id: number | string, result: unknown): void
  close(): Promise<void>
}

const input = (text: string) => [{ type: "text", text, text_elements: [] }]
const output = (value: unknown, success = true) => ({ success, contentItems: [{ type: "inputText", text: JSON.stringify(value) }] })
const schema = (properties: Record<string, unknown>, required: string[]) => ({ type: "object", properties, required, additionalProperties: false })
const string = { type: "string" }
const tools = [
  { type: "function", name: "start_process", description: "在 Codex command/exec 执行策略下启动一次独立命令，返回具体执行的 handle。", inputSchema: schema({ command: string, args: { type: "array", items: string } }, ["command", "args"]) },
  { type: "function", name: "start_subagent", description: "启动一次独立 Codex thread 执行，返回本次执行的 handle；子会话不加载云片糕工具。", inputSchema: schema({ prompt: string }, ["prompt"]) },
  { type: "function", name: "wait_for", description: "等待 handle 的结果。runtime 持有本次工具回包；超时或新输入不取消任务，可再次等待同一 handle。", inputSchema: schema({ handle: string, timeout: { type: "number", minimum: 0, maximum: 2147483 } }, ["handle"]) },
  { type: "function", name: "cancel_task", description: "独立请求取消 handle 的具体执行。", inputSchema: schema({ handle: string }, ["handle"]) },
]

/** Codex 0.166.0 的实验性等待入口；不提供空闲预生成压缩或等待期压缩。 */
export async function createCodexSession(options: CodexSessionOptions): Promise<CodexSession> {
  if (![options.codexPath, options.codexHome, options.cwd].every(isAbsolute)) throw new Error("codexPath、codexHome、cwd 必须是绝对路径。")
  if (options.pollIntervalMs !== undefined && (!Number.isFinite(options.pollIntervalMs) || options.pollIntervalMs < 1)) throw new TypeError("pollIntervalMs 必须是正数。")
  const codexHome = await realpath(options.codexHome)
  const directory = await stat(codexHome, { bigint: true })
  if (!directory.isDirectory()) throw new Error("codexHome 必须是已存在的目录。")
  const env: NodeJS.ProcessEnv = { ...process.env, ...options.env, CODEX_HOME: codexHome }
  const hostHome = (process.platform === "win32" ? env.USERPROFILE : env.HOME) || userInfo().homedir
  for (const home of new Set([homedir(), hostHome])) {
    const defaults = await stat(resolve(home, ".codex"), { bigint: true }).catch((error) => {
      if (error.code !== "ENOENT") throw error
    })
    if (defaults?.dev === directory.dev && defaults.ino === directory.ino)
      throw new Error("请提供独立 codexHome，不能使用默认 Codex 配置与会话目录。")
  }
  const version = await promisify(execFile)(options.codexPath, ["--version"], { cwd: options.cwd, env, timeout: 10_000 })
  if (version.stdout.trim() !== `codex-cli ${CODEX_VERSION}`) throw new Error(`Codex 入口只验证了 ${CODEX_VERSION}；实际版本不匹配。`)
  const rpc = new CodexRpc(options.codexPath, options.cwd, env)
  let closed = false, closePromise: Promise<void> | undefined, publicClosePromise: Promise<void> | undefined, owner = "", activeTurn: string | undefined
  let replacementTask: Promise<CodexSession> | undefined, replacementCancelled = false, replacementPublished = false
  const lifetime = new AbortController()
  const inputPrefix = `ypgi_${randomUUID()}_`
  const submissions = new Set<Promise<CodexTurn>>()
  let submittedVersion = 0, acceptedVersion = 0, samplingVersion = 0, compacting = false
  let sandbox: unknown, permissions: string | undefined
  const creations = new Set<Promise<unknown>>()
  const commands = new Map<string, { source: TaskSource; finish: Promise<void>; stop: () => void }>()
  const children = new Map<string, { turnID?: string; text: string; truncated: boolean; snapshot: TaskSnapshot; changed: Set<() => void> }>()
  const interventions = new Map<number | string, string>()
  const parked = new Map<string, { id: number | string; callID: string; turnID: string; replied: boolean }>()
  const acknowledgements = new Map<string, (outcome: "delivered" | "discarded") => void>()
  const turns = new Map<string, { public: CodexTurn; resolve: (value: CodexTurnResult) => void; finished: boolean }>()
  const requireOpen = () => { if (closed) throw new Error("Codex 适配实例已关闭；请创建新实例。") }
  const completeChild = (id: string, completed: any) => {
    const state = children.get(id)
    if (!state || state.turnID !== completed.id || !["working", "input_required"].includes(state.snapshot.status) || !["completed", "failed", "interrupted"].includes(completed.status)) return
    const text = (completed.items ?? []).filter((item: any) => item.type === "agentMessage").map((item: any) => item.text).join("\n")
    if (text) {
      state.truncated ||= text.length > 65_536; state.text = text.slice(-65_536)
    }
    state.snapshot = { status: completed.status === "completed" ? "succeeded" : completed.status === "interrupted" ? "cancelled" : "failed", finishedAt: Date.now(), result: { threadId: id, turn: completed, text: state.text, truncated: state.truncated }, error: completed.error?.message }
    for (const changed of state.changed) changed()
  }
  const report = (error: unknown) => { if (!closed) { try { options.onError?.(error) } catch { /* 诊断不改变任务状态。 */ } } }
  const readTurns = async (threadId: string, signal: AbortSignal): Promise<any[]> => {
    try {
      const read = await rpc.request("thread/read", { threadId, includeTurns: true }, signal)
      return read.thread.turns
    } catch (error) {
      // 0.166.0 的分页历史在首轮落盘前可能暂不可查，事件和后续查询仍可结算。
      if (error instanceof CodexRpcError && error.code === -32601 && error.message === "list_turns is not supported yet") return []
      throw error
    }
  }
  const toolOutcome = (item: any) => {
    if (item?.type !== "dynamicToolCall" || item.tool !== "wait_for") return
    if (item.status === "completed" && item.success === true) return "delivered"
    if (item.status === "failed" || (item.status === "completed" && item.success === false)) return "discarded"
  }
  const turn = (id: string) => {
    let item = turns.get(id)
    if (!item) {
      let resolve!: (value: CodexTurnResult) => void
      const completed = new Promise<CodexTurnResult>((done) => { resolve = done })
      item = { public: { id, completed }, resolve, finished: false }; turns.set(id, item)
    }
    return item
  }
  // 原生 additionalContext 按值去重且跨 compact 保留；输入版本确保新请求重新携带实际依赖。
  const context = (inputVersion: number) => ({ yunpiangao: { kind: "untrusted", name: "yunpiangao_runtime", value: JSON.stringify({ label: "云片糕任务运行时状态", inputVersion, ...runtime.snapshot(owner) }) } })
  const acceptInput = (version: number) => {
    if (version <= acceptedVersion) return
    acceptedVersion = version
    runtime.onInput(owner)
  }
  const runtime = createWaitRuntime({
    async resume(record, signal) {
      signal.throwIfAborted(); requireOpen()
      const pending = parked.get(record.id)
      if (!pending) throw new Error("Codex 等待工具已失效，不能在其他轮次重放。")
      const key = `${pending.turnID}:${pending.callID}`
      let outcome: "delivered" | "discarded" | undefined
      let wake: (() => void) | undefined
      const confirm = (value: "delivered" | "discarded") => {
        if (outcome) return
        outcome = value
        runtime.confirmDelivery(record.id, value)
        parked.delete(record.id)
        wake?.()
      }
      acknowledgements.set(key, confirm)
      try {
        if (!pending.replied) {
          rpc.respond(pending.id, output({ wait: record, runtime: runtime.snapshot(owner) }))
          pending.replied = true
        }
        while (!outcome) {
          await new Promise<void>((done, reject) => {
            const timer = setTimeout(finish, options.pollIntervalMs ?? 500)
            const abort = () => { cleanup(); reject(signal.reason) }
            function cleanup() { clearTimeout(timer); signal.removeEventListener("abort", abort); wake = undefined }
            function finish() { cleanup(); done() }
            wake = finish
            signal.addEventListener("abort", abort, { once: true })
            if (signal.aborted) abort()
          })
          signal.throwIfAborted()
          if (outcome) break
          const turns = await readTurns(owner, signal)
          const history = turns.find((item) => item.id === pending.turnID)
          const observed = toolOutcome(history?.items?.find((item: any) => item.id === pending.callID))
          if (observed) confirm(observed)
        }
      } finally { acknowledgements.delete(key) }
    },
    onError: report,
  }, { pollIntervalMs: options.pollIntervalMs, resumeOnInput: true })

  const track = <T>(operation: () => Promise<T>) => {
    const promise = Promise.resolve().then(operation)
    creations.add(promise); void promise.finally(() => creations.delete(promise)).catch(() => {})
    return promise
  }
  const launch = (command: string, args: string[]) => {
    const processID = `ypgp_${randomUUID()}`
    let snapshot: TaskSnapshot = { status: "working" }, bytes = Buffer.alloc(0), truncated = false, cancelRequested = false
    const listeners = new Set<() => void>()
    const notify = () => { for (const changed of listeners) changed() }
    const stopOutput = rpc.subscribe((message) => {
      if (message.method !== "command/exec/outputDelta" || message.params.processId !== processID) return
      const next = Buffer.concat([bytes, Buffer.from(message.params.deltaBase64, "base64")])
      truncated ||= next.length > 65_536; bytes = next.subarray(Math.max(0, next.length - 65_536))
    })
    const finish = rpc.request("command/exec", {
      command: [command, ...args], processId: processID, cwd: options.cwd,
      streamStdoutStderr: true, disableOutputCap: true, disableTimeout: true,
      ...(permissions ? { permissionProfile: permissions } : { sandboxPolicy: sandbox }),
    }).then((result) => {
      snapshot = { status: cancelRequested && result.exitCode === 137 ? "cancelled" : result.exitCode === 0 ? "succeeded" : "failed", finishedAt: Date.now(), result: { ...result, output: bytes.toString("utf8"), truncated, cancellationRequested: cancelRequested } }
    }, (error) => { snapshot = { status: closed ? "cancelled" : "failed", finishedAt: Date.now(), error: error instanceof Error ? error.message : "Codex command/exec 执行失败或连接关闭。" } })
      .finally(() => { stopOutput(); notify() })
    const source: TaskSource = {
      async read() { return snapshot },
      subscribe(changed) { listeners.add(changed); return () => { listeners.delete(changed) } },
      async cancel(signal) {
        cancelRequested = true
        // 原生先登记 processId 再启动进程；精确的不存在回执可能早于登记或晚于退出。
        while (snapshot.status === "working") {
          signal.throwIfAborted()
          try { await rpc.request("command/exec/terminate", { processId: processID }, signal); return }
          catch (error) {
            if (!(error instanceof CodexRpcError) || !error.message.startsWith("no active command/exec for process id ")) throw error
            await Promise.race([finish, new Promise<void>((done) => setTimeout(done, 10))])
          }
        }
      },
    }
    commands.set(processID, { source, finish, stop: stopOutput })
    return runtime.register(owner, "process", processID, source)
  }

  const child = async (prompt: string) => {
    const started = await rpc.request("thread/start", {
      cwd: options.cwd, model: options.model, modelProvider: options.modelProvider,
      approvalPolicy: options.approvalPolicy, sandbox: options.sandbox,
      dynamicTools: [],
    })
    const id = started.thread.id
    const state = { snapshot: { status: "working" } as TaskSnapshot, changed: new Set<() => void>(), turnID: undefined as string | undefined, text: "", truncated: false }
    children.set(id, state)
    if (closed) { await rpc.request("thread/unsubscribe", { threadId: id }); children.delete(id); throw new Error("Codex 创建期间实例已关闭。") }
    try {
      const result = await rpc.request("turn/start", { threadId: id, input: input(prompt) })
      state.turnID = result.turn.id
      requireOpen()
      return runtime.register(owner, "subagent", `${id}:${state.turnID}`, {
        async read(signal) {
          if (["working", "input_required"].includes(state.snapshot.status)) {
            const turns = await readTurns(id, signal)
            const completed = turns.find((turn) => turn.id === state.turnID)
            // 历史投影会把尚未记录终态的 turn 标为 interrupted，且不填完成时间。
            if (completed?.completedAt != null) completeChild(id, completed)
          }
          return state.snapshot
        },
        subscribe(changed) { state.changed.add(changed); return () => { state.changed.delete(changed) } },
        async cancel(signal) {
          if (state.snapshot.status === "working" || state.snapshot.status === "input_required")
            await rpc.request("turn/interrupt", { threadId: id, turnId: state.turnID }, signal)
        },
      })
    } catch (error) {
      if (state.turnID) await rpc.request("turn/interrupt", { threadId: id, turnId: state.turnID }).catch(() => {})
      await rpc.request("thread/unsubscribe", { threadId: id }).catch(() => {})
      children.delete(id); throw error
    }
  }

  const handleTool = async (message: RpcMessage) => {
    const params = message.params, args = params.arguments
    requireOpen()
    if (params.threadId !== owner) throw new Error("工具请求不属于本实例。")
    if (!args || typeof args !== "object") throw new Error("工具参数必须是对象。")
    let value: unknown
    switch (params.tool) {
      case "start_process":
        if (typeof args.command !== "string" || !args.command || !Array.isArray(args.args) || !args.args.every((arg: unknown) => typeof arg === "string")) throw new Error("command 和 args 无效。")
        value = launch(args.command, args.args); break
      case "start_subagent":
        if (typeof args.prompt !== "string" || !args.prompt.trim()) throw new Error("prompt 不能为空。")
        value = await child(args.prompt); break
      case "cancel_task":
        await runtime.cancel(owner, args.handle); value = { handle: args.handle, requested: true }; break
      case "wait_for": {
        const timeout = args.timeout ?? 600
        if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout < 0 || timeout > 2_147_483) throw new Error("timeout 必须在 0 到 2,147,483 秒之间。")
        await Promise.allSettled([...submissions])
        requireOpen()
        if (turns.get(params.turnId)?.finished) return
        if (samplingVersion < acceptedVersion) { value = { reason: "user_input", message: "模型请求期间已有新输入，本次等待意图失效。" }; break }
        if ([...parked.values()].some((wait) => wait.turnID === params.turnId && !wait.replied)) throw new Error("同一轮只允许一次待回包等待。")
        const record = runtime.begin(owner, args.handle, timeout * 1000)
        parked.set(record.id, { id: message.id!, callID: params.callId, turnID: params.turnId, replied: false })
        runtime.activate(record.id)
        return
      }
      default: throw new Error("未知 Codex 动态工具。")
    }
    if (!closed) rpc.respond(message.id!, output(value))
  }

  const stop = rpc.subscribe((message) => {
    const params = message.params
    if (message.method === "item/tool/call") {
      void track(() => handleTool(message)).catch((error) => { if (!closed) rpc.respond(message.id!, output({ error: error instanceof Error ? error.message : "工具执行失败。" }, false)) })
    } else if (message.id !== undefined && message.method) {
      const state = children.get(params?.threadId)
      if (state && state.turnID === params.turnId && state.snapshot.status === "working") {
        interventions.set(message.id, params.threadId)
        state.snapshot = { status: "input_required", intervention: { method: message.method, requestId: message.id, params } }
        for (const changed of state.changed) changed()
      }
      // 没有授权时保留宿主请求，交由嵌入方 UI 决定；不自动批准。
    } else if (message.method === "turn/started") {
      turn(params.turn.id)
      if (params.threadId === owner) activeTurn = params.turn.id
      const state = children.get(params.threadId); if (state && !state.turnID) state.turnID = params.turn.id
    } else if (message.method === "item/completed") {
      if (params.threadId === owner) {
        const outcome = toolOutcome(params.item)
        if (outcome) acknowledgements.get(`${params.turnId}:${params.item.id}`)?.(outcome)
        if (params.item.type === "userMessage" && params.item.clientId?.startsWith(inputPrefix)) {
          const version = Number(params.item.clientId.slice(inputPrefix.length))
          samplingVersion = Math.max(samplingVersion, version)
          acceptInput(version)
        }
      }
      const state = children.get(params.threadId)
      if (state && state.turnID === params.turnId && params.item.type === "agentMessage") {
        const text = state.text + params.item.text
        state.truncated ||= text.length > 65_536; state.text = text.slice(-65_536)
      }
    } else if (message.method === "turn/completed") {
      const completed = turn(params.turn.id)
      completed.finished = true
      completed.resolve(params.turn)
      if (params.threadId === owner) {
        if (activeTurn === params.turn.id) activeTurn = undefined
        for (const [id, pending] of parked) if (pending.turnID === params.turn.id && !pending.replied) {
          runtime.stopWaits(owner, id, "discarded")
          parked.delete(id)
        }
      }
      completeChild(params.threadId, params.turn)
    } else if (message.method === "connection/closed" && !closed) { void close() }
    try { options.onEvent?.(message) } catch (error) { report(error) }
  })

  function dispose(): Promise<void> {
    if (closePromise) return closePromise
    closed = true
    closePromise = Promise.resolve().then(async () => {
      runtime.stopWaits(owner, undefined, "discarded")
      await runtime.close()
      if (activeTurn) await rpc.request("turn/interrupt", { threadId: owner, turnId: activeTurn }).catch(() => {})
      await Promise.allSettled([...creations])
      await Promise.allSettled([...children].map(async ([id, state]) => {
        if (state.turnID && ["working", "input_required"].includes(state.snapshot.status)) await rpc.request("turn/interrupt", { threadId: id, turnId: state.turnID }).catch(() => {})
        await rpc.request("thread/unsubscribe", { threadId: id }).catch(() => {})
      }))
      await Promise.allSettled([...commands.keys()].map((processId) => rpc.request("command/exec/terminate", { processId })))
      await rpc.close()
      await Promise.allSettled([...commands.values()].map((command) => command.finish))
      for (const item of turns.values()) item.resolve({ id: item.public.id, status: "interrupted" })
      stop()
    })
    lifetime.abort(new Error("Codex 适配实例已关闭。"))
    return closePromise
  }
  function close(): Promise<void> {
    if (!replacementPublished) replacementCancelled = true
    if (publicClosePromise) return publicClosePromise
    const cleanup = dispose()
    publicClosePromise = Promise.resolve().then(async () => {
      await cleanup
      if (replacementTask && !replacementPublished) await replacementTask.catch(() => {})
    })
    return publicClosePromise
  }

  try {
    await rpc.request("initialize", { clientInfo: { name: "yunpiangao", version: "0.1.0" }, capabilities: { experimentalApi: true } })
    rpc.notify("initialized")
    const started = await rpc.request(options.threadId ? "thread/resume" : "thread/start", {
      threadId: options.threadId, cwd: options.cwd, model: options.model, modelProvider: options.modelProvider,
      sandbox: options.sandbox, approvalPolicy: options.approvalPolicy,
      ...(!options.threadId ? { dynamicTools: tools } : {}),
    })
    owner = started.thread.id; sandbox = started.sandbox
    permissions = started.activePermissionProfile?.id
  } catch (error) { await close(); throw error }

  const replacement = (id: string) => {
    requireOpen()
    const cleanup = dispose()
    replacementTask = cleanup.then(async () => {
      if (replacementCancelled) throw new Error("Codex 实例替换已被 close 取消。")
      const next = await createCodexSession({ ...options, threadId: id })
      if (replacementCancelled) { await next.close(); throw new Error("Codex 实例替换已被 close 取消。") }
      replacementPublished = true
      return next
    })
    return replacementTask
  }
  return {
    threadId: owner,
    snapshot: () => runtime.snapshot(owner),
    async prompt(text: string): Promise<CodexTurn> {
      requireOpen()
      if (compacting) throw new Error("Codex 正在压缩，请在控制轮结束后保留并重交输入。")
      const version = ++submittedVersion
      const current = activeTurn
      const submission = rpc.request(current ? "turn/steer" : "turn/start", {
        threadId: owner, input: input(text), clientUserMessageId: inputPrefix + version,
        additionalContext: context(version), ...(current ? { expectedTurnId: current } : {}),
      }, lifetime.signal).then((result) => {
        requireOpen()
        const entry = turn(result.turnId ?? result.turn.id)
        if (!activeTurn && !entry.finished) activeTurn = entry.public.id
        acceptInput(version)
        return entry.public
      })
      submissions.add(submission)
      try { return await submission } finally { submissions.delete(submission) }
    },
    async interrupt() {
      requireOpen(); runtime.onInterrupt(owner)
      if (activeTurn) await rpc.request("turn/interrupt", { threadId: owner, turnId: activeTurn })
    },
    async compact() {
      requireOpen()
      if (submissions.size || activeTurn || compacting) throw new Error("Codex 有在途输入或活跃轮次。0.166.0 不支持保留待回包等待的压缩，本次请求未提交。")
      compacting = true
      try {
        // compact/start 只确认入队；实际结束由控制轮事件确认。
        let stopStarted!: () => void
        let abort!: () => void
        const started = new Promise<CodexTurn>((done, reject) => {
          abort = () => reject(lifetime.signal.reason)
          lifetime.signal.addEventListener("abort", abort, { once: true })
          stopStarted = rpc.subscribe((message) => {
            if (message.method === "turn/started" && message.params.threadId === owner) {
              stopStarted(); done(turn(message.params.turn.id).public)
            }
          })
        })
        void started.catch(() => {})
        try {
          await rpc.request("thread/compact/start", { threadId: owner })
          return await (await started).completed
        } finally { stopStarted(); lifetime.signal.removeEventListener("abort", abort) }
      } finally { compacting = false }
    },
    async fork() {
      requireOpen()
      const result = await track(() => rpc.request("thread/fork", { threadId: owner, excludeTurns: true }))
      requireOpen()
      return replacement(result.thread.id)
    },
    reload() { requireOpen(); return replacement(owner) },
    switchThread(id: string) { requireOpen(); return replacement(id) },
    /** 嵌入方明确批准后才可对 onEvent 收到的宿主请求回包。 */
    respondToRequest(id: number | string, result: unknown) {
      requireOpen(); rpc.respond(id, result)
      const childID = interventions.get(id), state = childID && children.get(childID)
      if (state && state.snapshot.status === "input_required") {
        state.snapshot = { status: "working" }; for (const changed of state.changed) changed()
      }
      interventions.delete(id)
    },
    close,
  }
}
