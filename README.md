# 云片糕 · YunPianGao

在回答完成后的空闲窗口准备上下文摘要，并通过任务 handle 等待后台进程或子 Agent 接续工作。

调度核心通过 `CompactionPort` 接入 Harness。当前提供 **OpenCode 2.1.4** 适配器，默认使用临时生成接口准备摘要，再交给原生 compact 提交。

任务等待通过独立的 `createWaitRuntime` 接入。OpenCode 适配器提供 `start_process`、`start_subagent`、`wait_for` 和 `cancel_task` 四个工具。

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

## 任务等待

插件加载后，Agent 可以先启动任务，再在后续步骤中单独调用 `wait_for`。下面是工具输入示例，`handle` 使用启动工具返回的 `handle.id`：

```json
{"command":"npm","args":["test"]}
```

```json
{"handle":"启动工具返回的 handle.id","timeout":600}
```

| 工具 | 输入与行为 |
|---|---|
| `start_process` | `command` 为可执行文件，`args` 为参数数组；在当前工作目录启动，不通过 shell 解释，继承进程环境；使用 `yunpiangao.process` 权限。立即返回具体执行的 handle，保留最多末尾 64 KiB 的合并输出 |
| `start_subagent` | `agent`、`prompt`、`description`；校验宿主已有的子 Agent 并使用 `subagent` 权限。只允许顶层 session 启动，每次创建独立子会话，继承宿主的模型与权限规则 |
| `wait_for` | `handle`、可选 `timeout`（秒，默认 600，范围 0 至 2,147,483）；暂停当前 session 推理，在成功、失败、取消、需要介入或超时时接续 |
| `cancel_task` | `handle`；独立请求取消任务，只返回该 handle 的请求回执。进程发送 SIGTERM，子 Agent 调用宿主中断接口；取消是协作式的 |

`wait_for` 必须在独立步骤中单独调用。同一步有其他工具时会拒绝等待，避免中断并行工具。超时或用户新输入仅结束本次等待，任务继续运行；可以用同一 handle 再次等待。需要调整期限时，通过新输入结束等待，再指定新期限。

等待关系、期限、结果与恢复原因保存在插件进程内的结构化状态中。后续模型请求会收到这些状态；上下文压缩不会删除依赖。进程事件和子会话事件触发即时复核，等待期间每 500 毫秒查询一次作为遗漏通知与断线时的补偿；查询不调用模型。原生表单的查询恢复限制见[适配契约](docs/adapters.md#opencode-214)。删除 owner 会话会结束其等待与接续重试，插件启动的独立进程继续运行；原生子会话由宿主递归删除。

OpenCode 2.1.4 没有公开的执行停放接口。适配器使用原生中断释放执行循环，再通过固定消息 ID 的 synthetic 输入接续；历史中会出现等待工具被中断的记录。这种接续重新进入 Agent 循环，不恢复任意工具的调用栈。插件工具与原生后台 `shell`、`subagent` 的自动通知互相独立，原生工具返回的标识不能直接作为本插件的 handle。具体能力边界见 [适配契约](docs/adapters.md#任务等待)。

## 接入其他 Harness

通用入口导出 `createYunPianGao`，OpenCode 适配器单独导出于 `@ziyuew1116/yunpiangao/opencode`。核心不导入 OpenCode SDK；源码见 [scheduler.ts](src/scheduler.ts)。

宿主需要提供完成与输入事件、读取最近完整回答、临时生成摘要、原生排队提交和等待完成的能力，并能在持久化边界复核当前上下文。仅有事件通知还不足以安全替换上下文。接口及生命周期约定见 [适配契约](docs/adapters.md)。

## 运行边界与停用

- 摘要使用自定义提示词，移除工具定义，并请求最多 4,096 output tokens。具体生成设置、质量评估方法和测试覆盖范围见 [验证文档](docs/validation.md)。
- 模型摘要可能遗漏信息或延续已过期的临时要求，续跑质量应在独立会话中评估。
- 新输入使准备中的摘要结果失效；已发出的模型请求可能继续计算并计费。
- `direct` 只使用原生排队接口；该接口没有原子的“仅当仍空闲时执行”条件。
- OpenCode 适配器使用 2.1.4 的文本摘要接口；provider 原生不透明替换窗口需要单独适配。
- 卸载时停止本地定时器，并向客户端请求传递取消信号。已由宿主接纳的请求与控制项可能继续执行；任务等待的本地取消边界见适配契约。
- 任务等待仅覆盖插件进程存续期间。卸载或重启会丢失 handle 与等待状态，不隐式取消已启动任务；后台进程输出会继续被消费到进程退出，运行中的子会话由宿主管理。

停用时删除对应插件配置，并重启相应 OpenCode 进程。停用不自动撤销已经完成的压缩；需要恢复时使用 Harness 自身的会话分支、还原或备份机制。

## 隐私

会话读写使用宿主 API，插件不直接读写会话数据库，也不读取凭证文件。后台进程继承宿主环境，按工具输入执行。项目没有遥测服务；任务结果在进程内保存，接续结果通过宿主 synthetic 输入进入会话。默认诊断只输出固定错误提示，不包含会话内容或模型凭证。

准备摘要时，会话上下文通过 Harness 发送给你配置的模型服务。

## TODO

- [任务等待的后续工作](docs/todo.md)：跨重启恢复、原生任务适配，以及真实模型选择与等待策略的对照评估。

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

该检查连接本地合成模型服务，使用预设回复和 token 用量触发压缩与任务等待。每个场景使用独立工作目录及 XDG 配置、数据、状态、缓存目录，检查结束后清理。测试覆盖范围见 [验证文档](docs/validation.md)。

## 许可证

[MIT](LICENSE)。
