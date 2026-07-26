# 08. 工具路由与调度：从模型可见规格到稳定结果写回

模型不能直接调用 Rust 函数。它只能在 Responses 输出中声明“我想调用某个名字、参数是这些”；Codex 再判断这个工具是否在本次请求中可见、本地是否注册了匹配实现、hook 是否允许、handler 是否支持并行，最终把结果转换成模型协议项。本章沿 `spec → visible plan → registry → router → handler → output` 逐层拆开工具系统。

## 为什么规格和执行必须分层

工具系统同时服务两个信任域：

- 模型侧需要 JSON Schema、描述和名字，以生成结构化调用；
- 主机侧持有真正的副作用能力，必须做类型检查、权限、审批、hook、取消和日志。

如果把两者合成“给模型一个函数指针”，就无法隐藏内部兼容工具、延迟发现大型目录，也无法在模型生成调用后继续执行本地安全策略。固定快照用 [`ToolExecutor`](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/tools/src/tool_executor.rs) 把规格和 runtime 绑定在一个实现上，再由 core 在外层增加调度：

```rust
pub trait ToolExecutor<Invocation>: Send + Sync {
    fn tool_name(&self) -> ToolName;
    fn spec(&self) -> ToolSpec;
    fn exposure(&self) -> ToolExposure { ToolExposure::Direct }
    fn supports_parallel_tool_calls(&self) -> bool { false }
    fn handle(&self, invocation: Invocation) -> ToolExecutorFuture<'_>;
}
```

默认“不支持并行”是保守选择：新增工具必须显式证明自己能安全并发，不能因为模型协议允许 parallel calls 就自动并发执行所有副作用。

## 五个容易混淆的名词

| 层 | 回答的问题 | 代表类型 |
| --- | --- | --- |
| spec | 模型应怎样构造调用？ | `ToolSpec` |
| exposure | 现在是否向模型展示？ | `ToolExposure` |
| visible plan | 本 sampling step 实际发送哪些规格？ | `Vec<ToolSpec>` |
| registry | 本地按名字有哪些可执行 runtime？ | `ToolRegistry` |
| router | 如何把 `ResponseItem` 解析并交给 registry？ | `ToolRouter` |

handler 是某个工具的具体实现；`CoreToolRuntime` 则是 core 对 handler 的适配层，会附加 hook、telemetry、diff consumer 等编排能力。

## ToolExposure：可见不等于已注册

[`ToolExposure`](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/tools/src/tool_executor.rs) 有四种状态：

- `Direct`：初始模型请求可见，也可进入 code-mode 嵌套表面；
- `Deferred`：先注册，暂不列入初始工具表，等待搜索/发现；
- `DirectModelOnly`：普通模型请求直接可见，但不进入某些嵌套 code-mode 表面；
- `Hidden`：保留 dispatch 能力，不向模型展示。

因此存在两种看似反常、实则必要的情况：

1. registry 有 runtime，但 visible specs 没有它，例如 legacy shell 在 unified exec 模式下作为隐藏兼容入口；
2. visible specs 中有 hosted model tool，但本地 registry 没有 handler，因为它由模型服务执行。

“模型能看到什么”与“本地能分派什么”不是同一个集合，也不应该强行相等。

## spec plan 如何汇聚工具来源

[`spec_plan.rs`](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/core/src/tools/spec_plan.rs) 根据 Turn/Step 上下文汇聚：

- shell、`exec_command`、`write_stdin`、`apply_patch`；
- MCP resource 工具和 MCP server runtimes；
- `update_plan`、图片查看、时间与权限请求等 core utilities；
- collaboration / multi-agent 工具；
- extensions、dynamic tools、apps/connectors；
- hosted web search 等服务端工具。

随后 `build_model_visible_specs_and_registry` 做两件不同的事：

```text
PlannedTools
  ├─ runtime.exposure().is_direct()
  │    → spec_for_model_request
  │    → namespace merge/filter
  │    → model_visible_specs
  └─ all runtimes
       → ToolRegistry::from_tools
```

重复工具名不能悄悄覆盖旧实现；registry 构建会把重复注册视为错误。Namespace 工具还可能把多个具体工具合并为一个模型可发现的命名空间，减少初始上下文体积。

最终生成的 `ToolRouter` 被放进 StepContext。这意味着同一个 sampling request 使用同一份 visible specs 和 registry 视图。

## ToolRouter 如何解释模型输出

[`ToolRouter`](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/core/src/tools/router.rs) 内部只有两个核心字段：

