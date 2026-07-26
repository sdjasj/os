# 沙箱：chroot、namespace、capability 与 seccomp

对应官方模块：Sandboxing  
官方页面：https://pwn.college/system-security/sandboxing/

一手手册：[namespaces(7)](https://man7.org/linux/man-pages/man7/namespaces.7.html)、[capabilities(7)](https://man7.org/linux/man-pages/man7/capabilities.7.html) 与 [seccomp(2)](https://man7.org/linux/man-pages/man2/seccomp.2.html)。这些机制分别约束视图、特权和系统调用入口，不能互相替代。

## 1. 沙箱的目标不是“绝对安全”

沙箱是在假设被隔离代码可能完全失陷的情况下，限制它能观察和改变的资源。设计时必须写出：

~~~text
被隔离主体：
允许的输入/输出：
需要的文件：
需要的系统调用：
需要的网络：
CPU/内存/进程上限：
失败时如何终止和清理：
宿主上仍被共享的对象：
~~~

一个沙箱是否安全只能相对威胁模型回答。chroot、namespace、seccomp、capability、LSM、虚拟机分别约束不同层面，不能互相冒充。

## 2. chroot：改变路径解析的根

chroot 让进程的路径查找把某目录视为 /。概念上：

~~~text
宿主 /srv/jail/etc/config
沙箱看到 /etc/config
~~~

它主要是文件系统命名视图，不是完整安全边界。传统风险包括：

- 进程仍保留 chroot 外目录的打开文件描述符；
- 当前工作目录或目录 fd 未正确处理；
- 进程拥有足以再次 chroot、挂载或操作内核对象的权限；
- /proc、设备节点、socket 暴露了外界能力；
- 同一内核中的漏洞完全不受 chroot 限制。

安全顺序通常包括准备最小根目录、切换根和工作目录、关闭继承 fd、降 uid/gid、删除 capability，再叠加 namespace 与 syscall 策略。只调用 chroot 后继续以宿主 root 运行并不是沙箱。

## 3. Namespace：改变“看见什么”

Linux namespace 为不同资源提供隔离视图：

| 类型 | 主要隔离对象 |
|---|---|
| mount | 挂载树 |
| pid | 进程编号与可见进程 |
| net | 网卡、路由、防火墙和 socket 空间 |
| ipc | System V IPC、POSIX 消息队列 |
| uts | 主机名与域名 |
| user | uid/gid 映射与 capability 范围 |
| cgroup | cgroup 视图 |
| time | 部分系统时钟偏移 |

namespace 不是资源限额；CPU 和内存通常由 cgroup 限制。namespace 也不虚拟化内核，容器仍共享内核攻击面。

在允许非特权 user namespace 的发行版上，可做无害观察：

~~~bash
id
unshare --user --map-root-user sh -c 'id; cat /proc/self/uid_map'
~~~

典型现象：第二条命令在新 user namespace 内显示 uid 0，但 uid_map 表明它映射到宿主普通 uid。这里的“root”只在该 namespace 的权限模型内有意义。部分系统出于安全策略禁用该功能，出现 Operation not permitted 不代表命令写错。

## 4. Mount namespace 与传播

新 mount namespace 让进程可以拥有不同挂载视图，但挂载传播属性决定一侧变化是否传到另一侧：

- shared：挂载事件可在同组传播；
- private：不传播；
- slave：单向接收主组事件；
- unbindable：还限制 bind mount。

沙箱初始化若忘记把挂载设为 private，可能把内部挂载变化意外传播到宿主。容器运行时必须显式处理传播，而不是假设“新 namespace 就完全隔离”。

### bind mount 与只读

bind mount 可把已有目录映射到另一路径。只读挂载应考虑：

- 绑定对象下是否还有独立子挂载；
- 进程是否保留可写 fd；
- 是否有其他接口能修改同一底层对象；
- mount API 与内核版本的递归只读语义。

路径只读不等于对象在所有引用上只读。

## 5. Capability：把 root 权力拆开

传统 UNIX 把 uid 0 视为几乎全能。Linux capability 将权限拆为多个位，例如绑定低端口、改变所有者、管理网络、加载模块。

查看当前 shell：

~~~bash
grep -E 'Cap(Inh|Prm|Eff|Bnd|Amb)' /proc/self/status
command -v capsh >/dev/null && capsh --decode="$(awk '/CapEff/ {print $2}' /proc/self/status)"
~~~

进程有多个 capability 集：

- permitted：可转为有效的上限；
- effective：当前权限检查实际使用；
- inheritable / ambient：跨 exec 传播相关；
- bounding：未来可取得能力的上界。

降权时只改 uid 可能不够；应清理 effective、permitted、ambient 和 bounding，控制 securebits，并设置 no_new_privs。

## 6. no_new_privs：阻止 exec 获得新权限

PR_SET_NO_NEW_PRIVS 一旦设为 1，当前线程及后代通过 execve 不会因 setuid/setgid 位或文件 capability 获得新权限。它不可撤销，常是安装无特权 seccomp filter 的前提。

~~~c
#include <sys/prctl.h>

if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) == -1) {
    perror("prctl");
    exit(1);
}
~~~

