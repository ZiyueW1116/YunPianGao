# 云片糕 · YunPianGao

在回答后的空闲窗口提前准备上下文摘要，通过具体任务的 handle 等待后台进程或子 Agent，并由 runtime 接续 session。

主要适配目标为 **Pi Coding Agent 1.5.0 正式 SDK**（`@earendil-works/pi-coding-agent`），入口为 `@ziyuew1116/yunpiangao/pi`。OpenCode 2.1.4 保留独立[兼容入口](docs/opencode.md)。项目不使用 Pi Durable，不提供跨重启任务恢复。

Codex CLI 0.166.0 提供独立的[实验性等待入口](docs/codex.md) `@ziyuew1116/yunpiangao/codex`，使用真实 app-server 动态工具和原生执行对象。该入口保持等待工具待回包；不支持空闲预生成摘要提交或等待期间压缩，不属于完整云片糕语义移植。代码流与数据流见[Codex 自包含说明](docs/codex.html)。

Hermes Agent v0.22.6 提供独立的 Python 嵌入与终端入口，需要固定版本的最小宿主补丁；使用方法、52 项入口与管道验证和支持边界见 [Hermes 说明](docs/hermes.md) 与[自包含代码流 / 数据流说明](docs/hermes.html)。原版 CLI、Gateway、HTTP API 尚未接入。

## 在 Pi SDK 中使用

当前从源码构建，尚未发布 npm 包。需要 Node.js 22 或更新版本。

```sh
git clone https://github.com/ZiyueW1116/YunPianGao.git
cd YunPianGao
npm ci
npm run build
```

在嵌入 Pi 的应用中调用 SDK 入口。默认读取 Pi 的模型设置和认证；也可显式提供 `modelRuntime`、`model`、`agentDir` 和 `sessionManager`。

```js
import { createPiSession } from "@ziyuew1116/yunpiangao/pi"

const ypg = await createPiSession({ cwd: process.cwd() }, {
  thresholdTokens: 100000,
  idleDelayMs: 1500,
})
await ypg.session.bindExtensions({ mode: "json" })
await ypg.session.prompt("启动后台任务，需要结果时使用 wait_for。")
// prompt 返回后，runtime 仍可在任务完成或等待到期时接续。
// 将 await ypg.close() 接入应用退出流程。
```

嵌入方应维持 session 生命周期，并在退出时调用 `await ypg.close()`。再次输入使用 `session.prompt()`；停止当前等待并中断推理使用 `ypg.interrupt()`；`ypg.snapshot()` 返回结构化任务与等待状态。切换、分支或 reload 会关闭当前适配实例；新的 session 应重新调用 `createPiSession`。入口拥有资源加载器，支持其余 `CreateAgentSessionOptions`，不接收自定义 `resourceLoader`。

