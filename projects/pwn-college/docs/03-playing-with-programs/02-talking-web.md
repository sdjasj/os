# 02 · 与 Web 对话：请求、响应与状态

> 对应官方模块：[Talking Web](https://pwn.college/fundamentals/talking-web/)

## 学习目标

- 把 URL、HTTP 请求、HTTP 响应和 TCP 连接区分开。
- 理解方法、路径、查询参数、首部、消息体和状态码的职责。
- 正确进行 URL 编码，并观察 Cookie 如何在多次请求间携带状态。
- 使用仅绑定 localhost 的完整客户端/服务器示例进行安全实验。

## 一次 Web 交互包含哪些层

浏览器里的一条 URL 例如：

~~~text
http://127.0.0.1:8080/greet?name=A%26B
\__/   \_______/ \__/ \________________/
方案       主机    端口       路径与查询
~~~

客户端先根据方案、主机和端口建立连接，再发送 HTTP 请求。服务器返回状态行、首部和可选消息体。HTTP 不等于 HTML：消息体可以是文本、JSON、图片或任意字节。

一个原始请求可能是：

~~~http
GET /greet?name=A%26B HTTP/1.1
Host: 127.0.0.1:8080
Accept: text/plain
Connection: close

~~~

请求行里的目标通常只含路径和查询，不重复方案与主机。<code>Host</code> 允许同一个地址承载多个站点。空行表示首部结束。

## URL 编码不是“把整条 URL 替换一遍”

查询语法用 <code>&amp;</code> 分隔参数，用 <code>=</code> 分隔名称和值。如果数据本身是 <code>A&amp;B</code>，其中的 <code>&amp;</code> 必须编码为 <code>%26</code>，否则会被误解为下一个参数的开始。

应先分别编码组件，再用语法字符组装。不要把整条 URL 交给只针对参数值的编码器，否则 <code>:</code>、<code>/</code>、<code>?</code> 等结构也可能被错误处理。

## 完整 localhost 示例：两次请求与 Cookie

下面程序在回环地址上启动一个临时端口，随后由同一进程中的客户端发出两次请求。它不访问外网。保存为 <code>local_web_demo.py</code>：

~~~python
#!/usr/bin/env python3
from http.cookies import SimpleCookie
from http.cookiejar import CookieJar
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread
from urllib.parse import parse_qs, urlencode, urlsplit
from urllib.request import HTTPCookieProcessor, build_opener


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urlsplit(self.path)
        if parsed.path != "/greet":
            self.send_error(404)
            return

        parameters = parse_qs(parsed.query, keep_blank_values=True)
        name = parameters.get("name", ["visitor"])[0][:32]

        visits = 0
        cookie = SimpleCookie()
        try:
            cookie.load(self.headers.get("Cookie", ""))
            if "visits" in cookie:
                visits = int(cookie["visits"].value)
        except (ValueError, KeyError):
            visits = 0
        visits += 1

        body = f"hello {name}; visits={visits}\n".encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header(
            "Set-Cookie", f"visits={visits}; Path=/; SameSite=Lax"
        )
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format_string, *arguments):
        pass


def main():
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()

    port = server.server_address[1]
    target = "/greet?" + urlencode({"name": "A&B"})
    opener = build_opener(HTTPCookieProcessor(CookieJar()))

    try:
        print(f"request_target={target}")
        for number in (1, 2):
            url = f"http://127.0.0.1:{port}{target}"
            with opener.open(url, timeout=2) as response:
                text = response.read().decode("utf-8").rstrip("\n")
                print(f"response_{number}={text}")
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


if __name__ == "__main__":
    main()
~~~

运行：

~~~bash
python3 local_web_demo.py
~~~

预期输出：

~~~text
request_target=/greet?name=A%26B
response_1=hello A&B; visits=1
response_2=hello A&B; visits=2
~~~

<code>urlencode</code> 把数据中的 <code>&amp;</code> 变成 <code>%26</code>；服务器的 <code>parse_qs</code> 再还原它。客户端的 CookieJar 看到第一次响应中的 <code>Set-Cookie</code> 后，在第二次请求自动加入类似下面的首部：

~~~http
Cookie: visits=1
~~~

因此服务器能计算第二次访问为 2。HTTP 服务端本身没有因为 TCP 连接而自动记住用户；状态是通过客户端再次提交 Cookie 建立的关联。

## 请求的组成部分

### 方法

