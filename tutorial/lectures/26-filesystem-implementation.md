# 第 26 讲：文件系统实现——把块数组变成可恢复的数据结构

> 原始讲义：[sources/notes/lect26.md](../../sources/notes/lect26.md)  
> 前一讲：[文件系统 API（2）](25-filesystem-api-2.md) · 后一讲：[数据库系统](27-databases.md)  
> 配套示例：[atomic_replace.c](../../examples/atomic_replace.c)、[wal_kv.c](../../examples/wal_kv.c)

## 0. 本讲定位：API 背后是一组必须跨掉电成立的不变量

前两讲从应用一侧建立了文件系统抽象：路径经过目录逐层解析到 inode，文件描述符引用打开对象，`link/unlink/rename` 修改名字关系，`read/write/mmap` 访问字节，权限和 namespace 决定“能看见什么”。这些 API 看起来像一个内存中的树和若干 byte array。

第 23 讲却告诉我们，持久设备只给出近似这样的接口：

```text
read(block_no)  -> one block
write(block_no, bytes)
flush()         -> ask lower layers to reach a persistence boundary
```

本讲要填上两者之间最关键的一层：怎样在有限、昂贵、可能乱序且会在任意时刻断电的块数组上，实现名字、inode、目录、空闲空间和文件数据；又怎样保证重启后得到一个可解释的状态。

核心链条是：

```text
介质/控制器的约束
  -> block read/write/flush
  -> superblock + bitmap + inode + directory + data
  -> cache、allocation、writeback
  -> multi-block update 与任意时刻 crash
  -> fsck / WAL / journal
  -> fsync 协议
  -> 应用和数据库的 transaction
```

所以“文件系统是数据结构”只说了一半。完整说法是：**文件系统是一组持久数据结构，加上更新它们的并发与崩溃协议。**

## 1. 学习目标与问题地图

学完本讲，应能做到：

- 从 block device、partition、device mapper/LVM 一直追踪到文件系统看到的逻辑块数组；
- 解释 superblock 为什么是入口，而不是“存放所有 metadata 的大块”；
- 手算 FAT cluster chain、UNIX inode 的 direct/indirect mapping 和目录项到 inode 的两步查询；
- 区分 file data、inode metadata、allocation metadata 和 namespace metadata；
- 写出一次 append 涉及的多个位置，并枚举任意写入顺序下的坏状态；
- 区分 CPU memory fence、page-cache writeback、block flush/FUA 与真正非易失持久点；
- 说明 torn write、volatile controller cache 和 reorder 分别破坏什么假设；
- 比较 fsck、write-ahead logging、metadata journaling 和 data journaling 的恢复边界；
- 解释 `write()`、`rename()`、`fsync()`、`fdatasync()`、`syncfs()` 各自不保证什么；
- 实现并验证临时文件替换协议：`fsync(temp) -> rename -> fsync(parent)`；
- 说明为什么数据库会在文件系统上再实现 WAL，而不是把 journal 当成事务数据库。

本章的推导始终问四个问题：

1. 稳态时，磁盘上有哪些对象和不变量？
2. 一次 API 操作要改哪些 block？
3. crash 截断在任意一步时，重启会看到什么？
4. 恢复协议凭什么判断“旧状态”“新状态”或“需要回放”？

---

## 2. Review & Comments：文件系统首先是一种数据结构

讲义从 `struct fuse_operations` 回顾文件系统的实现面。只要一个系统能实现 `getattr`、`readdir`、`mkdir`、`open`、`read` 等对象操作，就能把自己的状态包装成文件树：

- `procfs` 把内核和进程状态投影成文件；
- `sysfs` 把设备模型投影成目录、属性和链接；
- FUSE 可以把压缩包、远端对象、游戏资源甚至剧情分支投影为 pathname namespace；
- 传统 ext4 则把块设备上的持久数据结构投影成同一套 VFS API。

这解释了“任何 `fuse_operations` 都可以是文件系统”，却没有解释持久化难题。内存型 FUSE 进程退出就能丢掉全部状态；磁盘文件系统必须在重启后重建相同的对象图。

### 2.1 最小块设备接口不是普通内存

先写一个教学接口：

```c
int bread(uint64_t block, void *buf);          // load one block
int bwrite(uint64_t block, const void *buf);   // store one block
int bflush(void);                              // establish persistence
```

这里的 `bflush` 只是规范中的持久化原语。它**绝不能**用 `__sync_synchronize()` 代替。后者是 CPU memory barrier：约束处理器/编译器对内存访问的排序；它不会把 dirty page 写回，也不会命令 NVMe/SATA controller 清空 volatile cache。

从上到下至少有这些不同的“完成”：

```text
用户 write 返回
  != 数据离开 libc buffer
  != 数据离开 page cache
  != bio/request 已提交
  != controller 已接收
  != volatile cache 已刷出
  != 介质在掉电后仍可恢复
```

文件系统必须使用内核和设备提供的 writeback、barrier、cache flush、FUA 等机制兑现自己的 `fsync` 合同；上层不能用一条 CPU fence 猜测完成。

---

## 3. 真实的块设备：文件系统下方还可以叠很多数据结构

### 3.1 实际设备、分区与 GPT

一个文件系统可以直接位于整块设备，也可以位于分区。GPT 本身就是持久数据结构：header 给出签名、版本、可用 LBA 范围、partition-entry array 的位置与校验；每个 entry 描述分区类型 GUID、唯一 GUID、起止 LBA 和属性。

