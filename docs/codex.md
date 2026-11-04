# Codex 0.166.0 实验性等待入口

入口为 `@ziyuew1116/yunpiangao/codex`，直接管理独立 `codex app-server` 子进程及 stdio JSON-RPC 连接，不使用通用 OpenAI API SDK。仅支持精确版本 `codex-cli 0.166.0`，创建前执行版本检查。默认 Codex app、全局 CLI、认证目录和已有会话不参与运行。

此入口是部分支持：任务等待穿过真实 Codex 执行循环；空闲预生成摘要提交和等待期间压缩未实现。不能据此宣称完成云片糕完整移植。[离线 HTML](codex.html) 展示代码与数据流。

## 安装与运行

```sh
npm ci
npm run build
npm run install:codex
```

`install:codex` 只在当前仓库的 `.host/cli` 安装 npm 精确版本 `@openai/codex@0.166.0`，不覆盖全局 CLI。SDK 的 `codexPath` 应指向安装器生成的原生二进制或可执行 CLI 入口。需 Node.js 22 或更新版本。

macOS arm64 验收使用官方 [rust-v0.166.0 release](https://github.com/openai/codex/releases/tag/rust-v0.166.0) 的 `codex-aarch64-apple-darwin.tar.gz`。也可使用该归档安装；归档 SHA-256 必须为 `c48824462fc57681eafb0925d97b11b589010475613904f570b42fea53e240d5`，解包后二进制 SHA-256 为 `39acf979729dd290f9a24ee38b2914e036c91b65952872e28ae2a6b88a7db7c1`。两者均已实际核对。

准备专用于此集成的 `CODEX_HOME` 和临时或独立项目，在该目录按 Codex 原生方式配置模型服务和认证。SDK 要求显式提供已存在的 `codexHome` 目录。启动前解析实际路径并比较目录身份，拒绝默认 `.codex` 及指向它的别名，包括通过 `env` 指定主目录的情况。测试使用独立配置和无外部认证的本机模型替身。

`CODEX_HOME` 隔离配置、认证与会话路径，但 Codex 原生仍可发现用户主目录中的 `.agents/skills` 元数据。测试在临时配置中设置 `skills.include_instructions = false`、禁用 bundled skills，使其不进入模型输入；该设置没有改变用户的技能目录。嵌入方需按原生配置决定是否显示这些技能。

```js
import { createCodexSession } from "@ziyuew1116/yunpiangao/codex"

const ypg = await createCodexSession({
  codexPath: "/absolute/path/to/codex",
  codexHome: "/absolute/path/to/isolated-codex-home",
  cwd: "/absolute/path/to/project",
  onEvent(message) {
    if (message.method === "item/agentMessage/delta")
      process.stdout.write(message.params.delta)
  },
})
try {
  const execution = await ypg.prompt("启动后台任务，需要结果时使用 wait_for。")
  await execution.completed
  console.log(ypg.snapshot())
} finally {
  await ypg.close()
}
```

终端示例：`node dist/codex-cli.js <Codex 绝对路径> <独立 CODEX_HOME> <项目绝对路径>`。输入 `/interrupt` 结束当前等待和推理，`/compact` 在无活跃轮次时发起原生压缩，`/close` 关闭入口。示例没有审批 UI；需要处理审批的嵌入方应使用 `onEvent` 与 `respondToRequest`。

## 工具与接续

| 工具 | 契约 |
|---|---|
| `start_process` | 以 `command` 和 `args` 调用原生 `command/exec`。用连接内唯一 `processId` 绑定一次执行，直接启动命令。持续读取 stdout 和 stderr，保留合并字节流的最后 64 KiB，再解码为 UTF-8。原生命令启动失败时记录该次执行的失败状态 |
| `start_subagent` | `prompt`；创建独立原生 thread，绑定该次 `turn/start`；不注册云片糕工具；记录回答文本、失败或中断 |
| `wait_for` | `handle`、可选 `timeout`（秒，默认 600，范围 0–2,147,483）；保持本次动态工具待回包；runtime 查询任务状态并等待事件，终态、需要介入或期限到达后返回成功工具结果 |
| `cancel_task` | `handle`；独立调用 `command/exec/terminate` 或子 thread 的 `turn/interrupt`，只返回取消请求回执；最终状态由具体执行确认 |

适配器使用核心 `wait.ts` 的 `TaskHandle`、单次 `WaitRecord`、deadline、先结算规则和查询补偿。成功、失败与取消结果都是正常工具结果的数据，不把任务失败伪装成工具协议错误。同一轮只允许一个待回包 `wait_for`，同批其他工具可以正常完成。没有固定长 `sleep` 或等待模型查询。

等待工具始终属于原生活跃 turn。结果通过原 `item/tool/call` 请求 ID 回包。适配器只认定同一 turn 的成功工具终态为已接纳，确认通知遗漏时通过 `thread/read` 复核同一个工具项。工具失败使等待记录的投递状态变为 `discarded`，已确定的任务结果或等待原因保留。连接断开会关闭实例，结束本地投递。

子任务以 handle 绑定的 turn 的原生结束事件为准。通知遗漏时，从该 turn 已记录完成时间的历史终态恢复状态和回答。缺少完成时间的 `interrupted` 可能只是宿主对未完结历史的投影，查询会继续复核。首轮落盘前若宿主暂时无法列出 turn，适配器继续等待通知或下一次查询。

`prompt(text)` 返回 `{id, completed}`。`completed` 在该原生轮次结束时结算。活跃期间的输入使用带 `expectedTurnId` 的 `turn/steer`；空闲输入使用 `turn/start`。只有宿主接纳新输入后才结束旧等待并返回 `user_input` 工具结果。原生用户消息条目携带输入标识，用于区分宿主已接纳的输入和当前模型已经看到的输入。已接纳且尚未进入模型上下文的新输入会使旧 `wait_for` 意图失效。宿主拒绝的输入保留原等待和等待意图。超时、新输入和 `interrupt()` 不调用任务取消；同 handle 可再次等待。任务输出保留在普通工具内容和 `additionalContext` 的 `untrusted` 条目中，不提升为系统或开发者指令。

`snapshot()` 独立保存任务、具体执行、等待、deadline、恢复原因和结果。后续经入口提交的输入带有这份结构化状态；它不依赖聊天文本仍保留完整工具结果。当前实例关闭后只保留最后观察到的快照，不能用旧 handle 恢复实际执行。

附加上下文包含输入版本；0.166.0 的原生 `AdditionalContextStore` 跨 compact 保留按值去重状态，因此每次新输入都需要不同版本才能重新携带实际依赖。任务输出仍按 `untrusted` 处理。结束等待后可以空闲压缩，再等待同一任务；这不等于在等待保持活跃时完成压缩。

## 权限和生命周期

进程使用 `thread/start` 实际返回的权限 profile 调用 `command/exec`；没有 profile 时才传递实际 sandbox policy。`command/exec` 是宿主客户端发起的沙箱命令接口，不能当作普通模型 shell 工具的逐命令审批协议；本入口不额外承诺 execpolicy 审批。它不会改用 `thread/shellCommand` 或 `process/spawn`：这两个接口在 0.166.0 的文档中明确属于沙箱外执行。

子 thread 使用独立原生工具循环，沿用指定模型、目录及原生配置。需要权限或交互时，父 handle 返回 `input_required`；`onEvent` 保留原生请求内容，嵌入方在得到明确授权后以原生 schema 调用 `respondToRequest(id, result)`，或独立取消子任务。入口不自动批准请求。终端示例只能展示需要介入的状态。

`close()` 先禁止新操作并停止 runtime 等待，再中断父推理，等待在途子 thread 创建、清理和结果收尾，取消连接拥有的命令，最后关闭 app-server。并发及同步重入共享同一个关闭 Promise。Codex 的 `command/exec` 对象归连接所有，原生断线也会请求终止命令；因此独立任务在超时和新输入后继续，但入口关闭不提供后台进程继续运行保证。

POSIX 的原生非 PTY 命令取消使用进程组 SIGKILL，最终协议只返回 exit code。入口在已有取消请求且回执为 137 时标记 `cancelled`，保留原始 exit code 与 `cancellationRequested`；其他非零退出保留 `failed`。该协议不区分信号退出与程序主动返回相同退出码，不能据此证明取消请求与退出的严格因果关系。Windows 未验证。

`reload()`、`fork()`、`switchThread(id)` 都关闭旧实例并创建新实例；旧工具、输入和 interrupt 失效，新实例没有旧任务 handle。会话历史由 Codex 自身 resume/fork 接口读取，不直接改写文件或数据库。首版限定进程存续期间，不承诺跨 app-server 重启恢复执行句柄。切换应只指向此独立配置内由调用方拥有的 thread。

## 明确不支持的能力

- **空闲摘要。** 官方 `thread/compact/start` 只有 `threadId`，没有预生成摘要载荷或提交复核回调。`thread/sample` 可在临时 fork 采样，但不提供压缩替换提交；`thread/inject_items` 只追加模型可见历史。入口不接入 `scheduler.ts`，不以追加摘要冒充压缩，也不读取聊天库补齐能力。
- **等待期间压缩。** 原生 `compact` 处理先调用 `abort_all_tasks(Replaced)`，再创建 `CompactTask`，待回包动态工具因取消而失败。有在途输入提交或活跃 turn 时，`compact()` 拒绝请求，保留用户输入、等待和任务。空闲时才调用原生压缩，并等到控制轮结束。没有交付能保留等待身份的宿主补丁。
- **原生任务接管和嵌套等待。** 已有内置后台终端、已有子 Agent、其他 app-server 客户端及子 thread 的云片糕工具不纳入当前 handle 管理。
- **跨连接恢复。** stdio 故障使实例失效；不能把重新发起 `turn/start` 当作同一次工具回包的可靠重试。

## 固定接口证据

官方 [app-server 文档](https://learn.chatgpt.com/docs/app-server) 与 [Codex SDK 文档](https://developers.openai.com/codex/sdk) 用于定位公开接口。具体顺序按 `rust-v0.166.0` 源码提交 `6ff1e1ca3b30fc8b914720681fcf5fe62e95f856` 核对：

- [动态工具回包与取消](https://github.com/openai/codex/blob/6ff1e1ca3b30fc8b914720681fcf5fe62e95f856/codex-rs/core/src/tools/handlers/dynamic.rs)：先登记 pending response，再发工具请求；回包不含正常结束工具轮的控制字段。
- [轮次循环](https://github.com/openai/codex/blob/6ff1e1ca3b30fc8b914720681fcf5fe62e95f856/codex-rs/core/src/session/turn.rs)：工具完成后继续模型循环；输入队列与压缩在原生执行路径中处理。
- [压缩处理](https://github.com/openai/codex/blob/6ff1e1ca3b30fc8b914720681fcf5fe62e95f856/codex-rs/core/src/session/handlers.rs)：`compact` 先中断旧任务，再启动控制轮。
- [thread 协议](https://github.com/openai/codex/blob/6ff1e1ca3b30fc8b914720681fcf5fe62e95f856/codex-rs/app-server-protocol/src/protocol/v2/thread.rs)：`ThreadCompactStartParams` 只有 thread ID，`ThreadInjectItemsParams` 是追加 items。
- [命令协议](https://github.com/openai/codex/blob/6ff1e1ca3b30fc8b914720681fcf5fe62e95f856/codex-rs/app-server-protocol/src/protocol/v2/command_exec.rs) 与 [命令生命周期](https://github.com/openai/codex/blob/6ff1e1ca3b30fc8b914720681fcf5fe62e95f856/codex-rs/app-server/src/command_exec.rs)：命令属于连接，最终 RPC 回执晚于输出，连接关闭请求终止执行。

接口仍为 experimental。其他 Codex 版本、真实模型自主工具选择、摘要质量、生产延迟与 Windows 均未验证。实际场景与指标见[验证记录](validation.md)。
