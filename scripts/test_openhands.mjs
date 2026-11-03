import { spawnSync } from "node:child_process"
const run = spawnSync(process.env.OPENHANDS_PYTHON ?? "python3", ["-m", "pytest", "test/openhands_runtime.py", "-v", "-s", "-o", "cache_dir=.runtime/pytest-cache", ...process.argv.slice(2)], { stdio: "inherit" })
if (run.error) console.error("无法启动 OpenHands Python 环境，请按 docs/openhands.md 安装固定依赖。")
process.exit(run.status ?? 1)