```rust
pub struct ToolRouter {
    registry: ToolRegistry,
    model_visible_specs: Vec<ToolSpec>,
}
```

`build_tool_call` 接受完成后的 `ResponseItem`，支持解析普通 FunctionCall、custom/freeform 调用和 tool-search 调用。对普通函数调用，它把 namespace 与 name 组合为 `ToolName`，保留 `call_id`，并把 JSON 参数封装为 `ToolPayload::Function`：

```text
ResponseItem::FunctionCall
  { namespace, name, arguments, call_id }
          │
          ▼
ToolCall
  { ToolName, ToolPayload::Function, call_id }
```

Router 此时没有执行 shell 或修改文件。它只完成协议形状到本地调用对象的转换；真正的副作用仍在 registry/handler 下游。

## ToolInvocation：把调用和上下文一起交给 handler

分派前，Router 构造 `ToolInvocation`，其中包含：

- `Arc<Session>`；
- 捕获该工具计划的 `Arc<StepContext>` 与 TurnContext；
- tool name、`call_id` 和 payload；
- cancellation token；
- Turn diff tracker；
- 调用来源，例如直接模型工具或 code mode。

保留 StepContext 是一个重要并发约束：工具 future 可能晚于网络事件开始执行，但它仍应使用“当时向模型展示该工具”的 step 视图，而不是临时拼一份新 router。

## Registry 是统一的编排闸门

[`ToolRegistry::dispatch_any_with_terminal_outcome`](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/core/src/tools/registry.rs) 的顺序值得逐步阅读：

1. 增加活动 Turn 的工具调用计数。
2. 按 `ToolName` 查 runtime；不存在则返回模型可见错误。
3. 检查 payload kind 是否与 handler 匹配；类型不变量破坏属于 fatal。
4. 发出 tool start 生命周期。
5. 运行 PreToolUse hook；hook 可以阻止，也可以重写输入。
6. 调用具体 `ToolExecutor::handle`。
7. 收集输出、成功状态、diff 和 telemetry。
8. 运行 PostToolUse hook，并记录附加上下文。
9. 发出唯一的 terminal outcome。

用时序表示：

```text
ToolRouter
  → ToolRegistry lookup
  → kind check
  → notify start
  → pre hook ── blocked ──→ model-visible failure
       │ continue / rewrite
       ▼
    handler.handle
       ▼
    post hook + telemetry + diff
       ▼
    AnyToolResult → ResponseInputItem
```

PostToolUse 的 block 发生在副作用完成之后，因此它能拒绝“把结果当成功继续使用”，却不能时间倒流撤销已经执行的命令。教程和产品文案都不应把 post hook 描述成操作系统级事务回滚。

## 可恢复错误和 fatal 错误

工具错误至少分两类：

- `FunctionCallError::RespondToModel(message)`：未知工具、参数解析失败、策略阻止等可被模型修正的错误；core 将其转换为失败输出，再次采样；
- `FunctionCallError::Fatal(message)`：payload kind 与已注册 handler 契约不一致等内部不变量破坏；通常终止 Turn。

命令退出码非零也不必然是 fatal。它常是一个合法工具结果，模型可以读 stderr、修正命令并重试。若所有失败都升级为 fatal，Agent 就失去自我修正能力；若所有错误都降级为字符串，内部类型错误又会被掩盖。

## 并行调度的读写锁技巧

[`ToolCallRuntime`](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/core/src/tools/parallel.rs) 持有一个 Turn 内共享的 `RwLock<()>`：

- handler 声明支持 parallel 时取得 read lock；多个 read lock 可同时存在；
- 不支持 parallel 时取得 write lock；它会等待所有 reader，并阻止其他 reader/writer。

这不是按工具名分别加锁，而是一道 Turn 级执行闸门：任一串行工具都与同 Turn 的其他工具互斥。典型只读工具、独立 shell 命令可显式并行；依赖共享顺序的工具默认串行。

取消也经过同一 runtime。部分工具要求等待 runtime 自己完成清理，另一些 future 可以直接 abort；terminal outcome 用原子状态避免“取消路径”和“正常完成路径”各发一次完成事件。

## 并发执行，为什么还能稳定写回

并行只改变“什么时候运行”，不能打乱模型历史。`try_run_sampling_request` 将工具 futures 按模型输出顺序放入 `FuturesOrdered`；[`drain_in_flight`](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/core/src/session/turn.rs) 按该顺序取结果，再转换为 `ResponseItem` 记录：

