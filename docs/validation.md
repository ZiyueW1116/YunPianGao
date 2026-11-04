# 验证范围

## Claude Code / Agent SDK

固定 `@anthropic-ai/claude-agent-sdk@0.3.317` 及其 Claude Code 2.1.317 原生包。在 macOS arm64、Node.js 26.3.1 验证。入口、版本依据、闭源边界和操作契约见 [Claude 使用说明](claude.md)。

`test/claude-runtime.test.mjs` 穿过产品 `createClaudeQuery`、正式 Mods、原生 Bash/子 Agent/权限、流式轮边界、输入、原生压缩与会话 fork。42 项目标验证包含 39 项产品与生命周期场景和 3 项独立 SDK defer 对照。

- 完成、注册前完成、失败、超时后同 handle 重等、新输入及重等、独立取消、同批多个工具、显式结束等待。
- 进程和子 Agent 等待中原生压缩；摘要仍阻塞时任务完成，压缩后才有一次接续；压缩后的请求保留结构化依赖。
- 子 Agent 完成、输入后重等、取消；原生权限 ask 使父会话以 input_required 接续，批准后再等待同一执行。
- 回答后的空闲摘要生成与原生替换；新输入、依赖变化使旧摘要失效；没有改聊天文件或把摘要伪装成用户提交。
- 重复通知与接纳回执丢失时按同一 ID 去重。通知遗漏场景断言收到原生 Bash 终态通知，故障注入扩展拦截了转发给 runtime 的回调。回调阻塞期间周期查询完成接续，放行后模型请求数保持不变。宿主完全漏发 Bash 终态时，缓存没有可供查询的终态。
- 无关原生 Bash 通知送达模型且保留当前等待，目标任务完成后接续一次。SDK 达到轮次上限后结束未停放的等待，覆盖尚在等待及期限已先结算两种状态，并使用同一 handle 重等。停放占满轮次时，宿主拒绝接续，适配器保留首个结果且停止重试。原生压缩后的提示命令实际收到 handle、等待 ID、期限及恢复原因。摘要阈值低于 1 时 SDK 拒绝启动，阈值为 1 时真实 Mods 可完成压缩。
- 原生扩展拒绝子创建、SDK 进程创建失败；interrupt + close 与真实 agent.spawn 前后阶段竞争，没有迟到 handle 或额外父请求；关闭后输入拒绝、同步重入只调用一次 interrupt；准备中的摘要在关闭时被中止，不提交。
- 停放期间 close、/clear、实际代码热重载；旧等待不再接续，独立进程继续完成。原生 SDK fork 的新实例拒绝历史里的旧 handle。没有源码变化的 reloadPlugins 不强行解释为新实例。
- 一个独立 PTY 场景启动正式交互终端，完成 onboarding、合成项目的原生信任检查，经过模型、工具、等待与接续后退出；不是只在 SDK 中加载插件。

生命周期故障只控制正式扩展边界或 SDK 创建/interrupt 调用边界，不替换原生执行循环。SDK 创建失败实验在分配进程前抛错，不声称覆盖闭源宿主任意内部分配异常。创建竞争以被测创建返回之前关闭为标准；已经发出的子请求可以存在，关闭后不能再发布 handle 或产生父接续。

测试每例使用临时项目、`CLAUDE_CONFIG_DIR`、`CLAUDE_CODE_TMPDIR`、空 settingSources 和回环地址的 Anthropic Messages/SSE 替身。defer 的 SDK 历史读取也显式使用同一临时配置根；测试只读正式 SDK 投影，不修改会话文件。SDK 退出等待消费循环，PTY 退出等待原生进程结束，再删除临时目录。未读取现有用户认证、聊天库或 DSW；未用 bypassPermissions。权限测试使用原生 ask 规则与受控 permission host，其余合成工具使用显式允许规则。

普通任务有 3 次父模型请求；超时后重等 4 次；输入后重等或取消 5 次；普通子任务另有 1 次子请求，权限介入场景共 2 次子请求。对预设模型流程断言额外唤醒与长 sleep 均为 0，等待提示为 Mods 生成的零用量消息。长 sleep 指模型实际工具输入里至少 60 秒的 sleep；测试门闩不算模型休眠。2026-11-03 的 148 项全量运行中，按原生 task_updated.end_time 到接续 provider 请求计时，目标场景观测为 11–108 毫秒，不是性能保证。替身主请求通常报告 100 input / 10 output tokens，摘要阈值场景另用合成用量；均不代表真实计费。

