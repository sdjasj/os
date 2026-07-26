# 18. 综合工作坊：设计一个可评审的功能，并建立 Codex 术语表

读懂源码的最终标准不是能复述目录，而是面对一个需求时能准确判断改动边界、兼容性风险和验证方法。本章用一个“只读工作区统计工具”的假想需求走完整设计过程。练习不要求你真的修改仓库；重点是形成可审查的变更方案。

## 需求：让模型获取有界的工作区统计

假设产品希望提供 `workspace_stats` 工具，返回当前环境内：

- 被扫描的文件数量；
- 按扩展名聚合的前 20 项；
- 总字节数的有界估算；
- 是否因文件数或输出预算提前截断。

约束：

- 只能读取活动 permission profile 允许的路径；
- 不跟随超出工作区的符号链接；
- 结果必须有硬上限，不能把文件名全集注入模型上下文；
- 本地和远程 exec environment 都要工作；
- TUI 与 app-server 客户端至少能看到开始/结束状态；
- 不新增 v1 app-server API；
- 不把新概念直接塞进 `codex-core`，除非没有更合适的 crate。

## 第一步：先写用户可见行为，而不是文件列表

一个清晰的行为规格可以是：

```text
Given  当前 Turn 选择了一个或多个执行环境
When   模型调用 workspace_stats，指定 environment_id 和可选相对目录
Then   Codex 在该环境的文件系统抽象上进行有界扫描
And    返回聚合统计、truncated 标志和扫描根
And    不返回完整文件列表或文件内容
And    权限拒绝被结构化地返回模型
```

先写这个规格能防止实现逐渐变成“顺便做一个搜索 API”或“把本地 `std::fs` 写死进 core”。

## 第二步：确定所有权和 crate

逐项判断：

| 职责 | 建议所有者 | 理由 |
| --- | --- | --- |
| 参数/输出数据结构 | 一个小型能力 crate 或 `codex-tools` | 可被 core 与测试复用，避免扩大 core API |
| 环境文件遍历 | `codex-file-system` / exec-server 抽象 | 支持远程 OS 和权限边界 |
| 模型可见 schema | core tool spec/extension contributor | 与当前 Turn 的能力集合相关 |
| 调用编排 | tool handler/runtime | 复用 hook、telemetry、取消路径 |
| 公共 UI item | 仅在确有独立展示需求时扩 protocol | 避免为静默聚合工具扩公共协议 |
| TUI 展示 | 先复用通用 tool lifecycle | 没有独特 UI 就不要新增 cell 类型 |

最小方案可能根本不需要新 app-server method：模型工具调用已经会变成现有 item/notification。只有客户端需要主动请求统计时，才考虑 v2 RPC。

## 第三步：设计自解释参数

避免这种 API：

```rust
fn stats(path: Option<PathBuf>, recursive: bool, limit: usize)
```

调用点会出现 `stats(None, true, 20)`，难以审查。更清楚的设计是：

```rust
enum Traversal {
    CurrentDirectory,
    Recursive { max_depth: u16 },
}

struct WorkspaceStatsRequest {
    root: Option<PathUri>,
    traversal: Traversal,
    max_files: u32,
}
```

如果 tool schema 面向模型，所有字段还要给出精确描述和边界；默认值应在一处解析，不能 schema 写 10,000、runtime 却用 100,000。

## 第四步：模型可见规格与 runtime 分离

沿第 08 章的结构，功能会经历：

```text
ToolSpec
  -> build_tool_specs_and_registry
  -> ToolRouter::model_visible_specs
  -> Responses request.tools

ResponseItem::FunctionCall
  -> ToolRouter::build_tool_call
  -> ToolRegistry::dispatch_any_with_terminal_outcome
  -> WorkspaceStatsHandler
  -> environment filesystem
  -> FunctionCallOutput
```

设计审查要分别验证两个问题：

1. 模型会不会在不合适的 Turn 看到该工具？
2. 即使模型伪造同名调用，registry/runtime 是否仍执行权限和参数检查？

不能用隐藏 schema 代替安全校验。

## 第五步：明确有界性

模型上下文规则要求所有注入项有硬 cap。这里至少需要三层边界：

```text
遍历边界：max_files / max_depth / cancellation
聚合边界：最多 20 个扩展名桶，剩余归入 other
序列化边界：输出最大字节或 token 预算
```

输出例子：