它不删除当前已有权限，也不限制系统调用。应把它看作“阻止未来提权通道”的一层。

## 7. seccomp：限制内核入口

seccomp-BPF 根据系统调用编号、架构和参数值决定：

- 允许；
- 返回指定错误；
- 终止线程或进程；
- 通知监控进程；
- 记录后再允许等。

安全策略优先使用小型 allowlist。denylist 很容易漏掉等价系统调用，例如只禁 open 却允许 openat 或其他对象获取通道。

### 一个可运行的 strict 模式演示

strict 模式只允许极少数系统调用，适合展示原理：

~~~c
// strict_demo.c
#define _GNU_SOURCE
#include <linux/seccomp.h>
#include <string.h>
#include <sys/syscall.h>
#include <sys/prctl.h>
#include <unistd.h>

static void end_process(int status) {
    syscall(SYS_exit, status);
    __builtin_unreachable();
}

static void write_all(int fd, const char *buffer, size_t length) {
    while (length > 0) {
        ssize_t written = write(fd, buffer, length);
        if (written <= 0) end_process(1);
        buffer += (size_t)written;
        length -= (size_t)written;
    }
}

int main(void) {
    const char before[] = "filter installed\n";
    write_all(STDOUT_FILENO, before, sizeof(before) - 1);

    if (prctl(PR_SET_SECCOMP, SECCOMP_MODE_STRICT) == -1) {
        const char error[] = "strict seccomp unavailable\n";
        write_all(STDERR_FILENO, error, sizeof(error) - 1);
        end_process(1);
    }

    char byte;
    if (read(STDIN_FILENO, &byte, 1) == 1) {
        write_all(STDOUT_FILENO, &byte, 1);
        write_all(STDOUT_FILENO, "\n", 1);
    }
    /*
     * 新版 glibc 的 _exit 包装通常使用 exit_group；strict 模式只允许
     * SYS_exit，所以这里明确发起后者。它只结束当前单线程示例。
     */
    end_process(0);
}
~~~

~~~bash
cc -Wall -Wextra strict_demo.c -o strict_demo
printf Z | ./strict_demo
# filter installed
# Z
~~~

使用 write 和显式 SYS_exit 而不是 printf/普通 exit，是因为 libc 的缓冲、清理以及新版 _exit 包装使用的 exit_group 可能触发 strict 模式不允许的系统调用。某些容器或平台已有 seccomp/LSM 限制，安装 strict 模式可能失败；程序会打印明确错误。

## 8. 为什么只看 syscall 名称仍不够

允许 read 和 write 时要问：

- 能读写哪些文件描述符？
- fd 是沙箱前继承的，还是沙箱内取得的？
- 指向普通文件、socket、设备还是 procfs？
- write 可否修改高权限进程可读的配置？

系统调用过滤器通常无法理解“这个 fd 逻辑上属于哪个租户”。应在进入沙箱前只保留必要 fd，并由外部代理执行复杂授权。

参数过滤也有 TOCTOU 风险：seccomp 能看到寄存器里的指针值，却不能安全地按业务语义深度解析之后可能被另一线程改变的用户内存。将策略缩到 syscall/常量参数层更可靠。

