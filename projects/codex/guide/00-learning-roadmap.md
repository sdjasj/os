# 00. Codex 学习路线：围绕一次 Turn 建立全局地图

Codex 不是“终端里套了一层聊天框”，而是一套允许模型在明确权限边界内读取上下文、调用工具、修改代码、运行验证并持续汇报状态的 Agent 系统。仓库里有上百个 Rust workspace member、多种客户端表面、跨平台沙箱、持久化、MCP、插件和 SDK。有效的学习方法不是逐目录浏览，而是先追踪一次用户请求，再逐层替换掉心中的黑盒。

## 学完后先要能回答的六个问题

读源码时始终保留这六个问题：

1. 用户输入从哪个“表面”进入：TUI、`codex exec`、IDE，还是 SDK？
2. 谁把输入翻译为 Thread/Turn/Item 协议？
3. 哪一层拥有会话状态，哪一层只是展示或转发？
4. 模型为什么能看到某个工具，它的实际执行者又是谁？
5. 文件和网络权限由谁描述、谁审批、谁在操作系统层强制执行？
6. 进程退出后，哪些事实写进 rollout，哪些只是可重建的索引或 UI 投影？

如果一个新文件无法放进这六个问题中的任何一个，先不要深读它。

## 固定学习快照

本教程依据：

```text
repository: https://github.com/openai/codex
commit:     61a44880a85d2fd0d8770908dea5733495e571c8
date:       2026-07-26
subject:    Raise the MCP server recursion limit (#35414)
```

固定提交有两个作用：一是让源码链接和讲解不随 `main` 漂移；二是提醒你 Codex 正在快速演进。比如旧资料常把 TUI 描述为直接持有 core conversation，而这个快照中的 TUI 已通过 `AppServerSession` 驱动嵌入式或远程 app-server。遇到教程和当前分支不一致时，应重新搜索符号并画调用链，而不是强行套旧结论。

## 一张够用的系统图

先把整个项目压缩成下面六层：

```text
用户/自动化
  │
  ├─ codex TUI ───────────────┐
  ├─ codex exec               │
  ├─ IDE / Desktop            ├─ app-server JSON-RPC v2
  └─ Python / TypeScript SDK ─┘
                                  │
                                  ▼
                         ThreadManager / CodexThread
                                  │  Submission Queue
                                  ▼
                           Session / run_turn
                                  │
                    ┌─────────────┴─────────────┐
                    ▼                           ▼
             Responses API 流             ToolRouter
             文本/推理/调用项       shell / patch / MCP / ...
                    ▲                           │
                    └──────── 工具结果回填 ────┘
                                  │ Event Queue
                                  ▼
                         UI、JSONL、SDK 事件
                                  │
                     rollout JSONL + SQLite 投影
```

这张图刻意区分三类协议：

- app-server JSON-RPC 是“客户端与 Codex 服务”之间的公共集成协议；
- core 的 Submission Queue / Event Queue 是“调用方与一个活跃线程”之间的内部异步协议；
- Responses API 的输入项和流事件是“Codex 与模型服务”之间的推理协议。

三个协议都出现消息、事件和 ID，但不能混为一谈。

## 先补足哪些背景知识

不需要先成为 Rust 专家，但建议掌握下表中的最小集合：

| 背景 | 在本项目中的用途 | 最先观察的语法 |
| --- | --- | --- |
| Rust 所有权 | 多任务共享 Session，避免悬垂引用和数据竞争 | `Arc<T>`、借用、`clone` |
| async Rust | 模型流、终端输入、工具和子 Agent 并发推进 | `async fn`、`.await`、`tokio::select!` |
| Channel | 把提交方、核心任务和 UI 解耦 | `async_channel`、`mpsc`、`watch` |
| Trait/动态分发 | 统一不同工具、环境、扩展实现 | `dyn Trait`、`Arc<dyn ...>` |
| Serde/Clap | 定义线协议和 CLI 命令树 | `Serialize`、`Deserialize`、`Parser` |
| 流式协议 | 一次响应由多个增量和终止事件构成 | SSE、WebSocket、JSONL |
| Agent 工具循环 | 模型不是直接执行命令，而是提出结构化调用 | call → dispatch → output → next sample |
| 操作系统隔离 | “允许执行”不等于“拥有全部主机权限” | sandbox、approval、exec policy |

第 01 章会用本仓库代码把这些概念串起来。

## 环境准备分成三级

### A 级：纯静态阅读

只需要 Git、`rg` 和编辑器，适合先建立地图：

```bash
cd <project-root>
git rev-parse HEAD
rg -n "enum Subcommand" codex-rs/cli/src/main.rs
rg -n "pub async fn run_turn" codex-rs/core/src/session/turn.rs
rg -n "pub struct ToolRouter" codex-rs/core/src/tools/router.rs
```

### B 级：编译和目标测试

仓库的 `codex-rs/rust-toolchain.toml` 在本快照固定 Rust `1.95.0`，并要求 `clippy`、`rustfmt` 和 `rust-src`。根文档还要求 `just`、DotSlash 与 `cargo-nextest`。按照上游安装文档准备后，从仓库根运行：

```bash
just fmt-check
just test -p codex-protocol
just test -p codex-app-server-protocol
```

不要直接用 `cargo test` 替代 `just test`：仓库 helper 会统一 nextest profile、栈大小和工作目录。第一次构建工作区成本很高，应从一个 crate 或单个测试开始。

### C 级：真实运行与模型请求

```bash
just codex -- "explain this codebase to me"
just exec -- --json "summarize the workspace architecture"
```

这一级可能读取用户配置、需要登录并产生模型费用。学习主链并不依赖真实请求：核心集成测试用本地 mock Responses 服务构造 SSE，反馈更快且可重复。

