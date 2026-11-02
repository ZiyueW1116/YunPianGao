import { appendFileSync } from "node:fs"

export default {
  id: "yunpiangao.synthetic-observer",
  async setup(ctx) {
    const abort = new AbortController()
    const registrations = [
      await ctx.session.hook("title", (event) => { event.result = "YunPianGao 合成测试" }),
      await ctx.session.hook("http.request", (event) => {
        const headers = new Headers(event.request.headers)
        headers.set("x-yunpiangao-test-kind", event.kind)
        headers.set("x-yunpiangao-test-session", event.sessionID)
        event.request = new Request(event.request, { headers })
      }),
    ]
    const watching = (async () => {
      for await (const event of ctx.event.subscribe({ signal: abort.signal })) {
        if (/^session\.(execution\.|compaction\.|step\.|tool\.|inbox\.)/.test(event.type) || event.type === "permission.asked")
          appendFileSync(ctx.options.events, JSON.stringify({ type: event.type, ...event.data }) + "\n")
      }
    })().catch((error) => { if (!abort.signal.aborted) throw error })
    return async () => {
      abort.abort()
      await watching
      for (const registration of registrations) await registration.dispose()
    }
  },
}
