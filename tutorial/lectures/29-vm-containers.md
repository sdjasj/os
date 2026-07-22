# 第 29 讲：虚拟机和容器——制造“系统中的系统”

> 原始讲义：[sources/notes/lect29.md](../../sources/notes/lect29.md)  
> 前一讲：[计算机安全简介](28-security.md) · 后一讲：[课程总结](30-course-summary.md)  
> 配套示例：[namespace_info.c](../../examples/namespace_info.c)

## 0. 本讲定位：隔离不是隐藏，而是重新定义可见状态与可用资源

上一讲从访问控制、内存漏洞、side channel、prompt injection 和供应链攻击说明：单个进程、内核乃至软件生态都可能不可信。于是产生一个系统问题：能否给不可信 workload 一个“看起来完整、实际受控”的计算机世界？

本讲给出两条路线：

```text
full-system virtualization
  模拟/虚拟 CPU、memory、interrupt、devices
  -> guest 可以运行自己的 kernel

OS-level virtualization
  复用 host kernel，虚拟化 syscall 可见的对象视图
  -> namespace + cgroup + image/runtime = container
```

二者都不是凭空复制硬件。它们都在实现一个状态机映射：guest/container 看到一组 virtual states 与 transitions；VMM/host kernel 把它们翻译为受控的 real states 与 transitions。

这也是通往最后一讲的收束点：从第一讲“程序和硬件都是状态机”，到现在一个普通 host process 可以表示一整台 virtual machine；一组普通 host processes 又可以被包装成“系统中的系统”。

## 1. 学习目标与问题地图

学完本讲，应能：

- 区分 ISA emulation、full-system virtualization、paravirtualization、process container；
- 解释 QEMU 一个 host process 如何表示 vCPU、guest physical memory 和 devices；
- 从 interpreter 推导 dynamic binary translation、dyngen 与现代 TCG translation blocks；
- 解释 direct execution、trap-and-emulate、binary translation/ring compression 的分工；
- 画出 guest virtual -> guest physical -> host physical 的两阶段地址翻译；
- 说明 VT-x/AMD-V、EPT/NPT、interrupt virtualization、VT-d/IOMMU 与 virtio 各解决哪一层；
- 从安全角度比较 VM boundary、shared-kernel container boundary 和 microVM；
- 逐一说明 PID、mount、network、user、UTS、IPC、cgroup、time namespace 虚拟化的“视图”；
- 解释 PID reuse 的 TOCTTOU，以及 pidfd/pidfs 稳定引用的边界；
- 只读观察 cgroup v2 的 CPU、memory、I/O、pids accounting/limits；
- 解释 OCI image layers、OverlayFS merged view 与 runtime bundle/process lifecycle；
- 在 workload、隔离、启动速度、密度、兼容性和运维之间选择 VM/container/microVM。

贯穿全文的问题是：

1. 被虚拟化的对象是什么？
2. 哪些操作可直接执行，哪些必须 trap/translate？
3. 控制面保存什么 mapping/policy state？
4. failure 或攻击能跨过哪一道边界？
5. 性能来自减少哪些 interception，代价又是什么？

---

## 2. 一个进程，一台机器：Full System Emulation 的最小模型

NEMU 已给出最朴素的答案：维护 architectural state，反复取指、译码、执行。

```text
while running:
    inst = guest_memory[guest_pc]
    decoded = decode(inst)
    guest_state = execute(decoded, guest_state)
    handle_exception_interrupt_or_mmio_if_needed()
```

若再模拟 timer、interrupt controller、disk、network card、serial port、firmware 和 boot protocol，这个 host program 就足以启动一个未修改的 guest OS。host 看见一个 QEMU process；guest 看见 CPU、RAM、PCI devices 和 disk。

### 2.1 “进程即机器”的状态展开

```text
QEMU process
├── vCPU state: guest registers, flags, control registers, PC
├── guest physical memory: host virtual-memory mappings
├── virtual devices: register state, queues, timers
├── interrupt/event state
├── disk/network/display backends
└── translation cache or KVM vCPU fds
```

这与第 5 讲“进程是状态机”完全一致，只是被模拟的 state 更大。snapshot 可序列化 machine state，migration 可把它转移到另一 host；deterministic replay 则额外记录 nondeterministic inputs。

### 2.2 Emulation 与 virtualization 不应混为同义词

| 方案 | guest ISA 与 host ISA | guest privileged code | 典型路径 | 主要用途 |
| --- | --- | --- | --- | --- |
| interpretation | 可同可异 | 软件逐指令解释 | decode/execute every instruction | 教学、bring-up、精确 instrumentation |
| binary translation/TCG | 可同可异 | 翻译成 host code | translate/cache translation blocks | cross-ISA system/user emulation |
| hardware-assisted virtualization | 通常相同 ISA | guest mode 直接执行，敏感事件 VM exit | KVM/VT-x/AMD-V | 生产 VM、接近 native CPU |
| OS-level container | 没有 guest ISA/kernel | 直接运行 host process | ordinary syscalls into shared kernel | 高密度 Linux workload |

“virtualization 比 emulation 快”太粗糙。QEMU/KVM VM 仍需 device emulation、memory virtualization 和 scheduling；TCG 也可能在相同 ISA 上翻译。判断关键是：多少 guest work 可在 real CPU 上直接执行，多少要跨边界。

### 2.3 性能数字必须带年代与 workload

PPT 用“不及 native 的 10%”强调逐指令解释的致命成本。这是教学量级，不是现代 QEMU 所有模式的固定 benchmark。TCG、translation caching、direct block chaining、multi-threaded vCPU，以及 KVM hardware acceleration 会得到完全不同结果；I/O-bound workload 又可能主要受 virtual disk/network backend 限制。

正确报告至少写 guest/host ISA、QEMU 版本、TCG/KVM、vCPU 数、machine/device model、workload、baseline 与 host contention。

### 2.4 实验一：只探测 QEMU/KVM 能力，不启动 VM

下面不创建 disk、不加载 image、不请求网络，也不使用 root：

```bash
if command -v qemu-system-x86_64 >/dev/null 2>&1; then
  qemu-system-x86_64 --version | sed -n '1,2p'
  printf 'accelerators: '
  qemu-system-x86_64 -accel help 2>&1 | sed -n '1,4p'
  printf 'first machine types:\n'
  qemu-system-x86_64 -machine help 2>&1 | sed -n '1,8p'
else
  echo 'qemu-system-x86_64 is not installed; skip the probe'
fi

if test -e /dev/kvm; then
  ls -l /dev/kvm
  test -r /dev/kvm -a -w /dev/kvm &&
    echo 'current user may open KVM' ||
    echo '/dev/kvm exists but current user lacks access'
else
  echo '/dev/kvm is absent (common in containers/nested VMs)'
fi
```

预期 QEMU 若存在会列出版本、accelerator（可能有 `tcg`、`kvm`）与 machine types。列出 `kvm` 不等于当前用户/CPU/host policy 一定能用；`/dev/kvm` access 是另一个条件。容器或云 VM 可能隐藏 hardware virtualization。实验只检查 command structure，不能测 performance 或 isolation。

一个典型启动命令的结构可读成：

