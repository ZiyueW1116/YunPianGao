# OpenHands Software Agent SDK 入口

入口为 Python 包 `yunpiangao-openhands` 的 `OpenHandsSession`，配合构建后的 `dist/adapters/openhands-core.js`。固定宿主为 `openhands-sdk==1.59.0`，官方 tag 对应 commit `ccae18cb897bef7960f210aa3f380b577a84be7c`。这是本地 SDK 嵌入入口，不是 OpenHands CLI、远端 Agent Server 或浏览器插件。代码流和数据流见[自包含 HTML](openhands.html)。

## 安装与启动

需要 Node.js 22 及以上、Python 3.12 及以上。以下操作在独立 checkout 中运行；Python 虚拟环境、缓存及测试产物都保留在被忽略的 `.runtime/` 下。

```sh
npm ci
npm run build
uv venv --python 3.13 .runtime/venv
UV_CACHE_DIR="$PWD/.runtime/uv-cache" uv pip install --python .runtime/venv/bin/python -r python/requirements.lock
UV_CACHE_DIR="$PWD/.runtime/uv-cache" uv pip install --python .runtime/venv/bin/python --no-deps -e ./python
# 需要 wheel 时构建可安装产物。
UV_CACHE_DIR="$PWD/.runtime/uv-cache" uv build python --wheel --out-dir .runtime/python-dist
```

SDK 嵌入示例：

```python
import os
from pathlib import Path
from openhands.sdk import Agent, LLM
from openhands.sdk.context.condenser import LLMSummarizingCondenser
from yunpiangao_openhands import OpenHandsSession

root = Path.cwd()
state = root / ".runtime" / "openhands"
llm = LLM(model=os.environ["LLM_MODEL"],
          api_key=os.environ.get("LLM_API_KEY"),
          base_url=os.environ.get("LLM_BASE_URL"))
agent = Agent(llm=llm, condenser=LLMSummarizingCondenser(
    llm=llm.model_copy(update={"usage_id": "condenser"})))
ypg = OpenHandsSession(
    agent=agent, workspace=str(root),
    core_entry=root / "dist/adapters/openhands-core.js",
    persistence_dir=state / "sessions", profile_store_dir=state / "profiles",
    scheduling={"thresholdTokens": 100000, "idleDelayMs": 1500},
    visualizer=None,
)
try:
    ypg.prompt("启动后台任务；需要结果时使用 wait_for。").result()
    # 保持应用存活；prompt 返回后，runtime 仍可启动新的原生 run。
    ypg.prompt("新输入只结束当前等待，任务继续。").result()
    print(ypg.snapshot())
finally:
    ypg.close().result()
```

也可使用交互入口。调用前设置自己的 `LLM_MODEL`，按模型服务要求设置 `LLM_API_KEY`、`LLM_BASE_URL`。如需隔离 SDK 用户状态，必须在导入 SDK 前设置绝对路径的 `OH_PERSISTENCE_DIR`；不依赖 XDG。入口不读取或复制现有用户配置。

```sh
OH_PERSISTENCE_DIR="$PWD/.runtime/openhands/user" \
.runtime/venv/bin/yunpiangao-openhands \
  --core-entry "$PWD/dist/adapters/openhands-core.js" \
  --workspace "$PWD" --state-dir "$PWD/.runtime/openhands" \
  --prompt '启动后台任务，使用具体 handle 等待。'
```

交互入口处理一轮初始输入后保持运行；输入 `/quit` 关闭。任务接续由 runtime 处理，不需要再次输入来唤醒。卸载 Python 包并停止嵌入应用即可停用；已提交的原生压缩需通过 SDK 自身会话分支或备份恢复。

## 工具与执行

