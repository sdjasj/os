# 模块 4：虚拟化链路——CubeShim、Hypervisor 与 Guest Agent

## 1. 学习目标

本章从 containerd task 继续向下，解释：

- CubeShim 如何实现 Shim v2 并把 OCI annotation 变成 VM 配置；
- 冷启动与快照恢复在 `start_vm` 中如何分支；
- Hypervisor 的 API request 如何创建、启动、暂停和恢复 VM；
- vsock/ttrpc 如何跨 Host/Guest 边界；
- Guest Agent 怎样最终创建进程和管理容器；
- VM 快照为什么要求协调 CPU、内存、设备和时间/随机数。

## 2. 先建立边界图

```text
Host 用户态
┌─────────────────────────────────────────────┐
│ Cubelet/containerd                          │
│    │ Shim v2                                │
│    ▼                                        │
│ containerd-shim-cube-rs                     │
│    ├─ 解析 OCI + VM annotations             │
│    ├─ 调 CubeHypervisor API                 │
│    └─ ttrpc client ───────────────┐          │
│ CubeHypervisor → /dev/kvm         │ vsock    │
└───────────────────────────────────┼──────────┘
                                    │
Guest                              │
┌───────────────────────────────────▼──────────┐
│ cube-agent (PID 1, ttrpc server)             │
│    └─ rustjail → Guest 内 container/process │
└──────────────────────────────────────────────┘
```

Host 上的 containerd 不进入 Guest；Guest 内的 Agent 也不直接调 KVM。CubeShim 同时连接上层 containerd 和下层 VMM/Agent，是关键适配层。

## 3. CubeShim workspace

[`CubeShim/Cargo.toml`](../../CubeShim/Cargo.toml) 管理三个子部分：

- `shim/`：`containerd-shim-cube-rs`，真正的 Shim v2 进程；
- `cube-runtime/`：快照、登录等辅助 CLI；
- `protoc/`：与 Guest Agent 通信的 protobuf/ttrpc 绑定。

入口 [`CubeShim/shim/src/main.rs`](../../CubeShim/shim/src/main.rs) 交给 containerd-shim framework 处理 Shim 启动参数；业务 service 在 [`service/`](../../CubeShim/shim/src/service)，Sandbox 状态机在 [`sandbox/`](../../CubeShim/shim/src/sandbox)。

## 4. Shim v2 背景与生命周期

containerd 调用大致为：

```text
Create → Start → State/Wait/Exec/Kill → Delete/Shutdown
```

Shim 必须把这些动作映射为两层对象：

- Sandbox/VM；
- Guest 内的 container/process。

第一个/pod container 的 Create 会触发 VM/Sandbox 准备；之后的 container 或 exec 则复用已存在的 VM 和 Agent 连接。

阅读 [`service/task_srv.rs`](../../CubeShim/shim/src/service/task_srv.rs) 时，可按每个 Shim API 找到它最终调用 `Sandbox` 还是 `Container`。例如 task Start 不一定等同于“此刻才创建 KVM VM”，部分准备已在 Create 阶段完成。

## 5. Annotation 是 Cubelet 与 Shim 的内部协议

Cubelet 生成 OCI Spec 时写入 annotation，CubeShim 在 [`sandbox/config.rs`](../../CubeShim/shim/src/sandbox/config.rs) 解析。重要键包括：

| Annotation | 含义 |
|---|---|
| `cube.vm.kernel.path` 对应常量 | Guest kernel |
| `cube.vm.snapshot.base.path` | 快照 metadata 根目录 |
| `cube.vm.snapshot.memory_vol_url` | 这次恢复使用的内存快照文件 |
| `cube.appsnapshot.create` | 正在制作模板快照 |
| `cube.appsnapshot.restore` | 从模板/运行时快照恢复 |
| `cube.snapshot.disable` | 普通冷启动且禁用恢复 |
| virtiofs/disk/net/pmem annotations | VM 设备配置 |

这是内部 ABI。改名字或结构时必须同步 Cubelet、CubeShim、部署模板和测试，不能只改一端。

`SandboxConfig` 还会拒绝同时设置 create 与 restore；这种互斥校验应尽早发生，避免携带矛盾配置进入 VMM。

