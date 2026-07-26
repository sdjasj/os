# 动态分配器误用：堆对象的生命周期

对应官方模块：Dynamic Allocator Misuse  
官方页面：https://pwn.college/program-security/dynamic-allocator-misuse/

## 1. 学习目标

本章讨论 glibc malloc 背后的基本模型以及程序怎样误用它。重点是**对象生命周期与分配器不变量**，不是背某个版本的堆利用模板。

你将学会：

- 区分“应用对象”和“分配器 chunk”；
- 解释 use-after-free、double-free、堆越界的根因；
- 理解 tcache 为什么提高性能，又为何扩大生命周期错误的影响；
- 用调试器和 AddressSanitizer 确认错误；
- 说明 safe-linking 等缓解保护什么、又不保护什么。

## 2. malloc 返回的不是“裸内存”

应用看到：

~~~c
void *p = malloc(32);
~~~

概念上，分配器维护的结构更像：

~~~text
低地址
+-------------------------+
| 分配器元数据             |
+-------------------------+
| 用户可用区域 32 bytes    | <- p 指向这里
+-------------------------+
| 对齐或下一个 chunk       |
+-------------------------+
高地址
~~~

实际元数据布局、大小类、缓存与校验会随 glibc 版本和架构变化。应用只能使用 malloc 承诺的 32 字节；读取 p 之前的字节或越过末尾都属于未定义行为。

几个必须分开的量：

- **请求大小**：程序传给 malloc 的数；
- **可用大小**：分配器因对齐可能实际提供得更多，但不能据此跨界设计；
- **chunk 大小**：用户区域加元数据并满足对齐；
- **大小类**：分配器管理相近 chunk 的分组。

安全边界由请求和对象类型定义，不由“这次看起来后面还有空位”定义。

## 3. 生命周期状态机

一个最小对象可画成：

~~~text
未分配 --malloc成功--> 活跃 --free--> 已释放
                 |                    |
                 +--读/写合法          +--读/写非法
                                      +--再次 free 非法
~~~

另外 malloc 可能失败并返回 NULL。realloc 更微妙：成功时旧指针可能失效，失败时旧对象仍有效。

建议为每个拥有堆对象的字段写清：

1. 谁负责 free；
2. 哪些地方只是借用；
3. 借用最长活多久；
4. 释放后如何让所有别名失效；
5. 错误路径是否与成功路径采用同一所有权规则。

## 4. Use-after-free：地址还在不等于对象还在

下面是故意有错的本地示例：

~~~c
// uaf.c
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

struct note {
    char text[24];
};

int main(void) {
    struct note *n = malloc(sizeof(*n));
    if (n == NULL) return 1;
    strcpy(n->text, "draft");

    struct note *alias = n;
    free(n);
    n = NULL;

    puts(alias->text);   // 错：alias 是悬空指针
    return 0;
}
~~~

不要依赖普通运行的表现。它可能打印 draft，也可能崩溃；两者都不改变“行为未定义”这一事实。用 AddressSanitizer：

~~~bash
cc -Wall -Wextra -O1 -g -fsanitize=address uaf.c -o uaf
./uaf
# 预期：AddressSanitizer 报告 heap-use-after-free，并标出分配、释放和读取位置
~~~

为什么危险？free 只告诉分配器“这块空间可复用”，不会清除所有指针。下一次同大小分配可能取得相同地址：

~~~text
alias ------+
            v
地址 X: [旧 note] --free--> [空闲 chunk] --malloc--> [新对象]
~~~

此后 alias 访问的是新对象的字节，却仍按旧类型和旧权限解释。这是“类型混淆 + 生命周期错误”的组合。

## 5. Double-free：同一所有权被结束两次

~~~c
void release_note(struct note **slot) {
    if (slot == NULL || *slot == NULL) return;
    free(*slot);
    *slot = NULL;
}
~~~

这个辅助函数能防止通过同一 slot 重复释放，但挡不住别名：

