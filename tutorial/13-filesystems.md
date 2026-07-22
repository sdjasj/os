# 第 13 章：文件系统——API、数据结构与崩溃一致性

> 对应讲义：[第 24 讲](../sources/notes/lect24.md)、[第 25 讲](../sources/notes/lect25.md)、[第 26 讲](../sources/notes/lect26.md)，配套实验：[atomic_replace.c](../examples/atomic_replace.c)

文件系统把块数组组织成两个核心抽象：可随机访问的文件对象，以及把名字映射到对象的目录。把它当成需要在崩溃后仍合法的数据结构，许多设计便自然起来。

## 13.1 目录项、inode 与打开文件

在典型 UNIX 文件系统中：

```text
path "a/b.txt"
  ↓ 逐级查目录
directory entry: "b.txt" → inode number
  ↓
inode: 类型、权限、属主、时间、大小、数据块索引
  ↓
file data blocks/extents
```

路径名不是文件对象固有属性。目录保存名字到 inode 的链接；打开后 fd 经内核对象引用 inode，即使原目录项被 `unlink`，只要仍有打开引用，文件数据就可继续访问。

```bash
printf hello > /tmp/a
ln /tmp/a /tmp/b
ls -li /tmp/a /tmp/b
```

两个名字指向同一 inode，链接计数为 2。硬链接通常不能跨文件系统，因为 inode 编号只在本文件系统内有意义。

## 13.2 符号链接是另一层名字解析

symlink 自身是独立 inode，内容是另一个路径字符串。解析器遇到它就继续解析目标，因此：

- 可跨文件系统、可指向不存在目标；
- 相对目标相对于 symlink 所在目录解释；
- 可能形成环，内核限制跟随次数；
- 路径解析期间目标可能被并发替换。

安全敏感程序应尽量持有目录 fd，使用 `openat`/`openat2` 和“不跟随 symlink、必须位于某目录下”等解析约束，而不是先 `realpath` 再打开。

## 13.3 mount：把多棵树拼成一棵

挂载把一个文件系统根接到现有目录项。`/proc`、`/sys`、`tmpfs` 等看起来都在同一树上，背后却是不同实现。VFS 用统一 inode/dentry/file 操作接口分派请求。

这使“设备 = 目录树”进一步扩展：procfs 把进程状态生成成文件，sysfs 展示设备模型，FUSE 让用户态程序实现文件系统。统一 API 带来组合能力，也会受传统路径与权限语义约束。

## 13.4 元数据与权限

inode 记录 `uid/gid` 和 mode 位；目录的读、写、执行权限分别影响列举、修改目录项和穿越。ACL、扩展属性、capability 和安全标签进一步表达策略。

容易混淆：删除文件需要的是父目录写与执行权限，不一定需要文件自身写权限；sticky bit（如 `/tmp`）再限制谁能删除目录中的他人条目。

`stat` 看到的是某时刻快照。检查权限后再按路径使用会产生 TOCTTOU，最好直接执行操作并处理内核返回。

## 13.5 监控、快照与 Overlay

- `inotify` 订阅目录/文件变化，但队列可能溢出，事件也不等于完整事务日志。
- Copy-on-Write 快照让新旧版本共享未修改块，更新时只复制路径上的节点。
- Git 以内容寻址对象和 commit DAG 保存文件树快照；它不是通用文件系统，却展示“文件系统就是数据结构”。
- OverlayFS 把只读下层与可写上层合并，容器镜像层由此高效复用；删除下层文件常用 whiteout 表示。

快照不是独立备份：底层介质损坏、同一管理员误删或密钥丢失可能同时影响所有快照。

## 13.6 一个经典磁盘布局

```text
superblock | allocation bitmap | inode table | data blocks ...
```

- superblock 描述全局参数和根位置；
- bitmap/freelist 追踪空闲块与 inode；
- inode 用直接块、间接块或 extent 索引文件数据；
- 目录本身是 `name → inode` 记录组成的特殊文件。

