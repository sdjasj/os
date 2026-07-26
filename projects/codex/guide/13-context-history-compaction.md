# 13. 上下文、历史与压缩：在有限窗口中保持可解释状态

Codex 必须同时满足三件看似冲突的事：模型要看到足够多的历史；请求前缀应尽量稳定以利用缓存；对话再长也不能突破上下文窗口。与此同时，审计日志不能因为“模型看不下了”就被删除。固定快照用 `ContextManager` 管当前有效模型上下文，用 TurnContext/WorldState 基线生成增量，用本地或远端 compaction 重建较短历史，再把替代历史作为 rollout 检查点追加持久化。

## 先区分四种“历史”

| 名称 | 服务对象 | 是否直接发给模型 | 是否权威持久化 |
| --- | --- | --- | --- |
| UI 事件流 | TUI/app-server/SDK | 否 | 只有部分事件持久化 |
| `ContextManager` | 当前 Session | `for_prompt()` 后是 | 否，是内存中的有效状态 |
| rollout JSONL | 审计、恢复与重放 | 不直接发送 | 是，追加式规范记录 |
| SQLite 投影 | 列表、搜索、分页查询 | 否 | 可从 rollout 重建 |

“模型上下文”不是“所有发生过的事件”。例如文本 delta 适合 UI 动画，却不应逐片永久加入 Prompt；完整工具输出可能为几兆字节，ContextManager 会截断；compaction 后模型只看到 replacement history，但旧事实仍留在此前的 rollout 行中。

## ContextManager 的内存结构

[`ContextManager`](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/core/src/context_manager/history.rs) 的核心字段是：

```rust
pub(crate) struct ContextManager {
    items: Arc<Vec<ResponseItem>>,
    history_version: u64,
    token_info: Option<TokenUsageInfo>,
    reference_context_item: Option<TurnContextItem>,
    world_state_baseline: Option<WorldStateSnapshot>,
}
```

`items` 从旧到新排列。用 `Arc<Vec<_>>` 是 copy-on-write：多个只读消费者可共享同一快照，只有 `Arc::make_mut` 真正追加时才复制。这对 sampling、token 估算和持久化并发读取很重要，避免每次请求深拷贝整个 transcript。

`history_version` 在 compaction、rollback 等“替换历史”操作时增加；普通追加不需要把整个历史视为新版本。两个 baseline 分别支持设置差异和 WorldState 差异生成。

## record_items：先限制，再保存

`record_items` 只保留可进入 API 的 `ResponseItem`，system item 不作为普通历史记录；函数和 custom-tool 输出会按模型的 truncation policy 处理。设计目标不是保存完整终端日志，而是保存“足够模型继续工作的有界表示”。

这一区分可以写成：

```text
raw command output
  ├─ 流式事件：供 UI 即时观察
  ├─ 受控日志：供人类深入诊断
  └─ truncated ResponseItem：进入模型上下文
```

工具结果中还可能包含图片、音频或结构化 content items；预算估算和截断必须知道它们的类型，不能用简单的 `String::truncate` 代替。

## for_prompt：发送前归一化

调用模型前，`ContextManager::for_prompt` 在快照上执行 normalization：

1. 每个 function/custom call 都应有对应 output；
2. 每个 output 都应找到对应 call；
3. 当前模型不支持图片时移除图片内容；
4. 当前模型不支持音频时移除音频内容。

这解释了为什么 raw history 与真正发送的 input 可能不同。归一化不应该随意改写共享 Session 历史，所以 `for_prompt` 消费一个 clone 出来的 ContextManager 快照，并利用 copy-on-write 隔离修改。

示意：

```text
raw items:       [user, call c1, output c1, orphan output c9, image]
model abilities: text only
for_prompt:      [user, call c1, output c1]
```

调用/输出成对不仅为了 API 校验，也让 compaction、rollback 与 replay 不会留下语义悬空的工具结果。

## 初始上下文不能每轮完整重发

模型除了聊天历史，还需要 cwd、sandbox、日期、环境能力、用户指令和 AGENTS.md 等上下文。如果每个 Turn 都重新插入完整 developer bundle，会带来：

- Prompt 不断膨胀；
- 相同语义产生重复 item；
- 前缀变化导致 prompt cache miss；
- 恢复时难以判断哪份设置是当前值。

[`record_context_updates_and_set_reference_context_item`](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/core/src/session/mod.rs) 使用 baseline：

```text
reference_context_item == None
  → 注入完整 initial context
  → 持久化 full WorldState + TurnContext baseline

reference_context_item != None
  → 计算 settings diff
  → 计算 WorldState diff
  → 只记录变化的 contextual fragments
  → 更新 durable baseline
```

模型切换时可能需要额外注入 `<model_switch>` 信息，防止模型特定指令丢失。即使某个 Turn 没产生模型可见设置差异，也会保留足够的 TurnContext baseline，供后续持久化语义使用。

## WorldState 是什么

WorldState 表示模型所处“世界”的结构化快照，而不只是用户消息，例如环境、能力和其他可观察运行状态。`ContextManager::update_world_state` 同时产生：

