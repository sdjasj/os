# 竞态条件：时间也是输入

对应官方模块：Race Conditions  
官方页面：https://pwn.college/system-security/race-conditions/

## 1. 定义：结果依赖未约束的交错

当多个执行者访问共享状态，且结果取决于它们的相对时序，而程序又没有正确同步时，就出现竞态。执行者可以是：

- 同一进程的线程；
- 多个进程；
- 信号处理器与主流程；
- 程序与文件系统/设备；
- 客户端的多个连接；
- CPU、DMA 设备或内核回调。

“在我的机器上通常正确”不能证明没有竞态，因为调试器、负载、核心数和优化都会改变交错。

## 2. 原子性不是“一行源码”

源代码：

~~~c
counter++;
~~~

通常包含三个逻辑步骤：

~~~text
load counter
add 1
store counter
~~~

两个线程可能这样交错：

~~~text
初始 counter = 10
线程 A 读取 10
线程 B 读取 10
线程 A 写 11
线程 B 写 11
结果 11，而不是 12
~~~

这称为 lost update。CPU 指令是否原子、编译器是否重排、语言内存模型是否允许并发访问，是三个不同问题。

## 3. 用 ThreadSanitizer 观察数据竞争

~~~c
// counter_race.c
#include <pthread.h>
#include <stdio.h>

static long counter;

static void *worker(void *unused) {
    (void)unused;
    for (long i = 0; i < 100000; i++) {
        counter++;
    }
    return NULL;
}

int main(void) {
    pthread_t a, b;
    pthread_create(&a, NULL, worker, NULL);
    pthread_create(&b, NULL, worker, NULL);
    pthread_join(a, NULL);
    pthread_join(b, NULL);
    printf("counter=%ld, expected=200000\n", counter);
}
~~~

~~~bash
cc -O1 -g -fsanitize=thread -pthread counter_race.c -o counter_race
./counter_race
# ThreadSanitizer 应报告 data race；计数值可能碰巧正确，也可能小于 200000
~~~

数据竞争在 C/C++ 语言模型中会导致未定义行为，不能只用 volatile 修复。volatile 主要约束某些编译器访问消除，不提供互斥或跨线程 happens-before。

## 4. 两种正确修复

### 4.1 互斥锁

~~~c
static long counter;
static pthread_mutex_t lock = PTHREAD_MUTEX_INITIALIZER;

static void *worker(void *unused) {
    (void)unused;
    for (long i = 0; i < 100000; i++) {
        pthread_mutex_lock(&lock);
        counter++;
        pthread_mutex_unlock(&lock);
    }
    return NULL;
}
~~~

锁适合保护由多个字段共同形成的不变量。临界区应覆盖“检查 + 修改”的整体。

### 4.2 C11 原子

~~~c
#include <stdatomic.h>

static _Atomic long counter;

static void *worker(void *unused) {
    (void)unused;
    for (long i = 0; i < 100000; i++) {
        atomic_fetch_add_explicit(&counter, 1, memory_order_relaxed);
    }
    return NULL;
}
~~~

若计数器只要求每次递增不丢失，relaxed 足够；它不为其他数据建立发布/获取关系。涉及“状态准备好后发布指针”等协议时，必须选择正确内存序或使用锁。不要为追求性能在不理解内存模型时随意使用 relaxed。

## 5. TOCTOU：检查对象与使用对象分离

典型文件流程：

~~~c
if (access(path, W_OK) == 0) {
    int fd = open(path, O_WRONLY);
    /* 写入 */
}
~~~

问题不是两行之间“太慢”，而是 path 是名称。攻击者或其他进程可在检查后把名称重新绑定到另一 inode：

~~~text
检查：path -> 安全文件 A
              [竞争窗口：目录项被替换]
使用：path -> 敏感文件 B
~~~

即使把两行放得很近，正确性仍依赖时序。加快代码只降低概率，不消除竞态。

## 6. 把检查绑定到已打开对象

更可靠的思路是先用所需约束打开对象，之后通过文件描述符操作同一个内核对象：

~~~c
// safe_open.c
#define _GNU_SOURCE
#include <fcntl.h>
#include <stdio.h>
#include <sys/stat.h>
#include <unistd.h>

int open_regular_no_symlink(const char *path) {
    int fd = open(path, O_WRONLY | O_NOFOLLOW | O_CLOEXEC);
    if (fd == -1) return -1;

    struct stat st;
    if (fstat(fd, &st) == -1 || !S_ISREG(st.st_mode)) {
        close(fd);
        return -1;
    }
    return fd;
}
~~~

这里 fstat 检查的是 fd 所引用的对象，随后 write 也使用该 fd。注意：

- O_NOFOLLOW 只保证最终路径分量不是符号链接；
- 中间目录仍可能被替换或穿越；
- 权限语义不能简单用 access 预检；
- 若安全要求严格，应使用可信目录 fd 配合 openat2 的 RESOLVE_BENEATH、RESOLVE_NO_SYMLINKS 等约束（依内核支持）；
- 创建临时文件应使用 O_CREAT|O_EXCL 或 mkstemp，而不是先判断不存在再创建。

## 7. 名称空间中的安全句柄

将字符串路径一次性解析成句柄后操作，是通用模式：

