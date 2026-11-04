import assert from 'node:assert/strict'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { fixture, until, sleep, send } from './fixture.mjs'
export async function runScenario(name, providedContext) {
    const f = await fixture(name, {}, providedContext)
    try {
      send(f.agent, '启动并等待合成任务。' + '用于压缩的合成上下文。'.repeat(1000))
      await f.agent.whenIdle()
      assert.ok(f.counts().parent === 2 || ['before', 'failure'].includes(name) && f.counts().parent === 3, JSON.stringify(f.errors.map(String)))
      if (name === 'timeout') await until(() => f.adapter.snapshot().waits.length === 2)
      if (name.includes('input') || name.endsWith('cancel')) {
        send(f.agent, '用户介入'); await f.agent.whenIdle()
        assert.equal(f.adapter.snapshot().waits[0].reason, 'user_input')
        if (name.includes('input')) { assert.equal(f.adapter.snapshot().tasks[0].status, 'working'); send(f.agent, '重等'); await f.agent.whenIdle() }
      }
      if (name.includes('compact')) {
        const pending = f.ctx.compaction.compactNow(f.agent, new AbortController().signal)
        if (name === 'compact-race') { await until(() => f.counts().summaries === 1); await f.release(); await until(() => f.adapter.snapshot().waits[0].reason === 'succeeded'); assert.equal(f.counts().parent, 2); f.releaseSummary.resolve() }
        const result = await pending
        assert.ok(result)
        if (name !== 'compact-race') assert.equal(f.counts().parent, 2)
      }
      if (name === 'interrupt') { await f.adapter.interrupt(); await f.release(); await sleep(40); assert.equal(f.counts().parent, 2); assert.equal(f.adapter.snapshot().waits[0].reason, 'interrupted'); return }
      if (name === 'resume-ack' || name === 'resume-consumed') {
        let hideNext = false
        const events = f.agent.session.snapshotEvents.bind(f.agent.session)
        if (name === 'resume-consumed') f.agent.session.snapshotEvents = (...args) => {
          const snapshot = events(...args)
          if (!hideNext) return snapshot
          hideNext = false
          return snapshot.filter(e => e.type !== 'agent/inbox/spliced' || !e.data.inserted.some(m => m.id.startsWith('ypgw_')))
        }
        const native = f.agent.followup.bind(f.agent)
        f.agent.followup = (message) => { native(message); hideNext = name === 'resume-consumed'; throw new Error('合成接纳后回执丢失') }
      }
      await f.release()
      const expected = name === 'timeout' ? 4 : name.includes('input') || name.endsWith('cancel') ? 5 : 3
      await until(() => f.counts().parent === expected && f.agent.status === 'idle')
      await sleep(30)
      assert.equal(f.counts().parent, expected)
      const state = f.adapter.snapshot(), last = state.waits.at(-1)
      assert.equal(last.state, 'delivered')
      assert.equal(last.reason, name.endsWith('cancel') ? 'cancelled' : name.includes('failure') ? 'failed' : 'succeeded')
      if (name === 'timeout') { assert.equal(state.waits[0].reason, 'timeout'); assert.equal(state.waits[0].handle.id, last.handle.id) }
      if (name === 'before') assert.ok(last.snapshot.finishedAt <= last.createdAt)
      const resumes = f.agent.session.snapshotEvents().filter((e) => e.type === 'user/message' && e.data.id.startsWith('ypgw_'))
      assert.equal(resumes.length, name === 'timeout' ? 2 : 1)
      const final = f.calls.filter((c) => c.kind === 'parent').at(-1)
      assert.ok(JSON.stringify(final.options.messages).includes('云片糕任务运行时状态'))
      if (name.includes('compact')) {
        const events = f.agent.session.snapshotEvents()
        const checkpoint = events.find((e) => e.type === 'compaction/summary')
        assert.ok(checkpoint && checkpoint.seq < resumes.at(-1).seq)
        const texts = final.options.messages.filter(m => m.role === 'user').flatMap(m => m.content)
          .filter(b => b.type === 'text').map(b => b.text)
        const stateText = texts.findLast(text => text.startsWith('云片糕任务运行时状态'))
        const modelState = JSON.parse(stateText.slice(stateText.indexOf('\n') + 1))
        const modelWait = modelState.waits.find(wait => wait.id === last.id)
        assert.deepEqual(modelWait.handle, last.handle)
        assert.equal(modelWait.deadline, last.deadline)
        assert.equal(modelWait.reason, 'succeeded')
        assert.deepEqual(modelState.tasks.find(task => task.handle.id === last.handle.id).handle, last.handle)
        const notice = JSON.parse(texts.find(text => text.startsWith(`{"id":"${last.id}"`)))
        assert.deepEqual(notice.handle, last.handle)
        assert.equal(notice.deadline, last.deadline)
        assert.equal(notice.reason, 'succeeded')
        assert.deepEqual(notice.snapshot, last.snapshot)
      }
      assert.equal(final.options.messages.filter((m) => m.role === 'system' && JSON.stringify(m).includes('"stdout":"DONE')).length, 0)
      assert.deepEqual(f.errors, name === 'child-failure' ? f.errors : [])
      assert.equal(f.agent.session.snapshotEvents().filter(e => e.type === 'tool/call' && /\bsleep\s+(?:[6-9]\d|\d{3,})(?:\D|$)/.test(JSON.stringify(e.data))).length, 0)
      console.log(JSON.stringify({ scenario: name, parentRequests: expected, childRequests: f.counts().child, extraWakeups: f.counts().parent - expected, longSleepCalls: f.agent.session.snapshotEvents().filter(e => e.type === 'tool/call' && /\bsleep\s+(?:[6-9]\d|\d{3,})(?:\D|$)/.test(JSON.stringify(e.data))).length, completionToResumeMs: last.snapshot?.finishedAt === undefined ? null : final.at - last.snapshot.finishedAt }))
    } finally { await f.close() }
}

