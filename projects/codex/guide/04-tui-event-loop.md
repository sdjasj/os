# 04. TUI 不是 Core 的外壳：App-Server 协议、Ratatui 与 `tokio::select!` 事件循环

Codex TUI 表面上是一个终端聊天界面，架构上却是 app-server 客户端。固定快照中，无论 TUI 使用同进程的 embedded server、复用本地 daemon，还是连接显式远程 server，Agent 控制路径都通过 app-server 的 typed request、server notification 和 server request。内嵌只消除了 socket/进程边界，没有创造一套“直接调用 core”的旁路。

理解这一点后，TUI 的复杂代码会清晰很多：它不拥有 Agent 的权威会话状态，而是同时消费终端事件、内部 UI 命令、活跃 thread 投影和 app-server 协议事件，再把这些信息渲染为屏幕。顶层 `tokio::select!` 就是四个世界的交汇点。

## 固定快照与学习目标

```text
repository: https://github.com/openai/codex
commit:     61a44880a85d2fd0d8770908dea5733495e571c8
```

本章完成后，你应能：

1. 解释 embedded、local daemon 与 remote app-server 的区别；
2. 证明 embedded 路径仍保留 app-server 协议语义；
3. 说清 `AppServerClient`、`AppServerSession`、`App`、`ChatWidget` 和 `Tui` 的职责；
4. 逐分支解释主 `select!` 循环；
5. 追踪一次用户提交怎样变成 `turn/start`，通知又怎样回到 UI；
6. 理解为什么 UI 状态是 server 状态的投影，而不是事实来源；
7. 用针对性测试和 snapshot 验证 TUI 行为。

## 先补背景：终端 UI 是持续运行的状态机

普通命令行程序常是：读参数 → 执行 → 打印 → 退出。TUI 则必须长期同时处理：

- 键盘、鼠标、粘贴、焦点与 terminal resize；
- 定时或合并后的 redraw 请求；
- app-server 流式通知；
- server 发起、需要用户答复的审批/elicitation request；
- 后台 thread 的状态变化；
- 内部组件请求打开 picker、写配置、切线程或退出。

因此 TUI 更像一个 event-driven state machine：

```text
等待多个事件源
  -> 取先就绪的一项
  -> 更新 App/Widget 状态
  -> 必要时请求绘制或发协议请求
  -> 回到等待
```

它不是每收到一个 token 就递归调用整个界面，也不是每个事件源各自随意修改屏幕。

## Ratatui、Crossterm 与 Tokio 分别做什么

| 组件 | 责任 | 本章中对应对象 |
| --- | --- | --- |
| Crossterm | terminal raw mode、键盘、粘贴、尺寸等底层事件 | `TuiEvent` 的来源 |
| Ratatui | 把当前状态渲染为一帧 terminal cells | `Terminal`、widget render |
| Tokio | 异步 task、channel、stream 与多路等待 | `mpsc`、`select!`、`.await` |
| app-server client | typed 控制面请求与事件流 | `AppServerClient` |

Ratatui 是即时模式 UI：程序保存业务/UI 状态，需要更新时再按状态画完整区域。终端并不会替你保存“按钮组件树”。所以渲染函数应尽量是状态到画面的投影，I/O 与业务请求则由事件处理层协调。

## 启动链：从 `codex` 默认分支到 `App::run`

第 03 章已经走到 `subcommand == None`。继续向下：

```text
codex-rs/cli/src/main.rs
  -> run_interactive_tui
  -> codex_tui::run_main
     ├─ 解析 CLI overrides
     ├─ 选择 AppServerTarget
     ├─ 准备 EnvironmentManager 与 Config
     └─ run_ratatui_app
          ├─ tui::init
          ├─ start_app_server
          ├─ onboarding / picker / resume
          ├─ AppServerSession::bootstrap
          └─ App::run
```

关键入口：

