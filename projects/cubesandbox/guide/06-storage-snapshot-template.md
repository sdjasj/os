# 模块 6：存储、模板、快照与克隆

## 1. 学习目标

读完本章，你应能：

- 区分 OCI 镜像、模板、rootfs volume、内存 volume 和 VM metadata；
- 解释 CubeCoW 的文件布局与 `FICLONE` 语义；
- 读懂 Rust Engine、C FFI 和 Cubelet Go wrapper 三层；
- 解释模板制作、Sandbox 恢复、运行时快照、回滚与克隆；
- 理解物理快照引用为什么主要保存在节点 catalog；
- 知道 XFS reflink 的运维限制和一致性边界。

## 2. 五个容易混淆的对象

| 对象 | 保存什么 | 生命周期 |
|---|---|---|
| OCI image | 用户空间文件 layer 与 image config | Registry/本地 content store |
| Template definition | 可创建 Sandbox 的逻辑定义、规格、兼容信息 | 控制面数据库 |
| Rootfs volume/snapshot | Guest/容器可写磁盘状态 | CubeCoW 文件 |
| Memory volume/snapshot | Guest RAM 内容 | CubeCoW 文件 + Hypervisor |
| VM metadata | vCPU、设备、VM config 等序列化状态 | Snapshot metadata 目录 |

只有这几部分相互匹配，恢复出的 Sandbox 才是完整一致的运行现场。

## 3. CubeCoW 的目标

[`cubecow/README.md`](../../cubecow/README.md) 将 CubeCoW 定义为基于 reflink 的 CoW 存储引擎。它解决：

- 创建大逻辑 volume 时不立刻写满全部空间；
- snapshot/clone 不逐字节复制；
- flat snapshot 删除不需要遍历子孙；
- 进程重启后可从目录扫描恢复索引；
- 通过 C ABI 供 Go Cubelet 使用。

它当前不是通用分布式块存储。每个节点的文件系统是物理数据所在位置，控制面必须追踪模板/快照在哪些节点有副本。

## 4. 文件布局

```text
<root_dir>/volumes/
├── vol-A/
│   ├── vol-A       # volume 主文件
│   ├── snap-A1     # 从 vol-A reflink
│   └── snap-A2     # 可从 vol-A 或 snap-A1 reflink，但扁平归到 vol-A
└── vol-B/
    ├── vol-B
    └── snap-B1
```

volume 和 snapshot 名在全局命名空间中不能冲突。内存索引：

```rust
enum NameKind {
    Volume,
    Snapshot { origin_volume: String },
}
```

Snapshot 只记录 ultimate origin volume，不保存父 snapshot 链。这使删除任意 snapshot 只是删除一个目录项，不会破坏其他 snapshot 的逻辑关系。

## 5. Engine trait

[`cubecow/src/engine/mod.rs`](../../cubecow/src/engine/mod.rs) 定义后端无关接口：

```rust
pub trait Engine: Send + Sync {
    fn create_volume(&self, name: &str, size_bytes: u64) -> Result<Volume>;
    fn delete_volume(&self, name: &str) -> Result<()>;
    fn resize_volume(&self, name: &str, new_size_bytes: u64) -> Result<(u64, u64)>;
    fn create_snapshot(&self, source: &str, snapshot: &str, activate: bool)
        -> Result<Snapshot>;
    fn delete_snapshot(&self, name: &str) -> Result<()>;
    fn activate_volume(&self, name: &str) -> Result<Volume>;
    fn deactivate_volume(&self, name: &str) -> Result<()>;
    fn reset_node_storage(&self) -> Result<()>;
}
```

`Box<dyn Engine>` 让调用方不依赖具体 `ReflinkEngine`。当前只有 reflink 后端，但抽象也使测试可以替换 fake。

### 5.1 activate 的含义

未 activate 的 snapshot 仍是可用于 snapshot/clone/delete 的合法对象，只是没有给直接块 I/O 使用的 device path。调用方不能用 `device_path == ""` 推断 snapshot 不存在。

## 6. 初始化

