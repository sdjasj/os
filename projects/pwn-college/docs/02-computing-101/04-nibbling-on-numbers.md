# 04 · 啃一口数字：二进制、十六进制与二补数

> 对应官方模块：[Nibbling on Numbers](https://pwn.college/computing-101/nibbling-on-numbers/)

## 学习目标

- 在二进制、十六进制和十进制之间转换。
- 从固定宽度位模式推导无符号值与带符号值。
- 解释二补数为何让加减法共用同一硬件。
- 正确使用 mask、符号扩展和截断。

## 十六进制是位的紧凑记法

一位十六进制恰好表示 4 bit，也叫一个 nibble：

~~~text
0xA7 = 1010 0111₂
         A    7
~~~

两个十六进制数字表示一个 8-bit 字节。十六进制没有改变数据，只改变人的书写方式。字符串 <code>"41"</code> 是两个字符，字节值 <code>0x41</code> 是一个字节，二者不可混淆。

## 固定位宽意味着模运算

8 位寄存器只能保存 0 到 255 的无符号值。写入 256 时高位被截断，得到 0：

~~~text
256 mod 2⁸ = 0
255 + 2 mod 2⁸ = 1
~~~

CPU 的低位加法并不知道“有符号”还是“无符号”。同一位模式 <code>1111 1111</code>：

- 按无符号解释为 255；
- 按 8 位二补数解释为 -1。

对 n 位值 <code>u</code>，若最高位为 1，带符号解释为：

~~~text
signed(u) = u - 2ⁿ
~~~

因此 <code>0xFE</code> 在 8 位下是 <code>254-256=-2</code>。

## 为什么二补数便于加法

8 位下 <code>-3</code> 表示为 <code>256-3=253=0xFD</code>。计算 <code>5+(-3)</code>：

~~~text
0x05 + 0xFD = 0x102
丢弃第 9 位 → 0x02
~~~

同一个加法器就得到 2，无需另造“负数加法”电路。

## 完整示例：显式转换任意位宽

保存为 <code>fixed_width.py</code>：

~~~python
def mask_for(bits: int) -> int:
    if bits <= 0:
        raise ValueError("bits must be positive")
    return (1 << bits) - 1


def to_unsigned(value: int, bits: int) -> int:
    return value & mask_for(bits)


def to_signed(value: int, bits: int) -> int:
    unsigned = to_unsigned(value, bits)
    sign_bit = 1 << (bits - 1)
    return unsigned - (1 << bits) if unsigned & sign_bit else unsigned


for value in (127, 128, 254, 255, 256, -3):
    u8 = to_unsigned(value, 8)
    s8 = to_signed(value, 8)
    print(f"{value:>4} -> hex=0x{u8:02x} unsigned={u8:>3} signed={s8:>4}")
~~~

运行：

~~~bash
python3 fixed_width.py
~~~

预期输出：

~~~text
 127 -> hex=0x7f unsigned=127 signed= 127
 128 -> hex=0x80 unsigned=128 signed=-128
 254 -> hex=0xfe unsigned=254 signed=  -2
 255 -> hex=0xff unsigned=255 signed=  -1
 256 -> hex=0x00 unsigned=  0 signed=   0
  -3 -> hex=0xfd unsigned=253 signed=  -3
~~~

Python 整数本身可任意精度；这里用 mask 主动模拟 CPU 固定位宽。格式 <code>02x</code> 表示至少两位、十六进制、小写。

## 截断与符号扩展

从 16 位缩到 8 位会保留低 8 位：

~~~text
0x12FE → 0xFE
~~~

再扩大时必须知道原解释：

- 零扩展：<code>0xFE → 0x00FE</code>，适合无符号 254；
- 符号扩展：<code>0xFE → 0xFFFE</code>，保持 -2。

符号扩展复制原最高位，使数值不变。x86 指令中 <code>movzx</code> 执行零扩展，<code>movsx</code> 执行符号扩展。

## 常见误区

- **认为十六进制数天然无符号。** 书写进制与有无符号是两回事。
- **忽略位宽。** <code>0xFF</code> 在 8 位和 32 位中的符号解释不同。
- **把 Python 的负数右移行为直接等同于所有语言。** 语言标准和操作数类型会影响结果。
- **用浮点 <code>pow</code> 处理位。** 使用移位 <code>1 << n</code> 更精确。
- **把溢出都当成安全的模运算。** C 的无符号溢出按模定义，但有符号溢出可能是未定义行为。

## 纸面练习

把 16 位位模式 <code>0xFF80</code> 分别按无符号数和二补数有符号数解释。若把其低 8 位 <code>0x80</code> 符号扩展回 16 位，结果是什么？

### 答案

无符号值是 <code>65408</code>。最高位为 1，带符号值为 <code>65408-65536=-128</code>。低 8 位 <code>0x80</code> 表示 -128，符号扩展复制最高位，得到 <code>0xFF80</code>。

## 小结

机器中先有固定宽度位模式，后有解释。写下位宽、原始十六进制和解释规则，就能机械地推导截断、扩展和负数，而不必凭感觉判断。

---

[← 上一篇：栈](./03-the-stack.md) · [下一篇：软件内省 →](./05-software-introspection.md)
