# 02. 从 126 个 crate 中找到主干：Workspace、依赖方向与构建地图

打开 `codex-rs/` 后，最容易产生的错觉是“必须先弄懂所有目录，才能读主流程”。固定快照里，Cargo workspace 有 126 个成员，但真正支撑一次普通用户请求的主干只有几层：分发入口、用户表面、app-server 控制面、core Agent 核心和执行环境。其余 crate 大多是在把配置、模型、工具、沙箱、持久化或扩展能力从中心模块中拆出来。

本章的目标不是背目录，而是建立一张可以反复使用的依赖地图。读完后，你应能仅凭一个 `Cargo.toml` 判断 crate 的角色，知道应从哪个二进制追调用链，也知道为什么“被依赖很多”不等于“应该继续往里面堆代码”。

## 固定快照与学习目标

本章对应上游提交：

```text
repository: https://github.com/openai/codex
commit:     61a44880a85d2fd0d8770908dea5733495e571c8
```

完成本章后，你应该能回答：

1. workspace、package、crate、target、binary 和 library 分别是什么；
2. 仓库根为什么不是 Cargo workspace 根；
3. `codex-cli/`、`codex-rs/cli/`、`codex-rs/tui/` 和 `codex-rs/core/` 的职责为何不同；
4. `app-server-protocol`、`protocol` 与 `exec-server-protocol` 为什么不能合并理解；
5. Cargo、Just 与 Bazel 在这个仓库中分别解决什么问题；
6. 如何用 `cargo metadata`、`cargo tree` 和 `rg` 验证自己的架构图。

## 背景一：Workspace、Package、Crate 和 Target

Cargo 术语经常被口语混用。阅读本项目时，最好严格区分：

| 术语 | 含义 | 本项目例子 |
| --- | --- | --- |
| workspace | 一组共同解析依赖、共享 lockfile 的 package | `<project-root>/codex-rs/Cargo.toml` |
| package | 一个带 `Cargo.toml` 的发布/构建单元 | `codex-rs/cli`，包名 `codex-cli` |
| crate | 一次 Rust 编译产生的库或可执行单元 | `codex_cli` library、`codex` binary |
| target | package 中声明的 lib、bin、test、bench 等目标 | `[[bin]]`、`[lib]`、`[[test]]` |
| module | crate 内由 `mod` 组织的源码命名空间 | `tui/src/app/` 下的子模块 |

一个 package 可以同时产生 library 与 binary。`codex-rs/cli/Cargo.toml` 就同时声明了原生 `codex` 可执行文件和 `codex_cli` 库。binary 的 `main.rs` 负责进程入口；library 让测试或其他 crate 可以复用内部逻辑。