## 6. Sandbox 对象

[`CubeShim/shim/src/sandbox/sb.rs`](../../CubeShim/shim/src/sandbox/sb.rs) 是核心。一个 Sandbox 持有：

- 配置和 ID；
- `CubeHypervisor`；
- Agent ttrpc client；
- containers map；
- VM/Sandbox state；
- monitor/OOM/log forwarder task；
- device、network、filesystem 等运行时信息。

建议先从以下方法读：

```text
init / new
  → create_sandbox
    → start_vm
    → connect_agent
    → reset_guest（恢复路径）
    → add_device
    → Agent.CreateSandbox
```

## 7. 冷启动与快照恢复

### 7.1 `start_vm`

核心逻辑位于 `sb.rs` 的 `start_vm`：

```text
launch_vmm
   │
   ├─ by_snapshot == true
   │      └─ restore_vm
   │           ├─ 成功：snapshot = true
   │           └─ App snapshot 恢复失败：直接返回错误
   │
   └─ snapshot == false
          ├─ create_vm
          └─ boot_vm

等待 vsock listening event
```

普通可回退场景下，某些 restore 失败可能回到冷启动；但明确的 app snapshot restore 不能悄悄冷启动，因为调用者要求恢复特定状态。静默降级会产生“API 成功但状态丢失”的严重语义错误。

### 7.2 `create_vm`

冷启动路径根据 `SandboxConfig` 组装：

- vCPU/内存；
- kernel/cmdline；
- net TAP；
- disk/pmem；
- vsock；
- virtiofs；
- RNG 等设备。

随后 CubeHypervisor 发送 `ApiRequest::VmCreate` 与 `VmBoot`。

### 7.3 `restore_vm`

恢复路径先校验 snapshot metadata 与当前资源是否匹配，再构造 `RestoreConfig`：

```rust
RestoreConfig {
    source_url: snapshot_dir,
    prefault: false,
    net_fds,
    fss,
    disks,
    pmems,
    vsock,
    memory_vol_url,
    ...
}
```

`source_url` 主要定位 VM config/state metadata，`memory_vol_url` 则定位物理内存快照文件。把两者混成一个路径会破坏新版 CubeCoW 物理引用模型。

## 8. CubeHypervisor 适配层

[`CubeShim/shim/src/hypervisor/cube_hypervisor.rs`](../../CubeShim/shim/src/hypervisor/cube_hypervisor.rs) 包装 `cube_hypervisor::VmmInstance`，维护简单状态：`Init → Launched → Running`。

### 8.1 启动 VMM instance

`launch_vmm`：

1. 追加 CubeShim 集成所需 seccomp rule；
2. 将 Shim `HypConfig` 转为 VMM config；
3. 创建 event notification channel；
4. `VmmInstance::new`；
5. 保存 receiver 并进入 `Launched`。

这里的 VMM 作为 Rust library/instance 嵌入 Shim 进程，而不是必须经外部 HTTP socket 调另一个守护进程。API request channel 仍保留清晰的 VMM command 边界。

### 8.2 API request 映射

| Shim 方法 | VMM request |
|---|---|
| `create_vm` | `VmCreate` |
| `boot_vm` | `VmBoot` |
| `pause_vm` | `VmPause` |
| `resume_vm` | `VmResume` |
| `snapshot_vm` | `VmSnapshot` |
| `restore_vm` | `VmRestore` |
| `pause_vm_cube` | `VmPauseToSnapshot` |
| `resume_vm_cube_with_config` | `VmResumeFromSnapshot` |
| `delete_vm` | `VmDelete` |

调用会出现两层 Result：发送 request 失败，以及 VMM 执行动作失败。适配代码用两次 `map_err(...)?` 逐层展开。

## 9. Hypervisor 内部

`hypervisor/` 源自 Cloud Hypervisor/RustVMM 生态，并有 Cube 的快照和运行时改动。不要从 workspace 所有 crate 平铺阅读。主线如下：

```text
hypervisor/src/main.rs / lib API
  → vmm/src/lib.rs（VmmInstance/API loop）
  → vmm/src/vm.rs（VM 状态机）
  → cpu_manager.rs / memory_manager.rs / device_manager.rs
  → hypervisor/hypervisor crate（KVM 抽象）
  → virtio-devices / vm-virtio / net_util / block_util
```

