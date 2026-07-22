# 第 27 讲：数据库系统

> 原始讲义：[sources/notes/lect27.md](../../sources/notes/lect27.md)  
> 前一讲：[文件系统实现](26-filesystem-implementation.md) · 后一讲：[计算机安全简介](28-security.md)  

## 0. 本讲定位：文件系统之上，应用究竟想持久化什么？

前几讲完成了从块设备到文件系统的推导：

```text
块设备
  → block/page 的读写
  → inode、目录与文件
  → cache、journaling、fsync 与 crash recovery
  → 一个可持久化的 byte array 名字空间
```

文件系统已经很强，但应用程序通常不想维护“某一段 byte 是什么”。
教务系统想维护的是学生、课程和选课关系；支付系统想维护的是余额与不可抵赖的流水；聊天应用想维护的是会话、消息与时间顺序。

因此，本讲继续向上抽象：

```text
文件系统：有名字、可随机访问、可持久化的字节
                         ↓
数据库：有 schema/约束、事务、并发控制和查询的数据结构
                         ↓
应用：在故障和并发中仍成立的业务不变量
```

这个箭头绝不表示数据库可以绕开文件系统与硬件。
数据库的 WAL、数据页、索引页最终仍是文件或设备上的字节；上一讲讨论的写回、乱序、`fsync` 和 torn write，正是数据库恢复协议的地基。

本讲之后的[第 28 讲：计算机安全简介](28-security.md)会再问：即使数据库能保证事务，谁有权读取、修改或删除其中的数据？数据库账号、行级策略、加密与审计仍需要放进完整的访问控制边界。

---

## 1. 学习目标与问题地图

完成本讲后，你应当能够：

1. 解释应用为什么本质上在维护可持久化数据结构，以及普通文件何时已经足够；
2. 分析 “Everything is a File” 的工具友好性、并发、schema、索引和 crash-consistency 代价；
3. 说明把 C 指针直接 `mmap` 到文件为何脆弱，以及 offset、allocator、flush 与 WAL 各解决什么问题；
4. 从“对象和指针”推导 relation、key、foreign key、join 与 declarative query；
5. 准确区分 ACID 四个字母、serializability、snapshot isolation 与 linearizability；
6. 从磁盘 page 推导 buffer/cache、B+ tree、query plan、locking/MVCC、WAL/checkpoint/recovery；
7. 用 SQLite 观察 transaction、WAL 文件、foreign key、`EXPLAIN QUERY PLAN` 和并发快照；
8. 解释大规模系统为何常做功能减法，以及 Redis、NoSQL、NewSQL 的不同取舍；
9. 用一个最小向量检索理解 embedding、metric、exact kNN 与 ANN 的正确性边界。

问题地图如下：

```text
应用数据
├── 直接用目录和文件？
│   ├── 工具/Agent 友好
│   └── 多对象事务、并发、schema、索引都交给应用
├── 直接 mmap C 数据结构？
│   ├── pointer、allocator、版本和地址问题
│   └── flush 不是 atomicity → WAL/recovery
├── 关系数据库？
│   ├── relation + SQL
│   ├── page/cache/index/query optimizer
│   └── ACID + locking/MVCC + WAL
└── 规模继续增大？
    ├── KV/Document/Column：限制接口换可扩展性
    ├── NewSQL：尽量保留 SQL/事务并 scale out
    └── Vector DB：按距离而非等值/顺序检索
```

---

## 2. Review & Comments

### 2.1 持久化：文件系统已经给了我们什么？

在 Linux 的典型本地文件系统中，磁盘上的 superblock、inode、bitmap、extent 和 journal 共同构成一个数据结构。
VFS 把不同实现统一为文件、目录、链接、权限和 descriptor API。

文件系统负责的 crash consistency 主要是它自己的不变量，例如：

- 已分配的 block 不应同时属于两个 inode；
- 目录项引用的 inode 应存在；
- bitmap、inode link count 与目录结构应相容；
- journal replay 后文件系统能够重新挂载。

但“文件系统没有坏”不等于“应用状态正确”。
假设转账程序依次写两个文件：

```text
alice.balance: 100 → 90
bob.balance:    20 → 30
```

掉电可能发生在两次写之间。
两个文件各自都完全合法，目录也完全合法，但钱凭空少了。
文件系统提供的是底层原子操作与持久化原语，不会自动理解“总余额不变”这个业务不变量。

### 2.2 我们总是通过应用访问文件

课件 `.pptx`、作业 `.docx`、电影 `.mp4` 和源码目录看似是“文件”，实际上都由应用解释：

- `.pptx` 是包含 XML、媒体与关系描述的 ZIP package；
- `.mp4` 有 box/atom 结构和索引；
- Git repository 由 objects、refs、index 与规则共同定义；
- `cat` 和 `sort` 本身也是解释 byte stream 的应用。

所以真正的问题不是“还要不要文件”，而是：

> 能否给应用一个比裸 byte array 更合适、同时仍能落到文件系统上的持久数据结构？

---

## 3. 什么是 “应用程序”？

> 软件是物理世界过程在信息世界中的投影。

大学里的学生、课程、选课、成绩和审批，在计算机中变成 record、relation、state transition 与权限检查。
电商里的商品、库存、订单、付款和退款也是如此。

### 3.1 应用天然需要 persistent data

进程退出时，寄存器、栈和普通 heap 消失；但以下事实必须跨进程、重启乃至机器故障继续存在：

- 个人信息和学籍；
- 订单当前处于创建、已支付还是已退款；
- 支付、维护和安全审计日志；
- 多人协作文档的版本与授权；
- 模型、向量与数据来源的版本关系。

“持久”也不是一个布尔值。
至少要问：

1. 进程崩溃后还在吗？
2. 操作系统崩溃后还在吗？
3. 断电、设备 write cache 或介质损坏后还在吗？
4. 单机丢失后，副本是否足以恢复？
5. 已经向客户端回复成功的操作，允许丢多少？

这些问题必须由 storage contract、同步策略、replication 与 backup 一起回答。

### 3.2 本质：数据结构的 CRUD

多数业务可以先粗略写成四类状态变换：

| 操作 | 含义 | 教务系统例子 |
|---|---|---|
| Create | 创建对象/关系 | 新建课程、选课 |
| Read | 读取或查询 | 查看课表、搜索课程 |
| Update | 改变状态 | 修改容量、登记成绩 |
| Delete | 删除或使其不可见 | 退课、撤销错误记录 |

真实应用还需要 validation、authorization、workflow 和 audit。
管理员、教务员、教师与学生看到的对象和允许的 transition 不同。

演示文稿同样是数据结构：slide 是对象，shape 属于 slide，relationship 指向图片或主题。
ISO/IEC 29500 用 XML 等文件表达它，并不妨碍它本质上仍是 CRUD。

这里有一个贯穿全讲的判断：

> 应用 API 操作的是领域对象；持久化层必须把这些操作可靠地编码为有限次 page/byte 更新。

---

## 4. Everything is a File

最直接的方案是把目录树当作数据库：

```text
ehall.nju.edu.cn/teacherJxrwApp/22020230/4
├── enrollment
│   ├── 231220001.md
│   └── 231220002.md
├── syllabus
│   ├── 1-intro.md
│   └── 2-process.md
└── textbook
    └── 1-ostep.md
```

路径承担 key，目录承担 collection，文件内容承担 value。
引用还可以表示成 symlink，例如 `enrollment/231220001/student -> ../../../students/231220001`。

### 4.1 为什么这很有吸引力？

UNIX 工具立即可用：

```bash
find enrollment -type f
rg '^status: accepted$' .
sort records/*.tsv
tar -cf snapshot.tar course/
rsync -a course/ backup/course/
```

文本格式还天然适合版本控制、diff、编辑器和自动化 Agent。
Agent 不必先安装某个专有 SDK，就能列目录、读取局部文件、生成 patch，并把修改交给人审核。

