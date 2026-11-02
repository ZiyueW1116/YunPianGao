# Harness 适配契约

`createYunPianGao(port, options)` 创建一个进程内调度器。会话标识用于隔离状态；token 阈值针对最近完整回答的用量，不是历史累计计费量。

## 事件

调用 `onExecution(sessionID, phase)` 报告 `started`、`succeeded`、`failed` 或 `interrupted`。只有成功事件会安排一次延迟检查。输入进入主循环前调用 `onInput(sessionID)`，使当前准备结果失效。两类事件必须按宿主实际发生的顺序传递。

`latestCompleted` 返回完整最终回答的标识及 token 数；无符合条件的回答时返回 `undefined`。宿主应过滤子会话、未完成回答、其他工作目录和刚完成的压缩，避免重复压缩循环。

## 准备与提交

`prepare` 生成临时文本摘要及对应的上下文指纹。它不得创建一条持久化用户消息或占用主执行循环的锁。指纹必须对应实际用于摘要的模型、指令和历史，且可以与提交时的状态比较。

`compact` 将控制项交给宿主原生队列。在原生持久化前，宿主必须以当前指纹调用调度器的 `takePrepared(sessionID, fingerprint)`：

- 返回文本时，提交该摘要。
- 返回 `undefined` 时，没有本调度器准备的结果；走宿主自身的压缩流程。
- 抛出 `StaleSummaryError` 时，取消本次替换并保留完整历史。不要捕获后继续使用旧摘要。

该复核与提交必须属于同一原生提交边界，不能先检查、再让其他任务改变上下文、最后写入旧结果。宿主也必须保留已经排队的新用户输入。

`compact` 可以只确认入队；`wait` 负责等待控制项完成。完成前调度器会持有准备结果，以便提交回调消费。参考实现见 [OpenCode 适配器](../src/adapters/opencode.ts)。

## 生命周期

`close()` 取消本地定时器，将取消信号传给宿主请求，并等待这些请求退出。端口实现必须响应 `AbortSignal`；不合作的端口会延长关闭过程。客户端取消不保证远端模型已停止计算。

状态与待提交摘要只在进程内保存，不跨进程恢复。卸载不能撤销宿主已经接受的任务，也不自动还原已经完成的压缩。

## 摘要格式

核心以文本传递摘要。需要加密、不透明或结构化 replacement window 的 Harness 须实现并验证对应端口；provider 原生对象不能直接作为文本摘要提交。

OpenCode 适配器默认使用 `prepare-then-commit` 策略，在提交时复核模型、系统指令和消息历史。摘要提示词、工具定义和输出预算见 [验证文档](validation.md)。

## 任务等待

`createWaitRuntime(port, { pollIntervalMs })` 创建独立于压缩调度的进程内 runtime。默认查询间隔为 500 毫秒；等待与压缩的接口、状态和取消操作互相独立。

### 任务与等待接口

`register(sessionID, kind, executionID, source)` 注册具体执行，返回 `TaskHandle`。`kind` 为 `process` 或 `subagent`；`executionID` 必须关联到这次执行，不能使用可重复启动任务的名称。handle 只能由所属 session 等待或取消。

`TaskSource` 提供以下能力：

- `read(signal)`：返回当前 `TaskSnapshot`。状态为 `working`、`input_required`、`succeeded`、`failed` 或 `cancelled`，可附带结果、错误、介入请求与完成时间。载荷须可由 `structuredClone` 复制；通过 OpenCode 工具结果或 synthetic 传递时还须可 JSON 序列化。
- `subscribe(changed)`：可选事件订阅，状态变化时触发复核，返回解除订阅函数。事件可能重复或遗漏，runtime 在等待期间仍按间隔调用 `read`。
- `cancel(signal)`：独立请求取消底层任务。请求被接纳不等于任务已经结束，最终状态仍以 `read` 为准。

`begin(sessionID, handleID, timeoutMs)` 注册等待并返回 `WaitRecord`。期限以毫秒保存；同一 session 的新等待会结束其前一次等待。宿主确认暂停，且不会再丢弃新唤醒之后，调用 `activate(waitID)`。任务可以在暂停之前完成，结果会暂存到激活时再接续。

成功、失败、取消、介入与超时竞争同一个状态转换：`waiting → ready → delivered`。第一次结束原因确定后，不再被迟到的事件或超时覆盖。终态在后续等待中保持可读；`input_required` 可以回到 `working`。查询失败不等同于任务失败，runtime 会继续复核直到得到结果或本次等待超时。

`WaitPort.resume(record, signal)` 必须触发真实 session 接续，并按 `record.id` 幂等接纳。接纳失败或响应丢失时，runtime 以相同标识重试；端口不能每次创建一条新输入。状态通知本身不能替代接续。

`onInput(sessionID)` 或 `onInterrupt(sessionID)` 结束尚未完成的等待，分别记录 `user_input` 或 `interrupted`，不再调用 `resume`；输入与中断的后续执行由宿主管理。已确定结果并开始投递的等待不会被后来的输入改写，宿主须保留新输入并按实际顺序处理。

