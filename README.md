# 云片糕 · YunPianGao

在 Agent 执行间隙准备上下文摘要，供下一轮接续工作。

YunPianGao 将调度核心与 Harness 适配器分开。当前提供 **OpenCode 2.1.4** 适配器，使用已完成回答后的空闲窗口准备摘要，再交给原生 compact 提交。其他 Harness 可以实现 `CompactionPort` 接入；目前没有发布其他适配器。

这是实验版本。已有的调度检查不能证明真实模型摘要无损，也没有证明与原生压缩质量等价。

## 工作方式

1. 收到执行成功事件，等待一个短暂的输入窗口。
2. 检查最后一个完整 assistant 回答的 token 用量，达到阈值才开始准备。
3. 在主执行循环之外调用临时摘要接口。新输入到达后，旧准备结果会失效。
4. 仍处于同一空闲轮时，将 compact 排入原生队列；在提交边界复核模型、系统指令和完整历史的指纹。
5. 指纹相同才提交已有摘要；不同时拒绝这次替换，保留完整历史。

新输入不需要等待准备阶段持有会话执行锁。实际模型服务的排队、计费和取消行为仍由 Harness 与模型入口决定。

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

480K 只是大窗口模型的配置示例，需要低于你的原生硬压缩阈值，并留足最后一轮增长及摘要生成的余量。它不是压缩后的目标长度。

OpenCode 2.1.4 的显式插件配置要求目录路径；仓库根目录的 `server.js` 提供适配器入口。

| 选项 | 默认值 | 行为 |
|---|---:|---|
| `thresholdTokens` | `100000` | 最近完整回答的 input、cache read、cache write 和 output token 总和达到该值时准备压缩 |
| `idleDelayMs` | `1500` | 执行成功后等待的毫秒数，新输入会取消该次计划 |
| `strategy` | `prepare-then-commit` | 先临时生成，再复核并提交；`direct` 则在空闲时直接排队调用原生 compact |

适配器仅处理当前工作目录中已成功结束的父会话。原生自动压缩配置继续由 OpenCode 管理；不需要为 YunPianGao 关闭它。插件不修改原生的保留历史预算。

## 接入其他 Harness

通用入口导出 `createYunPianGao`，OpenCode 适配器单独导出于 `@ziyuew1116/yunpiangao/opencode`。核心不导入 OpenCode SDK；源码见 [scheduler.ts](src/scheduler.ts)。

宿主需要提供完成与输入事件、读取最近完整回答、临时生成摘要、原生排队提交和等待完成的能力，并能在持久化边界复核当前上下文。仅有事件通知还不足以安全替换上下文。接口及生命周期约定见 [适配契约](docs/adapters.md)。

## 限制与回退

- 当前 OpenCode 摘要使用自定义提示、移除工具定义，并请求最多 4,096 output tokens。这与原生摘要生成方式不同；部分入口可能不按该字段实施硬限制。详见 [验证范围](docs/validation.md)。
- 摘要可能遗漏信息，或错误地延续上一轮的临时限制。请先在独立会话和独立数据目录中验证自己的工作流。
- 新输入会使旧摘要失效，但不能保证已经发出的模型推理免费或立即停止。
- `direct` 只使用原生排队接口；该接口没有原子的“仅当仍空闲时执行”条件。
- 已验证的是文本摘要路径。其他 OpenCode 版本和 provider 原生不透明压缩格式尚未验证。
- 卸载时会取消本地定时器和进行中的客户端请求。已交给原生队列的控制项可能继续执行。

停用时删除对应插件配置，并重启相应 OpenCode 进程。停用不自动撤销已经完成的压缩；需要恢复时使用 Harness 自身的会话分支、还原或备份机制。

## 隐私

库与适配器通过宿主 API 工作，不直接读写会话数据库，也不读取凭证文件。项目没有遥测服务，不保存聊天历史；默认诊断只输出固定错误提示，不包含会话内容或模型凭证。

摘要生成仍会把上下文发给你在 Harness 中选择的模型服务。公开仓库只含源码和合成测试，不包含真实聊天、评测轨迹、部署地址、账号配置或密钥。

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

该检查只连接本地合成模型服务，为每个场景创建新的工作目录和会话库，检查结束后清理。注入的 token 数仅用于触发调度，不能用于模型质量或吞吐结论。

## 许可证

[MIT](LICENSE)。