因此 `/dev/nvme0n1p2` 不是“盘片上的天然物体”。partition layer 把它收到的逻辑 block `x` 翻译为底层 disk 的 `partition_start + x`。GPT 还需要主/备 header 和 entry array，因为描述所有分区的入口损坏会让上层文件系统统统失联。讲义链接的 [UEFI GPT 规范](https://uefi.org/specs/UEFI/2.10/05_GUID_Partition_Table_Format.html)可作为字段级扩展阅读。

不要混淆几个编号：

- device sector/LBA 是块设备协议地址；
- filesystem block 是文件系统自己的分配单位，常由多个 sector 组成；
- page 是内存管理单位；
- FAT cluster 或 ext4 bigalloc cluster 又可能由多个 filesystem block 组成。

### 3.2 虚拟块设备：PV -> VG -> LV

LVM/device mapper 再加一层映射：

```text
Physical Volume(s)
       | divide into physical extents
       v
Volume Group: a pool of extents
       | map logical extents
       v
Logical Volume(s) -> /dev/mapper/... -> filesystem
```

它可以把多个 physical volumes 聚合成一个 volume group，再切出多个 logical volumes；一个 LV 的连续 logical extent 不一定在同一物理设备上。snapshot、thin provisioning、mirror/RAID target 还会添加 copy-on-write、共享 backing store 或冗余写。

这带来两个结论：

1. 文件系统只看到 LV 暴露的逻辑块，不应猜底层物理拓扑；
2. locality、failure domain、discard、flush 语义仍受每一层映射影响。

NVMe namespace 也向 host 暴露一段独立的 LBA 空间，但它由 controller/firmware 管理，不等同于 Linux 的通用 LVM。二者都说明“块设备可以由软件或硬件再定义”。

### 3.3 安全观察：只列举，不创建 PV/LV

下面全部是只读盘点命令；普通用户权限不足时允许部分命令失败。**不要为了课堂观察运行 `pvcreate`、`vgcreate`、`lvcreate`、`mkfs` 或向 `/dev/*` 写入。**

```bash
lsblk -o NAME,TYPE,SIZE,FSTYPE,FSVER,MOUNTPOINTS,PKNAME
findmnt -o TARGET,SOURCE,FSTYPE,OPTIONS /

if command -v pvs >/dev/null 2>&1; then
  pvs --readonly -o pv_name,vg_name,pv_size,pv_free
  vgs --readonly -o vg_name,vg_size,vg_free
  lvs --readonly -o lv_name,vg_name,lv_size,segtype,devices
fi
```

预期在 `TYPE` 中看到 `disk/part/lvm/crypt/raid` 的某个子集；云主机或容器可能只见 virtual disk，完全没有 LVM。`findmnt` 的 `SOURCE` 可能是 partition、LV、overlay 或网络文件系统。观察不到某层不等于该层不存在于宿主机；namespace 可能隐藏它。

---

## 4. Logic Volume Manager：课堂 Demo 想揭示的映射

PPT 的 LVM Demo 不是要求在保存作业的机器上练习分区，而是让我们把 “block array” 看成可组合对象：

```text
LV logical block
 -> device-mapper target
 -> logical extent
 -> one or more physical extents
 -> partition/device LBA
 -> controller/FTL physical location
```

`lvextend` 先改变 LV 映射和容量；它通常**不会自动**让文件系统的数据结构占用新空间。之后还需让 filesystem grow，例如 ext4 的 `resize2fs`。反过来 shrink 更危险：必须先证明文件系统尾部已空并缩小文件系统，再缩 LV；顺序反了就直接截掉有用 block。

`strace` LVM 工具时会看到它们读取 `/dev`、sysfs、配置与 metadata，并通过 ioctl 和 device mapper 通信；这不表示 LVM 核心逻辑只是文本文件。课堂复现应使用 disposable VM 和新建虚拟盘，绝不能拿宿主 root/data volume 当练习对象。本章后续所有动手实验改用普通临时文件。

---

## 5. 实现文件系统的代价：一个字节为什么引发多层读写放大

假设只更新 inode 中的 modification time。块设备不能只写 inode 里的 8 个 bytes；文件系统通常要：

```text
bread(inode_table_block)
modify 8 bytes in cached block
mark whole filesystem block dirty
eventually bwrite(inode_table_block)
```

若启用 metadata journal，还可能先把 metadata block 写到 journal，再 checkpoint 到 home location；SSD FTL 又可能 out-of-place program、更新 mapping、做 garbage collection。于是一次小 metadata update 的 host payload 与底层实际 bytes 差距很大。

“写放大几万倍”应理解为讲义的极端直觉，不是任意系统的固定常数。实际倍数取决于 filesystem block、journal transaction、设备 page/erase-block、合并机会、剩余空间和 workload。

### 5.1 cache 为什么必要，也为什么制造崩溃窗口

文件系统把更快的内存当 block/page cache：

- read hit 避免设备访问；
- 多次修改同一 metadata block 可合并成一次 writeback；
- read-ahead、delayed allocation 和 batching 利用 locality；
- 异步 writeback 让 `write()` 不必等待介质。

但 cache 把“应用已看到新状态”和“介质已持久化新状态”分开。crash 时 volatile memory 瞬间丢失，设备上只留下某个历史前缀，而且可能不是程序调用顺序的前缀。

### 5.2 locality 是布局策略，不是抽象保证

把 inode、目录项和数据尽量放在同一 block group 能减少 HDD seek，并改善 cache 命中；SSD 上连续 I/O 也更容易合并、并行和减少 mapping 开销。但 API 从不保证两个同目录文件物理相邻，应用不能依赖布局猜持久顺序。

---

## 6. 进入文件系统设计：先列对象、访问模式与不变量

### 6.1 要 persist 什么

至少有四类状态：

| 类别 | 例子 | 核心不变量 |
| --- | --- | --- |
| file data | 用户 bytes | offset 映射到正确 data block |
| inode metadata | type、mode、uid/gid、size、timestamps、block map | inode 与其映射/size 相容 |
| allocation metadata | free block/inode bitmap、free count | 一个资源不能既 free 又被引用 |
| namespace metadata | directory `name -> inode`、link count | dirent 指向已分配 inode，link count 可解释 |

“文件系统一致”通常首先指这些结构关系自洽，并不自动意味着应用层 JSON、Git object 或数据库 transaction 合法。

### 6.2 统计规律如何变成结构选择

经典观察是：多数文件很小，少数大文件占据多数 bytes；多数目录 entry 不多；文件系统长期不会永远全空。由此得到：

- small-file fast path 应少做间接访问；
- large file 必须可扩展，不能在 inode 塞下所有 block pointer；
- directory linear scan 对小目录简单有效，大目录需 hash/tree 索引；
- allocation 应兼顾近邻、碎片和近满状态；
- fixed inode table 会在“很多空文件”和“少量大文件”之间产生容量权衡。

这些是 workload 假设，不是自然定律。对象存储、maildir、容器 layer、视频归档会得到不同设计。

### 6.3 三个核心数据结构问题

1. metadata 放在哪里，怎样由 inode number 定位？
2. file logical block number 怎样映射到 physical filesystem block？
3. directory 怎样把 variable-length name 映射到 inode number？

再加上崩溃一致性，问题变成：怎样**原子地**维护这三种映射之间的关系。

---

## 7. Super Block：整套持久数据结构的根

链表要有 head，树要有 root，ELF/BMP 要有 header；文件系统也要有固定可发现的入口。superblock 常记录：

- magic、format version、feature flags；
- filesystem block size 与总 block/inode 数；
- block group/allocator 布局参数；
- UUID、mount/check 状态、错误策略；
- journal 或其他根结构的定位信息。

mount 的基本动作是：读取候选位置，检查 magic/features/checksum，构造内存 superblock，找到其余 metadata，必要时先 replay journal，再开放 namespace。

### 7.1 superblock 不是所有 metadata 的容器

它更像 schema + root pointers。每个文件的 size、权限和 block map 在 inode；名字关系在 directory data；空闲状态在 bitmaps。superblock 里的 free count 往往是汇总/加速信息，恢复工具可以从更细结构重新核对。

### 7.2 为什么要备份与校验

入口损坏会让其余 block 即使完好也难以解释。传统文件系统在多个 block group 放 superblock/group-descriptor backup；现代格式还加入 checksums 和 feature compatibility bits。

Linux 官方的 [ext4 on-disk 文档](https://docs.kernel.org/filesystems/ext4/index.html)把布局分为 superblock、group descriptors、block/inode bitmaps、inode table、directory entries 和 jbd2 journal。它是本章 ext4 细节的扩展依据；PPT 主线不要求背字段 offset。

---

## 8. 小文件系统和 FAT：空间紧张时，链表就是合理答案

5.25 英寸单面软盘只有 160 KiB，即 320 个 512-byte sectors。此时 B-tree、复杂 extent allocator 或巨大 inode table 都过于奢侈。FAT 的选择是把文件 block map 集中成一个数组。

### 8.1 FAT 的最小模型

disk 被分为 clusters；每个 cluster 由 `2^k` 个 sector 组成。FAT 近似是：

```c
cluster_t fat[N];
// fat[i] == FREE: cluster i 未分配
// fat[i] == EOF:  i 是链尾
// otherwise:      下一个 cluster number
```

directory entry 保存 name、attributes、size 和 first cluster。读文件的逻辑是：

```text
dirent.first = 7
FAT[7]  = 11
FAT[11] = 4
FAT[4]  = EOF

file logical cluster 0 -> physical cluster 7
file logical cluster 1 -> physical cluster 11
file logical cluster 2 -> physical cluster 4
```

顺序读可沿链走；随机 `lseek` 到第 k 个 cluster 在没有额外索引/缓存时要追 k 次 next pointer。碎片越多，数据 locality 越差，但“查表次数 O(k)”与物理上是否连续是两个维度。

### 8.2 FAT-12 的 12 bit 不是一个普通 C 数组

讲义用 `cluster_t fat[4096]` 表达语义。真实 FAT12 entry 以 12 bit 紧凑打包，相邻 entry 共享 bytes，解析还要处理 reserved values、bad cluster、end-of-chain 区间和 little-endian 字段。实现解析器应以规范中的 byte offsets 为准，不能把镜像直接 cast 为宿主 ABI struct 后假设 padding/endian 恰好相同。

### 8.3 目录文件与 8.3 名字

早期 FAT directory 是固定大小 entry 数组；8-byte base name + 3-byte extension 省空间且解析简单。metadata 跟 name 放在 dirent，导致：

- 重命名和 metadata 更新集中，但多个名字共享同一对象很难表达；
- 原生模型不支持 UNIX hard link；
- long filename 后来通过兼容 entry 序列补上，解析/一致性更复杂。

这是典型系统演化：旧格式的兼容性一旦成为生态合同，后来功能常以“补丁数据结构”叠加。

---

## 9. readfat：从手册到解析器的正确工作流

课堂 Demo 展示从 FAT 手册摘出 BPB、FAT 和 directory entry 字段，用 `mmap` 把**镜像文件**映射到进程地址空间，再像读数据结构一样遍历。LLM 可以加速抄字段和生成 parser，但质量保证仍依赖不变量检查。

一个可靠的只读解析器至少要验证：

1. image 长度覆盖 boot sector 和声明的区域；
2. bytes/sector、sectors/cluster 是格式允许的值；
3. FAT、root directory、data region 的计算不会整数溢出/越界；
4. cluster number 在合法范围，链不会无限循环；
5. file size 不要求读取超过 chain/image；
6. 任何 malformed entry 都返回错误，而不是越界解引用。

### 9.1 地址推导

若 data region 从 sector `first_data_sector` 开始，cluster numbering 从 2 开始，则：

```text
first_sector(cluster c)
  = first_data_sector + (c - 2) * sectors_per_cluster

byte_offset(c)
  = first_sector(c) * bytes_per_sector
```

这里的 `-2` 是格式合同，不是“数组下标习惯”。readfat Demo 的真正价值是训练一种方法：**先根据规范推导 offset，再对每次读取做 bounds check，最后才解释字段。**

不要对真实可写分区运行未经审计的 parser，更不要让教学程序“顺便修复”。普通 image + read-only `mmap` 足够观察所有结构。

---

## 10. UNIX 的选择：把顶点与边分开

把 namespace 看作图 `G(V,E)`：

- inode 是 vertex：对象类型、mode、uid/gid、size、timestamps、link count、data mapping；
- directory entry 是 labeled edge：`(parent inode, name) -> child inode number`；
- hard link 是多条 name edge 指向同一 inode；
- inode 的 link count 近似记录有多少持久 directory entries 指向它。

这比“目录里存完整文件 metadata”更适合 UNIX 语义。`fstat(fd)` 已经持有 inode 引用，不需要倒查文件名；rename 主要改变 edge，不必搬运 file data。

### 10.1 bitmap 分配与 locality

block bitmap 的一位表示一个 block/cluster 是否占用；inode bitmap 的一位表示 inode-table slot 是否占用。bitmap 比 FAT linked list 更容易批量找连续 free run，并能把 inode、目录、data 放进相近 block group。

必须保持：

```text
bitmap says allocated <=> block/inode belongs to a live structure
```

crash 可能打破双向条件：

- bitmap=free 但 inode 已引用：以后重新分配会让两个对象共享 block；
- bitmap=allocated 但无人引用：空间泄漏，安全性通常好于交叉链接，但容量减少。

### 10.2 ext2 的 fast/slow path：direct + indirect

经典 ext2 inode 有 12 个 direct pointers，再加 single、double、triple indirect pointer。设 block size 为 `B`，pointer size 为 4 bytes，`P=B/4`，可寻址 data blocks 为：

```text
12 + P + P^2 + P^3
```

4 KiB block 时 `P=1024`：小文件前 48 KiB 无需读 indirect block；超大文件再付 1–3 层索引代价。inode 体积变大换来 small-file fast path。

现代 ext4 默认更多使用 extent tree，把连续范围表达为 `(logical_start, physical_start, length)`，减少大连续文件的 mapping metadata；不能把 ext2 pointer 数组原样当成所有 UNIX filesystem 的现代实现。

### 10.3 directory 仍然是文件，但有专用解释

概念上 directory data 是一串 `name -> inode_number` records。小目录可 linear scan，大目录可用 hash tree 等索引。多个 dirent 可指同一 inode，于是 hard link 自然成立；不同 filesystem 的 inode number 属于不同 namespace，所以 ordinary hard link 不能跨 mount。

ext4 还会利用 inode 内固定空间做 fast symlink：短 target 可直接 inline，免分配 data block。PPT 给出的 `<= 60B` 是经典 ext2/ext4 inode 布局下常见阈值；启用不同 inode features/format 时应以工具实际输出为准，不把它提升为 POSIX 保证。

---

## 11. Debug File Systems：让不可见的 inode/dirent 变成证据

`debugfs` 能在 user space 解析 ext-family filesystem。课堂 Demo 的目的不是记住交互命令，而是把这条路径可视化：

```text
path component
 -> parent directory block
 -> directory entry
 -> inode number
 -> inode table slot
 -> extent/block mapping
 -> data block
```

对真实 mounted filesystem 使用 debugfs 写模式会绕过内核协调并破坏数据。下面实验只创建一个新的普通文件 image；不使用 loop、不 mount、不接触 `/dev/*`。

### 11.1 实验一：无特权解析临时 ext4 image

依赖 `mke2fs/mkfs.ext4`、`dumpe2fs`、`debugfs`。逐字执行；`image` 固定来自新建临时目录，并在写入前验证为普通文件。

```bash
lab=$(mktemp -d /tmp/lect26-ext4.XXXXXX) || exit 1
case "$lab" in /tmp/lect26-ext4.*) [ -d "$lab" ] || exit 1 ;; *) exit 1 ;; esac
image="$lab/fs.img"
cleanup_ext4_lab() {
  rm -f -- "$image"
  rmdir -- "$lab" 2>/dev/null || true
}
trap cleanup_ext4_lab EXIT HUP INT TERM

truncate -s 32M "$image" || exit 1
test -f "$image" && test ! -L "$image" || exit 1
/usr/sbin/mkfs.ext4 -q -F "$image" || exit 1

/usr/sbin/dumpe2fs -h "$image" 2>/dev/null |
  sed -n '/Filesystem volume name/p;/Filesystem UUID/p;/Filesystem features/p;/Block size/p;/Block count/p;/Inode count/p'
/usr/sbin/debugfs -R 'stats' "$image" 2>/dev/null | sed -n '1,36p'
/usr/sbin/debugfs -R 'stat <2>' "$image" 2>/dev/null | sed -n '1,24p'

rm -f -- "$image"
rmdir -- "$lab"
trap - EXIT HUP INT TERM
unset -f cleanup_ext4_lab
```

预期看到 ext4 magic/features、通常为 4096 的 block size（环境/参数可不同）、block/inode counts，以及 inode 2 的 root-directory metadata 与 extents/blocks。空 image 仍有 superblock、group descriptors、bitmaps、inode tables、journal、root 与 `lost+found`，所以 allocated blocks 不为零。

这个实验没有验证 mounted kernel 行为，也没有制造真实 crash。`debugfs` 版本、默认 mkfs features 和发行版配置会改变字段；应解释结构关系，不硬编码某个 inode 除 root inode 2 之外的编号。若缺少工具就跳过，绝不要把 `$image` 替换成真实设备来“省事”。

Linux 官方 [ext4 block-group 文档](https://docs.kernel.org/filesystems/ext4/blockgroup.html)给出的典型布局是 superblock/group descriptors、block bitmap、inode bitmap、inode table、data blocks；`flex_bg` 等特性会重排细节，因此课堂简图是模型，不是每个 image 的逐块模板。

---

## 12. 存储系统：应对崩溃

crash model 是本讲后半段的起点：在任意指令/写回阶段掉电或 kernel panic，volatile RAM 丢失；已经可靠写入非易失介质的 bytes 保留。进程 crash、kernel crash、整机断电和单设备故障不是同一个 failure model，本章主要讨论整机 crash/power loss 后的本地持久状态。

### 12.1 crash consistency 的目标

若一次 append 从一致状态 `S0` 变为一致状态 `S1`，理想原子语义是 recovery 后只见二者之一：

```text
before: inode.size=n, no new mapping, block free
after:  inode.size=n+B, mapping includes d, d allocated, data valid
```

不能留下 `size` 已增但 mapping 缺失、mapping 指向 free block、或旧文件突然暴露别人残留 bytes 的中间态。

注意两种不同目标：

- filesystem structural consistency：allocator、inode、directory 图可挂载且不交叉引用；
- application semantic consistency：例如转账两行记录要么都出现，要么都不出现。

journal 通常首先保护前者；应用必须用自己的协议保护后者。

---

## 13. 暗藏杀机的数据结构：一次 append 不是一次写

假设向文件尾追加一个完整 filesystem block，旧 inode 没有预留 extent。最小实现通常要修改：

1. data-block bitmap：把 block `d` 从 free 改为 allocated；
2. data block `d`：写入用户 payload；
3. inode table block：加入 mapping，增大 `size`，更新时间；
4. 可能还有 free-count、extent-tree block、quota 等派生 metadata。

讲义把核心简化成：

```c
bwrite(data_bitmap_block);
bwrite(d);
bwrite(inode_table_block);
```

关键不在这三行的源码顺序，而在 crash 可以把持久状态截在任意子集。定义三个布尔量：

```text
B: bitmap[d] == allocated
D: block d contains new payload
I: inode maps new logical block to d and size includes it
```

旧状态是 `000`，新状态是 `111`。其他组合都有问题：

| 持久组合 BDI | 可能后果 |
| --- | --- |
| `100` | block 泄漏；无人引用但 allocator 不再使用 |
| `010` | 新 payload 写在仍被认为 free 的 block；稍后可被覆盖 |
| `001` | inode 引用 free/旧内容，可能暴露别的文件残留数据 |
| `110` | bitmap 与 data 已新，但 inode 未引用；空间泄漏 |
| `101` | inode 引用已分配 block，但内容旧/撕裂 |
| `011` | 文件可见但 allocator 可把同一 block 再分给别处，交叉链接 |

这个表也解释“为什么先写 data 再写 metadata”只能减少某些危险，不等于 transaction。只靠一种固定顺序无法把三个独立写变成原子操作；crash 仍可能发生在相邻步骤之间。

### 13.1 overwrite、append、create、rename 的更新集合不同

- overwrite 已分配 block 可能不改 bitmap/inode mapping，但 data block 自身仍会 torn；
- append 常改 data、mapping 和 size；
- create 还要分配 inode，并在 parent directory 插入 dirent；
- unlink 要删 dirent、减 link count，最后可能释放 inode 与 data blocks；
- rename 涉及一个或两个 parent directories，替换目标时还会改变目标 link count。

所以不能用“ext4 有 journal”代替逐操作分析。先列出本次更新触碰哪些持久对象，再谈 ordering/recovery。

### 13.2 torn write：连一个 block 都未必全有或全无

设备可能以 sector、atomic-write unit 或内部 page 更新；filesystem block 往往更大。掉电时一个 4 KiB block 可能只有部分 sectors 是新版本，称为 torn write。具体 atomicity 取决于设备合同、对齐、长度、协议和 filesystem 支持，普通 buffered write 不应默认具备整 block power-fail atomicity。

常见防护包括：

- checksum 检测“不是合法旧版也不是合法新版”；
- 双副本/镜像与 generation number 选择完整版本；
- copy-on-write 后原子切 root pointer；
- journal record + commit marker，只接受完整 committed transaction；
- 支持时使用 hardware atomic write，但仍要处理多 block transaction。

checksum 主要负责检测，不能凭空恢复正确 bytes；恢复还需要冗余或可重算信息。

---

## 14. 层次化存储结构带来的问题：持久顺序要穿过所有队列

一次 `write()` 可能经过：

```text
application/libc buffer
  -> page cache / dirty inode
  -> filesystem writeback and journal transaction
  -> block scheduler / blk-mq queue
  -> device controller volatile cache
  -> SSD FTL mapping/cache or HDD scheduling
  -> nonvolatile medium
```

每一层都有合并、延迟和重排的理由：

- page cache 等待合并多次小写；
- filesystem delayed allocation 等待更好的 extent；
- block layer 与 HDD scheduler 改善 seek/locality；
- NVMe 有多 submission/completion queues；
- SSD FTL 把 logical page 改写映射到另一个 physical page；
- controller cache 可能先确认，再晚些写介质。

这确实类似 relaxed memory：program order 不自动等于 observation/persistence order。但类比的边界也要说清：CPU memory model 用 load/store/fence 定义多核可见性；storage stack 用 writeback、flush、FUA、journal commit、`fsync` 定义 crash 后持久性。两套 barrier 不可互换。

### 14.1 三种顺序必须分开

```text
submission order: 上层何时发出 request
completion order: 设备何时报告各 request 完成
persistence order: crash 后哪些内容真的可恢复
```

若设备正确实现 cache flush，filesystem 可在阶段间发 flush 建立 happens-before：

```text
write journal payload
flush
write commit record (possibly FUA)
flush/confirmed stable
```

若硬件/虚拟化层谎报 flush 或电源保护有缺陷，上层正确协议也会失效。这属于 lower-layer contract violation，不能由 fsck 猜出所有丢失数据。

---

## 15. 乱序执行：后果不只是“丢最后几秒”

假设程序按 `bitmap -> data -> inode` 提交，设备可能先持久 inode，再 bitmap，最后 data。掉电若发生在 inode 后，就落入前表的 `001`：文件 size 已增长，映射却指向被 allocator 认为 free 的 block。

更糟的安全问题是 stale-data exposure：若 `d` 曾属于另一个文件，inode/size 先落盘而新 data 未落盘，重启后读取新文件可能得到旧用户 bytes。因此 data-before-metadata ordering 不只是结构整洁，也是 confidentiality 边界。

### 15.1 volatile write cache

`bwrite` request completed 可能只表示 controller DRAM 收到数据。若 cache 没有 battery/capacitor，power loss 会清空它。正确 stack 要么禁用不诚实 cache，要么使用 flush/FUA 并相信设备完成语义。

虚拟机和 network storage 又多一层：guest 的 flush 要被 hypervisor、host filesystem、remote server 一路传播。测试只在某个 ext4 laptop 成功，不证明另一个 kernel/filesystem/cloud volume 有同样 persistence properties。

### 15.2 早期 SSD/firmware 的更大故障面

HDD 时代 filesystem 主要担心上层 metadata；SSD controller 自己还有 L2P mapping、GC、wear metadata。若 controller 内部恢复设计有 bug，FTL crash 可能让多个 LBAs 错映射或设备不可用，而不仅是丢一笔 host write。

因此 failure model 要写进结论：本章大多数协议假设 block device 在 flush 后可靠保存对应数据，并在故障后继续给出相同 LBA 语义；介质永久损坏、firmware bug、silent corruption 还需 RAID、checksums、backup、scrub 等机制。

---

## 16. Systems：“先挣钱，后还债”

缓存、延迟分配和异步 writeback 先赚取性能：应用很快返回，磁盘获得较大且更连续的 request。债务是内存中的 dirty state 和磁盘上的暂时不一致；正常运行时后台慢慢偿还，crash 则突然要求 recovery 接手账本。

历史系统常把昂贵恢复推迟到 reboot：平时 fast path 简单，出事后跑 File System Check。这是一种合理但代价明显的工程点：

- reboot 可能扫描整个大盘，恢复时间随容量增长；
- 工具只能依据残存结构推测“最可能状态”；
- 用户数据内容可能不可恢复；
- 修复工具本身也是复杂、可崩溃的软件；
- 错误操作或隐私泄露会把技术故障变成现实伤害。

讲义的社会案例提醒我们：recovery 工具拥有读取大量残留数据的能力，必须受授权、最小访问、审计和隐私规范约束。本章实验只处理自己新建的临时镜像。

---

## 17. File System Checking（FSCK）：从残存图重建“最可能”不变量

fsck 不知道 crash 前应用“想做什么”，它只有磁盘上当前的 graph 和格式规则。典型检查可抽象为：

1. 从 superblock/备份找到布局，验证 feature 和范围；
2. 扫描 allocated inodes，检查 type、size 与 block pointers/extents；
3. 建立每个 data block 的实际引用计数，找越界/重复引用；
4. 遍历 directories，验证 dirent 指向合法 inode，统计 observed links；
5. 对比 inode link count、inode bitmap、block bitmap 和 free counters；
6. 修复可推断差异，把失去名字但仍像文件的 inode 接到 `lost+found`；
7. 对无法安全决定的冲突报告/请求策略，而非伪造原内容。

### 17.1 fsck 能恢复什么

- bitmap 与实际引用不一致：可按扫描结果重建；
- free counters 不符：可重新计数；
- orphan inode 仍有有效 data mapping：可保留对象并给临时名字；
- directory entry 指向无效 inode：可删除坏 edge；
- duplicate block：可复制、截断或选择一方，但不知道哪一方语义正确。

### 17.2 fsck 不能恢复什么

- 被覆盖且无副本的 user bytes；
- 应用 transaction 的业务语义；
- 丢失的原 filename/parent，若没有日志或其他线索；
- 设备 silent corruption 后“哪一个副本正确”，若无 checksum/冗余；
- 尚在 volatile cache、从未达到介质的更新。

fsck 是**全局不变量修复**，journal replay 是**已提交操作重做**。它们可以共存：journal 处理常见 crash 的快速恢复，fsck 处理 journal 无法覆盖的损坏、bug 或更深不一致。

### 17.3 修复器自己也必须 crash consistent

若 fsck 原地改数百万个 metadata locations，修到一半再次掉电，状态可能比起点更复杂。因此 checker 需要 pass ordering、可重入/幂等更新、redo information 或先生成修复计划。讲义链接的 [“fsck crash”论文](https://dl.acm.org/doi/10.1145/3281031)正是在提醒：恢复程序不是 failure model 之外的魔法。

Git 的 `git fsck` 检查 object graph，与 filesystem fsck 层次不同。Git object 多采用 content-addressed、append-like 写入，有利于恢复，但 refs、index、working tree 等仍需要各自的原子更新协议。

---

## 18. 实现崩溃一致性：重新理解“数据结构”

### 18.1 视角一：只存当前形状

链表只存 next pointers，树只存当前 nodes，filesystem 只存当前 bitmap/inode/dirent。查询直接，但一次逻辑操作要 in-place 改多个位置；中途 crash 会暴露半完成形状。

### 18.2 视角二：先追加历史操作

把操作写成 append-only records：

```text
ALLOC block 417
WRITE block 417 hash=...
SET inode 12 size=8192 extent=...
COMMIT tx=93
```

只要能可靠判断 log 中最后一个完整 committed transaction，就能从旧 checkpoint 重放历史得到新状态。追加通常顺序、易 batching，也避免随机 in-place 小写；代价是：

- log 会无限长，需要 checkpoint/compaction；
- replay 要幂等，或记录 generation/LSN；
- tail 可能 torn，需要 length/checksum/commit marker；
- log 自身空间回收也要 crash safe；
- “日志已写”必须通过 flush 建立真实持久顺序。

正确设计常把两种视角组合：current structure 给 fast read，log 给 atomic update/recovery，后台 checkpoint 偿还重复存储与重放成本。

---

## 19. Append-only + Lazy Update：把随机更新变成顺序工作

CPU store buffer 的类比是“先在近处记录，再异步传播”，但 storage log 需要明确 persistence 和 recovery；它不是 CPU cache 的直接复制。

### 19.1 LSM tree 的分层

典型 LSM 结构：

```text
WAL:      append every accepted update, durable boundary
MemTable: mutable in-memory ordered map
SSTable:  immutable sorted runs on storage
Merge:    compact overlapping runs, discard shadowed versions
```

读操作从新到旧查多个 levels，小 table 的新 value override 大 table 的旧 value；Bloom filter、index/cache 减少无效查找。MemTable 满后 flush 为 immutable SSTable；后台 compaction 以额外读写放大换查询性能和空间回收。

“amortized O(1)”必须带模型：顺序写和分层 merge 摊销 allocator/index 代价，但不同 size ratio、leveled/tiered policy、value size 与 device 会得到不同 write amplification、read amplification 和 tail latency。

LSM 的 WAL 保护尚未 flush 的 MemTable；SSTable 成功安装到 manifest 后，相应 WAL 才能安全回收。这个依赖关系将在数据库讲发展为更完整的 transaction/recovery。

---

## 20. 文件系统中的 Write-ahead Log：先让恢复信息发生

一个 redo-journal transaction 可写成：

```text
1. append descriptor/TXBegin + metadata after-images
2. flush journal payload
3. append commit record/checksum
4. flush until commit is persistent
5. report transaction committed
6. checkpoint logged blocks to home locations
7. after checkpoint is durable, reclaim old log space
```

第 2–4 步建立关键 happens-before：commit marker 只有在 payload 完整持久后才允许成为有效证据。crash recovery 扫 log：

- 没有完整 commit/checksum 的 tail 丢弃；
- committed transaction replay 到 home locations；
- replay 中再次 crash，after-image 写入应幂等，下一次继续 replay；
- checkpoint 完成后才能越过/回收对应 log。

### 20.1 为什么 checkpoint 时 crash 仍可恢复

home locations 可能只更新了一半，但 committed journal 仍保留完整 after-images；重启后再次 replay，直到所有 home blocks 与 transaction 一致。只有确认 checkpoint 持久后，才可把那段 journal 当 free。

### 20.2 redo、undo 与 physical/logical logging

- redo 记录 new value：commit 后重放；
- undo 记录 old value：未提交修改若已到 home，可回滚；
- physical log 记录 block/byte image，恢复直接但体积大；
- logical log 记录“insert dirent”之类操作，紧凑但幂等/并发恢复更复杂。

PPT 主线使用 redo log；真实数据库/文件系统可能组合多种形式。

### 20.3 实验二：校验如何截断 torn WAL tail

仓库 [wal_kv.c](../../examples/wal_kv.c)每次 append 写 header/key/value、checksum 并 `fsync`。它不是多操作 transaction manager，但很适合观察“完整记录可重放，撕裂尾部应停止”。编译输出与日志都放在新建 `/tmp` 目录：

```bash
lab=$(mktemp -d /tmp/lect26-wal.XXXXXX) || exit 1
case "$lab" in /tmp/lect26-wal.*) [ -d "$lab" ] || exit 1 ;; *) exit 1 ;; esac
tool="$lab/wal_kv"
log="$lab/state.wal"
torn="$lab/torn.wal"
cleanup_wal_lab() {
  rm -f -- "$tool" "$log" "$torn"
  rmdir -- "$lab" 2>/dev/null || true
}
trap cleanup_wal_lab EXIT HUP INT TERM

cc -std=c11 -O2 -Wall -Wextra -D_GNU_SOURCE \
  examples/wal_kv.c -o "$tool" || exit 1
"$tool" set "$log" color blue
"$tool" set "$log" count 42
echo 'complete log:'
"$tool" dump "$log"

cp -- "$log" "$torn"
bytes=$(stat -c %s "$torn") || exit 1
test "$bytes" -gt 3 || exit 1
truncate -s "$((bytes - 3))" "$torn"
echo 'torn copy:'
"$tool" dump "$torn"

rm -f -- "$tool" "$log" "$torn"
rmdir -- "$lab"
trap - EXIT HUP INT TERM
unset -f cleanup_wal_lab
```

典型输出是完整 log 有两条 `SET`；torn copy 只打印第一条，并报告忽略 record 1 的 torn tail。原 log 不被破坏，截断只发生在副本。

这个实验模拟 record 边界损坏，并没有真的切断电源，也不能证明 `fsync` 下方硬件诚实。toy header 直接写 C integer，未定义跨 endian/ABI 的永久格式；生产格式还要规定 byte order、version、最大长度、transaction ID 和 recovery policy。

---

## 21. Journaling Tricks：让正确协议不至于慢到不可用

### 21.1 batching / group commit

多个系统调用的 metadata updates 可以合并为一个 journal transaction，共享 descriptor、commit 和 flush。xv6 的 log 是教学版；Linux ext4 的 jbd2 是工业版。batch 越大，单位操作 flush 成本越低，但 crash 时尚未提交的工作窗口与单次 checkpoint 压力也更大。

### 21.2 checksum 取代脆弱的 begin/end 猜测

transaction descriptor 记录长度/targets，commit block 携带 sequence/checksum。recovery 只接受记录数、边界和 checksum 都合法的 transaction；随机旧 bytes 恰好像 `TxEnd` 的风险降低。checksum 仍需 transaction ID/generation 避免环形 log wrap 后把旧 record 当新 record。

Linux 官方 [ext4 jbd2 文档](https://docs.kernel.org/filesystems/ext4/journal.html)说明：完整 transaction 以 commit block 结束；没有 commit 或 checksum 不匹配的 transaction 在 replay 时丢弃，之后再 checkpoint 到 home locations。

### 21.3 metadata journaling 与 data journaling

必须精确区分 ext4 的三种常见 data mode：

| 模式 | journal 中有什么 | 对 file data 的关键 ordering | crash 后主要边界 |
| --- | --- | --- | --- |
| `data=journal` | data + metadata | 两者先经 journal | 最强，但重复写 data、通常最慢 |
| `data=ordered`（常见默认） | metadata | 与新 metadata 关联的 data 先写 home，再 commit metadata | 防止新 metadata 暴露未初始化旧 data；不提供应用 transaction |
| `data=writeback` | metadata | data 可在 metadata commit 后写 | 结构可恢复，但新近文件内容可能旧/不期望 |

metadata journaling 保证的核心是 filesystem structure 可恢复，不是“所有最近 data 一字不丢”。`data=ordered` 也不是 full data journaling；它通过 ordering 获得重要安全性质。

### 21.4 revoke、checkpoint 与 journal reuse

若一个 block 在同一 recovery window 被释放/重新用途改变，旧 transaction 的 replay 不能覆盖更新用途；jbd2 revoke record 可告诉 recovery 跳过已失效的旧写。journal 是循环空间，只有对应 checkpoint 确认持久后才能复用，否则 wrap 会抹掉唯一 recovery copy。

真实 ext4 还包括 fast commit、delayed allocation、checksums 和不同 feature/mount options。这里的 transaction 图是推理模型；精确行为以运行 kernel、filesystem options 和 [Linux ext4 文档](https://docs.kernel.org/admin-guide/ext4.html)为准。

---

## 22. 应用程序的崩溃一致性：文件系统一致不等于文件内容正确

考虑讲义中的更新：

```python
Path("a.txt.tmp").write_text(new_contents)
unlink("a.txt")
rename("a.txt.tmp", "a.txt")
```

这有一个明显窗口：`unlink` 已持久而 `rename` 未持久，crash 后目标完全消失。即使去掉 `unlink`，让同文件系统 `rename(temp,target)` 原子替换名字，也只保证 live observers 不看到半个 directory entry；它不自动保证 temp data 已持久，也不自动保证新 directory entry crash 后仍在。

### 22.1 正确目标要先写清

常见“持久替换”希望：

1. 正常并发 reader 只看旧完整版本或新完整版本；
2. 成功返回后 crash，重启仍可通过目标名读到新完整版本；
3. crash 若发生在成功返回前，允许旧版或新版，但不允许半内容；
4. 不把临时文件建在另一 filesystem，避免 `rename` 变成 `EXDEV`；
5. 每个失败的 syscall 都被检查，临时残留可安全清理。

满足它通常需要：

```text
create temp in same directory/filesystem
write all bytes
fsync(temp)                 # payload + required inode metadata
rename(temp, target)        # atomic namespace replacement
fsync(parent_directory)     # persist directory entry change
```

若第一次创建 parent directory、跨两个 directories rename、还需删除旧 auxiliary files，必须逐一分析哪些 directory entries 需要同步。不能把一条 recipe 无条件推广到所有 filesystems、network protocols 和 OS。

### 22.2 persistence properties 会因文件系统而异

PPT 引用的 [OSDI 2014 “All File Systems Are Not Created Equal”](https://www.usenix.org/conference/osdi14/technical-sessions/presentation/pillai)研究了应用 update protocols 对底层 filesystem atomicity/ordering properties 的依赖，并在常用系统中发现大量 crash vulnerabilities。它支持的方法论是：不要依赖“我这台机器试过没坏”，而要声明 protocol 需要的 persistence properties，并跨配置验证。

---

## 23. sync() 系列系统调用：把“何时持久”变成应用协议

### 23.1 四个容易混淆的层次

```text
stdio fflush(stream)  : libc buffer -> kernel
write(fd, ...)        : copy/accept into kernel state; normally not durable
fsync/fdatasync       : wait for one file's required state to storage
fsync(parent dir)     : persist namespace/directory-entry change
```

`close(fd)` 也不等于 `fsync(fd)`；它释放描述符，writeback error 甚至可能更晚才暴露。应用要以系统调用返回值和明确持久点组织 protocol。

### 23.2 `sync()`：全局、粗粒度

`sync()` 要求全系统相关 dirty filesystem state 被同步，是关机、管理命令或诊断中的粗粒度工具。一个普通应用用它提交自己的几 KiB state，会连带别的进程和文件系统，造成不必要 I/O 与不可控 latency；它也没有把“哪些文件共同构成一个事务”表达出来。

### 23.3 `syncfs(fd)`：一个 mounted filesystem

Linux `syncfs(fd)` 把范围缩到 `fd` 所在 filesystem。它仍比单文件 protocol 粗，适合管理工具或需要整个 filesystem 边界的场景，不是数据库每条 transaction 的默认选择。

### 23.4 `fsync(fd)` 与 `fdatasync(fd)`

- `fsync` 同步 file data 和与该 file 关联的 metadata；
- `fdatasync` 可省略不影响后续正确读取的 metadata，例如纯 timestamp 变化；
- `size`、block mapping 等是读回 data 所必需，`fdatasync` 仍要同步；
- 两者都可能返回 `EIO`、`ENOSPC` 等，成功 protocol 必须处理错误；
- 同步 file 本身不必然同步“这个名字存在于 parent directory”。

Linux [fsync(2)](https://man7.org/linux/man-pages/man2/fsync.2.html)明确说明：为保证 containing directory entry 到盘，还需对 directory fd 调用 `fsync`。[rename(2)](https://man7.org/linux/man-pages/man2/rename.2.html)保证同 filesystem 替换的原子可见性；两者合起来才解释“rename 原子却仍要 fsync(dir)”。

### 23.5 一个最小持久替换协议

仓库的 [atomic_replace.c](../../examples/atomic_replace.c)执行：

```text
mkstemp(target.tmp.XXXXXX) in same directory
write_all
fsync(temp fd)
close(temp fd)
rename(temp, target)
open(parent directory)
fsync(parent fd)
```

`mkstemp` 同目录是为了确保 rename 不跨 filesystem，并避免可预测临时名 race。`write_all` 处理 short write/EINTR；每个关键 syscall 都检查错误。

### 23.6 实验三：只在临时目录运行 `atomic_replace`

编译产物、target 和 trace 全在唯一 `/tmp` 目录；不会触碰仓库数据或真实块设备：

```bash
lab=$(mktemp -d /tmp/lect26-replace.XXXXXX) || exit 1
case "$lab" in /tmp/lect26-replace.*) [ -d "$lab" ] || exit 1 ;; *) exit 1 ;; esac
tool="$lab/atomic_replace"
target="$lab/config.txt"
trace="$lab/trace.txt"
cleanup_replace_lab() {
  rm -f -- "$tool" "$target" "$trace"
  rmdir -- "$lab" 2>/dev/null || true
}
trap cleanup_replace_lab EXIT HUP INT TERM

cc -std=c11 -O2 -Wall -Wextra -D_GNU_SOURCE \
  examples/atomic_replace.c -o "$tool" || exit 1
"$tool" "$target" old-version

if command -v strace >/dev/null 2>&1; then
  if strace -o "$trace" -e trace=openat,write,fsync,rename,close \
       "$tool" "$target" new-version; then
    grep -E 'fsync|rename' "$trace"
  else
    echo 'strace/ptrace unavailable; running update without trace' >&2
    "$tool" "$target" new-version
  fi
else
  "$tool" "$target" new-version
fi
printf 'target: '
sed -n '1p' "$target"

rm -f -- "$tool" "$target" "$trace"
rmdir -- "$lab"
trap - EXIT HUP INT TERM
unset -f cleanup_replace_lab
```

预期 target 最终是 `new-version`；trace 的关键相对顺序为 temp-file `fsync`、`rename`、parent-directory `fsync`。额外 `openat/close/write` 来自 dynamic loader、stdio 或实现细节，不影响协议判断。

这不是安全的真实掉电实验，不能由一次 trace 证明 crash 后状态。tmpfs 可能把“持久化”退化为内存语义；NFS、FUSE、overlay、旧 kernel 或某些 filesystem 对 directory `fsync`/error reporting 的支持不同。先用 `findmnt -T "$lab"` 记录环境，协议保证应以目标平台文档与 fault-injection test 为准。

### 23.7 `rename + fsync` 仍不是万能 transaction

- 它适合一个 name 指向的单文件全量替换；
- 同时修改多个目标文件仍有中间状态，需要 manifest/WAL/directory swap 等更高层协议；
- 跨 filesystem rename 返回 `EXDEV`，copy+unlink 不是单一原子操作；
- 若新建了目录层级，还要同步相应 parent；
- 若数据在另一个服务或数据库，还要协调另一个 durability domain；
- `fsync` 让已写 bytes 达到文件系统承诺的持久边界，不验证内容语义正确。

---

## 24. 《操作系统》课到底教会了我们什么？从 API 到可证伪实验

多记了 `fsync/fdatasync` 两个名字，不等于掌握 crash consistency。本课程训练的系统方法是：

1. 写出状态机：persistent objects、operations、invariants；
2. 明确 failure model：process kill、kernel panic、power loss、device failure；
3. 标记 persistence points，而不是只看 syscall program order；
4. 在每个可能的 crash point 截断执行；
5. recovery 后检查 structural 与 application invariants；
6. 跨 filesystem、mount options、kernel/device stack 验证依赖；
7. 把反例缩小到可复现 trace，再修 protocol。

### 24.1 Vibe code checker，也要有 specification 与 oracle

Coding Agent 可以快速读论文、生成 tracer、枚举 workload、搭 VM、归纳 failure signatures；但三个核心判断不能靠“看起来合理”：

- trace 是否覆盖真实写入路径？`mmap` dirty page、io_uring、child process、库的后台线程是否漏掉？
- crash image 是否符合设备允许的 atomicity/ordering，而不是任意拼接不可能状态？
- oracle 是否正确？“文件能打开”不代表业务 transaction 一致。

LLM 最适合扩大机械实验和辅助分类；conceptual novelty、failure model 与 correctness argument 仍需要研究者负责。把经典论文实验规模扩大 100 倍可能有工程价值，但不能自动制造新科学问题。

---

## 25. Crash Consistency Checker：trace、枚举、恢复、判定

课堂 ccheck Demo 是 user-space、strace-based checker。一个简化架构是：

```text
run program in isolated temp workspace
  -> trace open/write/rename/unlink/fsync/... events
  -> identify persistence boundaries
  -> generate candidate crash points / persistence subsets
  -> reconstruct each candidate image
  -> run recovery or reopen state
  -> check declared invariants
  -> minimize and report counterexample
```

### 25.1 为什么要 trace syscall

syscall trace 把源代码层复杂库调用还原为文件对象操作，并记录 fd/path 生命周期。checker 可问：target rename 前 temp 是否同步？parent directory 是否同步？两个 data files 之间是否有 WAL commit？

但 strace 观察的是 system-call boundary，不直接知道 block/journal/FTL 的最终顺序。它还要正确跟踪 `fork/exec/dup/chdir/*at`、fd reuse、hard link、rename 后 path 身份；否则 trace 本身就会误归因。

### 25.2 crash-state enumeration 不能简单取任意子集

现实系统有约束：

- 同一 write 内可能按 atomic unit 撕裂；
- `fsync` 成功建立某些前序持久关系；
- journal transaction commit/replay 会折叠若干中间态；
- filesystem 特定 persistence properties 排除某些 reorder；
- device 诚实 flush 与不诚实/故障设备是不同模型。

枚举过弱会漏 bug，枚举过强会报告硬件永远不可能产生的 false positive。checker 的模型必须可检查、可替换并写进报告。

### 25.3 oracle：什么叫“没有数据不一致”

最低层可跑 fsck/只读 mount 并检查 graph；应用层应提供 predicate，例如：

```text
config parses && version in {old,new}
sum(account balances) == constant
manifest references only existing checksum-valid objects
index represents exactly committed log prefix
```

让 LLM 阅读 output、帮助产生候选 invariant 有用，但最终 oracle 必须 deterministic、可复现；否则模型的一次判断不能成为 correctness evidence。

### 25.4 安全边界

checker 只在 disposable VM、copy-on-write snapshot 或自己创建的普通 image/temp directory 中制造 crash states。不要 kill 宿主 kernel，不要 power-cycle 保存数据的设备，不要对 mounted root filesystem 重放 raw writes。每个 case 使用唯一目录，记录 filesystem/kernel/mount/device 信息，并在失败/信号路径清理。

课堂页面 `[Crash Consistency Checker](/OS/demos/persistence/ccheck)` 的重点是把论文方法变成可运行反馈环；它不是 MiniLab 的直接答案，也不是对所有 storage stack 的形式证明。

---

## 26. Takeaways：文件系统是“数据结构 + 持久更新协议”

1. block device 也可以由 GPT、LVM、device mapper、controller/FTL 多层数据结构虚拟化；文件系统只看到最终 logical blocks。
2. superblock 是入口；bitmap 管分配，inode 管对象与 logical-to-physical mapping，directory 管 name-to-inode edges。
3. FAT 把 mapping 表达为 cluster linked list；UNIX 分离 inode 与 dirent，天然支持 hard link，并用 direct/indirect 或 extents 兼顾大小文件。
4. cache、delayed allocation 和 request reorder 赢得性能，却让一次逻辑操作变成多个异步、可撕裂、可乱序的持久写。
5. fsck 从残存 graph 修 structural invariants，但无法恢复从未落盘的 bytes 或应用意图。
6. WAL 先持久化恢复信息，再写 commit，之后 checkpoint；journal 把这一思想用于 filesystem metadata/data。
7. metadata journaling 保护结构，不等于应用 data transaction；`data=ordered`、`writeback`、`journal` 的边界不同。
8. 应用必须用 `fsync/fdatasync`、atomic rename、directory fsync 或自己的 WAL 明确 durability protocol。
9. crash checker 的价值来自 failure model、persistence model 和 oracle，而不只是自动执行很多次。

把整讲压缩成一个不变量：

```text
任何“成功提交”的状态，都必须有足够且已持久的证据，
让 recovery 在任意 crash 后唯一地选择/重建一个合法状态。
```

---

## 27. 阅读材料与下一讲衔接

PPT 指定 OSTEP：第 40 章 File System Implementation、第 41 章 Locality and FFS、第 42 章 Crash Consistency: FSCK and Journaling、第 43 章 Log-Structured File Systems。建议带着四张表阅读：on-disk objects、update set、crash states、recovery rule。

选择性扩展资料：

- Linux [ext4 on-disk structures](https://docs.kernel.org/filesystems/ext4/index.html)与 [jbd2 journal](https://docs.kernel.org/filesystems/ext4/journal.html)；
- Linux man-pages 的 [fsync(2)](https://man7.org/linux/man-pages/man2/fsync.2.html)与 [rename(2)](https://man7.org/linux/man-pages/man2/rename.2.html)；
- [OSDI 2014 application crash consistency study](https://www.usenix.org/conference/osdi14/technical-sessions/presentation/pillai)；
- PPT 给出的 [Microsoft FAT specification](https://jyywiki.cn/OS/manuals/MSFAT-spec.pdf)和 [fsck crash 论文](https://dl.acm.org/doi/10.1145/3281031)。

下一讲进入[数据库系统](27-databases.md)。文件系统 journal 通常只保证 block/metadata transaction 与结构可恢复；数据库还要提供多个 records/index pages 上的 atomicity、consistency、isolation、durability，并处理 concurrent transactions。这里的 WAL、LSM、checksum、commit、checkpoint、replay 正是数据库恢复的词汇地基。

---

## 28. 概念辨析与思考题

### 28.1 最常见误区

| 误解 | 正确边界 |
| --- | --- |
| `write()` 返回就掉电不丢 | 通常只进入 kernel/cache；durability 需同步协议 |
| CPU fence 能 flush 磁盘 | memory ordering 与 storage persistence 是不同合同 |
| 单 block write 必然原子 | atomic unit 依设备/对齐/接口；还要考虑 torn write |
| journal 保存所有 file data | ext4 常见默认是 metadata journal + ordered data |
| fsck 能恢复原文件 | 它修格式不变量；名字、内容、应用意图可能已丢 |
| `rename` 原子就等于持久 | 原子可见性不等于 crash durability；还需 file/dir sync |
| `fsync(file)` 会同步文件名 | containing directory entry 要单独同步 |
| WAL 写过就能 replay | 要有完整性、commit、持久 ordering、幂等与回收协议 |
| checker 跑得多就是证明 | 结果只对其 failure model、coverage 和 oracle 有效 |

### 28.2 思考题

1. append 的 `BDI=101` 与 `BDI=011` 哪个更危险？分别如何修？
2. 为什么先 data 后 inode 可防 stale exposure，却不能保证无空间泄漏？
3. FAT 随机读第 k 个 cluster 为什么可能是 `O(k)`？加内存 index 后 crash 状态需改变吗？
4. inode 与 dirent 分离如何同时解释 hard link、unlink-open-file 和 `fstat`？
5. 一个 block 同时被两个 inode 引用时，fsck 为什么无法只凭 graph 知道谁正确？
6. journal commit 已持久、home blocks 只写一半时再次 crash，redo 为什么安全？
7. checksum 能检测 torn tail，为什么不能恢复 missing payload？
8. `data=ordered` 防住什么？它为何仍不能保证两个应用文件一起提交？
9. 持久替换协议中去掉 `fsync(temp)` 或 `fsync(parent)`，各留下哪种 crash state？
10. 若 temp 与 target 跨 filesystem，怎样设计 copy protocol 才不向 reader 暴露半文件？
11. ccheck 若只跟踪 pathname 而不跟踪 fd/object identity，会在哪些 rename/unlink trace 上出错？
12. 数据库为何还要 WAL？filesystem journal 能否知道“余额总和不变”这一 invariant？

---

## 29. PPT 内容覆盖表

下表第一列按 `lect26.md` 一级标题的原始顺序逐字保留；本讲没有需要去重的重复一级标题。

| 原讲义一级标题（按出现顺序） | 本章对应位置 | 覆盖要点 |
| --- | --- | --- |
| 文件系统实现 | §0–§1 | API 到 block 数据结构、crash protocol、数据库的全章定位 |
| Review & Comments | §2 | FUSE/procfs/sysfs、文件系统是数据结构、bread/bwrite/bflush 与 CPU fence 边界 |
| 真实的块设备 | §3 | 实际设备、GPT、partition、PV/VG/LV、namespace 和只读观察 |
| `[Logic Volume Manager](/OS/demos/persistence/lvm)` | §4 | extent mapping、grow 顺序、strace/ioctl、VM 安全边界 |
| 实现文件系统的代价 | §5 | block 粒度、读写放大、cache/writeback 与 locality |
| 进入文件系统设计 | §6 | data/metadata/namespace/allocation、workload、三类核心映射 |
| Super Block | §7 | root structure、magic/layout/features、备份与 checksum |
| 小文件系统和 FAT | §8 | 160 KiB、cluster chain、FAT12、8.3 dirent、随机访问代价 |
| `[readfat](/OS/demos/persistence/readfat)` | §9 | 手册驱动解析、mmap 镜像、offset 公式、bounds/invariant 校验 |
| UNIX 的选择：分离 | §10 | inode/dirent 顶点边分离、bitmap、direct/indirect、extent、fast symlink |
| `[Debug File Systems](/OS/demos/persistence/ext4)` | §11 | debugfs 路径、raw inode/dirent、无 loop 临时 ext4 镜像实验 |
| 存储系统：应对崩溃 | §12 | volatile state 丢失、S0/S1、结构与应用一致性 |
| 暗藏杀机的数据结构 | §13 | append 的 bitmap/data/inode 多写、八状态、torn write |
| 层次化存储结构带来的问题 | §14 | cache/queue/controller/FTL、submission/completion/persistence order |
| 乱序执行：后果 | §15 | stale exposure、volatile cache、FTL crash 与设备合同 |
| Systems: “先挣钱，后还债” | §16 | async 性能收益、crash recovery 债务、隐私与授权 |
| File System Checking (FSCK) | §17 | graph 扫描、可/不可恢复、lost+found、checker 自身 crash |
| 实现崩溃一致性：重新理解 “数据结构” | §18 | current shape 与 append history、checkpoint/compaction |
| Append-only + Lazy Update | §19 | WAL/MemTable/SSTable/merge、摊销和读写放大 |
| 文件系统中的 Write-ahead Log | §20 | descriptor/payload/commit/flush/checkpoint/replay、torn-WAL 实验 |
| Journaling Tricks | §21 | batch、checksum、metadata/data modes、revoke 和 journal reuse |
| 应用程序的崩溃一致性 | §22 | unsafe unlink+rename、持久替换目标、persistence properties |
| sync() 系列系统调用 | §23 | sync/syncfs/fsync/fdatasync、directory fsync、atomic_replace 实验 |
| 《操作系统》课到底教会了我们什么？ | §24 | specification、failure model、crash point、oracle、研究方法论 |
| `[Crash Consistency Checker](/OS/demos/persistence/ccheck)` | §25 | strace trace、状态枚举、恢复/判定、安全隔离与模型盲区 |
| Takeaways | §26 | 数据结构 + 持久协议、fsck/WAL/journal/fsync 的统一结论 |
| 阅读材料 | §27 | OSTEP 40–43、ext4/man-pages/论文与数据库衔接 |
