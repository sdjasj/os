# 03. `codex` 如何启动：npm Launcher、argv0 Helper 与 Clap 多工具入口

用户只输入一个 `codex`，背后却经过了两次分派。第一次发生在 npm 的 JavaScript launcher：它识别操作系统和 CPU，找到对应的原生 Rust binary，并保持信号与退出码语义。第二次发生在原生 binary：先按 argv0/隐藏参数判断是否要扮演 sandbox、patch 或 filesystem helper，再由 Clap 把普通命令路由到 TUI、`exec`、app-server、exec-server 等表面。

本章从进程模型出发，解释为什么一个可执行文件能承担多种角色，以及参数、环境、信号和异步 runtime 如何在入口处被正确交接。它不深入每个子命令的业务逻辑，而是回答“下一跳到底在哪里”。

## 固定快照与本章目标

```text
repository: https://github.com/openai/codex
commit:     61a44880a85d2fd0d8770908dea5733495e571c8
```

读完后你应能：

1. 区分 npm package、JavaScript launcher 和原生 `codex` binary；
2. 解释为什么 launcher 要异步 `spawn`，并转发 SIGINT/SIGTERM/SIGHUP；
3. 解释 argv0、argv1 和普通 CLI subcommand 的不同；
4. 从 `main()` 追踪到 `codex_tui::run_main`、`codex_exec::run_main`、app-server 和 exec-server；
5. 理解根级配置覆盖为什么必须传播给子命令；
6. 用 `--help` 和源码搜索验证路由，而不发起模型请求。

## 背景一：Shell 执行的不是“包”，而是文件

