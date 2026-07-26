# 第 16 章：非交互执行与 SDK——把 Codex 嵌入脚本、CI 和应用

交互式 TUI 适合人在回路中的探索；自动化系统则需要稳定的输入、结构化事件、明确的退出状态和可取消执行。Codex 提供三条程序化路径：`codex exec`、TypeScript SDK、Python SDK。它们共享底层 Agent 能力，却不是同一种传输协议的三层包装。

本章会先追踪 Rust 侧的 `codex exec`，再比较两个 SDK 的实现，从而回答一个实际问题：什么时候调用命令，什么时候用 SDK，什么时候直接接 app-server？内容依据固定源码快照 [`61a4488`](https://github.com/openai/codex/commit/61a44880a85d2fd0d8770908dea5733495e571c8)。

## 1. 先建立“控制面与展示面”概念

一个自动化客户端通常需要两层协议：

- 控制面：创建 Thread、启动/中断 Turn、响应审批、恢复会话；
- 展示面：把内部细粒度事件压缩成调用方容易消费的输出。

app-server v2 是完整控制面；`codex exec --json` 是面向一次命令执行的展示协议。后者只暴露一组较稳定、较小的 JSONL 事件，不等于 app-server 的全部通知。

```text
完整 app-server 事件
  ├─ thread、turn、item 生命周期
  ├─ delta、审批请求、配置告警、MCP 交互……
  └─ 经 exec 映射和归并
       └─ thread.started / turn.started / item.* / turn.completed / error
```

因此，不要仅凭 `codex exec --json` 的事件类型推断 app-server 的全部 API，也不要把 app-server 的任意新通知直接当成 exec JSONL 的兼容承诺。

## 2. `codex exec` 的 stdout 是机器接口

[`exec/src/lib.rs`](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/exec/src/lib.rs) 文件开头写明了两个不变量：

- 默认模式的 stdout 只能出现最终消息；
- JSON 模式的 stdout 必须是逐行有效 JSON。

日志、告警和进度文字必须去 stderr。crate 还使用 `#![deny(clippy::print_stdout)]`，把这条接口约束变成编译期纪律，仅在真正的事件发射点局部允许输出。

这对 shell 管道至关重要：

```bash
result="$(codex exec '概括当前变更')"

codex exec --json '运行相关测试并解释失败' \
  | jq -c 'select(.type == "turn.completed")'
```

如果调试日志混入 stdout，第一个命令得到脏文本，第二个命令会直接解析失败。

## 3. CLI 输入规则：参数、stdin 与结构化输出

参数结构位于 [`exec/src/cli.rs`](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/exec/src/cli.rs)。最值得记住的输入规则是：

- 有位置参数时，它是主提示；
- 没有位置参数或显式写 `-` 时，从 stdin 读取；
- 同时有位置参数和管道 stdin 时，stdin 作为附加上下文；
- `--output-schema` 指向最终回答的 JSON Schema；
- `--output-last-message` 把最终 Agent 消息另存到指定文件；
- `resume` 继续一个已有 Thread；
- `--ephemeral` 不持久化会话。

一个安全的 CI 组合是：

```bash
git diff --cached | codex exec - \
  --sandbox read-only \
  --output-schema ./review-schema.json \
  --output-last-message ./review-result.json
```

这里把 diff 作为数据送入 stdin，沙箱设为只读，最终结果单独落盘。不要把不受信任文本插值进一条拼接的 shell 命令；使用参数数组或 stdin 可以少一层 shell 解释。

## 4. Rust 主线：exec 其实复用 in-process app-server

`run_exec_session` 并没有直接调用 `Session::spawn`。它创建 [`InProcessAppServerClient`](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/app-server-client/src/lib.rs)，然后使用同一套类型化请求：

```text
加载配置与权限
  → InProcessAppServerClient::start
  → thread/start 或 thread/resume
  → turn/start 或 review/start
  → select! 等待通知、服务端请求和 Ctrl-C
  → 映射事件
  → thread/unsubscribe + shutdown
```

这一设计让 TUI、exec 和外部 app-server 客户端共享行为边界。exec 的特殊之处集中在：

- 如何把 CLI 选项转换成 `ThreadStartParams` / `TurnStartParams`；
- 如何自动处理审批等 server request；
- 如何把丰富通知映射成面向命令行的事件；
- 如何维护 stdout、stderr 与退出码契约。

恢复也通过 `thread/list` 与 `thread/resume`，不再绕过 API 直接读取 rollout。这减少了“交互入口能恢复，但 headless 入口语义不同”的分叉。

## 5. JSONL：为什么选择逐行 JSON

JSON 数组只有在末尾 `]` 写出后才完整；长 Turn 中调用方无法逐项消费。JSONL 每一行都是独立 JSON 对象，天然适合 pipe 和异步生成器：

```json
{"type":"thread.started","thread_id":"..."}
{"type":"turn.started"}
{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"..."}}
{"type":"turn.completed","usage":{"input_tokens":100,"output_tokens":20}}
```

真实 ID 与数据由运行时产生；示例只展示形状。消费者应按 `type` 做穷尽分派，并对未知字段保持宽容。不要假设一个 JSONL item 等于一个 Responses API `ResponseItem`：exec 会生成自己的 item ID、合并 delta，并把 app-server 枚举映射为更小的公开集合。

映射器位于 [`event_processor_with_jsonl_output.rs`](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/exec/src/event_processor_with_jsonl_output.rs)。例如，命令执行、文件修改、MCP 调用、协作 Agent、todo、推理摘要和最终消息都会转成 `ThreadItem` 的不同 variant。

## 6. 错误、退出码与取消

自动化不能只看是否收到过文本。一次 Turn 可能先产出若干 item，最后仍以失败或中断结束。可靠调用方至少要同时检查：

1. 子进程是否正常启动；
2. 每一行是否能解析；
3. 是否收到 `turn.failed` 或顶层 `error`；
4. 进程退出码是否为 0；
5. 是否收到预期的终止事件。

Ctrl-C 到来时，exec 会发送 `turn/interrupt`，而不是立即让整个进程无条件消失。这样 core 有机会取消工具、发出终止事件并清理订阅。SDK 也应把调用方取消映射到进程信号或协议 interrupt，而不能只停止读取 stdout，否则子进程可能继续工作。

## 7. TypeScript SDK：围绕 `codex exec --json` 的轻量封装

TypeScript SDK 的入口是 [`sdk/typescript/src/codex.ts`](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/sdk/typescript/src/codex.ts)：`Codex.startThread()` 或 `resumeThread()` 返回一个 `Thread`。真正的传输层在 [`exec.ts`](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/sdk/typescript/src/exec.ts)：

```text
CodexExec.run
  → 定位当前平台的 codex 原生二进制
  → 构造 codex exec --experimental-json [resume ID]
  → prompt 写入 stdin
  → readline 逐行读取 stdout
  → 非零退出时附带有界收集的 stderr
```

[`thread.ts`](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/sdk/typescript/src/thread.ts) 提供两个层级：

- `runStreamed()` 返回 `AsyncGenerator<ThreadEvent>`；
- `run()` 消费整个生成器，收集 completed item、最终 Agent 消息和 usage。

简化的消费方式如下：

```typescript
const thread = codex.startThread({
  workingDirectory: "/path/to/project",
  sandboxMode: "read-only",
});

const { events } = await thread.runStreamed("只分析测试失败，不修改文件");
for await (const event of events) {
  if (event.type === "item.completed") {
    consume(event.item);
  } else if (event.type === "turn.failed") {
    report(event.error);
  }
}
```

`Thread.id` 在收到 `thread.started` 后才填充，因此创建对象后、第一轮尚未开始时它可以是 `null`。恢复则把已有 ID 放进 `codex exec ... resume <id>`。

### 配置覆盖为什么要序列化为 TOML

SDK 接受嵌套 JavaScript 对象，但 CLI 的覆盖形式是重复的 `--config dotted.path=value`。`flattenConfigOverrides` 递归展开对象，`toTomlValue` 负责字符串、有限数值、布尔、数组和 inline table。`null` 被拒绝，因为它没有无歧义的 TOML 值语义。

全局 SDK config 先写入参数，Thread 选项后写入，因此更具体的 Thread 设置具有更高优先级。涉及权限时，调用方仍应显式设置可读的枚举值，不要依赖神秘的布尔组合。

## 8. Python SDK：面向 app-server 的类型化客户端

Python SDK 走的是另一条路径。[`sdk/python/src/openai_codex/client.py`](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/sdk/python/src/openai_codex/client.py) 的 `CodexClient` 启动：

```text
codex app-server --listen stdio://
```

随后执行 `initialize` request 与 `initialized` notification，再用带 ID 的请求和无 ID 的通知通信。reader thread 把 response 按 request ID 分发给 waiter，把 Turn、登录和 Goal 通知送进各自队列。

更高层 API 位于 [`sdk/python/src/openai_codex/api.py`](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/sdk/python/src/openai_codex/api.py)，提供同步和异步的 Thread、TurnHandle、steer、interrupt、审批与 Goal 操作。协议模型由 app-server schema 生成，并用 Pydantic 校验。

因此两种 SDK 的定位可以这样比较：

| 维度 | TypeScript SDK | Python SDK |
| --- | --- | --- |
| 底层进程 | `codex exec --json` | `codex app-server` |
| 传输 | 单 Turn JSONL 输出 | 双向 JSON-RPC/JSONL |
| API 宽度 | 简洁的 run/stream/resume | Thread/Turn/审批/登录/Goal 等完整控制 |
| 类型来源 | 手写 exec 事件类型 | app-server schema 生成模型 |
| 适合 | 脚本、构建步骤、一次性工作流 | 长生命周期服务、交互应用、细粒度控制 |

这不是语言能力优劣，而是当前仓库中两套 SDK 的架构事实。

## 9. 三条集成路径怎样选

### 选 `codex exec`

适合 shell、CI、Makefile 或只需最终文本/JSONL 的任务。优点是依赖少、行为可直接在终端复现；代价是需要自己管理进程、超时和事件解析。

### 选 TypeScript SDK

适合 Node.js 应用，希望用 `AsyncGenerator` 消费标准 exec 事件，且不需要完整双向 app-server surface。SDK 已处理平台二进制定位、参数序列化、临时 schema 文件和取消信号。

### 选 Python SDK 或直接 app-server

适合需要 steer、interrupt、审批回调、多 Thread、Goal、登录或长期事件订阅的应用。Python SDK 提供类型化门面；其他语言可以依据 app-server schema 实现客户端。

选择标准应是“需要多宽的控制面”，而不是“哪种写法看起来更高级”。

## 10. 安全与可靠性清单

- 默认从 `read-only` 或 `workspace-write` 开始，不为省事使用 full access。
- 把工作目录、附加目录和输出文件解析为明确路径；不要让模型文本决定宿主机任意路径。
- API key 通过进程环境或认证存储传递，不出现在命令参数、日志或教程示例中。
- 自定义 `env` 时注意它通常代表完整环境，而不只是增量字段；至少保留运行二进制所需的 PATH。
- stderr 可能包含诊断信息，展示前要做敏感信息处理，并设置有界缓存。
- 给自动化设置取消与外部超时，同时等待子进程退出，避免孤儿进程。
- 结构化输出仍需本地 schema 校验；“模型被要求输出 JSON”不等于永远合法。
- resume ID 属于持久会话句柄，不要把不同用户的 Thread 混用。
- 生产消费者处理未知事件时应向前兼容，关键终止事件缺失时应失败关闭。

## 11. 动手实验一：验证 stdout/stderr 契约

在一个临时 Git 仓库中运行，不让实验修改正在学习的源码：

```bash
lab_dir="$(mktemp -d)"
git -C "$lab_dir" init

codex exec --cd "$lab_dir" --sandbox read-only --json \
  '列出目录并用一句话说明结果，不要修改文件' \
  >"$lab_dir/events.jsonl" \
  2>"$lab_dir/diagnostics.log"

jq -c . "$lab_dir/events.jsonl" >/dev/null
```

验证点：

1. JSONL 每一行都能独立解析；
2. 首批事件中有 Thread/Turn 生命周期；
3. 最终有完成或失败事件；
4. 诊断日志没有混入 JSONL；
5. read-only 模式下没有产生工作区修改。

实验结束后按你的系统习惯删除临时目录。不要把真实会话、认证文件或日志提交到仓库。

## 12. 动手实验二：测试 SDK，而不请求真实模型

TypeScript 测试通过 [`codexExecSpy.ts`](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/sdk/typescript/tests/codexExecSpy.ts) 替换子进程边界，可以验证参数和 JSONL 聚合。Python 测试则使用 [`app_server_harness.py`](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/sdk/python/tests/app_server_harness.py) 模拟 app-server。

```bash
cd <project-root>

pnpm --dir sdk/typescript test -- --runInBand

cd sdk/python
uv run pytest tests/test_app_server_run.py
```

若本机没有对应依赖，先阅读各 SDK 的 lockfile 与仓库开发说明；不要为了一个教程实验在生产环境中全局升级依赖。

可以自己补一个测试：让假进程先输出 `item.completed`，再输出 `turn.failed`，断言高级 `run()` 最终抛错而不是把之前的 Agent 文本误当成成功结果。

## 13. 常见误区

- “`codex exec` 直接绕过 app-server 调 core”：当前实现使用 in-process app-server client。
- “`--json` 返回一个 JSON 数组”：它返回 JSONL，每行独立。
- “stdout 可以顺便打印调试信息”：stdout 是程序接口，诊断必须走 stderr。
- “收到 agent message 就成功”：必须等终止事件并检查退出码。
- “TypeScript 和 Python SDK 只是不同语言的同一实现”：当前前者包装 exec，后者连接 app-server。
- “停止读流就完成取消”：还要通知协议层或终止并回收子进程。
- “structured output 自动保证业务正确”：schema 只保证形状，不验证事实。
- “SDK 设置 full access 后应用仍然安全”：SDK 不会替宿主应用恢复已经放弃的隔离。

## 14. 本章自测

1. 为什么 exec 对 stdout 的约束比普通 CLI 更严格？
2. JSONL 相比一个大 JSON 数组，怎样改善流式消费？
3. `codex exec` 为什么复用 in-process app-server，而不是直接调用 core？
4. app-server notification 与 exec `ThreadEvent` 是什么关系？
5. 为什么 `Thread.id` 在 TypeScript SDK 第一轮开始前可能为空？
6. TypeScript config 对象怎样变成 CLI 参数，为什么拒绝 `null`？
7. Python SDK 为什么需要 response waiter 和 notification router 两套路径？
8. 你的集成需要哪一种控制面：exec、轻量 SDK，还是完整 app-server？

读完本章后，你应能把“运行 Codex”拆成配置解析、Thread/Turn 控制、事件映射和进程协议四层，并能为自己的自动化场景选出足够、但不过度复杂的入口。
