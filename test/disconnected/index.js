import { appendFileSync } from "node:fs"
import adapter from "../../server.js"

// 只包装测试入口；指定的真实生命周期事件在送达被测适配器前造成断流。
export default {
  id: "yunpiangao.synthetic-disconnect",
  async setup(ctx) {
    const interruptions = new Map()
    return adapter.setup({
      ...ctx,
      event: {
        ...ctx.event,
        async *subscribe(options) {
          for await (const event of ctx.event.subscribe(options)) {
            if (event.type === "session.deleted") throw new Error("合成断流：删除事件未送达。")
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
        async get(input, options) {
          try { return await ctx.session.get(input, options) }
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