| 不稳模式 | 更稳模式 |
|---|---|
| 检查路径，再按路径打开 | 打开 fd，再 fstat/操作 fd |
| 检查用户名，再按用户名更新 | 解析到不可变用户 ID，在事务中检查并更新 |
| 查询余额，再单独扣款 | 数据库事务/条件更新 |
| 检查对象版本，再无条件写 | compare-and-swap / ETag |

关键是让“检查”和“使用”由同一个原子操作或不可替换句柄连接。

## 8. 锁保护的是不变量，不是变量

假设账户由 balance 和 reserved 两字段组成，要求：

~~~text
balance >= 0
reserved >= 0
reserved <= balance
~~~

分别给两个字段加锁可能在组合检查中看到不一致快照。应定义哪个锁保护整个账户不变量，并保持统一锁顺序。

多个锁的死锁例子：

~~~text
线程 A：持有 lock_user，等待 lock_group
线程 B：持有 lock_group，等待 lock_user
~~~

修复包括：

- 全局规定获取顺序；
- 缩小同时持锁数量；
- try-lock + 回退；
- 用消息传递或单线程所有者消除共享写；
- 数据库事务与唯一约束。

## 9. 信号与可重入性

信号处理器可在主线程任意指令间插入。若处理器调用 malloc、printf 或获取主流程正持有的锁，可能破坏内部状态或死锁。POSIX 只保证一小组 async-signal-safe 函数可安全调用。

经典安全模式是让处理器只设置标志：

~~~c
#include <signal.h>

static volatile sig_atomic_t stop_requested;

static void on_signal(int signo) {
    (void)signo;
    stop_requested = 1;
}
~~~

主循环在正常上下文检查标志并清理。sig_atomic_t 适合单次简单读写，不是通用线程同步工具。

更复杂程序可使用 signalfd（Linux）或 self-pipe，把异步事件转成事件循环中的普通 I/O。

## 10. 生命周期竞态

即便所有字段读写都有锁，对象本身也可能在另一个线程释放：

~~~text
线程 A：取出对象指针
线程 B：从容器移除并 free
线程 A：加对象内部锁 <- 已经访问释放内存
~~~

对象内部锁无法保护“取得对象锁之前”的生命周期。常见方案：

- 容器锁保护查找与引用计数增加；
- hazard pointer / epoch reclamation；
- RCU；
- 把所有权移交单一事件循环；
- 使用具备安全共享所有权的语言抽象。

生命周期同步与字段同步要分别设计。

## 11. 提高复现率不等于制造漏洞

为诊断自有程序，可以：

- 在关键点加入 barrier；
- 固定线程数和 CPU affinity；
- 用条件变量精确暂停；
- 重复运行并记录调度；
- 使用 TSan、rr 或调度模糊测试；
- 给文件系统步骤加入测试钩子。

不要以 sleep 作为修复。sleep 只改变概率，在不同负载下仍会失败。测试钩子要避免进入生产构建。

## 12. 网络与多请求竞态

例：余额接口先读后写：

~~~text
请求 A 读余额 100
请求 B 读余额 100
请求 A 扣 80 -> 20
请求 B 扣 80 -> 20
总计扣了 160，却未出现负数
~~~

数据库层修复可以是一条条件更新：

~~~sql
UPDATE accounts
SET balance = balance - :amount
WHERE id = :id AND balance >= :amount;
~~~

然后检查受影响行数是否为 1。把条件和修改放在一个原子语句中，比应用层“SELECT 后再 UPDATE”更可靠。更复杂不变量需要事务、合适隔离级别和唯一约束。

## 13. 常见误区

- **加 sleep 修复竞态**：只改变窗口。
- **volatile 等于线程安全**：不提供原子性或顺序。
- **单核没有竞态**：抢占、信号、多进程仍可交错。
- **锁越多越安全**：错误粒度和顺序会产生不一致或死锁。
- **文件权限检查后立刻打开就安全**：名称可重新绑定。
- **TSan 没报警就没竞态**：它只看到这次覆盖到的路径，也有不支持的同步模式。

## 14. 纸面练习

### 题目一

为什么 access(path) 后 open(path) 不应通过“重试并比较路径字符串”修复？

### 答案

相同字符串在不同时间可解析到不同对象；重试仍有新的窗口。应打开一次并通过 fd 检查/使用，或使用支持解析约束的原子内核接口。

### 题目二

两个字段各自使用 atomic，能否保证字段组合不变量？

### 答案

不一定。单字段操作原子不代表读取到一致快照，也不保证跨字段检查与更新不可分割。可用锁、事务、版本化 CAS 或把状态编码进一个可原子更新的值。

### 题目三

某 UAF 只有多线程下出现。给对象字段加 mutex 后仍崩溃，原因可能是什么？

### 答案

对象可能在取得其内部 mutex 之前已被另一线程释放。需要保护对象查找和引用获取的外部生命周期协议，例如容器锁加引用计数。

## 15. 小结

竞态的根因是未被约束的时间交错。正确修复要么消除共享可变状态，要么让检查与使用成为同一原子操作，要么建立明确的 happens-before 和生命周期协议。速度、sleep 与“通常不会刚好发生”都不是安全证明。

---

[上一章：沙箱](01-sandboxing.md) · [分区索引](README.md) · [下一章：内核安全](03-kernel-security.md)