| 工具 | 输入 | 行为 |
|---|---|---|
| `start_process` | `command`、`args` | 复用 Node 进程源，不经 shell，在当前目录启动；输出合并保留末尾 64 KiB；返回具体执行 handle |
| `start_subagent` | `prompt`、`description` | 创建独立本地 Conversation 和 Agent 对象图，沿用模型和原生工具；不加载云片糕工具；返回本次执行 handle |
| `wait_for` | `handle`、`timeout` | 秒数，默认 600，范围 0–2,147,483；同一原生步骤最多一次；正常返回等待记录后请求暂停，待 `run()` 返回再激活等待 |
| `cancel_task` | `handle` | 独立取消：进程发送 SIGTERM，子 Conversation 请求步骤边界暂停；回执不等于已经终止 |

超时、新输入、`interrupt()` 只结束单次等待，不取消任务；相同 handle 可以重等。注册前完成、重复或遗漏通知由共用核心的状态读取及单次结算处理。Python 只转换真实执行状态，不复制等待期限、胜出原因或投递重试算法。

子 Conversation 沿用入口传入的原生 hooks、插件、秘密注入及执行限额，并在子会话创建时复制父会话的原生确认策略和安全分析器配置，不自动批准工具。等待确认时，任务状态为 `input_required`，父 Conversation 实际接续。嵌入方取得外部确认决定后调用 `ypg.confirm_subagent(handle, approved=True/False)`，再使用同一个 handle 等待。这个接口没有注册成模型工具。子会话被原生 hook 阻止或因限制结束且没有最终回答时，报告 failed，不把 FINISHED 状态单独当作任务成功。确认只针对宿主当前待确认动作，不替代应用自身的用户身份或授权检查。

`TaskToolSet` 的官方执行器是同步阻塞委派；此入口使用独立 Conversation，未将同步工具包装成已经后台化的任务。进程源使用嵌入应用的本机权限，执行请求经过 OpenHands 原生工具调度和确认策略；入口不更改确认策略或安全分析器。进程不接管 TerminalTool 的执行对象、秘密注册表或工作区环境过滤，调用方应按自定义本地工具的权限范围部署。

## 摘要与提交

完整回答后的空闲窗口由共用 Node 调度器检查最近一次回答用量。Python 复制原生只读 View，在主执行队列之外调用固定版本 `LLMSummarizingCondenser.condense`，保存其原生 `Condensation`，并把摘要文本与指纹交给核心。

指纹覆盖输入代次、完整 Agent 配置、原生可见事件和结构化依赖。新输入先进入核心使旧结果失效，随后按顺序进入原生消息队列。提交调用公开的 `Conversation.condense()`，原生步骤锁与入口接纳锁覆盖宿主指纹复核和事件写入。Node 在同一次同步调用中读取当前依赖、合成完整指纹并调用 `takePrepared`。自定义 Condenser 只在复核通过时返回保存的原生载荷。过期结果使本次提交失败，保留完整历史。

普通模型步骤仍使用原生 Condenser 的自动压缩条件。手动 `ypg.condense()` 使用同一个原生实现。等待期间压缩和结果投递在入口队列串行；结果先到达时由核心保持 ready 状态，压缩完成后再接续。摘要只改变宿主可见历史，依赖、deadline、结果和恢复原因保留在核心状态，每次模型请求通过新的 View 普通用户内容投影提供。任务原始输出只随工具结果或接续消息传递，不写入系统指令。

## 输入、接续与生命周期

`prompt`、`send_message`、`run`、`condense`、`confirm`、`fork` 返回 `concurrent.futures.Future`。`prompt` 合并发送和执行。单独 `send_message` 只入队，之后可调用 `run`。公开的 `ypg.conversation` 是受管 LocalConversation，其对应的原生方法也回到入口队列。入口只管理同步 `run()`，不接入原生 `arun()` 或调用方自行发起的底层 `agent.step()`。不要在 SDK 回调或工具执行器中同步等待主队列上的操作，以免等待自己收尾。

主会话有待确认工具时，`prompt()`、`run()` 和手动或自动压缩均拒绝执行。`prompt()` 此时不会追加消息，需要补充说明时可单独调用 `send_message()`。嵌入方通过 `ypg.confirm(approved=True)` 批准当前批次，或通过 `ypg.confirm(approved=False)` 拒绝，再由入口继续执行。如果排队期间待确认批次发生变化，调用方需要重新核对。原生 `conversation.navigate_to()` 也经同一队列串行执行。任务接续消息仍可入队，待确认期间由明确的确认决定继续执行。

