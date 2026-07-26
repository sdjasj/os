# 第 15 章：多 Agent 协作与持久目标——从并行任务树到自动续跑

前面的章节把一次 Turn 内部的模型、工具与上下文串了起来。本章再向外扩一层：当一个任务可以拆成多个相互独立的子问题时，Codex 如何创建子 Agent、限制并发、传递消息并汇总结果？当任务不能在一个 Turn 内完成时，Codex 又如何用 Goal 保存目标、统计预算并在空闲后继续工作？

两套机制解决的问题不同：

- 多 Agent 解决“同一时刻怎样并行推进多个子任务”；
- Goal 解决“跨多个 Turn 怎样持续追踪一个明确目标”。

它们都不是把模型调用简单复制几份，而是建立在 Thread、事件、持久化、资源上限和状态机之上的控制平面。本章依据固定源码快照 [`61a4488`](https://github.com/openai/codex/commit/61a44880a85d2fd0d8770908dea5733495e571c8)。

## 1. 先补背景：任务并行不等于数据并行

并行执行大致有三种形态：

1. 数据并行：同一算法处理不同数据块；
2. 流水线并行：不同阶段处理不同批次；
3. 任务并行：不同执行者处理不同、但可能有关联的子问题。

Codex 多 Agent 属于第三种。适合并行的任务通常满足至少一项：

- 可只读扫描不同子系统；
- 可在互不重叠的文件中实现；
- 一个 Agent 验证测试，另一个追踪协议；
- 主 Agent 仍有独立的关键路径工作可做。

如果两个 Agent 同时改同一段代码，计算虽然并行，冲突处理却变成新的串行瓶颈。因此，好的拆分不仅写清“做什么”，还要写清输入、输出、文件所有权和完成条件。

可以把任务表示成一个依赖图：

```text
             ┌─ 子任务 A：梳理协议 ─┐
根任务 ──────┼─ 子任务 B：定位测试 ─┼─ 汇总证据 ─ 修复 ─ 验证
             └─ 子任务 C：安全审查 ─┘
```

前三个节点没有依赖，可以同时运行；“修复”依赖汇总结果，应留在汇合点之后。这就是并行任务编排最基本的 DAG 思维。

## 2. 运行时对象：一棵树，共享一个控制平面

核心入口是 [`core/src/agent/control.rs`](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/core/src/agent/control.rs) 中的 `AgentControl`。源码注释给出了关键不变量：一个根 Thread 树最多创建一次控制器，根 Agent 与所有后代共享它。

它的结构可以简化为：

```rust
struct AgentControl {
    session_id: SessionId,
    manager: Weak<ThreadManagerState>,
    state: Arc<AgentRegistry>,
    agent_execution_limiter: Arc<AgentExecutionLimiter>,
    rollout_budget: Arc<RolloutBudget>,
}
```

这几个字段分别回答五个问题：

| 字段 | 作用 | 设计原因 |
| --- | --- | --- |
| `session_id` | 标识整棵协作树 | 所有子 Agent 属于同一协作会话 |
| `manager` | 找到真实 Thread | 使用 `Weak` 避免控制器和线程状态形成引用环 |
| `state` | 保存树、路径、昵称与数量 | 限制作用域在这棵树，而不是整个进程 |
| execution limiter | 限制同时运行的 Agent | 防止创建成功后同时抢占无限资源 |
| rollout budget | 汇总整棵树的 token 消耗 | 预算必须覆盖父子 Agent，而非每个 Agent 各算一份 |

这里必须区分 `ThreadId` 与 `SessionId`：每个 Agent 是一个可独立运行、持久化和接收事件的 Thread，因此有自己的 `ThreadId`；整棵父子树共享控制会话的 `SessionId`。把两者混为一谈，会让“给谁发消息”和“谁共享预算”都变得含糊。

## 3. AgentRegistry：路径、昵称与 RAII 预留

[`core/src/agent/registry.rs`](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/core/src/agent/registry.rs) 保存两类状态：

- 原子计数器记录已占用的 spawn 名额；
- 互斥保护的表记录 `AgentPath -> AgentMetadata`。

`AgentMetadata` 中包含线程 ID、规范路径、昵称和角色。V2 的规范路径形如：

```text
/root
/root/parser
/root/parser/fixtures
/root/security
```

相对路径便于同一子树内寻址，规范路径消除重名歧义。

创建 Agent 之前，`reserve_spawn_slot` 先返回一个 `SpawnReservation`。这是一种 RAII 事务模式：

```text
检查上限 → 预占计数 → 创建 Thread → 注册元数据 → commit
                         └─ 任一步失败：Drop 自动归还名额
```

如果只在创建成功后增加计数，并发请求会同时越过上限；如果预占后失败却不归还，容量会永久泄漏。预留对象把两种竞态一起封住。

## 4. `spawn_agent` 的真实创建链

模型看到的是工具定义，首先由 [`tools/handlers/multi_agents_spec.rs`](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/core/src/tools/handlers/multi_agents_spec.rs) 构造；V2 handler 位于 [`tools/handlers/multi_agents_v2/spawn.rs`](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/core/src/tools/handlers/multi_agents_v2/spawn.rs)。调用最终进入 [`agent/control/spawn.rs`](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/core/src/agent/control/spawn.rs) 的 `spawn_agent_internal`。

主线可以压缩成九步：

1. 从 `ThreadManagerState` 解析当前启用的多 Agent 版本；
2. 校验执行并发、树深度和线程总量；
3. 为 V2 resident Agent 或普通 Agent 预留容量；
4. 继承当前环境选择和 exec policy；
5. 解析角色配置，并保留调用时的审批与权限边界；
6. 选择新历史或 fork 历史；
7. 用同一个 `AgentControl` 创建子 Thread；
8. 提交初始任务或 `InterAgentCommunication`；
9. 成功后提交 registry reservation，并发出子会话开始事件。

步骤 5 很重要。角色可以改变模型、推理强度或说明，但不应暗中扩大父任务当前的审批与文件权限。安全属性属于运行时边界，不能因为换了“研究员”或“实现者”角色就消失。

### 新上下文与 fork 上下文

创建子 Agent 有两个有本质差异的选择：

- fresh：只给明确任务和必要上下文，成本低、干扰少；
- fork：继承父线程完整历史或最近 N 个 Turn，适合高度依赖前文的子任务。

fork 并不是复制内存向量。实现会先确保父 rollout 已刷新，再从可证明安全的模型上下文边界加载历史，截断最近 N 个 Turn 时还要清理父线程专属的 usage hint。第 14 章会进一步解释持久化谱系。

经验法则是：能用 10 行任务说明讲清楚，就优先 fresh；只有子任务必须理解大量前情时才 fork。上下文越多，成本、缓存压力和错误关联也越大。

## 5. 消息工具不是同一个操作的别名

V2 暴露的协作工具各有生命周期语义：

| 工具 | 主要语义 |
| --- | --- |
| `spawn_agent` | 创建新 Thread，并启动第一个 Turn |
| `send_message` | 向已存在 Agent 发送信息；可不触发新一轮工作 |
| `followup_task` | 投递后续任务；目标空闲时会触发 Turn |
| `interrupt_agent` | 中断目标当前 Turn，但保留 Agent |
| `list_agents` | 读取当前树中的 Agent 和状态 |
| `wait_agent` | 等待邮箱或状态变化，不创造业务工作 |

[`message_tool.rs`](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/core/src/tools/handlers/multi_agents_v2/message_tool.rs) 让 `send_message` 与 `followup_task` 共享提交路径，但通过“是否触发 Turn”区分语义。底层会构造 `Op::InterAgentCommunication`，因此消息也进入 Session 的操作队列，而不是旁路修改另一个 Agent 的内存。

这带来两个好处：

- 与普通输入一样经过串行 Session 边界，避免并发写状态；
- 可把协作通信作为有类型的 rollout item 保留下来，便于恢复和审计。

## 6. 状态不是轮询出来的，而是由事件归约

[`core/src/agent/status.rs`](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/core/src/agent/status.rs) 把线程事件归约为 Agent 状态：

```text
TurnStarted       → Running
TurnComplete      → Completed(last_agent_message)
TurnAbort(Interrupted | BudgetLimited) → Interrupted
其他 TurnAbort    → Errored(reason)
Error             → Errored(message)
ShutdownComplete  → Shutdown
```

`Interrupted` 不是最终状态：同一个 Agent 仍可收到 follow-up 并继续。`is_final` 把 `PendingInit`、`Running`、`Interrupted` 以外的状态都视为最终态，因此除 `Completed`、`Errored`、`Shutdown` 外，查询不到目标时使用的 `NotFound` 也会让等待结束；但它是失败/缺失哨兵，不表示任务成功。这也解释了为什么等待逻辑不能只判断“当前没有输出”，而要订阅状态变化。

## 7. 三种资源限制要分开看

多 Agent 至少有三种不同的上限：

1. spawn 数量：整棵树能登记多少子线程；
2. execution 数量：同一时刻能运行多少 Agent Turn；
3. rollout budget：整棵树最多消耗多少 token。

此外还有 spawn depth，防止 Agent 无限递归地产生后代。数量上限控制内存和句柄，执行上限控制瞬时 CPU/网络竞争，token 预算控制模型成本；三者不能用一个整数替代。

一个常见错误是“达到并发上限就多试几次”。如果限制来自配置，重试只会制造噪声。正确做法是等待已有 Agent 完成、关闭不再需要的 Agent，或回到串行执行。

## 8. Goal：比计划表更强的持久状态机

“计划”通常只描述当前 Turn 的步骤；Goal 则是和 Thread 绑定的持久对象。协议类型在 [`app-server-protocol/src/protocol/v2/thread.rs`](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/app-server-protocol/src/protocol/v2/thread.rs)：

```text
ThreadGoal
├─ threadId
├─ objective
├─ status
├─ tokenBudget
├─ tokensUsed
├─ timeUsedSeconds
├─ createdAt
└─ updatedAt
```

状态机包含：

```text
Active ──用户暂停──> Paused
   │
   ├──真实阻塞────> Blocked
   ├──账户限制────> UsageLimited
   ├──预算耗尽────> BudgetLimited
   └──任务完成────> Complete
```

并非所有状态都能由模型设置。[`ext/goal/src/spec.rs`](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/ext/goal/src/spec.rs) 让模型的 `update_goal` 只接受 `complete` 或 `blocked`；暂停、恢复、用量限制和预算限制由用户或系统控制。这是权限最小化：模型可以报告任务事实，不能伪造计费或用户控制状态。

另一个重要约束是：普通一次性请求不应自动创建 Goal。`create_goal` 的工具说明要求只有用户或系统明确请求时才创建；token budget 也只有明确要求时才设置。

## 9. Goal 为什么能自动续跑

Goal 被实现为扩展，而不是塞进巨大的 core 分支。入口是 [`ext/goal/src/extension.rs`](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/ext/goal/src/extension.rs)，它订阅线程、Turn、工具和 token usage 生命周期。

线程空闲时，[`GoalRuntimeHandle::continue_if_idle`](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/ext/goal/src/runtime.rs) 依次检查：

1. 当前线程是否允许看到 Goal 工具；
2. 是否存在 continuation deferral；
3. ThreadManager 和实时 Thread 是否仍存在；
4. 持久目标是否仍为 `Active`；
5. 线程是否确实处于可启动 Turn 的空闲状态。

条件满足后，它注入一个 continuation steering item，再调用 `try_start_turn_if_idle`。外部 set/clear 与自动续跑共用互斥许可，避免出现“刚暂停目标，却又根据旧快照启动一轮”的 TOCTOU 竞态。

Goal 状态保存在 state 数据库中；运行时只持有活跃 accounting 和控制句柄。恢复 Thread 时，扩展重新读取持久目标并恢复运行态。这和“把一个 Tokio task 永远挂在内存里”完全不同。

## 10. Goal 与多 Agent 怎样组合

两者可以组合，但要明确责任：

```text
持久 Goal：完成跨平台路径类型迁移
  ├─ 当前 Turn：扫描 API 表面
  │   ├─ Agent A：core 路径类型
  │   ├─ Agent B：app-server wire 类型
  │   └─ Agent C：Windows 测试
  ├─ 汇总、实现、测试
  └─ 未完成且仍 Active：空闲后启动下一 Goal Turn
```

Goal 的 token 统计覆盖连续 Turn；多 Agent 的 rollout budget 覆盖协作树。它们代表不同计量边界，不应把某个子 Agent 的完成误判成整个 Goal 完成。

## 11. 动手实验：先测试状态，再测试并行

不要在真实工作目录中故意制造冲突。先从已有测试理解不变量：

```bash
cd <project-root>/codex-rs

just test -p codex-core \
  commit_holds_slot_until_release

just test -p codex-core \
  multi_agent_v2_list_agents_returns_completed_status

just test -p codex-core \
  spawn_agent_releases_slot_after_shutdown

just test -p codex-goal-extension \
  budget_limited_goal_keeps_accruing_until_turn_stop
```

若过滤名因后续版本调整而未匹配，先用 `rg` 在对应 `*_tests.rs` 中确认当前名称，再保持使用 `just test`。

接着做一个纸面编排练习：选一个只读问题，把它拆为三个输出互不重叠的 Agent 任务，为每个任务写出“输入、不得修改的范围、输出格式、完成条件”，最后画出汇合点。若无法写出明确完成条件，说明任务还没有拆好。

## 12. 常见误区

- “子 Agent 是一个轻量函数调用”：它其实是有自己 `ThreadId`、事件和持久化语义的 Session。
- “fork 越完整越好”：历史越大，成本和干扰越高；fresh 通常更可控。
- “发消息一定会启动工作”：`send_message` 与 `followup_task` 的触发语义不同。
- “中断就是删除”：interrupt 结束当前 Turn，Agent 仍可继续。
- “达到限制后不断重试”：配置上限不会因忙等而消失。
- “Active Goal 会无条件死循环”：续跑要经过空闲、状态、能力和 deferral 检查，终止状态会清除活跃 accounting。
- “模型能随意暂停或改预算”：模型工具只暴露受限的状态迁移。

## 13. 本章自测

1. 为什么 `AgentControl.manager` 使用 `Weak`，而 registry 使用共享 `Arc`？
2. spawn reservation 如何同时防止并发越限和失败后的容量泄漏？
3. fresh spawn 与 fork spawn 的成本和适用场景分别是什么？
4. 为什么 `Interrupted` 不是最终 Agent 状态？
5. spawn、execution、depth 和 token budget 各自限制什么？
6. 为什么 Goal 不能由模型在普通任务中自行创建？
7. Goal 自动续跑如何避免与外部 pause/clear 发生竞态？
8. 一个子 Agent 完成，为什么不代表整个持久 Goal 已完成？

能从 `spawn_agent` 的工具调用一路追到 reservation、Thread 创建、事件归约，并能从 `thread/goal/set` 追到持久状态和 idle continuation，你就已经掌握了 Codex 的协作控制面。
