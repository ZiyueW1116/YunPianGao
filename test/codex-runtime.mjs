import assert from "node:assert/strict"
import { createServer } from "node:http"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { createCodexSession } from "../dist/adapters/codex.js"

export const binary = process.env.CODEX_BIN && resolve(process.env.CODEX_BIN)
export const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
export const gate = () => { let resolve; const promise = new Promise((done) => { resolve = done }); return { promise, resolve } }
export async function until(check, milliseconds = 15000) {
  const start = Date.now()
  while (!check()) { if (Date.now() - start > milliseconds) assert.fail("Codex 真实入口未在期限内到达预期状态。"); await sleep(10) }
}
export async function fixture(name) {
  const root = await mkdtemp(join(tmpdir(), "yunpiangao-codex-"))
  const cwd = join(root, "project"), codexHome = join(root, "codex")
  await mkdir(cwd); await mkdir(codexHome)
  const events = [], errors = [], requests = [], releaseChild = gate(), releaseWait = gate(), releaseSummary = gate()
  let harness, parent = 0, child = 0, summaries = 0, resumedAt
  const choose = (n, body) => {
    const texts = body.input.flatMap((item) => item.type === "function_call_output" ? typeof item.output === "string" ? [item.output] : (item.output ?? []).map((part) => part.text) : (item.content ?? []).map((part) => part.text))
    const handle = texts.map((text) => text?.match(/"id":"(ypg_[A-Za-z0-9-]+)"/)?.[1]).find(Boolean)
    const wait = (timeout = 30) => ["wait_for", { handle, timeout }]
    if (name.startsWith("summary")) return
    if (n === 1) {
      if (name.startsWith("child")) return ["start_subagent", { prompt: "CHILD_MARKER：返回合成结果。" }]
      const code = ["before", "race"].includes(name) ? 'console.log("DONE")' : name === "output" ? 'process.stdout.write("x".repeat(1200000));console.log("TAIL")' : name === "failure" ? 'process.exit(7)' : name === "sandbox" ? 'require("node:fs").writeFileSync("denied", "")' : name === "spawn-failure" ? "" :
        'const fs=require("node:fs");const t=setInterval(()=>{if(fs.existsSync("release")){clearInterval(t);fs.writeFileSync("finished", "");console.log("DONE")}},5)'
      return ["start_process", { command: name === "spawn-failure" ? join(cwd, "missing-program") : process.execPath, args: ["-e", code] }]
    }
    if (n === 2) return wait(name === "race" ? 0 : name === "timeout" ? .1 : 30)
    if (["timeout", "interrupt-rewait"].includes(name) && n === 3) return wait()
    if (["input", "child-input", "child-permission"].includes(name) && n === 4) return wait()
    if (name.endsWith("cancel") && n === 3) return ["cancel_task", { handle }]
    if (name.endsWith("cancel") && n === 4) return wait()
  }
  const server = createServer(async (req, res) => {
    try {
      let raw = ""; for await (const chunk of req) raw += chunk
      if (req.url !== "/v1/responses") { res.writeHead(404); res.end(); return }
      const body = JSON.parse(raw), text = JSON.stringify(body.input)
      const kind = text.includes("CHILD_MARKER") && !body.tools?.some((tool) => tool.name === "start_subagent") ? "child" : !body.tools?.length ? "summary" : "parent"
      requests.push({ kind, body, at: Date.now() })
      let tool
      if (kind === "child") {
        child++; await releaseChild.promise
        if (name === "child-permission" && child === 1) tool = ["exec_command", { cmd: "echo APPROVAL_FIXTURE", sandbox_permissions: "require_escalated", justification: "合成权限请求。" }]
        if (name === "child-failure") { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: { message: "合成子任务失败" } })); return }
      } else if (kind === "summary") { summaries++; if (name === "summary-close") await releaseSummary.promise }
      else { tool = choose(++parent, body); if (!tool && !name.startsWith("summary")) resumedAt = Date.now() }
      if (name === "before" && parent === 2 && kind === "parent") await until(() => harness.snapshot().tasks[0].status === "succeeded")
      if (name === "input-stream" && parent === 2 && kind === "parent") await releaseWait.promise
      const id = `fixture_${requests.length}`
      const items = [{ type: "response.created", response: { id } }]
      if (kind === "child" && name === "child") items.push({ type: "response.output_item.done", item: { type: "message", role: "assistant", phase: "commentary", id: "child_progress", content: [{ type: "output_text", text: "子任务合成进展。" }] } })
      const item = tool ? { type: "function_call", call_id: kind === "child" ? "child_approval" : `call_${parent}`, name: tool[0], arguments: JSON.stringify(tool[1]) } :
        { type: "message", role: "assistant", id: `msg_${requests.length}`, content: [{ type: "output_text", text: kind === "summary" ? "合成摘要：保留目标与精确标识。" : "合成任务已完成。" }] }
      items.push({ type: "response.output_item.done", item })
      if (name === "batch" && parent === 2 && kind === "parent") items.push({ type: "response.output_item.done", item: { type: "function_call", call_id: "extra", name: "start_process", arguments: JSON.stringify({ command: process.execPath, args: ["-e", "console.log('BATCH')"] }) } })
      items.push({ type: "response.completed", response: { id, usage: { input_tokens: 1000, input_tokens_details: null, output_tokens: 10, output_tokens_details: null, total_tokens: 1010 } } })
      if (res.destroyed) return
      res.writeHead(200, { "Content-Type": "text/event-stream" })
      res.end(items.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""))
    } catch (error) { errors.push(error); res.destroy() }
  })
  await new Promise((done) => server.listen(0, "127.0.0.1", done))
  await writeFile(join(codexHome, "config.toml"), `
model = "mock-model"
model_provider = "fixture"
approval_policy = "${name === "child-permission" ? "on-request" : "never"}"
sandbox_mode = "${name === "sandbox" ? "read-only" : "workspace-write"}"
model_auto_compact_token_limit = 999999
model_post_turn_compact_threshold_percent = 0
cli_auth_credentials_store = "file"
[skills]
include_instructions = false
[skills.bundled]
enabled = false
[analytics]
enabled = false
[otel]
exporter = "none"
metrics_exporter = "none"
[features]
shell_snapshot = false
async_compaction = false
[model_providers.fixture]
name = "合成模型替身"
base_url = "http://127.0.0.1:${server.address().port}/v1"
wire_api = "responses"
requires_openai_auth = false
request_max_retries = 0
stream_max_retries = 0
supports_websockets = false
`)
  const options = { codexPath: binary, codexHome, cwd, model: "mock-model", modelProvider: "fixture", pollIntervalMs: 20,
    env: { ...Object.fromEntries(Object.keys(process.env).filter((key) => key.startsWith("CODEX_")).map((key) => [key, undefined])), OPENAI_API_KEY: undefined },
    onEvent(message) { events.push(message) }, onError(error) { errors.push(error) } }
  try { harness = await createCodexSession(options) }
  catch (error) { server.closeAllConnections(); await new Promise((done) => server.close(done)); await rm(root, { recursive: true, force: true }); throw error }
  let closing
  return {
    ...harness, closeAdapter: harness.close, options, requests, events, errors, root, cwd, releaseChild, releaseWait, releaseSummary,
    counts: () => ({ parent, child, summaries, resumedAt }),
    replace(value) { harness = value },
    async release() { releaseChild.resolve(); await writeFile(join(cwd, "release"), "") },
    close() {
      closing ??= Promise.resolve().then(async () => {
        releaseChild.resolve(); releaseWait.resolve(); releaseSummary.resolve(); await writeFile(join(cwd, "release"), "")
        await harness.close(); server.closeAllConnections(); await new Promise((done) => server.close(done)); await rm(root, { recursive: true, force: true })
      })
      return closing
    },
  }
}
