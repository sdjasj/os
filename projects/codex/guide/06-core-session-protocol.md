# 06. Core 会话协议：从 ThreadManager 到 SQ/EQ 的异步边界

前几章已经把请求送到了 core。现在要回答更难的问题：一个对话由谁拥有，外部如何在不直接碰内部锁的情况下提交输入，为什么用户按下中断键时仍可能保留后台命令，以及 Turn 中途工具目录发生变化时，下一次模型请求会看到什么。本章以一次普通 `Op::UserInput` 为主线，建立 `ThreadManager → CodexThread → Session → TurnContext → StepContext` 的生命周期地图。

## 先补背景：把 Session 看成一个 Actor

Actor 模型的核心不是某个 Rust 类型，而是一条约束：外部参与者不能任意修改 Actor 内部状态，只能向它发送消息；Actor 串行接收消息，改变状态，再把结果作为事件发出去。Codex core 的对应术语是：

- SQ（Submission Queue）接收调用方提交的操作；
- EQ（Event Queue）把 Session 产生的事件交还给调用方；
- `Op` 是 SQ 消息的业务负载；
- `EventMsg` 是 EQ 消息的业务负载。

固定快照中的协议骨架非常小：

```rust
pub struct Submission {
    pub id: String,
    pub op: Op,
    pub client_user_message_id: Option<String>,
    pub trace: Option<W3cTraceContext>,
}

pub struct Event {
    pub id: String,
    pub msg: EventMsg,
}
```

这里的 `id` 是相关 ID：由某个 Submission 启动的事件会携带相同 ID。它不是模型服务的 `response_id`，也不是工具调用的 `call_id`。`trace` 则用于把跨 channel、跨 Tokio task 的工作仍归入同一条可观测链。

源码入口：[Submission、Op、Event 与 EventMsg](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/protocol/src/protocol.rs)。

## 五层对象分别活多久

| 对象 | 典型生命周期 | 拥有什么 | 不应该做什么 |
| --- | --- | --- | --- |
| `ThreadManager` | 应用进程级 | 活跃线程索引、共享服务、创建/恢复入口 | 执行具体模型回合 |
| `CodexThread` | 一个活跃对话 | `Arc<Session>`、`SessionIo`、配置摘要、rollout 路径 | 直接实现 Agent 循环 |
| `Session` | 一个活跃对话 | 历史、配置、活动 task、输入队列、工具与持久化服务 | 把内部可变状态暴露给 UI |
| `TurnContext` | 一个 Turn | 本回合固定的模型、权限、指令、环境选择等 | 随每次采样任意刷新 |
| `StepContext` | 一次 sampling step | 当下环境、AGENTS.md、MCP catalog、工具路由 | 跨越后续采样继续代表“当前状态” |

可以把作用域写成：

```text
应用
└─ ThreadManager
   └─ CodexThread / Session                    thread scope
      └─ TurnContext                           turn scope
         ├─ StepContext A → Responses request A
         └─ StepContext B → Responses request B
```

一次 Turn 因工具调用而包含多次模型请求时，`TurnContext` 保持稳定；每次请求前捕获新的 `StepContext`。因此“这个 Turn 用哪个模型”与“这一步有哪些已就绪工具”分属不同层级。

## ThreadManager：创建和恢复的总入口

[`ThreadManager`](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/core/src/thread_manager.rs) 负责启动新线程、恢复已有线程，并在内部状态中按 `ThreadId` 保存活跃的 `CodexThread`。主链是：

```text
ThreadManager::start_thread
  → start_thread_inner
  → ThreadManagerState::spawn_thread_with_source
  → Session::spawn
  → finalize_thread_spawn
  → 将 CodexThread 插入活跃线程表
```

`spawn_thread_with_source` 会先检查请求恢复的线程是否已经在当前进程中活跃；真正创建 Session 后，`finalize_thread_spawn` 要求 EQ 的第一个事件是 `SessionConfigured`。这个次序保证调用方在解释后续事件前，已经知道实际模型、线程 ID 和初始配置。若把首事件当普通聊天事件处理，恢复、模型 fallback 等状态就可能在 UI 中短暂错误。

## CodexThread：窄而稳定的双向门面

[`CodexThread`](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/core/src/codex_thread.rs) 的注释称它为组成一个 thread 的“双向消息流导管”。最关键的公开方法只有两种方向：