export async function runSummaryScenario(name, providedContext) {
    const f = await fixture(name, { thresholdTokens: 100 }, providedContext)
    try {
      if (name === 'summary-recheck') {
        const compact = f.ctx.compaction.compactNow.bind(f.ctx.compaction)
        f.ctx.compaction.compactNow = (...args) => { f.agent.model.select({ provider: 'fixture', model: 'changed' }); return compact(...args) }
      }
      if (name === 'summary-prompt' || name === 'summary-tools') {
        const compact = f.ctx.compaction.compactNow.bind(f.ctx.compaction)
        f.ctx.compaction.compactNow = (...args) => {
          if (name === 'summary-prompt') f.ctx.get('systemPrompt').section({ name: 'fixture-changed', order: 999, text: '提交前变化' })
          else f.ctx.tools.register({ name: 'changed_tool', description: '合成工具变化', parameters: { type: 'object', properties: {} }, output: { schema: { type: 'string' }, render: (_a, value) => [{ type: 'text', text: value }] }, async execute() { return '合成结果' } })
          return compact(...args)
        }
      }
      if (name === 'summary-microtask') {
        const summarize = f.ctx.compaction.summarize.bind(f.ctx.compaction)
        f.ctx.compaction.summarize = async (...args) => {
          const cached = f.adapter.summaryForCommit(args[0])
          const result = await summarize(...args)
          if (cached) queueMicrotask(() => send(f.agent, '提交前新输入'))
          return result
        }
      }
      send(f.agent, '待压缩合成事实。'.repeat(1000))
      await f.agent.whenIdle()
      await until(() => f.counts().summaries === 1)
      if (name === 'summary-stale') { send(f.agent, '新输入'); await f.agent.whenIdle(); f.releaseSummary.resolve() }
      if (name === 'summary-commit') await until(() => f.agent.session.snapshotEvents().some((event) => event.type === 'compaction/summary'))
      await sleep(60)
      const results = f.agent.session.snapshotEvents().filter((event) => event.type === 'compaction/summary')
      assert.equal(results.length, name === 'summary-commit' ? 1 : 0)
      assert.equal(f.counts().summaries, 1)
      if (results[0]) {
        assert.deepEqual(results[0].data.usage, { inputTokens: 10, outputTokens: 10 })
        assert.equal(results[0].data.llmStreamCall, true)
        assert.deepEqual(results[0].data.rawOutput, [{ type: 'text', text: '保留目标、约束与任务标识。' }])
        assert.ok(f.calls.find((c) => c.kind === 'summary').options.tools.length)
        const replay = Session.create(SessionId('replay'), f.agent.session.snapshotEvents())
        assert.deepEqual(replay.deriveMessages(), f.agent.session.deriveMessages())
      }
    } finally { await f.close() }
}
