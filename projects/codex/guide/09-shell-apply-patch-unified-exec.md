# 09. Unified Exec 与 Apply Patch：长进程、交互和文件修改的安全路径

Shell 是 Codex 中副作用最强的本地能力之一：它既能做只读搜索，也能启动服务器、修改文件或访问网络。`apply_patch` 同样会写文件，但它不应该只是某段随意交给 shell 的文本。固定快照把命令执行拆成 `exec_command`、live process manager 和 `write_stdin`，并把 shell 形式的 patch 拦截到专门的验证/审批/runtime 路径。本章解释这条链路和它的安全边界。

## 先建立四层安全模型

一次命令能够执行，至少要经过四种不同判断：

| 层 | 问题 | 典型实现 |
| --- | --- | --- |
| 结构解析 | 参数、cwd、环境和 patch 是否可解释？ | Serde、shell/patch parser |
| 策略与审批 | 是否允许请求这类权限，需不需要用户确认？ | approval policy、exec policy、hooks |
| 强制隔离 | 即使命令恶意，OS 实际允许访问什么？ | platform sandbox、filesystem/network policy |
| 结果治理 | 输出如何截断、记录、关联和取消？ | process manager、events、tool output |

审批不是沙箱：用户点击允许只解决“是否同意尝试”，真正访问边界仍由 sandbox/runtime 强制。反过来，处于沙箱中也不表示无需审批；命令可能在允许范围内删除大量工作区文件。

## Unified Exec 为什么拆成两个工具

传统 shell 工具通常等待命令结束再返回。Agent 场景还需要：

- 命令快速结束时一次拿到退出码和输出；
- 编译、测试或服务超过首轮等待时间时返回 process ID；
- 后续轮询增量输出；
- 在 PTY 中发送输入；
- Turn 中断后仍可管理有意启动的后台进程。

所以模型侧看到两个函数：

```json
{"name":"exec_command","arguments":{"cmd":"<command>","yield_time_ms":10000}}
{"name":"write_stdin","arguments":{"session_id":1234,"chars":"","yield_time_ms":1000}}
```

第二个请求中的数字是本地进程会话标识。字段叫 `session_id` 是因为模型已经按这个名字训练，handler 内部会把它映射为 `process_id`；它与 Codex 的 `SessionId` 完全不是一回事。

工具规划位于 [`spec_plan.rs`](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/core/src/tools/spec_plan.rs)：Unified Exec 模式展示 `exec_command` 和 `write_stdin`，同时把 legacy shell 留在 registry 中作为隐藏兼容分派入口。

## exec_command 的参数并非只有 cmd

[`ExecCommandArgs`](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/core/src/tools/handlers/unified_exec.rs) 还包含：

- 可选 shell 与 login 模式；
- 是否分配 TTY；
- 首轮 `yield_time_ms`；
- `max_output_tokens`；
- sandbox 与附加权限请求；
- justification 与可复用 prefix rule。

环境选择和 workdir 先单独解析，因为相对路径必须相对于“选中的执行环境 cwd”解析，不能相对于 app-server 进程的 `current_dir()`。远程执行环境甚至可能与 core 位于不同 OS；代码会检查 Path URI 的路径约定，并在需要本机沙箱却无法安全转换路径时 fail closed。

## exec_command handler 的真实链路

[`ExecCommandHandler::handle_call`](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/core/src/tools/handlers/unified_exec/exec_command.rs) 大致按以下顺序工作：

```text
解析 environment_id / workdir
  → 选中 TurnEnvironment 与 filesystem
  → 选择 sandbox，验证本机/远程路径约定
  → 解析完整 ExecCommandArgs
  → 决定 Direct 或 ZshFork shell mode
  → 分配 process_id，构造 argv
  → 合并 turn 内已授予权限
  → 规范化 additional permissions / approval request
  → 尝试 intercept_apply_patch
  → UnifiedExecProcessManager::exec_command
```

本地可配置 ZshFork 以复用 shell 环境；远程环境强制走 Direct，并使用远端报告的原生 shell。若模型请求了与远端不匹配的 shell 类型，handler 返回模型可见错误，而不是在 core 主机上猜测执行。

权限参数也不能随意扩大能力。如果 approval policy 不允许请求升级权限，handler 会在启动进程前拒绝；附加权限需要规范化并与本 Turn 已批准的 sticky permissions 合并。第 10 章会进一步讨论各平台沙箱，这里先记住顺序：命令解析和审批发生在 process spawn 前。

## Live process：为什么要在首次等待前存入 manager