<code>GET</code> 通常读取资源，<code>POST</code> 通常提交数据，但真正语义由应用和协议定义。不能认为使用某个方法就自动获得鉴权、幂等性或防重放能力。服务器必须显式限制每条路由允许的方法。

### 路径和查询

路径标识资源层级；查询通常提供筛选或参数。两者都来自不可信客户端。规范化、长度限制和路由匹配必须在同一种解码语义下进行，避免代理、框架和应用对同一字符串理解不同。

### 首部

首部携带元数据，如可接受类型、消息体类型、缓存策略和身份凭据。首部名称大小写不敏感，但值的语法由具体首部定义。不要把任意首部值直接拼进日志、响应或数据库语句。

### 消息体

消息体是字节。<code>Content-Type</code> 告诉接收方如何解释它，<code>Content-Length</code> 或其他帧机制说明边界。JSON 文本也必须先按规定字符集编码成字节再传输。

## 响应告诉客户端发生了什么

状态码按类别表达结果：

- 2xx：请求已成功处理；
- 3xx：需要重定向或使用缓存；
- 4xx：请求、身份或权限等客户端侧条件不满足；
- 5xx：服务器未能完成有效请求。

客户端不应只看消息体中的自然语言。应先检查状态码，再按 <code>Content-Type</code> 解码消息体。重定向也可能改变方法、目标站点或凭据发送范围，自动跟随前要了解库的策略。

## Cookie、会话与安全边界

Cookie 是服务器要求客户端在后续匹配请求中带回的一小段数据。它不是天然可信的数据库记录：客户端可以删除、重放或修改普通 Cookie。若 Cookie 表示权限，服务端必须使用不可伪造的签名/加密方案或只保存随机会话标识，并在服务器端查实际权限。

常见属性的目的不同：

- <code>Secure</code>：只通过 HTTPS 发送；
- <code>HttpOnly</code>：阻止普通页面脚本读取；
- <code>SameSite</code>：限制部分跨站请求场景；
- <code>Path</code> 和 <code>Domain</code>：限制发送范围；
- <code>Max-Age</code>/<code>Expires</code>：控制生命周期。

本地示例使用明文 HTTP，所以没有演示 <code>Secure</code>。真实凭据不应在明文网络上传输。

## HTTP 与 HTTPS 的界线

HTTPS 是在 TLS 保护的连接中传输 HTTP。TLS 可以为传输提供机密性、完整性并验证所连接服务器的证书身份，但不会自动修复应用中的越权、SQL 注入或错误的 Cookie 逻辑。URL 中的主机名验证、证书验证和应用授权是不同层面的检查。

## 常见误区

- **把 URL 编码当加密。** <code>%26</code> 只是字符的传输表示。
- **手工拼查询字符串。** 数据中的 <code>&amp;</code>、<code>=</code>、空格和非 ASCII 字符会破坏结构。
- **只看 200 以外就是“网络坏了”。** 4xx、5xx 是已经收到的 HTTP 响应。
- **相信客户端提交的 Cookie 权限值。** 客户端输入必须验证或以不可伪造方式保护。
- **把一次 TCP 连接等同于一个登录会话。** 会话关联通常由 Cookie 或令牌实现。
- **认为 HTTPS 会修复应用逻辑漏洞。** 它主要保护传输层。

## 纸面练习

参数值是 <code>a b&amp;c</code>。使用常见表单式查询编码时，目标片段应是什么？若错误地写成 <code>?q=a b&amp;c</code>，服务器可能怎样分解参数？第二次请求携带 <code>Cookie: visits=1</code> 时，服务端为什么仍应验证该值？

### 答案

通过 <code>urlencode({"q": "a b&amp;c"})</code> 得到 <code>q=a+b%26c</code>：空格表示为 <code>+</code>，数据中的 <code>&amp;</code> 表示为 <code>%26</code>。未编码的 <code>&amp;</code> 会被当作参数分隔符，服务端可能得到 <code>q="a b"</code> 和一个名为 <code>c</code> 的额外参数。Cookie 来自客户端，可能被修改为非数字、负数或极大值；服务端必须按不可信输入解析并施加范围约束。

## 小结

与 Web 对话时，把 URL 结构、请求字段、响应状态和跨请求状态逐层拆开。成熟库负责正确编码与协议细节，应用仍负责边界、身份与授权。

---

[← 上一篇：处理数据](./01-dealing-with-data.md) · [下一篇：程序误用与最小权限 →](./03-program-misuse.md)
