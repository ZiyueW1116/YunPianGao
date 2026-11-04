import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'

// 固定 npm 产物的补丁；拒绝修改未知版本或未知内容。
const require = createRequire(import.meta.url)
const root = process.argv[2] ? resolve(process.argv[2]) : dirname(require.resolve('@deepseek-ai/dsh-compaction-basic/package.json'))
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
if (pkg.version !== '0.2.2-alpha.3') throw new Error('宿主补丁只支持 0.2.2-alpha.3。')
const replacements = [
  ['lib/index.js', 'eafe4adbccc2b87377e4839f1a6093ebe1a0858caadc6c3dbffef19cb1dbc54b', [
    ['\t\tstage = "commit";', '\t\tdependencies.beforeCommit?.(summarized.input, agent);\n\t\tstage = "commit";'],
    ['\tasync summarize(input, agent, signal) {', `\tasync prepareSummary(agent, signal) {
\t\tsignal?.throwIfAborted();
\t\tconst range = selectCompactableRange(agent.session, this.ctx.tokenMeter.measure(agent.session), 0);
\t\tif (range === null) return null;
\t\tconst nodes = agent.session.surface.nodes;
\t\tconst input = buildSummarizationInput(agent.session, nodes.slice(nodes.indexOf(range.start), nodes.indexOf(range.end) + 1));
\t\treturn { input, result: await this.summarize(input, agent, signal) };
\t}
\tbeforeCommit(input, agent) {}
\tasync summarize(input, agent, signal) {`],
    ['\t\t\tmeter: this.ctx.tokenMeter,', '\t\t\tmeter: this.ctx.tokenMeter,\n\t\t\tbeforeCommit: (input, agent) => this.beforeCommit(input, agent),'],
  ]],
  ['lib/types/index.d.ts', '55678e07cf48061a7650a6da47075815ff55d9ee15d1cad153f3fb23c3238800', [
    ['export declare class BasicCompactionEngine extends CompactionEngine {', `export type { SummarizationInput, SummaryResult } from './summarizer.ts';
export declare class BasicCompactionEngine extends CompactionEngine {
    prepareSummary(agent: Agent, signal?: AbortSignal): Promise<{ input: SummarizationInput; result: SummaryResult } | null>;
    protected beforeCommit(input: SummarizationInput, agent: Agent): void;`],
  ]],
]
const patchedHashes = {
  'lib/index.js': '1c135b8440b42e6262e5319a9fee7057354dc2262172da9321fecdaa10d031e3',
  'lib/types/index.d.ts': '7a710e3513a0d2bac4f4ad9f07281149bd760a0d20eed3c44ad2ed0298b7a650',
}
const updates = []
for (const [file, expected, edits] of replacements) {
  const path = join(root, file), original = await readFile(path, 'utf8')
  const actual = createHash('sha256').update(original).digest('hex')
  if (actual === patchedHashes[file]) continue
  if (actual !== expected) throw new Error(`宿主文件校验失败：${file}`)
  let output = original
  for (const [before, after] of edits) {
    if (output.split(before).length !== 2) throw new Error(`宿主补丁锚点不唯一：${file}`)
    output = output.replace(before, after)
  }
  updates.push([path, '// YUNPIANGAO_PREPARED_SUMMARY_V1\n' + output])
}
for (const [path, output] of updates) await writeFile(path, output)
console.log('DeepSeek 固定版本摘要补丁已就绪。')