### 9.1 新建 VM

[`vmm/src/vm.rs`](../../hypervisor/vmm/src/vm.rs) 的 `Vm::new`：

1. 通过 hypervisor 抽象创建 KVM VM；
2. 计算 Guest physical bits；
3. 创建 `MemoryManager`；
4. 由 `new_from_memory_manager` 创建 CPU/Device manager；
5. 创建 virtio 设备。

### 9.2 从快照新建

`Vm::new_from_snapshot` 的关键区别：

1. 创建新的 KVM VM 容器；
2. 从 `MEMORY_MANAGER_SNAPSHOT_ID` 建立 MemoryManager；
3. 把 `source_url` 与 `memory_vol_url` 传给内存恢复；
4. 用同一 `new_from_memory_manager` 路径组装 VM，但带 snapshot state；
5. 后续恢复 CPU、Device 并启动 restored vCPU。

所以“恢复 VM”不是复活旧宿主进程，而是在新 VM 对象中重建状态。

## 10. VM 状态机与快照

### 10.1 Pause

`Pausable for Vm`：

1. 检查状态迁移是否合法；
2. 保存 KVM clock（x86_64）；
3. 激活尚未激活的 virtio 设备；
4. pause CPU manager；
5. pause device manager；
6. 状态设为 `Paused`。

先停 CPU 再处理设备/反之会影响 in-flight I/O 一致性，项目按当前设备模型定义了固定顺序。

### 10.2 Snapshot

`Snapshottable for Vm::snapshot` 明确要求当前状态为 `Paused`，随后收集：

- VM 自身状态/clock/common CPUID；
- CPU manager snapshot；
- Memory manager snapshot；
- ARM vGIC；
- Device manager snapshot。

再由 `Transportable::send` 写出：

```text
config.json / VM config
state.json  / CPU、设备等序列化状态
memory file / Guest RAM 数据
```

具体文件常量以当前代码为准。写完 config/state 后会 `sync_all`，用于跨机暂停快照的持久性。

### 10.3 Restore

恢复顺序包括：

- 恢复 clock；
- 恢复 DeviceManager 状态；
- 恢复 CPUManager；
- 恢复 ARM 中断控制器；
- 恢复实际 devices；
- 启动 restored vCPU；
- 重建 signal/TTY；
- 状态设为 Paused，随后再 resume。

快照兼容性因此涉及 CPU 特性、设备模型版本、Guest kernel/agent 版本和资源规格。模板版本矩阵不是纯展示功能，而是恢复正确性的保障。

## 11. 增量内存快照

[`vmm/src/pagemap_anon.rs`](../../hypervisor/vmm/src/pagemap_anon.rs) 与 [`memory_manager.rs`](../../hypervisor/vmm/src/memory_manager.rs) 支持筛选匿名脏页。思路是：

- 基础内存文件由 CubeCoW reflink 克隆；
- 只把本次变化的匿名页覆盖到克隆文件；
- 未变化页继续共享底层 extent；
- 最终仍形成可独立恢复的完整逻辑内存文件。

这把“内存页级增量检测”和“文件 extent 级 CoW”组合起来。若基础快照文件不存在，增量写无法凭空恢复未变化页，因此代码会失败而非生成残缺快照。

## 12. vsock 与 Agent 连接

vsock 为 Host/Guest 提供不依赖 IP 的 socket 通信。CubeShim 为 Sandbox 配置 vsock，并等待 Hypervisor 发出 listening/ready 事件，再由 `connect_agent()` 创建 ttrpc client。

这比立即 sleep 固定毫秒数可靠：

- 快机器无需多等；
- 慢机器不会因固定等待太短随机失败；
- ready event 可记录准确启动耗时。

## 13. 恢复后的 Guest 修复

从快照恢复后，`create_sandbox` 会调用 `reset_guest`：

- 设置 Guest 当前时间；
- 重新注入随机熵。

为什么必要：快照冻结了过去的 wall clock 和随机设备状态。若不修正，TLS、token 过期、日志时间、随机数安全性都可能出问题。

