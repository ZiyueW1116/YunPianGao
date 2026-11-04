# Hermes Agent 接入

云片糕提供独立的 Python 嵌入入口 `create_hermes_session()` 和终端入口 `python -m yunpiangao_hermes`。宿主固定为 NousResearch Hermes Agent **v0.22.6**，commit **`f0d94882e89ab8d4098b5bb2f166adfb9ee0a0ab`**，并要求从干净的固定版本 checkout 应用本仓库的[宿主补丁](hermes/host.patch)。宿主加载时检查停放契约版本 2。这不是可直接安装进原版 Hermes CLI 的插件。

源码、代码流和数据流见[自包含 HTML 说明](hermes.html)。核心的摘要调度和等待状态机保持共用；本接入不改动 `src/scheduler.ts`、`src/wait.ts` 或 Pi/OpenCode 适配。

## 安装与运行

构建云片糕需要 Node.js 22+；Hermes 运行环境使用 Python **3.14**，安装与验收脚本使用 Python 3。所有源码、环境与用户数据应放在独立目录。以下变量均指向调用者选择的绝对路径，不能指向已有 Hermes 的配置或聊天目录。

```sh
# 在 YunPianGao 源码目录执行
npm ci
npm run build

# 在独立目录下载固定宿主；不要覆盖已有安装
# HERMES_CHECKOUT 为新目录的绝对路径
git clone --depth 1 --branch v0.22.6 https://github.com/NousResearch/hermes-agent.git "$HERMES_CHECKOUT"
python3 scripts/prepare_hermes.py "$HERMES_CHECKOUT"

# HERMES_HOME、HERMES_RUNTIME_DIR、HERMES_ENV、HERMES_CACHE 为独立的绝对路径
export HERMES_HOME HERMES_RUNTIME_DIR
PYTHONPATH="$HERMES_CHECKOUT" python3.14 -m pm.build_env \
  --source "$HERMES_CHECKOUT" --out "$HERMES_ENV" \
  --python "$(command -v python3.14)" --cache "$HERMES_CACHE" --no-install-project

export HERMES_PYTHON="$HERMES_ENV/bin/python"
export PYTHONPATH="$PWD/dist/adapters/hermes:$HERMES_CHECKOUT"
"$HERMES_PYTHON" -m yunpiangao_hermes --agent-options ./hermes-options.json
```

`prepare_hermes.py` 检查精确 HEAD，验证补丁可应用后才写入；重复调用会确认补丁已应用。已有旧版补丁时，从同一固定提交准备新的干净 checkout。安装 Python 依赖使用 Hermes 的 PM 构建入口，从宿主锁文件建立新环境，不改写已有 Python 环境。Windows 的解释器路径为环境的 `Scripts/python.exe`；本接入尚未在 Windows 验收。

`hermes-options.json` 是原生 `AIAgent` 构造参数。模型认证沿用 Hermes 配置，也可按原生参数显式传入；不要公开包含凭证的文件。最小示例：

```json
{
  "model": "your-model",
  "provider": "your-provider",
  "cwd": "/path/to/project",
  "enabled_toolsets": ["terminal", "context_engine"],
  "quiet_mode": true
}
```

终端入口接收普通文本，支持 `/snapshot`、`/compact` 和 `/close`。等待期间可继续输入，完成后会自动显示下一轮回答。EOF 与 `/close` 都等待清理完成。此入口未提供 Hermes CLI 的 `/branch`、`/reload` 或 Gateway 路由命令。

Python 应用可直接使用相同入口：

```python
from yunpiangao_hermes import create_hermes_session

session = await create_hermes_session(
    {"model": "your-model", "provider": "your-provider", "cwd": "/path/to/project",
     "enabled_toolsets": ["terminal", "context_engine"]},
    scheduling={"thresholdTokens": 100000, "idleDelayMs": 1500},
)
try:
    await session.prompt("启动后台任务，需要结果时使用 wait_for。")
    # prompt 返回可能表示已停放；应用继续维持事件循环。
    # 新输入：await session.prompt(text)
    # 每轮结果：await session.events.get()
    # 结构化状态：await session.snapshot()
    # 停止本次等待：await session.interrupt()
finally:
    await session.close()
```