[`UnifiedExecProcessManager::exec_command`](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/core/src/unified_exec/process_manager.rs) 先在选定沙箱中打开进程，发出 Begin 事件，并启动输出流读取。若进程仍活着，它会在首次 `yield_time` 等待之前把 `Arc<process>` 与元数据写入 process store：

```rust
// 语义摘录：先持有 live process，再等待首轮输出
if process_started_alive {
    self.store_process(/* process, command, cwd, process_id, ... */).await;
}
let collected_output = collect_output_until_deadline(/* ... */).await;
```

若顺序反过来，用户在首轮等待期间中断 Turn，最后一个 `Arc` 可能被丢弃，后台进程会意外终止。现在 process manager 独立持有它，因此 `Op::Interrupt` 只中止当前 Agent task，不默认杀死后台 terminal；显式 `CleanBackgroundTerminals` 或终止命令才表示用户真的要清理它们。

首轮等待结束后有两种结果：

- 已退出：返回 `exit_code`，process ID 不再可交互；
- 仍活跃：返回 `process_id`，后续用 `write_stdin` 继续。

这是一种“yield”，不是固定超时杀进程。

## 输出同时服务 UI 和模型，但预算不同

进程输出一边通过事件流向客户端，一边进入有界 head/tail buffer，形成工具响应。输出可能非常大，代码会：

- 计算原始近似 token 数；
- 按 policy 与 `max_output_tokens` 截断；
- 保留省略字节信息和 chunk ID；
- 关联 call ID、process ID、wall time 与 exit code。

因此 UI 看到过的流式片段与下一次 Prompt 中保存的工具 output 不一定逐字相同。模型上下文必须有硬上限；不能为了“完整日志”把无限编译输出塞入历史。需要完整诊断时应依赖受控日志/文件，而不是绕开 ContextManager 的输出预算。

## write_stdin：轮询与交互共用同一路径

[`WriteStdinHandler`](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/core/src/tools/handlers/unified_exec/write_stdin.rs) 解析：

```rust
struct WriteStdinArgs {
    session_id: i32,
    chars: String,
    yield_time_ms: u64,
    max_output_tokens: Option<usize>,
}
```

语义由 `chars` 决定：

- 空字符串：后台 poll，只等待并收集新输出；
- 非空字符串：向已有终端写入字符，再收集输出；
- 非 TTY 进程通常不接受任意 stdin，代码只为中断控制序列保留受控路径；
- 已退出或未知 process ID 返回模型可见错误。

同一 process 的读写由 interaction lock 串行化，不同 process 可以并行轮询。进程退出后，manager 从 store 移除条目并返回 exit metadata；若仍活跃，响应继续携带相同 process ID。

`write_stdin` 不重复发 PreToolUse Bash hook，因为它只是已经过 pre hook 的原命令的传输延续。若这次 poll 首次观察到原命令结束，它可以发出该原命令对应的 PostToolUse。否则一个长命令会被错误计成许多独立 shell 操作。

## apply_patch 为什么是 freeform 工具

Patch 文本天然是一种小语言，塞进 JSON 字符串会增加转义错误，因此 [`ApplyPatchHandler`](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/core/src/tools/handlers/apply_patch.rs) 使用 custom/freeform payload。它不是拿到文本后直接写文件，而是：

1. `parse_patch` 解析 Add/Update/Delete/Move 等动作；
2. 解析或要求选定 environment；
3. 在该 environment filesystem 和 sandbox context 上验证路径与原始上下文；
4. 计算涉及的源路径、目标路径和所需写权限；
5. 经过 `ToolOrchestrator` 的审批与 runtime；
6. 发出 begin/end、结构化 changes 和 Turn diff；
7. 返回适合模型继续推理的简短结果。

示意 patch 只表达期望变更，不表达绕过路径校验的权力：

```diff
*** Begin Patch
*** Update File: src/example.rs
@@
-old_value
+new_value
*** End Patch
```

验证失败会以 `RespondToModel` 返回，例如上下文不匹配、目标缺失、非法遍历或不允许的环境选择；在副作用前失败的路径应保持文件系统不变。

## Shell 里的 apply_patch 为什么会被拦截

模型有时会生成形如 shell heredoc 的 `apply_patch` 命令。如果把它交给普通 shell，可能绕过专用 handler 的路径验证、审批键、diff tracker 和结构化事件。为保持两种调用表面的安全语义一致，`exec_command` 和 legacy shell 都在 spawn 前调用：

```text
intercept_apply_patch(command, cwd, filesystem, environment, ...)
  ├─ 不是 patch → 返回 None，继续普通 exec
  ├─ 是合法 patch → 走 verify + approval + ApplyPatchRuntime
  └─ 是可识别但不正确的 patch → 返回模型可见验证错误
```