通过 npm 安装后，package manager 为 `codex` 创建命令入口。入口来自 [`codex-cli/package.json`](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-cli/package.json#L1-L20)。下面是真实源码删节；只省略末尾很长的 `packageManager` 固定版本字段，并相应移除前一字段的尾逗号以保持片段为合法 JSON：

```json
{
  "name": "@openai/codex",
  "version": "0.0.0-dev",
  "description": "Codex CLI is a coding agent from OpenAI that runs locally on your computer.",
  "license": "Apache-2.0",
  "bin": {
    "codex": "bin/codex.js"
  },
  "type": "module",
  "engines": {
    "node": ">=16"
  },
  "files": [
    "bin/codex.js"
  ],
  "repository": {
    "type": "git",
    "url": "git+https://github.com/openai/codex.git",
    "directory": "codex-cli"
  }
}
```

这段配置只说明“命令先执行 `bin/codex.js`”，不说明 Agent 是 JavaScript 实现。launcher 接下来会寻找平台包中的 Rust binary。

如果使用独立安装脚本、Homebrew 或 release archive，也可能直接得到原生 binary，跳过 Node 这一层。因此排错时先问：当前 `codex` 是 package-manager shim、JavaScript launcher，还是直接的原生文件？

## 背景二：进程、argv、环境和信号

一个进程启动时至少接收三类入口状态：

- 参数向量 `argv`：`argv[0]` 通常是调用时使用的程序名，后面才是用户参数；
- 环境变量：例如 `PATH`、安装来源标记、配置和日志开关；
- 进程信号：Ctrl-C 在 Unix 上通常变成 SIGINT。

父进程启动子进程后，二者有独立 PID 和退出状态。若父进程不转发信号，用户按 Ctrl-C 可能只终止 launcher，留下原生 child；若父进程不镜像退出码，脚本就无法知道 Codex 是成功、失败还是被信号终止。

Windows 的 signal 语义与 Unix 不完全相同，但 launcher 仍统一处理 Node 能表达的常见终止事件。

## 第一段启动链：npm launcher 选择原生包

[`codex-cli/bin/codex.js`](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-cli/bin/codex.js#L16-L77)先把 target triple 映射为平台 npm 包：

```text
x86_64-unknown-linux-musl  -> @openai/codex-linux-x64
aarch64-unknown-linux-musl -> @openai/codex-linux-arm64
x86_64-apple-darwin        -> @openai/codex-darwin-x64
aarch64-apple-darwin       -> @openai/codex-darwin-arm64
x86_64-pc-windows-msvc     -> @openai/codex-win32-x64
aarch64-pc-windows-msvc    -> @openai/codex-win32-arm64
```

下面是[真实源码删节](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-cli/bin/codex.js#L16-L77)；只保留映射和 Linux 分支，其余平台分支明确省略：

```js
const PLATFORM_PACKAGE_BY_TARGET = {
  "x86_64-unknown-linux-musl": "@openai/codex-linux-x64",
  "aarch64-unknown-linux-musl": "@openai/codex-linux-arm64",
  "x86_64-apple-darwin": "@openai/codex-darwin-x64",
  "aarch64-apple-darwin": "@openai/codex-darwin-arm64",
  "x86_64-pc-windows-msvc": "@openai/codex-win32-x64",
  "aarch64-pc-windows-msvc": "@openai/codex-win32-arm64",
};

const { platform, arch } = process;
let targetTriple = null;

switch (platform) {
  case "linux":
  case "android":
    switch (arch) {
      case "x64":
        targetTriple = "x86_64-unknown-linux-musl";
        break;
      case "arm64":
        targetTriple = "aarch64-unknown-linux-musl";
        break;
      default:
        break;
    }
    break;
  // ... 删节：darwin、win32 和 default 分支 ...
}
```

target triple 同时编码 CPU、供应商/平台和 ABI。Linux 发布选用 musl target，有利于生成更独立的发布二进制；这不代表源码只能在 musl 系统上编译。

### 定位 binary

`findCodexExecutable()` 先解析平台 package，再拼出 `vendor/<target>/bin/codex`。如果 optional dependency 没装好，它根据 npm/pnpm/bun 给出对应重装命令。

下面是[真实源码删节](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-cli/bin/codex.js#L79-L108)，省略的只是错误提示拼接细节：

```js
function findCodexExecutable() {
  let vendorRoot;
  try {
    const packageJsonPath = require.resolve(`${platformPackage}/package.json`);
    vendorRoot = path.join(path.dirname(packageJsonPath), "vendor");
  } catch {
    vendorRoot = path.join(__dirname, "..", "vendor");
  }

  const codexExecutable = path.join(
    vendorRoot,
    targetTriple,
    "bin",
    process.platform === "win32" ? "codex.exe" : "codex",
  );
  if (existsSync(codexExecutable)) {
    return codexExecutable;
  }

  // ... 删节：构造重装建议并抛出错误 ...
}
```

这里没有下载二进制，也没有动态编译；平台包应在安装阶段作为 optional dependency 准备好。

### 为什么使用异步 `spawn`

launcher 没有用 `spawnSync`。源码注释明确说明：异步 child 让 Node 在原生 binary 运行期间仍能响应信号。

以下[真实片段](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-cli/bin/codex.js#L179-L198)未删节：

```js
const packageManager = detectPackageManager();
const packageManagerEnvVar =
  packageManager === "bun"
    ? "CODEX_MANAGED_BY_BUN"
    : packageManager === "pnpm"
      ? "CODEX_MANAGED_BY_PNPM"
      : "CODEX_MANAGED_BY_NPM";
const env = {
  ...process.env,
  CODEX_MANAGED_PACKAGE_ROOT: codexPackageRoot,
};
delete env.CODEX_MANAGED_BY_NPM;
delete env.CODEX_MANAGED_BY_BUN;
delete env.CODEX_MANAGED_BY_PNPM;
env[packageManagerEnvVar] = "1";

const child = spawn(binaryPath, process.argv.slice(2), {
  stdio: "inherit",
  env,
});
```

三个细节值得注意：

1. `process.argv.slice(2)` 把用户参数原样交给原生 binary；Node 自身和脚本路径不传下去；
2. `stdio: "inherit"` 让 TUI 直接使用当前 terminal，也保留 stdin/stdout/stderr 语义；
3. 安装来源环境变量先全部清掉，再只设置一个，避免嵌套或旧环境污染判断。

随后 launcher 转发 `SIGINT`、`SIGTERM` 和 `SIGHUP`，并在 child 退出时镜像退出码或重新发出同一信号。对应源码在 [`codex.js:209-249`](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-cli/bin/codex.js#L209-L249)。

## 第二段启动链：原生 `main` 先执行 arg0 分派

原生入口位于 [`codex-rs/cli/src/main.rs`](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/cli/src/main.rs#L958-L976)。真实源码未删节：

```rust
fn main() -> anyhow::Result<()> {
    let remote_control_disabled = codex_app_server::take_remote_control_disabled_env();
    arg0_dispatch_or_else(move |arg0_paths: Arg0DispatchPaths| async move {
        cli_main(arg0_paths, remote_control_disabled).await?;
        Ok(())
    })
}
```

`main` 没有直接调用 `MultitoolCli::parse()`，而是先进入 `arg0_dispatch_or_else`。这保证隐藏 helper 和正常 Clap 命令共享同一个发布 binary。

## 背景三：argv0 trick 与 multi-call binary

Unix 程序可以检查调用自己的名字。BusyBox 就用类似思路让一个 binary 扮演多个命令：当文件以某个 alias 名称被执行时，程序根据 `argv[0]` 选择角色。

Codex 还检查一个隐藏 argv1 标记，用于不能或不适合依赖别名的 helper 路径。两者必须区分：

```text
argv0 分派：程序“叫什么名字”
argv1 分派：程序名后的第一个参数是不是内部标记
Clap 子命令：面向用户的普通命令树
```

例如：

```text
codex exec ...
│     └─ Clap 子命令
└─ argv0

codex-linux-sandbox ...
└─ argv0 本身触发 helper
```

## `arg0_dispatch` 究竟做了什么

[`arg0/src/lib.rs:60-150`](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/arg0/src/lib.rs#L60-L150)先读取 `argv0` 的 basename，再检查隐藏 argv1。

下面是实际源码删节，只保留角色选择；patch 内容读取与错误处理明确省略：

```rust
pub fn arg0_dispatch() -> Option<Arg0PathEntryGuard> {
    let mut args = std::env::args_os();
    let argv0 = args.next().unwrap_or_default();
    let exe_name = Path::new(&argv0)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("");

    // ... 删节：Unix execve wrapper ...

    if exe_name == CODEX_LINUX_SANDBOX_ARG0 {
        codex_linux_sandbox::run_main();
    } else if exe_name == APPLY_PATCH_ARG0 || exe_name == MISSPELLED_APPLY_PATCH_ARG0 {
        codex_apply_patch::main();
    }

    let argv1 = args.next().unwrap_or_default();
    #[cfg(unix)]
    if argv1 == CODEX_ARG0_EXEC_HELPER_ARG1 {
        codex_exec_server::run_arg0_exec_helper_main();
    }
    if argv1 == CODEX_FS_HELPER_ARG1 {
        codex_exec_server::run_fs_helper_main();
    }

    // ... 删节：Windows wrapper、core apply_patch、PATH alias 准备 ...
}
```

这些 helper 是内部执行基础设施，不是普通用户命令，因此没有出现在 `codex --help` 的子命令列表中。

### 为什么还要构造 `Arg0DispatchPaths`

Agent 之后可能需要启动 sandbox helper 或让子进程重新执行当前 Codex binary。测试 harness 下，`std::env::current_exe()` 可能指向测试 binary，而不是真正的 Codex。因此 [`Arg0DispatchPaths`](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/arg0/src/lib.rs#L27-L37)把这些路径显式交给后续配置和执行层。以下为真实源码删节，只省略字段上的说明性 doc comment：

```rust
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct Arg0DispatchPaths {
    pub codex_self_exe: Option<PathBuf>,
    pub codex_linux_sandbox_exe: Option<PathBuf>,
    pub main_execve_wrapper_exe: Option<PathBuf>,
}
```

### `.env` 与 runtime 初始化顺序

正常分派会在创建线程和 Tokio runtime 之前加载 Codex home 下的 `.env`，并准备临时 PATH alias。修改进程环境在多线程程序中可能不安全，所以顺序本身就是安全约束，而非任意启动样板。

[`arg0_dispatch_or_else`](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/arg0/src/lib.rs#L190-L243)还会创建拥有受控栈大小的主线程和 Tokio multi-thread runtime，再运行传入的 async main。也就是说，Clap 后续调用的表面可以自然使用 `.await`，而普通 Rust `main` 仍保持同步签名。

## 第三段启动链：Clap 建立多工具命令树

### 根参数与子命令并存

[`MultitoolCli`](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/cli/src/main.rs#L90-L120)把根级配置、feature toggle、远程连接、TUI 参数和可选子命令放在一起。

以下为真实源码删节，只省略结构体前的 doc comment 与属性中的解释性行内注释：

```rust
#[derive(Debug, Parser)]
#[clap(
    author,
    version,
    subcommand_negates_reqs = true,
    bin_name = "codex",
    override_usage = "codex [OPTIONS] [PROMPT]\n       codex [OPTIONS] <COMMAND> [ARGS]"
)]
struct MultitoolCli {
    #[clap(flatten)]
    pub config_overrides: CliConfigOverrides,

    #[clap(flatten)]
    pub feature_toggles: FeatureToggles,

    #[clap(flatten)]
    remote: InteractiveRemoteOptions,

    #[clap(flatten)]
    interactive: TuiCli,

    #[clap(subcommand)]
    subcommand: Option<Subcommand>,
}
```

`flatten` 让多个结构体的字段出现在同一级 CLI 帮助中；`subcommand: Option<_>` 使“没有子命令”成为合法状态。Codex 正是把这个状态解释为交互 TUI。

### `Subcommand` 是入口目录

[`Subcommand`](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/cli/src/main.rs#L122-L211)列出面向用户和隐藏的多种表面。

下面为真实源码删节，保留本教程主线并明确省略其他 variant：

```rust
#[derive(Debug, clap::Subcommand)]
enum Subcommand {
    /// Run Codex non-interactively.
    #[clap(visible_alias = "e")]
    Exec(ExecCli),

    /// Run a code review non-interactively.
    Review(ReviewCommand),

    // ... 删节：login、logout、MCP、plugin 等 ...

    /// [experimental] Run the app server or related tooling.
    AppServer(AppServerCommand),

    // ... 删节：completion、update、sandbox、resume/fork 等 ...

    /// [EXPERIMENTAL] Run the standalone exec-server service.
    ExecServer(ExecServerCommand),

    /// Inspect feature flags.
    Features(FeaturesCli),
}
```

Clap derive 把 enum variant、字段属性和 doc comment 转成解析器与帮助文本。阅读命令行为时，先在 enum 找到参数类型，再跳到 `match subcommand`，不要从整个 `main.rs` 顶部顺序阅读。

## `cli_main` 的核心分派

[`cli_main`](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/cli/src/main.rs#L966-L1040)先解析根参数，把 feature enable/disable 折叠进配置覆盖，再分派。

下面是实际源码删节，只保留默认、exec 和 review 路径；参数传播细节用注释明确省略：

```rust
async fn cli_main(
    arg0_paths: Arg0DispatchPaths,
    remote_control_disabled: bool,
) -> anyhow::Result<()> {
    let MultitoolCli {
        config_overrides: mut root_config_overrides,
        feature_toggles,
        remote,
        mut interactive,
        subcommand,
    } = MultitoolCli::parse();

    let toggle_overrides = feature_toggles.to_overrides()?;
    root_config_overrides.raw_overrides.extend(toggle_overrides);

    // ... 删节：远程参数、strict config 和 profile 校验 ...

    match subcommand {
        None => {
            // ... 删节：把根配置覆盖合并进 TUI 参数 ...
            let exit_info = run_interactive_tui(
                interactive,
                root_remote.clone(),
                root_remote_auth_token_env.clone(),
                arg0_paths.clone(),
            )
            .await?;
            handle_app_exit(exit_info)?;
        }
        Some(Subcommand::Exec(mut exec_cli)) => {
            // ... 删节：远程模式校验和根参数继承 ...
            codex_exec::run_main(exec_cli, arg0_paths.clone()).await?;
        }
        Some(Subcommand::Review(ReviewCommand { args: review_args, .. })) => {
            let mut exec_cli = ExecCli::try_parse_from(["codex", "exec"])?;
            exec_cli.command = Some(ExecCommand::Review(review_args));
            // ... 删节：配置继承 ...
            codex_exec::run_main(exec_cli, arg0_paths.clone()).await?;
        }
        // ... 删节：其余子命令 ...
    }
}
```

这里能看出：

- 无子命令不是错误，而是 TUI 默认入口；
- `exec` 跳到 `codex-exec` library 的 async `run_main`；
- `review` 不是另一套 Agent runtime，而是构造一个 `ExecCommand::Review` 后复用 exec；
- `Arg0DispatchPaths` 被继续传给需要执行 helper 的表面。

## 四条最重要的分派路径

### 1. `codex [PROMPT]`：交互 TUI

```text
cli::main
  -> arg0_dispatch_or_else
  -> cli_main
  -> match subcommand: None
  -> run_interactive_tui
  -> codex_tui::run_main
  -> run_ratatui_app
```

`run_interactive_tui` 还负责把根 `--remote` 选项转换为远程 app-server endpoint。第 04 章从 `codex_tui::run_main` 继续。

### 2. `codex exec`：非交互表面

```text
cli_main
  -> Subcommand::Exec
  -> 继承根 shared/config 参数
  -> codex_exec::run_main
  -> 内嵌 app-server client
  -> thread/start + turn/start
  -> human 或 JSONL event processor
```

`codex exec` 不是 shell `exec(2)` 的简单封装，也不是 exec-server。它是面向脚本和 CI 的完整 Agent 客户端。

### 3. `codex app-server`：公共控制面服务

[`cli/src/main.rs:1102-1155`](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/cli/src/main.rs#L1102-L1155)解析 stdio/listen/auth/remote-control 选项，并调用：

```rust
codex_app_server::run_main_with_transport_options(
    // ... 删节：路径、配置与运行选项参数 ...
)
.await?;
```

上面是明确删节的真实调用形态。独立 app-server 可使用 stdio、Unix socket 或 websocket；TUI 的内嵌模式则在同一进程中复用相同 processor 语义。

### 4. `codex exec-server`：执行环境服务

[`run_exec_server_command`](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/cli/src/main.rs#L1694-L1763)先用 `Arg0DispatchPaths` 构造 runtime paths，然后二选一：

```text
设置 --remote
  -> 注册 environment
  -> codex_exec_server::run_remote_environment

未设置 --remote
  -> 解析 listen URL
  -> codex_exec_server::run_main_with_telemetry
```

这条路径服务于进程/文件/PTY 能力，不负责 TUI 渲染或模型采样。

## 为什么还有独立 `codex-tui`、`codex-exec` binary

`tui/Cargo.toml`、`exec/Cargo.toml` 和 `app-server/Cargo.toml` 各自也声明 binary，方便直接开发和测试：

```text
codex-tui
codex-exec
codex-app-server
```

发布给普通用户的主要入口仍是多工具 `codex`。独立 binary 的存在不意味着生产安装一定同时暴露所有文件；它们也是 crate 边界、集成测试和局部开发的工具。

## 配置覆盖为何要在入口处显式传播

根命令允许 `-c key=value`、feature enable/disable、profile、sandbox、cwd 等选项。子命令结构也可能有自己的配置字段。`cli_main` 会：

1. 把 feature toggle 转成统一配置覆盖；
2. 校验某些根选项是否适用于所选子命令；
3. 把 root override 前置合并到 TUI 或 exec 的 override；
4. 让更具体的子命令参数保持可预测优先级。

如果入口只“跳函数”而不传播这些值，就会出现 `codex -c ... exec` 与 `codex exec -c ...` 行为不一致。读路由代码时，不应把这些合并步骤当成无意义样板。

## 从输入到下一章的完整启动图

```text
用户输入 codex [参数]
  │
  ├─ npm 安装：bin/codex.js
  │    ├─ platform + arch -> target triple
  │    ├─ target triple -> 平台 npm package
  │    ├─ 定位 vendor/.../bin/codex
  │    └─ spawn + stdio inherit + signal/exit forwarding
  │
  └─ 原生 codex
       ├─ arg0_dispatch
       │    ├─ argv0 helper：linux sandbox / apply_patch / execve wrapper
       │    ├─ argv1 helper：exec / filesystem / platform wrapper
       │    └─ 正常路径：准备 PATH、Tokio runtime、Arg0DispatchPaths
       │
       └─ Clap MultitoolCli
            ├─ None       -> TUI
            ├─ exec       -> codex-exec
            ├─ review     -> codex-exec::Review
            ├─ app-server -> codex-app-server
            └─ exec-server-> codex-exec-server
```

## 实验一：静态验证 npm launcher

纯只读，不编译、不调用模型：

```bash
cd <project-root>
node --version
node --check codex-cli/bin/codex.js
rg -n 'PLATFORM_PACKAGE_BY_TARGET|findCodexExecutable|spawn\(' \
  codex-cli/bin/codex.js
rg -n 'SIGINT|SIGTERM|SIGHUP|childResult' codex-cli/bin/codex.js
```

回答：若删掉 `stdio: "inherit"`，TUI 最可能出现什么问题？若 parent 永远以 0 退出，CI 又会误判什么？

## 实验二：只运行帮助路径

这些命令会编译 Rust，但不会登录或调用模型：

```bash
cd <project-root>
just codex --help
just codex exec --help
just codex app-server --help
just codex exec-server --help
```

记录每条命令的 usage。特别观察第一条同时支持：

```text
codex [OPTIONS] [PROMPT]
codex [OPTIONS] <COMMAND> [ARGS]
```

这正对应 `subcommand: Option<Subcommand>`。

## 实验三：用符号搜索重建路由

```bash
cd <project-root>
rg -n 'fn main|async fn cli_main|match subcommand' \
  codex-rs/cli/src/main.rs
rg -n 'run_interactive_tui|codex_exec::run_main|run_main_with_transport_options' \
  codex-rs/cli/src/main.rs
rg -n 'run_exec_server_command|run_remote_environment|run_main_with_telemetry' \
  codex-rs/cli/src/main.rs
```

为每个命中写一行：“输入类型 → 被调用 crate/function → 是否进入长期事件循环”。

## 实验四：观察 argv0 分派而不执行 helper

只阅读和测试普通 library；不要把构建产物随意改名为 `apply_patch` 或 sandbox helper 后执行：

```bash
cd <project-root>
rg -n 'CODEX_LINUX_SANDBOX_ARG0|APPLY_PATCH_ARG0|CODEX_FS_HELPER_ARG1' \
  codex-rs/arg0/src/lib.rs
rg -n 'pub struct Arg0DispatchPaths|arg0_dispatch_or_else' \
  codex-rs/arg0/src/lib.rs
just test -p codex-arg0
```

目标是理解选择条件，不是手工触发内部 helper。helper 可能直接操作 patch、filesystem 或 sandbox 进程，脱离预期参数运行没有学习价值。

## 实验五：验证根配置传播

帮助路径可展示参数归属：

```bash
cd <project-root>
just codex --help | less
just codex exec --help | less
rg -n 'prepend_config_flags|inherit_exec_root_options|feature_toggles' \
  codex-rs/cli/src/main.rs
```

然后画出一个假想参数 `-c model="..."` 从 `MultitoolCli` 到 TUI/exec 配置的路径。不要在教程实验里放真实 API key 或账户信息。

## 常见误区

- **“npm 包说明 Codex 是 Node 应用。”** Node 文件只是分发 launcher，Agent 主体是原生 Rust binary。
- **“平台 package 是运行时下载器。”** launcher 只定位安装好的 optional dependency，缺失时给出重装建议。
- **“`spawn` 后 parent 可以立即退出。”** TUI 需要继承 stdio，信号和 child 退出状态也必须由 parent 协调。
- **“argv0 就是第一个用户参数。”** argv0 是调用名；Rust `args_os()` 的下一项才是 argv1。
- **“所有隐藏 helper 都是 Clap 子命令。”** arg0/argv1 分派发生在 Clap 解析之前。
- **“`codex exec` 就是 exec-server。”** `exec` 是无头 Agent 客户端，exec-server 是进程/文件执行服务。
- **“review 有独立模型循环。”** CLI 把 review 转成 `ExecCommand::Review`，复用 `codex-exec` 表面。
- **“分派只需调用目标函数。”** 配置、profile、remote、strict config 和 runtime helper 路径都要同步传播。
- **“独立 `codex-tui` binary 与用户 `codex` 是两套实现。”** 前者是同一 TUI library 的直接开发入口，普通 `codex` 也调用该 library。

## 自测

1. npm 安装后，shell 命令 `codex` 首先对应哪个文件？真正的 Agent binary 又在哪里定位？
2. 为什么 `process.argv.slice(2)` 而不是整个 `process.argv` 被传给 child？
3. `stdio: "inherit"` 对 TUI 有什么必要性？
4. argv0 alias、隐藏 argv1 标记和 Clap subcommand 分别在什么阶段判断？
5. `Arg0DispatchPaths` 为什么不能在所有场景都临时调用 `current_exe()` 得到？
6. `subcommand == None` 为什么是合法且重要的分支？
7. `codex review` 最终复用哪个 crate？
8. 本地 `codex exec-server` 和远程模式分别调用哪个执行服务入口？
9. 为什么 `.env` 和 PATH alias 准备要发生在创建多线程 runtime 之前？

## 本章源码索引

- [npm package manifest（固定提交）](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-cli/package.json)
- [npm launcher（固定提交）](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-cli/bin/codex.js)
- [arg0 分派实现（固定提交）](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/arg0/src/lib.rs)
- [原生多工具 CLI 入口（固定提交）](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/cli/src/main.rs)
- [CLI targets 与依赖（固定提交）](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/cli/Cargo.toml)
- [源码构建与运行说明（固定提交）](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/docs/install.md#L15-L50)

下一章从默认 `None -> TUI` 分支继续，观察 TUI 如何选择内嵌、daemon 或远程 app-server，并用一个 `tokio::select!` 循环同时处理终端、内部消息和协议事件。