[`cubecow/src/lib.rs`](../../cubecow/src/lib.rs) 的 `initialize` 按 backend kind 创建引擎。`ReflinkEngine::initialize_with_config`：

1. 校验 root directory 必须是合法绝对路径；
2. 创建 `volumes/`；
3. 做一次 `FICLONE` probe；
4. 扫描目录并清理崩溃遗留的 orphan；
5. 重建全局 name index；
6. 初始化 volume/snapshot metrics。

在启动时 fail fast 检查 reflink 很关键。否则平台可能运行很久，直到第一次 snapshot 才发现 ext4/挂载选项不支持。

## 7. `FICLONE` 的真实语义

[`engine/reflink.rs`](../../cubecow/src/engine/reflink.rs) 定义 Linux ioctl：

```rust
const FICLONE: libc::c_ulong = 0x40049409;
```

创建 snapshot 的核心步骤概念上是：

1. 锁住 name index 的写路径；
2. 验证源存在、目标名未占用；
3. 在同一个 origin volume 目录创建目标文件；
4. 对目标 fd 调 `ioctl(FICLONE, source_fd)`；
5. sync 文件/目录；
6. 更新 name index 和 metric。

### 7.1 为什么快

文件系统复制 extent reference，不读取和写回全部数据。初始 snapshot 的物理数据块与源共享。

### 7.2 为什么仍可能占满磁盘

当源和各 snapshot 随后写不同数据时，文件系统为修改 extent 分配新块。大量长期分叉的快照最终仍可能接近完整数据量。CoW 优化“相同部分共享”，不消灭不同数据。

### 7.3 为什么要求同一文件系统

reflink 共享的是同一个文件系统中的 extent。跨 mount/device 的 clone 通常不成立。配置 root 和 snapshot physical file 必须位于兼容布局。

## 8. 崩溃恢复

CubeCoW 以目录为 source of truth，不维护独立 ledger。初始化扫描会识别：

- 空 volume 目录；
- 缺少 main file 的目录；
- 零长度/未完成 snapshot；
- 名字冲突或非法项。

优点是少一份事务一致性；代价是目录命名/布局本身成为持久 ABI。外部运维不应手工重命名或移动 `volumes/` 下文件。

## 9. Rust 到 Go 的 FFI

### 9.1 C ABI

[`cubecow/src/ffi.rs`](../../cubecow/src/ffi.rs) 暴露 `#[no_mangle] extern "C" cubecow_*`，头文件在 [`include/cubecow.h`](../../cubecow/include/cubecow.h)。

FFI 设计要处理：

- Rust object 通过 opaque handle 持有；
- Rust `String` 转 C string，并提供专门 free 函数；
- panic 不能跨 FFI 边界；
- error code 与 thread-local last error；
- 调用 shutdown 后 handle 不可再用。

### 9.2 Go wrapper

[`Cubelet/pkg/cubecow/`](../../Cubelet/pkg/cubecow) 用 cgo 链接静态/动态库，转成 Go `Engine` 方法和语义错误码。

根 Makefile 的 `cubecow-sdk`：

1. `cargo build --release -p cubecow`；
2. 把 `libcubecow.a` 安装到 `Cubelet/third_party/cubecow/lib`；
3. 把 header 安装到 `include`；
4. 再编译 Cubelet。

所以修改 FFI 后要同时验证 Rust test、ABI header 和 Go cgo test。

## 10. Cubelet CowVolumeManager

[`Cubelet/storage/cubecow_volume_manager.go`](../../Cubelet/storage/cubecow_volume_manager.go) 把底层 volume/snapshot 操作提升为 Sandbox 语义，例如：

- 创建 Sandbox rootfs volume；
- 从 template rootfs snapshot clone；
- 创建/clone memory volume；
- commit template memory；
- 激活并取得最新 device path；
- 删除时处理记录 kind 与真实 kind 漂移。

### 10.1 命名

运行时用逻辑 ID 和 generation 构造唯一对象名。不要在业务层假设一个 Sandbox 永远只对应两个固定文件；rollback/commit 中可能产生新 generation，再原子切换 binding。

### 10.2 kind 漂移防御

