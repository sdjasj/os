# 12 · 调试复习：用证据缩小程序故障

> 对应官方模块：[Debugging Refresher](https://pwn.college/computing-101/debugging-refresher/)

## 学习目标

- 把“程序不对”改写成可重复、可验证的最小故障。
- 理解断点、单步、调用栈、局部变量和观察点各自回答什么问题。
- 使用带调试信息的构建，让源码、机器指令和运行状态对应起来。
- 区分“观察到的事实”“关于原因的假设”和“修复后的验证”。

## 调试不是猜修复，而是定位第一次偏离

程序最终输出错误，只说明某条执行路径上发生了偏离。高效的调试循环是：

1. 写出确定的输入、预期输出和实际输出；
2. 提出一个可以被证伪的假设；
3. 在假设涉及的边界前后观察状态；
4. 找到第一个与不变量不符的位置；
5. 做最小修改，并重新运行原测试和边界测试。

例如，若求和结果少了最后一项，假设可以是“循环退出条件提前了一次”，而不是模糊地说“循环坏了”。随后只需观察循环变量、累加器和退出条件。

## 可重复构建为什么重要

调试器通过调试信息把地址映射回函数、源码行和变量。先使用便于观察的构建：

~~~bash
gcc -std=c17 -Wall -Wextra -Wpedantic \
    -O0 -g3 -fno-omit-frame-pointer \
    -o debug_loop debug_loop.c
~~~

- <code>-g3</code> 保留源码、行号、变量和宏信息；
- <code>-O0</code> 减少优化导致的重排、合并和变量消失；
- <code>-fno-omit-frame-pointer</code> 通常让调用栈更容易阅读；
- 警告选项常能在进入调试器前指出类型或控制流错误。

这不是说优化程序不能调试，而是优化后“一行源码执行一次”“变量始终有存储位置”等直觉可能不再成立。最终仍应在发布构建上复现并验证。

## 完整示例：定位边界错误

保存为 <code>debug_loop.c</code>：

~~~c
#include <stdio.h>

static long sum_to(long limit) {
    long total = 0;
    for (long current = 1; current < limit; ++current) {
        total += current;
    }
    return total;
}

int main(void) {
    const long input = 4;
    const long expected = 10;  /* 1 + 2 + 3 + 4 */
    const long actual = sum_to(input);
    printf("input=%ld expected=%ld actual=%ld\n",
           input, expected, actual);
    return actual == expected ? 0 : 1;
}
~~~

构建并运行：

~~~bash
gcc -std=c17 -Wall -Wextra -Wpedantic \
    -O0 -g3 -fno-omit-frame-pointer \
    -o debug_loop debug_loop.c
./debug_loop
echo "exit=$?"
~~~

预期看到：

~~~text
input=4 expected=10 actual=6
exit=1
~~~

退出码把失败暴露给脚本和测试系统；若程序无论对错都返回 0，自动化会把错误结果当成成功。

## 在 GDB 中验证假设

启动调试器，在函数入口暂停：

~~~text
$ gdb -q ./debug_loop
(gdb) break sum_to
(gdb) run
(gdb) print limit
$1 = 4
(gdb) list sum_to
~~~

<code>break</code> 回答“在何处停”，<code>run</code> 创建一次新的被调试进程，<code>print</code> 读取表达式，<code>list</code> 则帮助确认当前源码和行号。接着在 <code>total += current;</code> 所在行设置断点；若文件保持上面的排版，该行是第 6 行：

~~~text
(gdb) break debug_loop.c:6
(gdb) continue
(gdb) print current
$2 = 1
(gdb) print total
$3 = 0
(gdb) display current
(gdb) display total
(gdb) next
~~~

反复执行 <code>next</code>，典型状态序列为：

~~~text
执行加法前：current=1, total=0
执行加法前：current=2, total=1
执行加法前：current=3, total=3
离开循环后：             total=6
~~~

从未出现 <code>current=4</code>，证伪了“加法算错”并支持“退出条件提前”的假设。把条件从 <code>current &lt; limit</code> 改为 <code>current &lt;= limit</code> 后重新构建，预期输出为：

~~~text
input=4 expected=10 actual=10
exit=0
~~~

修复必须覆盖边界。至少再检查 <code>sum_to(1)==1</code> 和业务是否允许 <code>limit&lt;=0</code>；后者应由规格决定，而不是由调试器替你猜。

## 常用观察手段各自解决什么问题

### 单步：step 与 next

<code>step</code> 会进入被调用函数，适合怀疑该函数内部；<code>next</code> 把当前源码行整体执行完，适合先观察调用者。若已经误入很深，可用 <code>finish</code> 运行到当前函数返回。

### 调用栈：backtrace 与 frame

~~~text
(gdb) backtrace
(gdb) frame 1
(gdb) info args
(gdb) info locals
~~~

调用栈回答“程序如何来到这里”。崩溃现场常停在库函数内，真正错误可能是上层调用者传入了无效长度或指针，所以要逐帧检查参数。

### 内存与类型

~~~text
(gdb) print/x total
(gdb) x/16bx &total
(gdb) ptype total
~~~

<code>print/x</code> 以十六进制解释一个有类型的值；<code>x/16bx</code> 从指定地址查看 16 个字节；<code>ptype</code> 检查调试器采用的类型。不要把内存显示格式误当成变量真实类型。

### 观察点

进入 <code>sum_to</code> 且 <code>total</code> 已在作用域后，可以执行：

~~~text
(gdb) watch total
(gdb) continue
~~~

观察点在值发生变化时暂停，适合回答“谁第一次改坏了这个状态”。硬件观察点数量有限，观察大范围内存也可能很慢，因此应先缩小对象。

## 崩溃时先保存现场

若问题偶发，记录输入、可执行文件版本、编译参数、环境和完整错误输出。允许生成 core dump 的环境中，可用 core 文件离线查看崩溃时的寄存器和调用栈。不要在调试时随意改变输入、工作目录、环境变量和编译选项，否则你可能正在研究另一个程序行为。

还可以把调试器命令写成脚本，使观察可重复：

~~~text
set pagination off
break sum_to
run
print limit
backtrace
quit
~~~

保存为 <code>inspect.gdb</code> 后运行 <code>gdb -q -batch -x inspect.gdb ./debug_loop</code>。批处理输出便于和不同版本比较。

## 常见误区

- **一开始就到处加日志。** 先明确假设和边界，否则大量输出会掩盖关键事件。
- **把最后崩溃的位置当成根因。** 内存或状态可能更早已经损坏。
- **在优化构建中相信每个变量都能打印。** 变量可能被常量传播、放入寄存器或完全消除。
- **修复后只运行原失败输入。** 还应测试相邻边界和已有回归测试。
- **忽略编译器警告和退出码。** 它们本来就是低成本证据。
- **边单步边修改多个条件。** 同时改变多项会失去因果关系。

## 纸面练习

一个函数处理长度为 3 的数组，调试时在循环体入口观察到索引依次为 0、1、2、3。数组有效索引是什么？第一条应该验证的假设是什么？若崩溃发生在索引 3 处，为什么还不能直接断言“读取指令有问题”？

### 答案

有效索引是 0、1、2。首先验证循环条件是否把 <code>index == length</code> 也放进了循环，例如误写为 <code>index &lt;= length</code>。索引 3 已越过数组边界；读取指令只是执行了调用者给出的地址，根因更可能是循环不变量或长度约束更早被破坏。还应检查长度来源以及是否存在其他写越界。

## 小结

调试的核心不是熟记命令，而是把执行过程变成证据：在明确边界处暂停，检查不变量，找到第一次偏离，再用回归测试证明修复有效。

---

[← 上一篇：字符串形式的数字](./11-numbers-as-strings.md) · [下一篇：构建 Web 服务器 →](./13-building-a-web-server.md)