课程主页、小型静态站点、配置仓库和 append-only 评测记录通常非常适合这种设计。
“使用数据库”不是成熟度认证；能用简单文件正确解决的问题，不需要凭空引入常驻服务、迁移与运维。

### 4.2 文件方案的最小约定

即使规模很小，也应定义：

- path/key 如何转义，是否允许用户输入 `/`、`..` 或 symlink；
- 文件格式和版本号；
- 临时文件、原子 `rename` 与目录 `fsync` 的保存协议；
- 单写者还是多写者，锁放在哪里；
- append record 如何定界、校验和恢复；
- 备份是否捕获一致快照，而不是恰好跨越一次更新。

“文件无需 schema”通常只是“schema 没有被机器明确检查”。
字段名、编码、目录布局和命名规则依然构成隐式 schema。

---

## 5. 优点和缺点

### 5.1 Tool friendly 和 agent friendly 的代价

文件系统 API 很通用，因此没有替应用完成这些工作：

| 需求 | 只用普通文件时谁来实现？ |
|---|---|
| 跨多个对象的 all-or-nothing | 应用的 WAL、shadow copy 或 protocol |
| 多进程并发更新 | file lock、版本检查或单写者服务 |
| 字段类型与约束 | parser/validator |
| 按非路径字段查找 | 扫描或额外索引 |
| query optimization | 应用手写 |
| schema evolution | migration code |
| 权限与审计 | filesystem ACL 加应用规则 |

每个小文件还可能带来 inode、目录项、page cache 与 metadata journal 开销。
一次逻辑对象更新可能触发数据页、inode、目录、journal、设备 FTL 等多层写放大。

不过，“性能稍差”不能凭感觉下结论。
大文件顺序扫描可能极快；小型数据放进 SQLite 也可能比遍历几万个小文件更快。
正确方法是按 workload 测量 working set、I/O pattern、tail latency 与故障恢复时间。

### 5.2 小规模系统的合理选择

课堂中的课程提交系统把对象组织为：

```text
/var/www/filerecv/OS2026/M1/<stuid>/
├── 2026-04-04-19-26-43.tar.bz2
└── 2026-04-04-19-26-43.tar.bz2.result
```

提交本身最好不可变；结果可以新建为另一个文件。
统计 Accepted 数量就能组合 glob、`cat`、`grep` 和 `wc`。

PPT 中 “Rejudge M5” 的命令体现了工具组合能力，但直接对真实目录执行批量 `rm` 风险很高。
先预览、限定根目录和类型，再删除：

```bash
find /var/www/filerecv/OS2026/M5 -type f -name '*.result' -print
# 人工确认输出后，才把 -print 换成受控的删除动作。
```

这是一个好架构的例子：append-only 提交、可重建结果、简单路径索引，规模和查询都受控。
当需要“所有院系同时选课、容量不能为负、退课与候补原子联动”时，复杂度才真正逼近数据库。

---

## 6. 一个有趣的 Hack

### 6.1 直接在文件上构建数据结构

ELF、BMP 和文件系统本身都证明：文件可以被解释成带 header、record 和 pointer-like reference 的结构。

```c
struct superblock {
  uint64_t student_table_offset;
  uint64_t course_table_offset;
};

struct student_disk {
  char stuid[16];
  uint64_t first_enrollment_offset;
};
```

磁盘结构中的 “pointer” 更适合存 offset、record id 或 page number，而不是进程虚拟地址。
读取时做：

```text
address = mapping_base + checked_offset
```

并验证 `offset + object_size <= file_size`，防止损坏文件把访问引到映射外。

### 6.2 为什么不能随手把 C struct 原样落盘？

C object layout 还夹带了大量隐含 ABI：

- pointer 宽度和虚拟地址；
- compiler padding 与 alignment；
- CPU endianness；
- `time_t`、enum、bit-field 的表示；
- 软件升级后的字段增删；
- allocator 的 free list 和内部指针；
- 并发线程正在修改到一半的状态。

所以可靠格式通常用固定宽度整数、显式 byte order、magic/version、length、checksum 和边界检查。
“零序列化”省下的代码，往往以 portability、evolution 与 recovery 复杂度偿还。

### 6.3 page 是文件与数据结构之间的工程支点

数据库通常不对每个字段单独做一次系统调用，而把文件划成 page：

```text
database file
┌──────────┬──────────┬──────────┬──────────┐
│ page 0   │ page 1   │ page 2   │ ...      │
│ header   │ records  │ B+ tree  │ freelist │
└──────────┴──────────┴──────────┴──────────┘
```

page 带来几项好处：

1. I/O 与 cache 的管理单位固定；
2. WAL 可以描述“哪个 page 的哪种变化”；
3. slotted page 能在 page 内移动 variable-length record，而外部只引用 slot；
4. checksum、LSN/version 和 free-space metadata 有明确归属；
5. index node 的 fan-out 很高，树高很低。

page size 并非所有系统统一。
SQLite 可配置 database page size；PostgreSQL 的常见默认 block size 是 8 KiB；某些 engines 使用 direct I/O 和自有 buffer pool，另一些更多依赖 OS page cache。

---

## 7. [Memory-mapped 数据结构](/OS/demos/persistence/mmds)

### 7.1 固定地址映射为什么看起来像魔法？

若程序总把文件映射到同一个虚拟地址，并由专用 allocator 在映射区内分配，那么写入文件的 pointer 数值在下次启动后仍可能指向相同位置：

```text
run 1: file offset 0x3000 ↔ VA 0x700000003000
run 2: file offset 0x3000 ↔ VA 0x700000003000
```

于是 `student->course` 看起来既是内存 pointer，也是持久关系。
这正是课堂 demo 想展示的反直觉可能性。

但固定地址可能与 ASLR、shared library、thread stack 或新版本布局冲突；`MAP_FIXED` 还会替换已有 mapping，使用错误会破坏进程。
生产格式更常保存 relative pointer/offset，并在映射后重定位或封装访问。

### 7.2 dirty page write-back 不等于 transaction commit

对 shared mapping 的普通 store 先修改进程可见的 page cache。
内核可以稍后写回；进程崩溃、OS 崩溃和掉电是三个不同边界。

