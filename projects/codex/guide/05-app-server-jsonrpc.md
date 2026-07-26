# 05. app-server JSON-RPC v2：把外部客户端接到 Thread、Turn 与 Item

> 本章对应源码快照 <code>61a44880a85d2fd0d8770908dea5733495e571c8</code>。链接都固定到这个提交；以后协议变化时，应先对照新版本源码和生成的 schema。

## 学习目标

学完本章，你应该能够：

- 解释 app-server 为什么“长得像 JSON-RPC 2.0”，却不能直接当作标准 JSON-RPC 2.0 实现；
- 画出 Connection → Thread → Turn → Item 的对象与事件关系；
- 从一个方法名追到协议类型、连接门禁、请求处理器和集成测试；
- 正确处理初始化、实验性 API、流式通知、背压和断线重连；
- 写一个不依赖真实模型凭据的最小握手实验。

## 1. 先补背景：RPC、事件流和状态机不是一回事

RPC（Remote Procedure Call）把跨进程交互包装成“方法 + 参数 → 结果或错误”。JSON-RPC 2.0 通常要求每条消息携带 <code>"jsonrpc":"2.0"</code>。Codex app-server 使用相似的请求、响应、通知和错误形状，但刻意省略这个字段。因此，最稳妥的理解是：

> app-server 有一套 JSON-RPC-like 的有状态协议，而不是可随意替换传输层和握手语义的通用 JSON-RPC 服务器。

“调用 <code>thread/start</code> 得到响应”只是控制面；模型推理过程中的 item 增量、审批请求、turn 完成等是异步事件流。客户端既要维护 RPC 请求 ID，也要维护会话状态机。

一个简化关系如下：

~~~text
一条连接
  ├─ initialize（恰好一次）
  ├─ initialized 通知
  └─ 多个 Thread
       └─ 多个 Turn（通常顺序执行）
            └─ 多个 Item
                 started → 若干 delta → completed
~~~

Thread 是长期会话，Turn 是一次用户驱动的推理周期，Item 是消息、工具调用、推理摘要等可观察单元。不要把 transport connection 当成 thread，也不要把一次 RPC response 当成整个 turn 的结果。

## 2. 协议外壳：消息到底长什么样

协议基础类型定义在 [rpc.rs](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/app-server-protocol/src/rpc.rs)。下面是结构化后的等价伪代码：

~~~rust
enum Message {
    Request { id: RequestId, method: String, params: Value },
    Notification { method: String, params: Value },
    Response { id: RequestId, result: Value },
    Error { id: RequestId, error: ErrorObject },
}
~~~

真实的 `JSONRPCMessage` 使用 `#[serde(untagged)]`：serde 根据字段形状区分四种结构，而不是依赖额外的 `type` 标签。关键不是背类型名，而是掌握四类消息的配对规则：

- Request 必须带 ID，服务器最终返回同 ID 的 Response 或 Error；
- Notification 没有 ID，也不期待响应；
- 服务器可以在一个请求尚未完成时主动发通知；
- ID 只解决“响应属于哪个请求”，不解决“通知属于哪个 thread/turn/item”。

方法注册表集中在 [common.rs](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/app-server-protocol/src/protocol/common.rs)。宏把 Rust 枚举变体、wire method 名称、Params 和 Response 类型绑定在一起，例如 <code>ThreadStart ↔ "thread/start"</code>。这比在处理器中散落字符串更容易生成 schema、检查遗漏和保持 Rust/TypeScript 一致。

## 3. 初始化门禁：为什么第一条业务请求会失败

初始化参数和能力协商类型位于 [v1.rs](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/app-server-protocol/src/protocol/v1.rs)，但这不表示后续业务 API 应继续开发在 v1。初始化是连接级兼容层；活跃业务 API 以 v2 为主。

协议文档规定的完整握手时序是：

~~~json
{"id":1,"method":"initialize","params":{"clientInfo":{"name":"study-client","version":"0.1.0"},"capabilities":{}}}
{"id":1,"result":{"userAgent":"codex_app_server/...","codexHome":"<CODEX_HOME>","platformFamily":"unix","platformOs":"linux"}}
{"method":"initialized"}
{"id":2,"method":"thread/start","params":{...}}
~~~

