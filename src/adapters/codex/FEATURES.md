# Codex 接入状态

适用入口为 Codex CLI 0.166.0 的独立 app-server。实验性入口 `createCodexSession()` 使用等待核心。实现见 [codex.ts](../codex.ts)。

| 核心能力 | 状态 | 接入边界 |
|---|---|---|
| 空闲摘要及提交复核 | 未接入 | `thread/compact/start` 无预生成摘要载荷或提交复核接口。当前入口未连接摘要调度器。 |
| 具体任务 handle | 支持 | 管理原生 `command/exec` 调用和独立子 thread 的具体 turn。既有原生任务不纳入 handle。 |
| 等待、重等与独立取消 | 支持 | 等待保持动态工具待回包，结果沿原请求接续。宿主接纳新输入或等待超时后可重等。取消另行调用原生命令 terminate 或子 turn interrupt。 |
| 任务要求介入 | 支持 | 子 thread 的原生权限和交互请求使父等待结算，SDK 调用方按原生协议处理。终端示例只显示介入状态。 |
| 通知补偿与单次接续 | 部分支持 | 使用 `thread/read` 复核遗漏的子 turn 终态及工具接纳。stdio 断开关闭实例，旧待回包工具不能跨连接恢复。 |
| 等待期间压缩 | 未接入 | 原生 compact 会中断待回包工具，入口在活跃 turn 或在途输入期间拒绝压缩。等待结束后可空闲压缩，再用同一 handle 等待。 |
| 结构化依赖 | 支持 | 进程内保留快照。后续输入携带带版本的普通 `untrusted` 上下文，空闲压缩后仍可注入。 |
| 生命周期 | 支持 | close、连接断开、reload、fork 或 switch 使旧实例失效。连接拥有的命令可能随关闭终止。 |

真实 app-server 验收使用预设模型替身。Windows 与真实模型尚未验证。详见 [Codex 使用与限制](../../../docs/codex.md) 及 [Codex 验证记录](../../../docs/validation.md#codex-app-server-01660)。
