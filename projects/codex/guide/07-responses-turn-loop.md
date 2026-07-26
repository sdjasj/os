# 07. Responses 与 Turn Loop：模型、工具和再次采样如何闭环

一个 Turn 不是一次 HTTP 请求。模型可能先要求运行命令，Codex 执行后把结果送回模型，模型再要求修改文件，最后才给出文字答复。固定快照中的 [`run_turn`](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/core/src/session/turn.rs) 正是这个循环的编排中心。本章从 `Prompt` 走到 HTTP/SSE 与 WebSocket，再沿事件流返回 core，完整解释一次“模型 → 工具 → 模型”的 Turn。

## 先区分 Turn、sampling step 和 response

| 概念 | 开始条件 | 结束条件 | 数量关系 |
| --- | --- | --- | --- |
| Turn | 用户输入或显式任务启动 | 无需 follow-up，或被中断/失败 | 一个 Turn 包含多个 step |
| sampling step | core 构造 Prompt 并请求模型 | 收到本次 response 的完成或错误 | 每个 step 对应一次模型请求 |
| response | 模型服务接受一个请求 | `response.completed` 或终止错误 | 提供方协议对象 |
| output item | response 中加入一项 | 对应 item done | 一个 response 可有多项 |
| delta | item 的增量片段 | item 完成 | 只适合流式展示，不是最终历史 |

工具型 Agent 的本质就是：一个 sampling step 的输出，可能成为下一个 sampling step 的输入。

## Prompt 是 core 与模型客户端的边界

[`Prompt`](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/core/src/client_common.rs) 并不是拼接后的单一字符串：

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

`input` 已由 ContextManager 整理为模型可见的有序项；`tools` 是本 step 的模型可见规格；`parallel_tool_calls` 只说明协议允许模型在一次响应中提出多个调用，并不自动让所有 handler 并发；`output_schema` 约束最终答复的结构。

`build_prompt` 从 StepContext 的固定 `ToolRouter` 取 visible specs，再从 TurnContext 取模型能力、基础指令和输出 schema。至此 core 仍未决定走 SSE 还是 WebSocket，这个传输选择属于 `ModelClientSession`。

## run_turn 的完整阶段

一次普通 Turn 可拆成八段：

1. 创建或复用 Turn 级 `ModelClientSession`。
2. 在新输入写入前检查是否需要 pre-sampling compaction。
3. 捕获第一个 `StepContext`，记录配置/WorldState 增量。
4. 运行 skills、plugins 与输入 hooks，把真实输入记录进历史。
5. 从 ContextManager 取得 `for_prompt()` 结果，执行一次 sampling request。
6. 流式消费文本、推理和工具调用；工具可以在 response completed 前启动。
7. 合并工具输出、steer 输入和 token 状态，判断是否 follow-up 或压缩。
8. 没有后续工作时运行 stop hooks，结束 Turn。

简化后的控制流是：

```text
run_turn
  ├─ pre-compact?
  ├─ capture StepContext
  ├─ record context diff + user input
  └─ loop
      ├─ drain pending steer input
      ├─ capture/consume one StepContext
      ├─ ContextManager::for_prompt
      ├─ run_sampling_request
      │   ├─ client_session.stream
      │   ├─ consume ResponseEvent
      │   └─ drain ordered tool futures
      ├─ compact if follow-up would exceed budget
      ├─ continue if tool/pending input/end_turn=false
      └─ stop hooks → finish
```

`StepContext` 每轮只捕获一次，保证这次请求展示的工具与随后执行该响应的 router 一致。重试则会从 Session 的当前历史重新构造 Prompt，而不是无条件重复一份已经过期的输入快照。

## Responses 请求长什么样

[`build_responses_request`](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/core/src/client.rs) 将 Prompt 转成 `ResponsesApiRequest`。下面是字段示意，不是真实请求记录：

```json
{
  "model": "<resolved-model>",
  "instructions": "<base instructions>",
  "input": [
    {"role": "user", "content": [{"type": "input_text", "text": "检查构建失败"}]}
  ],
  "tools": [
    {"type": "function", "name": "exec_command", "parameters": {}}
  ],
  "tool_choice": "auto",
  "parallel_tool_calls": true,
  "reasoning": {"effort": "...", "summary": "..."},
  "stream": true,
  "include": ["reasoning.encrypted_content"]
}
```

真实请求还可能带 service tier、prompt cache key、严格 JSON Schema、client metadata 与 stream options。Responses Lite 模式不会使用相同的顶层 tools/instructions 形状：它会把 `AdditionalTools` 和 developer message 插到 input 前缀。这是 wire 编码差异，不应反向污染 core 的 Prompt 抽象。

