import test from 'node:test'
import assert from 'node:assert/strict'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { fixture, until, sleep, send, gate } from './deepseek/fixture.mjs'
import DeepSeek from '../dist/adapters/deepseek.js'
import { runScenario, runSummaryScenario } from './deepseek/scenarios.mjs'

for (const name of ['complete', 'before', 'failure', 'timeout', 'input', 'cancel', 'compact', 'compact-race', 'child', 'child-input', 'child-cancel', 'child-failure', 'interrupt', 'resume-ack', 'resume-consumed', 'notification-lost', 'notification-repeat', 'batch', 'child-compact']) {
  test(`DeepSeek 原生循环：${name}`, { timeout: 15000 }, async () => {
    await runScenario(name)
  })
}

for (const name of ['summary-commit', 'summary-stale', 'summary-recheck', 'summary-microtask', 'summary-prompt', 'summary-tools']) {
  test(`DeepSeek 空闲摘要：${name}`, { timeout: 15000 }, async () => {
    await runSummaryScenario(name)
  })
}

test('DeepSeek 模型请求期间新输入使旧等待意图失效', { timeout: 15000 }, async () => {
  const f = await fixture('input-stream')
  try {
    send(f.agent, '启动合成任务')
    await until(() => f.counts().parent === 2)
    f.agent.steer(createUserMessage({ content: [{ type: 'text', text: '用户介入' }], source: { kind: 'user' } }))
    f.releaseModel.resolve(); await f.agent.whenIdle()
    assert.equal(f.adapter.snapshot().waits.length, 0)
    assert.equal(f.adapter.snapshot().tasks[0].status, 'working')
    assert.equal(f.counts().parent, 3)
    await f.release(); await sleep(40)
    assert.equal(f.counts().parent, 3)
  } finally { await f.close() }
})

const invoke = (f, name, args, signal = new AbortController().signal, tool = f.ctx.tools.get(name, f.agent)) => tool.execute(args, { agent: f.agent, signal, callId: 'lifecycle_call', concludeTurn() {}, deferContext() {} })
const childInput = { prompt: '合成子任务', description: '生命周期验证' }

for (const phase of ['setup', 'announce', 'tools']) {
  test(`DeepSeek 创建失败回滚：${phase}`, { timeout: 15000 }, async (t) => {
    const f = await fixture('summary-lifecycle')
    const failure = new Error('合成创建失败')
    let failedAgent, stop
    const config = { sessionId: 'broken', meta: { cwd: f.cwd }, agentOptions: { provider: 'fixture', model: 'fixture' } }
    if (phase === 'setup') config.setup = (_ctx, agent) => { failedAgent = agent; throw failure }
    if (phase === 'announce') stop = f.ctx.on('agent/created', ({ agent }) => { if (agent.id === 'broken') { failedAgent = agent; throw failure } })
    if (phase === 'tools') {
      const native = f.ctx.tools.register.bind(f.ctx.tools)
      const mocked = t.mock.method(f.ctx.tools, 'register', (tool, options) => { if (tool.name === 'wait_for') throw failure; return native(tool, options) }); stop = () => mocked.mock.restore()
    }
    try {
      await assert.rejects(f.ctx.agents.create(config), /合成创建失败/)
      assert.equal(f.ctx.agents.get('broken'), undefined)
      assert.equal(f.ctx.sessions.get('broken'), undefined)
      if (failedAgent && f.ctx.compaction.forAgent(failedAgent)) await assert.rejects(f.ctx.compaction.forAgent(failedAgent).interrupt(), /已关闭/)
      stop?.(); stop = undefined
      const recovered = await f.ctx.agents.create({ ...config, setup: undefined, sessionId: 'recovered' })
      await recovered.dispose()
    } finally { stop?.(); await f.close() }
  })
}

