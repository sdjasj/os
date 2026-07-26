# 02 · 通信拦截：从分层传输到可信信道

> 对应官方模块：[Intercepting Communication](https://pwn.college/intro-to-cybersecurity/intercepting-communication/)

## 学习目标

读完本章，你应当能够：

- 解释 Ethernet、ARP、IP、TCP 与应用协议分别解决什么问题；
- 区分地址、路由、连接、消息边界和应用身份；
- 说明被动观察、主动篡改、重放和冒充需要不同的防御；
- 理解 TCP 是字节流，能设计明确的应用层消息分帧；
- 说明 TLS 的机密性、完整性与证书验证为什么缺一不可。

## 1. 分层机制：一次发送经过哪些层

假设浏览器向某个服务发送一段 HTTP 数据。概念上它会经历：

```text
应用数据：       HTTP 方法、路径、首部、正文
传输层：         TCP 端口、序列号、确认与重传
网络层：         源 IP、目的 IP、路由选择
链路层：         本地网段中的源 MAC、下一跳 MAC
物理/虚拟介质：  电信号、无线电或虚拟交换机中的帧
```

接收端按相反顺序解封装。每一层只提供有限承诺：

- Ethernet 负责同一链路中的帧传递，不证明应用用户是谁；
- IP 尽力把数据报送往目的地址，不保证送达、顺序或唯一；
- TCP 在两个端点之间提供有序字节流，不自动提供加密和应用身份；
- TLS 在可靠传输之上建立加密且经过认证的信道；
- 应用仍需做登录、授权、重放防护和业务校验。

“数据到了正确 IP”与“数据来自正确的人”不是同一命题。

## 2. Ethernet 与交换：本地交付

Ethernet 帧包含源和目的 MAC 地址。交换机学习“某个源 MAC 最近出现在哪个端口”，再把目的帧转发到相应端口。广播帧则会被送到同一广播域内的多个端口。

MAC 地址是链路层标识，不是密码学身份。网卡和软件可以配置不同的源 MAC；交换表也只是转发状态。因此任何需要可信身份的应用都不能把“看到某个 MAC”当作充分认证。

防御重点包括：

- 缩小广播域，使用 VLAN 和网络分段；
- 对接入端口使用端口安全、802.1X 等认证；
- 对关键协议使用端到端加密，而不是假定内网天然可信；
- 监控异常的地址漂移和拓扑变化。

## 3. ARP：把下一跳 IP 映射为 MAC

主机要向同一 IPv4 子网的下一跳发送帧，必须知道该下一跳的 MAC。ARP 负责询问“谁拥有这个 IPv4 地址”，并把回答缓存起来。

它的传统设计主要追求可用性，没有给回答附带强密码学证明。因此本地链路中的恶意或错误节点可能造成错误映射。后果取决于网络拓扑：流量可能中断，也可能被错误节点转发后形成中间位置。

这里应建立的分析模型是：

```text
应用想发往目标 IP
  -> 路由表选出下一跳与接口
  -> 邻居缓存给出下一跳 MAC
  -> Ethernet 帧被交给该 MAC
```

排障时不要混淆“最终目标 IP”和“本地帧的目的 MAC”。跨网段通信时，目的 MAC 通常属于网关，而 IP 目的地址仍是远端服务。

网络侧可使用 DHCP snooping、动态 ARP 检查、静态关键邻居项和分段；应用侧仍应依赖 TLS 等端到端认证，因为链路层控制不能覆盖整条路径。

## 4. IP 与路由：逐跳选择，不是预先铺好的管道

IPv4 数据报包含源地址、目的地址和 TTL。路由器查看目的地址，按最长前缀匹配选择下一跳。TTL 每经过一跳递减，归零后丢弃，避免路由环路无限持续。

一个简化路由表：

| 前缀 | 下一跳 | 含义 |
| --- | --- | --- |
| `127.0.0.0/8` | 本机 | 回环网络 |
| `10.20.0.0/16` | 直连 | 本地私有网段 |
| `0.0.0.0/0` | 网关 | 无更具体匹配时使用 |

若目的地址是 `10.20.4.7`，`/16` 比默认 `/0` 更具体，因此走直连接口。路由只决定往哪里送，不验证数据内容，也不保证源地址没有被伪造。需要响应的协议通常还依赖返回路径和更高层握手来确认可达性。

## 5. TCP：可靠的是字节顺序，不是消息边界

TCP 用序列号、确认、重传和流量控制把不可靠的数据报抽象成有序字节流。发送端一次 `send` 的 100 字节，接收端可能通过多次 `recv` 得到；两次 `send` 也可能在一次 `recv` 中一起返回。

因此应用协议必须自行定义消息边界。常见方案有：

- 固定长度；
- 分隔符，例如一行一个消息；
- 长度前缀；
- 自描述格式，但仍需要外层长度或结束规则。

下面的示例只监听 `127.0.0.1`，由操作系统分配临时端口。它使用 4 字节大端长度前缀：

```python
# localhost_framing.py
import socket
import struct
import threading

HOST = "127.0.0.1"

def recv_exact(conn: socket.socket, size: int) -> bytes:
    chunks = []
    remaining = size
    while remaining:
        chunk = conn.recv(remaining)
        if not chunk:
            raise ConnectionError("stream ended early")
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)

def receive_frame(conn: socket.socket) -> bytes:
    header = recv_exact(conn, 4)
    length = struct.unpack("!I", header)[0]
    if length > 1024:
        raise ValueError("frame too large")
    return recv_exact(conn, length)

def send_frame(conn: socket.socket, data: bytes) -> None:
    conn.sendall(struct.pack("!I", len(data)) + data)

server = socket.socket()
server.bind((HOST, 0))
server.listen(1)
port = server.getsockname()[1]

def serve_once() -> None:
    conn, _ = server.accept()
    with conn:
        message = receive_frame(conn)
        print("server received:", message.decode())
        send_frame(conn, f"bytes={len(message)}".encode())
    server.close()

thread = threading.Thread(target=serve_once)
thread.start()

with socket.create_connection((HOST, port)) as client:
    send_frame(client, b"hello")
    print("client received:", receive_frame(client).decode())

thread.join()
```

预期输出：

```text
server received: hello
client received: bytes=5
```

线程输出在极少数环境中可能先后交换，但两行内容相同。示例中的安全要点是：

1. 只绑定回环地址，外部主机无法直接连接；
2. `recv_exact` 不假定一次读取就得到完整数据；
3. 在分配或读取正文前限制长度，防止不受控资源消耗；
4. 网络字节序 `!I` 让双方对整数表示达成一致。

它仍没有认证或加密，不能直接成为生产协议。

## 6. 被动观察、主动修改与重放

威胁能力需要分开描述：

| 能力 | 攻击者能做什么 | 仅加密是否足够 |
| --- | --- | --- |
| 被动观察 | 读取经过的明文与元数据 | 加密保护内容，但通常仍暴露端点和长度 |
| 主动修改 | 改字节、插入或删除数据 | 不够，还需要完整性认证 |
| 冒充端点 | 假装成服务或客户端 | 需要验证身份和密钥归属 |
| 重放 | 原样再次发送旧的合法消息 | 需要 nonce、序号、时间窗或幂等设计 |
| 阻断 | 丢包或断开连接 | 密码学通常不能保证可用性 |

这解释了为什么“把数据异或一下”不是安全信道：即使旁观者暂时看不懂内容，也没有可靠完整性、身份或重放保证。

## 7. 用 HMAC 看见“完整性”

以下代码只对玩具字节串做认证，不发送网络数据：

```python
# message_integrity.py
import hashlib
import hmac

KEY = b"local-demo-key-not-for-production"

def tag(message: bytes) -> bytes:
    return hmac.new(KEY, message, hashlib.sha256).digest()

def verify(message: bytes, supplied_tag: bytes) -> bool:
    expected = tag(message)
    return hmac.compare_digest(expected, supplied_tag)

original = b"transfer toy-coins: 5"
authenticator = tag(original)

print("original:", verify(original, authenticator))
print("changed: ", verify(b"transfer toy-coins: 8", authenticator))
```

预期输出：

```text
original: True
changed:  False
```

HMAC 证明“知道共享密钥的一方生成了这段消息，且消息未被更改”。它不隐藏内容，也不能区分共享同一密钥的多个成员，更不能自动阻止重放。真实协议还要规定密钥生成与轮换、消息序号、版本、算法协商和失败处理。

不要使用普通 `hash(key + message)` 自创 MAC；长度扩展、格式歧义等细节很容易破坏安全性。使用标准 HMAC 或成熟的 AEAD 协议。

## 8. TLS 建立了什么

TLS 通常在 TCP 之上提供：

1. **协商参数**：双方选择共同支持的协议版本和算法；
2. **密钥交换**：建立会话密钥，现代配置通常提供前向保密；
3. **服务端认证**：客户端验证证书链、主机名和有效期；
4. **记录保护**：后续应用数据同时加密并认证。

如果客户端关闭证书验证，连接可能仍“显示加密”，但加密对象可能是冒充者。只验证证书链却不验证主机名同样不足，因为一张给其他域名的合法证书不应代表目标服务。

生产系统应优先使用维护良好的 TLS 库和安全默认值：

- 不自创握手或加密记录格式；
- 不忽略证书错误；
- 不把 bearer token 放入明文协议；
- 给敏感客户端密钥设置合适的存储与轮换；
- 对极高风险接口考虑双向 TLS，但仍保留应用授权。

## 9. 应用层身份与端到端原则

TLS 认证的是证书对应的端点，应用会话认证的是用户或服务身份。二者互补：

```text
TCP：字节可靠到达某个 socket
TLS：这个 socket 对端持有目标证书对应的私钥
登录/session：当前操作代表某个应用用户
授权：该用户能否执行这次具体动作
```

反向代理、负载均衡和服务网格会增加终止点。必须明确 TLS 在哪里终止、代理到后端是否再次加密、客户端真实地址首部由谁可信地写入。绝不能无条件相信外部请求自带的 `X-Forwarded-For`。

## 10. 安全观察与排障

只在自己拥有或明确获准的本地环境观察通信。对于上面的 localhost 示例，可以使用：

```bash
ss -ltn
ss -tn
```

输出会随端口和时间变化，可能看到 `127.0.0.1:<临时端口>`。这些命令显示 socket 状态，不会读取别人的应用内容。

排障时按层提问：

1. 名称解析得到哪个 IP？
2. 路由表选择哪个接口和下一跳？
3. 邻居映射是否存在？
4. TCP 是否建立、重传或被重置？
5. TLS 证书与主机名验证是否成功？
6. 应用协议分帧、版本和认证是否一致？

直接把所有失败称为“网络不通”会掩盖真正边界。

## 11. 常见误区

- **“TCP 保证一发一收。”** TCP 只保证有序字节流，应用必须分帧。
- **“内网流量不需要加密。”** 内网仍有错误配置、恶意终端、代理和横向移动风险。
- **“HTTPS 隐藏所有信息。”** IP、端口、时序、包长和部分握手元数据仍可能可见。
- **“证书错误点继续就好。”** 继续意味着放弃对端身份保证。
- **“有 HMAC 就保密。”** HMAC 只提供完整性与共享密钥持有证明。
- **“随机 nonce 等于秘密。”** nonce 重点是唯一或不可预测，具体要求取决于协议；它通常可以公开。
- **“抓到包就等于能修改包。”** 被动观察与主动介入是不同能力。

## 12. 纸面练习与答案

### 练习一：下一跳

主机 `10.0.1.5/24` 向远端 `203.0.113.8` 发送数据，默认网关是 `10.0.1.1`。Ethernet 目的 MAC 和 IP 目的地址分别属于谁？

#### 答案

本地 Ethernet 帧的目的 MAC 属于默认网关 `10.0.1.1`；IP 数据报的目的地址仍是远端 `203.0.113.8`。路由器收到帧后继续转发 IP 数据报。

### 练习二：消息边界

客户端连续 `send` 两个 JSON 对象，服务端一次 `recv`。为什么不能假定只得到第一个对象？

#### 答案

TCP 不保留发送调用边界。一次 `recv` 可能得到半个对象、一个对象或多个对象。协议必须使用长度前缀、明确分隔符或其他可验证的分帧方法，并处理部分读取。

### 练习三：加密但未认证

某自制协议只把消息与密钥流异或，没有 MAC。旁观者看不懂明文，这是否足够？

#### 答案

不足。攻击者可能在不知道明文的情况下翻转密文字节，使解密后的对应位改变；协议也没有可靠端点认证和重放防护。应使用标准 AEAD 和经过分析的握手协议。

### 练习四：代理边界

公网客户端可以自行设置 `X-Forwarded-For: 127.0.0.1`，后端据此授予管理员权限。根因是什么？

#### 答案

后端把不可信客户端字段当成受信代理产生的身份信息。应由边界代理删除外部同名首部并重新写入，后端只接受来自受信代理网络的元数据；更根本地，管理员权限不应仅由源 IP 决定。

## 小结

网络分层把复杂通信拆成链路交付、路由、可靠字节流和应用语义，但低层可达性不会自动产生高层身份。安全信道必须同时考虑机密性、完整性、端点认证和重放；应用还要独立完成用户认证与授权。

---

[← 上一篇：Web 安全](./01-web-security.md) · [本节索引](./README.md) · [下一篇：密码学 →](./03-cryptography.md)
