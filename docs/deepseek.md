# DeepSeek Harness 接入

入口为 `@ziyuew1116/yunpiangao/deepseek` 的 Cordis 插件 `DeepSeekCompactionEngine`。它针对官方 DeepSeek Harness `0.2.2-alpha.3`，对应 tag `dsh-v0.2.2-alpha.3`、commit `05b1cae8db6e674c5685101494d4eec24652424a`，需要 Node.js ≥24.9.0。它不通过 Pi 调用 DeepSeek 模型。

本入口需要固定版本的宿主摘要补丁。未打补丁时插件拒绝加载。核心 `scheduler.ts` 与 `wait.ts` 保持独立；补丁只扩展宿主的原生摘要准备和提交复核，不改变会话格式或执行权限。

## 从源码运行

```sh
npm ci
npm run build
node scripts/deepseek-overlay.mjs /tmp/yunpiangao-deepseek.patch.json sdk-minimal
DSH_HOME=/absolute/path/to/isolated-dsh-home \
DSH_AGENTS_HOME=/absolute/path/to/isolated-agents \
  node_modules/.bin/dsh --profile sdk-minimal --patch /tmp/yunpiangao-deepseek.patch.json
```

`build` 和 `check` 会对本仓库安装的 `dsh-compaction-basic` 执行确定性补丁。overlay 生成器只创建指定文件，文件已存在时拒绝覆盖；不会修改现有用户配置。`sdk-minimal` 是官方 stdio JSON-RPC 应用，启动后等待 SDK 客户端请求，不是交互终端。客户端用法见官方 [SDK 说明](https://github.com/deepseek-ai/deepseek-harness/tree/05b1cae8db6e674c5685101494d4eec24652424a/packages/sdk/client)。模型与凭证仍由宿主配置。

生成的 overlay 保留 profile 的执行权限。官方 `sdk-minimal` 默认使用 `danger-full-access`，示例中的独立配置和会话目录只隔离宿主状态。需要工作区写入限制时，在后置 overlay 中将 `sandbox-policy` 的 `mode` 设为 `workspace-write`，并将 `workspaceRoot` 设为项目绝对路径。真实 profile 回归使用此限制。

使用另一套已安装的宿主时，先对该宿主实际解析的包目录运行：

```sh
node scripts/patch-deepseek.mjs /absolute/path/to/node_modules/@deepseek-ai/dsh-compaction-basic
```

补丁同时校验精确版本和两个原始产物的 SHA-256。未知文件拒绝修改；已打补丁可重复执行。安装或更新宿主后须重新检查。npm 包包含补丁工具、源代码差异及 overlay 生成器。

overlay 可为 `sdk`、`web` 或 `headless` 模板生成对应配置；这些模板已有 subagent 服务，只插入云片糕并停用原生 `compaction-basic` 行。真实入口验收覆盖 `sdk-minimal`；其余模板的实际启动、UI 和完整交互尚未验证。自定义 profile 的行 ID 和服务组成必须与模板核对，不能同时加载两个 compaction 服务。

移除 overlay 并重启宿主即可停用适配。若要恢复宿主包原貌，在该独立安装中重新安装精确版本；不要对正在运行的宿主直接替换文件。已经完成的压缩由宿主会话历史管理，停用插件不会撤销它。

## 工具与生命周期

| 工具 | 行为 |
|---|---|
| `start_process` | `command`、`args`；当前原生工作目录，不经 shell。经 `subprocess.resolveExecutable`、当前 `sandboxPolicy` 及 `sandbox.confine` 启动；stdout、stderr 各保留 64 KiB 尾部。返回本次执行 handle。 |
| `start_subagent` | `prompt`、`description`；经原生 `SubagentActivation`，默认 `spawn` provider，`delivery: caller`。返回具体 child 与 message 执行 handle。 |
| `wait_for` | `handle`、可选秒数 `timeout`，默认 600、范围 0–2,147,483。正常工具结果携带 `concludeTurn()` 决策。没有新输入时，等待在原生 `agent/status: idle` 激活。 |
| `cancel_task` | 独立请求取消。进程调用原生 `terminate()`，子 Agent 调用本次 activation 的 `dispose()`。 |

启动工具先预留 handle。宿主提交含该标识的成功工具结果后，runtime 才接受该 handle 的查询、等待与取消。若工具结果被拒绝或移除了 handle，适配器终止未发布进程或释放未发布 activation。

步骤准备或模型执行期间到达的新输入会使旧的等待意图失效。旧 `wait_for` 返回 `user_input`，宿主优先处理排队输入。输入也会结束已注册且尚未结算的等待。超时、新输入与 `interrupt()` 保留底层执行，同 handle 可以重等。核心使用执行源通知与周期查询，并在收到状态时复核 deadline。完成、失败、取消或超时后，runtime 发送带等待 ID 的普通用户消息，开启下一轮。

接纳复核读取原生内存 `snapshotEvents()` 的 `agent/inbox/spliced` 记录，包含已经消费的插入；不只检查 pending inbox。压缩保留这些日志事实，因此消息消费、压缩或接纳回执丢失不会让同一等待再次发送。显式宿主取消已经接纳的输入属于宿主行为，适配器不复活被主动丢弃的消息。

官方 SDK 的 `run()` 在首次 `idle` 返回。对于独立后台进程，`session/wait` 也可能在任务仍运行时返回。需要观察接续的调用方应在提交输入前订阅会话事件，并让宿主进程和订阅跨过停放期，按等待 ID 识别接续消息。

结构化任务、期限、结果与恢复原因保留在进程内。每个原生 pre-step 追加普通上下文快照，由宿主记入 Session，再用于模型请求。压缩后可重新找回依赖与结果；需要完整结果时可重等同一 handle。快照不是跨重启执行恢复承诺。

每个根 Agent 对应独立实例；本地子 Agent 不安装嵌套云片糕工具。`forAgent(agent)` 返回 `snapshot()`、`interrupt()` 和 `close()`。内部摘要方法供 compaction 子类协作使用，不是跨进程 API。`close()` 先同步撤销工具资格，再取消核心请求、父 Agent 当前推理及未发布创建，等待创建、activation 收尾和压缩结束，最后解除注册；重复和同步重入调用共用同一个 Promise。

Agent 被宿主释放时自动关闭对应实例。分支创建新的 Agent 与任务集合，已有实例不迁移；切换时由调用方释放不再使用的 Agent。插件 fiber 卸载关闭旧实例；重载产生的新实例只接管之后创建的根 Agent。没有原地重绑旧 handle 或通过改写 session ID 迁移状态的入口。关闭后的快照保留关闭时状态，不继续刷新；后台进程仍由宿主 subprocess 服务拥有，适配关闭不终止它们，整个宿主服务退出会按其原生规则终止进程。

## 空闲摘要与宿主补丁

完整最终回答后，最近回答的 input、output、cache read、cache write 用量达到 `thresholdTokens`，核心等待 `idleDelayMs` 后提前生成摘要。工具调用轮和压缩本身不充当完整回答。新输入、模型选择、工具或 prompt 注册变化使准备结果失效。

原生 `SummaryResult` 的摘要是 `ContentBlock[]`，同时带 provider、model、maxTokens、usage、rawOutput 和 `llmStreamCall` 回放标记。适配层保留整个对象；核心仅保存文本占位与指纹，不解析原生载荷。生成仍由 `BasicCompactionEngine.summarize` 完成，保留原生 prefix、工具声明、token meter、摘要指令与预算。

官方 `summarize` 只能替换生成器。官方 `compactNow()` 先进入 `runMaintenance()` 再生成摘要；它不能直接实现“无锁提前准备”，异步返回摘要后也缺少同步版本复核。`scripts/deepseek-host.patch.txt` 为固定源码提供两个最小扩展：

- `prepareSummary(agent, signal)` 使用原生 range 选择与 replay 输入，生成完整结果，不持有维护锁、不写压缩标记。
- `beforeCommit(input, agent)` 位于原生稳定性检查之后、同步替换之前。适配器在此调用核心 `takePrepared`；过期结果使本次原生压缩失败，历史保留，不退回另一轮模型摘要。

实际 npm 补丁修改同版本发布 bundle 及声明，真实入口测试运行的是这些修改后的产物。源码差异可在对应 commit 上用 `git apply scripts/deepseek-host.patch.txt` 重建；未声称运行过整个上游源码仓库的全量构建。辅助请求生成、usage、原始输出和替换仍走宿主服务；不写聊天文件或添加伪造摘要消息。

提交指纹覆盖输入代次、当前模型选择、原生请求 header、实际 replay 输入、surface 及结构化依赖。原生稳定性检查与同步 guard 共同保护提交；维护期间新输入由原生 inbox 保留，结果就绪的接续也在维护后执行。注册的 prompt、工具变化有原生事件；外部插件若悄悄修改其闭包数据而不发布宿主事件，不属于可观察的版本保证。

配置在同一 Cordis 行中传入：`thresholdTokens=100000`、`idleDelayMs=1500`、`pollIntervalMs=500`、`graceMs=1000`、`subagentProvider=spawn`。其余字段保持原生 `BasicCompactionConfig`，例如 `auto` 控制宿主硬阈值压缩。接入仅支持 prepare-then-commit，不增加核心 direct 策略。

## 验证与支持边界

```sh
npm run check
npm test
npm run test:deepseek
npm run audit:public
```

`test/deepseek-runtime.test.mjs` 验证真实 Cordis 服务、工具 pipeline、Agent loop、activation、subprocess、原生 compaction、Session 与隔离 JSONL persistence；模型提供者是预设回复的替身。`test/deepseek-profile.test.mjs` 从正式 `dsh --profile sdk-minimal --patch ...` 启动同一插件，通过真实 Loader 和宿主执行循环验收。两类结果分别统计，不能把它们称为真实模型自主行为。

临时项目独立设置 `DSH_HOME`、`DSH_AGENTS_HOME`，JSONL sessions 路径由真实 profile 或显式 root 控制；进程内服务测试不启用用户配置插件。入口测试保留 `workspace-write` 执行策略；不通过全权限模式补齐功能，不访问现有 DSW、用户配置或聊天库。测试退出前等待自己创建的进程实际结束。

2026-11-03，macOS arm64、Node.js 26.3.1：任务正常启动、等待、接续为 3 次父模型请求；超时重等为 4 次；用户输入后重等或独立取消后等待为 5 次；子 Agent 另有 1 次请求。公开回归观测额外模型唤醒和长 `sleep` 为 0；完成到下一轮请求的延迟是本机替身观测值，不能用作生产性能保证。最新具体场景数量与命令结果见[验证记录](validation.md#deepseek-harness-022-alpha3)。

本地委派的原生权限固定为创建时范围，审批会自动拒绝，受委派 Agent 的人工问答也被宿主禁止。本适配器不自动批准、不模拟父子人工交互；子任务可在最终结果中返回限制，由父 Agent 实际接续处理。核心的 `input_required` 状态仍保留，但未提供任意 external subagent provider 的实时介入转发。首版只验收本地 `spawn` activation；外部 provider、Windows、真正 HMR 文件重载、Web UI 和真实模型摘要保真度均未验证。

## 官方证据

所有源码链接固定于 `05b1cae8db6e674c5685101494d4eec24652424a`：

- [工具结果与 concludeTurn](https://github.com/deepseek-ai/deepseek-harness/blob/05b1cae8db6e674c5685101494d4eec24652424a/packages/core/tools/src/contracts.ts)
- [原生 Agent 的 send、maintenance 与生命周期](https://github.com/deepseek-ai/deepseek-harness/blob/05b1cae8db6e674c5685101494d4eec24652424a/packages/core/agent-loop/src/agent.ts)
- [activation 的发布前 signal 和 caller delivery](https://github.com/deepseek-ai/deepseek-harness/blob/05b1cae8db6e674c5685101494d4eec24652424a/packages/subagent/subagent/src/types.ts)
- [原生摘要与 compactNow](https://github.com/deepseek-ai/deepseek-harness/blob/05b1cae8db6e674c5685101494d4eec24652424a/packages/compaction/compaction-basic/src/index.ts)
- [SummaryResult 与回放标记](https://github.com/deepseek-ai/deepseek-harness/blob/05b1cae8db6e674c5685101494d4eec24652424a/packages/compaction/compaction-basic/src/summarizer.ts)
- [同步提交与原生稳定性检查](https://github.com/deepseek-ai/deepseek-harness/blob/05b1cae8db6e674c5685101494d4eec24652424a/packages/compaction/compaction-basic/src/region.ts)
