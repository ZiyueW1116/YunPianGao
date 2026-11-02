import { appendFileSync } from "node:fs"
import adapter from "../../server.js"

// 只包装测试入口；指定的真实生命周期事件在送达被测适配器前造成断流。
export default {
  id: "yunpiangao.synthetic-disconnect",
  async setup(ctx) {
    const interruptions = new Map()
    const children = new Set(), gaps = new Set()
    return adapter.setup({
      ...ctx,
      event: {
        ...ctx.event,
        async *subscribe(options) {
          for await (const event of ctx.event.subscribe(options)) {
            if (event.type === "session.deleted") throw new Error("合成断流：删除事件未送达。")
            if (ctx.options.dropChildTerminalForCompaction && children.has(event.data.sessionID) && event.type.startsWith("session.execution.")) {
              const terminal = ["session.execution.succeeded", "session.execution.failed"].includes(event.type)
              if (gaps.has(event.data.sessionID)) {
                appendFileSync(ctx.options.events, JSON.stringify({ type: "yunpiangao.test.dropped-execution", sessionID: event.data.sessionID, nativeType: event.type }) + "\n")
                if (terminal) { gaps.delete(event.data.sessionID); throw new Error("合成断流：控制项完成前的执行通知未送达。") }
                continue
              }
              if (terminal) {
                gaps.add(event.data.sessionID)
                appendFileSync(ctx.options.events, JSON.stringify({ type: "yunpiangao.test.dropped-execution", sessionID: event.data.sessionID, nativeType: event.type }) + "\n")
                continue
              }
            }
            if (ctx.options.dropSecondInterrupt && event.type === "session.execution.interrupted") {
              const sessionID = event.data.sessionID
              const count = (interruptions.get(sessionID) ?? 0) + 1
              interruptions.set(sessionID, count)
              if (count === 2) {
                appendFileSync(ctx.options.events, JSON.stringify({ type: "yunpiangao.test.dropped-interrupt", sessionID }) + "\n")
                throw new Error("合成断流：第二次中断事件未送达。")
              }
            }
            yield event
          }
        },
      },
      session: {
        ...ctx.session,
        async create(input, options) {
          const session = await ctx.session.create(input, options)
          children.add(session.id)
          return session
        },
        async get(input, options) {
          try {
            const session = await ctx.session.get(input, options)
            if (ctx.options.dropSecondInterrupt && (interruptions.get(input.sessionID) ?? 0) >= 2)
              appendFileSync(ctx.options.events, JSON.stringify({ type: "yunpiangao.test.interrupted-session", sessionID: input.sessionID, outcome: session.outcome, idle: session.time.idle }) + "\n")
            return session
          }
          catch (error) {
            if (error?._tag === "Session.NotFoundError" && error.sessionID === input.sessionID)
              appendFileSync(ctx.options.events, JSON.stringify({ type: "yunpiangao.test.missing-session", sessionID: input.sessionID }) + "\n")
            throw error
          }
        },
      },
    })
  },
}
