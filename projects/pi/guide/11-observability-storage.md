# 11｜可观测性与存储：Telemetry 抽象和 SQLite 后端

当前仓库不只有早期文档中的 ai/agent/tui/coding-agent 四包。telemetry 与可替换 session backend 展示了项目正在把“运行诊断”和“持久化能力”进一步模块化。

## 1. Telemetry 不是日志的同义词

[`packages/telemetry`](https://github.com/earendil-works/pi/tree/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/telemetry) 定义 vendor-neutral 的：

- span：有开始和结束的一次操作；
- parent/child：操作嵌套；
- attribute：描述操作的键值；
- event：span 内某个瞬时事件；
- status：ok/error；
- context：新 span 应挂在哪个父节点下。

例子：

    agent.prompt                         span
    ├─ model.stream                     child span
    │  ├─ event: retry.scheduled
    │  └─ attributes: provider, model
    └─ tool.execute                     child span
       └─ attributes: tool.name, success

Telemetry 是诊断数据，不是业务权威状态。即使 exporter 失败，也不能令模型调用或工具行为改变。

## 2. 为什么显式传 TelemetryContext

API 采用 callback：

    return telemetry.startSpan(
      {
        name: "example.read",
        attributes: { "resource.path": path },
      },
      async (span) => {
        const value = await read(path);
        span.setAttributes({ "resource.size": value.length });
        return value;
      },
    );

子操作显式使用 callback 获得的 span：

    parent.startSpan({ name: "example.child" }, child => work(child));

优点：

- 父子关系从参数可见；
- 不依赖全局“当前 span”状态；
- 并发异步任务不容易串错上下文；
- 测试可以直接注入内存实现；
- 核心包不绑定 OpenTelemetry、Sentry 或某家服务。

适配器内部仍可激活后端的 ambient context，但 Pi 自身的语义以显式参数为准。

## 3. callback-scoped 生命周期

公开 API 没有让业务代码手工调用 `end()`。`startSpan` 拥有 span 生命周期：

- 同步调用 callback，且只调用一次；
- callback 返回 Promise 时等待 settled；
- 正常完成默认 ok；
- throw/reject 默认 error；
- 显式 `setStatus` 可描述“正常返回但业务失败”；
- settled 后的记录调用无效；
- 记录后端报错必须被抑制，不能污染业务结果。

这避免早 return 或异常时漏掉 end，也定义了适配器必须通过的可观察契约。

## 4. NOOP 与 InMemory

### NOOP_TELEMETRY_CONTEXT

默认关闭 telemetry 时使用。它仍按正确时序执行 callback 并保留返回/拒绝值，只是不记录任何内容。

业务代码无需写：

    if (telemetryEnabled) { ... } else { ... }

始终调用 context 即可。

### InMemoryTelemetryContext

用于测试和本地诊断：

- 记录确定性 span ID 和 parent ID；
- 保存合并后的 attributes、按序 events 和最终状态；
- 返回 detached snapshots；
- 不记录时间戳，减少测试不确定性；
- 存储无界且仅在进程内，不适合长期生产收集。

测试可断言：

    const spans = telemetry.getSpans();
    assert.equal(spans[0].name, "agent.prompt");
    assert.equal(spans[1].parentId, spans[0].id);

## 5. Telemetry 适配器契约

自定义 OpenTelemetry/Sentry 适配器必须保证：

- callback 同步准入且只调用一次；
- 返回值和 rejection identity 不被改变；
- Promise settled 前 native span 保持打开；
- 多次 status 最后一次生效；
- attributes 合并，undefined 不覆盖；
- recording API 同步、被动、不抛错；
- backend 记录失败原子忽略；
- 并发 parentage 正确。

包提供 adapter conformance suite。不要只测“成功时产生一个 span”，异常、同步 throw、并发和后端失败才是适配器最易出错的部分。

## 6. Typed telemetry schema

底层 API 接受开放的名称和属性，便于适配各种后端；领域包可以用 `defineTelemetrySchema` 定义闭合 Schema：

- span 名称；
- 允许的 parent；
- start/end attributes；
- event 名称和属性；
- 默认/错误状态语义；
- schema 版本和说明。

`createTypedSpanStarter` 从 Schema 推导 TypeScript overload，阻止拼错属性名或给某 span 使用别的 span 属性。

类型只能约束本地代码。export 前仍要确保值可序列化，并在边界做大小与敏感性控制。

## 7. Telemetry 的隐私边界

不要默认记录：

- prompt 或 assistant 全文；
- 工具完整输入输出；
- 文件内容和绝对路径；
- API key、认证 headers；
- 用户标识和会话路径；
- 未清洗的异常对象。

优先记录低基数、可诊断的元数据，例如 Provider、模型 ID、stopReason、耗时、token 数、工具名、成功与否。

Telemetry adapter 失败必须不影响业务，不代表“可忽略数据治理”。日志/trace exporter 仍可能把数据发送到外部。

## 8. SQLite session backend

目录：[`packages/session-backends/sqlite-node`](https://github.com/earendil-works/pi/tree/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/session-backends/sqlite-node)

它使用 Node 的 `node:sqlite`，提供：

- SQLite database adapter；
- session repository；
- migrations；
- materialized views；
- 可选全文检索 FTS；
- agent session backend 接口的持久化实现。

典型用法：

    await using repository = new SqliteSessionRepository(options);
    const search = createSqliteSessionSearch(options);
    const session = await repository.create({ cwd });
    await session.appendMessage(message);

    for await (const hit of search.search("needle")) {
      consume(hit);
    }

repository 与 search 是独立服务，但可指向同一个 canonical database。这样主仓储接口不被搜索特有能力污染。

## 9. FTS 的延迟创建

README 描述的策略：

1. 首次非空搜索时才创建 FTS 表和 trigger；
2. 第一次创建后，从 canonical entries 做一次 rebuild；
3. 以后由 SQLite trigger 随插入、删除、payload 更新保持同步。

优点：

- 不使用搜索的应用不付 FTS 初始化成本；
- canonical tables 仍是权威来源；
- FTS 是可重建索引，不是唯一数据副本。

设计原则：派生索引坏了应能从权威数据重建。

## 10. 事务语义

SQLite adapter 使用明确事务边界，并以 `BEGIN IMMEDIATE` 一类策略尽早获取写意图，减少操作进行到一半才发现写锁冲突。

事务 callback 不应返回未等待的异步工作。若 adapter 明确拒绝 async callback，是为了防止：

    begin
    callback 返回 Promise
    adapter 误以为完成并 commit
    Promise 之后才继续写

任何数据库抽象都应明确 callback 能否 async，以及 commit/rollback 与 Promise settled 的关系。

## 11. JSONL 与 SQLite 如何比较

| 维度 | JSONL SessionManager | SQLite backend |
| --- | --- | --- |
| 人工检查 | 直接打开很方便 | 需要查询工具 |
| 追加历史 | 自然 | 用表和事务模拟 |
| 树查询 | 内存建索引 | SQL 索引/递归查询 |
| 搜索 | 需扫描或额外索引 | FTS 方便 |
| 并发写 | 文件级策略较简单 | 数据库锁与事务 |
| 迁移 | 按文件版本处理 | schema migrations |
| 可移植性 | 单文件易复制 | 单库也可复制但需一致性 |

两种后端必须保持相同领域语义：分支、条目顺序、消息关联和恢复结果不能因为存储不同而改变。

## 12. 领域对象与存储记录分离

不要让 Agent loop 直接写 SQL。正确分层：

    Agent/Session domain operation
      → session backend interface
      → repository mapping
      → transaction/database

映射层负责：

- ID 与父子关系；
- JSON payload 编解码；
- schema/version 迁移；
- 数据库错误转为领域错误；
- 原子性；
- 搜索索引更新。

## 13. 动手练习

### 练习 A：Telemetry 树

用 InMemory 实现：

    prompt
      ├─ model.stream
      └─ tool.execute

让 tool 抛错但 prompt 捕获并返回失败结果。断言 tool span error、prompt span 按你的业务语义设置状态，且 callback 返回值未改变。

### 练习 B：坏适配器

故意实现一个 recording 时抛错的 adapter，运行 conformance suite，观察哪些契约失败。然后让错误被抑制并保证 callback 只执行一次。

### 练习 C：存储一致性

向内存/JSONL/SQLite 后端写入同一分支会话，比较：

- 当前 leaf；
- build context 消息；
- model/thinking 设置；
- custom 与 custom_message；
- 搜索结果。

不要比较数据库内部行形状，而要比较领域可观察结果。
