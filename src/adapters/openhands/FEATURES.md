# OpenHands 接入状态

适用入口为 OpenHands Software Agent SDK 1.59.0 的本地 `OpenHandsSession`。Python 管理真实 Conversation，专用 [Node 桥接](../openhands-core.ts) 复用共享核心。远端 Agent Server 和 ACP 尚未接入。

| 核心能力 | 状态 | 接入边界 |
|---|---|---|
| 空闲摘要及提交复核 | 支持 | 从原生只读 View 在主队列外生成 Condensation，通过 `Conversation.condense()` 与原生步骤锁复核和提交。 |
| 具体任务 handle | 支持 | 管理本机 Node 进程与独立子 Conversation。入口不接管 TerminalTool 或同步 TaskToolSet 的任务。 |
| 等待、重等与独立取消 | 支持 | 正常工具结果后请求暂停，`run()` 返回时激活等待。超时或新输入保留原任务，可重等。独立取消为进程 SIGTERM 或子 Conversation 步骤边界暂停。 |
| 任务要求介入 | 支持 | 子 Conversation 确认请求触发父会话接续。嵌入方通过 `confirm_subagent()` 提交决定，再用同一 handle 等待。 |
| 通知补偿与单次接续 | 支持 | 复核原生执行状态，按等待 ID 和原生 sender 事件确认接纳，避免重复追加和执行。 |
| 等待期间压缩 | 支持 | 原生压缩与就绪接续由入口队列串行处理。 |
| 结构化依赖 | 支持 | 运行时结构化状态在压缩后仍可读取，并通过原生 View 投影为普通用户内容。 |
| 生命周期 | 支持 | close、fork、模型或配置切换等使旧实例失效。原生同步 `run()` 的暂停和取消受步骤边界限制。 |

真实本地 SDK 验收使用预设模型替身。Windows、跨平台进程树取消、远端入口与真实模型尚未验证。详见 [OpenHands 使用与限制](../../../docs/openhands.md) 及 [OpenHands 验证记录](../../../docs/validation.md#openhands-software-agent-sdk-1590)。
