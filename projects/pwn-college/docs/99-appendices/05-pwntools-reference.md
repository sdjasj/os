# 05 · pwntools 参考：可靠驱动本地交互程序

## pwntools 解决什么问题

pwntools 是面向 CTF 与二进制分析的 Python 工具库。它最有价值的部分不是“自动利用”，而是统一了三类重复工作：

1. 通过 tube 接口收发本地进程或网络字节流。
2. 按架构与字节序打包整数、生成汇编、读取 ELF 元数据。
3. 用超时、日志和明确同步点让交互脚本可复现。

这些能力也可能被滥用。只对自己创建的 toy 程序、离线样本或明确授权的靶场使用；本篇不连接任何公网目标。

## 安装在独立虚拟环境

```bash
python3 -m venv .venv
. .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install pwntools
python -c 'import pwnlib; print(pwnlib.__version__)'
```

以当前稳定文档为例，输出可能是 `4.15.0`。实际版本会变化；项目应记录依赖版本，不把系统 Python 与多个练习项目混装。完整隔离建议参见 [本地实验环境](./06-local-lab-setup.md)。

## tube：把交互当作字节协议

`process()`、`remote()`、`listen()` 等对象共享 tube 接口。常用操作按语义分为：

| 方法 | 含义 | 注意点 |
| --- | --- | --- |
| `send(data)` | 原样发送字节 | 不自动添加换行 |
| `sendline(data)` | 发送字节并加换行 | 对方协议必须按行读取 |
| `recv(n)` | 最多读取一定字节 | 一次读取不保证得到完整消息 |
| `recvuntil(delim)` | 读到分隔符 | 分隔符必须是 `bytes` |
| `recvline()` | 读取一行 | EOF 前可能没有换行 |
| `sendafter(d, x)` | 先等提示，再发送 | 适合无换行提示 |
| `sendlineafter(d, x)` | 先等提示，再发送一行 | 是同步组合，不是盲目 sleep |
| `recvall()` | 一直读到 EOF | 对永不退出的服务会等待，应设置超时 |

Python 3 中，协议数据使用 `bytes`，例如 `b'name? '`；文本 `str` 必须显式 `.encode()`。忽略这一点会产生类型错误或错误编码。

## 完整安全示例：自建 toy 子进程

保存为 `local_tube_demo.py`：

```python
from pwn import context, process

context.clear(arch='amd64', os='linux')
context.log_level = 'error'
context.timeout = 2

toy = (
    "import sys\n"
    "sys.stdout.buffer.write(b'name? ')\n"
    "sys.stdout.buffer.flush()\n"
    "name = sys.stdin.buffer.readline().strip()\n"
    "sys.stdout.buffer.write(b'hello ' + name + b'\\n')\n"
)

io = process(['python3', '-u', '-c', toy])
try:
    io.sendlineafter(b'name? ', b'learner')
    reply = io.recvline()
    print(reply.decode('utf-8').rstrip())
finally:
    io.close()
```

运行：

```bash
python local_tube_demo.py
```

预期输出：

```text
hello learner
```

toy 代码由脚本直接传给本机 `python3`，没有打开网络端口。`-u` 关闭 Python 标准流缓冲，toy 仍显式 `flush()` 提示；主脚本等待精确提示后再发送，避免依赖不稳定的 `sleep`。

`timeout` 后方法可能返回空数据或触发相应异常，具体取决于方法。脚本必须区分“超时”“EOF”“收到了空协议字段”，不能把它们统一当成功。

## 整数与字节打包

```python
from pwn import context, p32, p64, u32, u64

context.endian = 'little'
raw = p64(0x1122334455667788)
print(raw.hex())
print(hex(u64(raw)))
print(p32(0x41424344).hex())
```

预期输出：

```text
8877665544332211
0x1122334455667788
44434241
```

`p64` 把整数编码成 8 字节，`u64` 做反向解释。位宽必须匹配：不足 8 字节时 `u64` 不会自动猜测协议，应按设计使用 `.ljust(8, b'\x00')` 或拒绝异常长度。字节序原理参见 [数值与编码参考](./02-number-encoding-reference.md)。

## ELF 只读检查

```python
from pwn import ELF

elf = ELF('/bin/true', checksec=False)
print('arch =', elf.arch)
print('bits =', elf.bits)
print('entry =', hex(elf.entry))
```

常见 x86-64 Linux 输出形态：

```text
arch = amd64
bits = 64
entry = 0x...
```

入口地址因二进制版本而异。`ELF()` 解析文件并不执行它，但解析陌生、不可信文件仍应放在隔离环境。符号可能被剥离，动态地址也会受 PIE/ASLR 和加载基址影响。

## 本机回环连接的边界

只有在你已启动并控制本地 toy 服务时，才使用：

```python
from pwn import remote

io = remote('127.0.0.1', 31337, timeout=2)
```

`127.0.0.1` 是 IPv4 回环地址。不要把主机名或端口改成第三方服务；“能连通”不代表“获准测试”。服务也应绑定回环地址，而非 `0.0.0.0`。

## 调试交互脚本的方法

1. 先把 `context.log_level` 设为 `'debug'`，观察实际收发的字节。
2. 对每个协议阶段写出精确分隔符，不以固定等待时间同步。
3. 为读操作设置合理超时，捕获 EOF 并报告当前阶段。
4. 把文本编码/解码放在边界处，内部始终处理 `bytes`。
5. 在 `finally` 中关闭 tube，避免遗留子进程。

调试日志会显示载荷和响应，可能包含口令或令牌。即使在授权环境，也不要把敏感日志提交到仓库。

## 常见误区

- `sendline()` 会追加换行，二进制定长协议未必允许。
- `recv(1024)` 的参数是上限，不保证一次返回 1024 字节。
- `interactive()` 适合人工接管，不适合需要确定结果的自动化测试。
- `process('./app')` 继承部分环境和当前目录；差异可能来自 PATH、动态库或区域设置。
- `cyclic`、汇编和 ELF 帮助函数不是跨架构自动正确；先设置并验证 `context`。
- pwntools 日志中的地址和 PID 是本次运行状态，不是可移植常量。

## 官方资料

- [pwntools 稳定版官方文档](https://docs.pwntools.com/en/stable/)
- [Tubes API](https://docs.pwntools.com/en/stable/tubes.html)
- [Packing API](https://docs.pwntools.com/en/stable/util/packing.html)

---

[← 上一篇：GDB 参考](./04-gdb-reference.md) · [附录索引](./README.md) · [下一篇：本地实验环境 →](./06-local-lab-setup.md)
