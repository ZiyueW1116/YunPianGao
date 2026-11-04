import { spawnSync } from "node:child_process"
if (!process.env.CODEX_BIN) throw new Error("请用 CODEX_BIN 指定独立安装的 Codex 0.166.0；目标宿主验收不允许跳过。")
const result = spawnSync(process.execPath, ["--test", ...process.argv.slice(2), "test/codex-runtime.test.mjs"], { stdio: "inherit", env: process.env })
if (result.error) throw result.error
process.exitCode = result.status ?? 1