下面是[固定提交中的真实源码](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/cli/Cargo.toml#L1-L15)，未删节：

```toml
[package]
name = "codex-cli"
version.workspace = true
edition.workspace = true
license.workspace = true
build = "build.rs"

[[bin]]
name = "codex"
path = "src/main.rs"

[lib]
name = "codex_cli"
path = "src/lib.rs"
doctest = false
```

这也解释了三个看似相近的名字：

- 文件夹叫 `cli`；
- Cargo package 叫 `codex-cli`；
- Rust library crate 在代码里以 `codex_cli` 引用；
- 用户执行的 binary 叫 `codex`。

## 背景二：依赖方向比目录位置更重要

“A 在 B 目录旁边”不说明 A 能否调用 B；`Cargo.toml` 才是编译期依赖的事实来源。可以把依赖箭头理解为：

```text
A ---> B
```

表示 A 的代码可以引用 B 的公开 API，因此：

- B 的公共 API 变化可能迫使 A 修改；
- B 不应反过来随意依赖 A，否则容易形成环；
- 越靠近图底部的 crate，通常越应该保持小而稳定；
- 位于入口层的 crate 可以依赖多个子系统，因为它承担组合职责。

这不是绝对的“洋葱架构”。真实仓库在迁移中会有过渡依赖。例如 `codex-core` 在本快照也依赖 `codex-app-server-protocol`，而 `app-server-client` 仍保留 `legacy_core` 重导出。教程要描述真实依赖，不能把理想分层冒充现状。

## 仓库的两个根

先区分两个根目录：

```text
<project-root>/
├── README.md
├── justfile
├── codex-cli/              # npm 分发启动器
├── codex-rs/               # Rust Cargo workspace
├── sdk/                    # SDK
├── shell-tool-mcp/
└── ...
```

仓库根容纳分发脚本、文档、SDK 和 Rust 实现；真正的 Cargo workspace 根是 `<project-root>/codex-rs`。根 `justfile` 通过 `set working-directory := "codex-rs"` 让大多数 `just` 命令自动切换进去，所以从仓库根执行 `just test -p codex-tui` 是合法的。

下面是[根 `justfile` 的真实源码删节](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/justfile#L1-L28)；省略了与本段无关的 shell 配置和 recipe：

```make
set working-directory := "codex-rs"

# ... 删节：shell 与帮助配置 ...

codex *args:
    cargo run --bin codex -- {args}

exec *args:
    cargo run --bin codex -- exec {args}

# ... 删节：属性标记 ...
tui-with-exec-server *args:
    {{ justfile_directory() }}/scripts/run_tui_with_exec_server.sh "$@"
```

如果直接在仓库根执行 `cargo metadata`，Cargo 会找不到根 `Cargo.toml`；应先 `cd codex-rs`，或让 `just` 帮你切换目录。

## Workspace 清单透露了什么

[workspace 清单](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/Cargo.toml#L1-L139)在固定快照中包含 126 个成员，并集中声明 edition 与许可证。

以下为真实源码删节；成员中间使用注释明确省略：

```toml
[workspace]
members = [
    "app-server",
    "app-server-transport",
    "app-server-daemon",
    "app-server-client",
    "app-server-protocol",
    "app-server-test-client",
    # ... 删节：其他 workspace 成员 ...
    "cli",
    # ... 删节 ...
    "core",
    # ... 删节 ...
    "exec",
    "file-system",
    "exec-server-protocol",
    "exec-server",
    # ... 删节 ...
    "protocol",
    # ... 删节 ...
    "tui",
    "tools",
    # ... 删节：utils、state、plugin、model-provider 等 ...
]
resolver = "2"

[workspace.package]
version = "0.0.0"
edition = "2024"
license = "Apache-2.0"
```

这里至少能得到四条信息：

1. 所有主要 Rust 组件统一参与依赖解析；
2. 新 crate 默认继承 Rust 2024 edition；
3. `version = "0.0.0"` 表明仓库构建版本不依赖普通 crates.io 发布节奏；
4. `resolver = "2"` 使用现代 feature resolver，减少不相关 target 间的 feature 意外合并。

紧随其后的 `[workspace.dependencies]` 把内部路径依赖集中命名。例如 package 中写 `codex-core = { workspace = true }`，实际路径在 workspace 根统一解析为 `core`。这降低了路径拼写漂移，也让依赖升级集中处理。

## 不按字母，而按责任给 crate 分组

### 1. 分发与入口层

| 路径 | 作用 | 最先读的文件 |
| --- | --- | --- |
| `codex-cli/` | npm 包，选择对应平台原生 binary | `package.json`、`bin/codex.js` |
| `codex-rs/cli/` | 原生 `codex` 多工具入口 | `Cargo.toml`、`src/main.rs` |
| `codex-rs/arg0/` | 单 binary 的 helper/argv0 分派 | `src/lib.rs` |

这一层不拥有 Agent 主循环。它负责“进程怎样启动”和“用户命令进入哪种表面”。第 03 章会完整追踪。

### 2. 用户表面层

| crate | 用户体验 | 关键依赖 |
| --- | --- | --- |
| `codex-tui` | Ratatui 交互界面 | `app-server-client`、`app-server-protocol` |
| `codex-exec` | 非交互、human/JSONL 输出 | `app-server-client`、`app-server-protocol` |
| IDE/Desktop | 仓库外或其他客户端 | app-server wire protocol |

`codex-tui` 的 manifest 在本快照没有直接声明 `codex-core`，而是通过 `codex-app-server-client` 驱动内嵌或远程 app-server。`codex-exec` 仍直接依赖部分 core 配置/辅助类型，但运行 Turn 的控制路径也已经走 app-server client。

可从两个 manifest 直接验证：

- [`tui/Cargo.toml`](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/tui/Cargo.toml#L24-L55)
- [`exec/Cargo.toml`](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/exec/Cargo.toml#L24-L61)

### 3. app-server 控制面

| crate | 责任 |
| --- | --- |
| `app-server-protocol` | 公共 request/response/notification 类型、TS/schema 导出 |
| `app-server` | transport、连接、初始化、请求分派、core 事件翻译 |
| `app-server-client` | TUI/exec 共用的内嵌与远程 client facade |
| `app-server-transport` | 传输层抽象 |
| `app-server-daemon` | 持久本地 daemon 生命周期 |
| `app-server-test-client` | 面向公共协议的测试/实验客户端 |

控制面围绕 Thread、Turn、Item 工作。它是 TUI、exec、IDE 和 core 之间的稳定接缝，而不是模型推理本身。

### 4. Agent 核心与内部协议

| crate | 责任 |
| --- | --- |
| `protocol` | core 的 `Submission`、`Op`、`Event`、`EventMsg` 等内部消息 |
| `core` | `ThreadManager`、`CodexThread`、`Session`、Turn 与采样循环 |
| `tools` | 工具规格、路由和 runtime 相关能力 |
| `context-fragments`、`prompts` | 模型可见上下文与指令材料 |
| `models-manager`、`model-provider`、`codex-client` | 模型发现、provider 与请求客户端 |

`core` 很大，但仓库规范明确要求抵制继续向其中增加新概念。判断新能力归属时，应先问：能否成为独立的小 crate，或放入已有的工具、配置、状态、执行、扩展 crate？

### 5. 执行与隔离层

| crate | 责任 |
| --- | --- |
| `exec-server-protocol` | `process/*`、`fs/*`、`environment/*` wire 类型 |
| `exec-server` | 本地或远程环境的进程、文件系统与连接管理 |
| `file-system` | 可替换的文件系统能力 |
| `sandboxing` | 便携的 sandbox 意图与平台编排 |
| `linux-sandbox`、`windows-sandbox-rs`、`bwrap` | 平台具体强制执行 |
| `utils/pty` | 伪终端与交互进程 |

这里再次强调：`codex exec` 是无头客户端，`codex exec-server` 是执行环境服务。名字相似不代表在同一层。

### 6. 状态、扩展与叶子能力

剩余 crate 可以再按能力聚类：

- 配置与身份：`config`、`login`、`codex-home`、`cloud-config`；
- 持久化：`state`、`rollout`、`thread-store`、`agent-graph-store`；
- 外部能力：`codex-mcp`、`mcp-server`、`connectors`、`skills`、`plugin`；
- 扩展实现：`ext/agent`、`ext/mcp`、`ext/skills`、`ext/web-search` 等；
- 通用叶子：`utils/*`、`git-utils`、`http-client`、`terminal-detection`。

叶子 crate 的价值往往不是代码量，而是把平台差异或稳定契约从大 crate 中隔离出来。

## 三套协议必须分别画图

同一个请求至少经过三套类型系统：

```text
客户端表面
   │ app-server-protocol
   │ ClientRequest::TurnStart / ServerNotification
   ▼
app-server
   │ codex-protocol（内部 SQ/EQ）
   │ Op::UserInput / EventMsg
   ▼
core Session
   │ Responses API 类型与流
   │ ResponseItem / ResponseEvent
   ▼
模型服务

core / app-server
   │ exec-server-protocol
   │ process/start / fs/readFile / ...
   ▼
本地或远程执行环境
```

协议 crate 应尽量只保存数据契约和转换，不能把完整业务编排塞进去。调用者依赖协议类型，不等于协议 crate 应反向依赖调用者。

三个代表性入口：

- [`app-server-protocol/src/protocol/common.rs`](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/app-server-protocol/src/protocol/common.rs#L194-L274)
- [`protocol/src/protocol.rs`](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/protocol/src/protocol.rs#L174-L185)
- [`exec-server-protocol/src/protocol.rs`](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/exec-server-protocol/src/protocol.rs#L19-L56)

## 从 manifest 还原真实依赖主干

下面的图不是理想设计图，而是从固定提交各 manifest 提炼出的主干；为可读性省略 telemetry、config 和许多叶子依赖：

```text
codex-cli
 ├─> codex-tui
 ├─> codex-exec
 ├─> codex-app-server
 ├─> codex-exec-server
 └─> codex-mcp-server

codex-tui
 ├─> codex-app-server-client
 ├─> codex-app-server-protocol
 ├─> codex-exec-server
 └─> codex-protocol

codex-exec
 ├─> codex-app-server-client
 ├─> codex-app-server-protocol
 ├─> codex-core
 └─> codex-protocol

codex-app-server-client
 ├─> codex-app-server
 ├─> codex-app-server-protocol
 ├─> codex-core
 └─> codex-exec-server

codex-app-server
 ├─> codex-app-server-protocol
 ├─> codex-core
 └─> codex-exec-server

codex-core
 ├─> codex-protocol
 ├─> codex-exec-server
 ├─> model / tools / MCP / extensions
 └─> config / rollout / state / sandboxing

codex-exec-server
 ├─> codex-exec-server-protocol
 ├─> codex-file-system
 ├─> codex-sandboxing
 └─> codex-utils-pty
```

这张图揭示了两个值得深入思考的事实：

1. `cli` 是 composition root，直接依赖许多表面和服务是合理的；
2. TUI 的运行路径以 app-server 协议为边界，即使 server 与 UI 在同一进程。

## 一次文本 Turn 穿过哪些 crate

先忽略登录、恢复、审批和工具调用，一个最小请求链可以写成：

```text
codex-cli/bin/codex.js
  -> cli::main / cli_main
  -> codex_tui::run_main
  -> app_server_client::AppServerClient
  -> app_server::MessageProcessor
  -> app_server::TurnRequestProcessor
  -> core::CodexThread::submit(Op::UserInput)
  -> core::RegularTask::run
  -> core::session::turn::run_turn
  -> ModelClientSession::stream
  -> core EventMsg
  -> app-server ServerNotification
  -> TUI event loop / widget state
```

把这条链和依赖图对照起来：每跨一次协议边界，数据类型会变化；每跨一次 async/channel 边界，调用栈可能不再是同步函数嵌套。读源码时应记录“下一跳函数”和“下一跳消息类型”两列。

## Cargo、Just 与 Bazel 的分工

### Cargo：本地 Rust 开发事实来源

Cargo 负责 package graph、依赖解析、编译目标和测试 target。常用命令：

```bash
cd <project-root>/codex-rs
cargo metadata --no-deps --format-version 1
cargo tree -p codex-cli --edges normal
cargo check -p codex-app-server-protocol
```

### Just：仓库工作流入口

Just recipe 固化工作目录、nextest profile、栈大小和生成流程。例如 `just test` 不是 `cargo test` 的简单别名，而是运行 nextest。遵循仓库约定时，从根目录使用 `just` 更不容易漏环境参数。

### Bazel：发布/多平台与 Cargo 对齐

[`codex-rs/cli/BUILD.bazel`](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/cli/BUILD.bazel#L1-L17)使用 `codex_rust_crate` 和 `multiplatform_binaries`。[`defs.bzl`](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/defs.bzl#L181-L228)说明该宏模拟 Cargo 约定，并为 library、binary、build script 和测试建立 Bazel target。

这会带来一个重要维护规则：Cargo 能看到源码树中的文件，不代表 Bazel 编译也能看到。若使用 `include_str!`、`include_bytes!` 或类似编译期读取，必须同步 `BUILD.bazel` 的 `compile_data`/`build_script_data`。

## 实验一：只用文本工具统计 workspace

这是纯只读实验：

```bash
cd <project-root>
awk '/^members = \[/,/^\]$/ {
  if ($0 ~ /^[[:space:]]+".*",?$/) count++
} END { print count }' codex-rs/Cargo.toml
```

固定提交应输出 `126`。然后观察分布：

```bash
find codex-rs -maxdepth 3 -name Cargo.toml -print | sort
rg -n '^\[\[bin\]\]|^\[lib\]|^name = ' codex-rs/*/Cargo.toml
```

`find` 的数量不必恰好等于 workspace 成员数：嵌套 package、未加入 workspace 的目录或搜索深度都会影响结果。权威成员列表仍是根 `Cargo.toml`。

## 实验二：让 Cargo 输出机器可读地图

该实验可能首次下载依赖元数据，但不会调用模型：

```bash
cd <project-root>/codex-rs
cargo metadata --no-deps --format-version 1 \
  | jq -r '.packages[]
      | [.name, (.targets | map(.kind | join("+")) | join(","))]
      | @tsv' \
  | sort
```

然后只观察关键 package：

```bash
cargo metadata --no-deps --format-version 1 \
  | jq '.packages[]
      | select(.name == "codex-cli"
            or .name == "codex-tui"
            or .name == "codex-app-server"
            or .name == "codex-core"
            or .name == "codex-exec-server")
      | {name, targets: [.targets[] | {name, kind}]}'
```

尝试在输出中区分 package 名、crate target 名和用户可执行名。

## 实验三：验证依赖方向

```bash
cd <project-root>/codex-rs
cargo tree -p codex-cli --edges normal --depth 2
cargo tree -p codex-tui --edges normal --depth 2
cargo tree -p codex-exec-server --edges normal --depth 2
```

再做反向查询：

```bash
cargo tree -i codex-app-server-client --workspace
cargo tree -i codex-exec-server --workspace
```

自建一张两列表：左边是“谁依赖它”，右边是“它依赖谁”。前者说明变更影响面，后者说明实现可调用的能力。

## 实验四：从一个 crate 读到一条调用链

选择 `codex-tui`：

```bash
cd <project-root>
rg -n 'codex-app-server-client|codex-app-server-protocol|codex-core' \
  codex-rs/tui/Cargo.toml
rg -n 'enum AppServerTarget|fn start_app_server|pub async fn run_main' \
  codex-rs/tui/src/lib.rs
rg -n 'app_server.next_event|tokio::select!' codex-rs/tui/src/app.rs
```

预期结论不是“没有 core，所以 TUI 不运行 Agent”，而是“TUI 通过 app-server client 间接驱动拥有 core 的 server”。第 04 章会展开这条链。

## 实验五：最小构建与测试

这些命令会编译 Rust，但不会主动调用真实模型：

```bash
cd <project-root>
just test -p codex-app-server-protocol
just test -p codex-exec-server-protocol
just test -p codex-cli
```

第一次构建可能很久。不要一开始就运行完整 workspace；先用协议叶子和入口 crate 验证工具链，再按阅读范围扩大。

## 如何判断新代码应该放在哪里

遇到一个新功能，依次问：

1. 它是用户输入/输出的表面行为吗？考虑 `tui` 或 `exec`。
2. 它是外部客户端必须稳定调用的契约吗？考虑 app-server v2 protocol 与 processor。
3. 它改变 Agent 的模型/工具决策吗？考虑 core 的现有模块或独立能力 crate。
4. 它是进程、文件、PTY、远程 OS 能力吗？考虑 exec-server/file-system。
5. 它能否成为小而独立的 crate，避免扩大 core？
6. 它是否需要被多个表面复用？如果是，不要只藏在某个 widget。

不要仅因为 core 已经依赖所需类型，就默认把逻辑继续加入 core。依赖方便与所有权正确是两回事。

## 常见误区

- **把仓库根当 Cargo 根。** Rust workspace 在 `codex-rs/`；根 `justfile` 只是帮你自动切目录。
- **把文件夹名、package 名和 crate 名当成同一个字符串。** 连字符通常出现在 Cargo package，Rust 路径使用下划线，binary 又可能另有名字。
- **按 crate 数量平均学习。** 应先走 `cli/tui/app-server/core/exec-server` 主干，再按问题进入叶子能力。
- **把所有 protocol 当一套协议。** app-server、core SQ/EQ、Responses API 与 exec-server 的两端都不同。
- **认为 TUI 直接依赖 core 才能工作。** 固定快照中，TUI 通过 app-server client 和协议驱动内嵌或远程 server。
- **把 `codex exec` 和 `codex exec-server` 混淆。** 前者是非交互客户端，后者是执行环境服务。
- **认为 Cargo 通过就等于所有构建通过。** Bazel 对编译期数据、runfiles 和多平台 target 有额外约束。
- **看到过渡依赖就强行修正架构图。** 先忠实记录实际 graph，再讨论长期边界。

## 自测

1. `codex-rs/cli` package 为什么同时有 `codex` 和 `codex_cli` 两个名字？
2. 从仓库根运行 `just test -p codex-tui` 为什么能找到 workspace？直接运行 `cargo test` 又为什么可能找不到？
3. `codex-tui` 不直接声明 `codex-core` 时，一次 Turn 怎样到达 core？
4. `app-server-protocol` 和 `codex-protocol` 分别连接哪两端？
5. `exec-server-protocol` 为什么不应该承载 TUI widget 状态？
6. 哪个 crate 更像 composition root？为什么它直接依赖很多子系统并不一定是坏事？
7. `cargo tree -i codex-exec-server` 回答的是“它依赖谁”还是“谁依赖它”？
8. 新增一个可被本地和远程环境复用的文件遍历能力时，为什么应先考虑 `file-system`/`exec-server`，而不是直接在 TUI 使用 `std::fs`？

## 本章源码索引

- [Cargo workspace 与统一依赖（固定提交）](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/Cargo.toml)
- [根 Just 工作流（固定提交）](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/justfile)
- [CLI package targets（固定提交）](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/cli/Cargo.toml)
- [TUI manifest（固定提交）](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/tui/Cargo.toml)
- [app-server manifest（固定提交）](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/app-server/Cargo.toml)
- [core manifest（固定提交）](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/core/Cargo.toml)
- [exec-server manifest（固定提交）](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/exec-server/Cargo.toml)
- [Bazel crate macro（固定提交）](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/defs.bzl#L181-L228)

下一章从 npm 的 `codex` 命令开始，沿 JavaScript launcher、argv0 helper 分派和 Clap 命令树走到四个主要 Rust 运行表面。
