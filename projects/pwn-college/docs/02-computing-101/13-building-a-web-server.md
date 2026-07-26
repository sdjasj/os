# 13 · 构建 Web 服务器：从 TCP 字节流到 HTTP 响应

> 对应官方模块：[Building a Web Server](https://pwn.college/computing-101/building-a-web-server/)

## 学习目标

- 理解 <code>socket → bind → listen → accept</code> 的服务器生命周期。
- 从 TCP 字节流中识别 HTTP 请求行、首部边界和消息体长度。
- 正确处理短读、长度上限、超时和错误响应。
- 在只监听 localhost 的安全实验中观察完整请求与响应。

## TCP 提供字节流，HTTP 定义消息

服务器套接字的典型流程是：

~~~text
socket()  创建通信端点
bind()    选择本地地址和端口
listen()  建立等待连接的队列
accept()  取出一个已建立连接，得到新的连接套接字
recv()    从该连接读取字节
send()    向该连接写入字节
close()   释放连接
~~~

监听套接字继续负责接收新连接；<code>accept</code> 返回的套接字只服务某一个连接。混淆两者，会导致服务器处理完一个客户后再也无法接受新客户。

TCP 不保留应用消息边界。一次 <code>send</code> 的内容可能被多次 <code>recv</code> 取回，多次发送也可能在一次读取中出现。因此“调用一次 <code>recv(4096)</code> 就得到一份完整 HTTP 请求”不是协议保证。

HTTP/1.1 请求的简化结构为：

~~~http
POST /echo HTTP/1.1\r\n
Host: 127.0.0.1:8081\r\n
Content-Length: 5\r\n
\r\n
hello
~~~

空行 <code>\r\n\r\n</code> 终止首部；本教程的简化服务器只接受 <code>Content-Length</code> 描述的定长消息体，并明确拒绝 <code>Transfer-Encoding</code>。这避免两个长度机制产生歧义。

## 完整的 localhost 实验服务器

下面代码只绑定 <code>127.0.0.1</code>，不会主动暴露到局域网或互联网。它用于学习协议边界，不是生产服务器。保存为 <code>local_http.py</code>：

~~~python
#!/usr/bin/env python3
import socket

HOST = "127.0.0.1"
PORT = 8081
MAX_HEADER = 8192
MAX_BODY = 1024


class BadRequest(Exception):
    pass


def receive_headers(conn):
    data = bytearray()
    marker = b"\r\n\r\n"
    while marker not in data:
        chunk = conn.recv(1024)
        if not chunk:
            raise BadRequest("connection ended before headers")
        data.extend(chunk)
        if len(data) > MAX_HEADER:
            raise BadRequest("headers too large")
    head, body_prefix = bytes(data).split(marker, 1)
    return head, body_prefix


def receive_exact(conn, prefix, length):
    data = bytearray(prefix)
    if len(data) > length:
        raise BadRequest("unexpected bytes after request body")
    while len(data) < length:
        chunk = conn.recv(length - len(data))
        if not chunk:
            raise BadRequest("connection ended inside request body")
        data.extend(chunk)
    return bytes(data)


def make_response(status, body, content_type="text/plain; charset=utf-8"):
    reason = {
        200: "OK",
        400: "Bad Request",
        404: "Not Found",
        405: "Method Not Allowed",
    }[status]
    headers = [
        f"HTTP/1.1 {status} {reason}",
        f"Content-Length: {len(body)}",
        f"Content-Type: {content_type}",
        "Connection: close",
        "",
        "",
    ]
    return "\r\n".join(headers).encode("ascii") + body


def parse_request(conn):
    head, body_prefix = receive_headers(conn)
    try:
        lines = head.decode("iso-8859-1").split("\r\n")
    except UnicodeDecodeError as error:
        raise BadRequest("invalid header bytes") from error

    parts = lines[0].split(" ")
    if len(parts) != 3:
        raise BadRequest("invalid request line")
    method, path, version = parts
    if version != "HTTP/1.1" or not path.startswith("/"):
        raise BadRequest("unsupported request target or version")

    headers = {}
    for line in lines[1:]:
        if ":" not in line:
            raise BadRequest("invalid header line")
        name, value = line.split(":", 1)
        key = name.strip().lower()
        if not key or key in headers:
            raise BadRequest("empty or duplicate header")
        headers[key] = value.strip()

    if "transfer-encoding" in headers:
        raise BadRequest("transfer encoding is unsupported")
    length_text = headers.get("content-length", "0")
    if not length_text.isascii() or not length_text.isdigit():
        raise BadRequest("invalid content length")
    length = int(length_text)
    if length > MAX_BODY:
        raise BadRequest("request body too large")

    body = receive_exact(conn, body_prefix, length)
    return method, path, body


def handle(conn):
    conn.settimeout(3.0)
    try:
        method, path, body = parse_request(conn)
        if method == "GET" and path == "/":
            reply = make_response(200, b"local server is ready\n")
        elif method == "POST" and path == "/echo":
            reply = make_response(200, body, "application/octet-stream")
        elif method not in {"GET", "POST"}:
            reply = make_response(405, b"method not allowed\n")
        else:
            reply = make_response(404, b"not found\n")
    except (BadRequest, socket.timeout):
        reply = make_response(400, b"bad request\n")
    conn.sendall(reply)


def main():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        listener.bind((HOST, PORT))
        listener.listen(16)
        print(f"listening on http://{HOST}:{PORT}", flush=True)
        while True:
            conn, address = listener.accept()
            print(f"connection from {address[0]}:{address[1]}", flush=True)
            with conn:
                handle(conn)


if __name__ == "__main__":
    main()
~~~

在终端一启动：

~~~bash
python3 local_http.py
~~~

预期首先显示：

~~~text
listening on http://127.0.0.1:8081
~~~

在终端二请求首页。<code>--noproxy '*'</code> 防止本机代理改写这个实验请求：

~~~bash
curl --noproxy '*' -i http://127.0.0.1:8081/
~~~

响应的端口无关首部可能略有不同，本程序自身会返回：

~~~http
HTTP/1.1 200 OK
Content-Length: 22
Content-Type: text/plain; charset=utf-8
Connection: close

local server is ready
~~~

再发送二进制安全的 echo 请求：

~~~bash
printf 'five!' | curl --noproxy '*' -i \
    -X POST --data-binary @- http://127.0.0.1:8081/echo
~~~

关键输出为：

~~~http
HTTP/1.1 200 OK
Content-Length: 5
Content-Type: application/octet-stream
Connection: close

five!
~~~

结束实验时在服务器终端按 <code>Ctrl-C</code>。

## 逐层理解实现

### 1. 地址决定暴露范围

<code>127.0.0.1</code> 是回环地址，只有本机进程可连接。绑定 <code>0.0.0.0</code> 意味着监听所有 IPv4 接口，可能让同一网络中的其他机器访问；学习实验没有这个必要。

端口只标识本机上的服务入口，不提供身份认证或加密。真正对外部署还需 TLS、鉴权、日志、并发限制、反向代理和持续维护。

### 2. 首部和消息体要分别定界

<code>receive_headers</code> 循环读取直到找到空行，并设置 8192 字节上限。分割后，同一次 <code>recv</code> 可能已经读到部分消息体，所以返回 <code>body_prefix</code>，不能把它丢掉。

<code>receive_exact</code> 再根据 <code>Content-Length</code> 补齐消息体。读取不足、过长或超时都返回 400，而不是无限等待或默默截断。

### 3. 响应也必须自描述

状态行说明处理结果；<code>Content-Length</code> 按编码后的字节数计算，而不是按 Unicode 字符数；<code>Connection: close</code> 明确本示例处理一个请求后关闭连接。<code>sendall</code> 会持续发送直到所有响应字节交给内核或出现错误，比假设一次 <code>send</code> 写完更可靠。

### 4. 串行循环的限制

本例每次只处理一个连接，因此一个慢客户会暂时阻塞其他客户。线程、事件循环或多进程可以提供并发，但同时带来共享状态、取消、背压和资源上限问题。先把单连接协议边界写对，再选择并发模型。

## 从 C 包装器看到内核与进程

Python 隐藏了很多细节，但服务器的核心仍是 Linux 文件描述符和系统调用。Linux x86-64 的原始 syscall ABI 把调用号放在 <code>RAX</code>，参数依次放在 <code>RDI、RSI、RDX、R10、R8、R9</code>；编号是架构接口的一部分，不应跨架构照抄。C 的 <code>socket</code>、<code>bind</code>、<code>listen</code>、<code>accept</code>、<code>read</code>、<code>write</code> 和 <code>close</code> 包装器负责进入相应内核入口并把负错误码转换成 <code>errno</code>。

<code>bind</code> 接收的是结构体字节，而不是 <code>"127.0.0.1:8082"</code> 字符串。IPv4 常用结构可以概括为：

~~~c
struct sockaddr_in {
    sa_family_t       sin_family;   /* AF_INET */
    in_port_t         sin_port;     /* 16 位，网络字节序 */
    struct in_addr    sin_addr;     /* 32 位 IPv4 地址 */
};
~~~

网络协议采用大端字节序，所以程序用 <code>htons</code> 转换 16 位端口、用 <code>htonl</code> 转换 32 位地址。<code>sin_family</code> 是本机 API 字段，不做网络序转换。传给 <code>bind</code> 的长度必须与实际结构匹配；原始汇编也必须自己构造同样的内存布局。

下面的 C 版本只接受一个本机连接。它在 <code>accept</code> 后 <code>fork</code>：父进程和子进程起初各有一份描述符表，但表项引用相同的内核 socket 对象。因而子进程必须关闭监听 fd，父进程必须关闭已连接 fd；最后父进程用 <code>waitpid</code> 回收子进程，避免留下 zombie。保存为 <code>fork_http.c</code>：

~~~c
#define _POSIX_C_SOURCE 200809L
#include <arpa/inet.h>
#include <errno.h>
#include <netinet/in.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

static int write_all(int fd, const char *data, size_t length) {
    size_t offset = 0;
    while (offset < length) {
        ssize_t result = write(fd, data + offset, length - offset);
        if (result > 0) {
            offset += (size_t)result;
        } else if (result < 0 && errno == EINTR) {
            continue;
        } else {
            return -1;
        }
    }
    return 0;
}

static int has_header_end(const char *data, size_t length) {
    for (size_t i = 0; i + 3 < length; i++) {
        if (data[i] == '\r' && data[i + 1] == '\n' &&
            data[i + 2] == '\r' && data[i + 3] == '\n') {
            return 1;
        }
    }
    return 0;
}

static int serve_one(int connection) {
    char request[4096];
    size_t used = 0;
    int complete = 0;

    while (used < sizeof(request)) {
        ssize_t result = read(connection, request + used,
                              sizeof(request) - used);
        if (result > 0) {
            used += (size_t)result;
            if (has_header_end(request, used)) {
                complete = 1;
                break;
            }
        } else if (result == 0) {
            break;
        } else if (errno != EINTR) {
            return 1;
        }
    }

    static const char ok[] =
        "HTTP/1.1 200 OK\r\n"
        "Content-Length: 17\r\n"
        "Content-Type: text/plain\r\n"
        "Connection: close\r\n"
        "\r\n"
        "hello from child\n";
    static const char bad[] =
        "HTTP/1.1 400 Bad Request\r\n"
        "Content-Length: 12\r\n"
        "Connection: close\r\n"
        "\r\n"
        "bad request\n";

    const char *response = complete ? ok : bad;
    size_t response_length = complete ? sizeof(ok) - 1 : sizeof(bad) - 1;
    return write_all(connection, response, response_length) == 0 ? 0 : 1;
}

int main(void) {
    if (signal(SIGPIPE, SIG_IGN) == SIG_ERR) {
        perror("signal");
        return 1;
    }

    int listener = socket(AF_INET, SOCK_STREAM, 0);
    if (listener < 0) {
        perror("socket");
        return 1;
    }

    int reuse = 1;
    if (setsockopt(listener, SOL_SOCKET, SO_REUSEADDR,
                   &reuse, sizeof(reuse)) < 0) {
        perror("setsockopt");
        close(listener);
        return 1;
    }

    struct sockaddr_in address = {
        .sin_family = AF_INET,
        .sin_port = htons(8082),
        .sin_addr.s_addr = htonl(INADDR_LOOPBACK),
    };

    if (bind(listener, (const struct sockaddr *)&address,
             sizeof(address)) < 0 || listen(listener, 8) < 0) {
        perror("bind/listen");
        close(listener);
        return 1;
    }

    puts("listening on http://127.0.0.1:8082 (one request)");
    fflush(stdout);

    int connection;
    do {
        connection = accept(listener, NULL, NULL);
    } while (connection < 0 && errno == EINTR);
    if (connection < 0) {
        perror("accept");
        close(listener);
        return 1;
    }

    pid_t child = fork();
    if (child < 0) {
        perror("fork");
        close(connection);
        close(listener);
        return 1;
    }
    if (child == 0) {
        close(listener);
        int status = serve_one(connection);
        close(connection);
        _exit(status);
    }

    close(connection);
    int child_status;
    while (waitpid(child, &child_status, 0) < 0) {
        if (errno != EINTR) {
            perror("waitpid");
            close(listener);
            return 1;
        }
    }
    close(listener);

    return WIFEXITED(child_status) ? WEXITSTATUS(child_status) : 1;
}
~~~

终端一编译并启动：

~~~bash
cc -std=c17 -Wall -Wextra -Wpedantic -O2 fork_http.c -o fork_http
./fork_http
~~~

终端二只连接回环地址：

~~~bash
curl --noproxy '*' -i http://127.0.0.1:8082/
~~~

关键响应为：

~~~http
HTTP/1.1 200 OK
Content-Length: 17
Content-Type: text/plain
Connection: close

hello from child
~~~

服务一个请求后，子进程退出，父进程回收它并结束。若想观察 C API 与内核入口之间的关系，可重新启动服务器：

~~~bash
strace -f -e trace=network,process,read,write,close ./fork_http
~~~

再从另一个终端执行同一条 curl。<code>-f</code> 让跟踪器跟随子进程；输出会展示 <code>socket → bind → listen → accept</code>，随后是创建子进程、父子分别 <code>close</code>、子进程读写以及父进程等待。glibc 的 <code>fork</code> 在某些系统上会表现为 <code>clone</code> 或 <code>clone3</code>，这是包装器实现细节，并不改变“复制进程执行上下文”的语义。

真正的多客户进程服务器会让父进程继续 <code>accept</code>，为每个连接创建或调度工作者，并设置并发数、超时、请求上限和优雅关闭策略。无限 <code>fork</code> 会把输入流量放大为进程耗尽，因此并发本身也必须有背压。

## 这个教学服务器刻意没有什么

它没有完整实现 HTTP/1.1：不支持持久连接、分块传输、绝对形式请求目标、重复首部的合法合并规则、TLS 或高级状态码。生产环境应使用维护良好的 Web 服务器和框架，而不是继续扩展这段解析器。

安全上还要考虑慢速请求、连接数耗尽、日志注入、路径规范化、请求走私、响应拆分和应用层授权。长度上限与超时只是最初两道边界。

## 常见误区

- **认为一次 <code>recv</code> 等于一次请求。** TCP 只有有序字节流。
- **找到空行后丢弃已经读到的消息体前缀。** 这会让服务器永久等待不存在的字节。
- **用字符数作为 <code>Content-Length</code>。** 长度单位是线上传输的字节。
- **不设首部、消息体、连接和时间上限。** 每个连接都可能无限占用资源。
- **同时接受多个互相矛盾的长度描述。** 解析歧义会造成不同组件理解不同边界。
- **把教学解析器直接暴露到公网。** 能响应 curl 不等于满足生产安全要求。

## 纸面练习

某次第一次 <code>recv</code> 返回完整首部和消息体前两个字节，首部声明 <code>Content-Length: 5</code>。第二次只返回一个字节，第三次返回两个字节。服务器还应读取几次？每次之后累计的消息体长度是多少？为什么不能要求第二次就返回剩余三个字节？

### 答案

在首部分割后已有 2 字节；第二次后为 3 字节，仍不足；第三次后为 5 字节，正好完成，所以还读取两次。TCP 允许任意分段，只保证字节有序到达；读取函数请求 3 字节并不保证本次就返回 3 字节。

## 小结

实现 Web 服务器的关键不是输出一段 HTML，而是尊重每一层边界：套接字生命周期、TCP 短读、HTTP 首部终止符、消息体长度、资源上限和错误路径。

---

[← 上一篇：调试复习](./12-debugging-refresher.md) · [本节索引](./README.md) · [下一模块：Playing with Programs →](../03-playing-with-programs/README.md)
