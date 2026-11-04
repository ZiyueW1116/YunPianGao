import { writeFile } from 'node:fs/promises'
import { runScenario, runSummaryScenario } from './scenarios.mjs'
export const name = 'yunpiangao-profile-regression'
export const inject = ['agents', 'agentLoop', 'compaction', 'llm', 'sessions', 'subagents', 'subprocess', 'sandbox', 'sandboxPolicy', 'workingDirectory', 'tools']
export function apply(ctx) {
  ctx.effect(async () => {
    let result
    try { await (process.env.YPG_SCENARIO.startsWith('summary') ? runSummaryScenario : runScenario)(process.env.YPG_SCENARIO, ctx); result = { passed: true } }
    catch (error) { result = { passed: false, error: error.stack } }
    await writeFile(process.env.YPG_REPORT, JSON.stringify(result))
  })
}
