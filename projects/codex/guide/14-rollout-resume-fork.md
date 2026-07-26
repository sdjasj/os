# 14. Rollout、恢复与分叉：从追加日志重建会话

> 本章对应源码快照 <code>61a44880a85d2fd0d8770908dea5733495e571c8</code>。Rollout 可能包含用户提示、代码、工具输出和环境信息；学习时只用合成数据，绝不要把真实 rollout 放入公开教程或提交到仓库。

## 学习目标

学完本章，你应该能够：

- 区分持久化 rollout、模型上下文和 app-server Thread/Turn/Item 投影；
- 解释 JSONL 追加记录、后台 writer、flush 与恢复语义；
- 理解压缩后为什么可以截断扫描，以及何时必须回扫到开头；
- 区分 resume 与 fork 的 thread identity、历史和写入行为；
- 从 app-server 的恢复参数追到 thread store、core 和 recorder。

## 1. 先补背景：事件日志不是聊天消息数组

最简单的聊天程序会把历史保存成一个 JSON 数组，每次追加都重写整个文件。Codex 的会话更复杂：消息、工具调用、审批、world state、压缩替代项和 turn context 都要保持顺序与可审计性。因此使用 append-only JSONL（每行一个 JSON 对象）作为 durable rollout。

追加日志的优势：

- 写入新项不必重写全部历史；
- 崩溃时通常只需处理末尾未完成写入；
- 可以保留模型响应、状态转换和跨 agent 通信的时间顺序；
- resume 和 fork 可以共享统一的历史重建语义。

代价是“当前状态”不再直接存在于某一行，需要扫描或索引重建。

## 2. 三种视图必须分开

~~~text
Durable rollout（事实日志）
  JSONL：SessionMeta、ResponseItem、TurnContext、Compacted、WorldState...
       │
       ├─ 重建模型请求
       ▼
Model-visible context（推理视图）
  受压缩、回滚、边界和 token 预算影响
       │
       └─ 投影给客户端
       ▼
Thread / Turn / Item（API/UI 视图）
  支持分页、initialTurnsPage、excludeTurns
~~~

这三者不是可互换的数据结构：

- rollout 是规范性持久记录；
- model context 是某次推理真正发送给模型的、经过选择的历史；
- API projection 是为了 UI 和客户端消费组织的对象。

SQLite 或 session index 可以加速发现与投影，但不应被误认为 JSONL 的逐项同构副本。

## 3. RolloutItem：日志里到底记录什么

[protocol.rs](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/protocol/src/protocol.rs) 定义 <code>SessionMeta</code>、<code>SessionMetaLine</code>、<code>InitialHistory</code> 和 <code>RolloutItem</code>。本快照的主要 item 变体包括：

- <code>SessionMeta</code>：thread ID、来源、cwd、模型/provider 等会话元数据；
- <code>ResponseItem</code>：模型上下文中的消息、函数调用和输出等；
- <code>InterAgentCommunication</code> 及其 metadata；
- <code>Compacted</code>：压缩后的替代历史；
- <code>TurnContext</code>：某 turn 使用的上下文配置；
- <code>WorldState</code>：可增量更新的外部状态；
- <code>EventMsg</code>：事件记录。

简化 JSONL：

~~~json
{"timestamp":"...","type":"session_meta","payload":{"id":"thread-A","cwd":"<project-root>"}}
{"timestamp":"...","type":"turn_context","payload":{"turn_id":"turn-1","model":"example-model"}}
{"timestamp":"...","type":"response_item","payload":{"role":"user","content":"synthetic prompt"}}
{"timestamp":"...","type":"response_item","payload":{"type":"function_call","name":"read_file"}}
{"timestamp":"...","type":"response_item","payload":{"type":"function_call_output","output":"synthetic output"}}
~~~

这只是教学形状，不是可直接发送给当前二进制的完整 schema。精确 serde 标签应看源码和 fixture。

## 4. Recorder：前台产生事件，后台顺序落盘

持久化入口在 [rollout recorder.rs](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/rollout/src/recorder.rs)。<code>RolloutRecorderParams</code> 分为：

