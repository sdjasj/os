# 01 · 处理数据：字节、文本与编码层

> 对应官方模块：[Dealing with Data](https://pwn.college/fundamentals/data-dealings/)

## 学习目标

- 区分“原始字节”“字符文本”和“供人阅读的表示”。
- 理解 UTF-8、十六进制与 Base64 的输入输出类型。
- 能按相反顺序拆解多层编码，并验证往返是否无损。
- 避免换行、隐式字符集和重复编码造成的数据偏差。

## 数据本身没有自动附带含义

内存、文件和网络最终承载的都是字节。字节 <code>0x41</code> 可以被约定为 ASCII 字符 <code>A</code>、整数 65、位图中的一个颜色分量，或压缩流的一部分。解释取决于协议和类型信息。

可以把常见转换画成：

~~~text
Unicode 文本 --encode(UTF-8)--> 字节
Unicode 文本 <--decode(UTF-8)-- 字节

字节 --hex/base64 encode--> 只含特定字符的文本
字节 <--hex/base64 decode-- 只含特定字符的文本
~~~

这里有两个非常重要的方向：

- 字符编码解决“字符如何表示为字节”；
- 二进制到文本编码解决“任意字节如何装进文本通道”。

十六进制和 Base64 都不是加密，知道规则的人无需密钥即可还原。

## 完整示例：明确每一层的类型

保存为 <code>data_layers.py</code>：

~~~python
#!/usr/bin/env python3
import base64

raw = b"local data"

hex_text = raw.hex()
base64_text = base64.b64encode(raw).decode("ascii")

from_hex = bytes.fromhex(hex_text)
from_base64 = base64.b64decode(base64_text, validate=True)

print(f"bytes={raw!r}")
print(f"hex={hex_text}")
print(f"base64={base64_text}")
print(f"roundtrip={from_hex == raw and from_base64 == raw}")

word = "猫"
utf8 = word.encode("utf-8")
print(
    f"text={word} utf8={utf8.hex()} "
    f"byte_length={len(utf8)} character_length={len(word)}"
)
~~~

运行：

~~~bash
python3 data_layers.py
~~~

预期输出：

~~~text
bytes=b'local data'
hex=6c6f63616c2064617461
base64=bG9jYWwgZGF0YQ==
roundtrip=True
text=猫 utf8=e78cab byte_length=3 character_length=1
~~~

<code>b"local data"</code> 是 Python 字节对象；<code>hex_text</code> 和 <code>base64_text</code> 是字符串。代码显式用 ASCII 解码 Base64 的输出，因为 Base64 字母表本身属于 ASCII。<code>validate=True</code> 让解码器拒绝字母表外的字符，而不是悄悄忽略它们。

“猫”是一个 Unicode 码点，但它的 UTF-8 表示占 3 个字节。协议若规定“最多 10 字节”，就必须在编码后检查字节长度；界面若限制“最多 10 个字符”，则还要明确是码点、用户感知字符还是其他计数规则。

## 用命令行观察同一份数据

<code>printf</code> 默认不添加换行，适合构造精确字节。下面两条命令分别产生十六进制和 Base64 表示：

~~~bash
printf 'local data' | xxd -p
printf 'local data' | base64
~~~

预期为：

~~~text
6c6f63616c2064617461
bG9jYWwgZGF0YQ==
~~~

再还原并以十六进制检查：

~~~bash
printf '6c6f63616c2064617461' | xxd -r -p | xxd -g 1
printf 'bG9jYWwgZGF0YQ==' | base64 -d | xxd -g 1
~~~

两者的数据区都应包含：

~~~text
6c 6f 63 61 6c 20 64 61 74 61
~~~

不要用 <code>echo</code> 猜测精确输入：不同实现对 <code>-n</code> 和反斜杠的处理可能不同，而且默认添加的换行字节 <code>0a</code> 会改变编码、长度与散列。

## 十六进制是怎样映射的

一个字节有 8 位，可拆成两个 4 位半字节。每个半字节取值 0 到 15，正好对应一个十六进制字符：

~~~text
字节 0x6c = 二进制 0110 1100
高半字节 0110 = 6
低半字节 1100 = c
所以显示为 "6c"
~~~

因此 N 个字节总会变成 2N 个十六进制字符。十六进制适合调试和精确描述字节，但空间开销是 100%。

## Base64 为什么通常每 3 字节变 4 字符

3 字节是 24 位，Base64 将其拆成四组 6 位。6 位有 64 种取值，映射到固定字母表。若输入不足 3 字节，末尾通常用 <code>=</code> 填充到四字符组。

~~~text
3 个输入字节 = 24 位 = 4 × 6 位 = 4 个 Base64 字符
~~~

Base64 的典型空间开销约为三分之一。某些协议采用 URL-safe 变体，把 <code>+</code> 和 <code>/</code> 换成 <code>-</code> 和 <code>_</code>；是否保留填充也由协议决定。不能仅凭“看起来像 Base64”就猜变体。

## 多层转换要记录栈顺序

假设发送方执行：

~~~text
原始字节 → Base64 文本的 ASCII 字节 → 十六进制文本
~~~

接收方必须逆序执行：

~~~text
十六进制解码 → 得到 Base64 文本 → Base64 解码 → 原始字节
~~~

可以为每一层写类型标注：

~~~text
bytes --b64encode--> bytes-of-ASCII --hex--> str
str   --fromhex--> bytes-of-ASCII --b64decode--> bytes
~~~

每拆一层就检查字母表、长度约束和预期格式。若只因为输出“仍可打印”就继续猜，容易多解一次或少解一次。

## 文件、终端与换行

文本文件仍然是字节序列。Unix 文本行通常以 <code>0a</code> 结束，Windows 常见 <code>0d 0a</code>。终端可能按当前 locale 解码字节，无法解码时显示替代字符，但原始文件不一定坏了。诊断时优先用 <code>xxd</code> 或 <code>od -An -tx1</code> 看字节事实。

二进制数据不要先随意 <code>decode</code> 成文本再写回；一次失败的解码或规范化可能不可逆。应保持为 bytes，仅在协议明确要求的边界转换。

## 常见误区

- **把 Base64 当加密。** 它没有秘密密钥，只是表示转换。
- **认为字符串长度就是网络字节长度。** UTF-8 中一个字符可占多个字节。
- **忽略末尾换行。** 一个 <code>0a</code> 会改变全部后续编码或散列结果。
- **把十六进制字符直接当原始字节。** 文本 <code>"41"</code> 是两个 ASCII 字节，解码后才是一个 <code>0x41</code>。
- **不记录编码顺序。** 多层转换必须逆序拆解。
- **依靠平台默认字符集。** 文件或协议边界应显式指定 UTF-8 等编码。

## 纸面练习

给定十六进制文本 <code>41420a</code>：还原后有几个字节？若按 ASCII/UTF-8 显示是什么？若对还原后的字节做 Base64 编码，为什么结果与直接对六个字符 <code>41420a</code> 编码不同？

### 答案

每两个十六进制字符表示一个字节，所以得到 3 字节：<code>0x41 0x42 0x0a</code>，显示为 <code>AB</code> 后跟换行。直接编码文本 <code>41420a</code> 时，输入是六个 ASCII 字节 <code>34 31 34 32 30 61</code>；先做十六进制解码时输入 Base64 的则是三个字节，类型和长度都不同，结果自然不同。

## 小结

处理数据时，最有用的问题是：“这一层的值是什么类型、采用什么规则、下一层期待什么？”把字节、文本和文本化表示分开，复杂编码就会变成可验证的逐层转换。

---

[← 返回本模块目录](./README.md) · [下一篇：与 Web 对话 →](./02-talking-web.md)