for (const phase of ['prepare', 'publication', 'returned']) {
  test(`DeepSeek close 与 activation 创建竞争：${phase}`, { timeout: 15000 }, async (t) => {
    const f = await fixture('child-lifecycle'), release = gate(), entered = gate()
    const native = f.ctx.subagents.startActivation.bind(f.ctx.subagents)
    let activation, close1, close2
    if (phase === 'prepare') {
      f.ctx.subagents.registerProvider({ name: 'gated', capabilities: { agentOptions: true, agentPreset: true, outputSchema: true, depthLimit: true }, inheritsParentContext: false, async prepareContinuable(request) { request.signal.addEventListener('abort', () => { close2 = f.adapter.close() }, { once: true }); entered.resolve(); await release.promise; return {} } })
      // 通过原生 registry 选择 provider；只在测试边界延迟真实准备。
      t.mock.method(f.ctx.subagents, 'startActivation', (spec) => native({ ...spec, provider: 'gated' }))
    } else if (phase === 'publication') {
      f.ctx.on('agent/created', async ({ agent }) => { if (agent.session.header.origin === 'subagent') { entered.resolve(); await release.promise } })
    } else t.mock.method(f.ctx.subagents, 'startActivation', async (spec) => { activation = await native(spec); entered.resolve(); await release.promise; return activation })
    const oldTool = f.ctx.tools.get('start_subagent', f.agent)
    const creating = invoke(f, 'start_subagent', childInput).then(() => 'published', () => 'rejected')
    try {
      await entered.promise
      close1 = f.adapter.close(); close2 ??= f.adapter.close()
      assert.equal(close1, close2)
      let finished = false; close1.then(() => { finished = true })
      await sleep(10); assert.equal(finished, false)
      release.resolve()
      assert.equal(await creating, 'rejected')
      await close1
      assert.equal(f.adapter.snapshot().tasks.length, 0)
      assert.equal(f.counts().parent, 0)
      if (phase !== 'returned') assert.equal(f.counts().child, 0)
      await assert.rejects(invoke(f, 'start_subagent', childInput, undefined, oldTool), /已关闭/)
    } finally { release.resolve(); await f.close() }
  })
}

for (const operation of ['dispose', 'branch', 'reload', 'close-running', 'close-process']) {
  test(`DeepSeek 实例失效：${operation}`, { timeout: 15000 }, async () => {
    const f = await fixture(operation === 'close-running' ? 'child' : 'complete')
    let next
    try {
      send(f.agent, '启动并等待'); await f.agent.whenIdle()
      const oldTool = f.ctx.tools.get('start_process', f.agent)
      if (operation === 'branch') {
        const seed = f.ctx.sessions.fork(f.agent.session)
        next = await f.ctx.agents.create({ sessionId: 'branch', seed: seed.snapshotEvents(), inheritedEventCount: seed.inheritedEventCount, meta: { cwd: f.cwd, isSeeded: true }, agentOptions: { provider: 'fixture', model: 'fixture' } })
        assert.equal(f.ctx.compaction.forAgent(next.agent).snapshot().tasks.length, 0)
        await f.owned.dispose()
      } else if (operation === 'reload') {
        await f.compactionFiber.dispose()
        await f.ctx.plugin(DeepSeek, { auto: false, thresholdTokens: 999999 })
        next = await f.ctx.agents.create({ sessionId: 'reloaded', meta: { cwd: f.cwd }, agentOptions: { provider: 'fixture', model: 'fixture' } })
        assert.equal(f.ctx.compaction.forAgent(next.agent).snapshot().tasks.length, 0)
      }
      else if (operation === 'dispose') await f.owned.dispose()
      else await f.adapter.close()
      await assert.rejects(invoke(f, 'start_process', { command: process.execPath, args: [] }, undefined, oldTool), /已关闭/)
      await assert.rejects(f.adapter.interrupt(), /已关闭/)
      await f.release(); await sleep(50)
      assert.equal(f.counts().parent, 2)
      assert.equal(f.agent.session.snapshotEvents().filter((e) => e.type === 'user/message' && e.data.id.startsWith('ypgw_')).length, 0)
      if (operation === 'close-process') assert.equal(f.adapter.snapshot().tasks[0].status, 'working')
    } finally { await next?.dispose(); await f.close() }
  })
}

test('DeepSeek 子 Agent 保留宿主固定权限，不转为自动批准', { timeout: 15000 }, async () => {
  const f = await fixture('child-approval')
  try {
    send(f.agent, '启动带审批的合成子任务'); await f.agent.whenIdle()
    await until(() => f.counts().parent === 3 && f.agent.status === 'idle')
    assert.equal(f.counts().child, 2)
    assert.equal(f.adapter.snapshot().waits[0].reason, 'succeeded')
    const childRequest = f.calls.filter(c => c.kind === 'child').at(-1)
    assert.ok(childRequest.options.messages.some(m => m.role === 'tool' && m.content.some(b => b.type === 'text' && b.text === 'rejected')))
    assert.equal(f.approvalRequests(), 0)
  } finally { await f.close() }
})

