# 第 16 章：虚拟机与容器——隔离一台“假的计算机”

> 对应讲义：[第 29 讲](../sources/notes/lect29.md)，配套实验：[namespace_info.c](../examples/namespace_info.c)

虚拟机让一个软件栈相信自己拥有硬件；容器让一组进程相信自己拥有独立的操作系统视图。两者都在做虚拟化，但边界、代价与威胁模型不同。

## 16.1 模拟、虚拟化与容器

| 技术 | 客体看到什么 | 指令怎样执行 | 内核关系 |
|---|---|---|---|
| 全系统模拟 | 可不同体系结构硬件 | 解释/动态二进制翻译 | 客体有自己的内核 |
| 硬件辅助 VM | 虚拟 CPU/内存/设备 | 大部分直接执行 | 客体有自己的内核 |
| 容器 | 隔离的进程/文件/网络视图 | 普通宿主指令 | 共享宿主内核 |

QEMU 可把客体基本块动态翻译成本机代码并缓存，因而能在 x86 上模拟 RISC-V。相同体系结构的现代 VM 则让非敏感客体指令直接执行，只有特权事件陷入 hypervisor。

## 16.2 硬件辅助虚拟化

处理器提供 guest mode、VM control structure 和 VM exit：客体执行特定特权操作、访问未虚拟化设备或触发配置事件时退出到 VMM。VMM 更新虚拟设备/CPU 状态，再恢复客体。

内存需要两次翻译：

```text
guest virtual ─ guest page table → guest physical
guest physical ─ EPT/NPT → host physical
```

硬件缓存组合结果，否则嵌套页表遍历代价很高。设备可完全模拟、使用半虚拟化 virtio，或经 IOMMU 直通；三者在兼容性、性能与隔离间权衡。

VM 有独立内核，启动与内存开销较大，但安全边界通常强于共享内核容器。microVM 通过精简设备模型和启动路径缩短冷启动。

## 16.3 namespace：改变进程看到的世界

Linux namespace 隔离不同资源视图：

- PID：进程编号与树；
- mount：挂载点与文件系统视图；
- network：网卡、路由、端口和防火墙；
- UTS：主机名；
- IPC：System V/POSIX IPC；
- user：UID/GID 映射；
- cgroup/time 等其他视图。

运行：

```bash
./examples/namespace_info
ls -l /proc/self/ns
cat /proc/self/cgroup
```

`/proc/self/ns/pid` 等 symlink 中的编号标识 namespace 实例。两个进程对应链接相同，说明处于同一视图；`setns` 可加入已有 namespace，`clone/unshare` 可创建新视图（受权限与系统配置限制）。

PID namespace 中第一个进程是该视图的 PID 1，负责信号与孤儿回收。容器主进程若不承担 init 职责，可能积累 zombie 或不能按预期响应停止信号。

## 16.4 cgroup：资源不是“看不见”就够了

namespace 主要隔离可见性，cgroup 负责资源记账与控制：

- CPU 权重/配额；
- 内存上限与 OOM 行为；
- I/O 带宽/权重；
- 进程数量等。

不设限的容器虽看不见其他进程，仍可耗尽宿主内存或 fork bomb。反过来，配额不是安全隔离；它不隐藏对象，也不阻止内核漏洞。

## 16.5 rootfs、镜像与 OverlayFS

容器运行时准备一棵 root filesystem，并用 mount namespace 让进程把它看作 `/`。镜像通常由只读层组成，最上面加可写层：

```text
container writable layer
base app layer
runtime layer
distribution layer
        ↓ OverlayFS merged view
```

镜像不是 VM 磁盘的神秘格式，而是文件树、元数据和配置的可分发快照。容器仍使用宿主内核，镜像中的“发行版”主要是用户态库和工具。

可复现构建、固定 digest、非 root 用户、只读 rootfs 和最小基础镜像可减少供应链与运行时风险。

## 16.6 一个容器还需要什么

仅 namespace + cgroup 还不完整，运行时通常还设置：

- capabilities：移除多余 root 特权；
- seccomp：限制系统调用面；
- LSM（SELinux/AppArmor）：强制访问控制；
- veth/bridge/NAT：连接网络 namespace；
- bind mount、volume：提供持久数据；
- rlimit 与 no-new-privileges；
- 生命周期、日志和退出状态管理。

`chroot` 只改变路径解析根，不隔离进程、网络和资源，也不是单独的安全容器。

## 16.7 云上为何两者都要

VM 适合租户级强边界和异构内核，容器适合快速部署与高密度进程隔离。现实云常把容器放进 VM，再用 microVM/sandboxed container 缩小共享内核风险：

```text
physical host
  └─ VM (tenant boundary)
       └─ container (application packaging/resource boundary)
```

层次增加会带来网络、存储、可观测性和调度复杂性。隔离边界必须与攻击者模型匹配，而不是争论某一种技术“取代”另一种。

## 16.8 常见误区

- VM 内每条指令都被软件解释：硬件辅助下绝大多数普通指令直接执行。
- 容器拥有自己的内核：通常共享宿主内核，只隔离视图。
- root in container 等于宿主 root：user namespace 可映射身份，但配置不当、特权容器或内核漏洞仍很危险。
- cgroup 只做限制：它也提供层次化记账与调度权重。
- 镜像层越多运行越慢：读性能取决于文件系统与访问模式；真正问题常是体积、漏洞面和 copy-up。
- 删除容器就删除数据：挂载 volume/bind mount 的生命周期独立。

## 16.9 自测与实验

1. 在宿主和某容器内运行 `namespace_info`，比较 PID、mount、net namespace 与 cgroup。
2. 为什么用户 namespace 能让容器内 UID 0 映射为宿主普通 UID？这解决和没解决什么？
3. 对数据库 workload，容器可写 Overlay 层为何通常不如专用 volume？
4. 画出一次 virtio 块 I/O 从客体进程到宿主设备的路径。
5. 为运行不可信代码选择容器、VM 或二者组合，并写明威胁模型。

最后一章把全部抽象重新串成一张图，并给出 9 个 MiniLab 的实践路线。
