import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createClaudeQuery } from '../dist/adapters/claude.js'

export const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
export const until = async check => { for (let i = 0; i < 2000; i++) { if (await check()) return; await delay(5) } assert.fail('Claude 真实入口未在期限内到达预期状态。') }
const gate = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
const prefix = 'mcp__yunpiangao__'
const parseStatus = msg => {
  if (msg.type !== 'result' || !msg.result?.startsWith('yunpiangao: {')) return
  return JSON.parse(msg.result.slice('yunpiangao: '.length))
}

export async function fixture(name, scheduling = { thresholdTokens: 999999 }, observer) {
  const root = await mkdtemp(join(tmpdir(), 'yunpiangao-claude-'))
  const cwd = join(root, 'project'), config = join(root, 'config'), temp = join(root, 'tmp')
  await Promise.all([mkdir(cwd), mkdir(config), mkdir(temp)])
  await writeFile(join(cwd, 'synthetic.txt'), '合成文件内容。')
  let observerDir
  if (observer) {
    observerDir = join(root, 'observer'); await mkdir(join(observerDir, '.claude-plugin'), { recursive: true }); await mkdir(join(observerDir, 'hooks'));
    await writeFile(join(observerDir, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'a-yunpiangao-test', version: '0.0.1', description: '合成时序验证' }));
    await writeFile(join(observerDir, 'hooks/hooks.json'), JSON.stringify({ modules: ['./register.mjs'] }));
    await writeFile(join(observerDir, 'hooks/register.mjs'), observer)
    if (name === 'compact-command') {
      await mkdir(join(observerDir, 'commands'))
      await writeFile(join(observerDir, 'commands', 'dependency-probe.md'), '---\ndescription: 读取合成任务依赖\n---\n请查看当前任务依赖。DEPENDENCY_PROBE')
    }
  }
  const calls = [], messages = [], failures = [], releaseSummary = gate(), releaseChild = gate(), releaseWait = gate(), permission = gate()
  let parent = 0, child = 0, summaries = 0, q, handle, state, summaryBlocked = false
  const maxTurns = name === 'max-turns-submit' ? 2 : name.startsWith('max-turns') ? 3 : 20
  const normal = text => ({ type: 'text', text })
  const tool = (name, input) => ({ type: 'tool_use', id: `tool_${calls.length}`, name: prefix + name, input })
  const findHandle = body => {
    for (const m of body.messages) for (const c of Array.isArray(m.content) ? m.content : []) if (c.type === 'tool_result') {
      const text = typeof c.content === 'string' ? c.content : c.content?.map(x => x.text ?? '').join('')
      try { const value = JSON.parse(text.split("\n\n<system-reminder>")[0]); if (value.handle?.id) handle = value.handle.id } catch {}
    }
  }
  const choose = n => {
    if (name.startsWith('summary')) return normal('保留精确标识 SYNTHETIC_FACT_42。')
    if (n === 1) {
      if (name.startsWith('child')) return tool('start_subagent', { prompt: 'CHILD_MARKER：返回合成子结果。', description: '合成子任务' })
      const command = name === 'before' ? 'node -e "console.log(123)"' : name === 'failure' ? 'node -e "process.exit(7)"' : 'node -e \'const fs=require("node:fs");const t=setInterval(()=>{if(fs.existsSync("release")){clearInterval(t);fs.writeFileSync("finished","");console.log("DONE")}},5)\''
      return tool('start_process', { command, description: '合成门闩进程' })
    }
    if (n === 2 && name === 'max-turns-submit') return normal('后台任务继续执行。')
    if (n === 2 && name.startsWith('max-turns')) return { type: 'tool_use', id: 'read_before_wait', name: 'Read', input: { file_path: join(cwd, 'synthetic.txt') } }
    if (n === 2 && name === 'dependency-summary') return normal('后台任务继续执行。')
    if (n === 2 && name.includes('create-failure')) return normal('合成创建失败已处理。')
    if (n === 2) {
      const wait = tool('wait_for', { handle, timeout: name === 'timeout' ? .03 : 10 })
      if (name === 'batch') return [wait, { type: 'tool_use', id: 'extra_read', name: 'Read', input: { file_path: join(cwd, 'synthetic.txt') } }]
      if (name === 'other-notification') return [wait, {
        type: 'tool_use', id: 'other_bash', name: 'Bash',
        input: { command: 'while [ ! -f release-other ]; do sleep 0.05; done; echo OTHER_DONE', description: '另一原生任务', run_in_background: true },
      }]
      return wait
    }
    if (n === 3 && name.startsWith('max-turns')) return tool('wait_for', { handle, timeout: name === 'max-turns-ready' ? 0 : 10 })
    if (n === 4 && name.startsWith('max-turns') && name !== 'max-turns-submit') return tool('wait_for', { handle, timeout: 10 })
    if (name === 'branch' && n === 3) return tool('wait_for', { handle, timeout: 10 })
    if (name === 'timeout' && n === 3) return tool('wait_for', { handle, timeout: 10 })
    if ((name === 'input' || name === 'child-input' || name === 'child-permission') && n === 4) return tool('wait_for', { handle, timeout: 10 })
    if (name.endsWith('cancel') && n === 3) return tool('cancel_task', { handle })
    if (name.endsWith('cancel') && n === 4) return tool('wait_for', { handle, timeout: 10 })
    return normal('合成任务已完成。')
  }
  const server = createServer(async (req, res) => {
    try {
      let raw = ''; for await (const data of req) raw += data
      const body = JSON.parse(raw)
      if (req.url.includes('count_tokens')) { res.end(JSON.stringify({ input_tokens: 100 })); return }
      const nativeSummary = JSON.stringify(body.messages.at(-1)).includes('Please provide your summary based on the conversation so far');
      const kind = !body.tools?.length || nativeSummary ? 'summary' : body.messages.some(m => m.role === 'user' && JSON.stringify(m.content).includes('CHILD_MARKER')) ? 'child' : 'parent'
      calls.push({ kind, body, at: Date.now() })
      let block
      if (kind === 'summary') {
        summaries++
        if (name === 'summary-stale' || name === 'compact-race' || name === 'dependency-summary') { summaryBlocked = true; await releaseSummary.promise }
        block = normal((nativeSummary ? '<summary>' : '') + '## 目标\n保留 SYNTHETIC_FACT_42，完成本地合成任务。\n## 状态\n任务由结构化依赖继续管理。' + (nativeSummary ? '</summary>' : ''))
      } else if (kind === 'child') { child++; if (name === 'child-permission' && child === 1) block = { type: 'tool_use', id: 'child_read', name: 'Read', input: { file_path: join(cwd, 'synthetic.txt') } }; else { if (name !== 'child-permission') await releaseChild.promise; block = normal('合成子任务完成。') } }
      else { findHandle(body); block = choose(++parent) }
      if (name === 'input-stream' && kind === 'parent' && parent === 2) await releaseWait.promise
      if (name === 'before' && kind === 'parent' && parent === 2) await until(() => messages.some(m => m.type === 'system' && m.subtype === 'task_notification'))
      if (res.destroyed) return
      const tokens = name.startsWith('summary') && parent === 1 ? 1000 : 100
      const blocks = Array.isArray(block) ? block : [block]
      const message = { id: `msg_${calls.length}`, type: 'message', role: 'assistant', model: 'claude-sonnet-4-6', content: blocks, stop_reason: blocks.some(block => block.type === 'tool_use') ? 'tool_use' : 'end_turn', stop_sequence: null, usage: { input_tokens: tokens, output_tokens: 10 } }
      if (!body.stream) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(message)); return }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
      send('message_start', { type: 'message_start', message: { ...message, content: [], stop_reason: null, usage: { input_tokens: tokens, output_tokens: 0 } } })
      for (const [index, block] of blocks.entries()) {
        send('content_block_start', { type: 'content_block_start', index, content_block: block.type === 'text' ? { type: 'text', text: '' } : { ...block, input: {} } })
        send('content_block_delta', { type: 'content_block_delta', index, delta: block.type === 'text' ? { type: 'text_delta', text: block.text } : { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } })
        send('content_block_stop', { type: 'content_block_stop', index })
      }
      send('message_delta', { type: 'message_delta', delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: 10 } })
      send('message_stop', { type: 'message_stop' }); res.end()
    } catch (error) { failures.push(error); res.destroy() }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (/ANTHROPIC|CLAUDE/.test(key)) delete env[key]
  Object.assign(env, { CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_TMPDIR: temp, ANTHROPIC_API_KEY: 'synthetic-only', ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' })
  const queue = []; let wake, stopped = false
  async function* prompts() { while (!stopped) { if (!queue.length) await new Promise(resolve => { wake = resolve }); while (queue.length) yield { type: 'user', session_id: '', parent_tool_use_id: null, message: { role: 'user', content: queue.shift() } } } }
  const push = text => { queue.push(text); wake?.() }
  q = createClaudeQuery({ prompt: prompts(), options: { cwd, env, ...(name === 'child-permission' ? { settings: { permissions: { ask: ['Read'] } }, canUseTool: async (tool, input) => { if (tool === 'Read') await permission.promise; return { behavior: 'allow', updatedInput: input } } } : {}), ...(observerDir ? { plugins: [{ type: 'local', path: observerDir }] } : {}), settingSources: [], model: 'claude-sonnet-4-6', maxTurns, allowedTools: name === 'child-permission' ? [] : ['Bash', 'Agent', 'TaskStop', 'Read', `${prefix}start_process`, `${prefix}start_subagent`, `${prefix}wait_for`, `${prefix}cancel_task`], ...(process.env.YPG_CLAUDE_BIN ? { pathToClaudeCodeExecutable: process.env.YPG_CLAUDE_BIN } : {}), stderr: text => { failures.push(new Error(text)) } } }, scheduling)
  const consuming = (async () => { try { for await (const message of q) { messages.push(message); const status = parseStatus(message); if (status) state = status } } catch (error) { if (!stopped) failures.push(error) } })()
  return { q, done: consuming, calls, messages, failures, cwd, root, push, releaseSummary, releaseChild, releaseWait, permission, env,
    counts: () => ({ parent, child, summaries, summaryBlocked }),
    async status() { const start = messages.length; push('/ypg-status'); await until(() => messages.slice(start).some(parseStatus)); return state },
    async release() { releaseChild.resolve(); await writeFile(join(cwd, 'release'), '') },
    async close() {
      if (process.env.YPG_CLAUDE_DEBUG) await writeFile(join(process.env.YPG_CLAUDE_DEBUG, name + '.json'), JSON.stringify({calls,messages,failures:failures.map(String)}, null, 2))
      releaseSummary.resolve(); releaseChild.resolve(); releaseWait.resolve(); permission.resolve(); await writeFile(join(cwd, 'release'), '')
      if (name === 'other-notification') await writeFile(join(cwd, 'release-other'), '')
      stopped = true; wake?.(); q.close(); await consuming
      server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true })
    },
  }
}