for (const phase of ['prepare', 'publication']) {
  test(`DeepSeek 子 Agent 创建失败清理：${phase}`, { timeout: 15000 }, async () => {
    const f = await fixture('summary-lifecycle')
    try {
      if (phase === 'prepare') {
        f.ctx.subagents.registerProvider({ name: 'broken', capabilities: { agentOptions: true, agentPreset: true, outputSchema: true, depthLimit: true }, inheritsParentContext: false, async prepareContinuable() { throw new Error('合成准备失败') } })
        const native = f.ctx.subagents.startActivation.bind(f.ctx.subagents)
        f.ctx.subagents.startActivation = (spec) => native({ ...spec, provider: 'broken' })
      } else f.ctx.on('agent/created', ({ agent }) => { if (agent.session.header.origin === 'subagent') throw new Error('合成发布失败') })
      await assert.rejects(invoke(f, 'start_subagent', childInput), /合成/)
      assert.equal(f.adapter.snapshot().tasks.length, 0)
      assert.equal(f.ctx.agents.list().length, 1)
      assert.equal(f.counts().child, 0)
    } finally { await f.close() }
  })
}

for (const phase of ['lookup', 'spawn-reentrant']) {
  test(`DeepSeek close 与进程创建竞争：${phase}`, { timeout: 15000 }, async (t) => {
    const f = await fixture('summary-lifecycle'), release = gate(), entered = gate()
    let closing, spawned
    const native = f.ctx.subprocess[phase === 'lookup' ? 'resolveExecutable' : 'spawn'].bind(f.ctx.subprocess)
    if (phase === 'lookup') t.mock.method(f.ctx.subprocess, 'resolveExecutable', async (...args) => { entered.resolve(); await release.promise; return native(...args) })
    else t.mock.method(f.ctx.subprocess, 'spawn', (...args) => { spawned = native(...args); closing = f.adapter.close(); assert.equal(closing, f.adapter.close()); return spawned })
    try {
      const creating = invoke(f, 'start_process', { command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'] })
      const rejected = assert.rejects(creating, phase === 'lookup' ? { name: 'AbortError' } : /已关闭/)
      if (phase === 'lookup') { await entered.promise; closing = f.adapter.close(); release.resolve() }
      await rejected; await closing
      assert.equal(f.adapter.snapshot().tasks.length, 0)
      if (spawned) assert.equal(await spawned.waitForExit(), true)
    } finally { release.resolve(); await f.close() }
  })
}

test('DeepSeek wait_for 的最终工具结果被宿主策略拒绝时停止本次等待', { timeout: 15000 }, async () => {
  const f = await fixture('complete')
  try {
    f.ctx.on('tools/post-execute', async (exec, _result, next) => exec.name === 'wait_for' ? { kind: 'block', feedback: [{ type: 'text', text: '合成策略拒绝' }] } : next())
    send(f.agent, '启动任务'); await f.agent.whenIdle()
    assert.equal(f.counts().parent, 3)
    assert.equal(f.adapter.snapshot().waits[0].reason, 'interrupted')
    await f.release(); await sleep(50)
    assert.equal(f.counts().parent, 3)
  } finally { await f.close() }
})

test('DeepSeek 压缩维护期间 close 不产生迟到接续', { timeout: 15000 }, async () => {
  const f = await fixture('compact-race')
  try {
    send(f.agent, '压缩合成历史。'.repeat(1000)); await f.agent.whenIdle()
    const compacting = f.ctx.compaction.compactNow(f.agent, new AbortController().signal).then(() => 'committed', () => 'cancelled')
    await until(() => f.counts().summaries === 1)
    await f.release(); await until(() => f.adapter.snapshot().waits[0].reason === 'succeeded')
    await f.adapter.close()
    assert.equal(await compacting, 'cancelled')
    assert.equal(f.counts().parent, 2)
    assert.equal(f.agent.session.snapshotEvents().filter(e => e.type === 'compaction/summary').length, 0)
  } finally { await f.close() }
})