```json
{
  "root": "workspace://main/src",
  "filesScanned": 8421,
  "estimatedBytes": 91382744,
  "topExtensions": [
    { "extension": "rs", "count": 2104 },
    { "extension": "toml", "count": 187 }
  ],
  "truncated": true
}
```

不要返回“前 N 个文件名”作为顺手的 debug 信息，它既扩大上下文，也可能泄露调用者没有请求的项目结构。

## 第六步：处理权限与远程环境

错误做法是直接：

```rust
std::fs::read_dir(path)?;
```

这会绕过 environment-owned filesystem，且 app-server 和 exec-server 不同 OS 时路径语义错误。正确思路是从 `TurnEnvironmentSnapshot` 解析目标环境，通过其 `ExecutorFileSystem` 读取元数据，并携带相应 sandbox/permission context。

至少设计这些失败：

- environment id 不存在；
- root 不是绝对的环境原生 URI 或越过 workspace roots；
- 读取被 permission profile 拒绝；
- 扫描途中取消；
- 某些文件消失或无权限读取元数据；
- 远程连接中断。

“某一个文件消失”通常可以计数并继续；“根目录不可读”应让整个工具失败。把容错规则写进规格。

## 第七步：决定是否扩展公共协议

如果通用 MCP/tool call item 已经能表达开始、完成和结果，就不必新增 `WorkspaceStatsStartedEvent`。每加一个公共 variant 都会影响：

- `codex-protocol` 的 enum exhaustiveness；
- app-server v2 转换和 TypeScript 生成物；
- `rawResponseItem/*` 兼容性；
- exec JSONL event；
- TUI 映射；
- rollout 恢复。

只有产品明确需要专门 UI、稳定公共字段或主动 RPC 时，这个成本才合理。

若确实新增 v2 API，遵守：

- method 使用单数资源，如 `workspace/stats`；
- 请求叫 `WorkspaceStatsParams`，响应叫 `WorkspaceStatsResponse`；
- wire 字段 camelCase；
- request 的 `Option<T>` 标注 `#[ts(optional = nullable)]`；
- v2 类型设置 `#[ts(export_to = "v2/")]`；
- 不向 v1 添加新表面；
- 更新 app-server README 和 schema fixture。

## 第八步：列出重大逻辑与用户行为测试

在写代码前先列测试：

1. model request 在 feature/能力启用时包含正确工具 schema；
2. handler 通过 environment filesystem 读取，而非 host `std::fs`；
3. 超过 `max_files` 时结果 `truncated = true`；
4. 输出桶数与序列化大小有硬上限；
5. 权限拒绝不会退化为 unsandboxed 重试；
6. 取消会停止远程遍历；
7. app 与 exec 不同 OS 的路径仍正确；
8. 工具结果用原 `call_id` 回填，模型能继续采样；
9. 若 UI 文案变化，TUI snapshot 覆盖开始与完成状态。

核心 Agent 行为用 `core/tests/suite` 的 mock SSE 验证。远程文件系统路径用 `build_with_auto_env()`。不要只给聚合函数写 unit test 就声称功能完成。

## 第九步：控制变更规模

实际提交前估算 diff：

- 非机械改动总量应尽量低于 800 行；
- 复杂逻辑目标低于 500 行；
- 已很大的 central module 不继续堆独立方法；
- 若需要协议、runtime 和专用 UI 大幅扩展，拆成可独立落地的阶段。

一个合理阶段划分：

```text
阶段 1：能力 crate + environment filesystem 聚合 + 测试
阶段 2：core tool 注册与 Agent 集成测试
阶段 3：仅当需要时扩公共展示/API + TUI snapshot/schema
```

每一阶段都应可编译、可测试，并保持未启用功能时行为不变。

## 第十步：完成验证矩阵

假设最终改动涉及 `codex-tools` 与 `codex-core`：

```bash
just test -p codex-tools
just test -p codex-core <workspace-stats-test-filter>
just test -p codex-core
just fix -p codex-core
just fmt
```

如果还改 app-server protocol：

```bash
just write-app-server-schema
just test -p codex-app-server-protocol
just test -p codex-app-server
```

若改依赖，再运行 `just bazel-lock-update`。格式化和 fix 放在最后，按仓库约定不在其后重复跑测试。

## 贡献边界

上游 `docs/contributing.md` 在本快照明确说明外部贡献仅限受邀。你可以在个人 fork 中完成练习、写 issue 分析或设计说明，但不要把“我实现好了”自动等同于应提交一个未经邀请的 PR。对这个项目，清晰的复现、根因、方案与测试计划本身就是高价值产出。