`msync(MS_SYNC)` 可要求同步指定映射范围，但它仍不能让多个 cache line/page 的更新自动变成 all-or-nothing。
保守的持久化协议还要考虑目标文件的 `fdatasync/fsync`、新建/rename 时父目录的 `fsync`，以及平台/VFS/设备对 flush 的承诺。
Linux 具体语义见 [`msync(2)`](https://man7.org/linux/man-pages/man2/msync.2.html) 与 [`fsync(2)`](https://man7.org/linux/man-pages/man2/fsync.2.html)。

反例：

```c
// 反例：两次 store 之间 crash，会破坏总余额不变。
alice->balance -= 10;
bob->balance += 10;
msync(base, length, MS_SYNC);
```

即使最后的 `msync` 成功，crash 若发生在调用前或写回过程中，应用仍需要协议判断旧状态、新状态或恢复动作。

---

## 8. 你甚至可以实现 WAL Log

### 8.1 Write-ahead 的核心不是“多写一份日志”

WAL 的关键偏序是：

```text
log record durable  happens-before  corresponding data page may become durable
commit record durable happens-before reply "committed"
```

一种最小流程是：

1. 给 transaction 分配 id/LSN；
2. 把 redo/undo 或逻辑操作追加到 log；
3. 校验并 flush 必需的 log prefix；
4. 修改内存中的数据页；
5. 写入并 flush commit record；
6. 才向调用者确认成功；
7. 后台 checkpoint，把已覆盖状态推进到较新的稳定点并回收旧 log。

恢复时先识别最后一个完整、可信的 log prefix，再决定 redo 已提交更新、undo 未提交更新，或按该 engine 的协议重建状态。

这只是框架，不是所有数据库都采用相同 record：

- SQLite WAL 追加改变后的 database pages，并以 commit mark 界定 transaction；
- PostgreSQL WAL 记录足以重做 page/data-file 修改的信息，以 LSN 连接 page 与 log；
- ARIES 类系统常用 analysis/redo/undo 与 compensation log record；
- 纯 append-only KV 可以把 command/state log 直接 replay 成内存状态；
- copy-on-write engine 也可能主要依赖新 page 与原子 root 切换。

WAL 不是 backup：盘坏了、误删被正常记录、攻击者加密所有副本，都不能靠同盘 WAL 自动解决。

### 8.2 实验 1：复用 `wal_kv.c`，观察“完整前缀”恢复

仓库提供了[`examples/wal_kv.c`](../../examples/wal_kv.c)。
它把每次 `SET` 编成：

```text
magic | key_length | value_length | checksum | key | value
```

编译并在唯一临时目录运行：

```bash
wal_demo=$(mktemp -d /tmp/lect27-wal.XXXXXX) || exit 1
case "$wal_demo" in /tmp/lect27-wal.*) [ -d "$wal_demo" ] || exit 1 ;; *) exit 1 ;; esac

cc -std=c11 -O2 -g -Wall -Wextra -Wpedantic \
  examples/wal_kv.c -o "$wal_demo/wal-kv"

"$wal_demo/wal-kv" set "$wal_demo/state.wal" alice 100
"$wal_demo/wal-kv" set "$wal_demo/state.wal" bob 20
"$wal_demo/wal-kv" dump "$wal_demo/state.wal"
```

预期：

```text
0: SET alice = 100
1: SET bob = 20
```

现在只破坏复制品的最后两个字节，模拟一个 torn tail：

```bash
cp "$wal_demo/state.wal" "$wal_demo/torn.wal"
size=$(stat -c %s "$wal_demo/torn.wal")
test "$size" -gt 2
truncate -s "$((size - 2))" "$wal_demo/torn.wal"
"$wal_demo/wal-kv" dump "$wal_demo/torn.wal"
```

预期第一条完整 record 被打印，第二条被忽略，并在 stderr 看到：

```text
ignore torn tail after record 1
```

清理前验证前缀：

```bash
case "$wal_demo" in
  /tmp/lect27-wal.*) rm -r -- "$wal_demo" ;;
  *) echo 'refusing unexpected cleanup path' >&2 ;;
esac
```

### 8.3 这个 demo 证明了什么，又没证明什么？

它证明 length + checksum 能从 append-only 文件识别完整前缀，且每次 append 后调用了 `fsync`。
它没有实现完整 transaction manager：

- 一个 record 就是一条操作，没有多-record commit marker；
- header、key、value 分多次 `write`，多个 writer 可能交错；
- native struct layout 与 byte order 不是跨平台稳定格式；
- checksum 检测意外损坏，不抵御恶意伪造；
- 没有 checkpoint、compaction、index 或 snapshot；
- 这里的 `kill -9` 也不能等价模拟突然断电，因为 OS page cache 仍活着。

所以它是 WAL 思想的最小观察器，不是生产数据库。

把 heap 与持久化统一成一层地址空间的思路可追溯到 single-level store；PPT 给出的[相关论文](https://dl.acm.org/doi/10.1145/3477132.3483563)讨论了持久内存时代的重新审视。

---

## 9. 需求：一个非常非常好的数据结构

我们希望这个数据结构同时满足三组要求。

### 9.1 好用

- 能表达对象、关系、集合与约束；
- 查询不要求用户知道磁盘 page 和 pointer 布局；
- schema 与类型错误尽早暴露；
- 多种语言、工具和人都能访问。

### 9.2 性能

- 全校同时选课时不靠一把全局 mutex 串行所有请求；
- 常见 query 不必扫描全部数据；
- hot working set 尽量命中 cache；
- 写入能 batch/group commit，读取能并发；
- 性能退化能通过 plan、metrics 和 trace 解释。

### 9.3 持久化与一致性

- 已确认提交的数据满足明确 durability contract；
- 失败恢复后结构不损坏；
- 批量导入要么全部可见，要么全部不可见；
- 并发执行不能突破课程容量、唯一性、外键等不变量；
- backup/replica 能恢复到一个定义清楚的时间点。

困难不在单项，而在组合：cache 希望延迟写回；并发希望减少冲突；事务希望统一提交点；恢复又需要可重放的顺序证据。

---

## 10. 反思：我们是怎么实现数据结构的？

### 10.1 Pointer machine

只要能反复分配固定大小对象并保存对象之间的关系，就能编码 list、tree、graph 和更复杂结构：

```c
struct node {
  char value[32];
  struct node *left;
  struct node *right;
};
```

pointer 的抽象意义是“对象 A 与对象 B 有关系”。
地址只是 RAM 中一种高效编码。

### 10.2 从 pointer 到 relation

持久/共享系统不应让用户依赖物理地址，于是把关系显式写成稳定 value：

```text
Student(ID=231220001, Name='张三')
TakesCourse(StudentID=231220001, ClassID='OS2026')
Course(ClassID='OS2026', Title='操作系统')
```

`StudentID` 与 `ClassID` 类似可持久化 pointer。
它们可被比较、索引、检查 referential integrity，也能在数据页搬迁后保持含义。

这一步将“怎样沿内存地址走”改成“哪些 tuple 满足某个关系”。
物理组织被隐藏，数据库获得重写和优化空间。

---

## 11. Relational Database (关系型数据库)

Codd 的论文 [*A Relational Model of Data for Large Shared Data Banks*](https://dl.acm.org/doi/10.1145/362384.362685)提出一个出人意料地简单的方向：让用户描述数据之间的逻辑关系，而不必知道机器怎样组织它。

### 11.1 Everything is a table

一个 relation 可先近似理解为同一组 attributes 上的 tuple 集合：

```text
Student(ID, Name, Major)
Course(ClassID, Title, Capacity)
TakesCourse(StudentID, ClassID, Grade)
```

- 一行可表示一个对象或一条关系；
- primary key 标识 tuple；
- foreign key 引用另一个 relation 的 key；
- `CHECK/UNIQUE/NOT NULL` 声明局部不变量；
- transaction 把多个 state transition 组合起来。

### 11.2 数学 relation 不完全等于 SQL table

需要保留几个精确边界：

- 数学 relation 是 set；SQL 默认常采用 bag/multiset 语义，可能有重复行；
- SQL 有 `NULL` 和 three-valued logic；
- 不带 `ORDER BY` 的结果没有承诺顺序；
- table 可以暂时包含多个 physical row version；用户看到的是 visibility rules 过滤后的 logical rows；
- key 不是 C pointer，join 也不是简单解引用。

关系模型是逻辑接口；row store、column store、heap file、B+ tree 与 LSM tree 是可替换的物理实现选择。

---

## 12. 关系数据库模型

PPT 用教务关系图强调“对象和指针”的对应：

![教务系统中的关系模型](../../sources/site_html/static/img/rdbms-jw.jpg)

可把它画成：

```text
Student.ID ───┐
              ├─ TakesCourse.StudentID
Course.ID  ───┘  TakesCourse.ClassID ──→ Course.ID
```

`TakesCourse` 是 many-to-many relationship 的显式对象；它还可以携带 semester、status、grade 等属性。

### 12.1 约束把一部分 correctness 下沉到 DBMS

```sql
CREATE TABLE student (
  id   INTEGER PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE course (
  id       TEXT PRIMARY KEY,
  title    TEXT NOT NULL,
  capacity INTEGER NOT NULL CHECK (capacity >= 0)
);

CREATE TABLE takes_course (
  student_id INTEGER NOT NULL REFERENCES student(id),
  course_id  TEXT NOT NULL REFERENCES course(id),
  UNIQUE(student_id, course_id)
);
```

这能阻止不存在学生的选课和重复 pair，但不能自动证明全部业务语义。
例如“本科生最多选 30 学分”跨多行、依赖时间与身份，可能需要更谨慎的 transaction、trigger 或应用逻辑。

SQLite 的 foreign-key enforcement 还需每个 connection 显式启用 `PRAGMA foreign_keys=ON`；不要只看 schema 就假定它已执行。

---

## 13. 关系数据库查询：指针 “配对”

PPT 查询：

```sql
SELECT Courses.Title
FROM Student
JOIN Takes_Course
  ON Student.ID = Takes_Course.ID
JOIN Courses
  ON Takes_Course.ClassID = Courses.ClassID
WHERE Student.Name LIKE '张%';
```

它表达的是：找到姓名以“张”开头的学生，把 key 相等的 tuple 配对，再投影课程标题。
实际 schema 中关联列应写成类似 `Takes_Course.StudentID`；PPT 的重点是 key pairing，不是列名细节。

![查询沿 key 配对关系](../../sources/site_html/static/img/rdbms-jw.jpg)

### 13.1 logical query 与 physical join

同一个 join 可有多种等价执行方式：

- nested-loop join：外表每行去内表查找；
- index nested-loop：内表关联 key 有 index 时快速 probe；
- hash join：按 equality key 建 hash table；
- merge join：两边按 join key 有序时线性合并。

不是所有 engine 都实现全部算法。
SQLite 主要把 join 实现为 nested scans，并通过 index/automatic index 改善 inner lookup；PostgreSQL 等 server DBMS 还会在 cost model 下选择 hash/merge join。

SQL 用户只声明结果，不指定 page 访问顺序，这给 optimizer 留下了 join reorder、predicate pushdown、index selection 等空间。

---

## 14. 从模型到实现：数据库系统

### 14.1 从一条 query 到磁盘 page

一个典型但非统一的路径是：

```text
SQL text
  → parse / name binding / type checking
  → logical relational plan
  → rewrite + cost-based choices
  → physical operators
  → index/heap access
  → buffer manager / page cache
  → filesystem + WAL files
  → block device
```

其中每层都可以独立优化，也都可能制造 bug。

### 14.2 cache：为什么数据库不每次都 `pread`？

数据库维护 hot pages 的 buffer/cache，并记录：

- page id 到内存 frame 的映射；
- pin/reference 状态，防止正在使用的 page 被淘汰；
- dirty 状态；
- replacement 信息；
- page 对应的 LSN/version。

事务提交通常不要求立刻把所有 dirty data pages 刷回去；只要 WAL 已按协议持久化，recovery 可以 redo。
这叫 no-force 的常见思想。
是否允许未提交 dirty page 写出（steal）、如何 undo，则取决于 engine。

数据库 buffer pool 与 OS page cache 可能形成 double caching；一些 engine 使用 direct I/O 或其他接口减少重复，另一些（包括 SQLite 的常见用法）通过 filesystem/VFS 工作。

### 14.3 index：B+ tree 为什么常见？

B+ tree 的一个 node 恰好组织在 page 中；内部 node 保存 separator key 和 child page id，叶子保存 key 到 row locator/value 的映射，并常有相邻叶链接。

若一个 page 能容纳数百个 child pointer，树高通常很小：

```text
root page
  ├── internal page
  │     ├── leaf page: keys ...
  │     └── leaf page: keys ...
  └── internal page
        └── leaf page: keys ...
```

它支持 equality、range 和 ordered scan。
代价是额外空间、写放大、split/merge 与每次写都维护 index。
复合 index `(a,b)` 对 `a=? AND b=?` 或以 `a` 为前缀的查询有帮助，却通常不能等价替代只按 `b` 的 index。

LSM tree 则把写转成 memtable 与顺序 append，再后台 compaction；它改变了 read/write/space amplification 的平衡，并非“所有物理写从此永远只 append”。

---

## 15. ACID 数据库

### 15.1 四个字母分别承诺什么？

| 属性 | 精确问题 | 常见机制 |
|---|---|---|
| Atomicity | 一个 transaction 的修改是全有还是全无？ | WAL/undo/COW + commit point |
| Consistency | commit 后声明的约束与业务不变量是否成立？ | constraint + 正确 transaction/application |
| Isolation | 并发 transaction 可观察到哪些中间状态？ | locks、MVCC、validation |
| Durability | 已确认 commit 在指定故障模型后是否仍在？ | flush、WAL、replication、stable storage |

Consistency 不是“数据库自动理解业务”。
如果程序把转账金额写错，数据库可以非常可靠地持久化错误。

Durability 也依配置和故障模型而定。
关闭同步、异步 replication 或损坏的 storage flush contract，都可能让“commit 已回复”与“断电后仍在”产生差距。

### 15.2 multi-write transaction

转账必须把检查与两次更新放在同一 transaction：

```text
BEGIN
  read user1.balance
  if balance < amount: ROLLBACK
  update user1.balance -= amount
  update user2.balance += amount
COMMIT
```

若并发 transaction 都先看到相同余额，光有 atomicity 仍不够；还要用适当 isolation、row lock、atomic conditional update 或 serializable validation 防止 write skew/lost update。

### 15.3 serializability、snapshot isolation、linearizability

这三个词不能互换：

- **serializability**：一组已提交 transaction 的效果等价于某种串行顺序；
- **snapshot isolation**：transaction 通常从一个一致 snapshot 读取，写冲突按规则处理，但仍可能出现 write skew；
- **linearizability**：每个 operation 似乎在调用与返回之间某一点瞬时发生，并尊重真实时间先后；
- **strict serializability**：把 transaction 的 serializability 与真实时间约束结合。

许多关系数据库默认不是 Serializable。
例如 PostgreSQL 默认 Read Committed；SQLite 的写入在单 database file 上会串行化，而 WAL mode 的读者获得 snapshot，具体行为不能概括成“所有数据库默认一把大锁的语义”。

分布式系统还要说明 replica read、leader lease、clock 与 network partition 下的 contract。
“ACID”标签本身不能推出跨 region linearizability。

---

## 16. Databases v.s. Compilers

SQL 是 declarative language：用户说“要什么”，engine 决定“怎么做”。
因此数据库实现与 compiler 很像：

| 编译器 | 数据库 |
|---|---|
| source program | SQL text |
| AST / IR | parsed tree / logical plan |
| type/name checking | catalog binding / type checking |
| semantics-preserving optimization | relational rewriting |
| instruction selection | physical operator selection |
| register/cache cost | I/O、CPU、memory、network cost |
| machine code execution | iterator/vectorized/distributed execution |

![SQL 从逻辑计划到物理执行](../../sources/site_html/static/img/sql-exec.jpg)

### 16.1 optimizer 需要统计信息，不会读心

planner 估计 selectivity、row count、page count、cache behavior 和 operator cost，再比较候选计划。
统计信息过旧、字段高度相关、参数分布偏斜或 cost model 不匹配硬件时，计划可能很差。

常见变换包括：

- predicate pushdown；
- constant folding；
- projection pruning；
- join reordering；
- subquery flattening/decorrelation；
- index scan 与 full scan 选择。

`EXPLAIN` 展示计划，不等于实际运行时间；某些系统的 `EXPLAIN ANALYZE` 会真的执行 query，若对象是 DML 还可能产生修改，实验时必须放在 rollback transaction 或只用于 `SELECT`。

课堂推荐的 [CMU 15-445/645](https://15445.courses.cs.cmu.edu/)适合继续深入 storage、execution、optimization 与 concurrency control。

---

## 17. 一个超级复杂的并发程序

### 17.1 数据库管理的是“磁盘上的共享数据结构”

每条 SQL 最终变成对某些 logical item/page/version 的 Read/Write。
同时存在：

- 多个 client transaction；
- buffer eviction 与 background writer；
- checkpoint、vacuum/compaction；
- index split；
- replication sender/applier；
- crash recovery。

任何一个顺序错误都可能是 race、deadlock、durability hole 或 corruption。

### 17.2 2PL：边运行边获取锁

Two-Phase Locking 的经典形状是：

```text
growing phase:   acquire locks, do not release
shrinking phase: release locks, acquire no new lock
```

strict 2PL 常把 exclusive locks 保持到 commit/abort，便于避免其他 transaction 读到未提交值。
因为 transaction 的后续访问集合未必预先知道，engine 只能边执行边加 row/page/range/table lock。

`T1` 先锁 x 再等 y，`T2` 先锁 y 再等 x，就会 deadlock。
系统需要 wait-for graph/timeout/detection，选择 victim rollback；应用也必须准备重试。

phantom 还要求 predicate/range lock 或其他 serializable 技术，单锁已存在的 row 不一定够。

### 17.3 MVCC：保留多个版本

MVCC 更像“给读者一个历史 snapshot”，但“每次开 Git branch”只是直觉比喻：

- row/version 带 creator/deleter transaction metadata；
- snapshot 决定哪些 version visible；
- writer 产生新 version 或更新 page；
- vacuum/garbage collection 清理不再可见的旧 version；
- index 可能暂时指向同一 logical row 的多个 physical version。

MVCC 让 reader 与 writer 少互相阻塞，却不消灭 write-write conflict、schema lock、内存压力或 anomaly。
不同 engine 的 MVCC、undo storage 和 isolation 实现不同。

### 17.4 WAL 与并发控制解决不同问题

```text
locking/MVCC/validation → 谁能看到什么、并发顺序是否合法
WAL/checkpoint/recovery → crash 后如何重建已承诺的状态
```

两者通过 transaction id、commit status 和 LSN 连接，但不能互相替代。
一个完美串行化却不 flush 的数据库会丢 commit；一个完美持久化每次 write 的数据库也可能保存违反隔离的结果。

可扩展阅读：PostgreSQL 官方的 [MVCC 介绍](https://www.postgresql.org/docs/current/mvcc-intro.html)、[transaction isolation](https://www.postgresql.org/docs/current/transaction-iso.html)与 [WAL](https://www.postgresql.org/docs/current/wal-intro.html)。

---

## 18. 例子：SQLite

SQLite 是嵌入进程的 C library，不是必须单独部署的 database server。
应用通过 library 调用操作一个 database file，并获得 SQL、transaction、B-tree、pager、journal/WAL 与 recovery。

![SQLite](../../sources/site_html/static/img/sqlite.svg)

### 18.1 “一个文件”不等于“永远只有一个文件”

主 database 常是一个文件，但运行时可能出现：

- rollback journal：`database-journal`；
- WAL：`database-wal`；
- WAL shared-memory index：`database-shm`；
- temporary file。

不要在 database 正被使用时只复制主文件并漏掉配套状态。
使用 SQLite backup API、合适的 checkpoint/locking 协议或停机一致快照。

### 18.2 实验 2：transaction、约束、WAL 与 query plan

本实验只依赖 Python 标准库 `sqlite3`，在 `/tmp` 中自清理：

```python
#!/usr/bin/env python3
import os
import sqlite3
import tempfile

with tempfile.TemporaryDirectory(prefix="lect27-sqlite-", dir="/tmp") as root:
    path = os.path.join(root, "school.db")
    db = sqlite3.connect(path)
    db.execute("PRAGMA foreign_keys=ON")
    print("journal mode:", db.execute("PRAGMA journal_mode=WAL").fetchone()[0])
    db.execute("PRAGMA synchronous=FULL")
    db.execute("PRAGMA wal_autocheckpoint=0")

    db.executescript("""
      CREATE TABLE student(id INTEGER PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE course(id TEXT PRIMARY KEY, title TEXT NOT NULL);
      CREATE TABLE takes_course(
        student_id INTEGER NOT NULL REFERENCES student(id),
        course_id TEXT NOT NULL REFERENCES course(id)
      );
      INSERT INTO student VALUES (1, '张三'), (2, '李四');
      INSERT INTO course VALUES ('OS', '操作系统'), ('DB', '数据库');
    """)

    try:
        db.execute("BEGIN")
        db.execute("INSERT INTO takes_course VALUES (1, 'OS')")
        db.execute("INSERT INTO takes_course VALUES (999, 'DB')")
        db.commit()
    except sqlite3.IntegrityError as e:
        print("transaction rejected:", e)
        db.rollback()
    print("rows after rollback:",
          db.execute("SELECT count(*) FROM takes_course").fetchone()[0])

    db.execute("BEGIN IMMEDIATE")
    db.execute("INSERT INTO takes_course VALUES (1, 'OS')")
    db.execute("INSERT INTO takes_course VALUES (1, 'DB')")
    db.commit()

    sql = """SELECT course.title
             FROM student
             JOIN takes_course ON student.id=takes_course.student_id
             JOIN course ON course.id=takes_course.course_id
             WHERE student.name LIKE '张%'"""
    print("query result:", db.execute(sql).fetchall())

    probe = "SELECT course_id FROM takes_course WHERE student_id=1"
    print("before index:", db.execute(
        "EXPLAIN QUERY PLAN " + probe).fetchall())
    db.execute("CREATE INDEX takes_by_student "
               "ON takes_course(student_id, course_id)")
    # CREATE INDEX 开启/参与事务；checkpoint 前先结束写事务，
    # 否则同一连接可能因仍持有写事务而等待或返回 busy。
    db.commit()
    print("after index:", db.execute(
        "EXPLAIN QUERY PLAN " + probe).fetchall())

    print("live files:", sorted(os.listdir(root)))
    print("checkpoint:", db.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone())
    db.close()
```

保存为 `/tmp/lect27-sqlite.py` 后运行：

```bash
python3 /tmp/lect27-sqlite.py
rm -f -- /tmp/lect27-sqlite.py
```

应观察到：

- `journal mode: wal`；
- 第二次 insert 违反 foreign key，整个显式 transaction rollback，row count 为 0；
- 合法 transaction 一次提交两条选课，join 返回两门课；
- 建 index 前计划含 `SCAN takes_course`，之后含 `SEARCH ... USING COVERING INDEX`；
- connection 存活时目录通常有 `school.db`、`school.db-wal`、`school.db-shm`；
- checkpoint 返回三元组，具体 frame 数和 plan node 编号会随 SQLite 版本而变，不要硬编码完整文本。

`synchronous=FULL` 明确了本实验想观察的 durability 配置；它仍依赖 OS/VFS/设备正确实现同步承诺。
SQLite 官方资料：[transaction](https://sqlite.org/lang_transaction.html)、[WAL](https://sqlite.org/wal.html)、[atomic commit](https://sqlite.org/atomiccommit.html)、[`EXPLAIN QUERY PLAN`](https://sqlite.org/eqp.html)。

### 18.3 实验 3：WAL snapshot 与 single-writer 边界

下面用两个独立 connection 观察，不需要 thread，也没有时序偶然性：

```python
#!/usr/bin/env python3
import os
import sqlite3
import tempfile

with tempfile.TemporaryDirectory(prefix="lect27-snapshot-", dir="/tmp") as root:
    path = os.path.join(root, "counter.db")
    a = sqlite3.connect(path, isolation_level=None, timeout=0.1)
    b = sqlite3.connect(path, isolation_level=None, timeout=0.1)
    a.execute("PRAGMA journal_mode=WAL")
    a.execute("CREATE TABLE counter(value INTEGER NOT NULL)")
    a.execute("INSERT INTO counter VALUES (0)")

    a.execute("BEGIN")
    print("A snapshot before B:", a.execute(
        "SELECT value FROM counter").fetchone()[0])

    b.execute("BEGIN IMMEDIATE")
    b.execute("UPDATE counter SET value=value+1")
    b.execute("COMMIT")

    print("A same snapshot after B:", a.execute(
        "SELECT value FROM counter").fetchone()[0])
    try:
        a.execute("UPDATE counter SET value=value+1")
    except sqlite3.OperationalError as e:
        print("A cannot upgrade stale snapshot:",
              getattr(e, "sqlite_errorname", type(e).__name__))
    a.execute("ROLLBACK")
    print("A after new transaction:", a.execute(
        "SELECT value FROM counter").fetchone()[0])

    a.execute("BEGIN IMMEDIATE")
    try:
        b.execute("BEGIN IMMEDIATE")
    except sqlite3.OperationalError as e:
        print("second writer:",
              getattr(e, "sqlite_errorname", type(e).__name__))
    a.execute("ROLLBACK")
    a.close()
    b.close()
```

运行方式同上。预期：

```text
A snapshot before B: 0
A same snapshot after B: 0
A cannot upgrade stale snapshot: SQLITE_BUSY_SNAPSHOT
A after new transaction: 1
second writer: SQLITE_BUSY
```

这说明 WAL 允许 writer 提交时旧 reader 继续看历史 snapshot，但同一 database 同时仍只有一个 writer。
错误名在较旧 Python/SQLite binding 上可能只显示 `OperationalError`；语义以 SQLite 官方[隔离说明](https://sqlite.org/isolation.html)为准。

它不证明所有数据库都采用 SQLite 的锁粒度，也不证明跨多个 SQLite database file 有相同原子性。

---

## 19. 实现 “国民级” 的应用

当数据、QPS、地域和团队规模扩大，任意 SQL 的透明实现变得困难。
PPT 的聊天查询是：

```sql
SELECT *
FROM chat_records
WHERE (sender_id = :u1 AND receiver_id = :u2)
   OR (sender_id = :u2 AND receiver_id = :u1)
ORDER BY timestamp DESC
LIMIT 10;
```

逻辑完全正确，但系统要回答：

- 哪个 index 同时覆盖两个 OR branch 和倒序时间？
- 两个用户的数据在哪个 shard？
- hot celebrity account 是否形成热点？
- 跨 region 读允许多旧？
- pagination 遇到新消息插入是否重复/漏项？
- 删除、合规保留、搜索和 backup 如何联动？

### 19.1 数据模型可以主动暴露关键访问路径

例如先计算稳定 `conversation_id = canonical_pair(u1,u2)`，消息 key 变成：

```text
(conversation_id, reverse_timestamp, message_id)
```

这能把 query 和 partition/index 对齐，但付出新的约束：群聊、换号、跨租户、消息编辑与多副本都要重新设计。

“分库分表、读写分离、缓存”不是三个一键开关：

- shard key 决定哪些 transaction/query 变贵；
- replica read 可能读到旧值；
- cache invalidation 需要顺序、版本与失效策略；
- resharding 会移动数据并改变 failure domain；
- 跨 shard transaction 可能需要 distributed commit/consensus。

### 19.2 提供功能就会被使用

自由 query 让开发快，却可能出现没有 index 的全表 scan、巨大 join、N+1 queries、无界 result 或锁住太多行。
这是 capability 与可预测性之间的 systems trade-off，和 `fork()` 一样：强大抽象一旦成为兼容性承诺，就会积累实现和运维成本。

---

## 20. 解决办法：做减法

### 20.1 只支持可 scale out 的访问模式

Key-value API 把查询限制为：

```text
GET(key)
PUT(key, value)
DELETE(key)
```

再按需要增加 list append/range、conditional write、batch 或 secondary index。
应用负责把领域对象映射到 key：

```text
user:{uid}
user:{uid}:like_history
conversation:{cid}:messages
```

功能减少后，系统更容易：

- hash/range partition；
- 把 request 路由到 owner shard；
- 为单 key 定义原子性与 linearization point；
- 对固定 operation 做复制和限流；
- 预测单次请求触碰的数据量。

### 20.2 hash partition 不是分布式系统的终点

`hash(key) % N` 在节点数变化时会搬动大量 key；consistent hashing/range metadata 能改善重平衡，但仍要处理：

- hot key；
- replica placement；
- leader failure 与 membership；
- retry 导致重复写，需要 idempotency key；
- 多 key transaction 是否跨 shard；
- partition 时选择 availability 还是更强 consistency。

“高性能、高可靠就完成了”是 PPT 的抽象跃迁，不是说这些机制免费。

### 20.3 append-only 与 LSM 的边界

LSM-like storage 常把前台随机写先进入 WAL/memtable，再 flush 为有序 immutable runs，后台 compaction 合并。
前台路径更顺序，但 compaction 会读取和重写大量数据；read amplification、write amplification 与 space amplification 之间需要调参。

因此应说“把很多随机写转换为顺序追加和后台整理”，而不是“整个系统所有时刻只追加”。

---

## 21. Redis: Everything is In-memory

Redis 的核心工作集在内存中，提供 String、List、Set、Hash、Sorted Set、Stream 等 data types 与原子 command。
“in-memory”描述主要 serving path，不等于“必然不持久化”。

### 21.1 persistence 是配置选择

Redis 官方提供多种模式：

- RDB：周期性 point-in-time snapshot；
- AOF：记录写 command 并 replay；
- RDB + AOF；
- 完全关闭 persistence，把 Redis 纯粹当可丢 cache。

AOF 的 `appendfsync` 策略决定性能与可能丢失窗口；replication 也不自动等于同步 durability。
详见 Redis 官方[persistence 文档](https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/)。

### 21.2 MULTI/WATCH/EXEC 不是传统数据库 transaction 的复制品

`MULTI` 后 command 被排队，`EXEC` 时顺序执行且中间不插入其他 client command。
`WATCH` 提供 optimistic check-and-set：被观察 key 在 `EXEC` 前改变，则 transaction abort，由 client retry。

但 Redis transaction 没有传统意义的运行时 rollback；`EXEC` 后某条 command 类型错误，不会自动撤销此前已经执行的 command。
cluster 中 multi-key operation 还受 hash slot 等限制。
以官方[transaction 文档](https://redis.io/docs/latest/develop/using-commands/transactions/)为准。

### 21.3 可选实验：启动一个只监听 Unix socket 的临时 Redis

若系统安装了 `redis-server` 与 `redis-cli`，可在无 TCP 端口、无 persistence 的隔离实例观察 `MULTI/EXEC`：

```bash
if command -v redis-server >/dev/null && command -v redis-cli >/dev/null; then
  redis_demo=$(mktemp -d /tmp/lect27-redis.XXXXXX) || exit 1
  case "$redis_demo" in /tmp/lect27-redis.*) [ -d "$redis_demo" ] || exit 1 ;; *) exit 1 ;; esac
  redis_sock="$redis_demo/redis.sock"
  redis-server --port 0 --save '' --appendonly no \
    --unixsocket "$redis_sock" --unixsocketperm 700 \
    --dir "$redis_demo" >"$redis_demo/server.log" 2>&1 &
  redis_pid=$!

  i=0
  while test ! -S "$redis_sock" && test "$i" -lt 50; do
    i=$((i + 1))
    sleep 0.02
  done

  redis-cli -s "$redis_sock" <<'EOF'
SET likes 40
MULTI
INCR likes
INCR likes
EXEC
GET likes
EOF

  redis-cli -s "$redis_sock" SHUTDOWN NOSAVE || true
  wait "$redis_pid" 2>/dev/null || true
  case "$redis_demo" in
    /tmp/lect27-redis.*) rm -r -- "$redis_demo" ;;
  esac
else
  echo 'Redis not installed; skip this optional experiment'
fi
```

预期两次 `INCR` 先显示 `QUEUED`，`EXEC` 返回两个结果，最终为 42。
此实例明确关闭 persistence，只观察 command serialization；它不展示 crash durability、WATCH conflict 或 cluster semantics。

### 21.4 cache 仍有 correctness protocol

点赞先写 Redis、定期合成 persistent database insert 的方案必须定义：

- Redis crash 会丢多少；
- flush 到主数据库前后如何去重；
- 主库写成功但确认丢失时怎样 retry；
- cache 与主库版本冲突谁为准；
- eviction/expiration 是否会悄悄丢 pending state。

如果无法回答，Redis 应只保存可从 source of truth 重建的数据，或引入可靠 log/outbox/idempotency protocol。

---

## 22. NoSQL & NewSQL

“NoSQL”是一个产品家族标签，不是单一 data model 或一致性级别。

### 22.1 Document、wide-column 与 KV

- MongoDB-style document：key 对应 BSON-like document，适合一起读取/更新的聚合对象；
- Cassandra-style wide-column：以 partition key 和 clustering key 固定主要访问路径，CQL 看似 table/SQL，但 join/transaction 能力与关系数据库不同；
- KV：最小 key 到 value/data type 映射；
- graph/time-series/search engine 还会为 traversal、时间窗口或 inverted index 采用不同结构。

把 message append 到 `user:{uid}.messages` 很方便，但若同一 message 属于多个用户，就要选择复制、引用或额外 relation，并定义部分失败的恢复。

### 22.2 NewSQL 的目标

Spanner、TiDB、CockroachDB 等系统尝试保留关系模型、SQL 和较强 transaction，同时把 storage/replication 分布到多机。
它们不是“单机 B+ tree 加网络”这么简单：

- data 按 range/shard 分布；
- 每个 shard 需要 replication/consensus；
- transaction 跨 shard 时要协调 commit 与 timestamp/order；
- query optimizer 还要考虑 network shuffle；
- clock、leader lease、failure detection 都进入语义边界。

具体系统在 isolation、clock、schema change、secondary index、read freshness 和 failure behavior 上不同。
不要从“支持完整 SQL”推导出相同 implementation 或相同 linearizability contract。

### 22.3 选择数据库先写 contract，不先选标签

至少列出：

1. entity、relationship 和 invariant；
2. 主要 read/write pattern 与最大 fan-out；
3. 单 key、单 row、单 partition 或跨 partition atomicity；
4. isolation/consistency/read freshness；
5. acknowledged write 的 durability；
6. latency、throughput、dataset、working-set 与 growth；
7. backup、restore、migration、audit 和 access control。

之后再判断关系数据库、document/KV、stream log、search/vector index 或组合架构。

---

## 23. Vector Database

Embedding model 把文本、图片或其他 context 映射成向量；相似度常用 cosine、dot product 或 Euclidean distance。
Vector database 保存向量、id 与 metadata，并按距离找近邻。

![AI 应用中的向量数据库](../../sources/site_html/static/img/lect-2026.png)

### 23.1 Exact kNN 与 ANN

exact k-nearest-neighbor 对每个候选计算距离，结果精确但成本随数据量和维度增长。
ANN（Approximate Nearest Neighbor）用 index 缩小候选，例如：

- HNSW：分层 proximity graph；
- IVF：先找近的 coarse clusters/list；
- product quantization：压缩向量与近似距离；
- DiskANN-like graph：设计适合 SSD 的访问。

ANN 的接口已经改变：它通常以 recall/latency/memory/build-time 为交换，最近结果不保证绝对精确。
HNSW 原始论文见 [Malkov 与 Yashunin](https://arxiv.org/abs/1603.09320)。

### 23.2 实验 4：不用第三方包的精确 cosine 检索

这个小实验故意不用真正 vector DB，只固定数学 ground truth：

```python
#!/usr/bin/env python3
import math

docs = [
    ("fs", "文件系统保存命名字节", [1.0, 0.0, 0.0], {"lang": "zh"}),
    ("db", "数据库提供事务查询", [0.8, 0.6, 0.0], {"lang": "zh"}),
    ("gpu", "GPU 执行并行计算", [0.0, 0.1, 1.0], {"lang": "zh"}),
    ("en", "database transaction", [0.75, 0.65, 0.0], {"lang": "en"}),
]
query = [0.9, 0.4, 0.0]

def cosine(a, b):
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    if na == 0 or nb == 0:
        raise ValueError("cosine is undefined for a zero vector")
    return dot / (na * nb)

candidates = [d for d in docs if d[3]["lang"] == "zh"]
ranked = sorted(((cosine(query, vec), doc_id, text)
                 for doc_id, text, vec, _ in candidates), reverse=True)
for score, doc_id, text in ranked[:2]:
    print(f"{doc_id}: {score:.4f} {text}")
```

预期 `db` 排第一、`fs` 排第二；英文 document 因 metadata filter 不参与距离比较。

观察点：

- metric 是 API 的一部分；同一向量换 dot product/Euclidean 可能改变顺序；
- cosine 对 zero vector 无定义，通常要在写入时校验/normalize；
- metadata filter 放在 ANN 前还是后，会同时影响性能和 recall；
- 这个程序做 exact scan，可作为小数据上的 ground truth，与 ANN 结果计算 recall；
- embedding model 升级后，新旧向量不一定在同一空间，必须记录 model/version 并 re-embed 或隔离 index。

### 23.3 Vector DB 不等于“语义正确机器”

距离近只表示 embedding 与 metric 定义下接近，不代表事实正确、授权可见或来源可信。
RAG 系统还需：

- document version、tenant 与 ACL filter；
- deletion/更新后 index 的可见性；
- source citation 与 provenance；
- ANN recall 监测；
- prompt injection/恶意文档隔离；
- vector、metadata 与原文更新的一致性。

有些 vector systems 是独立分布式数据库，有些是 PostgreSQL extension，有些只是内存 ANN library。
它们的 transaction、durability 和 replication contract 都可能不同。

---

## 24. 常见误区与精确边界

### 误区 1：“文件系统有 journaling，应用多文件更新就自动 atomic”

错误。
filesystem journal 首先保护 filesystem metadata/data 的协议；应用要用 transaction、WAL 或正确的 file-update protocol 表达自己的 commit point。

### 误区 2：“调用 `write` 或修改 mmap 后，数据就在盘上”

错误。
它通常先进入 cache；何时对何种 crash durable 由 `fsync/msync`、数据库配置、VFS 与设备共同决定。

### 误区 3：“WAL 就是每次操作写一行文本”

不完整。
关键是 log-before-data、record 完整性、commit point、flush 顺序和 recovery algorithm。

### 误区 4：“ACID 数据库默认都 Serializable”

错误。
isolation level 与 anomaly contract 必须查具体 engine/configuration；serializable transaction 也不自动推出跨副本 linearizability。

### 误区 5：“MVCC 没有锁”

错误。
MVCC 减少 reader/writer 冲突，但 writer conflict、DDL、index、vacuum 和 serializable validation 仍需同步机制。

### 误区 6：“有 index，query 就一定更快”

错误。
低选择度、小表、覆盖范围不匹配或随机 I/O 过多时 full scan 可能更便宜；写入还要维护 index。

### 误区 7：“SQLite 是玩具，Redis 是内存所以不持久，NoSQL 都是 eventually consistent”

三句都错。
SQLite 是完整嵌入式 SQL engine；Redis persistence 可配置；NoSQL 产品的 consistency/transaction 差异很大。

### 误区 8：“向量数据库会返回语义上正确的答案”

错误。
它返回 metric/index contract 下的近邻；ANN 甚至允许近似，事实性、安全与授权需要更上层验证。

---

## 25. Takeaways

本讲可以压缩为六个结论：

1. **应用在持久化数据结构，而不只是文件。** 文件系统提供命名字节和底层 crash-consistency 原语，业务不变量仍需上层协议。
2. **目录/文件方案是合理工具。** 小规模、append-only、可重建、工具友好的 workload 不必强行上数据库。
3. **直接 mmap 只消除了部分复制。** pointer、allocator、版本、并发和 crash atomicity 并不会消失；WAL 的本质是持久化顺序与恢复规则。
4. **关系模型把物理 pointer 提升为 logical relation。** SQL 声明结果，DBMS 才能用 page/cache/B+ tree/query plan 隐藏物理组织。
5. **ACID 必须逐项、逐 engine、逐配置理解。** locking/MVCC 负责并发可见性，WAL/checkpoint 负责恢复；serializability 不等于 linearizability。
6. **规模化常靠限制自由度。** KV、NoSQL、NewSQL 和 vector database 分别选择不同 data model 与 contract，没有万能实现。

主线最终是：

```text
durable bytes
  → durable pages/records
  → indexed relations and constrained state transitions
  → transactions under concurrency and crash
  → distributed/approximate specialized contracts
```

---

## 26. 思考题与下一讲衔接

1. 两个普通文件分别保存余额，怎样用 WAL 定义一个可恢复的转账 commit point？请列出每次 flush 的偏序。
2. `wal_kv.c` 若允许两个进程同时 append，哪些 `write` 可能交错？怎样把 record framing 与 single-writer/lock 协议补完整？
3. 为什么 foreign key 能表达“选课引用存在的学生”，却不能单独保证“课程人数不超过 capacity”？
4. 为 `(conversation_id, timestamp DESC)` 建 index 后，为什么 `LIMIT 10` 仍可能遇到 pagination consistency 问题？
5. 构造两个 transaction，说明 snapshot isolation 下可能出现 write skew，但每个 writer 更新的 row 不冲突。
6. SQLite WAL mode 中长期 reader 为什么会妨碍 checkpoint？这与 MVCC 的旧版本回收有什么共同点？
7. Redis 作为 cache 与作为 source of truth 时，persistence、retry 和 eviction contract 有何不同？
8. 怎样用 exact scan 的 top-k 作为 ground truth 测量 ANN recall@k？metadata filter 应如何纳入测试？
9. serializability 与 linearizability 各约束什么顺序？跨 region 系统为什么必须把 read freshness 写进 API contract？
10. 如果数据库能正确保存每次修改，为什么下一讲仍需 confidentiality、integrity、availability 和 access control？

下一讲会把问题从“状态是否一致”转为“主体是否有权做这次状态变化”。
数据库 constraint 阻止不存在的 foreign key，却不会自动判断当前进程是不是教务员；backup 保证可恢复，也不阻止未授权读取。
这正是[计算机安全](28-security.md)的入口。

---

## 27. 扩展阅读（不替代 PPT 主线）

以下资料用于核对具体实现边界：

- E. F. Codd, [*A Relational Model of Data for Large Shared Data Banks*](https://dl.acm.org/doi/10.1145/362384.362685)：关系模型原始论文；
- SQLite 官方：[database file format](https://sqlite.org/fileformat2.html)、[query planner](https://sqlite.org/queryplanner.html)、[transaction](https://sqlite.org/lang_transaction.html)、[isolation](https://sqlite.org/isolation.html)、[WAL](https://sqlite.org/wal.html)、[atomic commit](https://sqlite.org/atomiccommit.html)；
- PostgreSQL 官方：[MVCC](https://www.postgresql.org/docs/current/mvcc-intro.html)、[transaction isolation](https://www.postgresql.org/docs/current/transaction-iso.html)、[B-tree indexes](https://www.postgresql.org/docs/current/btree.html)、[`EXPLAIN`](https://www.postgresql.org/docs/current/using-explain.html)、[WAL](https://www.postgresql.org/docs/current/wal-intro.html)；
- Redis 官方：[data types](https://redis.io/docs/latest/develop/data-types/)、[transactions](https://redis.io/docs/latest/develop/using-commands/transactions/)、[persistence](https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/)；
- C. Mohan 等，[ARIES](https://dl.acm.org/doi/10.1145/128765.128770)：经典 WAL recovery algorithm；
- M. Herlihy 与 J. Wing，[Linearizability](https://dl.acm.org/doi/10.1145/78969.78972)：并发对象实时一致性的原始定义；
- Y. Malkov 与 D. Yashunin，[HNSW](https://arxiv.org/abs/1603.09320)：graph-based ANN；
- 本仓库示例：[`wal_kv.c`](../../examples/wal_kv.c)。

这些资料展示多种实现，不应混成一个“标准数据库内部结构”。

---

## 28. PPT 内容覆盖表

下表第一列逐字保留 `sources/notes/lect27.md` 的全部非重复一级标题，并按原顺序列出。

| PPT 一级标题（逐字） | 本章对应位置 | 覆盖的案例/机制 |
|---|---|---|
| `数据库系统` | §0–§1 | 文件系统到数据库的抽象跃迁 |
| `Review & Comments` | §2 | 文件系统持久化、应用 crash consistency |
| `什么是 “应用程序”？` | §3 | 现实过程投影、persistent CRUD |
| `Everything is a File` | §4 | 教务目录树、UNIX 工具、symlink、Agent |
| `优点和缺点` | §5 | tool friendly 代价、课程提交与 rejudge |
| `一个有趣的 Hack` | §6 | 文件内 struct、offset、page |
| `[Memory-mapped 数据结构](/OS/demos/persistence/mmds)` | §7 | 固定映射、pointer、`msync/fdatasync` 边界 |
| `你甚至可以实现 WAL Log` | §8 | write-ahead、single-level store、`wal_kv.c` |
| `需求：一个非常非常好的数据结构` | §9 | 易用、性能、持久与 multi-write |
| `反思：我们是怎么实现数据结构的？` | §10 | pointer machine、关系编码 |
| `Relational Database (关系型数据库)` | §11 | Codd、table、SQL 与数学 relation 边界 |
| `关系数据库模型` | §12 | 对象、foreign key、constraint |
| `关系数据库查询：指针 “配对”` | §13 | JOIN、physical join algorithms |
| `从模型到实现：数据库系统` | §14 | page/cache/B+ tree/LSM/query path |
| `ACID 数据库` | §15 | A/C/I/D、isolation、linearizability |
| `Databases v.s. Compilers` | §16 | parse、rewrite、cost plan、`EXPLAIN` |
| `一个超级复杂的并发程序` | §17 | 2PL、deadlock、MVCC、WAL/recovery |
| `例子：SQLite` | §18 | embedded DB、WAL、plan、双连接并发实验 |
| `实现 “国民级” 的应用` | §19 | chat query、sharding/cache/replication |
| `解决办法：做减法` | §20 | KV、hash partition、LSM 边界 |
| `Redis: Everything is In-memory` | §21 | data types、cache、persistence、MULTI/WATCH |
| `NoSQL & NewSQL` | §22 | Document/Column/KV、distributed SQL |
| `Vector Database` | §23 | embedding、exact kNN、ANN、HNSW |

### 28.1 课堂演示与细节审计

| 原讲义内容 | 覆盖位置 |
|---|---|
| 教务系统、演示文稿都是数据结构 CRUD | §3 |
| 教务目录树、`find/grep`、symlink reference | §4 |
| 提交文件、结果文件、Accepted 统计、Rejudge M5 | §5 |
| ELF/BMP 类比、file-backed struct | §6 |
| fixed mapping、persistent pointer、专用 allocator | §7 |
| `msync`、`fdatasync` 与 crash consistency | §7.2 |
| superblock 内 WAL、先日志再副作用、清 WAL | §8 |
| single-level store | §8.3 |
| 任意数据、并发选课、multi-write all-or-nothing | §9 |
| pointer 是对象关系、二元关系 | §10 |
| Codd、用户不依赖物理组织、everything is table | §11 |
| 教务关系图 | §12–§13 |
| SQL JOIN 与 LIKE 查询 | §13 |
| ACID、余额转账 transaction | §15 |
| query rewriting、CMU 15-445、SQL execution 图 | §16 |
| `T1/T2`、2PL/deadlock rollback、MVCC branch 比喻 | §17 |
| SQLite 的定位、生态与 zero configuration | §18 |
| chat query 与 arbitrary-query performance bug | §19 |
| key 命名、like history、hash load balance、append-only | §20 |
| Redis data types、search、MULTI/WATCH/EXEC、cache | §21 |
| MongoDB/BSON、Cassandra/CQL、Spanner/TiDB/CockroachDB | §22 |
| embedding、vector database、ANN | §23 |
