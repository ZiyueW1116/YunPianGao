import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const [destination, profile = 'sdk-minimal'] = process.argv.slice(2)
if (!destination || !['sdk-minimal', 'sdk', 'web', 'headless'].includes(profile)) throw new Error('用法：node scripts/deepseek-overlay.mjs <输出 JSON 路径> [sdk-minimal|sdk|web|headless]')
const plugins = [{ id: 'yunpiangao-deepseek', name: fileURLToPath(new URL('../dist/adapters/deepseek.js', import.meta.url)), config: { thresholdTokens: 100000, idleDelayMs: 1500, pollIntervalMs: 500, auto: true } }]
if (profile === 'sdk-minimal') plugins.push({ id: 'yunpiangao-subagents', name: '@deepseek-ai/dsh-subagent' }, { id: 'yunpiangao-spawn', name: '@deepseek-ai/dsh-subagent-spawn-in-process', config: { providerName: 'spawn' } })
await writeFile(resolve(destination), JSON.stringify([{ id: 'compaction-basic', disabled: true }, { insert: plugins }], null, 2) + '\n', { flag: 'wx', mode: 0o600 })
console.log('DeepSeek overlay 已写入指定文件。')