- [`tui/src/lib.rs:911-1021`](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/tui/src/lib.rs#L911-L1021)：`run_main`、target 选择和 bootstrap config；
- [`tui/src/lib.rs:1324-1412`](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/tui/src/lib.rs#L1324-L1412)：terminal 与 app-server 启动；
- [`tui/src/lib.rs:1783-1841`](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/tui/src/lib.rs#L1783-L1841)：bootstrap、`App::run` 和 terminal 恢复。

## 第一个核心结论：TUI 总是选择一种 app-server target

[`AppServerTarget`](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/tui/src/lib.rs#L266-L285)是真实源码，未删节：

```rust
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum AppServerTarget {
    Embedded,
    LocalDaemon { endpoint: RemoteAppServerEndpoint },
    Remote { endpoint: RemoteAppServerEndpoint },
}

impl AppServerTarget {
    pub(crate) fn uses_remote_workspace(&self) -> bool {
        matches!(self, Self::Remote { .. })
    }

    fn thread_params_mode(&self) -> ThreadParamsMode {
        if self.uses_remote_workspace() {
            ThreadParamsMode::Remote
        } else {
            ThreadParamsMode::Embedded
        }
    }
}
```

三种 target 的语义：

| Target | server 在哪里 | client 传输 | 工作区语义 |
| --- | --- | --- | --- |
| Embedded | 与 TUI 同一进程 | 有界内存 channel | 本地 |
| LocalDaemon | 已运行的本地 app-server daemon | 本地远程端点/Unix socket | 本地 |
| Remote | 显式远端 app-server | 远程连接 | server/远端环境拥有路径语义 |

`ThreadParamsMode::Embedded` 这个名字包含 Embedded 和 LocalDaemon 的本地参数语义，不等于 LocalDaemon 也在 TUI 进程内。判断是否跨进程应看 `AppServerClient` variant，判断路径/工作区语义则看 target。

### target 怎样决定

`run_main` 会综合：

- 是否提供显式 remote endpoint；
- 默认 daemon socket 是否存在；
- 当前 CLI/config override 能否被复用的 daemon 正确重放；
- 当前 cwd 属于本地还是远程工作区。

显式 remote 优先；未显式 remote 且默认 daemon 可安全复用时选择 LocalDaemon；否则使用 Embedded。对应逻辑与测试位于：

- [`tui/src/lib.rs:862-909`](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/tui/src/lib.rs#L862-L909)
- [`tui/src/lib.rs:2569-2635`](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/tui/src/lib.rs#L2569-L2635)

这里的“可安全复用”很重要：daemon 不能自动继承本次进程所有非重放配置。若存在不可重放启动覆盖，宁可回退到 embedded，也不能悄悄忽略用户配置。

## `start_app_server` 只产生两种 client 实现

下面是 [`start_app_server`](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/tui/src/lib.rs#L451-L484) 的真实源码删节；参数列表保留，embedded 调用的长参数转发明确省略：

```rust
async fn start_app_server(
    target: &AppServerTarget,
    arg0_paths: Arg0DispatchPaths,
    config: Config,
    cli_kv_overrides: Vec<(String, toml::Value)>,
    loader_overrides: LoaderOverrides,
    strict_config: bool,
    cloud_config_bundle: CloudConfigBundleLoader,
    feedback: codex_feedback::CodexFeedback,
    log_db: Option<log_db::LogDbLayer>,
    state_db: Option<StateDbHandle>,
    environment_manager: Arc<EnvironmentManager>,
) -> color_eyre::Result<AppServerClient> {
    match target {
        AppServerTarget::Embedded => start_embedded_app_server(
            // ... 删节：把上述启动状态传入 embedded server ...
        )
        .await
        .map(AppServerClient::InProcess),
        AppServerTarget::LocalDaemon { endpoint } | AppServerTarget::Remote { endpoint } => {
            connect_remote_app_server(endpoint.clone()).await
        }
    }
}
```

统一 client enum 定义在 [`app-server-client/src/lib.rs:450-453`](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/app-server-client/src/lib.rs#L450-L453)：

```rust
pub enum AppServerClient {
    InProcess(InProcessAppServerClient),
    Remote(RemoteAppServerClient),
}
```

TUI 后续主要面对这个统一接口，而不需要在每个 widget 里判断 socket 还是 channel。

## 第二个核心结论：Embedded 仍然经过协议

“同进程”经常被误解为 TUI 直接拿到 `ThreadManager` 或 `CodexThread`。固定快照恰恰刻意避免这种双轨架构。

[`app-server/src/in_process.rs`](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/app-server/src/in_process.rs#L1-L39)的模块文档明确说明：

- socket/stdio 被有界内存 channel 替代；
- 输入是 typed `ClientRequest`；
- response 仍通过 app-server 使用的 JSON-RPC result envelope；
- 仍由同一个 `MessageProcessor` 处理；
- 高层 TUI/exec 应通过 `codex-app-server-client` facade。

下面是该模块文档中的真实源码片段，未删节：

```rust
//! The runtime is transport-local but not protocol-free. Incoming requests are
//! typed [`ClientRequest`] values, yet responses still come back through the
//! same JSON-RPC result envelope that `MessageProcessor` uses for stdio and
//! websocket transports. This keeps in-process behavior aligned with
//! app-server rather than creating a second execution contract.
```

这里要区分两件事：

```text
进程/传输边界：embedded 没有 socket 和 JSON 字节编解码成本
协议/语义边界：仍使用 ClientRequest、response envelope、notification、server request
```

### Embedded 也执行 initialize 握手

[`in_process::start`](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/app-server/src/in_process.rs#L350-L384)会启动 runtime，然后先发 `ClientRequest::Initialize`，成功后再发送 `ClientNotification::Initialized`，最后才返回可用 handle。

真实源码删节如下，错误清理分支明确省略：

```rust
pub async fn start(mut args: InProcessStartArgs) -> IoResult<InProcessClientHandle> {
    // ... 删节：execpolicy warning ...
    let initialize = args.initialize.clone();
    let client = start_uninitialized(args).await?;

    let initialize_response = client
        .request(ClientRequest::Initialize {
            request_id: RequestId::Integer(0),
            params: initialize,
        })
        .await?;
    // ... 删节：initialize error 时 shutdown 并返回错误 ...
    client.notify(ClientNotification::Initialized)?;

    Ok(client)
}
```

这让 embedded 与独立 app-server 在初始化能力、实验 API gate 和通知语义上保持一致。

## `AppServerSession`：TUI 的 typed RPC facade

[`tui/src/app_server_session.rs`](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/tui/src/app_server_session.rs#L1-L5)开头直接声明：该模块保存 TUI 需要的 typed JSON-RPC 调用，避免把 request/response plumbing 塞进 `App` 和 `ChatWidget`。

主要职责包括：

- 生成递增 request id；
- 把本地/远程路径和配置差异转换为 protocol params；
- 调用 `request_typed` 并把错误加上上下文；
- 保存启动时模型列表、server capability 等 session 级状态；
- 为 server request 提供 resolve/reject handle；
- 暴露统一 `next_event()`。

结构定义在 [`app_server_session.rs:164-202`](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/tui/src/app_server_session.rs#L164-L202)。注意它持有的是 `AppServerClient`，不是 `CodexThread`。

### 用户 Turn 最终成为 typed `turn/start`

[`AppServerSession::turn_start`](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/tui/src/app_server_session.rs#L894-L943)把 TUI 当前选择转换为 `TurnStartParams`。

以下是真实源码删节；保留了协议调用和关键字段，省略部分可选设置：

```rust
pub(crate) async fn turn_start(
    &mut self,
    thread_id: ThreadId,
    items: Vec<UserInput>,
    cwd: PathBuf,
    approval_policy: AskForApproval,
    // ... 删节：其余 TUI turn 设置参数 ...
) -> Result<TurnStartResponse> {
    let request_id = self.next_request_id();
    // ... 删节：把 permission override 转为 sandbox_policy/permissions ...
    self.client
        .request_typed(ClientRequest::TurnStart {
            request_id,
            params: TurnStartParams {
                thread_id: thread_id.to_string(),
                client_user_message_id: None,
                input: items,
                cwd: Some(cwd),
                approval_policy: Some(approval_policy),
                // ... 删节：workspace、model、effort、output schema 等 ...
            },
        })
        .await
        .wrap_err("turn/start failed in TUI")
}
```

即使 embedded，这里也构造 `ClientRequest::TurnStart`，随后进入 app-server `MessageProcessor` 和 `TurnRequestProcessor`，最后才被映射为 core 的 `Op::UserInput`。

## UI 内部消息：`TuiEvent`、`AppEvent` 与 `AppCommand`

三个 enum 名字相近，但边界不同。

### `TuiEvent`：terminal 输入和绘制时机

以下为 [`tui/src/tui.rs:544-557`](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/tui/src/tui.rs#L544-L557) 的真实源码删节；variant 完整，只省略各 variant 的 doc comment：

```rust
#[derive(Clone, Debug)]
pub enum TuiEvent {
    Key(KeyEvent),
    Paste(String),
    Resize,
    Draw,
}
```

它描述终端层事件，而不是 Agent protocol event。

### `AppEvent`：widget 到顶层 App 的内部总线

[`app_event.rs`](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/tui/src/app_event.rs#L1-L9)的模块文档说明，widget 用它请求只有顶层 App 才能完成的动作，避免直接访问 `App` 内部。

下面是 [`AppEvent`](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/tui/src/app_event.rs#L177-L309) 的真实源码删节：

```rust
pub(crate) enum AppEvent {
    OpenAgentPicker,
    SelectAgentThread(ThreadId),

    // ... 删节：side conversation、history、session lifecycle 等 ...

    NewSession { name: Option<String> },
    StartupThreadStarted { result: Result<AppServerStartedThread, String> },

    // ... 删节：resume、archive、fork 等 ...

    Exit(ExitMode),
    FatalExitRequest(String),

    /// Forward a command to the Agent.
    CodexOp(AppCommand),

    // ... 删节：其余应用级动作 ...
}
```

### `AppCommand`：TUI 想让 Agent 做什么

[`app_command.rs:24-99`](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/tui/src/app_command.rs#L24-L99)包含 `UserTurn`、`Interrupt`、审批答复、compact、review 等命令。它仍是 TUI 内部命令，不是 core `Op`；顶层 routing 会把它翻译为 app-server 请求。

这种分层可以压缩成：

```text
TuiEvent::Key/Paste
  -> ChatWidget 改 composer 状态
  -> 提交时产生 AppCommand::UserTurn
  -> AppEvent::CodexOp(AppCommand)
  -> App 顶层路由
  -> AppServerSession::turn_start/turn_steer
  -> ClientRequest
```

## `App::run` 建立了哪些长期状态

[`App::run`](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/tui/src/app.rs#L765-L850)先：

1. 创建 `app_event_tx/rx`；
2. 配置 terminal notification；
3. 通过 `AppServerSession::bootstrap` 读取账户、模型和 requirements；
4. 处理模型迁移、resume/fork/新 thread；
5. 构造 `App`、`ChatWidget` 和 per-thread event channel；
6. 安排启动 skills、rate limit 等非阻塞刷新；
7. 进入顶层 loop。

`App` 保存的是 UI 所需状态和 server 投影，例如当前显示 thread、overlay、pending request、render/reflow 状态。权威 thread/turn 生命周期仍在 app-server/core。

## 第三个核心结论：一个 `select!` 同时等待四类事件

主循环位于 [`tui/src/app.rs:1158-1244`](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/tui/src/app.rs#L1158-L1244)。下面是真实源码删节；保留四个 branch 和关键 guard，分支内部的错误/状态细节明确省略：

```rust
loop {
    let control = select! {
        Some(event) = app_event_rx.recv() => {
            match Box::pin(app.handle_event(tui, &mut app_server, event)).await {
                Ok(control) => control,
                Err(err) => break Err(err),
            }
        }
        active = async {
            if let Some(rx) = app.active_thread_rx.as_mut() {
                rx.recv().await
            } else {
                None
            }
        }, if App::should_handle_active_thread_events(
            waiting_for_initial_session_configured,
            app.active_thread_rx.is_some()
        ) => {
            // ... 删节：分派 active thread event 或清理已关闭 channel ...
            AppRunControl::Continue
        }
        event = tui_events.next() => {
            if let Some(event) = event {
                match app.handle_tui_event(tui, &mut app_server, event).await {
                    Ok(control) => control,
                    Err(err) => break Err(err),
                }
            } else {
                // ... 删节：terminal stream 关闭后的 shutdown-first ...
            }
        }
        app_server_event = app_server.next_event(), if listen_for_app_server_events => {
            match app_server_event {
                Some(event) => app.handle_app_server_event(&app_server, event).await,
                None => {
                    listen_for_app_server_events = false;
                    tracing::warn!("app-server event stream closed");
                }
            }
            AppRunControl::Continue
        }
    };

    // ... 删节：启动 gate 更新 ...
    match control {
        AppRunControl::Continue => {}
        AppRunControl::Exit(reason) => break Ok(reason),
    }
}
```

### `select!` 不等于四个 OS 线程

每个 branch 是一个 future。当前 task 等待哪个 future 先 ready；处理完后回到 loop，重新建立下一轮等待。其他 branch 没有被“永久取消”，但本轮未选中的 future 会被丢弃后在下一轮重建，因此 branch 内 future 必须是 cancellation-safe 或使用持久 receiver 状态。

源码这里没有写 `biased;`，不要假定永远按源码从上到下优先。真正需要顺序的逻辑通过 guard、queue、active thread store 和显式状态控制。

## 四个 branch 各自拥有哪类事实

### 1. `app_event_rx`：应用内部控制动作

来源包括 ChatWidget、picker、配置保存 task 和退出流程。`handle_event` 的 exhaustive match 位于 [`app/event_dispatch.rs`](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/tui/src/app/event_dispatch.rs#L1-L30)。

对 `AppEvent::CodexOp`，它会先完成必要的本地预绘制，再调用 `submit_active_thread_op(app_server, op)`。真实路径位于 [`event_dispatch.rs:415-441`](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/tui/src/app/event_dispatch.rs#L415-L441)。

### 2. `active_thread_rx`：当前显示 thread 的有序投影

app-server 的 notification/request 先按 `thread_id` 路由到对应 channel。只有当前 active thread 的 receiver 被这个 branch 直接消费；inactive thread 仍可缓存事件、显示 badge 或稍后切换恢复。

启动时还有 gate：在初始 session configured 之前，某些 active thread event 不应过早渲染。guard 把这个时序约束写进 branch 是否启用，而不是在每个事件 handler 里重复判断。

### 3. `tui_events.next()`：终端输入与重绘

[`handle_tui_event`](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/tui/src/app.rs#L1282-L1305)对 Draw/Resize 先执行 pre-render，再根据 overlay 或普通视图处理 key、paste 和 draw。paste 会把 `\r` 归一化成 `\n`，因为不同 terminal 的粘贴换行行为不同。

终端输入流关闭不是普通“没有按键”；程序会记录 warning，并走 shutdown-first，确保 active thread、rollout 和 child process 有机会清理。

### 4. `app_server.next_event()`：全局协议事件

统一 [`AppServerEvent`](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/app-server-client/src/lib.rs#L97-L114)包括。以下真实源码片段省略 derive 和转换实现，variant 列表完整：

```rust
pub enum AppServerEvent {
    Lagged { skipped: usize },
    ServerNotification(ServerNotification),
    ServerRequest(ServerRequest),
    Disconnected { message: String },
}
```

`handle_app_server_event` 位于拆出的 [`app/app_server_events.rs`](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/tui/src/app/app_server_events.rs#L32-L60)，分别处理：

- `Lagged`：记录丢失数量并修复可重建的启动 UI 状态；
- `ServerNotification`：更新全局状态或按 thread 路由；
- `ServerRequest`：登记待答复请求，交给相应 thread UI；
- `Disconnected`：展示错误并请求 fatal exit。

## 一次用户提交的精确调用链

从 composer 按下提交开始，可以画成：

```text
terminal Key event
  -> handle_tui_event
  -> ChatWidget 生成 AppCommand::UserTurn
  -> ChatWidget::submit_op
  -> AppEvent::CodexOp
  -> App::handle_event
  -> submit_active_thread_op
     ├─ 已有可 steer Turn：AppServerSession::turn_steer
     └─ 新 Turn：AppServerSession::turn_start
  -> AppServerClient::request_typed(ClientRequest::TurnStart)
  -> embedded MessageProcessor 或 remote transport
  -> app-server TurnRequestProcessor
  -> core Op::UserInput
```

关键源码：

- [`ChatWidget::submit_op`](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/tui/src/chatwidget.rs#L1729-L1761)
- [`AppEvent::CodexOp` 分派](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/tui/src/app/event_dispatch.rs#L415-L441)
- [`turn_steer`/`turn_start` 路由](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/tui/src/app/thread_routing.rs#L650-L759)
- [`AppServerSession::turn_start`](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/tui/src/app_server_session.rs#L894-L943)

为什么已有 Turn 时可能 `turn/steer` 而不是再开 Turn？用户可以在 Agent 工作期间追加输入。TUI 需要与 server 的 active turn id 对齐，还要处理“通知尚未到达但 server 状态已经变化”的竞态；`thread_routing.rs` 中包含缺失 active turn 和 expected-turn mismatch 的恢复逻辑。

## 一次 server 通知返回 UI 的调用链

反向路径是：

```text
core EventMsg
  -> app-server thread lifecycle listener
  -> ServerNotification（带 thread_id）
  -> AppServerClient event stream
  -> App::handle_app_server_event
  -> server_notification_thread_target
  -> primary/inactive thread channel
  -> active_thread_rx（若当前显示）
  -> ChatWidget / history cell / bottom pane state
  -> Draw request
  -> Ratatui frame
```

这条链解释了为什么 TUI 不应把 spinner 当成 Turn 是否运行的权威判断。spinner 只是收到通知后形成的本地投影；重连、lag 或切换 inactive thread 时，需要从 protocol/thread store 重建或纠正。

## Server Notification 与 Server Request 不同

- notification 是单向事实或进度，例如 Turn started/completed、item delta、账户更新；客户端不返回对应 response；
- server request 需要客户端答复，例如命令审批、文件修改审批、MCP elicitation 或 request-user-input；
- TUI 必须把 request id 和 thread id 一起保留，用户选择后通过 `AppServerRequestHandle` resolve/reject；
- 不支持的 server request 不能静默丢弃，否则 server 可能永远等待。

[`app_server_events.rs:193-236`](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/tui/src/app/app_server_events.rs#L193-L236)会登记 request，拒绝不支持项，并按 thread 路由。

## 背压与 `Lagged`：并非所有 UI 事件都同等可丢

内嵌 client 和 app-server 使用有界 channel，防止 UI 停顿时内存无限增长。`app-server-client` 会区分必须无损送达的关键事件和可在过载时丢弃/汇总的事件：

- completed、权威 item、streamed assistant text 等不能随意丢，否则 transcript 会永久损坏或界面永远等待；
- 某些可重新获取的状态通知在过载时可被跳过；
- consumer 落后时通过 `Lagged { skipped }` 告知 UI，而不是假装一切完整；
- server request 若无法排队，必须以 overload/internal error 回给 processor，避免审批悬挂。

相关设计说明在 [`app-server-client/src/lib.rs:1-16`](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/app-server-client/src/lib.rs#L1-L16)和 [`app-server/src/in_process.rs:26-32`](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/app-server/src/in_process.rs#L26-L32)。

## 渲染不是业务状态更新的同义词

TUI 允许先更新状态，随后合并多个 redraw；也允许在提交用户 Turn 前做一次预绘制，让用户输入立即出现在 transcript，而不必等待 RPC round trip。`AppEvent::CodexOp` 分支在用户 Turn 时运行 pre-render/reflow/render，然后才提交 server 请求。

这不是把 UI 当权威状态。若 `turn/start` 被 server 拒绝，TUI 会调用 `handle_turn_start_rejection` 把乐观展示修正为失败状态。可将其理解为受控的 optimistic UI。

对 UI 代码，应分开问：

1. 哪个事件修改了状态？
2. 哪个动作请求下一帧？
3. 哪个 render 函数把状态写到 terminal？
4. server 拒绝或断线时怎样回滚/纠正？

## 退出为什么不能直接 `process::exit`

用户退出时可能还有：

- active Turn 或后台 terminal；
- app-server worker 和 event channel；
- rollout/state 写入；
- terminal raw mode、alternate screen、鼠标/按键增强模式；
- tracing/feedback flush。

`ExitMode::ShutdownFirst` 会先请求清理；只有 `Immediate` 才是跳过部分清理的最后手段。主循环退出后还调用 `app_server.shutdown()`、清理 terminal，并由 `TerminalRestoreGuard` 恢复终端。若 panic/错误路径忘记恢复，用户 shell 可能保持 raw mode 或看不到正常回显。

关键代码：

- [`AppEvent::Exit` 语义](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/tui/src/app_event.rs#L292-L309)
- [`event_dispatch` 退出分支](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/tui/src/app/event_dispatch.rs#L390-L414)
- [`App::run` 循环后 shutdown](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/tui/src/app.rs#L1245-L1279)
- [`run_ratatui_app` terminal restore](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/tui/src/lib.rs#L1813-L1841)

## 为什么大型 `app.rs` 又拆出子模块

固定快照已把部分职责放入 `tui/src/app/`：

```text
app/event_dispatch.rs       AppEvent exhaustive routing
app/app_server_events.rs    app-server event routing
app/thread_routing.rs       thread/turn command routing
app/session_lifecycle.rs    start/resume/fork/attach
app/config_persistence.rs   配置写入
app/resize_reflow.rs        resize 与 transcript reflow
```

顶层 `app.rs` 仍负责总编排和主 loop。新增功能时，不应继续把每个领域动作都写成 `app.rs` 的独立大方法；应让中心文件保持 orchestration，把有内聚边界的行为放到专门模块。

## 实验一：证明 TUI 不直接启动 core Turn

纯静态阅读：

```bash
cd <project-root>
rg -n 'codex-core' codex-rs/tui/Cargo.toml || true
rg -n 'codex-app-server-client|codex-app-server-protocol' \
  codex-rs/tui/Cargo.toml
rg -n 'enum AppServerTarget|fn start_app_server' codex-rs/tui/src/lib.rs
rg -n 'ClientRequest::TurnStart' codex-rs/tui/src/app_server_session.rs
```

第一条在固定快照不应显示 TUI 的直接 `codex-core` dependency。注意 `app-server-client::legacy_core` 仍可重导出迁移中的配置类型；这不改变 Turn 控制路径经过 app-server 协议的结论。

## 实验二：重建启动 target 决策

```bash
cd <project-root>
rg -n 'fn app_server_target_for_launch|can_reuse_implicit_local_daemon' \
  codex-rs/tui/src/lib.rs
rg -n 'prefers_explicit_remote|uses_local_daemon|not_replayable' \
  codex-rs/tui/src/lib.rs
```

再运行针对性测试；会编译 TUI，但不会调用真实模型：

```bash
just test -p codex-tui app_server_target_for_launch
```

为三种输入各写出预期：显式 remote、存在默认 daemon 且配置可重放、配置不可重放。

## 实验三：验证 embedded 真的支持 RPC

固定快照已有名为 `embedded_app_server_supports_thread_start_rpc` 的测试：

```bash
cd <project-root>
rg -n 'embedded_app_server_supports_thread_start_rpc' codex-rs/tui/src/lib.rs
just test -p codex-tui embedded_app_server_supports_thread_start_rpc
```

阅读测试时标出 initialize、thread/start 和 response 的位置。实验目的不是证明“能创建 core 对象”，而是证明 embedded client 能通过同一 typed RPC contract 启动 thread。

## 实验四：给 `select!` 四个 branch 做事件卡片

```bash
cd <project-root>
rg -n 'app_event_rx.recv|active_thread_rx|tui_events.next|app_server.next_event' \
  codex-rs/tui/src/app.rs
rg -n 'enum TuiEvent' codex-rs/tui/src/tui.rs
rg -n 'enum AppEvent' codex-rs/tui/src/app_event.rs
rg -n 'enum AppServerEvent' codex-rs/app-server-client/src/lib.rs
```

为每个 branch 填表：

| 事件源 | 生产者 | 消费函数 | 是否跨协议 | 典型副作用 |
| --- | --- | --- | --- | --- |
| `app_event_rx` | widget/后台 UI task | `handle_event` | 否 | picker、配置、发 RPC |
| `active_thread_rx` | thread event router | `handle_active_thread_event` | 已由协议翻译 | transcript/thread 投影 |
| `tui_events` | terminal broker | `handle_tui_event` | 否 | composer、draw、resize |
| `app_server.next_event` | embedded/remote client | `handle_app_server_event` | 是 | notification/request 路由 |

## 实验五：追一条提交和一条返回链

```bash
cd <project-root>
rg -n 'fn submit_op|AppEvent::CodexOp' \
  codex-rs/tui/src/chatwidget.rs codex-rs/tui/src/app
rg -n 'submit_active_thread_op|\.turn_start\(|\.turn_steer\(' \
  codex-rs/tui/src/app/thread_routing.rs
rg -n 'handle_app_server_event|handle_server_notification_event' \
  codex-rs/tui/src/app/app_server_events.rs
```

在纸上写两条相反方向的箭头，并为每一跳标出具体 enum variant。若某一跳只能写“某个事件”，说明还没有真正读懂边界。

## 实验六：运行 UI 测试与查看 snapshot

会编译并执行本地测试，不调用真实模型：

```bash
cd <project-root>
just test -p codex-tui
cargo insta pending-snapshots -p codex-tui
```

只有实际修改 UI 且确认所有 `.snap.new` 都符合预期时，才运行：

```bash
cargo insta accept -p codex-tui
```

阅读教程无需接受任何 snapshot。Snapshot 是视觉契约，不是“测试失败后自动更新”的缓存。

## 可选实验：真实启动 TUI

下面命令会读取用户配置，可能要求登录；若提交 prompt 还可能产生模型请求和费用：

```bash
cd <project-root>
just codex
```

只观察启动时，可以不提交 prompt。另开终端显式设置本地日志目录：

```bash
cd <project-root>
RUST_LOG=codex_tui=debug,codex_app_server=debug \
  just codex -c log_dir=./.codex-log
```

日志可能包含本地路径、命令和上下文，不要提交 `.codex-log`。

## 常见误区

- **“Embedded 就是 TUI 直接调用 core。”** Embedded 只移除传输/进程边界，typed `ClientRequest`、response envelope 和 `MessageProcessor` 仍在。
- **“LocalDaemon 与 Embedded 都是同一进程。”** 二者都使用本地工作区语义，但 daemon 是远程 client 连接到独立服务。
- **“Remote 只代表模型服务在远端。”** 这里指 app-server/workspace target，路径和环境也由远端语义决定。
- **“`select!` 创建四个线程。”** 它让一个 async task 等待多个 future；并发来源可能另有 task，但宏本身不是线程 API。
- **“源码从上到下的 branch 永远有优先级。”** 此处没有 `biased;`；顺序约束通过状态和 guard 表达。
- **“`AppEvent` 就是 app-server event。”** `AppEvent` 是 TUI 内部总线，`AppServerEvent` 是协议 client 事件。
- **“`AppCommand` 可以直接转成 core `Op`。”** 生产路径由 App 路由成 app-server typed RPC。
- **“active widget 状态就是 server 状态。”** UI 是通知投影，必须处理 lag、重连、inactive thread 和 server rejection。
- **“每个 delta 都应立即完整重绘。”** redraw 可以合并；但不能因此丢弃会破坏 transcript 的关键协议事件。
- **“退出时直接清屏即可。”** 还要 shutdown server、清理 thread/child、flush 状态并恢复 terminal mode。

## 自测

1. Embedded、LocalDaemon 和 Remote 分别对应什么进程与工作区语义？
2. 为什么说 embedded 是“transport-local but not protocol-free”？
3. `AppServerSession` 为什么比让每个 widget 直接构造 request 更好？
4. `TuiEvent`、`AppEvent`、`AppCommand` 和 `AppServerEvent` 各连接哪两端？
5. 主 `select!` 的四个 branch 分别消费什么？哪个 branch 有启动 gate？
6. 用户在 Agent 工作中追加消息时，为什么可能调用 `turn/steer`？
7. app-server 的 `ServerRequest` 为什么不能像普通 notification 一样静默丢弃？
8. `Lagged { skipped }` 存在说明了什么背压设计？
9. TUI 在 `turn/start` 前乐观画出用户消息后，server 拒绝时必须做什么？
10. 为什么 fatal/error/panic 路径也必须恢复 terminal？

## 本章源码索引

- [TUI library 启动与 target 选择（固定提交）](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/tui/src/lib.rs)
- [TUI `App` 与主事件循环（固定提交）](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/tui/src/app.rs)
- [TUI typed app-server session（固定提交）](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/tui/src/app_server_session.rs)
- [TUI app-server event routing（固定提交）](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/tui/src/app/app_server_events.rs)
- [TUI AppEvent routing（固定提交）](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/tui/src/app/event_dispatch.rs)
- [TUI thread/turn routing（固定提交）](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/tui/src/app/thread_routing.rs)
- [统一 app-server client（固定提交）](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/app-server-client/src/lib.rs)
- [内嵌 app-server runtime（固定提交）](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/app-server/src/in_process.rs)
- [app-server public lifecycle（固定提交）](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/app-server/README.md#L66-L87)

下一章进入 app-server 公共协议本身，系统区分 request、response、notification 与 server request，并沿 `thread/start`、`turn/start` 和 Item streaming 走完整生命周期。