这是 SDK 集成入口，不能直接作为 `pi -e` 扩展加载。Pi 1.5.0 的普通扩展回调没有结束正常工具轮的返回值；SDK 使用公开的 `agent.finishTurn` 实现原生停放，详见[接口与能力边界](docs/adapters.md#pi-coding-agent-150)。

## Claude Code / Agent SDK

Claude Code 2.1.317 可加载 `claude --plugin-dir "$PWD/dist/claude-mod"`；Agent SDK 0.3.317 使用 `@ziyuew1116/yunpiangao/claude` 的 `createClaudeQuery`，示例为 `node examples/claude.mjs`。两者复用正式 Mods，支持原生后台任务等待、权限介入、空闲摘要与原生压缩提交。

原生 Bash 完整终态查询仍有接口缺口，因此这条入口不宣称覆盖全部目标语义。版本、输入流生命周期、关闭顺序、真实验证和支持边界见 [Claude 使用说明](docs/claude.md) 与[代码流和数据流](docs/claude.html)。它不是普通 settings hooks 或仅 MCP 的接入。

## OpenHands Software Agent SDK

OpenHands 1.59.0 提供独立 Python SDK 入口 `OpenHandsSession`。每个实例通过专用 Node 子进程复用相同的压缩调度器、等待 runtime 和进程执行源；Python 拥有真实 Conversation、工具与原生 Condensation。需要 Node.js 22 和 Python 3.12 及以上，安装、可运行入口与支持边界见 [OpenHands 使用说明](docs/openhands.md)，代码流与数据流见[自包含 HTML](docs/openhands.html)。

## 两层边界

| 层 | 责任 | 源码 |
|---|---|---|
| 核心 | 空闲调度、摘要失效和指纹复核；任务与单次等待、期限、结算竞争、接续重试及结构化依赖 | [scheduler.ts](src/scheduler.ts)、[wait.ts](src/wait.ts) |
| 适配 | 工具注册、执行与权限边界、宿主事件、停放与接续、原生上下文和压缩提交、生命周期 | [Pi](src/adapters/pi.ts)、[OpenCode](src/adapters/opencode.ts)、[Claude SDK](src/adapters/claude.ts)、[Claude Mods](src/adapters/claude-mod/hooks/register.mjs)、[进程实现](src/adapters/process.ts) |

适配层依赖核心层。核心不导入 Harness SDK、不按 Harness 名称分支、不读写聊天库。`CompactionPort`、`TaskSource` 和 `WaitPort` 对应真实调用边界；没有通用 Harness 基类、注册平台或能力矩阵。接口与生命周期见[适配契约](docs/adapters.md)。

实现范围、代码流、数据流和生命周期图见[设计说明（自包含 HTML）](docs/design.html)。下载后可离线阅读和打印。

新增 Harness 的接口证据、接入难度和建议顺序见[多 Harness 调研（自包含 HTML）](docs/harness-survey.html)；候选结论不代表已新增运行支持。

## 空闲压缩

完整回答后，等待 `idleDelayMs`（默认 1,500 毫秒）。最近完整回答的 input、output、cache read 和 cache write 用量之和达到 `thresholdTokens`（默认 100,000）时，在主执行循环外使用 Pi 原生摘要函数生成临时结果。阈值应低于模型的原生硬压缩阈值，并为最后一轮增长留出余量。

新输入使准备中的摘要失效。提交使用 `session.compact()` 和 `session_before_compact`，复核输入版本、模型、系统提示、原生分支及依赖状态；不一致时取消提交并保留完整历史。Pi 原生摘要生成不附带工具声明；输出预算及摘要格式由锁定版本的 Pi 管理。完整上下文被摘要，原生设置选择的尾部仍保留。Pi 入口仅支持 `prepare-then-commit`；原生自动压缩继续由宿主管理。

## 任务等待

| 工具 | Pi 输入与行为 |
|---|---|
| `start_process` | `command`、`args`；在当前目录启动具体进程，不经 shell，继承环境，返回本次执行的 handle；保留末尾 64 KiB 合并输出 |
| `start_subagent` | `prompt`、`description`；创建独立 Pi SDK session，沿用当前模型、认证和目录，使用原生工具且不加载扩展；返回具体 session 执行的 handle |
| `wait_for` | `handle`、可选 `timeout`（秒，默认 600，范围 0–2,147,483）；每轮只注册一次等待，允许同批其他工具完成；成功返回注册结果后，由原生轮边界停放；runtime 负责等候并接续 |
| `cancel_task` | `handle`；独立请求取消，进程发送 SIGTERM，子 Agent 调用 Pi `abort()`；只返回目标 handle 的请求回执 |

handle 表示一次执行，不能用任务名称或其他工具的标识代替。超时、新输入和 `interrupt()` 只结束本次等待，底层任务继续，可再次等待同一 handle。取消任务使用独立工具，取消为协作式，不保证立即结束。

runtime 在完成、失败、取消、需要介入或超时时结算一次等待。Pi 适配器通过原生 custom message 接续，并用等待 ID 检查接纳；没有 OpenCode 的 `interrupt + synthetic` 桥接或 idle 时间推断。通知可重复或遗漏，runtime 使用状态查询补偿；查询不调用模型，不依赖长 `sleep`。

依赖、期限、结果和恢复原因保存在进程内结构化状态中，在模型请求时以普通上下文重新注入，任务输出不提升为系统指令。等待期间可进行原生压缩；压缩完成后才发送就绪接续。首版不恢复跨重启 handle，聊天持久化也不会改变这个限制。

## 运行边界与隐私

Pi 1.5.0 没有 OpenCode 的 Agent 目录及权限请求协议。子 Agent 使用独立 SDK session；原生工具拥有宿主进程权限，本适配器不增加授权系统或自动批准提示。子 session 不加载扩展，因此不提供嵌套云片糕任务或扩展交互请求的转发。

Pi 在手动 compact 期间拒绝新 prompt；嵌入方需按宿主返回结果保留输入并在压缩后提交。准备摘要期间可以正常输入。空闲状态的原生 `session.abort()` 不产生新的执行事件；停止停放等待应使用 `ypg.interrupt()`。

`close()` 先停止本地调度与接续，再终止父 session 和所拥有的子 session 推理，等待在途创建及子结果收尾，最后释放 SDK 资源；并发调用等待同一次清理。关闭后的工具和 `interrupt()` 拒绝操作，`snapshot()` 保留关闭时的状态；独立后台进程继续运行，输出仍被消费直到退出。原生 `session` 已被释放，不能继续使用。停用 SDK 入口并重启嵌入方即可停止使用；已完成压缩应通过 Pi 自身的会话树或备份恢复。

会话读写只使用宿主 SDK，项目不直接访问聊天库、不读取凭证文件、没有遥测服务。摘要会通过 Pi 发送到你配置的模型服务。公开测试仅含合成对话和本地模型替身。平台与能力限制见[适配契约](docs/adapters.md)，未验证项目见 [TODO](docs/todo.md)。

## 开发与验证

```sh
npm ci
npm run check
npm test
npm run test:pi
npm run test:claude
npm run audit:public
npm pack --dry-run
```

`npm test` 包含核心回归、OpenCode 适配单测、Pi 真实 SDK 与 Claude SDK/Mods 场景；`test:pi` 可单独运行 Pi 场景。Pi 测试使用临时项目、独立配置、会话及模型缓存路径，不连接外部模型或现有 DSW。隔离方式、实测范围和模型替身限制见[验证文档](docs/validation.md)。

## 许可证

[MIT](LICENSE)。
