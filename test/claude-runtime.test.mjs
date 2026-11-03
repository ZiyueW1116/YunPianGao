import test from 'node:test'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { claudeModPath, createClaudeQuery } from '../dist/adapters/claude.js'
import { fixture, until, delay } from './claude-fixture.mjs'

for (const name of ['complete', 'before', 'failure', 'timeout', 'input', 'cancel', 'compact', 'compact-race', 'batch', 'child-compact', 'child', 'child-input', 'child-cancel']) {
  test(`Claude 真实 SDK + Mods：${name}`, { timeout: 30000 }, async () => {
    const f = await fixture(name)
    try {
      f.push('启动合成任务并等待。')
      await until(() => f.messages.some(m => m.type === 'assistant' && JSON.stringify(m.message.content).includes('云片糕：已登记任务等待')))
      const parked = await f.status()
      assert.equal(parked.waits.length, 1)
      if (!['before', 'failure'].includes(name)) assert.equal(f.counts().parent, 2)
      if (name === 'timeout') await until(() => f.counts().parent === 3)
      if (name.includes('input') || name.endsWith('cancel')) {
        f.push('用户介入：先处理这条输入。')
        await until(() => f.counts().parent === (name.endsWith('cancel') ? 4 : 3))
        if (name.includes('input')) { const s = await f.status(); assert.equal(s.waits[0].reason, 'user_input'); assert.equal(s.tasks[0].status, 'working'); f.push('继续等待同一任务。'); await until(() => f.counts().parent === 4) }
      }
      if (['compact', 'compact-race', 'child-compact'].includes(name)) { f.push('/compact'); if (name === 'compact-race') { await until(() => f.counts().summaryBlocked); await f.release(); await delay(50); assert.equal(f.counts().parent, 2); f.releaseSummary.resolve() } await until(() => f.messages.some(m => m.type === 'system' && m.subtype === 'compact_boundary')); assert.equal(f.counts().parent, 2) }
      await f.release()
      const expected = name === 'timeout' ? 4 : name.includes('input') || name.endsWith('cancel') ? 5 : 3
      await until(() => f.counts().parent === expected)
      const s = await f.status(), last = s.waits.at(-1)
      assert.equal(last.state, 'delivered')
      assert.equal(last.reason, name.endsWith('cancel') ? 'cancelled' : name === 'failure' ? 'failed' : 'succeeded')
      if (name === 'timeout') { assert.equal(s.waits[0].reason, 'timeout'); assert.equal(last.handle.id, s.waits[0].handle.id) }
      const final = f.calls.filter(c => c.kind === 'parent').at(-1)
      assert.ok(JSON.stringify(final.body.messages).includes('云片糕任务运行时状态'))
      await delay(50)
      assert.equal(f.counts().parent, expected)
      const modelTools = f.messages.filter(m => m.type === 'assistant').flatMap(m => m.message.content).filter(c => c.type === 'tool_use')
      const longSleepCalls = modelTools.filter(c => /\bsleep\s+(?:[6-9]\d|\d{3,})(?:\D|$)/.test(JSON.stringify(c.input))).length
      assert.equal(longSleepCalls, 0)
      assert.deepEqual(f.failures, [])
      const end = f.messages.find(m => m.type === 'system' && m.subtype === 'task_updated' && m.patch.end_time)?.patch.end_time
      console.log(JSON.stringify({ scenario: name, parentRequests: expected, childRequests: f.counts().child, extraWakeups: f.counts().parent - expected, longSleepCalls, completionToResumeMs: end ? final.at - end : null }))
    } finally { await f.close() }
  })
}

for (const name of ['summary-commit', 'summary-stale']) {
  test(`Claude 空闲摘要：${name}`, { timeout: 30000 }, async () => {
    const f = await fixture(name, { thresholdTokens: 500, idleDelayMs: 10 })
    try {
      f.push('保留精确事实 SYNTHETIC_FACT_42。')
      await until(() => f.counts().summaries === 1)
      if (name === 'summary-stale') { f.push('新输入使旧摘要失效。'); await until(() => f.counts().parent === 2); f.releaseSummary.resolve(); await delay(100) }
      else { await delay(100); const diagnostic = await f.status(); assert.deepEqual(diagnostic.errors, []); assert.ok(diagnostic.compactResult, JSON.stringify(diagnostic)) }
      const status = await f.status()
      assert.equal(Boolean(status.compactResult?.preparedUsed), name === 'summary-commit')
      if (name === 'summary-commit') { assert.ok(f.messages.some(m => m.subtype === 'compact_boundary')); f.push('摘要后继续。'); await until(() => f.counts().parent === 2); assert.ok(JSON.stringify(f.calls.filter(c => c.kind === 'parent').at(-1).body).includes('云片糕会话摘要')) }
      assert.equal(f.counts().summaries, 1)
      assert.deepEqual(f.failures, [])
    } finally { await f.close() }
  })
}

