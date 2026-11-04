# Pi Coding Agent 接入状态

适用入口为 Pi Coding Agent 1.5.0 的 `createPiSession()` 正式 SDK 集成。适配器实现见 [pi.ts](../pi.ts)。

| 核心能力 | 状态 | 接入边界 |
|---|---|---|
| 空闲摘要及提交复核 | 支持 | 使用 Pi 原生摘要函数。准备期间输入或模型变化可使结果失效，原生 compact hook 在替换前复核指纹。 |
| 具体任务 handle | 支持 | 管理本机进程和独立 SDK 子 session。子 session 禁用扩展。 |
| 等待、重等与独立取消 | 支持 | 已就绪时由原工具调用回包。仍需等待时结束当前轮，在 `agent_settled` 后激活。超时或新输入只结束本次等待。取消使用 `cancel_task`。 |
| 任务要求介入 | 未接入 | 当前子 session 没有可转发的扩展 UI 或权限请求，核心仍保留 `input_required`。 |
| 通知补偿与单次接续 | 支持 | 查询本地执行源补偿通知遗漏。通过原生 custom message 开启下一轮，按等待 ID 从会话条目确认接纳。 |
| 等待期间压缩 | 支持 | 压缩期间保留已就绪结果，压缩结束后接续。原生 compact 期间拒绝新 prompt，输入由嵌入方保留。 |
| 结构化依赖 | 支持 | 进程内快照保留 handle、期限、结果与恢复原因，后续请求重新注入普通上下文。 |
| 生命周期 | 支持 | SDK close、原生 shutdown、fork 或 reload 使旧实例失效。独立进程不因关闭等待而取消。 |

普通 `pi -e` 扩展入口未接入。验收使用真实 SDK 和预设模型替身，真实模型自主行为与 Windows 尚未验证。详见 [Pi 适配契约](../../../docs/adapters.md#pi-coding-agent-150) 与 [Pi 验证记录](../../../docs/validation.md#pi-coding-agent-150)。