```rust
pub async fn submit(&self, op: Op) -> CodexResult<String> {
    self.io.submit(op).await
}

pub async fn next_event(&self) -> CodexResult<Event> {
    self.io.next_event().await
}
```

这层门面的价值是隔离：TUI、exec 和 app-server 可以共同依赖 `submit/next_event`，却不必知道 Session 内有多少锁、工具服务和持久化对象。`submit` 返回新生成的 submission ID；调用方可以用它关联随后收到的事件。

`steer_input` 是另一条重要入口：如果当前有可 steer 的活动 Turn，新输入进入其待处理队列；若指定了 `expected_turn_id`，还可避免把迟到输入误投给已经更换的 Turn。

## SessionIo：为什么一边有界、一边无界

[`Session::spawn_internal`](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/core/src/session/mod.rs) 创建：

```rust
let (tx_sub, rx_sub) = async_channel::bounded(SUBMISSION_CHANNEL_CAPACITY);
let (tx_event, rx_event) = async_channel::unbounded();
```

`SUBMISSION_CHANNEL_CAPACITY` 在该快照中为 512。SQ 有界意味着调用方不能无限灌入用户输入、审批答复和配置变更；队列满时会产生背压。EQ 无界不等于事件可以无限增长，而是 core 不能在持有关键状态时因为 UI 暂时没取事件就停住；上层仍必须持续消费。另有 `watch::Receiver<AgentStatus>` 只保存最新状态，适合“当前是 Pending、Running 还是 Idle”这类不要求重放每个中间值的信息。

`SessionIo` 与 `Session` 分开还有一个生命周期意义：所有 SQ sender 被丢弃时，submission loop 能自然结束；共享 termination future 允许多个调用方等待 teardown，而不需要拿到 Session 内部控制权。

## 一次 UserInput 的真实调用链

[`submission_loop`](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/core/src/session/handlers.rs) 持续从 `rx_sub` 接收 `Submission`，再对 `Op` 分派。普通输入经过下面的状态转换：

```text
CodexThread::submit(Op::UserInput)
  │  生成 UUIDv7 submission id
  ▼
SessionIo::submit_with_trace
  │  tx_sub.send(Submission)
  ▼
submission_loop
  │  match Op::UserInput
  ▼
user_input_or_turn_inner
  ├─ 合并 thread settings override
  ├─ new_turn_with_sub_id → Arc<TurnContext>
  ├─ 若已有活动 Turn：尝试 steer
  └─ 若空闲：spawn_task(RegularTask)
       ├─ 发出 TurnStarted
       └─ run_turn(...)
```

用户输入先尝试 steer 而不是无条件开新任务，这使“模型运行时继续补一句”可以进入现有回合。若没有活动任务，它才连同 additional context 转换为 `TurnInput` 并启动 `RegularTask`。

[`Session`](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/core/src/session/session.rs) 明确维持“至多一个活动 task”的不变量。`spawn_task` 安装新的 `ActiveTurn`；task 完成后 `on_task_finished` 负责清理活动状态、冲刷 rollout，并发出 `TurnComplete` 或 `TurnAborted`。这不妨碍一个 Turn 内的多个工具并发，因为它们是同一个 task 内部的 future，而不是多个 Session task。

## TurnContext：回合级不可变快照

[`TurnContext`](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/core/src/session/turn_context.rs) 包含：

- `sub_id` 与 trace ID；
- 实际 `model_info`、provider、reasoning effort/summary；
- session source、history mode、父线程信息；
- 本回合环境选择、cwd、日期与时区；
- developer instructions、模式、personality；
- approval policy、permission profile、网络与 Windows sandbox level；
- final output JSON schema、动态工具和扩展状态。

它是“这一回合决定了什么”的证据。即使线程设置在 Turn 运行中被另一条 Submission 更新，当前 Turn 也不应突然一半使用旧模型、一半使用新模型。

## StepContext：请求级一致性快照

[`StepContext`](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/core/src/session/step_context.rs) 保存一次采样所需的动态视图：环境能力根、executor 发现结果、精确 MCP binding 与工具列表、最终 `ToolRouter`、当下的 AGENTS.md。

`run_turn` 对每个 sampling step 只捕获一次 StepContext，然后用同一个对象：

1. 生成模型可见工具规格；
2. 创建本地工具 router；
3. 执行该响应产生的工具调用。

