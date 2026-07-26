# 11 · 字符串形式的数字：解析、溢出与格式化

> 对应官方模块：[Numbers as Strings](https://pwn.college/computing-101/numbers-as-strings/)

## 学习目标

- 区分字符码、数字值和机器整数。
- 从十进制字符串逐位推导整数。
- 在乘 10 和加新数字之前检测溢出。
- 理解整数转字符串为何依赖除法与余数。

## 字符“7”不等于整数 7

ASCII/UTF-8 中字符 <code>'7'</code> 的字节值为 <code>0x37</code>，即十进制 55。若已验证字符在 <code>'0'..'9'</code>，数字值可由：

~~~text
digit = character - '0'
~~~

字符串 <code>"507"</code> 的解析过程：

~~~text
0
0×10+5 = 5
5×10+0 = 50
50×10+7 = 507
~~~

必须先验证字符，再做减法；标点或空白不能悄悄当作数字。

## 完整示例：安全解析 32 位有符号十进制

保存为 <code>parse_number.c</code>：

~~~c
#include <errno.h>
#include <limits.h>
#include <stdint.h>
#include <stdio.h>

static int parse_i32(const char *text, int32_t *result) {
    if (text == NULL || result == NULL || *text == '\0') {
        return -1;
    }

    int negative = 0;
    if (*text == '+' || *text == '-') {
        negative = *text == '-';
        ++text;
        if (*text == '\0') {
            return -1;
        }
    }

    const uint32_t limit =
        negative ? (uint32_t)INT32_MAX + 1u : (uint32_t)INT32_MAX;
    uint32_t magnitude = 0;

    for (; *text != '\0'; ++text) {
        if (*text < '0' || *text > '9') {
            return -1;
        }
        uint32_t digit = (uint32_t)(*text - '0');
        if (magnitude > (limit - digit) / 10u) {
            return -2;
        }
        magnitude = magnitude * 10u + digit;
    }

    if (negative) {
        *result = magnitude == (uint32_t)INT32_MAX + 1u
                    ? INT32_MIN
                    : -(int32_t)magnitude;
    } else {
        *result = (int32_t)magnitude;
    }
    return 0;
}

int main(void) {
    const char *tests[] = {
        "507", "-12", "2147483647", "-2147483648",
        "2147483648", "12x", ""
    };

    for (size_t i = 0; i < sizeof tests / sizeof tests[0]; ++i) {
        int32_t value = 0;
        int status = parse_i32(tests[i], &value);
        if (status == 0) {
            printf("%s -> %d\n", tests[i], value);
        } else {
            printf("%s -> error %d\n",
                   *tests[i] == '\0' ? "<empty>" : tests[i], status);
        }
    }
    return 0;
}
~~~

构建运行：

~~~bash
gcc -std=c17 -Wall -Wextra -O2 -o parse_number parse_number.c
./parse_number
~~~

预期输出：

~~~text
507 -> 507
-12 -> -12
2147483647 -> 2147483647
-2147483648 -> -2147483648
2147483648 -> error -2
12x -> error -1
<empty> -> error -1
~~~

为什么负数允许的 magnitude 比正数多 1？二补数范围不对称：<code>INT32_MIN=-2147483648</code>，而 <code>INT32_MAX=2147483647</code>。代码先用无符号 magnitude 表示绝对大小，避免对 <code>INT32_MIN</code> 直接取负产生不可表示值。

溢出检查写在乘法前：

~~~text
magnitude × 10 + digit <= limit
magnitude <= (limit - digit) / 10
~~~

这样不会先溢出再检查。

## 从整数回到字符串

对正整数反复除 10：

~~~text
507 / 10 = 50 余 7
50  / 10 = 5  余 0
5   / 10 = 0  余 5
~~~

余数出现顺序是 7、0、5，所以先存入临时缓冲，再反转为 <code>"507"</code>。零要单独处理，否则循环一次也不执行。负数还要预留符号，并小心最小负数的绝对值。

生产代码通常优先用 <code>strtol</code>、<code>strtoimax</code>、<code>snprintf</code> 等成熟接口，但仍需检查：

- <code>endptr</code> 是否停在字符串结尾；
- <code>errno==ERANGE</code>；
- 结果是否落在业务允许范围；
- 是否允许空白、正号和前导零。

## 文本语法必须明确

<code>"010"</code> 是十进制 10 还是八进制 8？<code>"1_000"</code> 是否允许下划线？<code>"+0"</code> 是否规范？解析器和调用者必须共同定义，不能依赖不同库的隐式猜测。安全协议还常要求唯一规范形式，避免同一数值有多种文本表示导致签名或缓存键不一致。

## 常见误区

- **忘记字符码与数字值的差。**
- **先乘加、后检查溢出。** 此时错误已经发生。
- **对 <code>INT_MIN</code> 直接取绝对值。**
- **只检查解析出的前缀。** <code>"12x"</code> 不应悄悄接受为 12。
- **把格式化字符串交给不可信输入。** 格式应固定，数据通过参数传入。
- **认为前导零、加号和空白在所有协议中都等价。**

## 纸面练习

用逐位算法解析 <code>"409"</code>，列出每一步 accumulator。若上限是 255，在哪一位之前可以判定溢出？

### 答案

初始 0；读 4 得 4；读 0 得 40；准备读 9 时，需要检查 <code>40 <= (255-9)/10 = 24</code>，不成立，所以在执行 <code>40×10+9</code> 前即可判定溢出。

## 小结

数字文本转换是一个有状态协议：验证字符、维护符号、检查边界、逐位累积。把每个步骤写出来，比依赖隐式转换更容易审计。

---

[← 上一篇：再访栈](./10-the-stack-revisited.md) · [下一篇：调试复习 →](./12-debugging-refresher.md)
