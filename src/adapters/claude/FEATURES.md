# Claude 接入状态

适用入口为 Claude Code 2.1.317 Mods 与 Agent SDK 0.3.317。两者使用同一插件。SDK 入口见 [claude.ts](../claude.ts)，宿主映射见 [Mods 注册](../claude-mod/hooks/register.mjs)。

| 核心能力 | 状态 | 接入边界 |
|---|---|---|
| 空闲摘要及提交复核 | 支持 | Mods 通过原生 `model.complete` 准备摘要，经 `command.run('compact')` 进入正式替换边界复核并提交。限已支持的内容块与可复核的会话投影。 |
| 具体任务 handle | 支持 | 管理原生后台 Bash 和本次 `agent.spawn` 执行。 |
| 等待、重等与独立取消 | 支持 | Mods 在工具批次后结束当前轮并激活等待。超时或新输入只结束本次等待，可用同一 handle 重等；取消使用原生 TaskStop。SDK 需要存活的输入流及足够的轮次预算。 |
| 任务要求介入 | 支持 | 子 Agent 的原生权限 ask 触发接续。审批由原生界面或 SDK permission host 处理。 |
| 通知补偿与单次接续 | 部分支持 | 子 Agent 可查原生会话，Bash 只可查询已接收的终态通知缓存。宿主完全漏发 Bash 终态时，无法恢复该终态。接续按等待 ID 从原生投影确认接纳。 |
| 等待期间压缩 | 支持 | 原生压缩完成后再接续，压缩后仍可取得结构化依赖。 |
| 结构化依赖 | 支持 | 进程内保存，普通输入和触发模型的斜杠命令均可携带结构化状态。 |
| 生命周期 | 支持 | SDK close、原生 session end 或模块热重载收尾旧实例。fork 创建新实例；SDK 输入流结束遵循宿主退出语义。 |

真实 SDK 与交互终端验收使用预设模型替身。真实模型、Windows 与其他架构尚未验证。详见 [Claude 使用与限制](../../../docs/claude.md) 及 [Claude 验证记录](../../../docs/validation.md#claude-code--agent-sdk)。
