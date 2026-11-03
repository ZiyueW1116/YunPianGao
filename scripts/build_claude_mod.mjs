import { readFile, writeFile, mkdir, cp, rm } from "node:fs/promises"

// Mods 只允许插件内导入；复用核心编译结果，把计时器映射到正式 clock API。
const target = new URL("../dist/claude-mod/", import.meta.url)
await rm(target, { recursive: true, force: true })
await mkdir(target, { recursive: true })
await cp(new URL("../src/adapters/claude-mod/", import.meta.url), target, { recursive: true })
const scheduler = await readFile(new URL("../dist/scheduler.js", import.meta.url), "utf8")
let wait = await readFile(new URL("../dist/wait.js", import.meta.url), "utf8")
const imported = 'import { randomUUID } from "node:crypto";'
if (!wait.startsWith(imported)) throw new Error("等待核心的导入发生变化，请复核 Mods 构建入口。")
wait = wait.slice(imported.length)
if (/^import /m.test(scheduler + wait)) throw new Error("核心新增了运行时导入，请复核 Mods 的依赖边界。")
await writeFile(new URL("hooks/core.mjs", target), `// 由 scripts/build_claude_mod.mjs 从核心生成。\nexport function createCore($) {\nconst setTimeout = (fn, ms) => $.clock.after(ms, fn);\nconst clearTimeout = timer => timer.cancel();\nconst randomUUID = () => crypto.randomUUID();\n${scheduler.replace(/^export (?=class|function)/gm, "")}\n${wait.replace(/^export (?=class|function)/gm, "")}\nreturn { createYunPianGao, createWaitRuntime, StaleSummaryError };\n}\n`)