- <code>Create</code>：为新 thread 创建 rollout；
- <code>Resume</code>：打开已有 rollout 并继续追加。

<code>RolloutRecorder</code> 通过有界 mpsc 通道把前台记录请求交给后台 writer，暴露的核心操作可归纳为：

~~~rust
let recorder = RolloutRecorder::new(&config, params).await?;
recorder.record_canonical_items(&items).await?;
recorder.persist().await?;
recorder.flush().await?;
let (loaded, thread_id, parse_errors) =
    RolloutRecorder::load_rollout_items(recorder.rollout_path()).await?;
recorder.shutdown().await?;
~~~

这是省略具体类型构造的调用形状：`new` 还要读取实现 `RolloutConfigView` 的配置；`load_rollout_items` 是接收路径的关联函数，并同时返回条目、可选 thread ID 和解析错误数。

这里的语义差异很重要：

- <code>record</code>：把有序项交给 recorder；
- <code>persist</code>：要求持久化某批状态；
- <code>flush</code>：等待此前排队的写入由后台 writer 处理，并完成文件 `flush` barrier；它不等同于 `sync_all`，也不承诺断电后仍已落盘；
- <code>shutdown</code>：完成收尾并停止后台任务。

有界通道提供背压，防止模型或工具事件产生速度长期超过磁盘。writer 遇到写失败会缓冲并尝试恢复，而不是悄悄丢弃后续项。延迟 materialization 则避免一个从未产生有意义内容的 session 立刻制造空文件。

### 4.1 Canonical items 为什么单独命名

不是所有 UI 通知都应进入 durable history。<code>record_canonical_items</code> 强调写入可用于恢复的规范项，而不是把每个瞬时 delta 当作永恒事实。这样 resume 不必重放一切渲染细节。

### 4.2 Session index 是追加索引

[session_index.rs](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/rollout/src/session_index.rs) 管理 <code>session_index.jsonl</code>。同一 session 的名称或元数据可以出现多条，读取时以较新记录为准。这与数据库里的 in-place update 不同：

~~~text
thread-A, name="first"
thread-B, name="other"
thread-A, name="renamed"   ← thread-A 当前名称
~~~

追加索引便于恢复，但也意味着需要定期考虑压缩、损坏行容忍和并发写入语义。

## 5. 从日志重建模型上下文

### 5.1 为什么从后向前扫描

模型只需要当前有效历史，不一定要读取从会话诞生以来每个 token。[model_context.rs](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/rollout/src/model_context.rs) 的 <code>ModelContextScan</code> 从最新项向旧项扫描，寻找一个证明“更早内容已被安全替代”的 cutoff。

安全 cutoff 需要同时满足：

1. 有可用的 compaction replacement 与窗口；
2. 已看到一个完整用户 turn 的边界；
3. 该 turn 的 <code>TurnContext</code> 与恢复语义兼容。

概念算法：

~~~rust
for item in rollout.iter().rev() {
    scan.observe(item);
    if scan.has_usable_compaction()
        && scan.has_completed_user_turn()
        && scan.turn_context_is_compatible()
    {
        break; // 更早内容已由 replacement 覆盖
    }
}
return scan.reconstruct_in_forward_order();
~~~

只看到 <code>Compacted</code> 一项并不足以停止。若 replacement 格式不受支持、缺少完整 turn 边界，或发生 rollback，扫描必须继续到开头，以正确优先于速度。

### 5.2 压缩不是删除

Compaction 把较老上下文总结成有界 replacement，再保留一个最近窗口。它改变的是“之后如何重建模型视图”，而不是伪装过去从未发生。

[compression.rs](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/rollout/src/compression.rs) 还处理压缩 rollout 的 materialization：在对压缩文件继续追加或建立引用前，先获得可稳定访问的实际内容。

### 5.3 Thread store 的本地扫描

[thread-store local model_context.rs](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/thread-store/src/local/model_context.rs) 把扫描接到本地分页读取：

