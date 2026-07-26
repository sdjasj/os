# 01. Rust 异步与工具型 Agent：读 Codex 前必须会的最小背景

Codex 的难点不是某个神秘算法，而是多个异步边界叠在一起：用户可以继续输入，模型在流式返回，工具可能并发运行，审批要等待外部决定，子 Agent 有独立生命周期，终端还要持续重绘。Rust 的所有权和类型系统让这些边界变得显式。本章不做完整 Rust 教程，只解释后续源码里反复出现的设计语言。

## 先理解工具型 Agent 循环

一次普通聊天通常是：输入 → 模型 → 文本。工具型 Agent 多了一个可重复的闭环：

```text
1. 构造 Prompt：历史 + 当前输入 + 指令 + 工具规格
2. 请求模型并消费流
3. 如果得到最终文本，结束 Turn
4. 如果得到工具调用：
   a. 解析结构化参数
   b. 检查 hook / policy / approval
   c. 在选定 sandbox 中执行
   d. 把结构化结果追加到历史
5. 回到步骤 2
```

因此“模型调用一次”等于一个 sampling step，不一定等于一个 Turn。一个 Turn 可以包含多次 Responses 请求和多次工具执行。

## `Prompt`：一次采样真正需要什么

`codex-rs/core/src/client_common.rs` 中的 `Prompt` 很小，却是理解模型边界的最佳入口：

```rust
pub struct Prompt {
    pub input: Vec<ResponseItem>,
    pub(crate) tools: Vec<ToolSpec>,
    pub(crate) parallel_tool_calls: bool,
    pub base_instructions: BaseInstructions,
    pub output_schema: Option<Value>,
    pub output_schema_strict: bool,
}
```

这里有五类信息：

- `input` 是已经整理好的上下文项，不只是最新用户字符串；
- `tools` 是模型可见的能力描述，不是可直接调用的 Rust 函数指针；
- `parallel_tool_calls` 表示协议是否允许模型在一步中提出多个调用；
- `base_instructions` 是基础行为约束；
- `output_schema` 约束最终结构化输出。

看到这里就能排除一个常见误解：工具执行权限并不由 Prompt 决定。Prompt 只告诉模型“可以提出什么”，实际能否执行仍由本地策略决定。

## 所有权：为什么到处是 `Arc`

Rust 默认一个值只有一个所有者。Session 却要同时被：

- submission loop 持有；
-当前 Turn task 持有；
- 工具 handler 持有；
- MCP 或多 Agent 子任务引用；
- app-server listener 读取事件。

所以核心大量使用 `Arc<Session>`：原子引用计数允许多个异步任务共享所有权。`Arc::clone(&session)` 只增加引用计数，不会深拷贝整个 Session。

`CodexThread` 的骨架展示了这种关系：

```rust
pub struct CodexThread {
    pub(crate) session: Arc<Session>,
    pub(crate) io: SessionIo,
    pub(crate) session_source: SessionSource,
    session_configured: SessionConfiguredEvent,
    rollout_path: Option<PathBuf>,
    out_of_band_elicitations: Mutex<OutOfBandElicitations>,
}
```

读到 `Arc<T>` 时问“哪些任务共同拥有 T”；读到 `&T` 时问“这次借用能跨越哪个 `.await`”；读到 `Mutex<T>` 时问“被保护的状态是不是最小集合”。这三问比背语法更有用。

## `Mutex`、`RwLock` 和 `watch` 不是同一种状态

它们分别表达不同意图：

- `Mutex<T>`：某段复合修改必须互斥，例如活跃 Turn 状态；
- `RwLock<T>`：读远多于写，并允许并发读取；
- `watch::Sender<T>`：只关心“最新值”，新订阅者不需要重放每一次变化；
- `mpsc` / `async_channel`：每一条消息都要按队列消费；
- `oneshot`：只等待一次结果，例如一个审批答复。

在 `Session::spawn_internal` 中，提交与事件使用不同 channel：

```rust
let (tx_sub, rx_sub) = async_channel::bounded(SUBMISSION_CHANNEL_CAPACITY);
let (tx_event, rx_event) = async_channel::unbounded();
let (agent_status_tx, agent_status_rx) = watch::channel(AgentStatus::PendingInit);
```

设计含义是：

- 提交入口有容量上限，防止客户端无限灌入操作；
- 一个线程产生的事件需要持续向外流动；
- Agent 状态只需观察最新状态，不必把每次重复赋值当成业务事件。

## SQ/EQ：Actor 风格的线程边界

