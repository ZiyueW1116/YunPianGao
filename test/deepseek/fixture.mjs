import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import LlmRuntime, { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Approval from '@deepseek-ai/dsh-user-approval'
import { defineTool } from '@deepseek-ai/dsh-tools'
import Tools from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import Subagent from '@deepseek-ai/dsh-subagent'
import * as Spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import * as Persistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import Fs from '@deepseek-ai/dsh-fs-local'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import DeepSeek from '../../dist/adapters/deepseek.js'

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
export const until = async (check, attempts = 1000) => {
  for (let n = 0; n < attempts; n++) {
    if (await check()) return
    await sleep(5)
  }
  assert.fail('DeepSeek 原生循环未到达预期状态')
}
export const gate = () => { let resolve; const promise = new Promise((r) => { resolve = r }); return { promise, resolve } }
const abortable = (promise, signal) => new Promise((resolve, reject) => {
  const stop = () => reject(signal.reason)
  if (signal?.aborted) return stop()
  signal?.addEventListener('abort', stop, { once: true })
  promise.then(resolve, reject).finally(() => signal?.removeEventListener('abort', stop))
})
const textChunks = (text, usage = 10) => [
  { type: 'block-start', index: 0, blockType: 'text' }, { type: 'text-delta', index: 0, text },
  { type: 'block-end', index: 0, block: { type: 'text', text } },
  { type: 'usage', usage: { inputTokens: usage, outputTokens: 10 } }, { type: 'finish', reason: { kind: 'stop' } },
]
const toolChunks = (name, args, index = 0) => {
  const id = `call_${Math.random()}`
  return [{ type: 'block-start', index, blockType: 'tool-call' },
    { type: 'tool-call-delta', index, id, name, argumentsDelta: JSON.stringify(args) },
    { type: 'block-end', index, block: { type: 'tool-call', id, name, arguments: JSON.stringify(args) } }]
}
export const send = (agent, text) => agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))