`stopWaits(sessionID, waitID?)` 强制结束该 owner 已注册的等待，停止重试并向在途投递传递取消信号，不取消底层任务；指定 `waitID` 时只收尾该次等待。已经确定的结束原因保留，尚未结束的等待记录为 `interrupted`。删除 owner、取消子任务时停止该 owner 的全部等待；停车失败只收尾本次等待，不能影响后来注册的等待。已经被宿主接纳的输入不能撤回。

`refresh(handleID?)` 复核已注册任务；传入 handle 时只查询该任务，省略时复核全部任务。

`snapshot(sessionID)` 返回结构化任务与等待副本，包含 handle、执行标识、期限、状态、恢复原因及结果。宿主应把依赖状态接入后续上下文，不能仅依赖可能被压缩的聊天文本。OpenCode 的系统上下文只注入依赖元数据；原始输出通过工具结果或 synthetic 输入传递，需要时可以再次等待同一 handle 获取缓存的终态结果。

`close()` 解除订阅、停止定时器、取消本地请求并等待其退出，包括已发起的 `cancel` 请求；关闭本身不调用任务的 `cancel`。端口的异步操作必须响应取消信号。状态、任务结果和已结束等待保留到该 runtime 实例被释放，不提供跨重启恢复。

### OpenCode 2.1.4

适配器使用公开工具注册接口添加四个工具。`wait_for.timeout` 使用秒，核心的 `timeoutMs` 使用毫秒；`CompactionPort.wait` 仍只等待压缩控制项。

后台进程继承环境和工作目录，不经过 shell 解释。启动前调用 `permission.assert`，action 为 `yunpiangao.process`，resource 为可执行文件和参数数组的 JSON。该权限独立于原生 `shell` 规则，`shell` 的 deny/ask 不约束它。默认 Agent 带有 `*` allow 规则，因此通常会匹配并允许；完全没有匹配规则时，`permission.evaluate` 回退为 ask，最终结果按宿主匹配规则决定，部署时应显式配置。最多保留末尾 64 KiB 的 stdout/stderr 合并结果，不接受交互式 stdin。POSIX 下取消向进程组发送 SIGTERM；因该信号退出时标记 `cancelled`，正常退出或其他错误按实际状态记录。忽略 SIGTERM 的进程可能继续运行，不自动强制终止。

子 Agent 使用宿主现有 agent 定义、权限检查与新建子会话接口，每次任务创建独立子会话，不接管既有子会话。子会话按宿主规则继承父会话权限，模型优先采用 agent 设置。首版子会话不得再次调用 `start_subagent`，可以调用 `start_process` 和 `wait_for`。输入接纳状态保存在插件内，不依赖可能被压缩移除的原始输入。

可见历史中的完整 assistant 回答及其后的第一个原生 idle 用于确认子任务终态，后续控制项的成功、失败或中断不覆盖该结果。子会话内部使用过 `wait_for` 时，原生 compact 等控制项的成功或失败不代表逻辑任务结束；内部等待结果投递后，还须出现新的完整回答及其后的 idle。停车关联中的 assistant ID 用于排除被中断的原等待回答，不要求回答时间严格大于 `idle`。新回答后的首个 idle 为 `failed` 时，返回该轮失败及错误。`tool-calls` 和 `length` 仍可能续跑；2.1.4 连续三次 `length` 后以 `output-limit` 失败结束，返回该错误。

生成新摘要时，公开 `compaction` hook 在窗口替换前仅复核正在压缩且未请求取消的子任务，将已确认的终态保留在现有 runtime 中，不等待当前压缩自身的清理。2.1.4 的插件 `session.context` 只返回当前窗口，没有完整历史查询接口。宿主复用预生成摘要时不会再次调用该 hook；`keepID` 保留尾部也只重建为摘要中的文本，不还原 assistant 错误与 idle。若原任务终态未被缓存，可见窗口又只剩压缩及其控制项终态，插件返回 `input_required` 和“压缩后无法复核原任务结果，需要在宿主确认”，不把控制项成功或失败作为原任务结果。已有内部等待且尚无新完成回答时仍保持 `working`；上述复核不取消底层任务。

执行事件及 session 查询用于观察结果，`permission.list`、运行中的 `question` 工具，以及 `form.created` 事件用于识别介入需求；表单经 `form.replied` 或 `form.cancelled` 清除，覆盖原生 `websearch` 的提供者选择表单。授权或表单在宿主 UI 中处理，插件不自动批准。2.1.4 的公开插件接口没有表单列表查询，断线漏掉表单创建或关闭事件时，无法保证恢复当前表单状态；权限与 `question` 仍可由查询复核。