在发送前，client 还会清除不应回传给服务端的本地 item ID。不要把本地生成 ID 当作服务端可接受的通用 ID。

## HTTP + SSE：把网络字节变成 ResponseEvent

HTTP 路径向 `/responses` 发起流式请求。服务端返回 SSE 后，`codex-api` 负责解析事件并归一化为 [`ResponseEvent`](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/codex-api/src/common.rs)：

- `Created`；
- `OutputItemAdded(ResponseItem)`；
- `OutputTextDelta(String)`；
- `ToolCallInputDelta`；
- reasoning delta/done；
- `OutputItemDone(ResponseItem)`；
- `Completed { response_id, token_usage, end_turn }`；
- rate limit、模型路由和安全元数据等旁路事件。

概念时间轴如下：

```text
response.created
  → output_item.added(function_call)
  → function_call.arguments.delta ...
  → output_item.done(function_call)
      └─ 本地工具已可开始执行
  → response.completed
  → 本地工具输出写入历史
  → 下一次 /responses
  → output_item.added(message)
  → output_text.delta ...
  → output_item.done(message)
  → response.completed
```

注意 `response.completed` 不是“整个 Turn 完成”。它只结束一次供应商响应。是否继续由 core 综合工具调用、pending input 和 `end_turn` 决定。

## OutputItemDone 如何触发工具

`try_run_sampling_request` 消费事件流。收到 `OutputItemDone` 时，交给 [`handle_output_item_done`](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/core/src/stream_events_utils.rs)：

- 若是普通消息或 reasoning：完成对应 `TurnItem`，记录最终 `ResponseItem`；
- 若可解析为工具调用：先持久化调用项，再创建工具 future，并设置 `needs_follow_up = true`；
- 若参数错误属于 `RespondToModel`：构造失败的工具输出，让模型有机会修正；
- 若是 fatal：终止当前采样/Turn。

调用项先记录、输出后记录非常重要。下一次 Prompt 中必须出现合法配对：

```json
[
  {
    "type": "function_call",
    "name": "exec_command",
    "call_id": "call-7",
    "arguments": "{\"cmd\":\"just test -p demo\"}"
  },
  {
    "type": "function_call_output",
    "call_id": "call-7",
    "output": "...test result..."
  }
]
```

如果只有 output 没有 call，服务端无法知道输出属于哪次请求；如果只有 call 没有 output，历史归一化必须补齐或清理不完整配对。

## 何时 needs_follow_up

以下任一条件可让 loop 再采样：

- 模型返回了本地工具调用；
- `ResponseEvent::Completed` 显式给出 `end_turn: false`；
- 模型运行期间用户又提交了 steer/mailbox 输入；
- stop hook 阻止结束并注入 continuation fragment。

若 follow-up 前 token 已到阈值，`run_turn` 会先进行 mid-turn compaction 或开启新 context window，再继续尚未完成的模型/工具链。压缩失败不能被当作普通空回复悄悄忽略。

## 为什么工具可在 response.completed 前启动

工具调用的完整参数在 `OutputItemDone` 时已经确定，无需等待本 response 的计费或其他尾部元数据。core 会把工具 future 加入 in-flight 队列，继续消费网络流；最后再排空工具结果。这减少了模型输出尾部延迟与本地执行延迟的串行叠加。

对应集成测试是 `shell_tools_start_before_response_completed_when_stream_delayed`。测试故意延迟 completed 事件，并证明 shell 已先启动。这个优化仍保留一个约束：工具调用项先进入历史，工具输出按稳定顺序写回。

## WebSocket：连接复用不等于上下文一定增量

[`ModelClientSession::stream`](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/core/src/client.rs) 在 provider 声明支持且当前 Session 未禁用 WebSocket 时优先尝试 WS；失败达到策略阈值后会切到 HTTP，并清空 WS session 状态。Turn 级 `ModelClientSession` 还保存连接、上次请求、上次响应和粘性的 turn state。

WebSocket 连接已复用，不代表一定只发送 input delta。增量请求必须同时满足：

1. 存在上一次请求和刚完成的 `LastResponse`；
2. 除 input 外的请求属性一致，例如模型、tools、instructions、reasoning 与输出格式没有变化；
3. 新请求 input 的前缀逐项等于“上次请求 input + 上次服务端新增的 output items”；比较会忽略仅供本地使用的内部 metadata；
4. 上次 `response_id` 非空；
5. input 能在上述基线之后切出一个增量后缀。

满足后，WS create 携带 `previous_response_id` 与后缀 items：

```text
previous request input:   [A, B]
previous response items:        [C]
new request input:        [A, B, C, D]
                                      └─ incremental delta = [D]
```