- 给模型看的 contextual fragment diff；
- 给 rollout 的 `WorldStateItem::full` 或 merge patch。

首次没有 baseline 时必须是 full snapshot；之后可以记录 patch。顺序也很关键：代码先记录由状态生成的模型可见 item，再持久化 WorldState/TurnContext baseline。否则崩溃点可能形成“基线已经前进，但对应上下文尚未写入”的不一致。

Step 中 WorldState 仍可能变化。`run_turn` 在每次 sampling request 前比较并记录变化，因此长工具链不会永远使用 Turn 开始时的陈旧环境视图。

## Token 预算不是精确 tokenizer 的单一数字

ContextManager 既接收服务端返回的 token usage，也能用字节/内容启发式估算。估算是保守控制信号，不应宣传为精确计费值。

[`context_window_token_status`](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/core/src/session/context_window.rs) 同时考虑：

- 当前完整 active context tokens；
- auto-compact 范围：总上下文，或 initial prefix 之后的 body；
- 模型完整 context window 的硬上限；
- token-budget fallback buffer；
- 当前 window 的 prefill baseline。

即使配置只按 body-after-prefix 触发 auto compact，完整模型窗口仍是不可越过的硬上限。`base_window_tokens_remaining` 会取多个限制中的最小余量。

## 压缩何时发生

压缩有三种主要时机：

- 手动：调用方提交 `Op::Compact`；
- pre-turn：新输入加入前预计会越过阈值；
- mid-turn：模型/工具还需 follow-up，但当前窗口已达到限制。

pre-turn 先压旧历史，再记录新用户输入；mid-turn 必须保留尚未完成的工具连续性，并把规范初始上下文放到 replacement history 的正确位置。二者不能简单共用“把 summary 追加在末尾”这一条规则。

## 本地 compaction：让模型总结，再重建短历史

[`compact.rs`](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/core/src/compact.rs) 的本地流程仍使用普通 Responses stream：

1. 创建 `ContextCompaction` TurnItem 并发出 started；
2. 在历史末尾加入 compaction prompt；
3. 用一个 Turn 级 client session 请求总结；
4. 若服务端报告 context window exceeded，从最旧项开始移除；若该项属于 call/output 配对，也同步移除 counterpart；
5. 从完成历史中取得最后一个 assistant summary；
6. 按 token 上限保留最近的真实用户消息；
7. 追加带固定 summary prefix 的摘要；
8. 必要时在最后真实用户消息/摘要前重新注入当前 canonical context；
9. 安装 replacement history，重算 token，并完成 compaction item。

结果形状近似：

```text
压缩前: [initial context, U1, A1, call, output, U2, A2, U3, ...]

压缩后: [fresh canonical context,
         recent U2,
         recent U3,
         summary of earlier work]
```

保留近期用户原话能减少摘要遗漏精确约束的风险，但压缩仍然有损。代码会提醒长线程和反复压缩可能降低准确率；对高度精确的新任务，开新 Thread 往往优于无限压缩。

## 远端 compaction：`/responses/compact` 返回替代历史

[`compact_remote_request.rs`](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/core/src/compact_remote_request.rs) 构造包含当前 input、visible tools 和 base instructions 的 Prompt，调用 model client 的 `/responses/compact`。请求前会重写过大的 function-call outputs，使压缩请求本身先能放进窗口。

远端返回的是一组 replacement `ResponseItem`，不是单一摘要字符串。安装前 [`process_compacted_history`](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/core/src/compact_remote.rs) 会：

- 丢弃服务返回的 developer messages，避免旧指令重复或覆盖当前 canonical 指令；
- 丢弃不是“真实用户内容”的 user wrapper；
- 保留真实用户消息、持久 hook prompt、assistant/agent message 和 compaction item；
- 从当前 Session 重新生成 canonical context；
- mid-turn 时把 canonical context 插在最后真实用户消息或摘要之前。

这体现一个重要信任边界：远端负责压缩对话语义，当前 Session 才是配置、环境与开发者指令的权威来源。

## 安装 replacement history 是显式重写点

[`replace_compacted_history`](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/core/src/session/mod.rs) 做四件事：

```text
给缺失的 ResponseItem 分配本地 ID
  → ContextManager.replace(replacement_history)
  → append RolloutItem::Compacted { replacement_history, window metadata }
  → append full WorldState + TurnContext baseline
```

`ContextManager.replace` 会递增 `history_version` 并清空旧 WorldState baseline，因为新窗口不能继续对已被替换的基线做 patch。

这里是“有效模型历史被重写”的语义边界，但 rollout 文件本身仍是追加式：旧项不会被原地删除，后面新增一个带 replacement history 的 checkpoint。下一章会专门讲恢复如何使用 checkpoint；本章只需记住“内存替换，日志追加”。

## Rollout、JSONL 与 SQLite 的分层

[`LocalThreadStore`](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/thread-store/src/local/mod.rs) 明确把 JSONL 视为 durable replay format，把 SQLite 视为快速查询的 metadata/history 投影。

写入顺序是：

```text
Session.persist_rollout_items
  → ThreadStore / LiveThread
  → durable JSONL append + flush barrier
  → materialize eligible items into SQLite
```

