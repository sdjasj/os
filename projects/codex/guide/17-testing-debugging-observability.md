# 17. 测试、调试与可观测性：用最小证据定位跨层问题

Codex 的同一用户行为往往跨过 CLI/TUI、app-server、core、模型流、工具 runtime 和持久化。只在最终界面“点一下看看”很难定位失败属于哪层。本章建立一套证据优先的排错方法：先确定契约层，再选择最小测试，最后才运行更大的系统。

## 测试金字塔应按边界划分

本项目不是简单的“单元测试多、集成测试少”。更合适的分类是：

| 测试层 | 回答的问题 | 典型位置 |
| --- | --- | --- |
| 纯函数/策略 | 一个转换或策略是否正确 | crate 内 `*_tests.rs` |
| core Agent 集成 | 模型事件会不会驱动正确行为 | `core/tests/suite/` |
| app-server 公共 API | 外部客户端看到的 RPC 是否正确 | `app-server/tests/suite/v2/` |
| TUI 状态与快照 | 协议事件最终怎样呈现 | `tui/src/**/*tests.rs`、snapshots |
| 跨进程/远程环境 | app 与 exec 不同 OS 时是否仍成立 | app/exec server 集成测试 |

选择测试的原则是“在最接近被修改契约的层验证”。比如改变 Agent 是否再次采样，应写 core 集成测试；新增 app-server 字段必须从 JSON-RPC API 验证；只改变渲染则使用 TUI snapshot。

## core 集成测试如何替代真实模型

`core_test_support::responses` 能构造本地 Responses SSE。一个典型模式是：

```rust
let server = responses::start_mock_server().await;
let sse = responses::sse(vec![
    responses::ev_response_created("resp-1"),
    responses::ev_completed("resp-1"),
]);
let response_mock = responses::mount_sse_once(&server, sse).await;

let test = test_codex().build(&server).await?;
test.submit_turn_with_permission_profile(
    "hello",
    PermissionProfile::read_only(),
).await?;

let request = response_mock.single_request();
let body = request.body_json();
```

这个测试同时覆盖：配置 → Session → Prompt → HTTP 请求，但没有真实账户、非确定模型或费用。`ResponseMock` 必须保留，才能断言 Codex 发出的请求；如果预期一次 POST，使用 `single_request()` 能顺便抓住意外重试。

### 测工具闭环

把 SSE 改成函数调用，再挂第二个最终响应：

```rust
responses::sse(vec![
    responses::ev_response_created("resp-1"),
    responses::ev_function_call("call-1", "some_tool", r#"{"value":1}"#),
    responses::ev_completed("resp-1"),
])
```

第二次请求应该包含同一个 `call_id` 的 function-call output。优先使用 test support 的结构化 helper，而不是手动下标访问 JSON：

```rust
let output = request.function_call_output("call-1");
```

这样协议字段移动时，测试失败更接近真正兼容性问题。

## app-server 测试必须站在公共 API 外面

app-server 的 v2 测试通常从 `TestAppServer::builder().build()` 启动实例，再通过 JSON-RPC 请求交互。启动线程时优先使用：

```rust
app_server
    .send_thread_start_request_with_auto_env(ThreadStartParams::default())
    .await?;
```

`with_auto_env` 不是语法糖：它让 app-server 与 exec-server 位于不同操作系统时仍使用正确的环境原生路径。测试不应绕过 RPC 直接调用 processor，否则 Rust 内部能工作并不能证明 camelCase wire shape、experimental gate 和 notification 顺序正确。

对一个新增 v2 API，至少验证：

1. client request 能从线协议反序列化；
2. response/notification 的 method 与字段名正确；
3. 缺少初始化握手时会被拒绝；
4. experimental 字段按 capability gate 生效；
5. 失败使用稳定 JSON-RPC error，而不是 panic 或断连接。

## TUI 为什么需要 snapshot

终端 UI 的回归往往是组合结果：宽度、换行、样式、状态和多个 cell 顺序共同决定屏幕。逐字段断言无法展示真实影响，`insta` snapshot 更合适。

典型流程：

```bash
just test -p codex-tui
cargo insta pending-snapshots -p codex-tui
cargo insta show -p codex-tui path/to/file.snap.new
cargo insta accept -p codex-tui
```

接受 snapshot 前要直接阅读 `.snap.new`。更新 snapshot 不是“让测试变绿”，而是确认视觉变化正是预期。任何用户可见 UI 或文案变化都应有相应 snapshot 覆盖。

## 测试模块的仓库惯例

新增测试模块时，实现在单独的 sibling 文件中：

```rust
#[cfg(test)]
#[path = "parser_tests.rs"]
mod tests;
```

断言优先：

- 引入 `pretty_assertions::assert_eq`；
- 对整个对象做 deep equality；
- 不为静态常量写无意义测试；
- 不为已经删除的逻辑补负面测试；
- 不为了测试向公共 API 暴露 helper。

如果逻辑改变 Agent 决策，单元测试通常不够，必须补 `core/tests/suite` 集成测试。

## 从最小命令逐步扩大

仓库根 `justfile` 把工作目录设为 `codex-rs`。推荐顺序：