这条拦截不是字符串包含检查。它通过 `maybe_parse_apply_patch_verified` 在给定 cwd、filesystem 和 sandbox 上识别并验证。成功后仍走与 dedicated apply_patch 相同的 runtime/事件路径。

## 安全边界：这些代码没有承诺什么

- `exec_command` 不是“安全命令列表”；任意命令的实际能力取决于权限、审批、沙箱和选定环境。
- 参数解析正确不代表命令无害。合法命令仍可能删除 sandbox 允许写入的数据。
- Turn 中断不保证后台进程停止。要清理必须使用显式后台 terminal 生命周期操作。
- 输出截断不等于进程输出被删除；它只限制事件/模型上下文表示。
- `apply_patch` 验证不是版本控制事务。多文件 patch 失败时应根据 runtime 返回的 committed delta 判断实际变化，不能假设自动回滚。
- PostToolUse hook 不能撤销已经写入的文件。
- 本地和远程环境的路径语义不同，不能用 core 主机路径替代 `PathUri`/environment cwd。

## 安全实验一：完整命令生命周期

下面的集成测试使用测试环境和 mock Responses，不连接真实模型：

```bash
cd <project-root>
just test -p codex-core \
  suite::unified_exec::unified_exec_full_lifecycle_with_background_end_event
just test -p codex-core \
  suite::unified_exec::write_stdin_returns_exit_metadata_and_clears_session
```

观察第一个测试中 Begin、后台 process ID 和最终 End 的关联；再观察第二个测试如何复用 process ID，以及退出后 store 不再返回该会话。测试可能启动短命令，但只在临时测试目录中工作。

## 安全实验二：验证 patch 逃逸被拒绝

```bash
cd <project-root>
just test -p codex-core \
  suite::apply_patch_cli::apply_patch_cli_rejects_path_traversal_outside_workspace
just test -p codex-core \
  suite::apply_patch_cli::apply_patch_cli_does_not_write_through_symlink_escape_outside_workspace
just test -p codex-core \
  suite::tool_harness::apply_patch_reports_parse_diagnostics
```

检查测试的最终断言应包括“工作区外目标未改变”，而不只是模型收到了错误字符串。安全测试必须同时证明拒绝结果和无副作用。

## 常见误区

- 把 `yield_time_ms` 当作命令超时。它只决定何时把当前输出与 process ID 交回模型。
- 把 `write_stdin.session_id` 当成 Codex SessionId。它实际指 unified exec process。
- 认为空 `write_stdin` 什么也不做。它是有等待上限的后台 poll，会收集输出并刷新退出状态。
- 认为 Esc/Interrupt 会自动停止所有服务进程。后台 terminal 被有意设计为可跨 Turn 存活。
- 把 approval 与 sandbox 混成一个开关。一个负责决策，一个负责操作系统强制边界。
- 用进程 cwd 解释工具 workdir。必须以选中的 Turn environment cwd 为基准。
- 让 shell 版 `apply_patch` 绕过专用 handler。interception 正是为了统一验证、审批和 diff 语义。
- 只断言 patch 返回失败，不检查目标文件。安全回归必须验证没有写穿工作区或符号链接边界。

## 自测题

1. `exec_command` 与 `write_stdin` 为什么比“等待到结束的 shell 函数”更适合 Agent？
2. 为什么 live process 必须在首次 yield 等待前进入 process store？
3. 空 chars 和非空 chars 的 `write_stdin` 分别表示什么？
4. 为什么同一 terminal 的交互要串行，而不同 terminal 可以并行？
5. 为什么 `write_stdin` 不重复触发 PreToolUse Bash hook？
6. dedicated `apply_patch` 在真正写文件前经过哪些验证？
7. shell 中的 patch 若不拦截，会绕过哪些语义？
8. 审批通过后，为什么仍然需要 sandbox？

## 源码定位

- [Unified Exec 参数与命令解析](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/core/src/tools/handlers/unified_exec.rs)
- [exec_command handler](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/core/src/tools/handlers/unified_exec/exec_command.rs)
- [write_stdin handler](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/core/src/tools/handlers/unified_exec/write_stdin.rs)
- [UnifiedExecProcessManager](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/core/src/unified_exec/process_manager.rs)
- [apply_patch handler 与 interception](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/core/src/tools/handlers/apply_patch.rs)
- [apply_patch 集成测试](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/core/tests/suite/apply_patch_cli.rs)
- [unified exec 集成测试](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/core/tests/suite/unified_exec.rs)
- [小型工具闭环测试](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/core/tests/suite/tool_harness.rs)

下一章将安全判断继续向下拆成 approval policy、permission profile、exec policy 和 Linux/macOS/Windows 的强制沙箱实现。
