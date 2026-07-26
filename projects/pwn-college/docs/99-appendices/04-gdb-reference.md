# 04 · GDB 参考：用证据理解程序状态

## GDB 在观察什么

GDB 控制一个被调试进程（inferior），可在指定位置暂停，读取寄存器与内存，查看调用栈，并逐条恢复执行。它会改变进程时序，因此竞态和反调试行为可能与正常运行不同；调试器证据也要结合源码、反汇编和系统环境解释。

只调试自己编译的程序或明确授权的目标。附加到其他用户或生产服务不仅受系统权限限制，也可能中断真实业务。

## 编译一个本地 toy 程序

保存为 `demo.c`：

```c
#include <stdio.h>

static int add(int a, int b) {
    int result = a + b;
    return result;
}

int main(void) {
    int left = 7;
    int right = 5;
    int total = add(left, right);
    printf("total=%d\n", total);
    return total == 12 ? 0 : 1;
}
```

用调试信息、低优化编译：

```bash
gcc -Wall -Wextra -O0 -g -o demo demo.c
./demo
```

预期输出为 `total=12`。`-g` 加入调试信息，`-O0` 让源码语句与机器执行较容易对应；生产优化代码中变量可能显示为 `<optimized out>`，函数也可能被内联。

## 一次完整的源码级会话

```text
$ gdb -q ./demo
(gdb) break add
(gdb) run
(gdb) info args
(gdb) next
(gdb) print result
(gdb) backtrace
(gdb) continue
(gdb) quit
```

典型输出片段：

```text
Breakpoint 1, add (a=7, b=5) at demo.c:4
a = 7
b = 5
$1 = 12
#0  add (a=7, b=5) at demo.c:5
#1  main () at demo.c:12
total=12
[Inferior 1 ... exited normally]
```

行号可能因空行不同而变化。`break` 创建断点；`run` 创建并启动 inferior；`next` 执行当前源码行但越过函数调用；`step` 会尝试进入调用；`continue` 运行到下一断点、信号或退出。

## 高频命令按问题分类

### 我停在哪里

```text
where                  # backtrace 的别名
frame 1                # 选择第 1 号栈帧
info frame             # 当前帧详细信息
list                   # 显示附近源码
```

栈帧编号 0 是当前函数，较大编号逐步接近调用者。损坏栈、尾调用优化或缺少展开信息会使回溯不完整。

### 变量为什么是这个值

```text
info locals
info args
print total
print/x total
ptype total
display/i $pc
```

`print/x` 以十六进制显示，`ptype` 查静态类型，`display` 在每次停止时自动显示表达式。格式改变表示方式，不改变被调试值。

### 内存里到底有什么

`x/NFU ADDRESS` 中 N 是数量，F 是格式，U 是单元大小：

```text
x/8xb &total            # 8 个十六进制 byte
x/4wx $rsp              # 4 个十六进制 4-byte word
x/6gx $rsp              # 6 个十六进制 8-byte giant word
x/s pointer             # 按 NUL 结尾字符串显示
x/10i $pc               # 反汇编 10 条指令
```

必须先确认地址有效和对象长度。`x/s` 会继续读取直到 NUL 或访问失败，不等于已验证安全字符串。

### 控制停止条件

```text
break demo.c:12
break add if a < 0
watch total
info breakpoints
disable 1
delete 1
```

断点按位置停止；watchpoint 在值被写改变时停止，依赖硬件资源与目标支持。条件表达式在调试上下文求值，复杂条件会显著减慢执行。

## 汇编与寄存器

```text
set disassembly-flavor intel
disassemble /m add
info registers rax rdi rsi rsp rip
stepi
nexti
```

`stepi` 执行一条机器指令；`nexti` 遇到调用时尝试跨过它。源码级 `next` 与指令级 `nexti` 不能混为一谈。寄存器角色参见 [x86-64 附录](./03-x86-64-registers-and-syscalls.md)。

## 参数、环境和输入

```text
set args first "two words"
show args
set environment MODE test
show environment MODE
run < input.txt
```

这些设置改变 inferior 的运行上下文。重定向中的文件由启动 GDB 的 shell/调试环境解析；只使用授权工作区中的虚构输入，避免把生产秘密加载进调试日志。

## 崩溃排查顺序

1. 记录信号和停止指令：`x/i $pc`。
2. 获取 `backtrace full`，但注意其中可能含敏感变量。
3. 检查当前帧参数、局部变量和相关内存边界。
4. 对照源码与 `disassemble /m`，判断优化影响。
5. 用最小输入在隔离环境复现，不直接修改生产进程状态。

`set variable x=...`、`jump`、直接写内存等命令会改变被调试程序，不属于只读观察。使用前应明确目的和可恢复性。

## 常见问题

- **No debugging symbols found：** 重新以 `-g` 编译自有程序，或安装匹配版本的调试符号。
- **变量 optimized out：** 优化器删除或重排了变量；尝试调试构建，不要据此认定值为空。
- **地址每次不同：** PIE 与 ASLR 的正常结果。优先按符号和相对位置推理。
- **断点未命中：** 函数可能被内联、代码未执行、共享库尚未加载，或源码与二进制不匹配。
- **自动加载警告：** GDB 会限制不受信任目录中的脚本；不要为了消警告全局放宽安全路径。

## 官方资料

- [GNU GDB 当前官方手册](https://sourceware.org/gdb/current/onlinedocs/gdb.html/)
- [GDB Sample Session](https://sourceware.org/gdb/current/onlinedocs/gdb.html/Sample-Session.html)

---

[← 上一篇：x86-64 寄存器与系统调用](./03-x86-64-registers-and-syscalls.md) · [附录索引](./README.md) · [下一篇：pwntools 参考 →](./05-pwntools-reference.md)
