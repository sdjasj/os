# 第 6 章：ELF、链接、加载与应用生态

> 对应讲义：[第 11 讲](../sources/notes/lect11.md)、[第 12 讲](../sources/notes/lect12.md)，配套实验：[preload_clock.c](../examples/preload_clock.c)

可执行文件可以理解为“进程初始状态的描述”：把哪些字节映射到哪些地址、赋予什么权限、从哪条指令开始。链接器解决跨模块名字与地址，加载器把描述兑现成地址空间。

## 6.1 从源码到运行

```text
source.c
  │ 预处理/编译
  ↓
object.o：机器码 + 符号 + 重定位
  │ 静态链接
  ↓
ELF executable / shared object
  │ 内核 ELF loader + 动态加载器
  ↓
地址空间、入口 PC、初始栈
```

动手拆开流程：

```bash
cc -c -g hello.c -o hello.o
nm -C hello.o
readelf -S hello.o
readelf -r hello.o
objdump -dr hello.o
cc hello.o -o hello
readelf -l hello
```

目标文件里某次函数调用尚不知道最终地址，编译器留下符号引用和 relocation。链接器布局各输入段，选择符号定义，再修补引用或生成供动态链接器处理的结构。

## 6.2 section 与 segment

- **section**（`.text`、`.data`、`.symtab` 等）主要是链接视角，细分代码、数据、符号和调试信息。
- **segment**（`PT_LOAD`、`PT_INTERP` 等）主要是加载视角，告诉内核把文件哪些范围映射为可读/写/执行页面。

一个可加载 segment 可以包含多个 section。运行时通常不需要 `.symtab` 和调试 section，因此删除它们不妨碍执行。权限通常按 segment 设置：代码 `R-X`、只读数据 `R--`、可变数据 `RW-`。

## 6.3 静态链接与动态链接

静态链接把所需库代码复制进最终文件，部署简单、文件更大、更新库需重新链接。动态链接让多个程序在运行时使用共享对象：只读代码页可跨进程共享，安全修复也可由更新共享库传播，但引入版本、搜索路径和加载时解析问题。

查看依赖：

```bash
readelf -d ./examples/clock_user
ldd ./examples/clock_user
LD_DEBUG=libs,bindings ./examples/clock_user 2>&1 | less
```

不要对不可信二进制随意运行 `ldd`；安全分析优先使用 `readelf -d` 等不执行目标的工具。

## 6.4 GOT、PLT 与延迟绑定

位置无关代码不应把外部函数绝对地址写死。常见 ELF 方案是：

```text
call foo@PLT → PLT stub → GOT[foo] → 实际 foo
                              ↑
                     动态加载器首次解析并回填
```

PLT 是可执行跳板，GOT 保存运行时地址。lazy binding 把解析成本推迟到第一次调用；`LD_BIND_NOW=1` 可要求启动时完成。现代 hardening 还会使用 RELRO，尽早把可写重定位表改为只读。

## 6.5 LD_PRELOAD：理解符号插入

构建后对比：

```bash
./examples/clock_user
LD_PRELOAD="$PWD/examples/libfakeclock.so" ./examples/clock_user
```

共享库定义了同名 `time`，动态加载器优先绑定到它；包装函数再用 `dlsym(RTLD_NEXT, "time")` 找到链条中的下一个实现：

```c
time_t shifted = real_time(NULL) + 3600;
```

应用看到的时间被拨快一小时。这类机制可用于测试、性能插桩和兼容层，也可能被滥用。它不能可靠截获静态链接、直接系统调用、符号被内联/隐藏或安全执行模式中的程序。

## 6.6 内核加载器与解释器

执行 ELF 时，内核验证头部、建立 `PT_LOAD` 映射、准备栈和辅助向量。如果存在 `PT_INTERP`，真正先获得控制权的是动态加载器（如 `ld-linux`），它映射依赖、完成重定位，再跳到程序入口。

脚本的 shebang 是另一种格式分派：

```text
#!/usr/bin/python3
```

执行脚本变成执行解释器，并把脚本路径放进参数。可执行格式并非必须像 ELF 那样庞杂；课程的 Funny Little Executable 旨在说明，只要加载器与格式共同定义“初始状态”即可。

## 6.7 从内核到“可用的 Linux”

内核启动成功还不等于拥有熟悉的系统。它需要初始根文件系统和第一个用户进程：

```text
kernel → initramfs /init → 发现真实根设备 → mount/pivot_root
       → init/systemd → 服务、登录、网络、桌面
```

initramfs 是内存中的临时用户态环境，包含发现存储、解密、组装 RAID/LVM、加载模块所需工具。发行版随后提供包、配置、服务管理和升级策略；这就是“Linux 内核”和“Linux 应用生态”的两面。

## 6.8 包管理其实是软件供应链

一个软件包通常包含文件、版本、依赖、安装脚本、签名和来源信息。包管理器要完成约束求解、下载验证、原子或可恢复安装，并维护“哪些文件属于谁”。

```text
源代码/上游发布
  ↓ 构建、测试、签名
发行版仓库
  ↓ 依赖解析、校验
本机文件系统与服务
```

同一便利也扩大供应链攻击面：构建机、维护者账户、依赖名称、安装脚本和镜像站都可能成为入口。锁定版本、校验签名、可重复构建、SBOM 和最小依赖是不同层次的缓解措施。

## 6.9 常见误区

- “编译器负责生成最终地址”：分离编译时很多地址未知，链接器和加载器仍要处理。
- “ELF section 直接映射成一页”：加载依据 program header/segment，边界也不必与页面一一对应。
- “动态库只在磁盘共享”：代码页通过页缓存映射可共享，进程的可写状态通常仍私有。
- `LD_LIBRARY_PATH=.` 是通用解决方案：它会改变解析顺序并可能加载错误或恶意库。
- 更新 `.so` 就能改变正在运行的进程：已映射页和已解析符号不会自动整体替换，通常需重启。
- `initramfs` 就是最终根文件系统：多数发行版只把它作为过渡环境。

## 6.10 自测与实验

1. 用 `readelf -l` 把 `clock_user` 的虚拟地址范围与 `/proc/PID/maps` 对应起来。
2. 给预加载库包装 `open`，打印路径后调用真实函数；如何避免递归和线程安全问题？
3. 分别构建 PIE、非 PIE、静态链接程序，比较文件大小、地址布局和系统调用。
4. 为什么共享库中的全局可写变量不能简单由所有进程共享同一物理页？
5. 从内核成功挂载根文件系统到用户看到登录界面，中间还缺哪些用户态组件？

至此，单进程世界的主要抽象已经齐全。下一部分开始面对多处理器带来的不确定性。