```text
qemu-system-x86_64
  -machine ... -accel kvm|tcg     # CPU execution engine
  -cpu ... -smp ... -m ...        # vCPU and RAM contract
  -drive ...                       # storage backend/frontend
  -device virtio-net-pci,...       # virtual device
  -nographic                       # console/frontend
```

不要从互联网随手下载不可信 image 后以共享 host directory、tap、USB passthrough 或 privileged mode 启动；这些选项扩大 attack surface。

---

## 3. QEMU dyngen：从“解释一条”到“缓存一段 host code”

早期 QEMU 论文的 dyngen 思路很巧：借用 C compiler 为一组微操作生成 host code templates；运行时根据 guest basic block 选择、复制并 relocate templates，形成可执行代码。PPT 的 PowerPC 例子：

```text
guest: addi r1, r1, -16

micro-operations:
  op_movl_T0_r1
  op_addl_T0_im
  op_movl_r1_T0
```

`T0` 是临时寄存器/状态，立即数经 relocation 嵌入。相比 dispatch 每条 guest instruction 的 interpreter，它把一段顺序 guest code 变成一段可直接运行的 host code，摊薄 decode/dispatch。

### 3.1 Dynamic binary translation 的最小流水线

```text
guest PC + relevant CPU mode
  -> fetch/decode guest instructions
  -> lower into intermediate operations
  -> optimize/liveness/register allocation
  -> emit host instructions into code cache
  -> execute
  -> branch/exception/state change exits
  -> lookup or translate next block
```

translation cache 的 key 不只是 guest PC。privilege level、MMU mode、segment state、endianness 等会改变同一 bytes 的语义；QEMU 用 Translation Block（TB）记录关键 CPU state assumptions。

### 3.2 为什么不能“一次编译整个 guest kernel”

- indirect branch 的 target 运行时才知道；
- exception 必须恢复精确 guest PC/state；
- self-modifying code 会让旧 translation 失效；
- guest 修改 page table/MMU mode 后 memory semantics 改变；
- MMIO access 必须调用 device model，不是普通 host load/store；
- interrupt 要在允许的边界注入。

所以 JIT 以 TB/basic-block 粒度缓存和链接。hot path 可 direct-chain 到下一个已翻译 TB；状态变化或需要检查 interrupt 时退出 main loop。

### 3.3 dyngen 是历史方案，现代 QEMU 主线是 TCG

