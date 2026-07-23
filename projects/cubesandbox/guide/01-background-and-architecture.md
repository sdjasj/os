# 模块 1：背景知识与总体架构

## 1. 学习目标

读完本章，你应能：

- 解释为什么 AI Agent 代码执行需要比普通容器更强的隔离；
- 区分 KVM、VMM、MicroVM、Guest Agent、OCI 和 containerd Shim；
- 理解 eBPF、TAP、NAT、TPROXY 与 L7 代理各自在网络链路中的位置；
- 理解 reflink/CoW 与内存快照不是一回事；
- 把仓库组件放进控制面和数据面两大区域。

## 2. 为什么 AI Agent 沙箱是特殊系统

传统后端通常运行开发者审核过的代码，而 Agent 沙箱可能执行：

- 模型刚生成、未经审核的 Shell 命令；
- 来自外部仓库的构建脚本和测试；
- 浏览器、编译器、包管理器等高复杂度程序；
- 会主动访问网络、读取环境变量、扫描文件系统的未知代码。

因此平台同时追求四个看似冲突的目标：强隔离、低启动时延、高实例密度和完整 Linux 兼容性。CubeSandbox 的解法是以 MicroVM 提供独立内核，以模板快照恢复降低启动成本，再用 eBPF 与 CoW 降低每实例网络/存储开销。

## 3. 虚拟化背景

### 3.1 KVM 是什么

KVM 是 Linux 内核的虚拟化基础设施。开启 KVM 后，用户态 VMM 可以通过 `/dev/kvm` 创建 VM、配置 vCPU 和 Guest 内存，并让大部分 Guest 指令直接在硬件虚拟化模式下运行。

KVM 本身不负责完整的设备模型和产品生命周期。本仓库的 `hypervisor/` 才是 VMM：它组装 CPU、内存、virtio-blk/net/vsock/fs 等设备，并处理启动、暂停、快照和恢复。

简化关系：

```text
CubeHypervisor（用户态 VMM）
        │ ioctl
        ▼
KVM（Linux 内核）
        │ VT-x / AMD-V / ARM Virtualization
        ▼
物理 CPU
```

### 3.2 MicroVM 与传统 VM

MicroVM 仍是 VM，但通常减少固件、设备和管理面，以换取更快启动和更低开销。CubeSandbox 会为沙箱配置必要的 virtio 设备，并借助模板内存快照绕过重复的 Guest 启动工作。

“恢复很快”不表示完全没有 VM 创建：仍要创建 KVM VM、映射内存、恢复 vCPU/设备状态，并重新连接 vsock；只是不用从头走完 Guest 内核和用户空间启动。

### 3.3 PVM 在哪里

PVM 是普通 x86_64 云服务器无法直接获得 `/dev/kvm` 时的一条部署路线。它解决的是“宿主机怎样提供 KVM 能力”，不改变 CubeAPI → CubeMaster → Cubelet → Shim → Hypervisor 的应用层架构。源码学习可以先把 PVM视为底层 KVM 提供方式。

## 4. 容器运行时背景

### 4.1 OCI 的三层含义

在本项目中经常看到 OCI，至少要分清：

- OCI Image Spec：镜像 manifest、config 和 layer 的格式；
- OCI Runtime Spec：容器的 `config.json`，包括进程、mount、namespace、capability、cgroup 等；
- OCI Distribution Spec：Registry 拉取和推送镜像的 HTTP 协议。

CubeMaster/Cubelet 可以把 OCI 镜像制作成模板；Cubelet 生成 OCI Spec；CubeShim 接住 containerd 的任务调用，但最后把“容器沙箱”映射为 MicroVM。

### 4.2 containerd 与 Shim v2

containerd 管理镜像、内容、snapshot 和 task。Shim v2 是每个运行时/任务与 containerd 之间的隔离边界：containerd 启动 Shim，之后 Shim 负责 Create、Start、Exec、Kill、Delete 等操作。

本仓库 [`CubeShim/README.md`](../../CubeShim/README.md) 的关键关系是：

```text
containerd
   │ Shim v2
containerd-shim-cube-rs
   │ ttrpc over vsock
cube-agent（Guest）
   │ rustjail / OCI
Guest 内进程
```

这使 Cubelet 可以继续复用 containerd/OCI 生态，同时把隔离边界升级为 VM。

### 4.3 Guest Agent 为什么必要

宿主 VMM 能启动 VM，却不能直接替 Guest 完成所有容器操作。Guest Agent 运行在 VM 内，拥有 Guest 视角的 mount、namespace、cgroup 和进程控制能力。

`agent/src/main.rs` 建立服务，`agent/src/rpc.rs` 实现 ttrpc 方法，`agent/rustjail/` 提供 OCI 运行原语。它以 PID 1 运行，还要承担 init 的职责，例如回收子进程和初始化 Guest 环境。

## 5. 网络背景

### 5.1 TAP 是什么

