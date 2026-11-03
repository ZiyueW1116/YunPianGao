# OpenCode 兼容入口

适配版本为 OpenCode 2.1.4。主要适配目标和接入示例见 [README](../README.md)。

## 配置

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


任务工具参数、权限和中断桥接见[适配契约](adapters.md#opencode-214)。真实入口命令为 `OPENCODE_BIN=/absolute/path/to/opencode npm run test:runtime`，范围见[验证文档](validation.md)。