~~~c
struct note *a = malloc(sizeof(*a));
struct note *b = a;
release_note(&a);
free(b);                 // 仍是 double-free
~~~

根因不是“忘了置 NULL”，而是 a 与 b 都被误认为所有者。可选设计：

- 单一所有者，其他代码只借用且不得跨越释放点；
- 引用计数，但要正确处理循环引用和原子性；
- 区域/arena 生命周期，一次释放整组对象；
- 使用 Rust 的所有权模型或 C++ 智能指针；
- 在 C API 中明确 create/destroy 及所有权转移语义。

## 6. 堆越界会破坏什么

堆上相邻的可能是：

- 另一个应用对象；
- 空闲链表相关字段；
- 分配器元数据；
- 对齐填充；
- 完全未映射的页。

所以同一个越界写可能表现为：

1. 立即触发页故障；
2. 悄悄改变相邻对象字段；
3. 到后续 malloc/free 才被完整性检查发现；
4. 在不同环境中产生完全不同结果。

下面的修复样例把“数据长度”和“缓冲区容量”绑定：

~~~c
struct blob {
    size_t length;
    unsigned char data[];
};

struct blob *blob_new(const unsigned char *src, size_t length) {
    if (length > 4096 || length > SIZE_MAX - sizeof(struct blob)) {
        return NULL;
    }
    struct blob *b = malloc(sizeof(*b) + length);
    if (b == NULL) return NULL;
    b->length = length;
    memcpy(b->data, src, length);
    return b;
}
~~~

检查 SIZE_MAX 减法是为了避免加法溢出。柔性数组成员把元数据和相应数据分配在同一对象中，但调用者仍必须以 b->length 为边界。

## 7. tcache 的直觉模型

现代 glibc 为常用小尺寸维护线程本地缓存 tcache。释放的小 chunk 可先进入对应大小类的单链表，后续相近大小 malloc 优先从这里取回。

概念模型：

~~~text
tcache[size_class]
   |
   v
[free chunk A] -> [free chunk B] -> NULL

malloc(相近大小) 返回 A
~~~

这样减少锁竞争并提高局部性，但也意味着“刚释放的地址很快被复用”。生命周期错误因此更容易把旧类型指针连到新对象。

重要限定：

- tcache 有每类容量限制；
- 大小归类包含对齐和最小 chunk 规则；
- 满缓存后 chunk 可能去其他 bin；
- 具体细节依 glibc 版本；
- 调试时必须先确认运行时 libc，而不能拿旧文章的布局硬套。

~~~bash
ldd --version | head -n 1
ldd ./uaf
~~~

## 8. Chunk 元数据与分配器不变量

分配器必须回答：

- 这个 chunk 多大；
- 前后 chunk 是否在使用；
- 空闲 chunk 属于哪个结构；
- 能否与相邻空闲空间合并；
- 链表指针和尺寸是否自洽。

因此常见完整性检查围绕：

- 大小是否对齐且处于合理范围；
- 前后尺寸关系是否一致；
- 双向链表前驱/后继是否相互指回；
- 同一 chunk 是否重复出现在缓存；
- 编码后的单链表指针是否可接受。

这些检查会把部分内存破坏从“稍后静默利用”变成“尽早终止”。但它们不是应用边界检查，也不能保证所有错误都被发现。

## 9. Safe-linking 的意义

某些单链空闲结构过去直接存储下一 chunk 地址。若应用漏洞能覆盖该字段，分配器后续可能跟随被篡改的指针。safe-linking 会用与当前存储位置相关的信息编码链指针，概念上类似：

~~~text
encoded_next = next XOR (storage_address >> page_shift)
~~~

精确公式属于具体实现，应以相应 glibc 源码为准。其安全意义：

- 攻击者通常需要知道堆地址或相关高位；
- 随意覆盖更可能在解码或对齐检查时失败；
- 它提高利用约束，但不修复 UAF/越界写；
- 若地址已泄漏且写能力充分，保护可能被削弱。

这再次说明信息泄漏和写原语经常组成利用链。

## 10. 正确使用 realloc