TAP 是内核提供的二层虚拟网卡。VM 的 virtio-net 一端连接 TAP，宿主程序或内核网络栈从 TAP 收发以太网帧。每个 Sandbox 有独立 TAP，使 eBPF 可以用 TAP ifindex 作为每沙箱策略键。

### 5.2 eBPF 与 TC

eBPF 程序可以挂到 Linux Traffic Control ingress/egress，在内核中检查和修改数据包。CubeNet 的 BPF 程序负责：

- 地址/端口转换；
- 连接跟踪；
- ARP 代理；
- LPM Trie 网络策略；
- 把流量重定向到 TAP、宿主接口或透明代理。

Go 控制库 [`CubeNet/cubevs/`](../../CubeNet/cubevs) 负责加载程序、管理 pinned map，并为每个 TAP 写入配置；C 文件 [`CubeNet/src/`](../../CubeNet/src) 是真正逐包执行的数据面。

### 5.3 L3/L4 与 L7 策略

- L3/L4 只需要 IP、CIDR、协议、端口，适合在 eBPF 中高速执行；
- L7 需要理解 HTTP method、Host、path、TLS SNI，并可能修改请求头，交给 CubeEgress/OpenResty 更合适。

两层是叠加关系。允许一个域名的 L7 规则不一定自动绕过 L3/L4 deny；官方 SDK 文档因此提醒域名规则还要配合 `allow_out`。

### 5.4 TPROXY 与 TLS 检查

TPROXY 让代理接收被重定向的连接，同时保留原目标信息。对 HTTPS 做 Host/path/头注入时，仅看加密前的 TCP 包不够；CubeEgress 动态为 SNI 签发叶子证书，由模板内预置信任的 CubeEgress CA 完成透明 TLS 代理。

这带来一条安全边界：CA 私钥和真实 API Key 留在宿主代理，不进入沙箱。相应地，生产环境必须保护 CA 私钥、代理管理接口和审计日志。

## 6. 存储背景

### 6.1 Copy-on-Write 与 reflink

普通文件复制需要读写全部数据；reflink 复制只建立共享 extent 映射。最初两个文件指向同一物理块，任一方写入时才为变化区域分配新块。

Linux `FICLONE` ioctl 暴露文件级 reflink。CubeCoW 在 [`cubecow/src/engine/reflink.rs`](../../cubecow/src/engine/reflink.rs) 中使用它创建卷快照：

```text
源文件 ── FICLONE ──> 快照文件
  │                       │
  └──── 共享未修改 extent ┘
```

这里的 O(1) 指避免按逻辑容量复制全部字节，不表示所有情况下绝对常数时间；extent 数量、文件系统日志、fsync 和后续写放大仍会影响性能。

### 6.2 磁盘快照与内存快照

二者必须同时理解：

- rootfs/volume 快照保存磁盘内容；
- VM snapshot 保存 vCPU、设备和内存状态；
- 模板恢复要让磁盘、内存和设备状态互相匹配。

CubeShim 的 restore config 会携带 snapshot metadata 路径、memory volume URL、磁盘/网络/virtiofs 配置；Hypervisor 再恢复 MemoryManager、CPUManager 和 DeviceManager。

## 7. API 与分布式系统背景

### 7.1 REST、gRPC、ttrpc 各做什么

| 协议 | 本项目中的位置 | 原因 |
|---|---|---|
| REST/HTTP | SDK → CubeAPI；CubeAPI → CubeMaster；WebUI → CubeOps | 对外易用、兼容现有 SDK |
| gRPC | CubeMaster → Cubelet；Cubelet → network-agent | 强类型、高效、适合节点服务 |
| ttrpc | CubeShim → Guest Agent | containerd/Kata 生态常用的轻量 RPC |
| vsock | Host ↔ Guest 传输 | 不依赖 Guest 外部 IP，适合 VM 边界 |

### 7.2 幂等、超时与补偿

Sandbox 创建跨多个进程和资源，不可能靠单个数据库事务覆盖。代码大量使用：

- `request_id` / `idempotency_key` 识别重试；
- deadline 限制 RPC；
- 调度重试选择其他节点；
- Cubelet workflow 失败后异步 failover destroy；
- Redis `SETNX` 风格状态锁避免重复暂停/恢复；
- 本地 JSON/数据库状态支持进程重启后 reconcile。

读代码时不要只看成功路径。一个功能是否完整，往往取决于“中间第 N 步失败后，前 N-1 步如何回滚”。

## 8. 控制面、数据面与状态面

更准确的三分法如下：

| 平面 | 组件 | 关键问题 |
|---|---|---|
| 控制面 | CubeAPI、CubeMaster、CubeOps、WebUI | 想要什么状态？放到哪个节点？ |
| 节点/数据面 | Cubelet、CubeShim、Hypervisor、Agent、CubeVS、Proxy、Egress | 怎样真正创建 VM、转发请求和执行代码？ |
| 状态面 | MySQL/PostgreSQL、Redis、Cubelet 本地状态、CubeCoW 目录 | 如何共享元数据、恢复状态和协调并发？ |