- 普通 rollout 可以反向分页，早停后无需加载整个文件；
- legacy 或压缩格式可能需要完整读取；
- 输出时确保 canonical <code>SessionMeta</code> 位于合适位置。

“API 首屏只取 20 个 turns”与“模型只需最近上下文”是两个不同优化，不能共用一个未经证明的截断点。

## 6. Resume：同一 thread 继续写

core 的入口在 [thread_manager.rs](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/core/src/thread_manager.rs)：

- <code>resume_thread_from_rollout</code>：从持久化文件恢复；
- <code>resume_thread_with_history</code>：从已给定 InitialHistory 恢复；
- 之后 recorder 以 Resume 模式继续同一 thread 的日志。

app-server 的 <code>ThreadResumeParams</code> 位于 [v2/thread.rs](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/app-server-protocol/src/protocol/v2/thread.rs)。对于不在内存中运行的 thread，输入优先关系是：

~~~text
显式 history
  > 非空 path
  > thread id
~~~

对于已在运行的 thread，按 ID resume 更像“重新接入”现有对象，并需要检查 path 一致性和未决审批。通常客户端应优先保存和使用 thread ID；path 是较底层、兼容性更强但也更容易误用的入口。

<code>excludeTurns</code> 和 <code>initialTurnsPage</code> 只优化 API 投影，不表示 durable rollout 或模型上下文被相同方式删除。分页 cursor 面向历史方向时也要遵守 backward pagination 语义。

## 7. Fork：新 thread 继承历史，而不是继续原文件

fork 的核心差异：

| 维度 | Resume | Fork |
|---|---|---|
| Thread ID | 保持不变 | 创建新 ID |
| 后续写入 | 追加原 thread | 写入新 thread |
| 历史 | 恢复原历史 | 复制或引用一个冻结前缀 |
| 语义 | 继续同一会话 | 从历史分支出新会话 |

core 入口是 [fork_thread_with_initial_history](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/core/src/thread_manager.rs)。本地分页 fork 的实现位于 [paginated_fork.rs](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/thread-store/src/local/paginated_fork.rs)，需要处理 lineage 与 frozen prefix。

为什么需要 frozen prefix？假设父 thread 在 fork 同时继续产生事件，如果子 thread 的“继承历史”每次读取都追随父文件末尾，子会话就会神秘吸收分叉后父分支的新事件。冻结边界确保 fork 时刻的历史不再漂移。

fork 还必须尊重 turn 边界。若在未完整工具调用或正在审批的中间状态截断，子 thread 可能得到无法解释的孤立 function output。相关边界辅助位于 [thread_rollout_truncation.rs](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/core/src/thread_rollout_truncation.rs)，并考虑 rollback。

## 8. 冷恢复、运行中重接和未决审批

“resume”至少有两种运行态：

### 冷恢复

进程中没有对应 thread。系统从 ID/path/history 定位 rollout，扫描历史，重建 core session，创建 recorder 并继续。

### 运行中重接

ThreadManager 已持有该 thread。app-server 不应再创建第二个独立 session，而应返回/订阅现有 thread，并正确呈现正在运行的 turn 和 pending approvals。

app-server 编排可从 [thread_lifecycle.rs](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/app-server/src/request_processors/thread_lifecycle.rs) 追踪。这里需要同时协调：

- 请求参数优先级；
- thread store 查找；
- active thread 判断；
- 历史投影；
- turn 与 item 通知；
- 未决审批状态。

因此 resume 不是简单的“读 JSONL 并返回数组”。

## 9. 故障与一致性场景

### 9.1 末尾损坏或写入失败

后台 writer 必须保持已确认项的顺序；flush 成功表示此前命令已经过 writer 的 flush barrier，不应把它解释成 fsync 级掉电持久性。恢复读取需要明确怎样处理末尾不完整行，不能把中间损坏无声跳过后继续拼接。

### 9.2 SessionMeta 与索引不一致

[metadata.rs](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/rollout/src/metadata.rs) 负责从 rollout 提取和协调 metadata/SQLite 状态。索引缺失时，canonical log 仍是重要恢复来源；索引内容也要与 SessionMeta 的 thread identity 核对。

