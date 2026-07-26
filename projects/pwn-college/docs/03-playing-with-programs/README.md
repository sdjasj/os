# 03 · Playing With Programs

安全工作很少只靠一个工具。真正重要的是理解数据怎样编码、HTTP 怎样传输、程序能力怎样越过权限边界，以及 SQL 怎样描述数据。本部分依照 [Playing With Programs](https://pwn.college/fundamentals/) 的四个模块，用原创的本地示例建立这些能力。

## 学完后能够

- 区分字节、文本、十六进制和 Base64，并安全地在它们之间转换。
- 从原始 TCP 字节推导 HTTP 请求、URL 编码、cookie 和状态。
- 用“程序拥有什么能力”分析过度授权，而不是背诵某个工具的技巧。
- 写出并解释 SQLite 的选择、过滤、表达式、限制和元数据查询。

## 章节索引

| 序号 | 教程 | 核心问题 |
| --- | --- | --- |
| 01 | [处理数据](./01-dealing-with-data.md) | 同一信息为何有多种表示 |
| 02 | [与 Web 对话](./02-talking-web.md) | HTTP 报文怎样承载请求和状态 |
| 03 | [程序误用与最小权限](./03-program-misuse.md) | 普通功能为何会在高权限下变成风险 |
| 04 | [SQL 练习场](./04-sql-playground.md) | 如何精确查询而不拼接不可信输入 |

## 安全约定

- Web 服务器只监听 <code>127.0.0.1</code>，客户端也只访问 localhost。
- 权限章节只使用普通用户自己创建的临时目录，不设置真实 SUID，不提供站内关卡解法。
- SQL 示例使用内存数据库，不写入真实业务数据。
- 所有示例都可独立理解；动态端口、时间和路径只需比较结构。

---

[← Computing 101](../02-computing-101/README.md) · [第一篇：处理数据 →](./01-dealing-with-data.md)