恢复后还需要按情况重新添加不能直接快照或绑定宿主的新设备，并更新 pmem sequence。

## 14. Guest Agent

[`agent/src/main.rs`](../../agent/src/main.rs) 是 Guest PID 1 入口。其职责包括：

- 初始化 mount、namespace、设备、网络与日志；
- 监听 vsock/ttrpc；
- 注册 Agent 与 Health service；
- 处理 signal 和子进程；
- 暴露指标。

[`agent/src/rpc.rs`](../../agent/src/rpc.rs) 实现协议方法，包括 Sandbox、Container、Process、Network、Storage 等操作。容器隔离原语来自 [`agent/rustjail/`](../../agent/rustjail)：

- namespace；
- capability；
- mount；
- seccomp；
- cgroup；
- OCI spec 转换；
- process/console/pipestream。

MicroVM 已提供独立内核，Guest 内仍使用容器 namespace/cgroup 是为了：一个 Sandbox VM 内可管理多个 container/process，并保持 OCI 兼容的资源和进程模型。

## 15. `CreateSandbox` 到 Guest process

CubeShim连接 Agent 后发送 `agent::CreateSandboxRequest`，包含：

- hostname；
- DNS、interfaces、routes、ARP neighbors；
- storage；
- Sandbox ID；
- `StartMode::SNAPSHOT` 或 `RESTORE`；
- 恢复时的 preserve memory 信息。

之后每个 container 的 create/start 再通过 Agent RPC 进入 rustjail。不要把 Agent `CreateSandbox` 与创建业务 container 混为一个 RPC：前者先建立 Guest 级沙箱环境。

## 16. 监控、OOM 与日志

Sandbox 建立后，Shim 会：

- 监听 Hypervisor shutdown event；
- 可选周期 ping Agent health；
- 监听 Guest OOM event并向 containerd 报告；
- 通过独立 vsock 连接转发 stdout/stderr；
- 在 pause/snapshot/destroy 前停止相关 forwarder，避免还有 goroutine 读取冻结连接。

并发 bug 常发生在“主控制连接”和“流式日志连接”生命周期不同步。相关修改要检查取消信号、JoinHandle 等待和恢复后重建。

## 17. 安全边界

- VMM 使用 seccomp 缩小宿主 syscall 面；
- Guest 独立 kernel，阻隔直接共享宿主内核；
- Guest container 仍应用 capability/seccomp/no-new-privileges；
- Host 路径/virtiofs 是穿透 VM 边界的敏感入口，必须验证路径和挂载权限；
- vsock RPC 也要视为边界协议，校验长度、ID 和状态。

强隔离是多层组合，不是“用了 KVM 就自动安全”。

## 18. 测试与阅读命令

```bash
# Shim
cd CubeShim
cargo test --workspace

# Guest Agent
cd agent
make test

# Hypervisor：先跑目标 crate/单元测试，不要一开始跑所有集成测试
cd hypervisor
cargo test -p vmm
```

统一 builder：

```bash
make shim-test
```

真实 VM 启动测试需要 `/dev/kvm`、Guest kernel/image、正确权限和网络设备，纯结构/序列化/状态机测试则不需要。

## 19. 动手练习

### 练习 1：追一个 annotation

从 Cubelet 的 `AnnotationsVMKernelPath` 开始，找到它在 CubeShim 中的字符串常量、解析字段，以及最终进入 Hypervisor config 的位置。

### 练习 2：比较两种启动

列出冷启动与 app snapshot restore 的共同步骤和不同步骤。解释为什么 app restore 失败不应默认退回冷启动。

### 练习 3：设计快照兼容检查

为以下变化判断能否恢复，依据是什么：

- vCPU 数变化；
- Guest kernel 变化；
- virtio-net 队列数变化；
- 宿主节点 IP 变化但 TAP 重新创建；
- envd 用户态版本变化。

## 20. 自测题

1. CubeShim 为什么同时需要 Hypervisor client 和 Agent client？
2. `VmRestore` 为什么仍要创建新的 KVM VM？
3. snapshot 前为什么必须 pause？
4. 恢复后为什么重设时间和随机数？
5. Guest 已在 VM 中，为什么还需要 rustjail？