## 9. 系统调用替代路径

禁用一个 syscall 不代表禁用一种能力：

- 已打开 fd 可绕过路径获取；
- openat 可相对目录 fd 打开文件；
- sendmsg 可传递 fd；
- mmap、read、write 可组合处理数据；
- io_uring 等复合接口改变传统 syscall 审计假设；
- procfs、设备和 IPC 可能提供另一接口。

因此先定义“资源能力”，再枚举能实现它的所有内核接口。

## 10. PID 与进程边界

PID namespace 中的 1 号进程有特殊职责：回收孤儿/僵尸进程并正确处理信号。若沙箱入口程序不做 init 工作，容易泄漏僵尸或无法优雅终止。

另外：

- 线程共享地址空间，一个线程的内存错误影响同进程全部线程；
- fork 后子进程继承许多 fd、映射和环境；
- ptrace 权限、/proc 挂载和 dumpable 状态会影响跨进程观察；
- 信号是异步入口，处理器应保持最小且可重入。

## 11. 资源限制与可用性

隔离可见性不自动阻止 fork bomb、内存耗尽或磁盘写满。应组合：

- cgroup v2 的 memory.max、pids.max、cpu.max；
- RLIMIT_NOFILE、RLIMIT_FSIZE、RLIMIT_CORE 等；
- 临时文件系统容量；
- 请求级超时和取消；
- 输出大小上限；
- 外部 watchdog。

资源上限也要留出清理与日志空间，否则沙箱耗尽资源后监控本身可能无法工作。

## 12. 一个合理的启动顺序

具体实现依运行时而异，常见推理顺序：

1. 父进程以必要权限准备 namespace、挂载和 cgroup；
2. 创建最小文件系统视图，处理传播与只读；
3. 打开极少数必须 fd，关闭其余继承项；
4. 设置 uid/gid 映射并降权；
5. 删除 capabilities，设置 no_new_privs；
6. 安装 seccomp allowlist 与 LSM 策略；
7. 设置资源上限、超时和工作目录；
8. exec 目标程序，清理环境变量；
9. 父进程监控、记录、回收并销毁临时资源。

“先运行不可信代码，再补沙箱”当然太晚；动态加载器和构造函数已经执行了。

## 13. 常见误区

- **chroot 是安全容器**：它主要改变路径根。
- **容器内 root 等于完全无害**：共享内核和错误挂载仍可能扩大影响。
- **seccomp 拒绝 open 就不能读文件**：可能已有 fd 或替代接口。
- **namespace 提供资源限额**：限额主要由 cgroup/RLIMIT 实现。
- **只要降 uid 就没有 capability**：必须检查各 capability 集和 exec 行为。
- **策略越长越安全**：复杂 denylist 往往更难审计。

## 14. 纸面练习

### 题目一

一个转换器进入 seccomp 前继承了数据库 socket，策略只允许 read/write。它还能访问数据库吗？

### 答案

很可能能。read/write 对既有 socket 仍有效；seccomp 不理解该 fd 的业务含义。应在沙箱前关闭 socket，或只传入一端受限的代理通道。

### 题目二

某容器根文件系统只读，但挂入了可写 Docker socket。安全结论是什么？

### 答案

只读根并不能抵消高权 socket。若容器进程能通过 socket 控制宿主容器运行时，它可能请求新的高权限容器或挂载宿主路径。应移除该 socket 或经最小权限代理。

### 题目三

为何 allowlist 通常优于 denylist？

### 答案

内核接口不断演进，同一能力可能有多条路径。denylist 必须预见所有危险入口；allowlist 只开放已建模的最小集合，默认拒绝新接口。

## 15. 小结

沙箱是资源能力的收缩工程：namespace 改变视图，capability 拆分特权，seccomp 限制内核入口，cgroup/RLIMIT 控制消耗，LSM 与文件权限约束对象访问。安全来自它们围绕清晰威胁模型的组合，而不是任何单一开关。

---

[上一章：系统安全导论](00-introduction.md) · [分区索引](README.md) · [下一章：竞态条件](02-race-conditions.md)