`codex-rs/protocol/src/protocol.rs` 的模块注释明确说明它使用 Submission Queue / Event Queue：

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

可以把一个活跃 `Session` 看成 actor：外部不能随意修改内部状态，只能提交 `Op`；Session 处理后发出 `EventMsg`。`id` 用于把事件和提交相关联，trace context 则让跨任务调用仍属于同一条观测链。

这种设计带来三个好处：

1. TUI、exec、app-server 不需要知道 Session 内部锁的布局；
2. 中断、审批答复、用户输入和设置更新可以统一排队；
3. 事件可被不同表面映射为 UI cell、JSON-RPC notification 或 JSONL。

## 大 enum：把状态机写进类型系统

`Op` 与 `EventMsg` 都是大 enum。它们不是“坏味道”本身，而是协议状态机的闭合集合。一个简化例子：

```rust
enum Op {
    UserInput { items: Vec<UserInput>, /* ... */ },
    Interrupt,
    ExecApproval { id: String, decision: ReviewDecision },
    Compact,
    Shutdown,
    // ...
}
```

匹配 enum 时，Rust 可以迫使调用方处理新增 variant。仓库规范因此鼓励 exhaustive `match`，避免 `_ => {}` 静默吞掉新的协议行为。阅读时先看 variant 名单，再挑与当前链路相关的分支。

## Trait：规格、调度与实现为什么分开

工具系统不能让 `shell`、MCP、图片查看和多 Agent 各自写一套主循环。它把共同契约抽成 trait，再用 `Arc<dyn ...>` 保存不同实现。

`ToolRouter` 体现两层分离：

```rust
pub struct ToolRouter {
    registry: ToolRegistry,
    model_visible_specs: Vec<ToolSpec>,
}
```

- `model_visible_specs` 决定模型请求里声明哪些工具；
- `registry` 保存按名字查找的实际 runtime。

某个 runtime 可以注册但对模型隐藏，用于 code mode 内部调度；也可以延迟暴露，只先公布 namespace。这就是为什么“在模型请求中没看到全部工具”不代表本地没有对应执行器。

## `impl Future + Send`：异步 trait 的关键约束

跨线程 Tokio executor 可能把 future 移到另一工作线程，因此许多 trait 方法不仅要返回 future，还必须是 `Send`。本仓库的约定偏向原生 RPITIT：

```rust
trait Example {
    fn run(&self) -> impl std::future::Future<Output = Result<()>> + Send;
}
```

实现可以写 `async fn run(...)`，只要生成的 future 满足契约。读到复杂 trait 边界时，先区分：

- trait 决定调用者能依赖什么；
- 实现决定具体如何等待 I/O；
- `Send` 决定 future 能否安全跨 executor 线程。

## Stream：响应不是一个值，而是一段时间轴

`ResponseStream` 包装一个 `mpsc::Receiver` 并实现 `futures::Stream`：

```rust
pub struct ResponseStream {
    pub(crate) rx_event: mpsc::Receiver<Result<ResponseEvent>>,
    pub(crate) consumer_dropped: CancellationToken,
}

impl Stream for ResponseStream {
    type Item = Result<ResponseEvent>;
    // poll_next delegates to rx_event
}
```

当消费者提前丢弃 stream，`Drop` 会取消 mapper task。这说明资源生命周期不仅由服务端“发完”决定，也由本地消费者是否继续轮询决定。

后续看到流式处理时，画一条时间轴：

```text
response.created
  -> reasoning delta...
  -> output_item.done(FunctionCall)
  -> response.completed
  -> local tool execution
  -> next response.created
  -> agent message delta...
  -> response.completed
```

不要把 delta、完整 item 和整个 response completed 当成同一级事件。

## `tokio::select!`：同时等待多个世界

TUI 顶层循环同时等待内部 `AppEvent`、活跃 thread 事件、键盘/粘贴/重绘事件和 app-server 广播：

```rust
let control = select! {
    Some(event) = app_event_rx.recv() => { /* ... */ }
    active = async { /* active thread receiver */ } => { /* ... */ }
    event = tui_events.next() => { /* ... */ }
    app_server_event = app_server.next_event() => { /* ... */ }
};
```

`select!` 不是“开四个线程”，而是让一个 async task 在多个 future 中等待先就绪者。处理完成后循环再次选择。理解这一点后，键盘输入、网络通知和重绘为何不会互相阻塞就清楚了。

## 取消不是错误处理的附属品

