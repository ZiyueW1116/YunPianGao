# OpenCode 接入状态

适用入口为 OpenCode 2.1.4 的兼容插件。摘要和等待适配分别见 [opencode.ts](../opencode.ts) 与 [opencode-wait.ts](../opencode-wait.ts)。

| 核心能力 | 状态 | 接入边界 |
|---|---|---|
| 空闲摘要及提交复核 | 部分支持 | `prepare-then-commit` 使用公开 compaction hook 复核模型、指令与消息。事件流断开后停止空闲调度。`direct` 是独立策略，由宿主即时摘要。 |
| 具体任务 handle | 支持 | 管理本机进程与新建原生子 session。既有原生后台任务不纳入 handle。 |
| 等待、重等与独立取消 | 支持 | 以 `interrupt({resume:true})` 停放，待清理后激活等待。工具历史显示 interrupted，接续是下一轮 synthetic 输入。等待要求当前模型步骤没有其他工具。超时或新输入只结束本次等待，取消另行请求。 |
| 任务要求介入 | 支持 | 可报告权限、question、form，用户在原生界面处理。 |
| 通知补偿与单次接续 | 部分支持 | 以 session 查询补偿任务与 owner 通知，固定 synthetic ID 由宿主 inbox 去重。公开 API 无表单列表，漏掉创建或关闭事件时无法重建表单状态。 |
| 等待期间压缩 | 支持 | 可在停放期间原生压缩并继续等待。若子任务终态尚未缓存且可见窗口只剩压缩控制项，返回需要在宿主确认的诊断。 |
| 结构化依赖 | 支持 | 保存在进程内，后续模型请求重新获得依赖元数据，原始结果随工具或 synthetic 输入传递。 |
| 生命周期 | 支持 | 插件卸载或 owner 删除结束其等待。独立进程仍可运行，子会话的删除与中断遵循宿主规则。 |

真实入口验收使用 OpenCode 2.1.4 与预设模型替身。子会话压缩恰好复用预生成摘要且原始终态无法重建的组合有源码核对与单测，尚无真实入口验收。详见 [OpenCode 适配契约](../../../docs/adapters.md#opencode-214) 与 [OpenCode 验证记录](../../../docs/validation.md#opencode-兼容验证)。