for (const action of ['close', 'clear', 'reload']) {
  test(`Claude 生命周期：等待中 ${action}`, { timeout: 30000 }, async () => {
    const f = await fixture(action)
    try {
      f.push('启动合成进程并等待。')
      await until(() => f.messages.some(m => m.type === 'assistant' && JSON.stringify(m.message.content).includes('云片糕：已登记任务等待')))
      const original = await f.status()
      if (action === 'reload') { const file = join(claudeModPath, 'hooks/register.mjs'); const content = await readFile(file, 'utf8'); await writeFile(file, content + '\n// 合成热重载验证。\n'); await f.q.reloadPlugins(); await delay(100) }
      else { f.push(action === 'close' ? '/ypg-close' : '/clear'); await until(() => f.messages.some(m => m.type === 'result' && (m.result?.includes('云片糕实例已关闭') || m.local_command === 'clear'))) }
      const current = await f.status()
      if (action === 'reload') assert.equal(current.tasks.length, 0)
      else assert.equal(current.closed, true)
      await f.release()
      await until(() => existsSync(join(f.cwd, 'finished')))
      await delay(300)
      assert.equal(f.counts().parent, 2)
      if (action !== 'reload') { const closed = await f.status(); assert.equal(closed.waits[0].id, original.waits[0].id); assert.equal(closed.waits[0].reason, 'closed') }
      assert.deepEqual(f.failures, [])
    } finally { await f.close() }
  })
}

for (const scenario of ['duplicate', 'lost-notify', 'lost-ack']) {
  test(`Claude 原生边界：${scenario}`, { timeout: 15000 }, async () => {
    const observer = scenario === 'duplicate' ? `export function register(on) { on('prompt.submit', async ($,e,next) => { if(e.origin.kind==='task-notification') { $.ui.log('合成重复通知'); await next(e) } return next(e) }) }` : scenario === 'lost-notify' ? `export function register(on) { on('clock.after', {ms:0}, async () => { throw new Error('合成 runtime 通知丢失') }) }` : `export function register(on) { let once=false; on('prompt.submit', async ($,e,next) => { const result=await next(e); if(!once && e.origin.kind==='plugin' && e.origin.name==='yunpiangao') { once=true; $.ui.log('合成接纳回执丢失'); return {drop:'合成接纳回执丢失'} } return result }) }`
    const f = await fixture(scenario, undefined, observer)
    try {
      f.push('启动合成进程并等待。')
      await until(() => f.messages.some(m => m.type === 'assistant' && JSON.stringify(m.message.content).includes('云片糕：已登记任务等待')))
      await f.release(); await until(() => f.counts().parent === 3); await delay(200)
      const state = await f.status()
      assert.equal(f.counts().parent, 3)
      assert.equal(state.waits[0].state, 'delivered')
      assert.equal(state.waits[0].reason, 'succeeded')
      if (scenario !== 'lost-notify') assert.ok(f.messages.some(m => m.subtype === 'ui_log' && m.plugin === 'a-yunpiangao-test'))
      assert.deepEqual(f.failures, [])
    } finally { await f.close() }
  })
}

test('Claude 在途输入结束旧等待而不取消任务', { timeout: 15000 }, async () => {
  const f = await fixture('input-stream')
  try {
    f.push('启动任务并等待。'); await until(() => f.counts().parent === 2)
    f.push('用户介入：先处理这条输入。'); await delay(30); f.releaseWait.resolve()
    await until(() => f.counts().parent === 3)
    const state = await f.status()
    assert.equal(state.waits.length, 1); assert.equal(state.waits[0].reason, 'user_input'); assert.equal(state.waits[0].state, 'delivered'); assert.equal(state.tasks[0].status, 'working')
    await f.release(); await delay(200); assert.equal(f.counts().parent, 3)
    assert.deepEqual(f.failures, [])
  } finally { await f.close() }
})