`prompt()` 在输入接纳时使旧摘要失效，再串行进入真实 `AIAgent.run_conversation()`；忙碌时输入保留在调用队列。手动压缩提交期间，输入等原生事务结束后接纳。取消在途 `prompt()` 会等原生轮次收尾并采用它返回的历史，随后向调用方传播取消。停止当前等待使用 `interrupt()`。每次 `close()` 等待同一次清理。调用方超时或取消等待时，只要事件循环仍在运行，清理就会继续。

## 工具与任务归属

| 工具 | 参数与行为 |
|---|---|
| `start_process` | `command`：在宿主原生 terminal 后台执行。命令使用 Hermes 的 shell、环境与审批规则；通过原生调用链、terminal 工具范围和审批检查。返回此次 ProcessSession 对应的云片糕 handle。 |
| `start_subagent` | `prompt`：调用正式 `SubagentLifecycleService.launch()`，使用固定补丁的 `independent=True`；继承原生模型、认证、目录和受限工具范围。返回此次 SubagentHandle 对应的云片糕 handle。 |
| `wait_for` | `handle`、可选 `timeout`（秒，默认 600，范围 0–2,147,483）：正常返回注册记录，在成功工具批次边界停放。本轮最多注册一次。 |
| `cancel_task` | `handle`：独立请求取消；进程调用原生 `kill_process()`，子 Agent 调用生命周期服务 `cancel()`。回执不等于终态。 |

嵌入入口绑定 Hermes 原生审批检查。默认配置下，需要批准且没有可应答审批通道的命令会被阻止，适配器不会读取会话 stdin 充当审批输入。宿主显式设置的审批策略仍生效。

一次 handle 绑定一次执行，所有权固定在创建时的 session。超时、新输入和 `interrupt()` 都不隐式取消已发布的任务；同一 handle 可以再次等待。独立子执行的记录由所属生命周期服务持有，宿主全局保留期届满后仍可在本实例内查询结果。完成、失败、取消或期限由共用 runtime 结算。工具轮停放前已经结算的结果也会在宿主返回后接续一次。先到的新输入只结算尚未结束的等待。若原生工具轮未能停放，适配器按 wait ID 结束该次等待，保留已结算的原因和底层任务。

零秒等待先复核指定 handle，再用零期限结算。若任务仍在运行，立即结算为超时。若复核期间接纳了新输入，旧轮不再注册等待。活跃等待期间，runtime 对原生状态做短间隔查询，默认 500 毫秒，可用 `poll_interval_ms` 调整。查询不请求模型、不调用长 `sleep`，也不依赖 best-effort 完成通知；因此通知遗漏不会漏唤醒。原生 API 没有给这些对象提供统一的可靠订阅，本接入不额外建立完成通知渠道。

任务结果和依赖以普通用户上下文进入后续请求，不进入 system prompt。接续记录含 wait ID、handle、deadline、恢复原因和结果；运行时元数据会在每轮重新注入。跨管道的 JSON 记录可分块读取，较大的累积快照仍可读取。压缩不能删除进程内执行关系。接纳 ID 和排队之间没有异步间隙；丢失回执后重复投递同一 ID 不创建第二轮。`delivered` 表示本地投递已收尾，包含已接纳的结果和已停止的等待。实际模型轮次与回答通过 `events` 和宿主结果观察。排队接续携带产生等待时的输入版本；新输入之后执行的旧接续不能注册新的过期等待。

原生子 Agent 会在收尾时清理其拥有的后台进程；这不改变父 runtime 对该子执行的等待语义。不要让子 Agent 启动必须在子执行结束后继续存活的任务，再把那个进程误当成父级独立任务。

## 空闲准备与原生压缩

入口以 `run_conversation()` 的实际返回判定完整回答；`on_turn_complete()` 不承担可靠收尾。成功完整回答后，由共用 scheduler 延迟检查最近响应的 `last_total_tokens`，默认阈值 100,000、空闲延迟 1,500 毫秒。停放工具轮、失败和中断不作为完整回答来源。

准备在主执行队列之外进行：复制当前投影，调用固定版本的原生 `_worker_copy()` 与 `ContextCompressor.compress()`；工作副本不绑定主会话数据库，禁用原生另一套 prepare-ahead。Python 保留原生压缩候选与必要统计，核心只接收摘要正文及指纹。若原生没有产生摘要，跳过提交。摘要请求使用宿主的模型路由、提示词、预算与裁剪逻辑。

