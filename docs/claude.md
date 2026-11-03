# Claude Code / Agent SDK

云片糕提供 Claude Code **2.1.317 Mods** 与 **TypeScript Agent SDK 0.3.317** 入口。SDK 入口加载同一 Mods，并给 `close()` 增加原生 interrupt 收尾。核心调度器和等待状态机保持独立；构建仅把核心的计时器、UUID 映射到 Mods 正式环境，不改 Claude 安装包或聊天文件。

已验证任务等待、原生权限介入、空闲预生成摘要、指纹复核提交和生命周期。**原生 Bash 任务没有正式的完整终态查询接口**：runtime 可补偿自己的通知遗漏，但如果宿主完全不交付该进程的原生终态通知，无法从缓存恢复终态，只能等本次期限。这项缺口使本入口不能宣称覆盖全部目标语义。真实模型自主工具选择、摘要保真度、Windows 与其他架构未验证；Linux x64 已通过 Node.js 22/24 的 CI 回归。

## 使用

从仓库执行 `npm ci && npm run build`。终端使用固定版本的 Claude Code：

```sh
claude --version
claude --plugin-dir "$PWD/dist/claude-mod"
```

版本须为 `2.1.317`。本次 macOS arm64 验收也可直接运行 `node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude --plugin-dir "$PWD/dist/claude-mod"`，无需全局 CLI。其他平台的二进制路径按所安装的 SDK 平台包确定，不使用全局最新版本替代。插件无需安装到用户目录。停止使用时退出会话，之后不传 `--plugin-dir`；已提交的压缩通过 Claude 自己的会话机制恢复。

SDK 可运行 `node examples/claude.mjs`，或导入：

```js
import { createClaudeQuery } from '@ziyuew1116/yunpiangao/claude'

const query = createClaudeQuery({
  prompt: inputs, // 持续存活的 AsyncIterable<SDKUserMessage>
  options: { cwd: process.cwd() },
}, { thresholdTokens: 100000, idleDelayMs: 1500 })
const reader = (async () => {
  for await (const message of query) consume(message)
})()
// 应用退出时：
await query.close()
await reader
```

`inputs` 与 `consume` 由嵌入方提供。必须持续消费 Query 并保持输入流存活；EOF 和字符串 prompt 都采用宿主的单轮/退出语义，不承诺回答后的后台接续。`close()` 并发调用共用同一 Promise，先调用正式 `interrupt()`，再关闭 SDK 进程；还须等待消息消费循环结束。关闭后的 `streamInput()` 拒绝输入，原输入迭代器后续产出的消息也不再转交宿主。其余 Query 方法保留原生语义。原生 `interrupt()` 保留宿主语义；停放时可能没有执行事件。结束单次等待使用 `/ypg-interrupt`，它不取消底层任务。

SDK 调度参数覆盖 `settings.pluginConfigs['yunpiangao@inline'].options` 的同名值。终端可通过原生插件配置设置 `thresholdTokens`（正数）和 `idleDelayMs`（非负毫秒），默认分别为 100,000 和 1,500。SDK 的 `settings` 参数使用对象；其余配置、认证、权限和宿主隔离参数沿用官方 SDK。

## 工具与状态

| 工具 | 输入与行为 |
|---|---|
| `start_process` | `command`、可选 `description`；调用原生 Bash 的 `run_in_background`，取得具体 `backgroundTaskId`。这里的 command 是原生 shell 命令，不是 Pi 的 argv 接口。 |
| `start_subagent` | `prompt`、`description`；使用正式 `agent.spawn`，绑定一次原生子 Agent 执行。 |
| `wait_for` | `handle`、可选 `timeout` 秒，默认 600，范围 0–2,147,483；一轮最多登记一次，可与同批其他工具共存。 |
| `cancel_task` | `handle`；通过原生 TaskStop 独立取消。其已停止回执必须包含匹配的 task_id，才更新取消终态。 |

终端和模型看到的完整工具名为 `mcp__yunpiangao__<name>`。`/ypg-status` 返回结构化状态与诊断；`/ypg-close` 停止插件调度并清理其子 Agent，不取消独立 Bash 任务。SDK 在途工具期间的命令可能被宿主排队，应用退出应调用 Query 的 `close()`。

工具登记等待后，原生同批工具先完成。下一次 `turn.step` 通过 Mods 正式流接口输出标明“云片糕”的零用量等待提示并结束一轮；`turn.complete` 激活核心等待。它不是模型请求，也没有声称底层任务已经成功。runtime 使用事件与 100 毫秒状态复核；不让模型查询，不调用长 sleep。

完成、失败、取消、介入和期限竞争同一个 WaitRecord。超时和新输入只结束本次等待，同一执行 handle 可再次等待。SDK 输入在宿主实际处理时触发 `prompt.submit`；在途输入可能先产生一个等待记录，再由该输入将它以 `user_input` 收尾。模型请求代次检查只依据真实 hook 时序，不把客户端发送时间假定为宿主已处理时间。

Bash 终态来自宿主认证的 `task-notification`，与用户文本中的相似标签区分。插件只解析已登记的原生 ID，保留通知摘要和输出文件引用；详细输出仍通过原生 Read 获取。重复通知不会重复结算。子 Agent 使用 `turn.complete` 缓存本次结果，`agent.list()` 和 `session.messages({agentId})` 补偿遗漏；原生 `tool.check` 的 ask 决策产生 `input_required`，工具调用收尾后解除。权限由原生 UI 或 SDK permission host 处理，插件不自动批准。