取消子任务先强停止子会话名下已注册的等待与本地投递，再请求原生中断并等待清理。内部等待期间 compact 已结束而原生中断为 no-op 时，没有真实完成回答的逻辑任务仍标为 `cancelled`；已有真实完成结果则保持该结果。中断事件遗漏时，查询确认的取消终态同样停止子会话本地等待。子会话启动的独立进程不级联取消，后续进程完成或等待期限到达不再触发已停止的接续。插件不删除子会话或宿主排队输入，已经由宿主接纳的 synthetic 输入不能撤回。`cancel_task` 只返回目标 handle 的取消请求回执，不带其他任务结果。

收到 owner 删除事件后，插件结束其等待，不调用任务的 `cancel`。断线重连时会查询已注册任务的 owner，即使任务未完成，也能发现漏掉的删除或后续执行中断。复核中断沿用事件路径的停车对象身份与严格递增 idle 判断，旧查询不能结束新等待，不取消底层任务；接续请求确认 owner 不存在时同样结束其等待。仅识别直接包含 `_tag: "Session.NotFoundError"` 且 `sessionID` 对应当前会话的错误，其他查询失败只诊断并保留状态，接续失败继续使用相同消息 ID 重试。

独立进程继续运行；OpenCode 删除会话时会中断并递归删除原生子会话，插件不改变该宿主行为。独立删除运行中的子会话时，删除事件或确定该子会话不存在的查询结果使父 handle 转为 `cancelled`，不再查询已删除会话。

源码核对版本为 tag `v2.1.4`，commit `68bc26b7da1990ce10ffecfbc1e09eb13aa5d824`。影响接续的宿主能力包括：

- [Promise 适配器](https://github.com/anomalyco/opencode/blob/v2.1.4/packages/plugin/src/promise/adapter.ts) 提供工具执行的 `AbortSignal`；公开 session API 没有停放执行或恢复任意工具栈的操作。进程内 API 未转发 `RequestOptions.signal`，插件以取消竞争结束本地等待，宿主已接纳的操作可能继续。
- [执行协调器](https://github.com/anomalyco/opencode/blob/v2.1.4/packages/core/src/session/run-coordinator.ts) 在中断时清除旧唤醒，在清理期间接纳新唤醒。[`interrupt({resume:true})`](https://github.com/anomalyco/opencode/blob/v2.1.4/packages/core/src/session/execution.ts) 保留并发到达的 steering 输入，但回执只确认接受中断。适配器随后调用公开的 [`session.wait`](https://github.com/anomalyco/opencode/blob/v2.1.4/packages/core/src/session/session.ts) 等待原生执行清理及终态提交完成，再读取 `idle` 并激活接续。该清理请求在插件作用域运行，工具收到取消信号后先返回，不等待该请求，因此不阻塞自身清理。
- [会话投影](https://github.com/anomalyco/opencode/blob/v2.1.4/packages/core/src/session/projector.ts) 为每次执行终态严格推进 `time.idle`，新执行开始后仍保留上次 `outcome`。尚未匹配逻辑终态时，只有严格大于停车 `idle` 的中断才属于后续执行；相同或较早的查询快照不能取消新等待。事件与任务查询采用同一比较，异步事件查询还须保持当时的停车归属。原生空闲会话的中断操作是 no-op，已处于 stopping 的执行被重复中断也返回 `false`，均不产生新的中断事件；可以通过新 prompt 结束等待。宿主没有原子的执行代次回执；若其他宿主输入在 `session.wait` 完成到读取 `idle` 之间又完成一轮执行，这两次中断的归属仍无法仅凭该回执区分。
- 工具可在模型流结束前执行。适配器等待 assistant 的 `time.streamed`，再复核完整工具列表；同一步有其他工具时拒绝暂停。输入版本检查阻止模型流期间新输入到达后的过期等待意图。
- [synthetic 输入](https://github.com/anomalyco/opencode/blob/v2.1.4/packages/core/src/session/session.ts) 进入原生 inbox 并触发执行；同一输入 ID 的接纳由[队列](https://github.com/anomalyco/opencode/blob/v2.1.4/packages/core/src/session/inbox.ts) 去重。等待结果使用固定消息 ID，任务状态也通过 `context` hook 注入后续请求，因此压缩后仍可复核依赖。
- [原生后台 subagent](https://github.com/anomalyco/opencode/blob/v2.1.4/packages/core/src/session/subagent-completion.ts) 和 [shell](https://github.com/anomalyco/opencode/blob/v2.1.4/packages/core/src/tool/plugin/shell.ts) 自带通知。插件使用独立启动入口避免重复通知，尚未适配这些原生标识。

等待时 session 显示为中断后的空闲状态，历史中的 `wait_for` 工具被记为 interrupted；接续通过新的 Agent 执行处理 synthetic 结果，不恢复任意工具调用栈。用户输入结束等待，不取消任务。事件流断开后，空闲压缩沿用停止调度的行为；任务等待继续查询并重连事件订阅。跨重启重放、原生任务接管和 Windows 进程组取消不在已验证范围内。