当前 `prepare_websocket_request` 路径允许空后缀，因此 `[A, B, C]` 也可以复用 `previous_response_id`；源码注释中的“strict extension”应结合这个 `allow_empty_delta = true` 例外理解。若基线不匹配、tools 改变或上次响应出错，则发送完整 create，不得用错误的 `previous_response_id` 强行续接。

## 三种事件表示不要混淆

| 表示 | 所在边界 | 用途 |
| --- | --- | --- |
| `codex_api::ResponseEvent` | 模型传输层 | 归一化 SSE/WS 流 |
| `ResponseItem` | 模型上下文层 | 组成下一次 Prompt 与 durable transcript |
| `EventMsg` / `TurnItem` | core 到客户端 | 展示 item 开始、增量、完成、Turn 生命周期 |

文本 delta 可即时发给 UI，但最终历史应记录完成后的 `ResponseItem`。`RawResponseCompleted` 可以携带 response ID 与 token usage，却仍不等于 `TurnComplete`。

## 安全实验一：用 mock SSE 验证两次请求

测试不使用真实账户或真实模型，mock server 会返回预设 SSE：

```bash
cd <project-root>
just test -p codex-core \
  suite::tool_harness::shell_command_tool_executes_command_and_streams_output
```

阅读 [`tool_harness.rs`](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/core/tests/suite/tool_harness.rs) 时标出：第一次 mock 如何返回 FunctionCall，第二次 mock 如何捕获新的 `/responses` 请求，以及断言如何按 `call_id` 读取 function-call output。

## 安全实验二：验证 WebSocket 增量判定

```bash
cd <project-root>
just test -p codex-core \
  suite::client_websockets::responses_websocket_uses_previous_response_id_when_prefix_after_completed
just test -p codex-core \
  suite::client_websockets::responses_websocket_creates_on_non_prefix
just test -p codex-core \
  suite::client_websockets::responses_websocket_creates_when_non_input_request_fields_change
```

三个测试分别验证：合法前缀使用 previous response ID、input 非前缀时完整创建、非 input 属性变化时完整创建。它们只启动本地测试服务，不会连接生产模型端点。

## 常见误区

- 把 Turn 等同于一个 `/responses` 请求。工具与 steer 都能让同一 Turn 多次采样。
- 收到 `response.completed` 就发 `TurnComplete`。core 还要等待工具、pending input、token/compaction 和 stop hooks。
- 把 delta 直接追加为永久历史。delta 用于展示，完成 item 才是稳定上下文单位。
- 等 response completed 后才执行工具。完整工具 item done 后即可启动，尾部网络流可与执行重叠。
- 认为 WebSocket 永远发送增量。只有请求属性和完整上下文前缀满足条件时才安全。
- 只比较最新用户消息判断 WS 前缀。基线还包括上次请求 input 和服务端新增 output items。
- 把 HTTP fallback 当成 Turn 失败。WS 不健康时，Session 可切换到 HTTP 继续相同逻辑请求。
- 认为 `parallel_tool_calls: true` 会让任何工具并发。真正的并发许可还由本地 handler 声明和调度闸门决定。

## 自测题

1. 为什么一个 Turn 可以有多个 sampling step？
2. Prompt 中的 tools 与本地执行权限是什么关系？
3. `OutputItemDone(FunctionCall)` 到达后，为什么工具可以在 response completed 前开始？
4. 哪几种条件会令 `needs_follow_up` 为真？
5. 下一次请求为什么必须同时包含工具调用和同 `call_id` 的输出？
6. WebSocket 增量请求的基线由哪两部分组成？
7. tools 或 reasoning 配置发生变化时，即使 input 前缀一致，为什么也不能继续增量？
8. `ResponseEvent`、`ResponseItem` 和 `EventMsg` 分别服务于哪一层？

## 源码定位

- [Prompt 与 ResponseStream](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/core/src/client_common.rs)
- [run_turn 与 sampling loop](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/core/src/session/turn.rs)
- [Responses 请求构造、HTTP 与 WebSocket 选择](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/core/src/client.rs)
- [Responses API 统一事件](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/codex-api/src/common.rs)
- [HTTP Responses endpoint](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/codex-api/src/endpoint/responses.rs)
- [WebSocket Responses endpoint](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/codex-api/src/endpoint/responses_websocket.rs)
- [SSE 映射](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/codex-api/src/sse/responses.rs)
- [完成 item 的本地处理](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/core/src/stream_events_utils.rs)
- [WebSocket 集成测试](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/core/tests/suite/client_websockets.rs)

下一章沿 `OutputItemDone(FunctionCall)` 向下追踪：工具为何对模型可见、如何进入 registry、怎样经过 router、hook 与并发调度后稳定写回。
