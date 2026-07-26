# 01 · Web 安全：守住每一次“重新解释”

> 对应官方模块：[Web Security](https://pwn.college/intro-to-cybersecurity/web-security/)

## 学习目标

读完本章，你应当能够：

- 把一次 HTTP 请求画成“字节—字段—业务对象—输出页面”的数据流；
- 从解释器边界推导路径穿越、命令注入、SQL 注入与 XSS 的共同根因；
- 说明同源策略、CORS、Cookie 与 CSRF 防护各自约束什么；
- 设计参数化查询、上下文编码、可靠路径约束和会话检查；
- 用负面测试验证输入没有意外改变程序语法。

## 1. Web 漏洞为什么总与“解释”有关

浏览器发送的是字节，Web 框架把它解析成方法、路径、首部和正文；应用再把字段交给文件系统、SQL 引擎、模板引擎或操作系统。每经过一层，同一串字符都可能获得新的语义。

```text
HTTP 字节
  -> URL/表单解析
  -> 路由与业务逻辑
  -> 文件路径 / SQL 参数 / 命令参数
  -> HTML、JavaScript、JSON 或重定向响应
  -> 浏览器再次解析
```

安全设计的核心不是“过滤坏字符”，而是保证外部数据始终停留在它所属的语法位置。例如用户名应当是 SQL 的一个值，不能变成 SQL 语法；标题应当是 HTML 文本，不能变成标签；文件名应当在指定目录内，不能重新选择根目录。

可以用一个统一不变量描述：

> 用户控制的数据可以影响值，但不能改变解释器正在执行的语法结构。

## 2. 路径解析：字符串前缀不等于目录边界

假设本地文档服务只允许读取 `/srv/toy-public`。下面的函数只做路径判定，不读取真实文件：

```python
# safe_path.py
from pathlib import Path

ROOT = Path("/srv/toy-public").resolve()

def resolve_public(request_path: str) -> Path:
    relative = request_path.lstrip("/")
    candidate = (ROOT / relative).resolve()

    if candidate != ROOT and ROOT not in candidate.parents:
        raise ValueError("path leaves public root")
    return candidate

tests = [
    "images/logo.txt",
    "images/../index.html",
    "../toy-secret.txt",
]

for item in tests:
    try:
        print(f"{item!r} -> {resolve_public(item)}")
    except ValueError as error:
        print(f"{item!r} -> DENY: {error}")
```

预期输出：

```text
'images/logo.txt' -> /srv/toy-public/images/logo.txt
'images/../index.html' -> /srv/toy-public/index.html
'../toy-secret.txt' -> DENY: path leaves public root
```

推导过程如下：

1. 先把输入视为相对路径；
2. 与可信根目录组合；
3. 让文件系统语义完成规范化，而不是手工删除某个字符；
4. 检查规范化后的路径是否仍是根目录或它的后代。

仅检查 `str(candidate).startswith(str(ROOT))` 并不可靠，因为 `/srv/toy-public-old` 也有相同字符串前缀。`Path.parents` 检查的是路径组成关系。

这个例子仍不是高强度文件服务器的完整实现。检查路径后再打开文件之间可能发生符号链接替换，形成检查时与使用时不一致（TOCTOU）。面对不可信本地用户时，应考虑基于目录文件描述符的 `openat`/`openat2`、禁止跟随符号链接、最小权限和容器隔离。

## 3. 命令执行：让数据成为一个参数

危险设计常把外部文本拼入一整条 shell 命令。shell 会解释分号、管道、重定向、变量替换和通配符，因此开发者以为的“文件名”可能被重新解释成命令语法。

安全设计通常直接向程序传递参数数组，并禁用 shell：

```python
# argv_boundary.py
import subprocess

user_text = "quarterly report; draft"

completed = subprocess.run(
    ["/usr/bin/printf", "%s\\n", user_text],
    check=True,
    text=True,
    capture_output=True,
)

print(repr(completed.stdout))
```

预期输出：

```text
'quarterly report; draft\n'
```

这里的分号只是 `printf` 收到的第三个参数，不会被 shell 解释。关键区别是：

```text
不安全模型：字符串 -> shell 再解析 -> 若干命令
安全模型：参数列表 -> execve -> 一个指定程序
```

如果业务确实需要 shell 语言，应把可执行操作设计成固定枚举，而不是允许用户提供任意 shell 片段。即便做了引号转义，也要考虑目标 shell、字符编码、环境变量和后续解析层。

## 4. SQL 注入：参数化不是转义技巧

SQL 查询也同时包含语法和数据。参数化查询先固定语法树，再把值绑定到占位符；数据库不会把绑定值重新当成 SQL 片段。

下面的数据库只存在于内存：

```python
# parameterized_sql.py
import sqlite3

db = sqlite3.connect(":memory:")
db.execute("create table users (name text primary key, role text not null)")
db.executemany(
    "insert into users values (?, ?)",
    [("Ada O'Neil", "reader"), ("Lin", "editor")],
)

def role_for(name: str):
    row = db.execute(
        "select role from users where name = ?",
        (name,),
    ).fetchone()
    return None if row is None else row[0]

print(role_for("Ada O'Neil"))
print(role_for("Missing User"))
```

预期输出：

```text
reader
None
```

名字中的单引号没有破坏查询结构，因为驱动负责按数据库协议传值。要注意：参数占位符通常只能代表“值”，不能直接代表表名、列名或排序关键字。若用户可以选择排序字段，应使用白名单映射：

```python
ORDER_COLUMNS = {"name": "name", "role": "role"}
column = ORDER_COLUMNS.get(user_choice)
if column is None:
    raise ValueError("unsupported order")
```

## 5. 输出到浏览器：编码必须匹配上下文

跨站脚本（XSS）的根因是应用把不可信文本放入浏览器会执行或解析的上下文。HTML 文本节点、HTML 属性、URL、JavaScript 字符串和 CSS 的编码规则并不相同。

下面只生成一段本地 HTML 字符串：

```python
# html_context.py
from html import escape

title = "<b>local note</b>"
page = f"<h1>{escape(title)}</h1>"
print(page)
```

预期输出：

```text
<h1>&lt;b&gt;local note&lt;/b&gt;</h1>
```

浏览器会显示字面量 `<b>local note</b>`，而不是把它解释为粗体标签。更稳妥的实践是使用默认自动转义的模板系统，并避免把不可信数据插入脚本、事件处理属性或未经校验的 URL。

Content Security Policy（CSP）可以限制脚本来源、禁止内联脚本并减少 XSS 后果，但它是纵深防御，不代替正确的上下文编码。把任意 HTML 交给“清洗器”时，也必须持续更新并明确允许的标签与属性。

## 6. Cookie、同源策略与 CSRF 是三件不同的事

### 6.1 同源策略

浏览器用“协议 + 主机 + 端口”定义源。默认情况下，一个源的脚本不能随意读取另一个源的响应。这保护的是浏览器中的读取边界，不阻止浏览器向其他站点发送请求。

### 6.2 Cookie

Cookie 常作为会话凭据。推荐属性包括：

- `Secure`：只通过 HTTPS 发送；
- `HttpOnly`：阻止普通 JavaScript 读取；
- `SameSite=Lax` 或 `Strict`：减少跨站请求自动携带；
- 精确的 `Path`、短有效期和服务端撤销机制。

### 6.3 CSRF

如果浏览器自动附带身份 Cookie，恶意页面可能诱导已登录浏览器发出状态改变请求。服务端不能只问“Cookie 对不对”，还要确认“这个状态改变是否来自本应用认可的交互”。

一个简化的纯内存检查器：

```python
# csrf_check.py
import hmac

SESSION_TOKEN = "toy-session-csrf-token"

def allow_change(method: str, cookie_token: str, form_token: str) -> bool:
    if method != "POST":
        return False
    return hmac.compare_digest(cookie_token, form_token)

print(allow_change("POST", SESSION_TOKEN, SESSION_TOKEN))
print(allow_change("POST", SESSION_TOKEN, "missing"))
print(allow_change("GET", SESSION_TOKEN, SESSION_TOKEN))
```

预期输出：

```text
True
False
False
```

真实系统的 token 应不可预测、与会话绑定并通过受信页面产生。状态改变操作不应使用 GET。还可结合 `SameSite`、`Origin`/`Referer` 检查和重新认证，但不能误把 CORS 当成 CSRF 防护：CORS 主要控制响应能否被跨源脚本读取。

## 7. 认证与授权：登录成功不代表什么都能做

认证回答“你是谁”，授权回答“这个身份能否对这个资源执行此动作”。常见错误是路由只检查用户已登录，却没有检查资源所有者。

```text
请求文档 42
  -> 会话解析得到用户 Alice
  -> 查询文档 42 的 owner_id
  -> 判断 Alice 是否为 owner 或具备显式共享权限
  -> 再返回内容
```

不要相信客户端提交的 `owner=true`、价格、角色或用户 ID。服务端应从会话与数据库中的可信状态推导权限，并让拒绝成为默认结果。

## 8. 一张防御矩阵

| 边界 | 常见失效 | 根因防御 | 纵深防御 |
| --- | --- | --- | --- |
| URL → 文件系统 | 路径越界 | 规范化后验证目录关系；安全打开 API | 最小文件权限、隔离根目录 |
| 字段 → OS 程序 | 命令注入 | 参数数组、固定可执行程序 | 低权限账户、seccomp/容器 |
| 字段 → SQL | SQL 注入 | 参数化查询、白名单标识符 | 最小数据库权限、审计 |
| 数据 → HTML/JS | XSS | 上下文编码、自动转义模板 | CSP、HttpOnly Cookie |
| 跨站页面 → 状态改变 | CSRF | 会话绑定 token、验证 Origin | SameSite、重新认证 |
| 身份 → 资源 | 越权 | 每次服务端对象级授权 | 审计、最小数据返回 |

## 9. 安全验证方法

测试不应只覆盖“正常名字”。每个输入边界至少包含：

1. 空值、超长值和非 ASCII 文本；
2. 会被下一层解释的分隔符，但只用无害玩具数据；
3. 规范化后与原文本不同的路径；
4. 不存在的对象和属于另一测试用户的对象；
5. 无 Cookie、过期 Cookie、缺失 CSRF token 的请求；
6. 输出到不同上下文时，验证浏览器得到的是文本还是可执行语法。

自动化测试应断言“明确拒绝”或“按字面值处理”，而不是只断言服务没有崩溃。

## 10. 常见误区

- **“删除几个特殊字符就安全。”** 同一数据可能经历 URL 解码、Unicode 规范化、路径解析和模板渲染，多层语法无法靠一张黑名单覆盖。
- **“前端验证过，后端不用再查。”** 客户端完全由请求者控制。
- **“使用 ORM 就绝对没有注入。”** 原始 SQL、动态排序和字符串拼接仍可能打破参数边界。
- **“CORS 能阻止别人向我发请求。”** 它主要限制浏览器脚本读取响应，不是通用请求防火墙。
- **“HttpOnly 修复 XSS。”** 它减少 Cookie 被读取的风险，但恶意脚本仍可能代表用户执行操作。
- **“返回 404 就不会泄漏。”** 响应时间、长度和状态差异仍可能暴露对象是否存在。

## 11. 纸面练习与答案

### 练习一：路径不变量

应用先判断输入字符串不以 `../` 开头，然后拼到根目录。为什么这个检查不足？应在哪个阶段检查什么？

#### 答案

路径可能包含中间的父目录段、重复分隔符、编码后的字符或符号链接；文本形式与文件系统最终解析结果不等价。应在完成必要解码并按文件系统规则规范化后，验证最终对象位于允许根目录内；若存在不可信本地并发者，还应使用基于目录描述符且限制符号链接的原子打开方式。

### 练习二：查询与显示

一个搜索词先作为参数安全地送入 SQL，随后原样插入 HTML。系统是否已经安全？

#### 答案

没有。参数化只保护 SQL 解释边界；同一数据在 HTML 输出边界仍需按上下文编码。安全性质不能自动跨解释器继承。

### 练习三：跨站请求

某银行接口要求登录 Cookie，但修改地址使用 GET 且没有 CSRF token。浏览器同源策略为何不能独自保护它？

#### 答案

同源策略通常阻止攻击页面读取银行响应，却不一定阻止浏览器发出请求，而且 Cookie 可能自动附带。服务端应把状态改变改为 POST 等非安全方法，并验证不可预测、会话绑定的 CSRF token，结合 SameSite 和来源检查。

### 练习四：修复优先级

命令注入问题有两个候选修复：A）禁止分号；B）取消 shell，调用固定程序并传参数数组。哪个更接近根因？

#### 答案

B。它移除了“数据被 shell 语法重新解释”的整个边界。A 只屏蔽一种元字符，仍可能遗漏管道、重定向、替换、换行或目标 shell 的其他语法。

## 小结

Web 安全的共同主题是保持“语法与数据分离”。先画出每个解释器边界，再为该边界选择原生安全接口：路径做规范化与目录约束，进程调用使用参数数组，SQL 使用绑定参数，HTML 使用上下文编码，状态改变同时验证身份与请求意图。

---

[← 本节索引](./README.md) · [下一篇：通信拦截 →](./02-intercepting-communication.md)