注意示例没有 <code>jsonrpc</code> 字段。连接状态由 [message_processor.rs](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/app-server/src/message_processor.rs) 中的 <code>ConnectionSessionState</code> 守卫：

1. 初始化前，普通业务请求会被拒绝；
2. `initialize` request 成功时，当前实现就切换连接状态，同一连接不能再次初始化；
3. 此后请求才进入 <code>dispatch_initialized_client_request</code>；
4. 实验性方法或字段还会经过额外能力门禁。

这里要区分“文档握手”与“当前门禁实现”：客户端仍应按约定发送 `initialized` notification，但当前服务端收到它时只记录日志；真正解除业务门禁的是成功处理 `initialize` request，而不是等待这条 notification。

这是一种 typestate 思想：即使 Rust 类型没有把连接状态编码成泛型，运行时仍强制“未初始化态不能执行已初始化态操作”。

## 4. v2 的核心对象：Thread、Turn、Item

协议按领域拆分，而不是塞进单一巨型文件：

- [thread.rs](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/app-server-protocol/src/protocol/v2/thread.rs)：创建、读取、恢复、分叉和归档 thread；
- [turn.rs](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/app-server-protocol/src/protocol/v2/turn.rs)：开始、打断和 steer turn；
- [item.rs](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/app-server-protocol/src/protocol/v2/item.rs)：定义对客户端可见的 item 联合类型。

客户端应把通知看成增量状态转换，而不是日志文本：

~~~text
thread/start response
  ↓
turn/start response
  ↓
item/started(item A)
  ↓
item/.../delta(item A, chunk 1..n)
  ↓
item/completed(item A)
  ↓
turn/completed
~~~

<code>turn/completed</code> 是 turn 级结束信号和摘要兜底，并不能替代逐个 item 通知。若客户端只保存最后一条完成通知，遇到工具调用、多模态输入或中途审批时会丢失结构。

### 4.1 从协议到执行的调用链

以 <code>thread/start</code> 为例，阅读路线是：

~~~text
common.rs 方法注册
  → v2/thread.rs 的 ThreadStartParams / Response
  → message_processor.rs 的连接与实验性门禁
  → request_processors/thread_processor.rs
  → request_processors/thread_lifecycle.rs
  → core 的 ThreadManager
  → item / turn 通知回到连接
~~~

这条路线揭示三个边界：protocol crate 只定义 wire contract；app-server 负责连接和 API 编排；core 承担 agent 会话语义。新增方法时，不能只添加一个 serde struct 就认为功能完成。

## 5. 传输、背压与连接关闭

[app-server README](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/app-server/README.md) 是传输行为的第一入口：

- 默认 stdio：每行一条 JSON 消息，适合父进程启动子进程；
- WebSocket：仍属实验性，适合长连接客户端；
- Unix socket WebSocket：把监听范围限制在本机文件系统入口；
- 队列有界；客户端消费过慢时，不可能无限缓存通知。

“有界”是可靠性设计而非小实现细节，但不同方向和 transport 的饱和语义不同：

- 入站 request 队列饱和时，新请求会收到 overload 错误 <code>-32001</code>；
- 可断开的 WebSocket 客户端消费 outbound 消息过慢、writer 队列装满时，服务端关闭该连接；
- stdio 的 outbound 队列满时，发送方会等待容量，由背压向上游传播，而不是按同一规则断开。

具体分支位于 [transport.rs](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/app-server/src/transport.rs)。生产客户端需要：

- 独立读取循环，及时 drain 通知；
- 给未决 request ID 建表，并在断线时统一失败；
- 将 item 增量合并做成幂等或可检测重复；
- 不假设通知严格紧邻触发它的响应。

[connection_rpc_gate.rs](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/app-server/src/connection_rpc_gate.rs) 还负责连接收尾时的 drain 行为。理解这里能避免“关闭 stdin 后为什么仍需等服务器完成输出”的困惑。