提交通过原生 `compress_now()` → `_compress_context()` → `ContextEngine.compress()`。在原生 lease 内，适配器以当前消息、输入版本、session、模型、provider、endpoint、system prompt、工具声明、压缩参数和结构化依赖计算指纹，调用核心 `takePrepared()`；不匹配则抛出错误并保留历史，不退回重新生成来掩盖旧摘要。通过后交还准备好的原生消息列表，继续由宿主进行候选检查、原子归档与写入，以及内存投影刷新。适配器不直接修改聊天表或聊天文件。

输入接纳与整个原生提交共享锁，准备阶段不持锁。后到输入保留到事务结束；已经接纳的输入使旧代次失效。任务在压缩时就绪会先被接纳进同一执行队列，实际模型调用等压缩结束后发生。手动 `session.compact()` 也使用同一队列。取消已进入原生事务的压缩时，适配器等待事务返回并安装它返回的历史，再向调用者传播取消。

Hermes 的压缩提交会调用 `commit_memory_session()`，进而调用 `ContextEngine.on_session_end()`，即使是原地压缩。因此该回调不能单独表示实例关闭。实例失效由显式 close、原生 reset、模型切换或 session 身份变化控制。

## 宿主补丁与入口范围

[host.patch](hermes/host.patch) 只修改两处宿主源码，未把云片糕核心复制进去：

- `agent/turn_tool_round.py`：在成功工具批次、持久化与 guardrail 检查完成后，调用可选 `tool_round_boundary(messages)`。非空状态文本使轮次以 `runtime_parked` 正常结束，并沿用 finalizer 和工具结果持久化。没有使用工具失败或中断伪装等待。
- `agent/subagent_lifecycle.py`：复用原生 child detach 支持独立归属，由所属服务保留独立子执行记录。在构造结束及 executor 工作项开始时检查关闭，处理发布失败和缺少子身份时的资源清理。默认请求保持原生父级取消归属。

Hermes 的 `PluginContext.register_context_engine()` 允许注册一个 ContextEngine，工具可由其 `get_tool_schemas()` / `handle_tool_call()` 暴露；`select_context()` 只改变单次请求。插件注册没有普通成功工具轮的停放契约，因此首版选用固定补丁上的嵌入入口，在首次请求前装配 engine 与工具，之后不改写工具表。

CLI、Gateway 和 HTTP API 的原生完成接纳不同：CLI/Gateway 各自有完成消费与唤醒循环，API 的异步完成主要写入 timeline，后续模型轮由客户端发起。本入口维护自己的 `run_conversation()` 执行队列，不能把它的结果推广为这三种原生入口已通过验收。

