import { appendFileSync } from "node:fs"
import adapter from "../../server.js"

// 只包装测试入口；真实删除事件在送达被测适配器前造成断流。
export default {
  id: "yunpiangao.synthetic-disconnect",
  async setup(ctx) {
    return adapter.setup({
      ...ctx,
      event: {
        ...ctx.event,
        async *subscribe(options) {
          for await (const event of ctx.event.subscribe(options)) {
            if (event.type === "session.deleted") throw new Error("合成断流：删除事件未送达。")
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