这样可以避免“请求告诉模型工具 A 存在，但响应到来时却用工具集合 B 解码”的竞态。MCP 执行还会在不可逆操作前重新校验当前 catalog revision；第 11 章再展开这一点。

## ID 不能混用

| ID | 代表什么 | 常见出现位置 |
| --- | --- | --- |
| `ThreadId` | 可持久化的对话身份 | ThreadManager、rollout、app-server |
| `SessionId` | root 与多 Agent 后代的会话谱系 | agent control |
| submission ID / turn ID | 一次启动回合的操作与相关事件 | `Submission.id`、`Event.id`、`TurnContext.sub_id` |
| `response_id` | 一次供应商 Responses 响应 | `ResponseEvent::Completed` |
| `call_id` | 工具调用与工具输出的配对键 | `FunctionCall` / `FunctionCallOutput` |
| `item_id` | 模型项或 TurnItem 身份 | 流式 item 事件 |

根 Session 通常从 `ThreadId` 派生 `SessionId`；子 Agent 则继承 agent-control 的谱系语义。不要因为二者在根线程上可能相似就把类型概念合并。

## 安全实验：画出 SQ/EQ 的生产者和消费者

本实验只搜索源码，不登录、不联网、不执行模型工具：

```bash
cd <project-root>

rg -n "struct SessionIo|SUBMISSION_CHANNEL_CAPACITY|bounded\(|unbounded\(" \
  codex-rs/core/src/session/mod.rs
rg -n "pub async fn submit|pub async fn next_event|steer_input" \
  codex-rs/core/src/codex_thread.rs
rg -n "submission_loop|Op::UserInput|Op::Interrupt|Op::Shutdown" \
  codex-rs/core/src/session/handlers.rs
rg -n "pub struct TurnContext|pub\(crate\) struct StepContext" \
  codex-rs/core/src/session
```

为每个 channel 写一行“生产者、消费者、容量、关闭条件”。然后选择一个 `Op::Interrupt` 分支，验证它终止的是当前 task，而不是默认清理全部后台终端。若希望做编译级验证，可运行 `just test -p codex-core`；该命令不需要真实模型账户，但首次构建可能较慢。

## 常见误区

- 把 `CodexThread` 当作 Agent 引擎。它主要是门面和导管，状态机在 `Session` 与 task 中。
- 把 Thread、Session 和 Turn 当同义词。Thread 是持久对话，Session 是其活跃运行实例，Turn 是一次有始有终的工作。
- 认为每条输入都创建新 Turn。活动 RegularTask 可以接收 steer 输入。
- 认为一个 Turn 只能发一次 HTTP 请求。工具闭环会产生多个 sampling step。
- 认为 EQ 无界就无需背压。core 只是避免关键路径被 UI 阻塞；消费者仍必须持续读取并限制自己的投影。
- 把 submission ID、`response_id` 和 `call_id` 放在同一个字段里复用。三者分别关联本地回合、供应商响应和工具配对。
- 在 Session 内部随手读取进程 cwd。路径应来自选定的 Turn environment，不能假设 app-server 与 exec-server 在同一主机或同一操作系统。

## 自测题

1. 为什么 `SessionConfigured` 必须是创建线程后观察到的第一个事件？
2. SQ 选择有界 channel，而 AgentStatus 选择 `watch`，分别表达什么语义？
3. `CodexThread` 隔离了哪些 Session 内部实现细节？
4. 为什么 TurnContext 固定模型与权限，而 StepContext 要在每次采样前更新？
5. 用户在模型工作期间继续输入时，代码为什么先尝试 steer？
6. “一个 Session 同时最多一个 task”为什么不等于“工具绝不能并行”？
7. `ThreadId`、submission ID、`response_id`、`call_id` 分别关联哪一级生命周期？

## 源码定位

- [ThreadManager 创建与恢复](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/core/src/thread_manager.rs)
- [CodexThread 双向门面](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/core/src/codex_thread.rs)
- [Session 创建、SessionIo 与 channel](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/core/src/session/mod.rs)
- [Session 状态主体](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/core/src/session/session.rs)
- [Submission 分派](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/core/src/session/handlers.rs)
- [TurnContext](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/core/src/session/turn_context.rs)
- [StepContext](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/core/src/session/step_context.rs)
- [RegularTask 生命周期](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/core/src/tasks/regular.rs)

下一章进入 `run_turn`：同一个 Turn 如何通过 Responses 流、工具执行和再次采样形成闭环。