test('Claude 终端 Mods：真实 PTY 完成接续', { timeout: 40000 }, async () => {
  const f = await fixture('terminal')
  const binary = process.env.YPG_CLAUDE_BIN ?? createRequire(import.meta.url).resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/claude`)
  const terminal = spawn('python3', [fileURLToPath(new URL('./claude_terminal.py', import.meta.url)), binary, claudeModPath], { cwd: f.cwd, env: f.env, stdio: ['pipe', 'pipe', 'pipe'] })
  let output = '', error = ''
  terminal.stdout.on('data', data => { output += data.toString() })
  terminal.stderr.on('data', data => { error += data.toString() })
  const ended = new Promise(resolve => terminal.once('exit', resolve))
  try {
    await until(() => output.includes('YPG_TERMINAL_READY'))
    terminal.stdin.write('启动合成进程并等待。\r')
    await until(() => f.counts().parent === 2)
    await delay(100); await f.release()
    await until(() => f.counts().parent === 3)
    await delay(200)
    assert.equal(f.counts().parent, 3)
    assert.ok(JSON.stringify(f.calls.at(-1).body).includes('云片糕等待结果'))
    assert.ok(JSON.stringify(f.calls.at(-1).body).includes('云片糕任务运行时状态'))
    assert.equal(error, '')
    terminal.stdin.write('/exit\r')
    await ended
  } finally { terminal.kill('SIGTERM'); await ended; if (process.env.YPG_CLAUDE_DEBUG) await writeFile(join(process.env.YPG_CLAUDE_DEBUG, 'terminal.txt'), output + error); await f.close() }
})

test('Claude 子 Agent 创建被原生扩展拒绝时不发布 handle', { timeout: 15000 }, async () => {
  const f = await fixture('child-create-failure', undefined, `export function register(on) { on('agent.spawn', () => ({deny:'合成创建失败'})) }`)
  try {
    f.push('启动合成子 Agent。'); await until(() => f.counts().parent === 2)
    const state = await f.status(); assert.deepEqual(state.tasks, []); assert.equal(f.counts().child, 0)
    f.push('/ypg-close'); await until(() => f.messages.some(m => m.type === 'result' && m.result?.includes('云片糕实例已关闭')))
    assert.deepEqual(f.failures, [])
  } finally { await f.close() }
})

for (const phase of ['before', 'after']) {
  test(`Claude Query.close 与真实子 Agent 创建竞争：${phase}`, { timeout: 15000 }, async () => {
    const observer = `export function register(on) { on('agent.spawn', async($,e,next) => { ${phase === 'after' ? 'const result=await next(e);' : ''} await $.fs.write('creating', ''); while(true){try{await $.fs.read('release-create');break}catch{await $.clock.sleep(5,{signal:next.signal})}} ${phase === 'after' ? 'return result' : 'return next(e)'} }) }`
    const f = await fixture('child-create-race', undefined, observer)
    try {
      f.push('启动合成子 Agent。'); await until(() => existsSync(join(f.cwd, 'creating')))
      f.q.close()
      await f.done
      await writeFile(join(f.cwd, 'release-create'), '')
      await f.release(); await delay(100)
      assert.equal(f.counts().parent, 1)
      assert.equal(f.messages.filter(m => m.type === 'user' && JSON.stringify(m.message.content).includes('"handle"')).length, 0)
      if (phase === 'before') assert.equal(f.counts().child, 0)
      assert.deepEqual(f.failures, [])
    } finally { await writeFile(join(f.cwd, 'release-create'), ''); await f.close() }
  })
}

test('Claude 子 Agent 权限介入接续后可等待同一 handle', { timeout: 15000 }, async () => {
  const f = await fixture('child-permission')
  try {
    f.push('启动合成子 Agent 并等待。'); await until(() => f.counts().parent === 3)
    const waiting = await f.status(); assert.equal(waiting.waits[0].reason, 'input_required'); assert.equal(waiting.tasks[0].status, 'input_required')
    f.permission.resolve(); await until(() => f.counts().child === 2)
    f.push('继续等待同一子任务。'); await until(() => f.counts().parent === 5)
    const done = await f.status(); assert.equal(done.waits[1].reason, 'succeeded'); assert.equal(done.waits[1].handle.id, waiting.waits[0].handle.id)
    assert.deepEqual(f.failures, [])
  } finally { await f.close() }
})

test('Claude SDK close 同步重入共用一次 interrupt', { timeout: 15000 }, async () => {
  const f = await fixture('close-reentrant')
  try {
    f.push('启动进程并等待。'); await until(() => f.counts().parent === 2)
    const interrupt = f.q.interrupt.bind(f.q)
    let nested, count = 0
    f.q.interrupt = () => { count++; nested = f.q.close(); return interrupt() }
    const closing = f.q.close(); assert.equal(nested, closing)
    await closing; await f.done; assert.equal(count, 1)
    await assert.rejects(f.q.streamInput((async function* () {})()), /已关闭/)
    assert.deepEqual(f.failures, [])
  } finally { await f.close() }
})

test('Claude SDK 进程创建失败可收尾且不调用模型', { timeout: 15000 }, async () => {
  const f = await fixture('spawn-failure')
  try {
    const failure = new Error('合成 SDK 进程创建失败')
    await assert.rejects(async () => {
      const q = createClaudeQuery({ prompt: '合成启动。', options: { env: f.env, cwd: f.cwd, spawnClaudeCodeProcess() { throw failure } } })
      try { for await (const _message of q) {} } finally { await q.close() }
    }, /合成 SDK 进程创建失败/)
    assert.equal(f.counts().parent, 0)
  } finally { await f.close() }
})

test('Claude 显式结束单次等待不取消进程', { timeout: 15000 }, async () => {
  const f = await fixture('interrupt-wait')
  try {
    f.push('启动任务并等待。'); await until(() => f.counts().parent === 2)
    await f.status(); f.push('/ypg-interrupt')
    await until(() => f.messages.some(m => m.type === 'result' && m.result?.includes('本次等待已结束')))
    await f.release(); await until(() => existsSync(join(f.cwd, 'finished'))); await delay(150)
    assert.equal(f.counts().parent, 2)
    assert.equal((await f.status()).waits[0].reason, 'interrupted')
  } finally { await f.close() }
})

test('Claude SDK fork 的新实例拒绝历史中的旧 handle', { timeout: 15000 }, async () => {
  const f = await fixture('branch')
  let fork
  try {
    f.push('启动任务并等待。'); await until(() => f.counts().parent === 2); await f.status()
    const id = f.messages.find(m => m.subtype === 'init').session_id
    await f.q.close(); await f.done
    const messages = []
    fork = createClaudeQuery({ prompt: '尝试等待历史中的 handle。', options: { cwd: f.cwd, env: f.env, settingSources: [], model: 'claude-sonnet-4-6', resume: id, forkSession: true, allowedTools: ['mcp__yunpiangao__wait_for'] } })
    for await (const message of fork) messages.push(message)
    assert.equal(f.counts().parent, 4)
    assert.ok(messages.some(m => m.type === 'user' && JSON.stringify(m.message.content).includes('handle 不存在')))
    assert.notEqual(messages.find(m => m.subtype === 'init').session_id, id)
    assert.deepEqual(f.failures, [])
  } finally { await fork?.close(); await f.close() }
})

test('Claude 依赖变化使准备中的摘要失效', { timeout: 15000 }, async () => {
  const f = await fixture('dependency-summary', { thresholdTokens: 50, idleDelayMs: 10 })
  try {
    f.push('启动后台任务，先完整回答。'); await until(() => f.counts().summaries === 1)
    await f.release(); await until(() => f.messages.some(m => m.subtype === 'task_notification'))
    await delay(30); f.releaseSummary.resolve(); await delay(100)
    const state = await f.status(); assert.equal(state.tasks[0].status, 'succeeded')
    assert.equal(state.compactResult?.preparedUsed, undefined)
    assert.equal(f.messages.filter(m => m.subtype === 'compact_boundary').length, 0)
    assert.equal(f.counts().parent, 2); assert.equal(f.counts().summaries, 1)
  } finally { await f.close() }
})

test('Claude close 中止正在准备的摘要而不提交', { timeout: 15000 }, async () => {
  const f = await fixture('summary-stale', { thresholdTokens: 500, idleDelayMs: 10 })
  try {
    f.push('完整回答后准备摘要。'); await until(() => f.counts().summaries === 1)
    f.push('/ypg-close'); await until(() => f.messages.some(m => m.type === 'result' && m.result?.includes('云片糕实例已关闭')))
    const closed = await f.status(); assert.equal(closed.closed, true)
    f.releaseSummary.resolve(); await delay(100)
    assert.equal(f.messages.filter(m => m.subtype === 'compact_boundary').length, 0)
    assert.equal(f.counts().parent, 1); assert.equal(f.counts().summaries, 1)
  } finally { await f.close() }
})