[`write_and_project`](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/thread-store/src/local/live_writer.rs) 保证 durable write 先完成。SQLite 投影失败时可以落后，不能领先于规范 JSONL；后续可追赶或重建。

rollout policy 也不会持久化所有事件。符合 policy 的消息、推理、工具调用/输出等 `ResponseItem`，以及 Compacted、TurnContext、WorldState、SessionMeta 和部分终止事件是 durable；`AdditionalTools`、CompactionTrigger、文本 delta、ItemStarted、RawResponseItem 等通常只是瞬时或可重建信息。不要通过“UI 是否显示过”推断“rollout 一定保存了”。

## 压缩应保持的三个不变量

1. replacement history 中调用和输出仍成对，且媒体符合当前模型能力。
2. canonical settings/WorldState 来自当前 Session，而不是盲信旧摘要或远端 developer item。
3. 当前有效历史可被替换，但 durable rollout 只追加 checkpoint，不原地改写审计过去。

任何优化若破坏这三点，都可能表现为模型 API 拒绝、恢复后指令漂移或 SQLite 比 JSONL 多出“尚未真正持久化”的事实。

## 安全实验一：观察本地压缩事件

测试使用 mock Responses，不需要账户：

```bash
cd <project-root>
just test -p codex-core \
  suite::compact::manual_compact_emits_context_compaction_items
just test -p codex-core \
  suite::compact::auto_compact_runs_after_token_limit_hit
```

比较手动与自动用例：二者都应产生 ContextCompaction 生命周期项，但触发来源和 Turn 时机不同。不要通过把本地上下文窗口设置到危险的大值来“避免测试”；阈值行为正是测试目标。

## 安全实验二：验证远端 replacement 与 durable checkpoint

```bash
cd <project-root>
just test -p codex-core \
  suite::compact_remote::remote_compact_replaces_history_for_followups
just test -p codex-core \
  suite::compact_remote::remote_compact_persists_replacement_history_in_rollout
just test -p codex-thread-store \
  paginated_live_append_materializes_turn_items_and_state
```

前两个测试分别验证下一次 Prompt 使用替代历史、rollout 中存在 replacement checkpoint；最后一个验证 durable append 后的 SQLite 投影。它们使用临时目录和本地 mock，不读取用户真实 rollout。

## 常见误区

- 把 ContextManager 当完整审计日志。它只保存当前模型所需的有效、有界上下文。
- 把 token estimate 当精确计费。它是窗口控制的启发式下界/估算，服务端 usage 才是另一类证据。
- 每个 Turn 重发完整 cwd、指令和环境状态。baseline/diff 正是为稳定前缀和限制增长而设计。
- 只删除孤立工具 output，不处理对应 call。历史必须维持配对不变量。
- 认为 compaction 只是把旧消息删掉。它生成语义摘要/替代项，重注入 canonical context，并追加 durable checkpoint。
- 盲信远端 compaction 返回的 developer message。当前 Session 才是配置与指令的权威来源。
- 认为压缩后 rollout 文件也会变短。旧日志仍在，只在末尾新增 replacement checkpoint。
- 把 SQLite 当规范数据源。它是可落后、可重建的投影，JSONL durable write 必须先成功。
- 认为无限次压缩没有质量成本。摘要有损，长线程应按任务边界拆分。

## 自测题

1. UI 事件、ContextManager、rollout JSONL 和 SQLite 分别服务什么目的？
2. `Arc<Vec<ResponseItem>>` 的 copy-on-write 对采样快照有什么帮助？
3. `for_prompt` 为什么要补齐/移除 call-output 配对并过滤不支持媒体？
4. reference TurnContext 和 WorldState baseline 如何减少重复上下文？
5. body-after-prefix 的 auto-compact 范围为什么仍不能越过模型完整窗口？
6. 本地 compaction 在压缩请求本身超窗时怎样缩小输入？
7. 远端 replacement 为什么要删除 developer messages 并重新注入 canonical context？
8. “内存替换，日志追加”具体指哪两个操作？
9. 为什么 SQLite 允许落后 JSONL，却绝不能领先？

## 源码定位

- [ContextManager、截断与归一化](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/core/src/context_manager/history.rs)
- [上下文归一化 helpers](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/core/src/context_manager/normalize.rs)
- [WorldState 模型](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/core/src/context/world_state/mod.rs)
- [Session 上下文增量与 replacement 安装](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/core/src/session/mod.rs)
- [窗口与 token 状态](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/core/src/session/context_window.rs)
- [本地 compaction](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/core/src/compact.rs)
- [远端 compaction 请求](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/core/src/compact_remote_request.rs)
- [远端 replacement 处理](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/core/src/compact_remote.rs)
- [Rollout 持久化策略](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/rollout/src/policy.rs)
- [本地 ThreadStore 分层](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/thread-store/src/local/mod.rs)
- [JSONL 先于 SQLite 的 live writer](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/thread-store/src/local/live_writer.rs)

下一章会接着讨论 durable checkpoint 如何参与线程恢复、rollback、fork 和 lineage；那里关注重放算法，本章则只关注当前有效上下文如何生成和替换。