Redis 适合低时延的路由映射、事件流和锁；关系数据库保存模板、快照、卷、AgentHub 等需要持久查询的记录；节点本地状态记录只在该节点有意义的 TAP、快照物理引用和运行时元数据。

## 9. 两条端到端时序

### 9.1 创建沙箱

```text
SDK
 │ POST /sandboxes
 ▼
CubeAPI：鉴权/限流/参数校验/协议转换
 ▼
CubeMaster：解析模板 → 过滤/打分节点 → gRPC Create
 ▼
Cubelet：workflow 准备 image/storage/network/cgroup
 ▼
containerd → CubeShim：创建并启动 task
 ▼
Hypervisor：创建或恢复 VM
 ▼
Guest Agent：CreateSandbox，启动 Guest 内服务
 ▼
CubeMaster：写 Proxy Redis 映射、持久化 spec、发布生命周期事件
 ▼
SDK 获得 sandbox_id、domain、可选 traffic token
```

### 9.2 执行代码

```text
SDK
 │ POST http(s)://49999-<sandbox_id>.cube.app/execute
 ▼
CubeProxy：解析 host → Redis/本地缓存查后端 → 可选自动恢复 gate
 ▼
节点端口/TAP/CubeVS
 ▼
Guest 内 Jupyter/code interpreter
 │ NDJSON/stream response
 ▼
SDK 聚合 stdout/stderr/result
```

注意第二条链路不经过 CubeMaster。若创建成功但 `run_code` 失败，优先查数据面，而不是盯着调度器。

## 10. 代码中的架构证据

### 10.1 CubeAPI 路由层

[`CubeAPI/src/routes.rs`](../../CubeAPI/src/routes.rs) 把健康检查、Sandbox、Template、Snapshot 和 Volume 路由分组，并为快照类同步长操作配置 240 秒 timeout。它表明 timeout 是按业务类别设计的，不是统一拍一个数。

### 10.2 CubeMaster 调度

[`CubeMaster/pkg/scheduler/schedule.go`](../../CubeMaster/pkg/scheduler/schedule.go) 的 `Select` 依次执行 pre-filter、并行 filter、score，最后从高优候选中选择节点。过滤回答“能不能放”，打分回答“放哪更好”。

### 10.3 Cubelet 工作流

[`Cubelet/config/config.toml`](../../Cubelet/config/config.toml) 的 create flow：

```toml
actions = [
  ["createid", "appsnapshot"],
  ["images", "volume", "storage", "network", "netfile", "cube-sandbox-store"],
  ["cgroup"],
  ["cubebox"]
]
```

外层数组是顺序步骤，内层同组 action 并行。这种配置把依赖关系直接变成了执行图。

### 10.4 Hypervisor 恢复

[`hypervisor/vmm/src/vm.rs`](../../hypervisor/vmm/src/vm.rs) 的 `Vm::new_from_snapshot` 从 snapshot 构造 MemoryManager，再恢复设备与 CPU；`Snapshottable for Vm` 要求 VM 先处于 Paused 状态，然后分别收集 CPU、Memory 和 Device 快照。

## 11. 动手练习

### 练习 1：画出自己的组件图

只使用以下组件，画出创建请求方向并标注协议：SDK、CubeAPI、CubeMaster、Cubelet、containerd、CubeShim、Hypervisor、Agent。再另画一张 `run_code` 图。

检查点：两张图不应相同；第二张必须出现 CubeProxy。

### 练习 2：找到四种接口定义

在仓库运行：

```bash
rg -n 'route\("/sandboxes|g\.POST\(SandboxAction' CubeAPI CubeMaster
rg -n 'rpc EnsureNetwork|service NetworkAgent' network-agent/api
rg -n 'CreateSandboxRequest' CubeShim/protoc agent/libs/protocols
```

分别说出它们跨越哪个进程或隔离边界。

### 练习 3：验证文件系统 reflink

在专用测试目录、且确认底层文件系统支持 reflink 后：

```bash
truncate -s 1G source.img
cp --reflink=always source.img clone.img
du -h source.img clone.img
stat source.img clone.img
```

解释为什么两个文件逻辑大小都是 1 GiB，但初始物理占用可以很小。不要在生产 CubeCoW 目录中做此练习。

## 12. 自测题

1. KVM 与 CubeHypervisor 是什么关系？
2. containerd 为什么不直接和 Guest Agent 通信？
3. 为什么 L7 凭证注入不适合只靠 eBPF 完成？
4. 为什么 VM 内存快照不能替代 rootfs 快照？
5. Cubelet 工作流失败后为什么需要补偿，而不是数据库回滚？

参考答案要点：KVM 是内核虚拟化接口而 VMM 组装 VM；Shim 隔离 containerd 生命周期并管理 VM/IO；HTTP/TLS 语义和秘密头修改需要代理；内存引用的文件状态必须匹配；跨进程、内核和文件系统资源无法纳入单一 ACID 事务。