## 6. API 设计规则：Rust 类型就是 wire contract 的源头

开发 v2 API 时，应同时考虑 serde 和生成的 TypeScript：

- 请求、响应、通知分别命名为 <code>*Params</code>、<code>*Response</code>、<code>*Notification</code>；
- wire 字段和字符串枚举默认 camelCase；
- v2 类型输出到 <code>v2/</code>；
- client → server 的可选字段用可省略且可为 null 的 TS 表达；
- 联合类型在 serde 与 TS 两侧使用一致的显式 discriminator；
- ID 在 API 边界优先保持 String，内部再解析；
- 新 list API 默认考虑 cursor pagination；
- 实验性表面必须显式标注并由初始化能力开启。

schema 生成入口可从 [write_schema_fixtures.rs](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/app-server-protocol/src/bin/write_schema_fixtures.rs) 追踪。改协议后运行：

~~~bash
cd codex-rs
just write-app-server-schema
just write-app-server-schema --experimental
just test -p codex-app-server-protocol
~~~

生成文件变化是 API diff 的可审查证据，不能只看 Rust 是否编译。

## 7. 不调用真实模型的最小实验

### 实验 A：观察握手

仓库提供测试客户端入口：

~~~bash
cd codex-rs
just app-server-test-client watch
~~~

学习时先只完成 <code>initialize</code> 和 <code>initialized</code>，记录每行 JSON，验证请求 ID 配对。不要填真实 token；握手本身不需要执行真实 turn。

### 实验 B：读集成测试作为可执行规范

[TestAppServer](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/app-server/tests/common/test_app_server.rs) 封装了子进程、请求与通知等待。依次阅读：

1. [initialize.rs](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/app-server/tests/suite/v2/initialize.rs)，确认门禁和能力协商；
2. [thread_start.rs](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/app-server/tests/suite/v2/thread_start.rs)，观察参数如何进入 core；
3. [turn_start.rs](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/app-server/tests/suite/v2/turn_start.rs)，观察模型响应如何映射为 item；
4. [experimental_api.rs](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/app-server/tests/suite/v2/experimental_api.rs)，观察未协商能力时的拒绝。

测试里的模拟 Responses SSE 比手工连接真实服务更适合学习：输入、服务端事件和客户端可见通知都可控，失败也可复现。

## 8. 常见误区

1. **给每条消息强加 <code>"jsonrpc":"2.0"</code>。** 当前协议明确省略它，标准库的严格模式可能无法直接使用。
2. **把 <code>initialized</code> 当成当前实现的状态开关。** 完整客户端仍应按文档发送它，但当前服务端在 `initialize` request 成功时就解除门禁，notification 本身只被记录。
3. **把 RPC response 当成推理结果全集。** 真正的流式内容通过通知到达。
4. **只按到达顺序拼文本。** 应按 thread、turn、item ID 归属并应用生命周期事件。
5. **在 v1 增加业务 API。** 当前开发规则要求新增表面进入 v2。
6. **给可选字段加任意 serde 默认值。** omission、null 和默认值可能是不同的 wire 语义。
7. **忽略慢消费者。** 有界队列意味着读取循环是协议正确性的一部分。
8. **只更新 Rust，不更新 schema、README 和测试。** 多语言客户端依赖生成契约。

## 9. 自测题

1. app-server 与标准 JSON-RPC 2.0 最直观的 wire 差异是什么？
2. Request ID 和 Item ID 分别解决哪一层关联问题？
3. 为什么 <code>turn/completed</code> 不能代替 <code>item/completed</code>？
4. 一个新 v2 方法至少要经过哪四层代码？
5. 客户端消费通知太慢可能发生什么？应该怎样设计读取循环？
6. 初始化能力协商如何保护实验性 API？
7. 如果 Rust 测试通过但生成 schema 有 diff，是否可以忽略？为什么？

能不看源码回答这些问题，并能在测试中指出对应证据，就已经掌握了 app-server 的骨架。
