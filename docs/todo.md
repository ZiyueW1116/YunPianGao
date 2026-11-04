# 后续验证与能力边界

当前主要入口为 Pi Coding Agent 1.5.0 正式 SDK。核心与适配边界、运行期限及取消规则见[适配契约](adapters.md)，实测范围见[验证文档](validation.md)。

- [ ] 使用真实模型对同一批任务比较固定 `sleep`、模型轮询和 `wait_for`，记录自主工具选择、额外唤醒、长 `sleep`、完成到接续延迟和 token 用量；本地合成替身预设工具选择，不证明模型自主行为或改善幅度。
- [ ] 在 Windows 验证独立取消及进程树行为；当前 POSIX 使用进程组 SIGTERM，Windows 分支只向直接进程发送 SIGTERM。
- [ ] 如需 Pi CLI 扩展入口，先确认宿主提供正常工具轮停放的公开扩展契约。1.5.0 的 SDK 有 `finishTurn`，普通扩展回调没有对应 `end` 返回值；不使用阻止工具或中断补丁代替。
- [ ] 如需子 Agent 扩展交互，定义 Pi UI 请求的归属、查询与解除契约，并验证 `input_required` 的真实接续。当前子 session 禁用扩展，不转发 UI 或模拟 OpenCode 的权限与表单协议。

首版 handle、期限、恢复原因与结果只在进程内保存。跨重启恢复、持久化任务框架、已有原生任务接管、复用既有子 session 和嵌套云片糕任务均不在当前支持范围；会话记录持久化不等于执行句柄可恢复。

OpenCode 2.1.4 的公开接口缺口与兼容边界继续记录在[OpenCode 契约](adapters.md#opencode-214)，不作为 Pi 适配的替代证明。

## Hermes 待验证范围

- [ ] 真实模型自主选择 wait_for、摘要保真度与 token 用量比较；当前响应由本地模型替身预设。
- [ ] 原生 CLI、Gateway、HTTP API 的独立接入和各自完成接纳；当前只有固定补丁上的嵌入式入口。
- [ ] 原生生命周期服务的介入事件来源与解除契约；当前没有 input_required 转发或入口内的交互审批。
- [ ] Windows、PTY 交互及记忆提供者 checkpoint。当前要求原地文本压缩，禁用独立记忆与后台复盘。

具体版本、补丁、使用与当前证据见 [Hermes 说明](hermes.md)。