`test/claude-defer.test.mjs` 只核实被产品排除的正式替代路径。初始 defer 断言工具未执行。恢复实验分别断言“重新 PreToolUse 复核”与“跳过复核执行原工具”的已观测序列，并记录执行次数及请求数；通过不代表该路径满足产品语义。流式双工具只留下一个 deferred payload；不承诺批量恢复。完整结果与文档差异见 [Claude 边界](claude.md)。

模型回复、工具选择及摘要内容由替身预设。这些结果证明真实宿主的代码路径与生命周期，不证明真实模型自主等待、摘要质量、吞吐改善或生产延迟。实现提交 [c1273b5](https://github.com/ZiyueW1116/YunPianGao/commit/c1273b59a852f33cb6b746dcb46f850713b0b737) 的 [Linux x64 CI](https://github.com/ZiyueW1116/YunPianGao/actions/runs/41665570816) 全部通过：Node.js 22/24 的 check、148 项测试、公开审计和归档检查，以及原有 OpenCode 的 6 个压缩、32 个等待真实场景。Windows、其他架构、远程客户端和真实模型仍需独立验收。

2026-11-04 的隔离运行通过全量 154 项测试，Claude 专项 42 项。完整检查、打包和公开边界审计使用以下命令。

```sh
npm run check
npm test
npm run test:claude
npm run audit:public
npm pack
```

## Codex app-server 0.166.0

目标为官方 `rust-v0.166.0` release 的 macOS arm64 二进制，实际输出 `codex-cli 0.166.0`；源码对应 `6ff1e1ca3b30fc8b914720681fcf5fe62e95f856`。归档与原生二进制 SHA-256 见 [Codex 版本记录](codex.md)。全局 0.147.0 未用于验收。没有宿主源码改动或自行构建的宿主补丁。

`test/codex-runtime.test.mjs` 的宿主场景使用产品 `createCodexSession` 入口和真实 `codex app-server`，其中一项直接运行 `dist/codex-cli.js` 终端入口完成任务接续。本机 Responses SSE 服务只预设模型回复、工具选择和用量，不替换原生执行循环、工具处理器、命令执行、会话记录或压缩实现。handle 从真实工具结果或压缩后重新注入的结构化状态读取。

- 进程完成、注册等待前完成、非零退出、启动失败、超过宿主默认捕获上限的 64 KiB 输出尾部、超时后同 handle 重等、等待中新输入与重等、独立取消、显式 interrupt 后同 handle 重等、同批其他工具完成，以及零期限与完成竞争时的一次接续。
- 独立子 thread 完成、失败、输入后重等、独立取消；原生命令审批使父 handle 返回 `input_required`，明确拒绝后同 handle 可重等并得到子任务最终回答。测试不批准或执行该次提权命令。
- 原生 read-only 权限下写入失败且目标文件不存在；进程只走 `command/exec`，不调用沙箱外的 shellCommand 或 process/spawn。
- 正常回包重复发送仍只有一次模型接续；屏蔽 `item/completed` 确认通知后，经原生 `thread/read` 补偿确认接纳。遗漏子任务的回答与完成事件时，按绑定的具体 turn 查询终态并恢复回答文本。通知屏蔽和回包复制只位于测试的连接边界，未替换宿主循环。
- 未记录完成时间的中断投影保持子任务待确认，真实失败到达后只按失败接续一次。中断抢先于回包时，分别通过真实失败通知和历史复核确认投递已丢弃。模型流期间被拒绝的 steer 保留等待意图。首条输入提交期间压缩请求被拒绝，输入完成后压缩独立结算。门闩和投影复现在连接边界控制时序，模型请求、轮次结束及工具终态由真实宿主产生。
- 使用临时主目录验证指向默认目录的别名在启动宿主前被拒绝。
- 父入口 initialize 或 thread/start 回执处理失败后，实际 app-server 进程退出；子 thread 创建失败不发布 handle；close 等待在途子 thread 创建。故障与门闩位于真实原生响应边界，没有产品故障注入配置。
- reload、fork、switchThread 后旧实例失效、新实例没有旧 handle；close 与在途 fork 或 reload 竞争时不发布替换实例；并发 close 和连接关闭通知中的同步重入获得相同 Promise。
- 空闲原生 compact、close 收尾在途 compact，以及先结束等待再 compact 后重新等待同 handle；压缩后模型输入仍带任务依赖、deadline 和恢复原因，任务原始输出不进入系统或开发者指令。

压缩相关的负对照单独确认能力缺口：产品在活跃 turn 上拒绝 compact，保留等待和任务；测试直接调用同一真实连接的 `thread/compact/start` 时，原等待 turn 变为 interrupted、动态工具失败、独立进程仍在运行，进程完成后不额外唤醒。这个实验不算“等待期间压缩已支持”。空闲预生成摘要和安全提交没有可运行实现，未用 Pi/OpenCode 结果补充证明。

每例建立临时 cwd 和显式独立 CODEX_HOME，配置文件、认证存储模式、会话、数据库、日志和缓存遵循该版本原生目录规则，不假设 XDG。清除测试子进程继承的 `CODEX_*` 会话变量后再设置独立 CODEX_HOME，移除外部 API key，使用 `requires_openai_auth = false` 的本机 provider。临时配置禁用 analytics、OTel、shell snapshot、自动压缩及模型中的技能目录；不改动用户配置、认证或真实会话。Codex 仍会发现主目录技能元数据，测试断言模型请求不含可用技能清单。清理等待原生进程退出后删除临时目录；现有 DSW 服务不参与测试。

运行命令：

```sh
npm run check
CODEX_BIN=/absolute/path/to/codex npm run test:codex
CODEX_BIN=/absolute/path/to/codex npm test
npm run audit:public
npm pack --dry-run
```

`test:codex` 未设置二进制时直接失败；普通 `npm test` 未设置时明确跳过 Codex 场景。

2026-11-04 在隔离的 macOS arm64、Node.js 26.3.1 环境中，`npm run check`、设置 `CODEX_BIN` 后的 `npm test`（156 项）和 `npm run test:codex`（44 项）均通过。

2026-11-03 在 macOS arm64、Node.js 26.3.1 上，目标宿主 37 项及设置二进制后的完整 149 项测试均通过；普通完成流程 3 次父模型请求，超时重等 4 次，用户输入后重等或取消 5 次，显式 interrupt 停在 2 次。普通子任务另有一次子模型请求；权限介入的子任务需要原生命令结果后的第二次子模型请求。

预设流程的额外父模型唤醒和时长至少 60 秒的 sleep 工具调用均为 0。完整等待场景的单独运行中，从原生命令最终回执、子 turn/completed 或具体 turn 终态查询回执的本地接收时刻（TaskSnapshot.finishedAt）到接续 provider 请求观测为 6–25 毫秒；注册前完成包含其预先完成至开始等待的时间。该值不是操作系统精确退出时刻或生产延迟保证。模型与工具选择由替身预设，不证明真实模型自主选择、摘要质量或性能改善。Linux、Windows、跨重启恢复及宿主补丁均未验收。

## OpenHands Software Agent SDK 1.59.0

验收使用 PyPI 的 `openhands-sdk==1.59.0`，对应官方 tag `v1.59.0` 与 commit `ccae18cb897bef7960f210aa3f380b577a84be7c`。接口按[固定官方源码](openhands.md#官方接口证据)核对；未修改宿主源码。Python 入口、跨语言边界和支持范围见 [OpenHands 说明](openhands.md)。

`test/openhands_runtime.py` 从产品 `OpenHandsSession` 创建真实 LocalConversation，由 OpenHands 调用模型、调度工具、发出原生事件、执行 `pause/run/send_message/condense/fork/close`。每个入口启动构建后的 Node 专用桥接，实际调用现有 `scheduler.ts`、`wait.ts` 和 `process.ts`。测试没有替换 Agent 步骤循环；模型是仅监听本机回环地址的 OpenAI-compatible HTTP 替身，工具选择与回复均由它预设。

GitHub Actions 的 `openhands` 任务在 Ubuntu 上使用 Node.js 22 和 Python 3.13，从 `python/requirements.lock` 安装依赖后运行同一套测试。

场景覆盖：

- 进程完成、注册前完成、非零退出、超时后同 handle 重等、等待期间用户输入、独立取消、显式 interrupt，以及同批 wait_for 和另一启动工具正常返回。
- 主 Conversation 待确认时，普通输入、手动压缩和原生 `run` 均被拒绝。任务完成后的接续消息可入队，模型请求等待显式决定。分支切换在当前执行结束后生效，测试使用文件写入验证并发切换及批准和拒绝的结果。
- 在 Python 生成宿主指纹后、Node 取用预备摘要前让真实后台进程完成，验证 Node 使用最新依赖拒绝旧摘要，且原生历史没有新增 Condensation。
- 独立子 Conversation 的正常文本和原生 FinishTool 完成、provider 失败、用户输入后重等、独立取消、等待期间压缩；子任务确认策略产生 input_required，父会话实际接续，外部确认后相同 handle 可再次等待成功。合成写入工具在批准前没有副作用，批准后才执行。另有原生 UserPromptSubmit hook 拒绝子输入的场景：子模型请求为 0，执行限额被继承，没有最终回答的结束状态报告 failed。
- 等待期间手动原生 Condensation；摘要请求仍被门闩阻塞时任务完成，接续只在压缩结束后启动；普通步骤的原生自动压缩仍有效，压缩后的模型请求能找回结构化依赖。
- 回答后的空闲摘要准备与原生提交，准备期间新输入使旧结果失效，以及提交边界输入代次变化后拒绝旧摘要。View 通过 SDK 序列化投影复制，避免复制系统事件内的执行器锁，不修改缓存 View。
- 在途模型请求收到新输入时拒绝旧等待意图；接纳后回执丢失时按原生 sender 复核并去重；子任务通知遗漏时查询补偿、重复通知、完成与 deadline 竞争均只有一次有效接续。
- 主 Conversation 构造前失败与构造后回执失败、子 Conversation 构造前失败/构造后失败/发送初始化失败；不发布失败 handle，已构造对象完成原生清理，恢复边界后可创建成功。
- close 与子构造、发送初始化交错，以及直接通过原生工具对象创建时与 close 竞争；并发 close 共用 Future，晚到对象被清理，不发子模型请求或 handle。原生 close 中同步重入也复用同一次清理。
- 通过受管原生 close、switch_llm、完整 fork、按事件分支以及重建入口使旧实例失效；旧工具和 interrupt 拒绝操作，迟到进程结果不再接续。新入口没有旧任务；关闭期间独立进程继续完成；空闲摘要请求尚未返回时 close 等待原生生成收尾且不提交摘要。
- `python -m yunpiangao_openhands` 的实际命令行入口完成本地模型请求、显示回答、接收 `/quit` 并清理退出。

生命周期门闩只改变公开创建/发送边界的时序；构造失败、直接工具调用和同步重入场景不作为模型自主行为证据。检查中使用 SDK 内存事件和原生对象清理标记进行断言，没有直接访问或修改聊天库。首次创建失败位于 Python 构造调用边界，不证明 SDK 内部每一处任意异常均能完全回滚。

每例使用临时项目及显式 `persistence_dir`、`profile_store_dir`；导入 SDK 前设置独立绝对路径 `OH_PERSISTENCE_DIR`，并隔离 `LOG_DIR`、`TIKTOKEN_CACHE_DIR`、`HF_HOME`，禁用外部 observability 环境。`LITELLM_LOCAL_MODEL_COST_MAP=True` 使用依赖自带元数据；依赖安装及模型分词元数据缓存与运行验证分开，不读取用户配置、真实聊天或模型凭证，不连接上海 DSW。SDK 并不依赖 XDG；上述路径按 1.59.0 的实际源码选择。

运行命令：

```sh
npm run check
npm test
OPENHANDS_PYTHON="$PWD/.runtime/venv/bin/python" npm run test:openhands
npm run audit:public
npm pack --dry-run
```

2026-11-03 在 macOS arm64、Node.js 26.3.1、Python 3.13.18 上验收。完整任务正常启动、等待、接续为 3 次父模型请求；超时重等为 4 次；输入后重等或独立取消后重等为 5 次；显式 interrupt 后保持 2 次。普通子任务另有 1 次子模型请求，权限介入另需原生后续步骤。15 个输出计量记录的任务场景中，额外父模型唤醒和时长至少 60 秒的 sleep 工具调用均为 0；检查读取真实 ActionEvent 参数。测试使用 10 毫秒核心查询间隔，TaskSnapshot.finishedAt 到接续 provider 请求的本次观测为 10–23 毫秒，包含跨语言传递，不是生产性能保证。替身主模型用量通常为每请求 20 tokens，摘要触发首轮为 1,010；这些值用于调度断言，不代表真实计费。

2026-11-03 的验收通过了 112 项 `npm test` 回归和 44 项 OpenHands 真实入口测试。TypeScript 检查、Python 编译、公开内容审计、npm 归档清单、归档解包后的 Python/Node 创建关闭、Python wheel 构建及可安装入口检查通过。上游 Pydantic 关于 TypedDict ReadOnly 的一条 warning 不影响断言。原 Pi/OpenCode 结果未用于替代 OpenHands 验收。

2026-11-04 在同一 SDK 版本下重跑 TypeScript 检查、112 项 `npm test` 回归和 49 项 OpenHands 真实入口测试，均通过。

测试证明固定 SDK 的执行与适配语义，不证明真实模型自主选择、摘要保真度、性能收益或外部服务取消时延。同步 run 的在途请求仍受原生步骤锁和 SDK 网络期限约束；远端 Agent Server、ACP、MCP 配置接管、Windows、跨重启恢复未验证。

## Pi Coding Agent 1.5.0

主要验收使用 npm 锁定的 `@earendil-works/pi-coding-agent@1.5.0`，对应官方 tag `v1.5.0`。官方 [SDK](https://pi.dev/docs/latest/sdk)、[扩展](https://pi.dev/docs/latest/extensions) 和[模型](https://pi.dev/docs/latest/models) 文档用于定位能力；具体签名与执行顺序以安装包声明和[固定版本源码](adapters.md#pi-coding-agent-150)为准。对象为正式 Coding Agent SDK，没有使用 Pi Durable。

`test/pi-runtime.test.mjs` 通过产品 `createPiSession` 入口加载 inline extension，调用原生 `bindExtensions`、`prompt`、工具执行、`finishTurn`、custom message、SessionManager 和 compact。模型服务是仅监听本机回环地址的 OpenAI-compatible SSE 替身，未替换 SDK 的工具或执行循环。`npm test` 包含这些场景；`npm run test:pi` 可单独运行。

20 个完整执行循环场景覆盖：

- 后台进程完成、提前完成、非零退出、超时后同一 handle 重等、等待中用户输入及重等、独立取消、显式 interrupt、接纳回执丢失后的去重，以及模型请求期间新输入使旧等待意图失效。
- 进程与子 Agent 等待期间原生 compact；任务在摘要请求仍阻塞时完成，只在 compact 结束后接续，压缩后的请求仍收到结构化依赖。
- 独立 Pi 子 session 完成、用户输入后重等、独立取消、provider 失败，父 session 实际接续。
- 同一工具批次含等待和另一个进程启动时，两者都正常返回，在原生轮边界停放；没有 OpenCode 的单工具中断限制。
- 回答后的空闲期准备并提交摘要；准备期间新输入使结果失效；准备完成后、提交边界前系统提示变化时拒绝旧摘要，不额外调用原生摘要模型作为 fallback。

另有 21 个生命周期场景，使用产品入口与原生 SDK 对象；在资源加载、创建回执、绑定或订阅边界注入故障与门闩，检查真实对象的释放、任务注册及模型请求数量：

- 父入口的资源加载、SDK 创建、订阅安装失败；子入口的资源加载、SDK 创建、绑定失败。已有 session 必须释放，失败不发布 handle；恢复边界后独立创建成功。
- close 与子资源加载、绑定入口、绑定完成交错；SDK 创建回执晚于 close；通过工具对象独立发起的创建也被 close 等待。关闭后不启动子模型、不发布 handle，并发 close 都等到清理完成。
- 资源加载或绑定期间的工具取消信号；运行中子推理的关闭、结果收尾与一次释放；关闭期间独立进程继续完成；就绪投递被阻塞在 compact 时关闭，不产生接续。
- 通过原生 `AgentSessionRuntime.dispose()`、文件会话 fork、内存会话 fork，以及 `session.reload()` 触发 shutdown。旧工具与 interrupt 拒绝操作，无迟到接续；新 fork 实例没有旧任务，旧快照保留原归属。reload 不重新注册旧工具，也不恢复已释放的 session。
- 通过正式 `agent.subscribe(event, signal)` 的 abort 监听器同步重入 close，两次调用获得同一个 Promise；父 session.dispose 与公开 `registerSessionResourceCleanup` 回调均只执行一次。

这些门闩只控制边界时序，没有增加产品故障注入接口或替换 SDK 执行循环。部分创建失败和独立工具调用场景不经过模型轮次；它们验证资源与生命周期契约，不作为模型自主行为证据。SDK 创建故障注入位于 `SessionManager.buildSessionContext()`，早于 AgentSession 分配；已返回对象的失败清理由后续绑定和订阅故障覆盖，不声称验证 SDK 内部“分配后、返回前”任意异常的资源释放。

通用 `wait.test.mjs` 另覆盖注册前完成、重复通知、完成与期限竞争、查询失败与断线补偿、需要介入及解除、一次有效接续、handle 归属、取消与卸载。`scheduler.test.mjs` 覆盖阈值、输入竞争、失效、重复触发、指纹及生命周期。Pi 进程内事件不经过远端 SSE，未照搬 OpenCode 的重连或 idle 推断补丁。

隔离方式按 1.5.0 的 SDK 与 config 源码核实：每例使用临时 cwd、显式 `agentDir` 和 SessionManager；文件会话使用 `SessionManager.create(cwd, sessionDir)`，内存 fork 与部分恢复检查使用 `SessionManager.inMemory(cwd)`。ModelRuntime 显式指定临时 `authPath`、`modelsPath` 与 `modelsStorePath`，禁用初始模型刷新。测试进程还设置 `PI_CODING_AGENT_DIR`、`PI_CODING_AGENT_SESSION_DIR` 与 `PI_OFFLINE`，隔离主题、辅助二进制和默认会话路径；不假设遵循 XDG。无扩展包配置、无现有用户配置、无外部服务请求，任务状态在内存中。清理前等待独立进程实际退出，再删除临时目录。上海 DSW 服务、配置和会话库不参与测试。

2026-11-03 在 macOS arm64、Node.js 26.3.1 上运行上述场景：普通任务父 session 为 3 次模型请求；超时后重等为 4 次；输入后重等或输入后取消再等待为 5 次；显式 interrupt 后停在 2 次。子 Agent 场景另有 1 次子模型请求。完整执行循环场景断言接续条目数量与等待 ID，额外父模型唤醒及长 `sleep` 调用均为 0。测试从实际原生会话工具参数统计长 `sleep`（时长至少 60 秒），从 TaskSnapshot.finishedAt 到接续 provider 请求统计延迟；本次单独 Pi 运行观测为 1–10 毫秒，不是性能保证。

验收命令 `npm run check`、`npm test` 中的 112 项共享、Pi 与 OpenCode 测试、`npm run test:pi`（41 项）、`npm run audit:public` 与 npm 归档内容检查均通过。Codex 的额外场景和二进制要求见上节。OpenCode 兼容入口的 6 个压缩和 32 个等待真实场景沿用此前验收记录，生命周期修订未重跑；这些结果不代替 Pi 验收。

模型回复、工具选择及用量均由替身预设。上述结果证明 Pi 真实 SDK 的执行与接续路径，不证明真实模型自主选择 `wait_for`、摘要质量、性能改善或生产延迟。真实模型对照评估、Windows 和扩展 UI 请求转发仍未验证。

## OpenCode 兼容验证

### 公开测试

调度测试覆盖阈值、成功与失败事件、新输入竞争、过期结果丢弃、提交指纹变化、跨会话隔离、重复触发、失败恢复、direct 策略和卸载取消。

`test/runtime.py` 使用真实 OpenCode 接口和本地合成模型服务，6 个场景检查未触发、准备后提交、输入到达时的并发接续、摘要请求失败、direct 原生路径，以及已注册任务的依赖稳定时复用准备好的摘要。组合场景在后台进程仍阻塞时完成准备与提交，检查只有一次 generate、没有额外 compaction 模型请求，后续主模型仍收到 runtime 依赖。每个场景使用新的会话库，并在停止进程后做 SQLite `quick_check`。

测试回复和 token 用量由本地服务预设，无需外部模型账号。公开测试覆盖调度和会话接续，未包含真实模型的摘要质量或吞吐量基准。

### 任务等待验证

`test/wait.test.mjs` 覆盖成功、失败、取消、介入解除后无事件再次等待、先完成后注册、超时后再次等待、完成与超时竞争、输入与中断、期限调整、通知遗漏、查询断线、仅查询端口、接续响应丢失重试、状态副本、handle 归属和卸载。强停止等待覆盖未激活、等待重试、在途投递成功与失败；卸载检查已发起取消请求的清理完成。`test/opencode-wait.test.mjs` 验证宿主中断通知晚到、固定 synthetic 标识、流式输出中的并行工具检查、新输入版本、子会话原始输入被压缩移除、内部停车与外部中断的 idle 归属、取消停车中的子任务、删除子会话、停车失败收尾、旧停车回执及旧中断查询不影响新等待、表单创建与关闭、单任务取消回执，以及任务结果不会进入系统指令。`test/adapter.test.mjs` 验证事件订阅重连与卸载。

原生清理屏障回归让终态提交必须先等待工具返回，再推进 `idle`，分别覆盖旧值未定义和上轮代次仍在的情况。删除恢复检查接续及重连查询中的确定缺失、普通错误和错误 session/tag 的负对照，以及卸载时取消 owner 的本地复核。

逻辑子任务回归区分控制项与实际回答，覆盖内部等待未结束、结果已投递但新回答未结束、回答已完成但其后 idle 尚未出现，以及 compact 后取消。新回答时间等于或小于停车 idle 时，仍依靠 assistant ID 和消息顺序正确确认完成。首个成功或失败 marker 后再出现控制项的成功、失败或中断，均保留首个结果；失败 marker 没有配套的 `assistant.error` 时也返回该轮错误。

延迟旧 `get` 响应的回归在新停车建立后返回较早的中断代次，任务读取及事件复核均保留新等待。重连时的 owner 查询同样检查停车对象身份；确认后续中断时结束旧等待，同代 idle 和迟到的旧 owner 查询不结束新等待。

压缩回调测试覆盖仅复核目标 handle、跳过已请求取消的子任务，以及替换前缓存的原始成功或失败不被后续控制项覆盖。预生成摘要复用的 `keepID` 与 `metadata.recent` 形状按 2.1.4 公开 schema 测试：只剩摘要文本与控制项 idle 时返回具体介入诊断，不谎报任务成功或失败。该复用分支的 hook 与尾部保留行为已经固定 tag 源码核对，尚未运行真实预生成摘要组合回归。

`test/runtime_wait.py` 从仓库目录的 `server.js` 加载插件，使用真实 OpenCode 2.1.4 和本地合成模型服务。32 个场景分别检查：

- 进程完成、注册前完成、非零退出、超时后再次等待、等待期间用户输入、独立取消、等待期间原生压缩，以及重复接纳同一 synthetic 输入。
- 子 Agent 完成、等待期间用户输入、独立取消、权限请求批准后再次等待成功、`question` 介入、内部等待进程、子会话压缩，以及原生 `websearch` 提供者选择表单的介入与取消。搜索在选择表单处取消，不访问外部搜索服务。
- 取消内部停车的子 Agent 后，分别让进程成功或等待到期，均无子会话 synthetic 接续或额外模型请求，独立进程仍然完成。
- 删除 owner 会话后停止接续与告警；独立删除子会话后父等待得到一次取消结果，无持续查询失败。
- 停车后原生压缩另启执行，在压缩请求中调用真正的宿主中断接口，旧等待随中断结束，进程不被取消且完成后不再唤醒。
- 真实事件流在 owner 或子会话删除事件送达前断开：重连复核在进程仍未完成时发现 owner 消失并结束等待，子会话查询则使父 handle 返回取消，均无持续失败告警。故障只由 `test/disconnected` 包装真实插件入口注入，不提供产品选项。
- 子会话内部停车后 compact 成功或失败，进程仍阻塞时父会话不接续；内部结果投递后再阻塞真实新模型请求，旧控制项 outcome 也不提前完成任务。最终正常回答、真实 provider 错误和连续三次 `length` 分别返回成功或可说明的失败。
- 内部停车后 compact 成功，再取消子任务，原生中断为 no-op 时父等待仍得到取消结果，子会话不再被等待唤醒，独立进程继续完成。
- 子会话内部停车后 compact 另启执行，再通过宿主 API 中断；事件流漏掉该次中断时，查询复核使父等待只收到一次取消，子会话不会在进程完成后再次唤醒，进程仍正常完成。
- 普通子任务真实 provider 失败后紧接 compact 成功或失败，执行通知在原任务终态到控制项结束之间丢失：压缩前的定向复核保留原任务失败与错误。原生 manual compact 请求失败时，控制项执行仍可能以 `succeeded` 结束，不能据此改写原任务结果。
- 进程 owner 停车后 compact 另启执行，再通过宿主 API 中断；事件流漏掉第二次 owner 中断时，重连查询在进程仍被阻塞时确认中断并结束等待，进程完成后没有 synthetic 或额外模型唤醒。

保留 owner 的场景检查模型请求与 synthetic 消息数量；删除 owner 的场景检查模型请求数不再增加且没有接续失败告警。用户输入场景在任务仍被阻塞时完成新一轮回答，并检查进程或子会话仍然运行。成功接续的压缩场景在任务未结束时完成原生 compact，后续模型请求仍收到 runtime 依赖状态。测试完成后释放合成任务、停止宿主并执行独立会话库的 SQLite `quick_check`。

每个场景建立临时工作目录及独立 `XDG_CONFIG_HOME`、`XDG_DATA_HOME`、`XDG_STATE_HOME`、`XDG_CACHE_HOME`、`OPENCODE_CONFIG_DIR`。测试不连接现有服务，不读取已有会话或外部模型凭证。运行命令：

```sh
OPENCODE_BIN=/absolute/path/to/opencode npm run test:runtime
```

测试输出记录父 session 的模型请求数、相对预设流程的不必要唤醒次数、长 `sleep` 工具调用数、合成 token 用量，以及任务完成到接续模型请求的延迟。长 `sleep` 指工具输入中时长至少 60 秒的 shell `sleep`；合成任务内部的短周期门闩检查不计入该指标。token 用量由替身固定为每次父 session 请求 1,010，不代表真实模型计费。

2026-11-03 的 macOS arm64 检查中，正常启动、等待、接续共 3 次父模型请求；超时后再次等待为 4 次；用户输入后独立取消再等待或权限批准后重等为 5 次；删除 owner 或外部中断后停在 2 次。完整 32 场景均无额外模型唤醒或长 `sleep` 调用。部分内部停车后取消场景的快照时间沿用宿主此前停车的 `idle`，输出的时间差包含取消前的停留时间。该记录是本地合成检查的观测值，不是性能保证。真实模型是否主动选择 `wait_for`、相对固定休眠或模型轮询的改善幅度，以及平台差异，仍按 [TODO](todo.md) 单独验证。

### OpenCode 摘要生成

OpenCode 适配器使用自定义摘要提示词，移除工具定义，并通过 `maxTokens` 请求最多 4,096 output tokens。返回的摘要须包含七个指定标题，具体提示词见 [适配器源码](../src/adapters/opencode.ts)。

这些生成设置与 OpenCode 原生同步摘要的提示词、工具定义和预算不同。`maxTokens` 的实际约束由模型服务实现，部分入口可能忽略或重新解释该字段。

## 真实模型评估

评估摘要质量时，应检查历史事实和精确标识的保留情况、用户要求的作用范围，以及仅限上一轮的临时限制是否被带入后续任务，并记录摘要后的任务接续结果。

对比调度策略时，统一摘要提示词、工具定义、输出预算、保留历史、触发阈值和后续输入。分别重复摘要生成与摘要后的续跑，覆盖两处的模型随机性，并分别记录摘要长度、质量和吞吐量。

## 兼容范围

- Pi SDK 适配器针对 1.5.0；OpenCode 兼容适配器针对 2.1.4。两者使用各自原生摘要与提交接口。
- Claude SDK 针对 0.3.317，Mods 针对 CLI 2.1.317；支持边界见 [Claude 说明](claude.md)。
- 核心构建输出为 ESM，CI 在 Node.js 22 和 24 上运行检查与测试。
- 其他 Harness 通过 `CompactionPort` 接入；原生不透明替换窗口需要对应的端口实现，见 [适配契约](adapters.md)。
