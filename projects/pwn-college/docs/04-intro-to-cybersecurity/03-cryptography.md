# 03 · 密码学：先说清安全目标，再选择原语

> 对应官方模块：[Cryptography](https://pwn.college/intro-to-cybersecurity/cryptography/)

## 学习目标

读完本章，你应当能够：

- 区分编码、哈希、加密、MAC、签名和密钥交换；
- 解释对称加密为何还需要完整性认证和 nonce 管理；
- 从攻击者能力出发选择安全性质，而不是只选择算法名称；
- 说明 Diffie–Hellman 如何协商共享秘密，以及为什么仍需认证；
- 正确描述密码存储、随机数、密钥生命周期与证书信任。

## 1. 六类操作解决六类问题

| 操作 | 是否需要秘密 | 能否恢复原文 | 主要目的 |
| --- | --- | --- | --- |
| 编码 | 否 | 是 | 表示与传输，例如 UTF-8、Base64 |
| 哈希 | 否 | 否（设计目标） | 固定长度摘要、完整性指纹 |
| 对称加密 | 共享密钥 | 是 | 机密性 |
| MAC | 共享密钥 | 不适用 | 完整性与共享密钥持有证明 |
| 数字签名 | 私钥签名、公钥验证 | 不适用 | 完整性、签名者身份与公开验证 |
| 密钥交换 | 各方秘密材料 | 产生共享秘密 | 在不直接传送会话密钥时协商密钥 |

最常见的概念错误是把 Base64 当作加密。任何人都能解码 Base64，因为没有秘密参与：

```python
import base64

encoded = base64.b64encode("本地玩具数据".encode("utf-8"))
decoded = base64.b64decode(encoded).decode("utf-8")

print(encoded.decode("ascii"))
print(decoded)
```

预期输出：

```text
5pys5Zyw546p5YW35pWw5o2u
本地玩具数据
```

编码解决“字节怎样装进某种文本协议”，不提供保密性。

## 2. 密码系统从威胁模型开始

在选择算法前，先回答：

1. 保护的资产是什么：消息内容、身份、密钥还是历史记录？
2. 攻击者能否只观察，还是能修改、重放和选择输入？
3. 哪些端点可信，端点被攻陷后是否要求保护过去的会话？
4. 密钥由谁生成、存在哪里、如何轮换与撤销？
5. 失败时系统是拒绝、重试，还是悄悄降级？

算法名称只是设计的一部分。使用 AES 却重用 nonce、使用 TLS 却关闭证书验证、使用强哈希却没有密码专用 KDF，都可能让系统失去目标安全性质。

经典原则是：系统的安全性应依赖密钥保密，而不是算法或代码保密。公开、经过长期分析的标准算法通常比自创“别人看不懂”的变换可靠。

## 3. 哈希：摘要不是加密

密码学哈希函数把任意长度输入映射到固定长度摘要，并追求：

- 难以从摘要恢复输入（原像抗性）；
- 难以找出另一个输入产生同一摘要（二次原像抗性）；
- 难以找到任意一对碰撞输入（碰撞抗性）。

```python
# hash_demo.py
import hashlib

for message in (b"local note A", b"local note B"):
    digest = hashlib.sha256(message).hexdigest()
    print(message.decode(), digest[:16])
```

预期输出：

```text
local note A f3f73e82f03da3d8
local note B 3cc8a795307eeda1
```

只改一个字符，摘要前缀已经完全不同。但普通哈希没有秘密，任何人都能为修改后的消息重新计算摘要，因此它本身不能证明消息来自某个授权发送者。

下载页面公布软件摘要的价值依赖于“摘要通过另一条可信渠道发布”。若攻击者能同时替换文件和页面上的摘要，校验就失去意义。

## 4. 对称加密与 nonce

对称加密双方持有同一密钥。现代应用通常应使用 AEAD（Authenticated Encryption with Associated Data），例如 AES-GCM 或 ChaCha20-Poly1305。AEAD 同时提供：

- 密文机密性；
- 密文和关联数据的完整性；
- 对篡改的明确拒绝。

关联数据不被加密，但会被认证，适合放协议版本、消息类型或不可隐藏的路由标识。

许多 AEAD 要求同一密钥下 nonce 唯一。nonce 通常不需要保密，但错误重用可能泄露明文关系，甚至破坏认证。

下面用异或流的纯玩具模型说明“重用密钥流”为什么危险；它不是可部署的加密实现：

```python
# toy_keystream_reuse.py
def xor_bytes(left: bytes, right: bytes) -> bytes:
    return bytes(a ^ b for a, b in zip(left, right))

message_a = b"amount=10"
message_b = b"amount=90"
toy_stream = bytes.fromhex("102030405060708090")

cipher_a = xor_bytes(message_a, toy_stream)
cipher_b = xor_bytes(message_b, toy_stream)

print(xor_bytes(cipher_a, cipher_b) == xor_bytes(message_a, message_b))
print(xor_bytes(cipher_a, cipher_b).hex())
```

预期输出：

```text
True
000000000000000800
```

两份密文相异或后，重复的密钥流被消掉，直接暴露两份明文之间的差异。流加密或基于计数器的模式必须严格遵守 nonce 规则。不要直接使用裸 AES-ECB、手写 CBC 填充或自制异或方案。

## 5. MAC：带密钥的完整性

消息认证码让持有共享密钥的一方生成标签，另一方验证。HMAC 是成熟组合：

```python
# hmac_demo.py
import hashlib
import hmac

KEY = b"toy-shared-key"

def sign(message: bytes) -> str:
    return hmac.new(KEY, message, hashlib.sha256).hexdigest()

message = b"role=reader"
tag = sign(message)

print(hmac.compare_digest(tag, sign(message)))
print(hmac.compare_digest(tag, sign(b"role=editor")))
```

预期输出：

```text
True
False
```

验证时使用 `compare_digest`，避免普通字符串比较可能产生的时序差异。真实协议还必须把字段编码成唯一形式，否则不同字段组合可能产生同一字节串。例如，不带长度地连接 `("ab", "c")` 与 `("a", "bc")` 都得到 `abc`。可以使用规范 JSON、长度前缀或成熟序列化格式。

MAC 的所有验证者都持有同一秘密，所以任何验证者也能生成标签；它不提供对第三方可证明的签名归属。

## 6. 数字签名：私钥签，公钥验

数字签名使用非对称密钥：私钥生成签名，公钥验证。它适合软件更新、证书、审计记录等需要公开验证的场景。

重要边界包括：

- 公钥必须通过可信方式绑定到身份；
- 签名覆盖的字节必须有明确、唯一的编码；
- 验证必须固定算法和参数，避免算法降级或混淆；
- 私钥泄漏后需要轮换和撤销机制；
- “签名有效”只说明被签字节未变且对应私钥参与，不说明内容本身正确。

不要把签名简单描述为“用私钥加密哈希”。不同签名方案的数学结构、安全证明和编码规则不同，生产代码应直接调用成熟库的高层 API。

## 7. Diffie–Hellman：协商秘密，但不会自动认证身份

下面使用极小整数展示机制。参数故意不安全，只适合纸面教学：

```python
# toy_dh.py
p = 23
g = 5

alice_secret = 6
bob_secret = 15

alice_public = pow(g, alice_secret, p)
bob_public = pow(g, bob_secret, p)

alice_shared = pow(bob_public, alice_secret, p)
bob_shared = pow(alice_public, bob_secret, p)

print("public:", alice_public, bob_public)
print("shared:", alice_shared, bob_shared)
print("equal:", alice_shared == bob_shared)
```

预期输出：

```text
public: 8 19
shared: 2 2
equal: True
```

双方公开交换 `8` 和 `19`，各自结合自己的秘密得到相同结果。真实系统使用巨大且经过选择的群或椭圆曲线，并通过 KDF 从共享结果派生不同用途的密钥。

纯 Diffie–Hellman 不知道对方是谁。一个主动中间者可分别与双方协商不同秘密。TLS 通过证书签名等机制把握手与服务身份绑定。结论是：

```text
密钥交换解决“怎样得到共同秘密”
认证解决“这个秘密是与谁共同得到的”
```

## 8. 密码存储：慢、带盐、可升级

登录系统通常不需要恢复用户密码，因此应保存密码专用 KDF 的结果，而不是可逆加密或快速普通哈希。

```python
# password_kdf.py
import hashlib
import hmac

SALT = b"fixed-demo-salt"  # 仅为得到可复现输出；生产中每个账户随机生成

def derive(password: str) -> bytes:
    return hashlib.scrypt(
        password.encode("utf-8"),
        salt=SALT,
        n=2**14,
        r=8,
        p=1,
        dklen=32,
    )

stored = derive("correct horse")
print(hmac.compare_digest(stored, derive("correct horse")))
print(hmac.compare_digest(stored, derive("wrong horse")))
```

预期输出：

```text
True
False
```

生产系统应为每个密码生成独立随机盐，并随记录保存算法和成本参数，以便未来升级。盐不需要保密，它阻止预计算表跨账户复用；pepper 是另一个可选的服务器秘密，应存放在数据库之外。常用方案包括 Argon2id、scrypt、bcrypt 和合适参数的 PBKDF2。

快速哈希适合大文件校验，却让攻击者每秒尝试更多候选密码，因此不适合直接保存密码。

## 9. 安全随机数与密钥生命周期

密码学密钥、会话 token 和 nonce 应使用操作系统的密码学安全随机源。在 Python 中使用 `secrets`，不要用用于模拟的 `random`：

```python
import secrets

token = secrets.token_urlsafe(24)
print(len(token) >= 32)
```

预期输出：

```text
True
```

token 的实际字符每次不同。熵之外，还要管理完整生命周期：

```text
生成 -> 分发 -> 存储 -> 使用范围 -> 轮换 -> 撤销 -> 销毁 -> 审计
```

常见工程原则：

- 不把密钥提交到源码仓库或写进客户端程序；
- 为不同用途派生不同密钥，避免“一把钥匙走天下”；
- 给密钥版本号，让轮换期间能区分新旧数据；
- 日志中不要打印密钥、明文密码或完整 bearer token；
- 端点被攻陷时，明确哪些历史会话仍受前向保密保护。

## 10. 证书与信任链

证书把公钥、域名、有效期等信息交给签发者签名。浏览器从受信根证书开始验证签名链，并检查：

1. 每级签名是否有效；
2. 当前时间是否在有效期内；
3. 目标主机名是否匹配 SAN；
4. 用途与密钥用法是否允许；
5. 是否符合本地策略以及必要的撤销信息。

信任根是策略选择，不是数学自动产生的事实。组织内部 CA、证书固定和公有 CA 各有运维权衡。固定证书或公钥若没有备用与轮换计划，证书正常更新时可能导致整个客户端群体失联。

## 11. 组合原语时的安全与防御检查表

| 问题 | 推荐思路 |
| --- | --- |
| 本地数据需要保密且防篡改 | 标准 AEAD；安全保存密钥；唯一 nonce |
| 两个服务共享秘密并认证消息 | TLS，或标准 HMAC 协议加明确重放保护 |
| 软件发布供所有人验证 | 数字签名；可信分发公钥；版本与回滚策略 |
| 保存登录密码 | Argon2id/scrypt/bcrypt/PBKDF2；每账户随机盐 |
| 生成会话 token | CSPRNG；足够熵；短生命周期；服务端撤销 |
| 比较认证标签 | 常量时间比较；失败统一处理 |

“加密后再 MAC”之类低层组合有严格顺序和编码要求。现代系统优先使用经过分析的 AEAD 与协议库，而不是自行组合裸原语。

## 12. 安全与伦理边界

- 本章中的小整数 DH、固定盐和固定玩具密钥只用于可复现推导，绝不能部署；
- 不要尝试解密不属于自己的流量、文件或账户数据；
- 密码恢复测试只应针对自己生成的玩具哈希或有明确授权的审计范围；
- 真实密钥一旦误入终端记录、日志或版本库，应视为泄漏并轮换，而不是只删除文件。

## 13. 常见误区

- **“Base64 看不懂，所以是加密。”** 它是公开可逆编码。
- **“哈希能验证发送者。”** 无密钥哈希任何人都能重算。
- **“用了 AES 就安全。”** 模式、nonce、认证、密钥管理和错误处理同样重要。
- **“nonce 必须保密。”** 多数方案要求唯一或不可预测，具体条件由算法决定；它通常随密文公开。
- **“共享密钥 MAC 等于数字签名。”** 每个验证者也能伪造 MAC，无法向第三方区分生成者。
- **“证书合法就一定是目标网站。”** 还必须验证主机名和用途。
- **“盐是秘密。”** 盐通常公开且按账户唯一；它与可选的秘密 pepper 不同。
- **“自己发明的算法没人知道。”** 隐藏算法不能替代经过公开分析的密码设计。

## 14. 纸面练习与答案

### 练习一：文件下载

下载站在同一 HTTP 页面同时提供文件和 SHA-256 值。攻击者可以修改这两个响应。摘要是否能证明文件未被攻击者替换？

#### 答案

不能。攻击者可替换文件并为新文件重算摘要。摘要必须通过攻击者无法同时控制的可信渠道获得，或使用发行方数字签名并可信地分发验证公钥。

### 练习二：消息认证

两个服务共享 HMAC 密钥。服务 A 收到一条标签有效的消息，能否向独立第三方证明一定是服务 B 发出的？

#### 答案

不能。A 自己也持有同一密钥，理论上同样能生成该标签。HMAC 适合共享密钥成员间认证，不提供数字签名式的公开不可否认性。

### 练习三：密钥交换

Alice 与 Bob 完成了未认证的 Diffie–Hellman，并得到相同会话密钥。他们能否据此确定没有中间者？

#### 答案

不能。若公共值未绑定到身份，主动中间者可分别与两端交换密钥。必须使用证书签名、预共享认证密钥或其他认证机制保护握手 transcript。

### 练习四：密码数据库

两名用户选择相同密码。若每个账户使用不同随机盐，数据库中的派生值通常是否相同？这有什么价值？

#### 答案

通常不同。独立盐阻止攻击者直接看出相同密码，并使针对一个盐的预计算结果无法跨所有账户复用；它不提高单个弱密码本身的熵，所以仍需合适 KDF 成本和密码策略。

### 练习五：重放

一条 AEAD 保护的“支付 5 个玩具币”消息被完整记录并原样发送第二次，标签仍然有效。系统缺少什么？

#### 答案

缺少应用层重放防护。应把单调序号、唯一请求 ID、时间窗或业务幂等键纳入被认证数据，并记录已处理状态。机密性和完整性不会自动产生“只执行一次”。

## 小结

密码学设计的顺序应是“威胁模型—安全性质—标准协议—密钥生命周期—验证测试”。编码不保密、哈希不认证、加密不一定防篡改、密钥交换不自动确认身份。只有把这些边界说清楚，算法才会在系统中真正提供预期保护。

---

[← 上一篇：通信拦截](./02-intercepting-communication.md) · [本节索引](./README.md) · [下一篇：访问控制 →](./04-access-control.md)