Agent 系统中取消随时可能发生：用户按 Esc、Turn 被替换、tool stream 断开、子 Agent 被 interrupt、session shutdown。`CancellationToken` 能被 clone 到各层；触发一次后，所有观察者都能结束。

应区分：

- 业务失败：命令退出码非零，通常作为工具结果返回模型；
- 策略拒绝：审批或 hook 阻止执行，模型可能收到可恢复反馈；
- 取消：当前工作不再需要，应尽快清理子进程和流；
- fatal：内部不变量破坏，Turn 或 Session 可能终止。

如果把四者都折叠成字符串错误，UI、重试和持久化都无法做正确决策。

## Agent 上下文不是一个无限字符串

模型可见输入最终是有序 `ResponseItem` 列表，并受上下文窗口约束。Codex 需要：

- 保持函数调用与函数输出成对；
- 截断超长工具输出；
- 根据模型能力移除不支持的图片或音频；
- 注入有硬上限的 `AGENTS.md`、skills 和环境信息；
- 在接近窗口限制时压缩旧历史；
- 持久化足够的信息，让恢复后的上下文语义一致。

这也是为什么上下文管理和 rollout 不能简化为 `Vec<String>`。

## 背压、并发和顺序

异步不意味着所有工作都应并行：

- submission channel 有界，体现入口背压；
- 同一 Turn 中只有明确声明支持的工具才可并行；
- rollout 写入要保持可恢复顺序；
- TUI 渲染可合并帧，但协议事件不能随意丢；
- 多 Agent 有总数、深度和同时执行数量限制。

读并发代码时标出三种约束：容量上限、顺序屏障、取消传播。它们往往比 `spawn` 本身更重要。

## 本章实验一：给异步原语分类

执行以下搜索：

```bash
rg -n "async_channel::bounded|async_channel::unbounded|watch::channel" \
  codex-rs/core/src/session/mod.rs
rg -n "tokio::select!|select!" codex-rs/tui/src/app.rs
rg -n "CancellationToken" codex-rs/core/src/tools codex-rs/core/src/client_common.rs
```

为每个命中写出：谁发送、谁接收、是否允许丢旧值、如何结束。

## 本章实验二：从类型推断工具调用闭环

不用读函数体，只读这些类型：

```bash
rg -n "pub struct Prompt|pub struct ResponseStream" \
  codex-rs/core/src/client_common.rs
rg -n "pub struct ToolCall|pub struct ToolRouter" \
  codex-rs/core/src/tools/router.rs
rg -n "FunctionCallOutput" codex-rs/protocol/src/models.rs \
  codex-rs/core/src -g '*.rs'
```

尝试回答：模型提出调用时携带哪些字段？本地按什么键找 handler？结果怎样与原 `call_id` 配对？第 07、08 章会给出完整答案。

## 常见误区

- 看到 `clone()` 就认为复制成本很大。`Arc::clone` 通常只操作引用计数，但 `Vec`/`String` clone 可能深拷贝。
- 认为加了 `Mutex` 就线程安全。锁的持有范围若跨慢 I/O，仍会造成阻塞或死锁风险。
- 把 channel 当共享列表。channel 表达所有权转移和消费顺序，不应随意“偷看内部 Vec”。
- 把一个 Turn 等同于一次 HTTP 请求。工具闭环可能产生多个采样 step。
- 认为模型调用工具就是执行工具。模型只生成结构化意图，本地才拥有执行权。
- 认为所有流事件都要持久化。内部 delta、公共 item、rollout canonical item 的粒度不同。

## 自测

1. 为什么 `AgentStatus` 适合 `watch`，Submission 更适合有界 channel？
2. `Arc<Session>` 解决了什么问题，为什么它不等于内部状态自动无锁？
3. `ToolRouter` 为什么同时需要模型可见 specs 和 runtime registry？
4. 一次 Turn 为什么可能包含两次以上 Responses 请求？
5. 业务失败、策略拒绝、取消和 fatal error 对上层的处理应有什么不同？
6. 为什么函数调用和输出必须通过 `call_id` 成对？

## 源码定位

- [Prompt 与 ResponseStream](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/core/src/client_common.rs)
- [SQ/EQ 协议](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/protocol/src/protocol.rs)
- [Session channel 初始化](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/core/src/session/mod.rs)
- [ToolRouter](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/core/src/tools/router.rs)
- [TUI 顶层事件循环](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/tui/src/app.rs)

下一章把近百个 crate 重新分成少数职责清晰的层，并解释为什么新能力不应默认塞进 `codex-core`。