## 四遍读码法

### 第一遍：只找边界

先列二进制、公共协议和持久化边界：

```bash
rg -n '^\[\[bin\]\]|^name = ' codex-rs/*/Cargo.toml
rg -n '^pub enum (Op|EventMsg)' codex-rs/protocol/src/protocol.rs
rg -n 'ThreadStart =>|TurnStart =>' \
  codex-rs/app-server-protocol/src/protocol/common.rs
```

这一遍不追实现细节，只回答“谁能调用谁”。

### 第二遍：只追一个 Happy Path

选择最普通的文本请求，不考虑恢复、多 Agent、图片或审批：

```text
CLI/TUI 输入
  -> app-server thread/start
  -> app-server turn/start
  -> CodexThread::submit(Op::UserInput)
  -> Session submission_loop
  -> run_turn
  -> ModelClientSession::stream
  -> agent message
  -> turn/completed
```

在纸上为每个箭头写出“输入类型、输出类型、异步边界”。能写清这三项，才算真的走通。

### 第三遍：插入一次工具调用

把模型响应改成函数调用，观察循环如何继续：

```text
ResponseItem::FunctionCall
  -> ToolRouter::build_tool_call
  -> ToolRegistry::dispatch_any_with_terminal_outcome
  -> 具体 handler/runtime
  -> FunctionCallOutput
  -> 下一次 Responses 请求
```

这一遍重点是区分“模型可见规格”“注册的运行时”“审批与沙箱编排”“返回模型的输出”。

### 第四遍：加入失败和持久化

依次问：流中断会不会重试？命令被拒绝后模型看到什么？工具仍在运行时如何取消？Turn 完成前写了哪些 rollout item？恢复时如何过滤半截 Turn？真实系统的复杂性主要藏在这些非 Happy Path 中。

## 用测试当作可执行规格

仓库测试大致分四种：

- crate 单元测试：适合纯转换、解析和策略；
- `codex-rs/core/tests/suite/` 集成测试：mock Responses API，验证 Agent 行为；
- `codex-rs/app-server/tests/suite/`：从公共 JSON-RPC API 验证集成；
- TUI `insta` 快照：验证最终渲染，而不是逐字段断言。

阅读一个功能时，维护一张表：

| 角色 | 需要找到的证据 |
| --- | --- |
| 入口 | CLI 参数、RPC method 或 tool schema |
| 数据类型 | protocol crate 中的 struct/enum |
| 编排 | core/app-server 中的 async 函数 |
| 副作用 | runtime、filesystem、network 或 state store |
| 输出 | EventMsg、notification、JSONL 或 UI cell |
| 测试 | mock 输入和完整对象断言 |

## 本章实验：制作自己的“请求链卡片”

只做静态阅读，不调用模型：

1. 在 `codex-rs/cli/src/main.rs` 找到 `MultitoolCli` 和 `Subcommand`。
2. 在 `codex-rs/tui/src/app.rs` 找到 `App::run` 中的 `tokio::select!`。
3. 在 `codex-rs/app-server/README.md` 找到 Thread、Turn、Item 的定义。
4. 在 `codex-rs/protocol/src/protocol.rs` 找到 `Submission`、`Op`、`Event`、`EventMsg`。
5. 在 `codex-rs/core/src/session/turn.rs` 找到 `run_turn`。
6. 把这六处写成一张卡片，每处只写“一句话职责”和“下一跳”。

参考命令：

```bash
rg -n "struct MultitoolCli|enum Subcommand" codex-rs/cli/src/main.rs
rg -n "pub async fn run\(|tokio::select!" codex-rs/tui/src/app.rs
rg -n "Core Primitives|Lifecycle Overview" codex-rs/app-server/README.md
rg -n "struct Submission|enum Op|struct Event|enum EventMsg" \
  codex-rs/protocol/src/protocol.rs
rg -n "pub\(crate\) async fn run_turn" codex-rs/core/src/session/turn.rs
```

## 常见误区

- 按 crate 数量平均分配时间。`core`、`protocol`、`app-server`、`tui` 是主链，很多小 crate 是刻意抽出的能力边界。
- 把 UI 状态当权威状态。TUI 的 cell、spinner 和 active thread 都是协议事件的投影。
- 把 approval 当 sandbox。前者决定何时询问，后者在操作系统层限制执行；两者可以独立配置。
- 把工具描述当实现。模型只看到 schema，真正 dispatch 还会经过 registry、hook、审批和 runtime。
- 只读成功路径。恢复、取消、重复事件、输出截断和半完成 Turn 才最能暴露设计意图。
- 直接运行全工作区测试。先锁定 crate 和测试名，再逐步扩大范围。

## 自测

1. app-server JSON-RPC、core SQ/EQ 和 Responses API 分别连接哪两端？
2. 为什么本教程围绕 Turn 而不是围绕目录组织？
3. TUI 为什么可以连接嵌入式或远程 app-server？这对架构边界意味着什么？
4. 为什么 mock Responses API 的集成测试比真实模型请求更适合验证 Agent 逻辑？
5. 当本地 `main` 与教程快照不同，你应优先搜索符号还是依赖固定行号？

## 源码与官方背景

- [Codex 根 README（固定提交）](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/README.md)
- [源码构建说明（固定提交）](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/docs/install.md)
- [Cargo workspace（固定提交）](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/Cargo.toml)
- [Codex 官方文档](https://developers.openai.com/codex)
- [Codex app-server README（固定提交）](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/app-server/README.md)

下一章用项目里的 `Arc`、channel、stream、trait 和 enum 补齐读懂核心链路所需的 Rust 与 Agent 背景。