错误写法：

~~~c
buffer = realloc(buffer, new_size);
if (buffer == NULL) {
    /* 原指针已经丢失，发生泄漏 */
}
~~~

更稳妥：

~~~c
void *tmp = realloc(buffer, new_size);
if (tmp == NULL) {
    /* buffer 仍指向旧对象 */
    return -1;
}
buffer = tmp;
capacity = new_size;
~~~

还要在调用前验证 new_size 的乘法或加法不会溢出。若计算元素数组：

~~~c
if (count > SIZE_MAX / sizeof(*items)) {
    return -1;
}
size_t bytes = count * sizeof(*items);
~~~

## 11. 调试策略

### 11.1 Sanitizer 优先

~~~bash
cc -fsanitize=address,undefined -fno-omit-frame-pointer -g app.c -o app
ASAN_OPTIONS=detect_leaks=1 ./app
~~~

ASan 通过红区、影子内存和隔离延迟复用来发现越界与 UAF。它改变布局和时序，所以“ASan 下没复现”也不能证明生产构建安全。

### 11.2 记录生命周期

为分配、所有权转移和释放打日志，至少记录：

~~~text
事件编号、对象类型、地址、请求大小、所有者、调用位置
~~~

不要在生产日志泄漏可被远程读取的地址；这是本地调试策略。

### 11.3 GDB 观察

~~~gdb
break malloc
break free
run
bt
finish
p/x $rax
~~~

分配器内部数据结构随版本变化，先证明应用层的非法生命周期，再深入 metadata；否则很容易在实现细节里迷路。

## 12. 防御优先级

1. 采用内存安全语言处理不可信解析；
2. 在 C/C++ 中建立单一所有权和清晰销毁 API；
3. 所有长度计算做溢出与上限检查；
4. 释放后撤销可达性，而不只是清零一处指针；
5. CI 启用 ASan/UBSan、模糊测试和静态分析；
6. 保持 libc 与编译工具链更新；
7. 将不可信解析隔离在低权限进程。

## 13. 常见误区

- **free 会把内存清零**：标准不保证；内容还可能暂时存在。
- **地址相同就是同一对象**：地址复用后生命周期和类型已经改变。
- **置 NULL 解决 UAF**：只能解决被置空的那个别名。
- **glibc 报 corrupted 就是 glibc 有 bug**：更常见是应用更早破坏了堆。
- **记住一个 chunk 图就通用**：分配器细节高度版本相关。
- **safe-linking 等于堆安全**：它只增加某类链表篡改的约束。

## 14. 纸面练习

### 题目一

对象 A 被释放；随后同大小对象 B 复用了相同地址。旧指针 p 写入一个字段。应怎样描述这个问题？

### 答案

这是对 A 的 use-after-free；在物理层面写到了当前 B 的存储。安全影响取决于 B 的类型和该字段用途，可能形成类型混淆或数据/指针破坏。不能因地址相同就称 A 仍然存在。

### 题目二

一个程序给所有 free 后的局部变量赋 NULL，但仍偶发 UAF。最可能漏掉了什么？

### 答案

同一对象的其他别名、容器条目、回调上下文或跨线程借用没有失效。应审计所有权图和同步关系，而不是继续增加局部置空。

### 题目三

tcache 让 free 后的 chunk 更快被同尺寸 malloc 复用，这对正确程序和错误程序分别意味着什么？

### 答案

正确程序获得更低分配延迟；错误程序中的悬空指针更可能迅速指向另一逻辑对象，使 UAF 的表现从“读到旧数据”变成“破坏新对象”。

## 15. 小结

堆安全的核心是不把“地址”误认为“对象”。对象有类型、容量、所有者和生命周期；分配器只管理可复用的字节区间。tcache、metadata 检查和 safe-linking 是实现与缓解层，真正的根因修复仍是边界、所有权与同步。

---

[上一章：返回导向编程](03-return-oriented-programming.md) · [分区索引](README.md) · [下一章：程序利用方法论](05-program-exploitation.md)
