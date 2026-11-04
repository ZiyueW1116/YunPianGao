import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
const cwd = fileURLToPath(new URL("..", import.meta.url))
const result = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["install", "--prefix", ".host/cli", "--ignore-scripts", "--no-audit", "--no-fund", "@openai/codex@0.166.0"], { cwd, stdio: "inherit" })
if (result.error) throw result.error
process.exitCode = result.status ?? 1