export async function fixture(name, scheduling = {}, providedContext) {
  const root = await mkdtemp(join(tmpdir(), 'ypg-deepseek-')), cwd = join(root, 'project')
  await mkdir(cwd)
  const ctx = providedContext ?? new Context(), calls = [], errors = []
  let parent = 0, child = 0, summaries = 0, approvals = 0, adapter, agent, compactionFiber
  const processes = []
  const releaseApproval = gate(), releaseChild = gate(), releaseSummary = gate(), releaseModel = gate()
  class Script extends LlmAdapter {
    async *stream(options) {
      const summary = options.purpose === 'compaction'
      const kind = summary ? 'summary' : options.sessionId === agent?.id ? 'parent' : 'child'
      calls.push({ kind, at: Date.now(), options })
      let chunks
      if (kind === 'summary') { summaries++; if (name === 'summary-stale' || name === 'compact-race') await abortable(releaseSummary.promise, options.signal); chunks = textChunks('保留目标、约束与任务标识。') }
      else if (kind === 'child') {
        child++; if (name !== 'child-approval') await abortable(releaseChild.promise, options.signal)
        if (name === 'child-failure') throw new Error('合成子任务失败')
        chunks = name === 'child-approval' && child === 1 ? [...toolChunks('need_approval', {}), { type: 'finish', reason: { kind: 'tool-calls' } }] : textChunks('子 Agent 合成结果。')
      } else {
        const n = ++parent
        const started = options.messages.filter(m => m.role === 'tool').flatMap(m => m.content)
          .find(b => b.type === 'text' && b.text.startsWith('{"handle":{'))
        const handle = started && JSON.parse(started.text).handle.id
        let tool
        if (!name.startsWith('summary')) {
          if (n === 1) tool = name.startsWith('child') ? ['start_subagent', { prompt: '合成子任务', description: '验证 activation' }] : ['start_process', { command: process.execPath, args: ['-e', name === 'before' ? 'console.log("DONE")' : name === 'failure' ? 'process.exit(7)' : 'const fs=require("node:fs");const t=setInterval(()=>{if(fs.existsSync("release")){clearInterval(t);console.log("DONE")}},5)'] }]
          if (handle && (n === 2 || name === 'timeout' && n === 3 || (name.includes('input') || name.includes('approval')) && n === 4 || name.endsWith('cancel') && n === 4)) tool = ['wait_for', { handle, timeout: name === 'timeout' && n === 2 ? .03 : 10 }]
          if (name.endsWith('cancel') && n === 3) tool = ['cancel_task', { handle }]
        }
        if (name === 'before' && n === 2) await until(() => adapter.snapshot().tasks[0]?.status === 'succeeded')
        if (name === 'input-stream' && n === 2) await abortable(releaseModel.promise, options.signal)
        chunks = tool ? [...toolChunks(...tool), ...(name === 'batch' && n === 2 ? toolChunks('start_process', { command: process.execPath, args: ['-e', 'console.log("BATCH")'] }, 1) : []), { type: 'usage', usage: { inputTokens: 10, outputTokens: 10 } }, { type: 'finish', reason: { kind: 'tool-calls' } }] : textChunks('合成最终回答。', name.startsWith('summary') && n === 1 ? 1000 : 10)
      }
      for (const chunk of chunks) yield chunk
    }
  }
  try {
    if (!providedContext) {
    for (const plugin of [LlmRuntime, SessionStore, SessionProjectionRegistry, SystemPrompt, Tools, NativeToolExecutor, AgentRegistry]) await ctx.plugin(plugin)
    await ctx.plugin(Fs)
    await ctx.plugin(WorkingDirectory, { defaultDirectory: cwd })
    await ctx.plugin(Sandbox)
    await ctx.plugin(SandboxPolicy, { mode: 'workspace-write', workspaceRoot: cwd })
    await ctx.plugin(Subprocess)
    await ctx.plugin(TokenMeter)
    await ctx.plugin(Approval, { policy: 'ask' })
    await ctx.plugin(Subagent)
    await ctx.plugin(Spawn, { providerName: 'spawn' })
    await ctx.plugin(Persistence, { root: join(root, 'sessions'), compression: 'none' })
    }
    const spawnProcess = ctx.subprocess.spawn.bind(ctx.subprocess)
    ctx.subprocess.spawn = (spec) => {
      const handle = spawnProcess(spec); processes.push(handle)
      if (!name.startsWith('notification-')) return handle
      const done = new Proxy(handle.done, { get(target, key) {
        if (key !== 'then') return Reflect.get(target, key, target)
        return (...args) => {
          const completed = target.then(...args), finish = completed.finally.bind(completed)
          completed.finally = (notify) => name === 'notification-lost' ? completed : finish(() => { notify(); notify() })
          return completed
        }
      } })
      return { ...handle, done }
    }
    ctx.llm.registerAdapter(['fixture'], new Script())
    if (name === 'child-approval') {
      ctx.tools.register(defineTool({ name: 'need_approval', description: '合成审批工具', parameters: {}, output: { schema: { type: 'string' }, render: (_a, value) => [{ type: 'text', text: value }] }, async execute(_a, exec) { return ctx.get('approval').request({ agent: exec.agent, toolName: 'need_approval', callId: exec.callId, signal: exec.signal }) } }))
      ctx.on('approval/request', async (request) => { approvals++; await abortable(releaseApproval.promise, request.signal); return 'allowed-once' })
    }
    if (!providedContext) compactionFiber = await ctx.plugin(DeepSeek, { auto: false, thresholdTokens: 999999, idleDelayMs: 5, pollIntervalMs: 5, ...scheduling })
    if (!providedContext) await ctx.plugin(AgentLoop, { agents: [] })
    ctx.on('agent/error', ({ error }) => errors.push(error))
    const owned = await ctx.agents.create({ sessionId: SessionId('parent'), meta: { cwd }, agentOptions: { provider: 'fixture', model: 'fixture' } })
    agent = owned.agent
    adapter = ctx.compaction.forAgent(agent)
    return { root, cwd, ctx, agent, owned, adapter, compactionFiber, calls, errors, releaseSummary, releaseModel, releaseApproval,
      approvalRequests: () => approvals,
      counts: () => ({ parent, child, summaries }),
      async release() { releaseChild.resolve(); await writeFile(join(cwd, 'release'), '') },
      async close() { releaseApproval.resolve(); releaseChild.resolve(); releaseSummary.resolve(); releaseModel.resolve(); await writeFile(join(cwd, 'release'), ''); await Promise.allSettled(processes.map((handle) => handle.done)); await adapter.close(); await (providedContext ? owned.dispose() : ctx.fiber.dispose()); await rm(root, { recursive: true, force: true }) },
    }
  } catch (error) { if (!providedContext) await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }); throw error }
}
