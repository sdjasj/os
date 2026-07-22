# 第 14 章：数据库——从 WAL 到 ACID

> 对应讲义：[第 27 讲](../sources/notes/lect27.md)，配套实验：[wal_kv.c](../examples/wal_kv.c)

文件系统提供持久字节和目录树，却不直接提供“同时转账两行、崩溃后不多不少”“按条件快速查询百万记录”“多个客户端隔离更新”等语义。数据库是在文件与内存之上构造的专用数据结构、事务协议和查询执行器。

## 14.1 为什么不直接写文件

一个 JSON 文件足以保存小配置，但当需求增长，会立刻遇到：

- 更新一半时断电怎样恢复；
- 多个进程怎样避免覆盖彼此；
- 如何按任意字段查找而不扫描全部；
- schema 怎样演化；
- 操作失败怎样回滚；
- 如何复制、备份并在故障后继续服务。

数据库并非“更高级的文件格式”，而是一套围绕数据 workload 设计的完整运行时。

## 14.2 关系模型把位置变成关系

关系表由 tuple 和 attribute 构成，查询描述“想要哪些关系成立”，而不是手写指针遍历。SQL 执行大致经过：

```text
SQL text → parse/resolve → logical plan → optimize
         → physical plan → operators(scan/join/sort/aggregate)
```

这很像编译器：SQL 是源语言，逻辑计划像 IR，代价模型选择索引扫描、连接顺序和算法，执行器运行物理算子。统计信息不准会导致优化器选择灾难性计划。

索引是额外数据结构：B/B+Tree 适合有序范围与随机更新，hash 适合等值，LSM Tree 让写先顺序进入内存表和日志、后台合并，换取读放大与 compaction 开销。

## 14.3 ACID 要落实成故障语义

- **Atomicity**：事务的修改全发生或全不发生。
- **Consistency**：已提交状态满足应用与数据库声明的不变量；数据库不能凭空知道所有业务规则。
- **Isolation**：并发事务的可观察行为受隔离级别约束。
- **Durability**：系统承诺提交成功后，约定故障模型下结果可恢复。

“ACID 数据库”并不说明具体隔离级别、复制一致性和磁盘故障范围。必须读产品契约：是 read committed、snapshot isolation 还是 serializable？提交是否等待多数副本？磁盘损坏是否在保证范围内？

## 14.4 WAL：先记录承诺，再修改主数据

Write-Ahead Logging 的核心约束：描述修改的日志必须在相应数据页之前稳定。事务提交时先确保持久 commit 记录，恢复再 redo 已提交修改、undo 未提交修改（具体设计可能只 redo）。

配套 [wal_kv.c](../examples/wal_kv.c) 是最小 append-only WAL：

```bash
./examples/wal_kv set /tmp/tutorial.wal color blue
./examples/wal_kv set /tmp/tutorial.wal answer 42
./examples/wal_kv dump /tmp/tutorial.wal
```

每条记录含 magic、键值长度和 checksum：

```text
header(magic, klen, vlen, checksum) | key | value
```

追加后调用 `fsync`。恢复顺序读取，遇到不完整尾部或 checksum 错误就停止，前面的完整记录仍可重放。这展示两个原则：

1. 只 append，避免原地更新一半；
2. 记录必须自描述且可验证，才能识别 torn tail。

它还不是完整数据库：没有事务 ID/commit record、索引、并发控制、checkpoint、删除语义和跨记录原子性。

## 14.5 checkpoint 为什么必要

如果永远从日志起点恢复，启动会越来越慢。checkpoint 把已确认日志效果合并进主数据，并记录安全截断点：

```text
WAL: [old committed] [checkpoint] [new committed] [active]
       可回收/归档                    恢复只需关注这里
```

创建 checkpoint 时还有事务在运行，因此数据库常用 LSN 标记页和日志进度，而非简单暂停世界。WAL 本身也需轮转、归档与容量控制，否则磁盘耗尽会变成可用性事故。

## 14.6 并发控制：锁与 MVCC

两阶段锁（2PL）通过读写锁实现 serializability，但会阻塞并产生死锁，需要检测/回滚。MVCC 保存多个版本，读事务按 snapshot 选择可见版本，读写冲突减少；代价是版本回收、写写冲突和某些隔离异常。

常见异常：

- dirty read：读到未提交修改；
- non-repeatable read：同一行两次读取不同；
- phantom：同一谓词两次出现不同记录集合；
- write skew：两个事务读到同一快照后修改不同记录，共同破坏跨行约束。

Snapshot isolation 通常防止很多异常，但不自动等于 serializable。业务代码要把不变量转化为数据库能检测的冲突、唯一约束或显式锁。

## 14.7 SQLite、Redis 与分布式数据库

- SQLite 把完整关系数据库做成进程内库，单文件、部署简单，适合本地和嵌入式 workload；并发写受其锁/WAL 模式约束。
- Redis 以内存数据结构和单线程命令执行简化并发语义，持久化、复制与集群有各自权衡。
- NoSQL 放弃统一关系模型，针对 key-value、文档、列族、图等访问模式优化。
- NewSQL 尝试同时提供关系/事务语义与横向扩展，需要分布式共识、时间戳和数据分片。
- Vector database 针对近似最近邻和向量过滤建立特殊索引，仍需处理元数据、更新、一致性和持久化。

没有“类型更先进所以一定更快”；应从查询、更新、规模、故障和一致性需求反推系统。

## 14.8 数据库与文件系统的契约

数据库会管理自己的 page cache、WAL 和写入顺序，但最终依赖文件系统：

- `pwrite`/`mmap` 修改页；
- `fsync`/`fdatasync` 建立持久边界；
- 原子 rename 安装新 manifest/checkpoint；
- direct I/O 可能绕过页缓存；
- 文件系统/设备必须正确实现 flush 和原子写假设。

双层缓存会浪费内存或造成不可预测回写；direct I/O 减少一层，却把对齐、缓存和调度责任交给数据库。选择取决于引擎设计。

## 14.9 常见误区

- WAL 写完就代表事务已提交：还需要明确 commit record 与 flush 边界。
- checksum 能纠正损坏：通常只能检测，恢复仍需副本或备份。
- 事务自动保证业务一致性：未声明的不变量数据库无从维护。
- MVCC 没有锁所以不会阻塞：写冲突、DDL、版本回收仍会协调。
- 加索引总会加速：索引占空间、降低写入速度，低选择性查询也可能不使用。
- 复制就是备份：错误删除会复制到所有副本；备份需要独立恢复点和故障域。

## 14.10 自测与实验

1. 给 `wal_kv` 加 transaction id、BEGIN/COMMIT，恢复时只输出已提交事务。
2. 截短 `/tmp/tutorial.wal` 的最后几个字节，验证恢复忽略尾部；不要对真实数据做此实验。
3. 用两个账户构造 write skew，分别讨论 snapshot isolation 与 serializable 的结果。
4. B+Tree 和 LSM Tree 分别更偏好怎样的读写 workload？compaction 会怎样影响尾延迟？
5. 设计一次跨机器付款的幂等请求 ID 与去重表，说明重试边界。

下一章讨论数据库与操作系统共同面对的另一类问题：对手会主动寻找边界之外的行为。