```text
模型输出顺序: call A, call B
实际完成顺序:       B, A
历史写回顺序: output A, output B
```

等待 A 写回不会阻止 B 在后台执行，只是约束 transcript 顺序。这样重放、快照测试和下一次 Prompt 都具有确定性。每个 output 仍通过自己的 `call_id` 与调用配对，顺序和身份是两道独立保证。

## 一次工具闭环的请求/事件示意

```json
// 模型完成一个调用项
{"type":"function_call","name":"update_plan","call_id":"c1","arguments":"{...}"}

// Router/Registry/Handler 后形成模型输入项
{"type":"function_call_output","call_id":"c1","output":"plan updated"}
```

完整链路是：

```text
ResponseEvent::OutputItemDone
  → handle_output_item_done
  → ToolRouter::build_tool_call
  → ToolCallRuntime::handle_tool_call
  → ToolRegistry::dispatch_any_with_terminal_outcome
  → concrete handler
  → ResponseInputItem
  → drain_in_flight
  → Session::record_conversation_items
  → next Responses request
```

调用项会在排入 future 前先记录。即便工具随后失败，历史仍能表达“模型曾请求什么、系统返回了什么”。

## 安全实验一：验证 malformed payload 如何返回模型

本地 mock 测试不会连接真实模型：

```bash
cd <project-root>
just test -p codex-core \
  suite::tool_harness::update_plan_tool_rejects_malformed_payload
```

阅读测试时检查第二次 Responses 请求，确认 malformed 参数不是 panic，而是与原调用关联的失败 output。

## 安全实验二：观察并发与稳定分组

```bash
cd <project-root>
just test -p codex-core \
  suite::tool_parallelism::read_file_tools_run_in_parallel
just test -p codex-core \
  suite::tool_parallelism::tool_results_grouped
just test -p codex-core \
  suite::tool_parallelism::shell_tools_start_before_response_completed_when_stream_delayed
```

第一个测试观察墙钟时间证明并发，第二个验证结果分组/顺序，第三个验证工具无需等待 response completed 才启动。计时断言只能作为集成证据，设计依据仍应来自 handler 的并行声明和 RwLock 闸门。

## 常见误区

- 认为 ToolSpec 就是执行权限。它只描述模型能提出什么，本地策略仍握有最终执行权。
- 认为 visible specs 与 registry 必须完全相同。Hidden、Deferred 和 hosted 工具都证明二者可以有意不同。
- 在 Router 中直接实现工具副作用。Router 应负责协议转换，handler/runtime 才拥有具体行为。
- 默认所有函数调用都可并行。handler 必须显式声明，串行工具通过 write lock 与其他调用互斥。
- 认为并发完成顺序就是历史顺序。`FuturesOrdered` 有意恢复模型输出顺序。
- 丢掉 `call_id`，只按 tool name 配对。同名工具可以在一个响应中调用多次，名字不足以建立一一关系。
- 把任何 handler 错误都当 fatal。参数或策略错误通常应让模型看到并修正。
- 认为 PostToolUse block 能撤销已完成副作用。它发生在 handler 之后，不是数据库事务回滚。

## 自测题

1. spec、visible plan、registry、router 和 handler 分别回答什么问题？
2. 为什么 legacy/内部工具可能注册却不向模型展示？
3. hosted tool 为什么可能可见却没有本地 handler？
4. StepContext 固定 ToolRouter 解决了什么竞态？
5. PreToolUse 与 PostToolUse 在副作用发生时间上有什么本质差异？
6. `RespondToModel` 和 `Fatal` 应分别用于什么失败？
7. RwLock 的 read/write guard 如何表达 parallel/serial 工具？
8. 为什么既需要稳定输出顺序，又需要 `call_id` 配对？

## 源码定位

- [ToolExecutor 与 ToolExposure](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/tools/src/tool_executor.rs)
- [工具规格与来源规划](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/core/src/tools/spec_plan.rs)
- [ToolRouter 与 ToolCall](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/core/src/tools/router.rs)
- [ToolRegistry、hook 与 telemetry 编排](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/core/src/tools/registry.rs)
- [并行执行闸门与取消](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/core/src/tools/parallel.rs)
- [模型完成项到工具 future](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/core/src/stream_events_utils.rs)
- [有序排空工具结果](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/core/src/session/turn.rs)
- [工具并行集成测试](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/core/tests/suite/tool_parallelism.rs)

下一章选择副作用最明显的一组 handler，追踪 unified exec、后台 live process、`write_stdin` 与 `apply_patch` 的安全执行路径。
