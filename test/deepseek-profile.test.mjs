import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { until } from './deepseek/fixture.mjs'
const require = createRequire(import.meta.url)
const cli = join(dirname(require.resolve('@deepseek-ai/dsh/package.json')), 'lib/bin.js')
const deepseek = resolve('dist/adapters/deepseek.js'), driver = resolve('test/deepseek/profile-driver.mjs')

for (const name of ['complete', 'timeout', 'input', 'cancel', 'compact-race', 'child', 'child-input', 'child-cancel', 'child-compact', 'before', 'failure', 'resume-ack', 'resume-consumed', 'notification-lost', 'notification-repeat', 'batch', 'summary-commit', 'summary-stale', 'summary-recheck', 'summary-microtask', 'summary-prompt', 'summary-tools']) {
  test(`dsh sdk-minimal profile：${name}`, { timeout: 20000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'ypg-dsh-profile-')), report = join(root, 'result.json'), overlay = join(root, 'overlay.json')
    const cwd = join(root, 'project'); await mkdir(cwd)
    const rows = [
      { id: 'llm-deepseek', disabled: true },
      { id: 'compaction-basic', disabled: true },
      // 验收保留受限执行策略，不使用 sdk-minimal 的全权限默认值。
      { id: 'sandbox-policy', config: { mode: 'workspace-write', workspaceRoot: cwd } },
      { insert: [
        { id: 'ypg-compaction', name: deepseek, config: { auto: false, thresholdTokens: name.startsWith('summary') ? 100 : 999999, idleDelayMs: 5, pollIntervalMs: 5 } },
        { id: 'ypg-subagent', name: '@deepseek-ai/dsh-subagent' },
        { id: 'ypg-spawn', name: '@deepseek-ai/dsh-subagent-spawn-in-process', config: { providerName: 'spawn' } },
        { id: 'ypg-regression', name: driver },
      ] },
    ]
    await writeFile(overlay, JSON.stringify(rows))
    const child = spawn(process.execPath, [cli, '--profile', 'sdk-minimal', '--patch', overlay], {
      cwd, env: { ...process.env, DSH_HOME: join(root, 'home'), DSH_AGENTS_HOME: join(root, 'agents'), DSH_PRIMARY_RUNTIME: '', DSH_PERSONALIZED_RECOMMENDATIONS: 'false', YPG_SCENARIO: name, YPG_REPORT: report }, stdio: ['pipe', 'pipe', 'pipe'],
    })
    let logs = '', exit
    child.stdout.on('data', (chunk) => { logs += chunk }); child.stderr.on('data', (chunk) => { logs += chunk })
    const exited = new Promise((resolve) => child.on('exit', (code, signal) => { exit = { code, signal }; resolve() }))
    try {
      let result
      await until(async () => {
        try { result = JSON.parse(await readFile(report, 'utf8')); return true } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error }
        if (exit) assert.fail(`dsh 启动失败：${JSON.stringify(exit)}\n${logs}`)
        return false
      }, 3000).catch(error => {
        throw new Error(`等待 dsh sdk-minimal 报告失败（${name}）\n${logs}`, { cause: error })
      })
      assert.equal(result.passed, true, result.error + '\n' + logs)
      const metrics = logs.split('\n').find((line) => line.startsWith('{"scenario"'))
      if (metrics) console.log(metrics)
    } finally {
      child.kill('SIGTERM')
      const watchdog = setTimeout(() => child.kill('SIGKILL'), 3000)
      await exited; clearTimeout(watchdog)
      await rm(root, { recursive: true, force: true })
    }
  })
}
