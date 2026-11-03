import test from 'node:test'
import assert from 'node:assert/strict'
import { query, getSessionMessages } from '@anthropic-ai/claude-agent-sdk'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// 这些场景验证正式 defer 的宿主限制；产品等待使用 Mods 正常轮边界。
for (const scenario of ['resume', 'new-input', 'batch']) {
  test(`Claude 正式 defer：${scenario}`, { timeout: 15000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'yunpiangao-claude-defer-'))
    const config = join(root, 'config'), temp = join(root, 'tmp'), file = join(root, 'facts.txt')
    await Promise.all([mkdir(config), mkdir(temp), writeFile(file, 'SYNTHETIC_FACT_42')])
    let requests = 0, preCalls = 0, executed = 0, defer = true
    const bodies = []
    const server = createServer(async (req, res) => {
      let raw = ''; for await (const data of req) raw += data
      const body = JSON.parse(raw)
      if (req.url.includes('count_tokens')) { res.end(JSON.stringify({ input_tokens: 100 })); return }
      bodies.push(body)
      const n = ++requests
      const blocks = n === 1 ? Array.from({ length: scenario === 'batch' ? 2 : 1 }, (_, i) => ({ type: 'tool_use', id: `defer_${i}`, name: 'Read', input: { file_path: file } })) : [{ type: 'text', text: '合成 defer 验证完成。' }]
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const send = (event, value) => res.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`)
      send('message_start', { type: 'message_start', message: { id: `msg_${n}`, type: 'message', role: 'assistant', model: 'claude-sonnet-4-6', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 0 } } })
      for (const [index, block] of blocks.entries()) {
        send('content_block_start', { type: 'content_block_start', index, content_block: block.type === 'text' ? { type: 'text', text: '' } : { ...block, input: {} } })
        send('content_block_delta', { type: 'content_block_delta', index, delta: block.type === 'text' ? { type: 'text_delta', text: block.text } : { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } })
        send('content_block_stop', { type: 'content_block_stop', index })
      }
      send('message_delta', { type: 'message_delta', delta: { stop_reason: n === 1 ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 10 } })
      send('message_stop', { type: 'message_stop' }); res.end()
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const env = { ...process.env }
    for (const key of Object.keys(env)) if (/ANTHROPIC|CLAUDE/.test(key)) delete env[key]
    Object.assign(env, { CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_TMPDIR: temp, ANTHROPIC_API_KEY: 'synthetic-only', ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' })
    const savedConfig = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = config
    const options = { cwd: root, env, settingSources: [], model: 'claude-sonnet-4-6', tools: ['Read'], allowedTools: ['Read'], ...(process.env.YPG_CLAUDE_BIN ? { pathToClaudeCodeExecutable: process.env.YPG_CLAUDE_BIN } : {}), hooks: {
      PreToolUse: [{ matcher: 'Read', hooks: [async () => { preCalls++; return defer ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'defer' } } : {} }] }],
      PostToolUse: [{ matcher: 'Read', hooks: [async () => { executed++; return {} }] }],
    } }
    const run = async (prompt, resume) => {
      const q = query({ prompt, options: { ...options, ...(resume ? { resume } : {}) } }), messages = []
      try { for await (const message of q) messages.push(message) } finally { q.close() }
      return messages
    }
    try {
      const first = await run('读取合成事实。')
      if (process.env.YPG_CLAUDE_DEBUG) await writeFile(join(process.env.YPG_CLAUDE_DEBUG, 'defer-' + scenario + '.json'), JSON.stringify({first,bodies,preCalls,executed,requests}, null, 2))
      const result = first.find(message => message.type === 'result')
      assert.equal(result.is_error, false)
      if (scenario === 'batch') {
        assert.equal(result.stop_reason, 'tool_deferred')
        assert.ok(['defer_0', 'defer_1'].includes(result.deferred_tool_use.id))
        assert.equal(preCalls, 2)
        assert.equal(executed, 0)
        assert.equal(requests, 1)
      } else {
        assert.equal(result.stop_reason, 'tool_deferred')
        assert.equal(result.deferred_tool_use.id, 'defer_0')
        assert.equal(executed, 0)
        assert.equal(requests, 1)
        for (let i = 0; i < 200; i++) {
          const saved = await getSessionMessages(result.session_id, { dir: root })
          if (JSON.stringify(saved).includes('defer_0')) break
          if (i === 199) assert.fail('原生 deferred 调用没有持久化。')
          await new Promise(resolve => setTimeout(resolve, 5))
        }
        if (scenario === 'resume') defer = false
        const resumed = await run(scenario === 'resume' ? '' : '用户新输入：先回答这一条。', result.session_id)
        if (process.env.YPG_CLAUDE_DEBUG) await writeFile(join(process.env.YPG_CLAUDE_DEBUG, 'defer-' + scenario + '.json'), JSON.stringify({first,resumed,bodies,preCalls,executed,requests}, null, 2))
        const final = resumed.findLast(message => message.type === 'result')
        assert.equal(final.is_error, false)
        assert.notEqual(final.stop_reason, 'tool_deferred')
        // 正式恢复路径存在两种实测序列：重新复核，或跳过 PreToolUse 直接执行。
        // 产品不依赖 defer；这里锁定具体执行证据，不把任一序列宣称为完整等待支持。
        if (preCalls === 2) {
          assert.equal(executed, scenario === 'resume' ? 1 : 0)
          assert.equal(requests, scenario === 'resume' ? 3 : 2)
        } else {
          assert.equal(preCalls, 1)
          assert.equal(executed, 1)
          assert.equal(requests, 3)
        }
        console.log(JSON.stringify({ scenario: `defer-${scenario}`, preToolHooks: preCalls, executed, modelRequests: requests, resumeRechecked: preCalls === 2 }))
        if (scenario === 'new-input') assert.ok(JSON.stringify(bodies.at(-1).messages).includes('用户新输入'))
      }
    } finally { if (savedConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = savedConfig; server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }) }
  })
}