### 9.3 回滚之后的上下文

回滚会让“文件末尾最新项”与“当前有效历史”不同。扫描和 truncation 必须识别 rollback 边界，不能只按字节偏移切片。

### 9.4 不兼容的 TurnContext

历史中的模型、权限或上下文设置可能与当前恢复条件不同。安全 scan 要么找到可证明兼容的 cutoff，要么保守回扫；不能为了提速假装兼容。

## 10. 动手实验

### 实验 A：只用合成 JSONL 理解追加

在临时目录创建一个只含虚构文本和虚构路径的最小 rollout fixture。依次追加 SessionMeta、TurnContext、用户项、助手项，观察：

1. 行顺序是否保留；
2. 最后一行截断时读取器如何处理；
3. session index 同 ID 多次命名时谁获胜。

不要复制个人 sessions 目录中的真实文件。

### 实验 B：运行 recorder 测试

~~~bash
cd codex-rs
just test -p codex-rollout
~~~

结合 [recorder.rs tests](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/rollout/src/recorder.rs) 的测试模块，重点观察 deferred materialization、flush、resume 和写失败后的行为。

### 实验 C：给 ModelContextScan 画时间线

阅读 [rollout model_context.rs](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/rollout/src/model_context.rs) 和 [thread-store model context tests](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/thread-store/src/local/model_context_tests.rs)。为以下序列标出能否早停：

~~~text
旧历史 → Compacted → replacement → 完整 user turn → compatible TurnContext → 新历史
旧历史 → unsupported Compacted → 新历史
旧历史 → Compacted → 半个 tool call → 新历史
旧历史 → Compacted → rollback → 新历史
~~~

先预测，再用测试名和断言校正心智模型。

### 实验 D：比较 resume 与 fork 的 API 行为

阅读 [thread_resume.rs](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/app-server/tests/suite/v2/thread_resume.rs)，记录返回 thread ID、首屏 turns、历史来源和后续写入目标。再找到 fork 测试，验证新 ID 与冻结边界。实验只使用测试 fixture 和模拟响应。

## 11. 常见误区

1. **把 rollout 当聊天文本。** 它还含工具、上下文、世界状态、压缩和跨 agent 事件。
2. **把 SQLite 当唯一真相。** 它是索引/投影加速层，durable JSONL 仍承担恢复语义。
3. **看到 Compacted 就停止向前扫描。** 必须同时证明 replacement、窗口和 turn context 可用。
4. **把 API 分页当模型截断。** 二者面向不同消费者。
5. **认为 resume 会创建新 thread。** resume 维持 identity，fork 才新建分支。
6. **让 fork 持续追随父日志尾部。** 应冻结分叉时刻的历史前缀。
7. **在半个工具调用中间截断。** function call 与 output 必须保持可解释结构。
8. **按 path 重复创建已在运行的 thread。** 先按 ID 检查并重接。
9. **把真实 rollout 用作教程 fixture。** 其中可能包含秘密、源码和私人提示。
10. **调用 record 后立刻假设磁盘已稳定。** 需要理解 persist/flush/shutdown 的保证。

## 12. 自测题

1. durable rollout、model context、API projection 各自服务谁？
2. 为什么 recorder 使用有界后台通道？
3. <code>record</code>、<code>flush</code> 和 <code>shutdown</code> 的保证有什么差异？
4. ModelContextScan 安全早停至少需要哪些证据？
5. unsupported compaction 为什么迫使扫描回到开头？
6. resume 输入同时给 history、path、ID 时，非运行 thread 如何选择？
7. fork 为什么必须生成新 thread ID 和 frozen prefix？
8. <code>initialTurnsPage</code> 会删除 rollout 中较老 turns 吗？
9. 正在运行且有 pending approval 的 thread 被新连接 resume 时，应避免什么？
10. session index 同 ID 多次出现时，为什么采用较新记录？

能从一个 <code>thread/resume</code> 请求一路解释到定位、反向扫描、上下文重建、活动会话重接和 recorder 续写，就掌握了 Codex 会话持久化的主干。