FAT 把块链关系集中在表中，简单但随机访问长文件需沿链；UNIX inode 把每文件索引分离，局部性和并发更好。现代文件系统使用 extent、B-tree、checksums、COW 等适配大盘与复杂 workload。

## 13.7 缓存改变了写入语义

页缓存让读写先在内存完成，内核稍后回写。这样吞吐高、延迟低，却意味着崩溃可能发生在任意中间状态：

```text
创建 inode → 写目录项 → 分配数据块 → 写数据 → 更新大小
```

设备和 CPU 还可能重排写入。若目录项先落盘而 inode 未初始化，重启后结构损坏；若元数据完整但数据未落盘，文件可能包含旧数据或零。

`fsck` 在重启后扫描并修复结构不变量，但全盘扫描慢，而且只能把结构变合法，不能猜出用户期望内容。

## 13.8 Journaling 与写前日志

文件系统可先把一组元数据更新写入日志，再写 commit 记录，最后 lazily 更新主位置：

```text
append log(records) → flush → append COMMIT → flush
                                  ↓
                          checkpoint home locations
```

恢复时只重放完整已提交事务，忽略尾部未提交记录。日志模式可能只保护元数据，数据写入顺序仍影响应用语义；data journaling 更强但写放大更大。COW 文件系统则写新树并原子切换根指针，也要处理引用计数、GC 和根更新持久化。

## 13.9 应用的原子持久替换

直接 `open(O_TRUNC)` 再写配置，崩溃可能留下空文件。更稳妥的同文件系统替换模式见 [atomic_replace.c](../examples/atomic_replace.c)：

```bash
./examples/atomic_replace /tmp/config.txt 'version=2'
```

协议：

1. 在目标同目录创建临时文件；
2. 写完整内容并 `fsync(temp_fd)`；
3. `rename(temp, target)` 原子替换目录项；
4. `fsync(parent_dir_fd)` 持久化目录变化。

`rename` 的原子性意味着并发读者看到旧名字或新名字，不看到“半个目录项”；它不单独保证断电后的持久性。若还要保留权限、属主、xattr，需要在 rename 前正确设置临时文件。

对多文件事务，这个模式不够；要使用日志、数据库或可恢复协议。

## 13.10 sync 家族要精确理解

- `fsync(fd)`：请求文件相关数据和必要元数据持久化；
- `fdatasync(fd)`：可省略不影响数据读取的部分元数据；
- `syncfs(fd)`：推动该文件系统的脏数据；
- `msync`：针对 memory-mapped 范围；
- `O_SYNC/O_DSYNC`：让每次写按相应语义完成，代价高。

具体设备、文件系统、挂载选项和内核版本会影响保证。NFS 等远程文件系统还多一个服务器端稳定存储边界。应用必须定义自己需要的“已提交”究竟跨越到哪里。

## 13.11 常见误区

- inode 保存文件名：名字在目录项中，一个 inode 可有多个硬链接。
- `unlink` 立即抹掉打开文件：目录引用消失，最后引用关闭后才回收。
- `rename` 自动保证断电不丢：还要持久化文件内容与相关目录。
- `fsync` 一次就能提交跨目录重命名的所有状态：可能需要同步源、目标目录，具体看协议。
- inotify 是可靠审计日志：队列会溢出，观察者也可能晚启动。
- 快照等于备份：共享故障域仍然存在。

## 13.12 自测与实验

1. 打开文件后 `unlink`，继续读写，再查 `/proc/PID/fd`；何时真正释放空间？
2. 用 `strace` 查看 `atomic_replace` 的写入顺序，故意在各步骤 `kill -9` 并观察结果。
3. 画出创建一个新文件需要更新的最少磁盘结构，列举每个可能崩溃点。
4. 解释 OverlayFS 中“修改下层文件”为何需要 copy-up。
5. 如果两个配置文件必须要么一起升级要么都不升级，如何用 WAL 设计恢复协议？

下一章把 WAL、索引和并发控制组合成专门的数据管理系统：数据库。
