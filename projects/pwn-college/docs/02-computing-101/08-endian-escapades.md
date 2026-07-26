# 08 · 端序历险：多字节值怎样躺在内存里

> 对应官方模块：[Endian Escapades](https://pwn.college/computing-101/endian-escapades/)

## 学习目标

- 区分数值、字节序列与显示格式。
- 推导小端和大端编码。
- 安全地从字节流读取和写入整数。
- 识别结构体 padding 与端序是两类不同问题。

## 数字没有端序，字节表示才有

抽象整数 <code>0x12345678</code> 没有“第一个内存字节”。把它存为 4 字节时才需约定：

~~~text
低地址 → 高地址
小端：78 56 34 12
大端：12 34 56 78
~~~

“小端”把最低有效字节放在最低地址。x86-64 是小端。网络协议传统上常使用大端，也叫 network byte order。

端序不等于单个字节内部的 bit 顺序，也不等于人类打印十六进制时的字符顺序。

## 完整示例：观察本机并显式解码

保存为 <code>endian_demo.c</code>：

~~~c
#include <stdint.h>
#include <stdio.h>
#include <string.h>

static uint32_t read_be32(const unsigned char bytes[4]) {
    return ((uint32_t)bytes[0] << 24) |
           ((uint32_t)bytes[1] << 16) |
           ((uint32_t)bytes[2] << 8) |
           (uint32_t)bytes[3];
}

static void write_le32(unsigned char out[4], uint32_t value) {
    out[0] = (unsigned char)(value & 0xffu);
    out[1] = (unsigned char)((value >> 8) & 0xffu);
    out[2] = (unsigned char)((value >> 16) & 0xffu);
    out[3] = (unsigned char)((value >> 24) & 0xffu);
}

static void print_bytes(const unsigned char *bytes, size_t length) {
    for (size_t index = 0; index < length; ++index) {
        printf("%02x%s", bytes[index], index + 1 == length ? "\n" : " ");
    }
}

int main(void) {
    const uint32_t value = 0x12345678u;
    unsigned char native[sizeof value];
    unsigned char little[4];
    const unsigned char big[4] = {0x12, 0x34, 0x56, 0x78};

    memcpy(native, &value, sizeof native);
    write_le32(little, value);

    printf("native: ");
    print_bytes(native, sizeof native);
    printf("little: ");
    print_bytes(little, sizeof little);
    printf("read_be32=0x%08x\n", read_be32(big));
    return 0;
}
~~~

构建并在 x86-64 运行：

~~~bash
gcc -std=c17 -Wall -Wextra -O2 -o endian_demo endian_demo.c
./endian_demo
~~~

预期输出：

~~~text
native: 78 56 34 12
little: 78 56 34 12
read_be32=0x12345678
~~~

<code>memcpy</code> 把对象表示安全地复制到字节数组；显式位移函数与本机端序无关，适合解析文件和协议。先把每个字节转为 <code>uint32_t</code> 再移位，避免窄整数提升带来的意外。

## 字宽、截断与组合

qword、dword、word、byte 在常见 x86 语境中分别是 8、4、2、1 字节。读取某个宽度意味着：

1. 选择连续多少字节；
2. 按本机或协议端序组合；
3. 决定零扩展还是符号扩展。

例如小端内存 <code>80 ff 00 00</code>：

- 读 16 位无符号得到 <code>0xFF80=65408</code>；
- 读 16 位有符号得到 -128；
- 读 32 位得到 <code>0x0000FF80=65408</code>。

宽度变化会改变解释。

## 结构体 padding 不是端序

编译器可能在字段间插入 padding 以满足对齐：

~~~c
struct record {
    unsigned char tag;
    uint32_t count;
};
~~~

这通常不等于 5 字节；<code>count</code> 前可能有 3 字节 padding。即使双方端序相同，直接把结构体内存写到网络也会受到 padding、ABI 和编译器差异影响。协议应逐字段编码，或使用明确的序列化格式。

## 常见误区

- **把十六进制字符串倒写当作端序转换。** 应按字节分组，不是逐字符反转。
- **认为一字节值也有端序差异。** 单字节没有内部字节顺序。
- **直接强转未对齐字节缓冲区。** 可能违反对齐和别名规则。
- **把主机端序直接写入文件协议。** 应明确指定格式。
- **认为 packed struct 自动解决一切。** 它仍有端序、未对齐性能和可移植性问题。

## 纸面练习

字节序列 <code>01 02 03 04</code> 分别按 32 位大端和小端解释，十六进制值是什么？若只读取前两个字节呢？

### 答案

32 位大端为 <code>0x01020304</code>，小端为 <code>0x04030201</code>。只取前两字节，大端为 <code>0x0102</code>，小端为 <code>0x0201</code>。必须同时说明宽度和端序。

## 小结

跨文件、网络或不同机器传输整数时，不要依赖本机对象布局。明确字节宽度和端序，逐字节编码/解码，才能让位模式的含义保持一致。

---

[← 上一篇：控制流](./07-control-flow.md) · [下一篇：汇编练习集 →](./09-assembly-assortment.md)