持久记录可能说对象是 volume，但底层实际为 snapshot。删除先按记录 kind 调，遇到特定 `InvalidArgument` 再尝试另一种 delete。它避免旧版本/崩溃导致对象永久无法回收。

这种 fallback 必须只针对明确语义错误，不能把所有 I/O error 都当 kind 错误，否则会掩盖真实磁盘故障。

## 11. Snapshot Catalog

[`Cubelet/storage/snapshot_catalog.go`](../../Cubelet/storage/snapshot_catalog.go) 保存逻辑 snapshot 到物理对象的节点本地映射，包括：

- snapshot/template ID；
- kind；
- rootfs volume name/kind；
- memory volume name/kind；
- metadata directory；
- generation、状态和绑定信息。

为什么不让 CubeMaster数据库直接保存所有 `/data/...` path：

- 物理路径是节点本地实现细节；
- 同一模板可在不同节点有不同物理对象名/path；
- 重启后 device path 可能需通过 CubeCoW engine 重新 resolve；
- 控制面只需知道逻辑副本位置和健康状态。

## 12. 从 OCI 镜像制作模板

逻辑过程：

```text
OCI image
  ↓ pull/unpack image config + layers
创建 template build Sandbox
  ↓ rootfs/virtiofs/可写层准备
冷启动 MicroVM + cube-agent/envd
  ↓ probe 确认服务 ready
暂停 VM
  ├─ Hypervisor 写 CPU/device metadata
  ├─ Hypervisor 写 memory volume
  └─ CubeCoW 固化 rootfs volume
  ↓
CubeMaster 注册 template definition + node replica
```

模板并不只是 OCI image 的另一个名字。它包含已经启动到可服务点的 VM 快照，因此后续 create 能快速 restore。

CubeMaster 的 [`pkg/templatecenter/`](../../CubeMaster/pkg/templatecenter) 负责：

- definition/build job；
- image pull progress；
- artifact placement/distribution；
- snapshot replica；
- compatibility fingerprint；
- cleanup/GC；
- CubeEgress CA 烘焙。

## 13. 创建 Sandbox 时的存储路径

以 snapshot template 为例：

1. CubeMaster解析 template，选择有健康 replica 的节点；
2. Cubelet `appsnapshot` action 解析 local template；
3. storage action 从 template rootfs/memory 创建 Sandbox 对象；
4. `StorageInfo` 带 rootfs path 与 memory volume URL；
5. CBRI 写入 Shim annotations；
6. CubeShim构造 `RestoreConfig`；
7. Hypervisor 从 metadata + memory file 恢复；
8. Guest 看到与模板 snapshot 匹配的磁盘状态。

模板局部性因此会影响调度。若所选节点没有 replica，又没有同步分发流程，restore 必然失败。

## 14. 运行时快照

运行中的 Sandbox snapshot 要同时冻结并保存：

```text
quiesce/stop streams
  ↓
pause vCPU + devices
  ↓
CubeCoW clone 当前 rootfs/memory base
  ↓
Hypervisor 写变化内存页与 VM state
  ↓
catalog 标记 snapshot ready
  ↓
可恢复原 Sandbox运行，或保留 paused 状态（视操作类型）
```

若任何阶段失败，要避免 catalog 将半成品暴露为 Ready，并清理新建 CoW object。

## 15. 增量内存快照

Hypervisor 的 `pagemap_anon` 路径只识别需要写出的匿名页；CubeCoW 先从 base memory file 做 reflink。结果：

```text
base memory file
   │ FICLONE
new memory file（最初共享全部 extent）
   │ overwrite changed anonymous pages
   ▼
逻辑完整、物理增量的新快照
```

这不是链式增量格式；最终文件仍可按完整内存镜像恢复。flat 文件模型降低恢复时对长 snapshot chain 的依赖。

## 16. 回滚

回滚不是简单把运行中 VM 的某个内存指针倒回。大致需要：

1. 校验目标 snapshot 属于该 Sandbox且 Ready；
2. 停止/删除当前 VM 对象；
3. 切换 rootfs/memory/metadata binding；
4. 用目标 `RestoreConfig` 在同一 Shim 生命周期中恢复 VM；
5. 重连 Agent/monitor/log；
6. 成功后更新 runtime snapshot binding；
7. 失败时保持可诊断状态，并按设计补偿。