```bash
# 1. 精确测试或 crate
just test -p codex-protocol
just test -p codex-core <test-name-filter>

# 2. 改动 crate
just test -p codex-core

# 3. 完成代码后修复 lint、格式化
just fix -p codex-core
just fmt
```

只有修改 `common`、`core` 或 `protocol` 等共享范围、且获得运行完整套件的授权后，才扩大到：

```bash
just test
```

不要为常规验证加 `--all-features`，它会显著扩大构建矩阵和 `target/` 占用。Rust 编译锁等待可能很久，不应通过杀 PID“解决”。

## 生成物是契约的一部分

有些改动仅编译通过仍不完整：

| 改动 | 必须同步 |
| --- | --- |
| `ConfigToml` 或嵌套配置类型 | `just write-config-schema` |
| app-server API shape | `just write-app-server-schema` |
| experimental app-server fixture | 再运行 `--experimental` 版本 |
| Cargo 依赖或 lockfile | `just bazel-lock-update` |
| compile-time 文件读取 | crate 的 `BUILD.bazel` data 声明 |

这类 drift 常在 Bazel 或 schema CI 才暴露。教程练习时也要把“生成物是否同步”写进变更计划。

## 日志：先保持 stdout 契约

不同表面对 stdout 有严格语义：

- TUI 库禁止意外写 stdout/stderr；
- `codex exec` 默认模式的 stdout 应只含最终消息；
- `codex exec --json` 的 stdout 必须是逐行合法 JSONL；
- app-server stdio 的 stdout 是协议通道。

所以诊断输出必须走 tracing 或 stderr，而不能临时 `println!`。源码通过 crate 级 lint 阻止这种破坏。

### TUI 日志

上游安装文档给出的方式是显式设置目录：

```bash
RUST_LOG=codex_core=debug,codex_tui=debug \
  codex -c log_dir=./.codex-log
tail -F ./.codex-log/codex-tui.log
```

日志目录可能包含用户路径、命令或上下文，排错后不要提交。

### app-server 日志

```bash
RUST_LOG=codex_app_server=debug LOG_FORMAT=json \
  codex app-server --listen stdio://
```

stdio 上的 JSON-RPC 仍走 stdout，结构化 tracing 走 stderr。调试客户端必须分别捕获两条流。

## Instrumentation 应放在函数定义上

仓库约定优先：

```rust
#[tracing::instrument(level = "trace", skip_all)]
async fn do_work(...) { /* ... */ }
```

而不是在调用处给 future 临时 `.instrument(...)`。定义处 instrumentation 能覆盖所有调用路径，也更容易通过 trace 看清：thread spawn、run turn、sampling request、tool dispatch 和 approval 之间的父子关系。添加之前先检查被调用函数是否已经 instrumented，避免重复 span。

## 一套跨层排错剧本

假设现象是“模型调用 shell 后 UI 一直转圈”。按层缩小：

1. 模型层：mock SSE 是否包含完整 FunctionCall 与 response completed？
2. 路由层：`ToolRouter::build_tool_call` 是否返回 call？名字和 namespace 是否一致？
3. registry：handler 是否注册、payload kind 是否匹配？
4. policy：是否卡在 hook、approval 或网络审批？
5. runtime：子进程是否结束，PTY session 是否仍活跃？
6. core event：是否发出工具完成和 TurnComplete/TurnAborted？
7. app-server：notification 是否映射并发给订阅连接？
8. TUI：active thread receiver 是否消费，cell 生命周期是否转为 completed？

每一步都要求一个可观察证据，不用“可能是异步问题”代替定位。

## 本章实验一：阅读一个完整集成测试

选择 `codex-rs/core/tests/suite/web_search.rs` 中一个测试，标出：

1. mock 服务创建；
2. SSE 脚本；
3. `test_codex` 配置；
4. 用户 Turn；
5. 出站请求断言。

然后回答：这个测试能发现工具 schema 错误吗？能发现 TUI 渲染错误吗？为什么？

## 本章实验二：建立故障矩阵

为下面四种失败分别选择最小测试层：

- 配置层级 precedence 错误；
- function-call output 没有回填；
- `turn/completed` wire 字段错误；
- shell completed cell 在 80 列终端换行异常。

参考答案依次是 config 单元测试、core 集成测试、app-server v2 测试、TUI snapshot。

## 自测

1. 为什么 core Agent 行为优先用 mock Responses 集成测试，而不是纯 unit test？
2. app-server 测试为何不能直接调用 request processor？
3. 为什么 `codex exec --json` 中一条调试 `println!` 属于协议破坏？
4. snapshot 更新前必须人工检查什么？
5. 哪些改动需要同步 schema 或 Bazel lock？
6. 如何用八层排错剧本定位“工具完成但 UI 未结束”？

## 源码定位

- [core 集成测试示例](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/core/tests/suite/web_search.rs)
- [app-server v2 测试目录](https://github.com/openai/codex/tree/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/app-server/tests/suite/v2)
- [TUI streaming snapshot 示例](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/tui/src/streaming/render_tests.rs)
- [根 justfile](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/justfile)
- [构建与日志说明](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/docs/install.md)

最后一章把前面的边界合并成一项可评审的端到端功能设计，并给出全教程术语表。