## 综合练习

不写代码，提交一页设计说明，必须包含：

1. 用户故事和非目标；
2. 数据流图；
3. crate 所有权表；
4. request/output Rust 类型草图；
5. 三层有界性；
6. 权限、远程 OS 和取消语义；
7. 是否扩公共协议及理由；
8. 九项测试清单；
9. 分阶段 diff 预算；
10. 最小验证命令。

如果任何一项只能写“沿用默认行为”，回到对应章节找出默认行为的真正所有者。

## 术语表

| 术语 | 本教程中的准确含义 |
| --- | --- |
| Surface | TUI、exec、IDE、Desktop、SDK 等用户/程序入口 |
| Thread | 可跨多个 Turn 持续、持久化或恢复的对话 |
| Session | 一个 Thread 当前加载到内存后的运行实例 |
| Turn | 一次用户驱动到完成/中断的 Agent 工作单元 |
| Item | Turn 中的用户消息、推理、文本、工具、文件变更等结构化项 |
| Sampling step | 对模型服务的一次请求；一个 Turn 可有多步 |
| Submission / Op | 发送给 core Session 的内部控制消息 |
| Event / EventMsg | core Session 向调用方发出的内部事件 |
| ResponseItem | Responses API 上下文或模型输出中的结构化项 |
| ToolSpec | 发给模型的工具名称、描述和参数 schema |
| ToolRouter | 把模型 item 转成 ToolCall，并连接 registry |
| ToolRegistry | 按名字保存本地 runtime、执行 hook 和 telemetry 的调度层 |
| Handler / Runtime | 参数适配与实际副作用实现；不同工具的划分略有差异 |
| Approval | 决定动作何时需要用户/审查器明确同意的控制 |
| Sandbox | 操作系统或执行环境真正强制的文件/网络边界 |
| Exec policy | 对命令模式做 allow/prompt/forbid 决策的规则层 |
| Permission profile | 文件系统与网络权限等的组合配置 |
| MCP | 外部服务器向 Codex 暴露工具、资源与交互能力的协议 |
| App / Connector | 面向外部服务的已授权工具集合，底层可通过 MCP 接入 |
| Skill | 带 `SKILL.md` 的可复用任务工作流与资源说明 |
| Plugin | 可安装的能力包，可组合 skill、MCP、hook 等 |
| Hook | 在 session/turn/tool/compact 等生命周期点运行的策略或自动化 |
| Context fragment | 有明确角色、位置和边界的模型可见上下文片段 |
| ContextManager | 维护、归一化、截断模型历史和 token 信息的 core 组件 |
| Compaction | 用有界摘要/检查点替换较老上下文以腾出窗口 |
| Rollout | 按顺序持久化 Thread 事实的 canonical JSONL 记录 |
| SQLite projection | 为列表、搜索和元数据查询构建的可重建索引视图 |
| Resume | 以同一 Thread ID 重建并继续上下文 |
| Fork | 复制选定历史边界，创建新的 Thread ID |
| Sub-agent | 在同一根 Agent 控制树中拥有独立 Thread 的工作者 |
| Goal | 绑定 Thread 的持久目标、状态、时间和可选 token 预算 |
| JSONL | 一行一个 JSON 对象的流/文件格式，便于增量消费和恢复 |
| Backpressure | 通过有界队列或流控制限制生产速度，防止无界积压 |

## 最终自测

1. 从 TUI 输入到 Responses API，写出至少八个关键类型或函数。
2. 为什么 model-visible tool 与 runtime registry 必须分别审查？
3. Resume 和 Fork 对 ID 与历史的语义差别是什么？
4. SQLite projection 为什么不能替代 rollout canonical log？
5. 新功能何时值得扩 app-server 公共协议？
6. 一项 Agent 逻辑变化为什么必须有集成测试？
7. 如何证明一个上下文片段是有界的？
8. 当新逻辑似乎“放 core 最方便”时，应先问哪些问题？

## 源码定位

- [仓库开发约定](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/AGENTS.md)
- [工具路由](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/core/src/tools/router.rs)
- [文件系统抽象](https://github.com/openai/codex/tree/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/file-system)
- [环境选择](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/core/src/environment_selection.rs)
- [app-server v2 类型](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/app-server-protocol/src/protocol/v2/mod.rs)
- [贡献说明](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/docs/contributing.md)

完成本章后，建议回到第 00 章重画一次系统图。第一次画的是目录关系；第二次画出的应该是所有权、协议、权限与持久化边界。
