import { createInterface } from 'node:readline'
import { createClaudeQuery } from '../dist/adapters/claude.js'

const input = createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) })
const messages = (async function* () {
  for await (const line of input) if (line.trim()) yield {
    type: 'user', session_id: '', parent_tool_use_id: null, message: { role: 'user', content: line },
  }
})()
const session = createClaudeQuery({ prompt: messages, options: { cwd: process.cwd() } })
const stop = () => { input.close(); void session.close() }
input.on('SIGINT', stop)
process.once('SIGINT', stop)
try {
  for await (const message of session) {
    if (message.type === 'assistant') for (const part of message.message.content) if (part.type === 'text') console.log(part.text)
    if (message.type === 'result' && message.is_error) console.error('Claude 本轮未完成，请检查原生返回状态。')
  }
} finally { await session.close(); input.close() }
