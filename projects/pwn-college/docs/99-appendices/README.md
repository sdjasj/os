# 99 · 附录与速查

这里的附录不是替代正文的命令清单，而是遇到具体问题时可独立查阅的“模型 + 示例 + 注意事项”。每篇先说明工具或概念解决什么问题，再给出只作用于本地自建对象、回环服务或本机只读系统内省的示例。

## 使用边界

- 只调试自己编译的程序，或有明确书面授权的目标。
- 网络示例仅允许本机 toy 服务与 `127.0.0.1`。
- 默认普通用户权限；不为“省事”添加 `sudo`、特权容器或宿主根目录挂载。
- 输出中的地址、PID、版本和临时路径是环境相关值，不应照抄为固定答案。
- 附录不包含 pwn.college challenge 的 flag、专用输入或逐关解法。

## 索引

| 文件 | 适合在什么时候查 |
| --- | --- |
| [Linux 命令参考](./01-linux-command-reference.md) | 不确定该用哪类命令，或需要判断输入、输出、副作用时 |
| [数值与编码参考](./02-number-encoding-reference.md) | 在十六进制、字节序、补码、ASCII、UTF-8 之间转换时 |
| [x86-64 寄存器与系统调用](./03-x86-64-registers-and-syscalls.md) | 阅读汇编、函数调用或 Linux syscall 时 |
| [GDB 参考](./04-gdb-reference.md) | 要在自建程序中暂停、单步、查看栈与内存时 |
| [pwntools 参考](./05-pwntools-reference.md) | 要可靠驱动本地交互程序、收发字节或解析 ELF 时 |
| [本地实验环境](./06-local-lab-setup.md) | 安装工具、隔离数据、创建可恢复工作区时 |
| [术语表](./07-glossary.md) | 遇到相近术语，需要快速区分含义时 |

## 推荐查阅路径

第一次接触二进制主题时，建议按“数值与编码 → x86-64 → GDB → pwntools”阅读。命令行不熟悉时先查 Linux 命令参考；准备运行任何代码前先阅读本地实验环境。

## 一个通用的只读诊断框架

面对陌生文件，先识别类型和元数据，再决定是否执行：

```bash
sample=/bin/true
stat -c 'mode=%A size=%s bytes' -- "$sample"
file -- "$sample"
```

典型输出形态：

```text
mode=-rwxr-xr-x size=... bytes
/bin/true: ELF 64-bit LSB pie executable, x86-64, ...
```

`stat` 和 `file` 只读取元数据与文件头，不启动目标。若路径来自外部，应先验证它确实位于授权工作区；即使 `file` 判断为可执行文件，也不能证明其安全。

## 版本说明

命令与工具会随发行版变化。运行 `bash --version`、`gdb --version`，以及虚拟环境中的 `python3 -c 'import pwnlib; print(pwnlib.__version__)'` 记录本地版本，并优先查对应版本的官方文档。

---

[返回教程主线](../01-linux-luminarium/README.md) · [第一篇：Linux 命令参考 →](./01-linux-command-reference.md)
