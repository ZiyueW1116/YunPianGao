# DeepSeek Harness 接入状态

适用入口为 DeepSeek Harness 0.2.2-alpha.3 的 Cordis 插件，需应用固定版本的宿主摘要补丁。实现见 [deepseek.ts](../deepseek.ts)。

| 核心能力 | 状态 | 接入边界 |
|---|---|---|
| 空闲摘要及提交复核 | 支持 | 补丁提供无锁 `prepareSummary` 和同步 `beforeCommit`。宿主负责原生摘要载荷与持久化，核心负责提交资格与指纹复核。 |
| 具体任务 handle | 支持 | 管理宿主 subprocess 和本地 `spawn` activation，宿主接纳工具结果后才发布 handle。 |
| 等待、重等与独立取消 | 支持 | 正常工具结果调用 `concludeTurn()`，原生 idle 后激活等待。超时或新输入只结束本次等待，取消另行请求。 |
| 任务要求介入 | 未接入 | 本地委派权限由宿主固定，审批直接拒绝。未接入外部 provider 的实时人工介入。 |
| 通知补偿与单次接续 | 支持 | 事件与原生状态查询共同复核。等待 ID 由原生 inbox 历史确认，消息消费后仍可识别接纳。 |
| 等待期间压缩 | 支持 | 原生维护队列保留任务接续与后到输入，压缩结束后再执行。 |
| 结构化依赖 | 支持 | 任务、期限、结果和恢复原因在进程内保留，每个原生 pre-step 重新加入普通上下文。 |
| 生命周期 | 支持 | 根 Agent dispose 或插件卸载收尾旧实例，新 Agent 使用新任务集合。独立进程由原生服务拥有。 |

真实宿主验收覆盖正式 `sdk-minimal` profile，使用预设模型替身。Web UI、其他 profile、外部 provider、真正的文件 HMR、Windows 与真实模型尚未验证。详见 [DeepSeek 使用与限制](../../../docs/deepseek.md) 及 [DeepSeek 验证记录](../../../docs/validation.md#deepseek-harness-022-alpha3)。