[`CubeShim/shim/src/sandbox/sb.rs`](../../CubeShim/shim/src/sandbox/sb.rs) 中 rollback 使用 `VmDelete` 后 `VmResumeFromSnapshot`，Hypervisor进程/实例仍可承载新 VM。

## 17. 克隆

从 snapshot 创建新 Sandbox：

- 控制面生成新 Sandbox ID；
- rootfs/memory 以目标 snapshot 为源 reflink；
- 生成独立网络、TAP、vsock 与 proxy mapping；
- restore 后重置 Guest 时间/随机数；
- 新旧 Sandbox 后续写入通过 CoW 分离。

共享存储 extent 不代表共享运行时身份。hostname、IP、token、Sandbox ID 和外部 volume mount 都必须按新实例重建。

## 18. 持久卷与运行时 rootfs 的区别

用户持久卷由 CubeMaster volume record + Cubelet volume plugin 管理，可使用 COS/NFS 等后端。它们通过 `volume_mounts` 进入 Sandbox，用于跨 Sandbox保留业务数据。

CubeCoW rootfs/memory 则是平台运行时内部对象。删除 Sandbox通常回收它们，但不能自动删除用户持久卷。

设计 delete API 时必须明确 ownership：谁创建、谁引用、谁最终删除。

## 19. 一致性与并发

存储代码常见锁层次：

- CubeMaster数据库/分布式 operation lock；
- Cubelet sandbox lifecycle lock；
- snapshot catalog lock；
- CubeCoW name index RwLock；
- 文件系统原子操作。

避免死锁的原则：固定锁顺序、不要持全局锁跨慢 RPC、底层操作幂等、数据库状态采用 `CREATING → READY/FAILED` 显式状态机。

## 20. 运维注意

- `/data/cubelet` 必须是启用 reflink 的 XFS（或实现支持的其他 FICLONE FS）；
- 监控逻辑容量与实际物理空间，两者差异很大；
- snapshot 多不一定立即占空间，分叉写入后才增长；
- 不要对 CubeCoW 管理目录做普通备份工具的“展开式复制”后期待仍保留共享 extent；
- 跨节点复制模板要同时复制 metadata、rootfs、memory 并校验 fingerprint；
- 升级 Hypervisor/Guest kernel/Agent 前检查模板兼容矩阵，必要时重建模板。

## 21. 测试

```bash
# Rust 纯单元测试
cd cubecow
cargo test --lib

# Cubelet Go wrapper（需要先构建/链接库的测试用统一 builder 更稳）
cd ..
make cubecow-test-native

# Cubelet storage 逻辑
cd Cubelet
go test ./storage/...
go test ./services/cubebox/... -run 'Snapshot|Rollback|Commit'
```

真实 reflink benchmark：

```bash
cd cubecow
sudo cargo bench --bench reflink_ops
```

只在专用 loop/XFS 测试环境运行，不要指向生产 root directory。

## 22. 动手练习

### 练习 1：追一个 memory volume

从 snapshot catalog 的 `MemoryVol` 开始，找到它如何变成 CubeShim annotation、`RestoreConfig.memory_vol_url`，再进入 Hypervisor `MemoryManager::new_from_snapshot`。

### 练习 2：模拟分叉写入

在测试 XFS 上创建 source 和两个 reflink clone，分别修改不同 offset，然后用 `xfs_bmap`/`du` 观察共享与独占 extent 的变化。

### 练习 3：设计 crash point

为 create snapshot 列出至少五个 crash point，并说明重启后由数据库状态、catalog 扫描还是 CubeCoW layout 的哪一层恢复/清理。

## 23. 自测题

1. 为什么 snapshot-of-snapshot 仍可放在 ultimate origin 目录？
2. 为什么 `device_path` 为空不等于 snapshot 不存在？
3. 为什么 template definition 不能只保存 OCI image URL？
4. 为什么增量内存快照仍需要 base memory file？
5. 为什么持久卷不应随 Sandbox delete 自动删除？