入口选择同步 `Conversation.run()` 的真实执行循环。模型调用期间，新输入立即失效旧资格，但消息须等当前原生执行返回才能交给 `send_message()`；它不是流式 steering。`pause()` 受 SDK 步骤锁约束，不能立即停止正在进行的模型调用或任意工具。`interrupt()` 的暂停请求在独立控制线程发出，不会排在整轮执行之后；关闭也请求暂停，并等待模型调用、工具和在途子会话创建收尾。关闭延迟受调用方配置的 SDK 网络期限和工具协作行为约束。

接续用原生 `send_message(..., sender="yunpiangao.resume:<waitID>")` 接纳，再安排一次 `run()`。入口记录已安排的等待 ID，并通过 SDK 内存事件复核已经接纳的 sender；接纳回执丢失时不会重复追加或重复执行。同一 ID 的幂等性限当前实例，不承诺跨重启重放。

`ypg.close()` 立即停止新操作，返回所有并发调用共用的 Future。它先关闭核心接续资格，再等待主执行、在途创建、子推理、端口处理及原生资源清理。独立进程继续运行，由 Node 消费输出直到退出；因此该核心子进程可能比适配实例存活更久。关闭快照保持关闭时状态，不在后台继续更新。

原生 `conversation.close()`、切换模型/配置以及动态加载插件会使旧适配实例失效。完整 fork 或按 `from_event_id` 分支通过真实 SDK 创建没有云片糕执行对象的独立 Conversation，并关闭旧入口；返回的是原生 Conversation。新的云片糕任务需创建新的 `OpenHandsSession`。SDK 1.59.0 没有该入口可原地复用的 reload 协议；重建入口不恢复旧 handle，保存的聊天记录也不会恢复 Node 状态。入口拒绝传入已有 `conversation_id` 或共享 `file_store`。

首版只支持本地 Conversation、文本原生摘要与进程存续期间的任务。远端 Agent Server、ACPAgent、MCP 配置接管、嵌套云片糕任务、跨重启恢复以及原生 Terminal/TaskToolSet 任务接管不在支持范围。

## 官方接口证据

版本查阅日期为 2026-11-03，以下链接固定源码，不以在线文档更新代替版本契约：

- [CondenserBase 与 RollingCondenser](https://github.com/OpenHands/software-agent-sdk/blob/ccae18cb897bef7960f210aa3f380b577a84be7c/openhands-sdk/openhands/sdk/context/condenser/base.py)：只读 View、新 View 或 Condensation，以及原生自动/显式请求条件。
- [原生摘要与合法遗忘范围](https://github.com/OpenHands/software-agent-sdk/blob/ccae18cb897bef7960f210aa3f380b577a84be7c/openhands-sdk/openhands/sdk/context/condenser/llm_summarizing_condenser.py)：原生提示词、范围计算、生成和硬重置边界。
- [Conversation](https://github.com/OpenHands/software-agent-sdk/blob/ccae18cb897bef7960f210aa3f380b577a84be7c/openhands-sdk/openhands/sdk/conversation/impl/local_conversation.py)：同步 run、pause、send_message、condense、fork 及 close。
- [真实 Agent 批次与 Condensation 提交](https://github.com/OpenHands/software-agent-sdk/blob/ccae18cb897bef7960f210aa3f380b577a84be7c/openhands-sdk/openhands/sdk/agent/agent.py)：先执行整个批次，再发结果事件；condense 结果在本步骤纳入历史。
- [TaskExecutor](https://github.com/OpenHands/software-agent-sdk/blob/ccae18cb897bef7960f210aa3f380b577a84be7c/openhands-tools/openhands/tools/task/impl.py)：blocking-only 委派。

运行验收、隔离目录和模型替身范围见[OpenHands 验证记录](validation.md#openhands-software-agent-sdk-1590)。
