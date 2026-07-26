# 02 · 数值与编码参考

## 表示不是对象本身

同一组比特可以被解释成无符号整数、有符号补码、浮点数、指针、机器指令或文本编码。`0x41`、十进制 `65`、二进制 `01000001` 和 ASCII 字符 `A` 可以对应同一字节，但它们是不同的显示与解释方式。

分析数据时先回答四个问题：位宽是多少、是否有符号、字节序是什么、采用何种编码。

## 进制与位宽

| 表示 | 常见前缀 | 例子 | 含义 |
| --- | --- | --- | --- |
| 二进制 | `0b` | `0b1010` | 每位基数 2，值为 10 |
| 八进制 | `0o` 或 shell 中前导 0 | `0o12` | 值为 10；常用于权限 |
| 十进制 | 无 | `10` | 面向人类计数 |
| 十六进制 | `0x` | `0x0a` | 每个十六进制位恰好表示 4 bit |

`n` bit 无符号整数范围是 `0` 到 `2^n-1`。8 bit 因而是 0–255，16 bit 是 0–65535。写十六进制时保留前导零能显示位宽，例如 `0x00000041` 明确展示 32 bit 容器。

## 二进制补码

现代系统通常用二进制补码表示有符号整数。`n` bit 范围是 `-2^(n-1)` 到 `2^(n-1)-1`。负数 `-x` 的位模式可由 `2^n-x` 计算。

以 8 bit 为例：

```text
  5 = 0000 0101 = 0x05
 -5 = 1111 1011 = 0xfb   （256 - 5 = 251）
```

同一字节 `0xfb` 若按无符号解释是 251，按 8 bit 有符号补码解释是 -5。位模式没有自行携带“有符号”标签。

## 字节序

字节序描述多字节值在内存中的排列。数值 `0x12345678` 占 4 字节：

```text
地址递增 →
小端：78 56 34 12
大端：12 34 56 78
```

x86-64 对普通整数使用小端；网络协议常约定网络字节序（大端）。字节序不改变单个字节内部的位顺序，也不等于字符串从右向左。

## 可运行转换示例

```bash
python3 - <<'PY'
import base64
import struct

value = 0x12345678
little = struct.pack('<I', value)
big = struct.pack('>I', value)

print('decimal =', value)
print('little  =', little.hex(' '))
print('big     =', big.hex(' '))
print('signed8 =', int.from_bytes(bytes([0xfb]), 'little', signed=True))
print('utf8    =', '中'.encode('utf-8').hex(' '))
print('base64  =', base64.b64encode(b'ABC').decode('ascii'))
PY
```

预期输出：

```text
decimal = 305419896
little  = 78 56 34 12
big     = 12 34 56 78
signed8 = -5
utf8    = e4 b8 ad
base64  = QUJD
```

`<I` 表示小端 32 bit 无符号整数，`>I` 表示大端。`hex()` 是可读显示；`base64` 把任意字节编码成有限字符集，既不加密也不提供完整性。

## ASCII、Unicode 与 UTF-8

Unicode 为字符分配码点，例如 `中` 是 U+4E2D；UTF-8 规定码点如何编码为字节，此处为 `e4 b8 ad`。Python 的 `str` 表示文本，`bytes` 表示字节；`.encode()` 从文本得到字节，`.decode()` 从字节按指定编码恢复文本。

```python
text = 'café'
raw = text.encode('utf-8')
assert raw == b'caf\xc3\xa9'
assert raw.decode('utf-8') == text
```

错误编码解码可能失败，也可能静默产生乱码。安全协议应明确编码并决定非法序列如何处理，不能依赖系统默认值。

## 常见转换陷阱

- **十六进制文本不等于原始字节。** 字符串 `"41"` 是字节 `34 31`；`bytes.fromhex('41')` 才得到字节 `41`。
- **Base64 不是加密。** 任何人都能无密钥还原。
- **整数溢出取决于语言。** C 无符号算术按模回绕；有符号溢出可能是未定义行为；Python 整数可自动扩展。
- **忘记位宽。** `0xff` 在 8 bit 有符号与 32 bit 有符号上下文含义不同。
- **把显示地址当稳定值。** ASLR、进程和运行次数都会改变实际地址。

## 纸面检查

给定小端四字节 `ef be ad de`：按无符号 32 bit 解释是多少十六进制？若只把四个显示字符串倒序，而未先确认它们确实是字节，会有什么问题？

答案是 `0xdeadbeef`。倒序规则只适用于已明确划分的多字节整数；若输入是文本字符、变长编码或多个字段，机械倒序会破坏结构。

## 进一步查阅

- [Python `struct` 官方文档](https://docs.python.org/3/library/struct.html)
- [Unicode 标准官方站点](https://www.unicode.org/standard/standard.html)

---

[← 上一篇：Linux 命令参考](./01-linux-command-reference.md) · [附录索引](./README.md) · [下一篇：x86-64 寄存器与系统调用 →](./03-x86-64-registers-and-syscalls.md)