源码证据固定于 [ContextEngine](https://github.com/NousResearch/hermes-agent/blob/f0d94882e89ab8d4098b5bb2f166adfb9ee0a0ab/agent/context_engine.py)、[插件注册](https://github.com/NousResearch/hermes-agent/blob/f0d94882e89ab8d4098b5bb2f166adfb9ee0a0ab/hermes_cli/plugins.py)、[工具轮](https://github.com/NousResearch/hermes-agent/blob/f0d94882e89ab8d4098b5bb2f166adfb9ee0a0ab/agent/turn_tool_round.py)、[生命周期服务](https://github.com/NousResearch/hermes-agent/blob/f0d94882e89ab8d4098b5bb2f166adfb9ee0a0ab/agent/subagent_lifecycle.py)、[压缩事务](https://github.com/NousResearch/hermes-agent/blob/f0d94882e89ab8d4098b5bb2f166adfb9ee0a0ab/agent/conversation_compression.py)。

## 生命周期与限制

`close()` 同步撤销新操作资格，停止核心调度与接续，打断原生在途请求，等待工具交接创建出的子执行，然后统一向这些子执行请求取消。子结果和压缩线程收尾后释放宿主。关闭先于子执行的 executor 准入时，宿主释放子对象，模型请求与云片糕 handle 均不会产生。关闭后快照保留核心收尾后的状态，未结算等待记录为 closed，底层任务状态保留最后观测值。未传入 session_db 时，入口通过原生状态 registry 获取并拥有 SessionDB，关闭时释放；调用者传入的数据库仍由调用者拥有。原生 `AIAgent.close()` 会清理它拥有的进程资源；退出不承诺让后台工作继续。

原生 reset、模型更新或 session ID 变化使旧适配失效；新会话必须重新创建实例。原生 CLI 的 branch/reload 不属于此入口，不能直接把旧对象装到另一 session 上。请只通过公开包装方法推进和关闭主会话，避免并发调用裸 `agent.run_conversation()` 或直接修改宿主字段。

首版限定一个进程内的嵌入 session：不提供跨重启恢复、已有原生任务接管、PTY 输入、原生 CLI/Gateway/API 插件装载、嵌套云片糕子任务或入口内的交互审批。原生子生命周期接口未暴露可靠的 `input_required` 状态，子执行仍按 Hermes 的非交互审批策略处理；本接入不宣称支持介入请求转发。核心的结构化介入状态回归继续保留。

首版要求 `skip_memory=True` 和 `skip_background_review=True`，入口默认设置这两项；不支持依赖记忆提供者提交前 checkpoint 的压缩。模型原生不透明压缩模式、其他 ContextEngine、原生 micro-compaction/prepare-ahead、会话轮换式压缩与直接并发修改主会话也不在支持范围。请使用独立配置并关闭这些竞争路径。摘要会发送给用户配置的模型服务。

## 验证

```sh
npm run check
npm test
HERMES_CHECKOUT=/path/to/patched-hermes HERMES_PYTHON=/path/to/isolated/python npm run test:hermes
npm run audit:public
npm pack --dry-run
```

`npm test` 包含共用核心、Pi/OpenCode 回归和 Hermes 核心管道测试。`test:hermes` 使用固定补丁、真实 `AIAgent`、terminal/ProcessRegistry、SubagentLifecycleService、工具执行循环和原生 SQLite 压缩事务。模型响应由回环 HTTP 替身预设，竞态用例用门闩控制事件顺序，大快照用例向真实 Python/Node 管道注入合成结果。用例为 `HERMES_HOME`、`HERMES_RUNTIME_DIR`、cwd 与数据库建立独立目录。复验使用清空继承环境的进程，另设 HOME、临时目录与缓存，并显式使用合成凭证。

48 项用例覆盖正常完成、注册前完成、完成/deadline 竞争、失败、timeout 后重等、新输入与请求中输入、独立取消、interrupt、批次、回执丢失、进程/子执行等待中压缩、压缩时完成、空闲摘要提交/失效/指纹拒绝、父创建失败/取消、子发布失败、close 与创建前后交错、原生 reset/close、身份失效和同步重入。另有默认原生持久化、真实终端命令入口、close 与在途压缩竞争、工具范围及独立子执行停止等待后的存活测试。回归还核对危险命令默认阻止、停放前已结算结果实际进入模型请求、宿主保留期后重等、取消后继续使用已持久化历史、调用者超时后的关闭、executor 准入与关闭的竞争，以及超过 16 MiB 的跨语言快照。另有用例覆盖 executor 满载时关闭、停放失败时仅收尾当次等待、取消已提交压缩后下一轮读取摘要、零秒复核已完成任务，以及复核期间新输入替换旧等待意图。核心的完成/deadline 竞争、重复通知及查询补偿由共用测试覆盖。

在 macOS arm64、Python 3.14.10、Node.js 26.3.1 上，计量场景的额外父模型唤醒和模型长 sleep 次数均为 0。测试使用 10 毫秒查询间隔，日志记录每个样本从完成到接续的延迟。测试进程本身用短文件门闩控制结束，门闩不是等待 runtime 的实现。压缩样例额外记录一次历史准备轮和一次原生摘要请求；标题生成在测试配置中关闭，普通入口仍遵循用户的标题设置。

模型替身预设工具选择，不能证明真实模型自主使用 `wait_for`、摘要保真度或 token 节省。Windows、原生 CLI/Gateway/API、真实模型自主任务和 `input_required` 来源仍未验证，不能作为完整多入口支持交付。

Hermes 自带 `tests/agent/test_subagent_lifecycle.py` 经标准 runner 运行，15 项通过；两个宿主补丁文件通过原生 Ruff 检查。附加的完整宿主 code-health 检查在稀疏 checkout 扫描基线 Python 文件时达到 120 秒上限，未取得完整结果，不能记为通过。Python 3.14 的宿主启动路径出现 detached scratch 清理进程的 `ResourceWarning`，已定位于 `hermes_constants_scratch_detach.py:45`，未修改该宿主行为；测试进程仍正常退出。公开交付不包含临时目录、模型请求正文或用户轨迹。