今天应把 dyngen 看作通往 Tiny Code Generator 的历史入口，而不是照搬现代源码结构。QEMU 官方 [TCG translator 文档](https://www.qemu.org/docs/master/devel/tcg.html)说明 TB state specialization、direct block chaining、translated-code invalidation、exception mapping 与 software MMU；[TCG IR 文档](https://www.qemu.org/docs/master/devel/tcg-ops.html)定义 typed operations、temporaries 与 helpers。

这也纠正 PPT 中“把连续代码交给编译器慢慢 profile-guided 优化”的简化印象：现代 TCG 的目标是快速、可移植地产生 code；heavy optimization 会增加 translation latency，是否值得取决于 block hotness 和复用次数。

### 3.4 TCG 与 KVM 在 QEMU 中可以共享 machine/device model

QEMU 不只是一台 CPU translator。用 TCG 时它翻译 guest CPU；用 KVM 时 Linux `/dev/kvm` 让 vCPU 进入 hardware virtualization mode。两者仍可复用 QEMU 的 machine construction、device models、disk/network backends、monitor 和 migration infrastructure。

因此“QEMU 就是模拟器”“KVM 就是一台虚拟机”都不精确：QEMU 是 user-space virtual machine monitor/device emulator；KVM 是 Linux kernel virtualization interface/accelerator，常组合使用。

---

## 4. 黄金时代的起点：Disco、服务器闲置与 consolidation

### 4.1 Disco 把 1970s 的想法带回多处理器时代

Disco（SOSP 1997）在 scalable shared-memory multiprocessor 上用 virtual machine monitor 运行多个 commodity OS instances。它不是“首次想到 VM”，而是把旧思想放到当时新硬件与 workload，重新解决 resource management、NUMA memory、device sharing 等问题。

这展示论文的经典价值：concept 不必凭空出现；当 technology constraints 改变，旧抽象可能获得新解法和新意义。

### 4.2 `.COM` 泡沫附近的现实需求

早期 ISP/企业常按 physical server 部署一个 BBS、mail 或 web service。若各服务平均 CPU utilization 很低，机器、电力、机架和运维仍按整台付费。VM consolidation 把多个互相隔离的 guest 放到一台 host：

```text
capacity gain
  ~= physical resources
     / per-VM reserved + multiplexed demand + virtualization overhead
```

但“平均 10%”不能直接安全装十台：burst 可能相关，memory/storage/network 也会成为 bottleneck。oversubscription 是以 statistical multiplexing 换 density，必须有 admission control、QoS、monitoring 和 failure-domain 设计。

### 4.3 VMM 重新成为产品

VM 对 customer 仍像一台可装 OS、可 reboot、可配置 network/disk 的机器；provider 则可 placement、snapshot、migrate、meter。商业价值与技术机制对齐，促成 VMware 等产品兴起。

PPT 用“黑心商人”调侃 oversubscription，真正工程判断不是“是否超卖”，而是 SLA 是否明确、tail latency 是否可控、noisy neighbor 是否被隔离、故障是否透明报告。

---

## 5. 黄金时代的起点（cont’d）：创业故事与大学的使命

讲义继续讲 VMware 创业团队与硅谷创业公司，也插入 Y Combinator 的名字双关。Y combinator 在 lambda calculus 里让匿名函数获得递归能力：

```python
def Y(f):
    def wrapper(*args):
        return f(wrapper)(*args)
    return wrapper

factorial = Y(lambda rec: lambda n:
              1 if n < 2 else n * rec(n - 1))
```

这段代码与 virtualization mechanism 没有直接依赖；它承载的课堂线索是：扎实概念、研究品味、人才网络、市场窗口可能在很短距离内相遇。

### 5.1 事实、轶事与价值判断分层

- 公司成立年份、论文时间、产品/硬件发布可查证；
- “谁抓住财富机会”是历史叙事，需要多来源；
- “大学应培养什么”是课程观点，不应伪装成 architecture fact；
- 幸存者故事不能证明所有技术创业的成功概率。

大学的使命不只是把当前产品手册教熟，而是让学生能从 primitives 推导新 system：ISA、page table、interrupt、compiler、OS state machine 一旦掌握，就能理解 VMM 为什么可能。

---

## 6. 这些“传说”离我们并不远：论文应把旧想法带到新世界

讲义把 Disco、LFS、SimOS、scheduler activations、Nachos 放在一条“品味传承”线上。共同点不是作者名录，而是研究工作应做到：

1. 找到真实 constraint 或 abstraction mismatch；
2. 说明已有方案为何在新条件下不足；
3. 提出可实现机制；
4. 用诚实 benchmark/trace 证实 trade-off；
5. 让后人能复现、反驳和继续构建。

### 6.1 Benchmark crime 对 virtualization 尤其危险

VM/container benchmark 很容易被选择性设置污染：

- 把 TCG 与 native 比，却不写 guest/host ISA；
- 把 warm cache 的 container 与 cold-boot VM 比；
- 给 baseline 不同 CPU pinning、NUMA placement 或 storage cache；
- 只报 average throughput，隐藏 noisy-neighbor tail latency；
- 在 idle host 测 isolation overhead，却声称 multi-tenant scalability；
- 用一个 microbenchmark 推广到全部 cloud workload。

Gernot Heiser 的 [Benchmarking Crimes](https://gernot-heiser.org/benchmarking-crimes.html)是方法论扩展阅读。LLM 能生成漂亮的图，更要求我们保存 command、configuration、raw data 和 negative results。

### 6.2 “Brings back an idea popular in the 1970s”不是贬义

VM 的复兴说明 novelty 可来自重新组合：旧 abstraction + 新 hardware + 新 workload + 新 implementation。研究贡献要写清哪一项变了，不能靠改名掩盖已知方案，也不能因为概念古老就忽略新的系统问题。

---

## 7. 技能与品味：先能解释机制，才有资格评价设计

数字逻辑告诉我们 privilege/interrupt/page-walk 最终是电路状态转换；体系结构告诉我们 ISA contract；OS 告诉我们 address space、process、device；compiler/JIT 告诉我们 code translation。缺任意一层，评价 VMM 都容易退化为产品名比较。

### 7.1 执行训练的重要性

- NEMU 强迫我们实现 fetch/decode/execute；
- AbstractMachine 把 machine interface 变成可替换 contract；
- differential testing 用 reference state transition 找 emulator bug；
- QEMU/TCG 把同一问题扩展到真实 ISA、exceptions、MMU 和 devices；
- KVM 再把“哪些 transition 交给 hardware”显式化。

环境和见闻决定“你知道有哪些可能”。课程观点不是崇拜旧实验，而是随着工具、Agent 与 industrial systems 变化，持续提高训练的真实性与验证质量。

---

## 8. 我们在追赶的时代：从 live update 到 Agent-Month

PPT 回顾基于 virtualization 的 OS live update，以及本土实验室人才和 industrial impact，再反问 reward hacking：若考试分数消失，是否还会主动学习最后两个实验？

技术主线是：VM 把整个 OS state 变成 VMM 可观察、复制和切换的对象，于是 live update、checkpoint/replay、migration、fault injection 都有了统一抓手。人的主线则是：会跑命令不够，要能提出问题、设计证据、承担结果。

“Mythical Agent-Month”时代，Agent 降低代码生成成本，却不自动降低这些成本：

- 定义正确 specification；
- 建立可信 benchmark；
- 发现 privilege/security boundary；
- 构造 rare failure；
- 判断结果是否有 conceptual novelty。

最值得追赶的不是 patch 数，而是更快形成“假设 -> 实现 -> adversarial test -> 反思”的闭环。

---

## 9. 关键技术：直接执行特权代码

纯 emulation 的每条 guest instruction 都经软件。若 guest ISA 与 host 相同，大多数 ordinary instructions 本可直接在 CPU 跑；真正需要 VMM 介入的是会改变 system-wide privileged state、访问 virtual device、或影响隔离的操作。

### 9.1 Direct execution + trap-and-emulate

理想流程：

```text
guest user/kernel ordinary instruction
  -> direct execution on real CPU

sensitive/privileged operation
  -> trap / VM exit
  -> VMM validates and emulates virtual effect
  -> resume guest
```

例如 guest 关闭 interrupt，只能改变自己的 virtual interrupt-enable state，不能关掉 host CPU 对所有 VM 的中断；guest 写 device register，只能触发 virtual device；guest 改 CR3/page tables，只能改变自己被授权的 address translation。

### 9.2 早期 x86：ring compression、binary translation、shadow page table

经典 x86 有些 sensitive instructions 在非最高 privilege 下不按“清晰 trap”工作，早期 VMware 不能只靠朴素 trap-and-emulate。常见组合是：

- VMM 占据最高 ring；guest kernel 被降到较低 ring；
- dynamic binary translation 找到/patch 不能安全直接执行的 kernel code；
- ordinary instructions 直接执行；
- shadow page table 把 guest page-table intent 合成为 CPU 实际使用的 host mapping；
- guest 对 page tables/CR3 的修改触发 VMM 更新 shadow state。

“在 Ring 3 模拟 Ring 0”是概念表达；历史产品可能使用 ring 1、binary translation 和不同 host architecture 技巧，不能把一个 ring 编号当统一实现。

### 9.3 Shadow paging 为什么昂贵

guest 认为：

```text
guest virtual address (GVA) -> guest physical address (GPA)
```

host 必须再决定：

```text
GPA -> host physical address (HPA)
```

没有硬件二阶段 walk 时，VMM 维护一个直接 `GVA -> HPA` shadow mapping。guest 改 PTE、切 CR3、invalidate TLB 都可能导致 trap、同步或 shadow rebuild；正确跟踪 alias、permission 与 SMP shootdown 很复杂。

### 9.4 VT-x/AMD-V 与 nested paging

硬件 virtualization 增加 guest/non-root execution mode 与 VM control state。guest kernel 可按预期使用自己的 privilege level；被配置为敏感的 event 触发 VM exit。Intel EPT、AMD NPT 让硬件组合两阶段 page walk：

```text
GVA --guest page table--> GPA --EPT/NPT--> HPA
```

TLB/page-walk cache 缓存组合结果。这样显著减少 shadow page-table traps，但 miss 可能要访问两层多级页表，VMM 仍需管理 EPT/NPT permissions、dirty/access bits、memory overcommit、NUMA 与 TLB invalidation。

### 9.5 I/O virtualization：从 trap 到 shared queue

device I/O 有几种层次：

- full device emulation：guest 访问 legacy register/MMIO，QEMU 模拟行为，兼容强、exit 多；
- paravirtual device：guest virtio driver 与 host/backend 通过 shared virtqueues/buffers 协作，减少模拟 legacy hardware；
- device passthrough：把 physical/VF 分给 guest，性能高，但 migration/sharing/device trust 更难；
- VT-d/IOMMU：限制 DMA 可达 host physical pages，并支持 interrupt remapping，是安全 passthrough 的关键。

virtio 是 guest/host 共同遵守的 device interface，不等于“完全不虚拟化”。OASIS [virtio 规范](https://docs.oasis-open.org/virtio/virtio/v1.1/virtio-v1.1.html)定义 device status、feature negotiation、virtqueues 与各类 devices。

### 9.6 VM isolation boundary

VM 分离 guest kernels 和 page tables，通常比 shared-kernel container 提供更强 tenant boundary；但“VM 绝对安全”是错的。attack surface 包括：

- hypervisor/KVM/QEMU device-model bugs；
- malicious virtual device inputs 与 image parser；
- passthrough/IOMMU misconfiguration；
- shared CPU cache、branch predictor、memory dedup 等 side channels；
- host kernel/firmware 管理面；
- management API、snapshot 与 image supply chain。

隔离强度取决于最弱共享层、configuration 与 patching，而不只取决于产品标签。

---

## 10. 虚拟化的黄金时代：paravirtualization、硬件协作与机器状态管理

### 10.1 Xen：修改 guest，主动把难操作变成 hypercall

Xen 2003 选择 paravirtualization：guest kernel 知道自己运行在 hypervisor 上，不直接执行难虚拟化的敏感操作，而通过 hypercall 请求 page-table update、interrupt/event 与 I/O。ordinary user code 仍直接执行。

```text
unmodified application
  -> guest syscall
  -> paravirtualized guest kernel
  -> hypercall/event channel/grant table
  -> hypervisor
```

优势是早期没有 VT-x/EPT 时仍能高效；代价是修改/维护 guest OS，不能透明运行任意 proprietary kernel。今天同一 VM 也可能同时使用 hardware-virtualized CPU 与 paravirtual virtio devices；“full virtualization”和“paravirtualization”不是只能二选一的产品标签。

### 10.2 Hardware/software co-design

Intel VT-x、AMD-V 把 guest execution/VM exit 变成 architectural mechanism；EPT/NPT 加速 memory virtualization；VT-d/AMD IOMMU 管 DMA/remapping；APIC virtualization、posted interrupts 等继续减少 interrupt exits。

硬件并没有“消灭 hypervisor”：VMM 仍决定哪些 events intercept、GPA->HPA mapping、vCPU scheduling、virtual topology、device backend、migration compatibility 和 policy。硬件提供可组合 primitives，软件兑现 VM abstraction。

Linux KVM 把 VM/vCPU/memory region/interrupt 等控制暴露为 `/dev/kvm` ioctls；QEMU 常作为 user-space VMM 调用它。版本和 architecture 细节以 Linux 官方 [KVM API 文档](https://docs.kernel.org/virt/kvm/api.html)为准。

### 10.3 I/O 为什么常比 CPU 更难

CPU-bound guest 大段 direct execute，VM exit 少时可接近 native；I/O path 可能经过 guest driver、virtqueue、event notification、QEMU/vhost backend、host filesystem/block/network stack。zero-copy、batching、vhost kernel/userspace accelerator、SR-IOV 都在减少 copies/exits，却会改变 isolation、observability 和 live migration。

性能报告因此要分别测 CPU、memory、storage、network、startup、migration 和 tail latency，不能只跑一个算术 loop 宣布“虚拟化无开销”。

### 10.4 ReVirt：记录 nondeterminism，重放机器执行

若初始 machine snapshot 相同，并记录 interrupt timing、device input、network packets 等 nondeterministic events，VMM 可以重演 guest 的 instruction-level execution，用于 intrusion analysis/debugging。

难点是 SMP：多个 vCPU 的 data races/ordering 本身就是 nondeterministic input；现代 replay 必须约束/记录它，日志量和运行扰动会增加。replay 也不等于 backup：若初始 image 或 log 被攻击者篡改，重演仍不可信。

### 10.5 Migration：移动的不只是 RAM bytes

live migration 常用 pre-copy：guest 运行时复制 memory，追踪 dirty pages，反复传增量，最后短暂停机传剩余 state 并切 network/storage identity。若 dirty rate 接近链路带宽，可能不收敛；post-copy 等方案改变 downtime 与故障风险。

完整 state 还包括 vCPU registers、virtual devices、timers、pending interrupts、disk state 和 network connections。source/destination QEMU machine type、CPU feature contract 与 devices 必须兼容。PPT 的“慢 DSL 分钟迁移”展示机制潜力，不应当作现代所有 VM 的固定时延。

### 10.6 黄金时代留下的抽象

VM 让 machine state 成为可管理对象：create、pause、snapshot、clone、replay、migrate、meter、destroy。云平台在这些 verbs 上叠 placement、billing、health management 和 tenant isolation；这比“同一 host 多跑几套 OS”更深刻。

---

## 11. 虚拟化的另一个方法：让 OS 虚拟化自己的对象视图

应用不能直接读 CR3、硬盘 controller 或 physical memory；它主要通过 syscall 观察 PID、path/mount、socket、UID、hostname、IPC、clock。既然 kernel 本来就为每次 syscall 查 object，何不让 lookup 带一个 namespace identity？

教学模型可以写成：

```c
struct task {
    struct nsproxy *namespaces;
    struct cred *credentials;
    struct cgroup_subsys_state *resource_groups;
    /* address space, fds, signals, ... */
};
```

同一个 real kernel object 可以在不同 namespace 中不可见或用不同 ID/name 表示。容器里的 `pstree` 从 PID 1 开始，不是另外启动了一颗 CPU/内核，而是 PID lookup 和 `/proc` view 被虚拟化。

### 11.1 从 `osid` 思想实验到多维 namespace

给 process 一个单一 `osid`，让 PID 从 1 分配、fork 继承，看似够用；但现实需要分别共享/隔离：两个 container 可能共享 network 却不共享 mount，或共享 user namespace 的 parent relation。Linux 因此把视图拆成多种 namespace objects，而不是一个全能 container ID。

### 11.2 Container 不是“没有虚拟化”

VM 虚拟化 hardware interface，让 guest kernel 管对象；container 虚拟化 OS interface，让 host kernel 按 namespace/cgroup/credentials 解释对象。二者都维护 mapping 和 policy，只是 boundary 不同。

容器进程执行 native instructions、ordinary syscalls，不需要每条 syscall 进入一个 user-space simulator。低 overhead 来自共享 kernel 和省略虚拟硬件/guest boot，不代表 namespace lookup、OverlayFS、virtual network、cgroup accounting 没成本。

---

## 12. Aside: pidfs——从可复用整数到稳定对象引用

### 12.1 PID 的 TOCTTOU

反例：

```text
pid = search_process_by_name()
... delay ...
kill(pid, SIGKILL)
```

目标可能已退出，numeric PID 被另一个 task 复用；检查和使用分离，`kill` 可能命中新进程。加快 `ps | grep` 不能从语义上消除 race。

### 12.2 pidfd 是 capability-like stable reference

```c
int pidfd = pidfd_open(pid, 0);
pidfd_send_signal(pidfd, sig, NULL, 0);
```

`pidfd_open` 在 lookup 成功时获得对特定 process identity 的 fd 引用；之后 signal/poll/wait 等操作通过 fd，不会因整数 PID 被复用而改指另一个进程。它把第 7 讲反复出现的模式再次兑现：先把不稳定 name/number lookup 成稳定 fd，再操作 object。

边界：pidfd 不让进程永生；target exit 后 fd 可用于通知/等待相关语义，signal 会失败而不会转向未来同号进程。权限检查仍存在，拿到 fd 不自动越权。

“pidfs”指 kernel 为 pidfd 等提供的 pseudo-filesystem/object representation；应用首先依赖的是 documented pidfd API。不要把 `/proc/PID` pathname、numeric PID、pidfd 三者当成同一稳定性。

### 12.3 实验二：安全观察 namespace identity、cgroup 与 pidfd readiness

先把仓库示例编译到唯一临时目录。它只读 `/proc/self/ns/*` 和 `/proc/self/cgroup`：

```bash
lab=$(mktemp -d /tmp/lect29-ns.XXXXXX) || exit 1
case "$lab" in /tmp/lect29-ns.*) [ -d "$lab" ] || exit 1 ;; *) exit 1 ;; esac
tool="$lab/namespace_info"
cleanup_ns_lab() {
  rm -f -- "$tool"
  rmdir -- "$lab" 2>/dev/null || true
}
trap cleanup_ns_lab EXIT HUP INT TERM

cc -std=c11 -O2 -Wall -Wextra -D_POSIX_C_SOURCE=200809L \
  examples/namespace_info.c -o "$tool" || exit 1
"$tool"

echo 'self namespace handles:'
ls -l /proc/self/ns 2>&1 | sed -n '1,24p'
echo 'PID 1 comparison (some entries may be permission denied):'
for ns in pid mnt net uts ipc user cgroup time; do
  printf '%-7s self=' "$ns"
  readlink "/proc/self/ns/$ns" 2>/dev/null || printf 'unavailable\n'
  printf '%-7s pid1=' "$ns"
  readlink "/proc/1/ns/$ns" 2>/dev/null || printf 'unavailable\n'
done

rm -f -- "$tool"
rmdir -- "$lab"
trap - EXIT HUP INT TERM
unset -f cleanup_ns_lab
```

symlink target 常形如 `mnt:[4026531841]`；相同 type 和 inode-like number 表示同一个 namespace object。容器可能无法读取 PID 1 的某些 links，old kernel 可能没有 `time` entry；这是权限/版本边界，不应以 root 绕过。

可选的 Python 3 pidfd probe 创建自己的短命 child，不发送 signal：

```bash
python3 - <<'PY'
import os, select, subprocess

if not hasattr(os, "pidfd_open"):
    print("Python/kernel does not expose pidfd_open; skip")
    raise SystemExit(0)

child = subprocess.Popen(["sleep", "0.1"])
fd = os.pidfd_open(child.pid, 0)
poller = select.poll()
poller.register(fd, select.POLLIN)
print("pid=", child.pid, "pidfd=", fd,
      "before_exit=", poller.poll(0))
child.wait()
print("after_exit=", poller.poll(1000))
os.close(fd)
PY
```

预期 exit 前没有 readiness，exit 后 pidfd 变为 readable/hangup 相关 event（具体 mask 用整数显示）。这证明 fd 可观察那个 child 的生命周期，不证明任意 PID search 安全；安全步骤仍是尽早 `pidfd_open` 并处理 lookup failure。

Linux [pidfd_open(2)](https://man7.org/linux/man-pages/man2/pidfd_open.2.html)与 [pidfd_send_signal(2)](https://man7.org/linux/man-pages/man2/pidfd_send_signal.2.html)是接口扩展阅读。

---

## 13. 这个想法其实很古老：chroot 只改一个路径解析起点

Version 7 UNIX 的 `chroot` 让 process 的 pathname `/` 从另一个 directory 开始解析。它对 packaging/testing 有用，却不是完整安全 container：

- PID 与 process table 仍共享；
- network stack、ports、hostname、IPC 仍共享；
- resource usage 没有限制；
- privileged process、open fds、mounts 与历史实现可能提供 escape path；
- host kernel 完全共享。

因此“目录看起来像 rootfs”不等于隔离。安全 chroot 还需 drop privileges、关闭越界 fds、控制 mounts/capabilities 等；现代 container 使用多 namespaces、cgroups、capability/LSM/seccomp 配合。

### 13.1 从 OS objects 枚举 virtualization surface

想造一个“完全虚拟 OS view”，就回顾 OS 有哪些对象：process IDs、filesystem/mounts、credentials、IPC、network devices/routes/ports、hostname、clocks、resource accounting。Namespaces 正是按这个清单逐步发展；漏掉任何共享对象都可能造成冲突、信息泄漏或逃逸通道。

---

## 14. 祝贺，你发明了 Linux Namespaces！

Linux namespace 是 kernel object；task 通过 `nsproxy`/credentials 等引用一组 namespace。`clone(CLONE_NEW*)` 创建 child 时建立某种新 namespace；`unshare()` 让 caller 不再共享；`setns(fd, type)` 加入 fd 引用的既有 namespace。具体权限由 user namespace、capabilities、target relation 和 namespace type 决定。

### 14.1 每一种 namespace 到底虚拟化什么

| namespace | 主要虚拟视图/对象 | 关键边界 |
| --- | --- | --- |
| PID | process IDs、parent relation、namespace init | nested；同一 task 在各层有不同 PID；`/proc` mount 要匹配视图 |
| mount | mount table、mount propagation | 不是自动复制 file bytes；shared/private propagation 会跨边界传播 mount events |
| network | interfaces、routes、ports、firewall state、network stack | 新 net ns 初始常只有 loopback；连外界需 veth/bridge/routing |
| user | UID/GID mapping、scoped capabilities | container uid 0 可映射为 host unprivileged UID；映射/权限规则严格 |
| UTS | hostname、NIS domain name | 不隔离 DNS/network；只是 utsname fields |
| IPC | SysV IPC、POSIX message queues 等 | ordinary file-backed `mmap` 仍由 mount/file permissions 决定 |
| cgroup | `/proc` 等处可见的 cgroup root/view | 不负责资源限制本身；限制由 cgroup controllers |
| time | monotonic/boottime clock offsets | 不虚拟化 `CLOCK_REALTIME` wall clock，也不等于 timezone |

PPT 将 time 概括成“系统时间和时区”；现代 Linux time namespace 的精确语义是对部分 clocks 的 offsets，timezone 通常由 userspace files/environment（如 `/etc/localtime`, `TZ`）决定。教学扩写应在这里校准抽象。

### 14.2 PID namespace 的 PID 1 不是装饰

namespace 第一个 process 成为该层 PID 1，承担 orphan adoption/reaping，并对 signals 有特殊规则。若它退出，kernel 会终止该 PID namespace 中其余 processes。容器里只跑一个不会 reap children 的 app，可能积累 zombies；runtime 常加入 minimal init。

从 host 看 container init 仍有 host PID。`ps`/`/proc` 是否显示 container view，还取决于 procfs 是否在对应 PID/mount namespace 重新 mount；只调用 `unshare(CLONE_NEWPID)` 不会神奇改好所有观察工具。

### 14.3 user namespace：看似 root，不是 host root

user namespace 把 inside UID/GID 映射到 outside IDs，并让 capabilities scoped 到 owning user namespace 及其 descendants。它是 unprivileged container 的基础，也扩大 kernel attack surface：inside “root” 可调用更多 namespaced kernel paths，但不能凭此拥有 parent namespace 的任意能力。

mapping 写入、setgroups policy、filesystem ownership 与 idmapped mounts 细节随 kernel/configuration 演进，不能用“容器里 uid 0 = 安全”或“= host root”概括。

### 14.4 mount namespace 与 Overlay rootfs

mount namespace 隔离 mount table，不自动限制一个已打开的 host fd，也不自动禁止 device nodes。runtime 通常构造新的 rootfs、设置 bind/pseudo-filesystems、pivot_root/chroot、调整 mount propagation，并关闭不该继承的 fds。

namespace 是 visibility boundary；DAC/capability/LSM/seccomp 是 authorization/action boundary。安全 container 需要组合它们。

### 14.5 实验三：条件探测无特权 user + UTS namespace

这段只在新 user/UTS namespace 内改 hostname；先后读取 host hostname 验证未改变。许多发行版、容器 sandbox 或 sysctl 会禁止 unprivileged user namespace，失败是预期分支：

```bash
before=$(hostname)
echo "host before: $before"

if command -v unshare >/dev/null 2>&1; then
  if unshare --user --map-root-user --uts sh -c '
       hostname lect29-inside || exit 1
       printf "inside uid="; id -u
       printf "inside hostname="; hostname
       printf "inside user ns="; readlink /proc/self/ns/user
       printf "inside uts ns="; readlink /proc/self/ns/uts
     '
  then
    echo 'unshare probe succeeded'
  else
    echo 'unprivileged user/UTS namespaces are disabled or filtered; skip'
  fi
else
  echo 'unshare command is unavailable; skip'
fi

after=$(hostname)
echo "host after:  $after"
test "$before" = "$after"
```

成功时 inside UID 常显示 0，但它映射到 caller 的 outside identity；inside hostname 改为 `lect29-inside`，host 前后相同。失败常见原因有 kernel config、`user.max_user_namespaces`、LSM/seccomp、container runtime policy；不要使用 `sudo` 把失败“修掉”，否则实验改变了 threat model。

Linux [namespaces(7)](https://man7.org/linux/man-pages/man7/namespaces.7.html)与各 namespace 子页面给出系统调用/权限语义；`lsns` 是观察工具，不是 namespace 创建机制。

---

## 15. 再进一步：资源调度——cgroup 与 namespace 正交

namespace 回答“你看见哪些对象/名字”；cgroup 回答“一组 processes 可用多少资源、如何统计/调度”。一个 process 可以与另一个 process 共享 PID namespace，却位于不同 cgroup；也可在不同 namespaces 中但受同一上层 cgroup budget。

### 15.1 cgroup v2 的层次与 controllers

cgroup v2 是一棵 hierarchy。process 被放入某个 cgroup，资源 controller 在 parent-child 层次分配/限制。常见文件：

| controller | 观察/控制文件 | 含义与边界 |
| --- | --- | --- |
| CPU | `cpu.stat`, `cpu.max`, `cpu.weight` | usage、quota/period、相对权重；quota 不是独占 core |
| memory | `memory.current`, `memory.high`, `memory.max`, `memory.events` | 当前使用、throttle/reclaim、hard limit/OOM events |
| I/O | `io.stat`, `io.max`, `io.weight` | block-device accounting/limits；效果依 backend/controller support |
| pids | `pids.current`, `pids.max`, `pids.events` | task 数限制；防 fork bomb，不是 CPU 限制 |

还可有 cpuset、hugetlb、RDMA 等。controller 是否出现在 `cgroup.controllers`、是否 delegated、文件是否存在取决于 host 配置。

### 15.2 实验四：只读观察自己所在的 cgroup v2

绝不向 `/sys/fs/cgroup` 写值，不改宿主限制：

```bash
findmnt -t cgroup2 2>/dev/null ||
  echo 'cgroup v2 mount is not visible'
echo '/proc/self/cgroup:'
sed -n '1,20p' /proc/self/cgroup

relative=$(awk -F: '$1 == "0" {print $3}' /proc/self/cgroup)
current="/sys/fs/cgroup$relative"
case "$current" in
  /sys/fs/cgroup|/sys/fs/cgroup/*) ;;
  *) echo 'unexpected cgroup path' >&2; exit 1 ;;
esac

echo "current cgroup: $current"
for file in cgroup.controllers cgroup.procs cpu.stat cpu.max cpu.weight \
            memory.current memory.high memory.max memory.events \
            io.stat io.max pids.current pids.max pids.events; do
  if test -r "$current/$file"; then
    echo "[$file]"
    sed -n '1,12p' "$current/$file"
  fi
done
```

预期 `0::/path` 表示 unified hierarchy；`max` 表示该层没有数值 hard limit，但仍受 ancestors/host capacity 限制。容器中 `memory.max` 可能有限，`cpu.max` 如 `200000 100000` 表示每 100 ms period 最多 200 ms CPU time（可跨多个 CPU），不是固定绑两核。

`io.stat` 为空不证明“没有 I/O”，可能是 controller/backend/accounting visibility 差异。读取只是瞬时 snapshot；并发 workload 会让 counters 变化。Linux 官方 [cgroup v2 文档](https://docs.kernel.org/admin-guide/cgroup-v2.html)是字段语义依据。

### 15.3 namespace + cgroup 仍不等于完整 container product

还需要：

- root filesystem/image 与 copy-on-write layer；
- process lifecycle/runtime；
- capabilities、seccomp、LSM、no-new-privileges；
- virtual network 与 DNS；
- logging、secrets、health、update；
- image provenance/signature/scanning；
- orchestration 与 failure handling。

Docker/LXC/containerd/runc/Kubernetes 位于不同层，不能都叫“一个 namespace wrapper”。

### 15.4 Image、OverlayFS 与 runtime

OCI image 是 content-addressed manifest/config 与有序 filesystem changesets/layers；不是一个正在运行的 container。lower layers 通常只读共享，container 获得 writable upper layer；OverlayFS merged view 做 lookup，修改 lower file 时 copy-up，删除用 whiteout 表达。

```text
read-only lower layers: base <- libraries <- application
                          + writable upper
                          -> merged rootfs seen by process
```

layer 提高 distribution/cache/dedup 效率，也会带来 copy-up latency、inode/permission/xattr 语义、page cache 与 image supply-chain 问题。volume/bind mount 往往绕过 writable layer，生命周期另算。

OCI runtime bundle 通常包含 `config.json` 与 rootfs；low-level runtime 按 spec 创建 namespaces、cgroups、mounts、credentials/capabilities/seccomp，再 exec process。OCI [Image Specification](https://specs.opencontainers.org/image-spec/)与 [Runtime Specification](https://specs.opencontainers.org/runtime-spec/)区分“可分发内容”与“如何运行”。

FreeBSD Jails、Solaris Zones、Linux containers 表明 OS-level isolation 不是 Docker 才发明。namespaces/cgroups 是 meta-mechanisms；产品价值来自把它们组合成可复用、安全、可运维的 contract。

---

## 16. 云时代的虚拟机：VM、容器与编排是互补层

### 16.1 “如果只需要 Linux，容器就和虚拟机完全一样”应怎样理解

对许多 Linux application，container 提供相似的部署体验：独立 rootfs、process tree、network identity、resource budget，进程可以被 start/stop/restart。作为课堂直觉，这解释容器为何能替代大量“每服务一台 Linux VM”的用途。

严格语义却不完全相同：

- container 与 host 共享 kernel/version/configuration；VM 可运行另一个 kernel/OS；
- container 内不能任意加载 kernel module、改变 host-global sysctl 或依赖不同 syscall ABI；
- kernel vulnerability 可能跨 container；VM 还隔着 virtual hardware/hypervisor boundary；
- `/proc`, time, device, security module、eBPF 等行为会暴露 shared-kernel 特征；
- checkpoint/migration、live kernel update 与 device access 能力不同。

因此应把 PPT 的“完全一样”读成**面向一类 workload 的 operational substitutability**，不是形式语义或安全边界等价。

### 16.2 VM、container、microVM 的设计点

| 维度 | 传统 VM | shared-kernel container | microVM |
| --- | --- | --- | --- |
| guest kernel | 独立、可不同 OS | 与 host 共享 | 独立、通常精简 Linux |
| CPU path | hardware virtualization | host native process | hardware virtualization |
| device model | 较完整，兼容性高 | host kernel objects | 最小 devices/boot path |
| isolation | 通常较强，仍依赖 VMM/host | kernel 是共同 attack surface | VM boundary，缩小 device attack surface |
| 启动/内存 | 通常更高 | 通常最低 | 介于两者，目标是很快/很小 |
| density | 较低 | 较高 | 折中 |
| kernel flexibility | 高 | 低 | 高于 container |
| image/ops | VM disk + machine config | OCI layers + runtime | kernel/rootfs + microVM config，可被 container control plane 包装 |

microVM（例如 minimalist VMM 路线）不是神秘第三种 virtualization primitive：它仍用 KVM/硬件 VM，只减少 legacy device model、boot surface 与 per-guest overhead，以保留 VM boundary 并接近 container density/startup。

另有 sandboxed-container 设计在 syscall interception、user-space kernel 或 VM-backed runtime 上取不同点。选择不能只看 cold-start 一个数字。

### 16.3 多租户：trust boundary 决定默认选择

```text
same owner / mutually trusted services
  -> container 往往足够，配合 least privilege

different tenants / hostile code
  -> VM 或 VM-backed sandbox 常是更稳妥默认

special hardware / maximum I/O
  -> passthrough/SR-IOV，但加强 IOMMU 与运维隔离
```

即便使用 VM，tenant isolation 还需 host patching、management-plane authentication、image provenance、network/storage encryption、side-channel mitigation、rate limiting 和 audit。即便同一 owner，container 也应 drop capabilities、rootless/user namespace、seccomp/LSM、read-only rootfs、resource limits，而不是 `--privileged`。

### 16.4 Density、oversubscription 与 noisy neighbor

云 provider 将 CPU、memory、I/O、network 和 failure domain 统计复用。平均 utilization 提高能降低成本/能耗，但 overcommit 造成：

- CPU steal/throttling；
- memory reclaim/swap/OOM；
- shared cache/NUMA interference；
- storage/network queue tail latency；
- 同 host 故障影响多个 tenants。

cgroup quota/weight 和 hypervisor scheduler 是控制手段，不会凭空创造 capacity。SLA 需要 percentile、burst policy、placement 和 admission control；billing unit 不等于独占 physical resource。

### 16.5 Kubernetes：管理 desired state，不是新的 CPU 虚拟化

Kubernetes 的核心控制循环：

```text
user declares desired objects
  -> API server persists intent
  -> controllers reconcile actual vs desired
  -> scheduler chooses node
  -> kubelet/container runtime starts Pod
  -> readiness/health/service routing update
  -> failure triggers replacement/reconciliation
```

Pod 是一组紧密协作 containers 的调度/共享单位，常共享 network namespace，并可共享 volumes；它不是硬件 VM。container crash 可由 restart policy 恢复，node failure 可在另一 node 重建 Pod，但 process memory/local writable layer 不会自动迁移。

### 16.6 “无状态”简化了重建，不等于业务没有状态

stateless frontend 把 durable state 放进 database/object store，任一 replica 可替换。stateful workload 仍需：

- persistent volume 与 storage failure model；
- application replication/consensus/backup；
- stable identity/ordering；
- graceful rollout 与 schema compatibility；
- region/zone failure planning。

Kubernetes health check 只能判断 probe；不能证明 request 没丢、数据库一致或新版本语义兼容。

### 16.7 声明式系统把人工错误转成 specification 问题

PPT 总结：机器不可靠，用多副本/故障转移；人工不可靠，用声明式 reconciliation；环境不可靠，用 container image 固化 userspace。每项都有限度：

- replicas 若共用同一 bug/zone/credential，仍会一起失败；
- 错误 desired state 会被 controller 忠实地大规模实现；
- image 固化 rootfs，不固定 host kernel、CPU、clock、network、external services/secrets；
- immutable layer 不保证 supply-chain 可信，需 digest/signature/provenance/scanning。

“云原生”不是把程序装进 image 就完成，而是把 failure 当日常 transition，设计可观测、可替换、可回滚的 control loop。

### 16.8 从安全课到课程总结

上一讲问“如何限制不可信代码”；本讲给出两个 sandbox boundary。下一讲则把它们与此前所有抽象统一：process/VM/container 都是在 specification 下虚拟状态，security 来自 reference monitor 和最小权限，cloud reliability 来自对 failure transition 的显式处理。

---

## 17. 一张统一机制图

```text
application instructions/syscalls
          |
          +-- container ------------------------------+
          |   same host ISA + same host kernel        |
          |   namespace: object views                 |
          |   cgroup: accounting/scheduling/limits    |
          |   OCI/Overlay/runtime: packaging/lifecycle|
          |                                           |
          +-- virtual machine -------------------------+
              guest ISA/kernel
              direct execute or TCG
              VM exit/hypercall
              EPT/NPT: GPA -> HPA
              QEMU/virtio/passthrough: virtual I/O
              hypervisor/cgroup: host resources
```

VM process 自己也可以被 host cgroup 限制，也可运行在 containerized management environment；VM 内又可跑 containers。层次组合很常见，边界分析必须问“哪一层与谁共享 kernel/device/control plane”。

### 17.1 机制对照表

| 问题 | VM 路线 | container 路线 |
| --- | --- | --- |
| CPU identity | vCPU state / CPUID contract | host thread/process |
| address translation | guest PT + EPT/NPT | ordinary process PT |
| privileged operation | VM exit/hypercall/emulate | syscall into host kernel |
| device | emulated/virtio/passthrough | namespace/device cgroup/host fd |
| process IDs | guest kernel PID | PID namespace mapping |
| filesystem | virtual disk + guest FS | mount namespace + rootfs/Overlay |
| resource control | VMM + host scheduler/cgroup | cgroup controllers |
| isolation root | hypervisor + host | host kernel |
| packaging | disk/snapshot/machine type | OCI manifest/layers/config |

---

## 18. 概念辨析与常见误区

| 误区 | 正确边界 |
| --- | --- |
| QEMU 一定很慢 | TCG 与 KVM 路径不同；还要区分 CPU 与 I/O workload |
| KVM 等于 QEMU | KVM 是 kernel accelerator/API；QEMU 是 user-space VMM/device ecosystem |
| virtualization 必须模拟不同 ISA | 同 ISA hardware-assisted VM 是主流；cross-ISA 才必须 translation/emulation |
| EPT 让 memory virtualization 无成本 | 减少 exits/shadow sync；two-dimensional walk、TLB/NUMA 仍有代价 |
| virtio 是 device passthrough | virtio 是 paravirtual interface；backend/passthrough 是另一层选择 |
| VM 一定不能逃逸 | hypervisor/device/host/side-channel 都是 attack surface |
| container 是轻量 VM | 它是被 namespaces/cgroups 限制的 host processes，共享 kernel |
| chroot 就是 container | 它主要改变 pathname root，不隔离 PID/network/resources |
| namespace 负责 CPU/memory 限制 | namespace 管视图；cgroup 管 accounting/control |
| cgroup namespace 就是 cgroup controller | 前者虚拟可见层次，后者实施资源 policy |
| container 内 UID 0 就是 host root | user namespace 可映射为 host unprivileged UID；配置决定能力范围 |
| PID namespace 自动让 `ps` 正确 | 还需匹配的 procfs mount 和 init/reaping |
| time namespace 能改所有时间/时区 | 只偏移特定 clocks；wall clock/timezone 另有机制 |
| image 保证环境完全相同 | host kernel/CPU/external services/config/secrets 仍不同 |
| Pod 就是 VM | Pod 是 container 编排/共享单位，不含独立 guest kernel |

---

## 19. 思考题与延伸观察

1. 为什么同 ISA VM 仍需要 device emulation？CPU direct execute 解决了什么、没解决什么？
2. QEMU TB cache 的 key 若只有 guest PC，会在哪些 privilege/MMU state 变化下出错？
3. self-modifying code 为什么要求 invalidation？怎样保持 precise guest exception PC？
4. 早期 x86 binary translation 与 Xen paravirtualization分别把修改成本放在哪一侧？
5. shadow page table 与 EPT/NPT 各维护哪种 mapping？为什么后者仍需 VMM？
6. passthrough 为什么需要 IOMMU？没有 DMA isolation 时 guest device 能破坏什么？
7. 一台 VM live migration 需要处理哪些 CPU 以外的状态？dirty rate 太高会怎样？
8. PID number、`/proc/PID` 与 pidfd 分别是哪种引用？哪一步仍可能 lookup race？
9. 为什么 user namespace 的 inside root 既有用又扩大 kernel attack surface？
10. mount namespace 隔离 mount table，为什么继承的 host fd 仍可能越界？
11. time namespace 为什么不等于把 wall-clock 拨到任意日期？
12. `cpu.max=max 100000` 是否代表独占全部 CPU？ancestor cgroup 会如何影响？
13. Overlay copy-up 对大文件首次写有什么 latency/space 后果？volume 又绕过哪一层？
14. 为不可信第三方编译任务选择 container、microVM 还是 VM？列出 threat model 和 benchmark。
15. Kubernetes 重建 Pod 时，哪些 state 自动回来，哪些必须由应用/存储层恢复？
16. 若所有 replicas 使用同一个受污染 image，多副本为何不能提高正确性？

延伸实验坚持只读/无特权：比较 `/proc/self/ns/*` 与另一个自己启动的 process；周期采样 `cpu.stat/memory.current/pids.current`；若 QEMU 可用，只阅读 `-accel help/-machine help/-device help`。不要创建 host bridge、改 cgroup limits、mount image、开启 privileged container 或加载 kernel module。

---

## 20. Takeaways：两种虚拟化都在重写“你看见的机器”

1. full-system emulation 把 architectural/device state 放进 process；dynamic translation 缓存 guest -> host code。
2. 同 ISA virtualization 让 ordinary code direct execute，对 sensitive events trap/VM exit；硬件 VT-x/AMD-V、EPT/NPT、IOMMU 降低 interception 成本。
3. QEMU/TCG、QEMU/KVM、virtio 与 passthrough 是可组合层，不是互斥品牌。
4. VM 把 OS state 变成可 snapshot/replay/migrate 的对象，也形成多租户隔离边界；边界仍有 VMM、device、host 与 side-channel 风险。
5. container 复用 host kernel，通过 namespaces 虚拟对象视图，通过 cgroups 计量/调度/限制资源。
6. pidfd 把可复用 numeric PID lookup 变成 stable fd reference，再次体现“名字 -> 对象”的 OS 设计。
7. OCI image/OverlayFS 负责可分发 rootfs changes，runtime 负责创建受限 processes；Kubernetes 负责 desired-state reconciliation。
8. container、VM、microVM 的选择来自 workload 与 threat model，不来自“哪个更现代”。
9. 云系统的可靠性不是机器永不失败，而是 failure 被发现、隔离、替换、恢复并留下证据。

最后一讲会把这条规律推广到整门课：

```text
找到真实状态
  -> 定义允许的 transitions
  -> 建立抽象/虚拟视图
  -> 维护 mapping 与 invariant
  -> 观察 failure/security boundary
  -> 用可复现实验证伪
```

---

## 21. 阅读材料与时效说明

PPT 主线的经典文献包括 Disco、QEMU dynamic translation、Xen、ReVirt 与 virtual-machine migration；它们解释机制为何产生。扩展到当前实现时优先查：

- QEMU 官方 [TCG translator internals](https://www.qemu.org/docs/master/devel/tcg.html)；
- Linux 官方 [KVM API](https://docs.kernel.org/virt/kvm/api.html)与 [cgroup v2](https://docs.kernel.org/admin-guide/cgroup-v2.html)；
- Linux man-pages [namespaces(7)](https://man7.org/linux/man-pages/man7/namespaces.7.html)、[pidfd_open(2)](https://man7.org/linux/man-pages/man2/pidfd_open.2.html)；
- OASIS [virtio specification](https://docs.oasis-open.org/virtio/virtio/v1.1/virtio-v1.1.html)；
- OCI [Image](https://specs.opencontainers.org/image-spec/) 与 [Runtime](https://specs.opencontainers.org/runtime-spec/) specifications；
- FreeBSD Handbook 的 [Jails](https://docs.freebsd.org/en/books/handbook/jails/)历史/机制说明。

这些页面会随 QEMU、kernel 与 OCI revisions 演进。本文固定的是抽象和验证方法；command/feature availability 必须记录当前 host architecture、kernel、QEMU/runtime 版本与 policy。接下来进入[第 30 讲课程总结](30-course-summary.md)。

---

## 22. PPT 内容覆盖表

下表第一列按 `lect29.md` 一级标题顺序逐字保留；`黄金时代的起点 (cont’d)` 与前页在正文连续讲解，但单列以便机械审计。

| 原讲义一级标题（按出现顺序） | 本章对应位置 | 覆盖要点 |
| --- | --- | --- |
| 虚拟机和容器 | §0–§1、§17 | 两条虚拟化路线、全章问题地图与统一机制图 |
| 一个进程，一台机器 | §2、实验一 | full-system state、NEMU、emulation/virtualization、QEMU/KVM安全探测 |
| QEMU dyngen | §3 | micro-op template、DBT/TCG、TB/cache/chaining/invalidation、TCG与KVM |
| 黄金时代的起点 | §4 | Disco、1970s idea、服务器低利用率、consolidation/oversubscription |
| 黄金时代的起点 (cont’d) | §5 | VMware/创业叙事、Y combinator、大学使命与事实/观点分层 |
| 这些 “传说” 离我们并不远 | §6 | LFS/Disco/SimOS/Nachos、论文意义与 benchmark crime |
| 技能与品味 | §7 | 数字逻辑/ISA/OS/compiler 基础、NEMU/AM/differential testing |
| 我们在追赶的时代 | §8 | live update、人才与 impact、reward hacking、Mythical Agent-Month |
| 关键技术: 直接执行特权代码 | §9 | trap-and-emulate、binary translation、shadow PT、EPT/NPT、I/O/IOMMU |
| 虚拟化的黄金时代 | §10 | Xen paravirtualization、硬件协作、virtio、ReVirt、migration |
| 虚拟化的另一个方法 | §11 | syscall/object-view virtualization、osid 思想实验、shared kernel |
| Aside: pidfs | §12、实验二 | PID reuse/TOCTTOU、pidfd stable identity、poll lifecycle |
| 这个想法其实很古老 | §13 | chroot 1979、单 filesystem view 的不足、对象清单 |
| `祝贺，你发明了 Linux Namespaces\!` | §14、实验三 | clone/setns/unshare、8 类 namespace、PID 1/user/mount 边界 |
| 再进一步：资源调度 | §15、实验四 | cgroup v2 controllers、只读观察、OCI/OverlayFS/runtime、Jails/LXC |
| 云时代的虚拟机 | §16 | VM/container/microVM、多租户、K8s、声明式/故障转移/云原生边界 |
