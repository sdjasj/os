# 10：SQLite 状态模型

OpenClaw 把自己的运行时状态放入 SQLite，而不是不断增加 JSON、JSONL 或 sidecar 文件。本章先学所有权，再学 schema、事务和迁移。

## 1. 两类数据库

路径 helper 直接表达所有权：

```text
共享状态库
  <state-root>/state/openclaw.sqlite

每 Agent 状态库
  <state-root>/agents/<agentId>/agent/openclaw-agent.sqlite
```

共享库路径见 [`src/state/openclaw-state-db.paths.ts`](../../../src/state/openclaw-state-db.paths.ts#L33-L40)，每 Agent 路径见 [`src/state/openclaw-agent-db.paths.ts`](../../../src/state/openclaw-agent-db.paths.ts#L21-L33)。

选择标准：

| 状态                                    | 所有者                        |
| --------------------------------------- | ----------------------------- |
| 跨 Agent 的全局 registry/runtime state  | 共享状态库                    |
| 插件的全局 KV                           | 共享状态库中的插件 owner 表面 |
| 只属于一个 Agent 的 session/cache/state | 每 Agent 状态库               |
| 明确的导入导出、附件、日志、备份        | 可以是命名文件 artifact       |
| 临时且可重建的 cache                    | 优先不迁移，删掉后重建        |

“文件写起来更快”不是选择 JSON 的理由。先问数据的 owner、并发、查询、原子性、生命周期和升级需求。

## 2. 测试路径隔离

共享库 path helper 在测试环境使用 worker-scoped 临时目录：

```ts
if (env.VITEST || env.NODE_ENV === "test") {
  // pid + worker id/thread id
  return path.join(os.tmpdir(), "openclaw-test-state", shardSuffix);
}
```

这避免并行 Vitest worker 共享 WAL 文件。测试隔离不是由每个测试作者记得设置临时目录，而是由底层 path owner 给出安全默认值；显式 `OPENCLAW_STATE_DIR` 仍可覆盖用于专门的集成场景。

## 3. Agent id 先规范化再进入路径

每 Agent path helper 调用 `normalizeAgentId`，再构造绝对路径。这有两层意义：

- 相同逻辑 id 映射到一个稳定目录；
- 路径安全和命名语义集中在 session/routing 规范化 owner。

但“normalize 过”不等于所有任意输入都可安全做路径。调用者仍应先通过相应协议/config schema，且 path owner 需要测试 traversal 和保留值。

## 4. Schema contract 与版本

共享和每 Agent 数据库各自有 schema contract：

- `src/state/openclaw-state-db-contract.ts`
- `src/state/openclaw-agent-db-contract.ts`

`package.json#openclaw.schemaVersions` 记录发布/工具链可见的版本。本快照共享库版本为 6，每 Agent 库版本为 16。

schema version 不是“改了 SQL 就顺手 +1”。版本提升意味着旧 reader 可能不再容忍新形态，需要明确讨论和升级策略。

纯新增表若旧版本仍能运行，只是看不到新功能，通常采用：

1. 在 canonical schema 声明；
2. 首次使用时执行一次幂等 lazy ensure；
3. 下一次自然 schema bump 时折叠进正式 migration；
4. 当前改动不提高 schema version。

是否兼容旧 reader 是判断核心，不是 diff 大小。

## 5. 打开数据库不是一个构造函数调用

[`src/state/openclaw-state-db.ts`](../../../src/state/openclaw-state-db.ts) 的 `openOpenClawStateDatabase` 负责：

- 按路径复用进程内 handle；
- 创建父目录；
- 打开 `node:sqlite`；
- 应用 pragmas；
- 做 integrity/quarantine 处理；
- 确保 schema 与 migration；
- 建立 Kysely facade；
- 暴露有所有权的 close/lifecycle。

每 Agent 库在 `src/state/openclaw-agent-db.ts` 使用相似但独立的 contract，并验证 agent owner。

阅读数据库入口时，不要只看成功返回值。至少列出：

```text
open 前的路径准备
bootstrap / integrity
schema ensure
缓存 key
并发 open
失败清理
close 后缓存移除
```

## 6. Kysely 作为类型化查询 facade

[`src/infra/kysely-sync.ts`](../../../src/infra/kysely-sync.ts) 把 Kysely 的 query compiler 与同步 `DatabaseSync` 执行结合。目标是让一般 runtime 查询拥有表/字段类型，而不是散落字符串 SQL。

概念上：

```ts
const query = db.selectFrom("some_table").select(["id", "status"]).where("id", "=", id);

const compiled = query.compile();
const row = sqlite.prepare(compiled.sql).get(...compiled.parameters);
```

具体 helper 封装了参数绑定和结果映射。原始 SQL 保留给 DDL、migration、底层 bootstrap 或 SQLite 特有 primitive；业务读写不应为了少写几行绕过类型表面。

## 7. 写事务必须同步

[`src/infra/sqlite-transaction.ts`](../../../src/infra/sqlite-transaction.ts#L35-L45) 显式检查事务回调返回值：

```ts
function assertSyncTransactionResult(value: unknown): void {
  if (isPromiseLike(value)) {
    throw new Error(
      "SQLite write transactions must be synchronous; Promise returns are not supported.",
    );
  }
}
```

原因不是 JavaScript 风格偏好，而是锁持有时间和一致性。错误示例：

```ts
await transaction(async () => {
  const decision = await pluginHook(); // 锁期间执行未知网络/插件工作
  write(decision);
});
```

正确形状：

```ts
const planned = await planOutsideTransaction();

transaction(() => {
  const current = rereadAuthoritativeRows();
  validateStillApplicable(current, planned);
  commitWrites(planned);
});
```

异步规划完成后，事务内仍要重新读权威行。否则从规划到 commit 之间的并发更新会让旧决策覆盖新状态。

## 8. nested transaction 与 savepoint

transaction helper 用 `WeakMap<DatabaseSync, number>` 跟踪深度。最外层事务使用 `BEGIN`/`COMMIT`，内层通过唯一 savepoint 表达局部回滚。

```text
BEGIN IMMEDIATE
  write A
  SAVEPOINT openclaw_tx_1
    write B
  RELEASE openclaw_tx_1
COMMIT
```

如果内层失败，可以 rollback to savepoint；外层 owner 再决定是否继续或整体回滚。savepoint 名只用于当前进程协调，数据库对象作为 WeakMap key，handle 被回收时不会永久保留元数据。

## 9. lock、busy timeout 与可观测性

SQLite 并发写可能得到 `SQLITE_BUSY` 或 `SQLITE_LOCKED`。helper 同时检查 Node 的字符串 `code` 和扩展数值 `errcode` 低字节，兼容底层错误表示。

它还分别记录：

- 获取 begin/commit 锁等待过慢；
- 事务持锁总时间过长。

这两类指标不能混为一谈：前者说明竞争，后者说明当前 transaction callback 做得太多。日志包含 database/operation label、耗时和 pid，便于定位 owner。

## 10. `BEGIN IMMEDIATE` 的直觉

deferred transaction 可能先读，真正写时才竞争锁；immediate 在开始时就请求写 reservation。OpenClaw 的共享状态写 helper倾向 immediate，使竞争更早、更可预测地暴露。

这不代表所有数据库操作都要 immediate。选择取决于读写模式和 owner contract；不要脱离现有 helper 自行拼接事务 SQL。

## 11. migration 与 runtime 的边界

持久状态遵循“一次迁移 owner”：

```text
旧 store / 旧 schema
  -> doctor 或 migration 读取
  -> 验证
  -> 写入 canonical SQLite
  -> runtime 只读写 canonical store
```

不应形成：

```text
runtime 先读 SQLite
  -> 没有就读旧 JSON
  -> 两边双写
  -> SQLite 错了再回退 JSON
```

后者让每个请求永久承担升级债务，还会制造两个权威来源。对可重建 cache，更简单：删除旧 cache，让当前 runtime 重建，不需要 compat import。

## 12. 设计一个新状态表的检查清单

在写代码前回答：

1. 数据属于全局、插件还是某 Agent？
2. 是用户不可丢的持久状态，还是可重建 cache？
3. 查询键和唯一约束是什么？
4. 多进程/多请求会怎样竞争？
5. 写操作能否在同步短事务中完成？
6. 是否只是新增表，旧 reader 能否忽略？
7. lazy ensure 是否幂等？
8. close、清理、保留和导出策略是什么？
9. 是否已有通用表/插件 KV 能承载，避免新 schema？
10. 测试如何证明 rollback、并发和重开持久性？

若答案指向 schema version bump，先与 owner 讨论，不要自动实施。

## 13. 本章练习

### 练习 A：所有权分类

为以下状态选择位置：Telegram polling offset、全局 plugin install registry、某 Agent 的 memory index cache、用户导出的 transcript、短期 HTTP 响应 cache。

验收：每项都说明生命周期、可丢失性和并发需求，不只给路径。

### 练习 B：事务重构

写一个伪代码流程：“调用插件判断是否允许 → 更新任务状态”。先写错误的 async transaction，再改成事务外 plan、事务内 reread/validate/write。

验收：指出两个阶段之间可能发生的竞争，并写出重新验证条件。

### 练习 C：追踪一张真实表

从两个 DB contract 中任选一张表，找到 schema 声明、ensure/migration、读 helper、写 helper、调用者和测试。

验收：画出 owner、主键/唯一约束、写事务和清理生命周期。

## 14. 继续阅读

数据库只是状态底座。模块 7 会把 session/context/memory 映射到具体 owner，模块 11 再讲怎样用临时 DB 和 worker 隔离可靠测试这些行为。
