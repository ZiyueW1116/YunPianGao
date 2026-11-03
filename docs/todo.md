# 后续验证与能力边界

当前主要入口为 Pi Coding Agent 1.5.0 正式 SDK。核心与适配边界、运行期限及取消规则见[适配契约](adapters.md)，实测范围见[验证文档](validation.md)。

- [ ] 使用真实模型对同一批任务比较固定 `sleep`、模型轮询和 `wait_for`，记录自主工具选择、额外唤醒、长 `sleep`、完成到接续延迟和 token 用量；本地合成替身预设工具选择，不证明模型自主行为或改善幅度。
- [ ] 在 Windows 验证独立取消及进程树行为；当前 POSIX 使用进程组 SIGTERM，Windows 分支只向直接进程发送 SIGTERM。
- [ ] 如需 Pi CLI 扩展入口，先确认宿主提供正常工具轮停放的公开扩展契约。1.5.0 的 SDK 有 `finishTurn`，普通扩展回调没有对应 `end` 返回值；不使用阻止工具或中断补丁代替。
- [ ] 如需子 Agent 扩展交互，定义 Pi UI 请求的归属、查询与解除契约，并验证 `input_required` 的真实接续。当前子 session 禁用扩展，不转发 UI 或模拟 OpenCode 的权限与表单协议。

首版 handle、期限、恢复原因与结果只在进程内保存。跨重启恢复、持久化任务框架、已有原生任务接管、复用既有子 session 和嵌套云片糕任务均不在当前支持范围；会话记录持久化不等于执行句柄可恢复。

OpenCode 2.1.4 的公开接口缺口与兼容边界继续记录在[OpenCode 契约](adapters.md#opencode-214)，不作为 Pi 适配的替代证明。

OpenHands 1.59.0 的本地 SDK 入口与边界见 [OpenHands 说明](openhands.md)。真实模型自主工具选择、跨平台进程树取消、远端 Agent Server、ACP、MCP 接管和跨重启执行恢复均未验证；同步 `run()` 的输入排队与步骤边界暂停不代表流式 steering 或即时取消。
