import { createHash } from "node:crypto"
import type { Plugin } from "@opencode/plugin"
import type { SessionRequest } from "@opencode/plugin/promise/session"
import { createYunPianGao, type Options } from "../scheduler.js"
import { setupWaitTools } from "./opencode-wait.js"

const headings = ["## Objective", "## Requirements", "## Decisions", "## Work State", "## Next Move", "## Relevant Files", "## Important Context"]
const summaryPrompt = `请把以上对话整理为供后续 agent 继续工作的摘要。保留用户目标、要求、已作决定、完成事项、未完成事项和关键标识；后续消息优先于旧信息。保留精确路径和错误信息，区分已验证事实与推测。不要继续任务，不要调用工具。只返回摘要，完整使用以下标题：\n${headings.join("\n")}`
const fingerprint = (event: Pick<SessionRequest, "model" | "system" | "messages">) =>
  createHash("sha256").update(JSON.stringify([event.model, event.system, event.messages])).digest("hex")

type SessionID = Parameters<Plugin.Context["session"]["get"]>[0]["sessionID"]
type CompactionID = NonNullable<Parameters<Plugin.Context["session"]["compact"]>[0]["id"]>

const adapter: Plugin.Plugin = {
  id: "yunpiangao.opencode",
  async setup(ctx) {
    const preparing = new Map<string, { marker: string; fingerprint?: string }>()
    const registrations: Array<{ dispose(): Promise<void> }> = []
    const eventController = new AbortController()
    const nativeID = (sessionID: string, messageID: string) =>
      `msg_yunpiangao_${createHash("sha256").update(`${sessionID}:${messageID}`).digest("hex").slice(0, 24)}` as CompactionID
    const engine = createYunPianGao({
      async latestCompleted(sessionID, signal) {
        const id = sessionID as SessionID
        const session = await ctx.session.get({ sessionID: id }, { signal })
        if (session.parentID || session.outcome !== "succeeded" || session.location.directory !== ctx.location.directory) return
        const messages = await ctx.session.context({ sessionID: id }, { signal })
        const last = messages.findLast((message) => message.type === "assistant" || message.type === "compaction")
        if (last?.type !== "assistant" || last.finish !== "stop" || !last.tokens || !last.time.completed) return
        return { messageID: last.id, tokens: last.tokens.input + last.tokens.cache.read + last.tokens.cache.write + last.tokens.output }
      },
      async prepare(sessionID, source, signal) {
        const job = { marker: `YUNPIANGAO_PREPARE_${nativeID(sessionID, source.messageID)}` } as { marker: string; fingerprint?: string }
        preparing.set(sessionID, job)
        try {
          const generated = await ctx.session.generate({ sessionID: sessionID as SessionID, prompt: job.marker }, { signal })
          if (!job.fingerprint || !headings.every((heading) => generated.text.split("\n").some((line) => line.trim() === heading)))
            throw new Error("摘要格式或上下文指纹不完整，保留完整历史。")
          return { text: generated.text, fingerprint: job.fingerprint }
        } finally { preparing.delete(sessionID) }
      },
      async compact(sessionID, source, signal) {
        await ctx.session.compact({ sessionID: sessionID as SessionID, id: nativeID(sessionID, source.messageID), delivery: "queue" }, { signal })
      },
      async wait(sessionID, signal) { await ctx.session.wait({ sessionID: sessionID as SessionID }, { signal }) },
      onError() { console.warn("云片糕（YunPianGao）本次空闲压缩未完成；请在原会话中检查状态，完整历史不会由插件直接改写。") },
    }, ctx.options as Options)

    let watching: Promise<void> = Promise.resolve()
    let waiting: Awaited<ReturnType<typeof setupWaitTools>> | undefined
    const close = async () => {
      eventController.abort()
      await waiting?.close()
      await engine.close()
      await watching
      for (const registration of registrations.reverse()) await registration.dispose()
      preparing.clear()
    }
    try {
      registrations.push(await ctx.session.hook("prompt", (event) => {
        engine.onInput(event.sessionID)
        waiting?.onInput(event.sessionID)
      }))
      registrations.push(await ctx.session.hook("generate", (event) => {
        const job = preparing.get(event.sessionID)
        const last = event.messages.at(-1)
        if (!job || !last?.content.some((part) => part.type === "text" && part.text === job.marker)) return
        job.fingerprint = fingerprint({ ...event, messages: event.messages.slice(0, -1) })
        event.messages[event.messages.length - 1] = { role: "user", content: [{ type: "text", text: summaryPrompt }] }
        event.tools = {}
        event.options.maxTokens = 4096
      }))
      registrations.push(await ctx.session.hook("compaction", (event) => {
        const summary = engine.takePrepared(event.sessionID, fingerprint(event))
        if (summary !== undefined) event.result = { summary }
      }))
      waiting = await setupWaitTools(ctx)
      watching = (async () => {
        while (!eventController.signal.aborted) {
          try {
            for await (const event of ctx.event.subscribe({ signal: eventController.signal })) {
              waiting.onEvent(event)
              if (event.type === "session.execution.started") engine.onExecution(event.data.sessionID, "started")
              else if (event.type === "session.execution.succeeded") engine.onExecution(event.data.sessionID, "succeeded")
              else if (event.type === "session.execution.failed") engine.onExecution(event.data.sessionID, "failed")
              else if (event.type === "session.execution.interrupted") engine.onExecution(event.data.sessionID, "interrupted")
            }
          } catch { /* 等待任务由查询继续复核，随后重连事件流。 */ }
          if (eventController.signal.aborted) return
          await engine.close()
          console.warn("云片糕（YunPianGao）事件订阅中断；空闲压缩已停止，任务等待继续复核并重连。")
          await waiting.reconcile()
          await new Promise<void>((resolve) => {
            const done = () => { clearTimeout(timer); eventController.signal.removeEventListener("abort", done); resolve() }
            const timer = setTimeout(done, 500)
            eventController.signal.addEventListener("abort", done, { once: true })
          })
        }
      })()
      return close
    } catch (error) {
      await close()
      throw error
    }
  },
}

export default adapter