接续通过 `prompt.submit` 投递普通用户角色数据，携带等待 ID、原因、结果及依赖。接纳回执丢失时读取正式会话投影复核同一 ID，不重复入队。原始输出不作为系统指令。插件拦下自己拥有的原生通知，避免原生通知与 runtime 各产生一次模型请求；其他任务的通知照常交给宿主。

## 摘要与提交

最近一次完整回答的最后一个真实 `turn.step` 用量达到阈值后，核心在空闲窗口准备摘要。输入包括正式会话投影、系统提示章节与依赖；`model.complete` 使用同一模型和原生认证、4,096 output token 预算，不声明工具，不向主会话追加用户消息。摘要请求接受 AbortSignal。文本、工具与 thinking 内容块已纳入检查；遇到其他内容块保留完整历史，不执行这条文本摘要路径。

指纹覆盖输入代次、模型、系统提示、消息投影、原始 API 内容块、工具清单及依赖。准备完成后调用正式 `command.run({command:'compact'})`；在 `session.compact` 的原生替换边界再次读取并复核。通过后返回摘要消息列表，让宿主建立 compact_boundary、替换历史并持久化；不通过则返回 skip，保留完整历史。压缩期间就绪的等待经过原生屏障后接续。没有跨任意其他插件副作用的通用事务保证，其他插件不得在本插件复核之后改写同一提交结果。

2.1.317 的 `session.compact()` 方法在 SDK/headless 中明确报不可用；`command.run('compact')` 已实测可用。在线参考的简表只列 skip，但该 build 导出的正式 `SessionCompactResult` 接受消息列表，真实持久压缩已验证。主会话投影读取有原生数量上限；若准备投影与提交范围不一致，指纹不通过，不截取后强行替换。

## 生命周期与边界

一个实例只服务创建时的 session。`/clear`、resume/切换触发 `session.end`，旧实例关闭；新 SDK session 应重新调用入口。代码热重载销毁旧模块与计时器，创建新 runtime，旧 handle 不恢复。没有源码变化的 `reloadPlugins()` 可以保留模块，不等同于热重载。宿主 `state` 仅保存当前进程内“原生 ID 已归属”的记录，用于阻止热重载后的旧任务通知再次唤醒；不保存输出、等待或执行对象，也不使用持久 store。

SDK 关闭先 interrupt，工具返回后与注册前都复核取消信号；未发布的子 Agent 由原生归属表查找并停止。原生 `Query.close()` 单独使用有收尾窗口，不能替代 SDK 适配入口的关闭顺序。创建失败不发布 handle；父入口进程创建失败可收尾；同步重入只启动一次 interrupt。终端关闭插件后，独立 Bash 进程仍由 Claude 管理；终止整个 Claude 进程对原生任务的影响遵循宿主生命周期。

首版只支持进程存续期间。SDK fork 是新的进程/实例，历史里的 handle 文本不能恢复执行对象；嵌套云片糕工具被拒绝。其他 native agents、外部插件和独立 session 的权限交互不属于本实例。没有对闭源 CLI 打补丁，也没有修改聊天库。

## 验证与证据

运行 `npm run test:claude`。它包含正式 SDK、终端 PTY 和 defer 对照；全部使用临时 cwd、显式 CLAUDE_CONFIG_DIR 与 CLAUDE_CODE_TMPDIR、空 settingSources 和本机 Anthropic 协议模型替身。未使用用户配置、真实聊天、外部模型凭证或 DSW。测试扩展只在原生 hook 边界注入门闩、重复通知和回执故障，不替换 Claude 执行循环。

实际请求计数、延迟与覆盖范围见[验证记录](validation.md#claude-code--agent-sdk)。[自包含 HTML](claude.html) 展示代码流与数据流。

固定依据：

- [Agent SDK 0.3.317](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk/v/0.3.317)，包元数据 claudeCodeVersion 为 2.1.317。
- [SDK 官方接口](https://code.claude.com/docs/en/agent-sdk/typescript)、[正式 defer](https://code.claude.com/docs/en/hooks#defer-a-tool-call-for-later)、[Mods 参考](https://code.claude.com/docs/en/plugins/mods/reference)。在线页会变化，声明以本机 build 为准。
- 在终端以 --plugin-dir 加载后，宿主生成 `.claude-plugin/types/claude-code/index.d.ts`；本次 SHA-256 为 `346bb9c8243cec810b79884a35e05089dcfb2bbc77c325a31e0077aaf5ad5740`，build 时间为 2026-11-02T22:15:13Z。
- 原生 macOS arm64 包的 npm integrity 为 `sha512-SSXvZ04MpfA0hLfGrP9SBTNOgw2p2TsmJAUjr6GA5bM9LVLRLX6pmiIAaTtpaPhslK+zd6Nf5taU/XRldPyUBg==`，下载后已核对。原生执行循环闭源；可检查的 SDK 分发代码、类型与实际行为不等同于拥有该循环的可修改源码。

正式 defer 对照表明：单工具非交互调用返回 tool_deferred，工具尚未执行。SDK 空字符串 resume 观测为 3 次请求，包含额外空输入轮次。恢复在不同运行时序下有两种序列：再次触发 PreToolUse 后执行原调用或继续 defer；或者没有再次触发 PreToolUse 就执行原 Read。携带新输入且重新 defer 的序列会放弃原调用并处理新输入，但不能把它当成该 build 的稳定复核保证。公开对照测试分别断言原调用是否执行及模型请求数，并输出是哪种序列。

流式双工具实验留下一个 deferred 调用、两个工具均未执行，与文档“多工具忽略 defer”的说明不同；不据此承诺批量恢复。交互终端不采用 defer，产品也不把它包装成工具成功。完整 Bash 终态查询与 defer 恢复复核的差异都属于闭源宿主边界，未通过修改聊天记录补齐。
