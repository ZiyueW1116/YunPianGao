# 云片糕 · YunPianGao

在回答完成后的空闲窗口准备上下文摘要，供下一轮接续工作。

调度核心通过 `CompactionPort` 接入 Harness。当前提供 **OpenCode 2.1.4** 适配器，默认使用临时生成接口准备摘要，再交给原生 compact 提交。

## 工作方式

1. 收到执行成功事件，等待一个短暂的输入窗口。
2. 检查最后一个完整 assistant 回答的 token 用量，达到阈值才开始准备。
3. 在主执行循环之外调用临时摘要接口。新输入到达后，旧准备结果会失效。
4. 仍处于同一空闲轮时，将 compact 排入原生队列；在提交边界复核模型、系统指令和完整历史的指纹。
5. 指纹相同才提交已有摘要；不同时拒绝这次替换，保留完整历史。

新输入可以在摘要准备期间继续处理。模型请求的排队、计费和取消由 Harness 与模型服务管理。

## 在 OpenCode 中使用

当前从源码构建，尚未发布 npm 包。需要 Node.js 22 或更新版本来构建，适配器目标版本为 OpenCode 2.1.4。

```sh
git clone https://github.com/ZiyueW1116/YunPianGao.git
cd YunPianGao
npm ci
npm run build
```

在你准备启用的 OpenCode 配置里添加插件。下面的路径需要替换为克隆目录的实际绝对路径；继续使用原有模型和凭证配置即可。

```json
{
  "plugins": [
    {
      "package": "/absolute/path/to/YunPianGao",
      "options": {
        "thresholdTokens": 480000,
        "idleDelayMs": 1500,
        "strategy": "prepare-then-commit"
      }
    }
  ]
}
```

示例将触发阈值设为 480K，用于判断何时开始准备摘要。阈值应低于原生硬压缩阈值，并为最后一轮增长和摘要生成留出余量；压缩后保留的历史预算由 OpenCode 配置控制。

OpenCode 2.1.4 的显式插件配置要求目录路径；仓库根目录的 `server.js` 提供适配器入口。

| 选项 | 默认值 | 行为 |
|---|---:|---|
| `thresholdTokens` | `100000` | 最近完整回答的 input、cache read、cache write 和 output token 总和达到该值时准备压缩 |
| `idleDelayMs` | `1500` | 执行成功后等待的毫秒数，新输入会取消该次计划 |
| `strategy` | `prepare-then-commit` | 先临时生成，再复核并提交；`direct` 则在空闲时直接排队调用原生 compact |

适配器仅处理当前工作目录中已成功结束的顶层会话。原生自动压缩配置继续由 OpenCode 管理，可以与 YunPianGao 一起启用。

## 接入其他 Harness

通用入口导出 `createYunPianGao`，OpenCode 适配器单独导出于 `@ziyuew1116/yunpiangao/opencode`。核心不导入 OpenCode SDK；源码见 [scheduler.ts](src/scheduler.ts)。

宿主需要提供完成与输入事件、读取最近完整回答、临时生成摘要、原生排队提交和等待完成的能力，并能在持久化边界复核当前上下文。仅有事件通知还不足以安全替换上下文。接口及生命周期约定见 [适配契约](docs/adapters.md)。

## 运行边界与停用

- 摘要使用自定义提示词，移除工具定义，并请求最多 4,096 output tokens。具体生成设置、质量评估方法和测试覆盖范围见 [验证文档](docs/validation.md)。
- 模型摘要可能遗漏信息或延续已过期的临时要求，续跑质量应在独立会话中评估。
- 新输入使准备中的摘要结果失效；已发出的模型请求可能继续计算并计费。
- `direct` 只使用原生排队接口；该接口没有原子的“仅当仍空闲时执行”条件。
- OpenCode 适配器使用 2.1.4 的文本摘要接口；provider 原生不透明替换窗口需要单独适配。
- 卸载时会取消本地定时器和进行中的客户端请求。已交给原生队列的控制项可能继续执行。

停用时删除对应插件配置，并重启相应 OpenCode 进程。停用不自动撤销已经完成的压缩；需要恢复时使用 Harness 自身的会话分支、还原或备份机制。

## 隐私

库与适配器通过宿主 API 工作，不直接读写会话数据库，也不读取凭证文件。项目没有遥测服务，不保存聊天历史；默认诊断只输出固定错误提示，不包含会话内容或模型凭证。

准备摘要时，会话上下文通过 Harness 发送给你配置的模型服务。

## TODO

- [ ] [基于任务 handle 的 `wait_for` 机制](docs/todo.md)：等待长工具调用或子 Agent，在终态、超时或需要介入时恢复 session，减少猜测时长的长 `sleep` 和反复查询。尚未实现。

## 开发与验证

```sh
npm ci
npm run check
npm test
npm run audit:public
npm pack --dry-run
```

真实 OpenCode 入口的本地合成检查：

```sh
OPENCODE_BIN=/absolute/path/to/opencode npm run test:runtime
```

该检查连接本地合成模型服务，使用预设回复和 token 用量触发调度。每个场景使用独立工作目录和会话库，检查结束后清理。测试覆盖范围见 [验证文档](docs/validation.md)。

## 许可证

[MIT](LICENSE)。
