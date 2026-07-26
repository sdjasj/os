# 内核安全：最高权限代码的边界

对应官方模块：Kernel Security  
官方页面：https://pwn.college/system-security/kernel-security/

一手资料：[Linux 内核 slab/SLUB 文档](https://docs.kernel.org/mm/slab.html)与[内核自我保护项目说明](https://docs.kernel.org/security/self-protection.html)。具体配置项和分配器行为必须与目标内核源码、配置及构建对应。

## 1. 为什么内核漏洞不同

内核同时管理：

- 进程地址空间与页表；
- 文件、网络、设备和 IPC；
- 用户身份、capability 与访问控制；
- 调度、信号和计时；
- 容器共享的系统调用边界。

用户态进程失陷后，影响受其 uid、namespace、seccomp 和资源限制约束；内核代码失陷可能破坏这些约束本身。因此内核属于绝大多数 Linux 系统的可信计算基。

本章目标：

- 理解用户态到内核态的调用和数据复制边界；
- 认识内核模块、设备与 ioctl 的接口模型；
- 从越界、UAF、引用计数和竞态推导风险；
- 解释页表与常见内核缓解；
- 建立安全的内核调试环境观念。

## 2. 系统调用边界

用户程序调用 read 时，通常先进入 libc 包装，再执行 syscall 指令。CPU 切换到内核入口，但**不会自动信任用户指针**。

~~~text
用户态
  fd, user_buffer, length
        |
        v syscall
内核态
  验证 fd 与权限
  验证长度
  copy_to_user / copy_from_user
  更新内核对象
        |
        v return
用户态
~~~

用户指针面临几个问题：

- 指向未映射页；
- 指向只读页；
- 跨页，后半部分无效；
- 另一个线程同时修改内容；
- 长度算术溢出；
- 指向内核地址（架构/配置依赖）。

Linux 驱动应使用 copy_from_user、copy_to_user、get_user、put_user 等接口并检查返回值，不应把用户指针直接当普通内核指针解引用。

## 3. ioctl：灵活也危险的接口

ioctl 常用一个命令号加用户指针传递结构体。安全 ABI 要明确：

- 固定宽度整数；
- 结构体版本与大小；
- 对齐与 32/64 位兼容；
- 每个指针指向的长度；
- 保留字段必须为零；
- 命令级权限；
- 并发与对象生命周期。

一个用户态请求结构示例：

~~~c
#include <stdint.h>

struct digest_request_v1 {
    uint32_t version;
    uint32_t flags;
    uint64_t input_address;
    uint32_t input_length;
    uint32_t reserved;
    uint8_t output[32];
};
~~~

内核端不能因为外层结构复制成功，就直接相信 input_address 和 input_length。它们是第二层不可信输入，要再次验证、限制长度并安全复制。

## 4. 一个无害的最小内核模块

以下模块只在加载/卸载时写日志，用于理解入口。不要在主机上随意加载第三方模块；在一次性 VM 中使用与内核匹配的 headers。

~~~c
// hello_module.c
#include <linux/init.h>
#include <linux/module.h>

static int __init hello_init(void) {
    pr_info("security_tutorial: loaded\n");
    return 0;
}

static void __exit hello_exit(void) {
    pr_info("security_tutorial: unloaded\n");
}

module_init(hello_init);
module_exit(hello_exit);
MODULE_LICENSE("GPL");
MODULE_DESCRIPTION("Benign teaching module");
~~~

对应 Makefile 的核心行：

~~~make
obj-m += hello_module.o
~~~

在隔离 VM 中可按内核构建系统编译：

~~~bash
make -C /lib/modules/$(uname -r)/build M="$PWD" modules
~~~

加载模块需要高权限且会把代码放入内核地址空间。教程不自动执行 insmod；若模块有空指针或越界写，可能让整个 VM 崩溃。实际研究要启用快照和串口日志。

## 5. 用户态/内核态地址空间

虚拟地址通过多级页表转换为物理页。页表项还携带权限：

- present；
- read/write；
- user/supervisor；
- executable disable；
- accessed/dirty 等。

用户页通常带 user 位，内核页只允许 supervisor。每个进程拥有自己的用户空间映射，但内核映射可能以架构和 KPTI 配置相关的方式共享。

页故障并不总是漏洞：

- demand paging 首次访问正常触发；
- copy-on-write 在写时复制；
- 文件映射按需读入；
- 非法地址才导致 SIGSEGV 或内核 oops。

## 6. 典型根因

### 6.1 越界访问

长度来自用户，但分配、复制和元素计算使用不同类型或单位。内核越界写可能破坏相邻内核对象，影响远大于普通进程内越界。

防御模式：

~~~c
#include <linux/overflow.h>

if (count > MAX_ITEMS)
    return -EINVAL;
if (check_mul_overflow(count, sizeof(struct item), &bytes))
    return -EOVERFLOW;
buffer = kmalloc(bytes, GFP_KERNEL);
~~~

内核提供 overflow.h 中的 checked arithmetic 辅助函数。实际 API 随内核版本确认。

### 6.2 Use-after-free

文件描述符、socket、凭据等对象常被多线程和异步回调共享。引用计数减少 UAF，但要求：

- 获取引用与查找不可竞争；
- 每条成功获取路径恰好释放一次；
- 从容器移除与最后释放顺序正确；
- 回调、timer、workqueue 在释放前取消或排空。

### 6.3 引用计数溢出

若计数整数回绕到零，对象可能在仍有引用时释放。内核的 refcount_t 比普通 atomic_t 更适合对象生命周期：它带有饱和和误用检查语义。

### 6.4 竞态

自旋锁、mutex、RCU、原子变量、seqlock 各有上下文限制。中断上下文不能睡眠；持自旋锁时调用可能睡眠的函数会出错。锁保护范围应由不变量决定。

### 6.5 未初始化与信息泄漏

把带 padding 的结构体整体 copy_to_user，可能把旧内核栈/堆字节泄漏出去。应先零初始化，只复制定义字段，并避免把内核地址暴露给不可信方。

## 7. slab 分配器的对象视角

内核频繁分配固定类型对象，slab/SLUB 将页组织成 cache：

~~~text
kmem_cache "object_X"
  slab page
    [slot][slot][slot][slot]...
~~~

对象释放后 slot 可很快被同 cache 或兼容布局的对象复用。因此 UAF 可能让旧指针操作新对象。调试与缓解包括：

- KASAN 检测越界/UAF；
- KFENCE 低开销抽样检测；
- slab freelist randomization/hardening；
- 初始化时清零；
- 隔离敏感对象 cache；
- 正确的引用计数与 RCU 生命周期。

缓解增加复用预测难度，但不替代生命周期修复。

## 8. 常见内核缓解

| 机制 | 主要作用 |
|---|---|
| KASLR | 随机化内核映像基址 |
| SMEP | supervisor 模式不能从用户页执行 |
| SMAP | supervisor 对用户页数据访问需显式开启 |
| PXN/PAN | ARM 上类似执行/访问隔离 |
| KPTI | 更强地分离用户与内核页表，缓解 Meltdown 类风险 |
| Stack Canary | 检测部分内核栈覆盖 |
| CFI | 限制间接调用目标 |
| Shadow Call Stack/CET | 保护返回控制流 |
| hardened usercopy | 检查内核对象与用户复制边界 |
| lockdown/module signing | 限制高权代码与内核修改接口 |

这些机制通常把一个直接路径变成多阶段问题，例如地址泄漏削弱 KASLR、数据原语绕过 SMEP 的“不可执行用户页”限制。但安全结论应基于具体内核配置。

本机只读查看：

~~~bash
uname -a
grep -E 'CONFIG_(RANDOMIZE_BASE|PAGE_TABLE_ISOLATION|STACKPROTECTOR|CFI)=' /boot/config-$(uname -r) 2>/dev/null
cat /proc/sys/kernel/kptr_restrict
cat /proc/sys/kernel/dmesg_restrict
~~~

某些发行版不公开 /boot/config；这是打包选择，不说明缓解未启用。

## 9. 为什么内核执行能改变沙箱结论

seccomp 在系统调用入口过滤用户线程。若攻击者利用内核 bug 获得内核级任意读写或执行，过滤器本身、凭据和 namespace 隔离都属于可被破坏的内核状态。换句话说：

~~~text
沙箱假设：内核正确地执行策略
内核漏洞：假设本身失败
~~~

因此高风险多租户场景会考虑更强边界：

- 独立虚拟机和硬件辅助虚拟化；
- 微虚拟机；
- 单独物理主机；
- 缩小可访问设备和系统调用；
- 快速更新宿主内核。

虚拟机也有 hypervisor 攻击面，但把边界从庞大宿主 syscall ABI 移到了更窄的虚拟硬件接口。

## 10. 安全研究环境

内核实验至少使用：

1. 非生产 VM；
2. 可回滚快照；
3. 无敏感数据和凭据；
4. 与宿主隔离的网络；
5. 串口或虚拟控制台日志；
6. 与目标内核严格匹配的符号与源码；
7. KASAN/KCSAN/UBSAN 等调试构建；
8. 崩溃后自动重启但保留日志。

常见 QEMU 调试结构：

~~~text
宿主 GDB
   |
   v gdbstub
QEMU VM -> 调试内核 -> 最小 initramfs
~~~

不要在日常工作站上加载试验模块。内核错误可能损坏文件系统或泄露宿主数据。

## 11. 漏洞分析工作流

1. 固定内核版本、配置、模块哈希；
2. 识别用户可达接口：syscall、ioctl、netlink、文件系统、设备；
3. 找到对象分配、发布、查找、引用和释放点；
4. 写出并发不变量与锁/RCU规则；
5. 使用 KASAN/KCSAN 定位最早违规，而非最后 oops；
6. 判断能力：越界读、UAF、受限写还是引用泄漏；
7. 枚举 SMEP/SMAP/KASLR/CFI 等约束；
8. 最小化 PoC，只保留触发根因；
9. 修复并加入回归、模糊测试；
10. 按项目安全流程负责任披露。

## 12. 常见误区

- **内核地址崩溃就是提权**：还需证明可控性与权限影响。
- **容器 root 已经是内核 root**：通常不是，但共享内核漏洞可能跨越边界。
- **copy_from_user 返回 0/1**：它返回未复制的字节数，应按 API 语义检查。
- **一个 atomic 引用计数解决所有生命周期**：查找与获取引用仍可能竞争。
- **KASLR 隐藏一切地址**：日志、指针泄漏和侧信道都可能削弱它。
- **在宿主测试更真实**：风险不值得；VM 可同时提供真实内核行为和恢复能力。

## 13. 纸面练习

### 题目一

驱动先 copy_from_user 外层结构，再直接解引用结构中的 64 位 input_address。问题在哪里？

### 答案

外层复制只验证了结构本身可读；input_address 仍是不可信用户提供的地址。驱动应验证长度上限与算术，再用用户复制 API 从该地址复制到内核缓冲，处理部分复制与并发修改。

### 题目二

SMEP 开启后，内核能否安全地忽略一个函数指针 UAF？

### 答案

不能。SMEP 阻止内核直接从常见用户页取指，但函数指针仍可能被引向内核已有代码或触发数据破坏。UAF 根因和控制流完整性仍需修复。

### 题目三

为何结构体 padding 可能造成信息泄漏？

### 答案

编译器为对齐插入的字节可能未初始化。若内核把整个结构按 sizeof 复制给用户，padding 中的旧栈/堆数据也会被复制。应零初始化并使用稳定 UAPI 布局。

## 14. 小结

内核安全的核心是把所有用户输入、指针、长度和时序视为不可信，并维护对象生命周期与权限不变量。内核缓解提供纵深防御，但共享内核本身仍是容器和沙箱的根信任。

---

[上一章：竞态条件](02-race-conditions.md) · [分区索引](README.md) · [下一章：微体系结构利用](04-microarchitecture-exploitation.md)
