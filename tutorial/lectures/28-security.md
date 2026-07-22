# 第 28 讲：计算机安全简介

> 原始讲义：[sources/notes/lect28.md](../../sources/notes/lect28.md)  
> 前一讲：[数据库系统](27-databases.md) · 后一讲：[虚拟机和容器](29-vm-containers.md)  
> 配套示例：[constant_time_compare.c](../../examples/constant_time_compare.c)

> 安全与伦理边界：本章只在自己创建的临时目录、自己编译的教学程序和只读系统接口上实验。不要对他人的账户、进程、主机、无线电信号、软件仓库或服务做探测；不要运行 PPT 中的 fork bomb，也不要把故意含漏洞的代码部署到真实环境。

## 0. 本讲定位：数据正确之后，谁有权看到和改变它？

上一讲从文件系统走到数据库，用 transaction、constraint、WAL 和 concurrency control 保证应用状态在并发与 crash 后仍满足 invariant。
但数据库能正确提交一笔转账，并不等于这笔转账获得了授权：

```text
数据库问题：两个账户余额的更新是否 atomic、durable、isolated？
安全问题：发起者是谁？是否有权转账？密钥是否泄漏？
          能否伪造请求？能否让服务耗尽资源？
```

安全把课程里所有抽象重新放到 adversarial environment：攻击者会选择最坏输入、并发时机、系统调用序列、缓存状态、依赖版本，甚至物理条件。
“正常使用时正确”不够；系统还要在明确的 attacker capability 下维持承诺。

本讲依次沿 PPT 的四条线推进：

```text
历史上的无隔离机器
  → CIA 与密码学提供的安全性质
  → 身份、访问控制矩阵与 UNIX 凭据
  → 意外路径、内存破坏、ROP 与多层缓解
  → timing/cache/电磁/物理侧信道
  → Agent 工具权限与软件供应链信任
```

下一讲研究虚拟机与容器：它们把本讲的 least privilege、attack surface 和 isolation boundary 变成可部署的系统机制。

---

## 1. 学习目标与安全问题地图

完成本讲后，你应当能够：

1. 用 asset、principal、threat actor、entry point、trust boundary 描述 threat model；
2. 分别解释 confidentiality、integrity、availability，避免把“加密”当作安全的同义词；
3. 区分 hash、MAC、digital signature、public-key encryption、password KDF 和 distributed consensus；
4. 从 access control matrix 推导 UNIX mode、ACL、capability、MAC 和 seccomp 的不同切片；
5. 区分 authentication 与 authorization，以及 real/effective/saved/filesystem UID；
6. 解释 set-user-ID、Linux capabilities、file descriptor delegation 和 least privilege 的边界；
7. 从 unchecked write 推导 stack corruption、control-flow hijack 与 ROP，但不把教学原理变成现实利用指南；
8. 说明 stack canary、ASLR/PIE、NX、CFI/CET、sandbox 分别阻断哪一步，以及为什么都不完整；
9. 解释 timing/cache/transient execution、电磁辐射和 cold boot 如何绕过“合法输出”边界；
10. 为 tool-using Agent 设计 authority separation、approval、sandbox、secret handling 和 audit；
11. 从 source、build、dependency、registry、artifact provenance 分析供应链攻击。

### 1.1 安全论证的最小五元组

一句“系统是安全的”没有可检验含义。至少要写出：

| 元素 | 要问的问题 | 教务系统例子 |
|---|---|---|
| asset | 要保护什么？价值和生命周期是什么？ | 试卷、成绩、账号 credential、availability |
| principal | 谁可以请求操作？如何稳定标识？ | 学生、教师、教务员、service account |
| threat actor/capability | 对手能控制哪些输入、时间、机器或依赖？ | 普通登录用户、恶意网页、被攻陷 dependency maintainer |
| policy | 哪个 principal 在什么条件下能对哪个 object 做什么？ | 任课教师在提交窗口内录入本班成绩 |
| mechanism | 哪层怎样 enforce policy，失败时如何 fail closed？ | session authentication、DB row policy、kernel UID、audit |

还应明确 trust assumptions：相信 CPU 正确执行 privilege check 吗？相信 kernel、compiler、CI runner、package registry、管理员和物理机房中的谁？
可信计算基（TCB）越大，必须同时正确且未被攻破的部分越多。

### 1.2 Policy 与 mechanism 不可混为一谈

“教师能改自己课程成绩”是 policy；UID/mode、SQL `GRANT`、SELinux label、签名验证是 mechanisms。
同一 mechanism 可实施不同 policy，同一 policy 也常需多层 mechanism。

mechanism 不能替 policy 作业务判断：进程 euid 是教师账号，并不证明目标课程属于他；数据库角色允许 `UPDATE`，也不证明这次 change 经双人复核。
反过来，只有文档中的 policy 而没有不可绕过的 enforcement，也只是愿望。

### 1.3 Authentication、authorization、accounting

- authentication（认证）：当前 caller 是谁，或控制了什么 credential？
- authorization（授权）：这个已识别 principal 是否能执行当前 operation？
- accounting/auditing（记账/审计）：谁在何时请求了什么、结果如何，记录能否抵赖或篡改？

password、SSH key、passkey 或 client certificate 解决认证的一部分；它们不直接定义文件、数据库 row 或 tool call 的权限。
审计也不是授权：记录“越权修改已发生”不能恢复 integrity，只能帮助检测、追责和 recovery。

---

## 2. 回到美好的 “裸奔” 时代

### 2.1 8086 real mode：地址隔离尚未成为 PC 的默认抽象

PPT 从 8086 real mode 开始。经典 physical address 近似为：

```text
physical = (segment << 4) + offset
```

16-bit segment 与 16-bit offset 形成 20-bit 地址，通常描述为 1 MiB address space；不同 `segment:offset` 可指向同一 physical address。
后来的 A20 gate 又让边界行为多了一层历史兼容性。

real mode 没有今天 process page table 意义上的 per-process address space，也没有 ring-based memory protection 为每个 application 隔离 RAM。
firmware service 与 interrupt vector table 都在共同 physical memory 中。

PPT 把：

```asm
int $x
```

类比成从 `4*x` 取一个函数指针再调用，很适合建立直觉：8086 interrupt vector table 每项 4 bytes，保存 offset 与 segment；CPU 据此转移，而不是进入一个由现代 syscall ABI 隔离的 kernel object。
精确地说，它不是 C function pointer，也会保存 flags/return state；BIOS interrupt 只是当时一类 firmware interface。

### 2.2 “没有安全”是 threat model 的结论

在这种单机、单用户、共同地址空间和直接硬件访问的模型里，任意 native program 基本被授予整台机器：

- 可读写其他 program/data；
- 可直接控制 device/interrupt；
- 可修改持久介质与启动路径；
- 一个 memory bug 的 blast radius 就是全系统。

这并不表示历史上所有计算机都没有 protection；mainframe/multi-user systems 很早就发展了 privilege 与 memory protection。
这里讨论的是早期 commodity PC 的默认 trust model：用户运行的软件被视作可信扩展，而非潜在敌手。

### 2.3 病毒与 CIH 案例

当 executable 可以改写其他 executable、boot data 或 hardware-facing state，自我复制代码便能在共享软件介质上传播。
“加壳”会改变/包裹 binary representation 以隐藏 payload 或增加分析成本，但不是病毒的必要定义。

PPT 提到 CIH，意在说明 integrity failure 不止“某个文件坏了”：在当时硬件/OS 条件下，恶意程序可破坏磁盘数据，并在部分机器上影响 flash BIOS，使 availability 也受损。
本章不复现 malware，也不提供感染或 firmware modification 步骤；要学习的是 authority 过大导致的 blast radius。

### 2.4 BBS 的“裸奔”是社会信任边界

南京大学小百合和仍存在的水木社区代表早期网络社区：系统规模、用户关系和威胁预期与今天全球互联网服务不同。
很多服务依赖实名社区、管理员人工处置和“大家不会恶意使用”的社会约束。

社会约束可以是风险管理的一部分，却不能替代技术边界。
一旦 principal 扩大、自动化增强、资产升值或攻击者能远程批量尝试，原有隐含假设就会失效。

---

## 3. 保密性 Confidentiality

### 3.1 定义不是“文件加密了”

Confidentiality 要求 information 只向 authorized principals disclosure。
对象可以是 file contents，也可以是：

- filename、访问时间和通信对象等 metadata；
- database query result；
- memory 中的 key；
- screen pixels、CPU cache footprint、response time；
- backup、log、core dump 和 telemetry。

因此“disk encrypted”只保护特定 at-rest threat model。
机器已解锁、process 有 decryption key、日志复制了 plaintext，或 side channel 泄漏时，confidentiality 仍可能失败。

### 3.2 PPT 的“快速格式化”反例

quick format 往往只重建 filesystem metadata，并不保证覆盖所有 data blocks。
从 namespace 中看不到文件，不等于 storage 上不可恢复；delete、unlink 与 secure erasure 是不同 specification。

现代 SSD 的 flash translation layer、wear leveling、snapshot/backup 又让“覆盖同一 logical block”不等于擦除所有 physical copies。
若 asset 的 threat model 包括设备转售或物理取证，应在数据产生前使用完整 device encryption，并管理 key destruction、backup 和 hardware sanitize policy，而不是事后依赖普通删除。

### 3.3 Confidentiality 的完整链条

```text
identify caller
  → authorize read
  → constrain process/address space
  → protect data at rest and in transit
  → keep keys/secrets out of logs and lower-trust components
  → limit side channels and residual copies
```

任一环断裂都会泄漏。
“只有管理员能读”还需问管理员 account 是否过宽、service 是否会回显、backup operator 是否能读、key 是否与 ciphertext 放在一起。

---

## 4. 完整性 Integrity

Integrity 是防止 unauthorized modification、deletion、fabrication 和 replay，并能在需要时验证来源与顺序。
它保护的不只是 bytes：

- 成绩与余额的值；
- executable/control flow；
- access-control policy；
- build artifact 与 dependency graph；
- audit log 的完整性；
- “这条命令由谁批准”的 provenance。

PPT 用“入侵教师邮箱拿考卷、改成绩”的极端故事提醒：攻破 authentication endpoint 可能继承其全部 downstream authority。
数据库 ACID 可以把未经授权的修改完美、持久、原子地写入；这恰好说明 consistency 不等于 security integrity。

### 4.1 完整性常需要来源和 freshness

hash 可发现随机/恶意内容变化，但若 attacker 能同时替换文件与 hash，验证毫无意义。
MAC 需要共享 secret；digital signature 用 private key 产生证明、public key 验证。
二者仍需可信 key binding，并处理 version、nonce/counter/timestamp，否则旧的合法 message 可被 replay。

例如“转账 100 元”的有效签名若能重复提交，cryptographic verification 全部成功，业务 integrity 仍失败。

---

## 5. 可用性 Availability

Availability 是 authorized users 在承诺的时间和质量范围内获得服务。
它必须带 service-level specification：无限资源下“永远在线”不可实现。

攻击面包括：

- 带宽/connection flood；
- CPU、memory、fd、process、disk-space exhaustion；
- lock contention/deadlock；
- dependency/DNS/identity provider failure；
- 删除 data 或 key 导致不可恢复；
- 触发 worst-case algorithmic complexity。

PPT 展示 fork bomb 是 resource exhaustion 的最短反例。**不要运行它**：即使在 shell 中只有几个字符，也能指数式创建 process，导致同机用户无法 fork/login。
安全学习应使用 resource model、代码审查和隔离实验环境，而不是在共享系统验证破坏效果。

### 5.1 Hash table complexity DoS

若 attacker 能构造大量 collision，某些 hash table 的一次平均 `O(1)` operation 会退化，插入 n 项的总成本可能从近似 `O(n)` 上升到 `O(n²)`。
攻击者以很低输入 bandwidth 换取 server 大量 CPU，这就是 asymmetric cost。

Crosby 与 Wallach 的 [algorithmic complexity attack 原始论文](https://www.usenix.org/conference/12th-usenix-security-symposium/denial-service-algorithmic-complexity-attacks)展示了这种低带宽 DoS。
工程防御可能包括 keyed/randomized hash、worst-case-bounded structure、input/size limit、per-principal quota、timeout 和 backpressure；只扩容不能消除不对称。

### 5.2 Availability 与访问控制并不等价

拒绝非法 syscall 有帮助，但公平 scheduler、cgroup/rlimit、rate limit、admission control、replication、backup/restore 和 overload shedding 都属于 availability mechanism。
授权用户也可能因 bug 或被盗 credential 发出灾难性请求，所以 resource policy 不能只分“登录/未登录”。

---

## 6. 一分钟密码学

PPT 用 one-way function 与 trapdoor one-way function 建立直觉；真实 cryptographic construction 需要更精确的接口和安全定义。

### 6.1 Hash：容易正算，不应轻易逆推

cryptographic hash：

```text
H : arbitrary-length bytes → fixed-length digest
```

常见目标包括 preimage resistance、second-preimage resistance 和 collision resistance，它们不是同一个性质。
SHA-256 的输出“像随机”是设计目标下的有用直觉，不表示它是真随机 function，也不表示 `SHA256(password)` 是合格的密码存储。

password storage 需要 unique salt 和专用、可调成本的 password hashing/KDF；普通 fast hash 恰好方便离线猜测。
hash 也不提供 authenticity：任何人都能重算未加 key 的 digest。

### 6.2 Public-key encryption

更准确的抽象是：

```text
(pk, sk) ← KeyGen()
c        ← Encrypt(pk, message; randomness)
message  ← Decrypt(sk, c)
```

Bob 用 Alice 的 authentic public key 加密，Alice 用 private key 解密。
这只描述 confidentiality primitive；production protocol 还要 authentication、message integrity、nonce/randomness、key rotation 和 downgrade/replay protection。
通常使用经过审查的 hybrid authenticated-encryption protocol，而不是直接“用 trapdoor function 算消息”。

### 6.3 Digital signature 不是“把加密倒过来”

```text
(pk, sk) ← KeyGen()
sig      ← Sign(sk, message)
ok       ← Verify(pk, message, sig)
```

signature 让 verifier 检查 message 是否被改动以及 signer 是否控制 corresponding private key。
[NIST FIPS 186-5](https://csrc.nist.gov/pubs/fips/186-5/final)定义了批准的 digital-signature algorithms。

PPT 用 challenge `c` 与 trapdoor 求 preimage `r` 表达“只有 secret holder 能产生、其他人能验证”的核心思想；但真实 signature scheme 不是任意 trapdoor function 反向使用。
textbook RSA、自己拼 hash/encoding 或复用 nonce 都可能完全破坏安全性，应使用高层 cryptographic library 与标准 protocol。

### 6.4 原语与安全目标的对应关系

| 原语 | 典型目标 | 不自动提供 |
|---|---|---|
| hash | content fingerprint、commitment building block | 身份、保密、抗 replay |
| MAC | 共享密钥双方间 integrity/authenticity | public verifiability、保密 |
| signature | public verification 的 integrity/origin | message confidentiality、key legitimacy |
| encryption | confidentiality | authenticity，除非用 AEAD/protocol 组合 |
| password KDF | 提高离线猜测成本 | 弱密码变强、online rate limiting |

最难的往往不是公式，而是 key generation、storage、distribution、revocation 和 recovery。

---

## 7. 应用：区块链

### 7.1 一个 replicated、tamper-evident log

PPT 用“狗随机扔骨头、花计算去找”的故事解释 Bitcoin proof-of-work：参与者反复尝试 nonce，使 block hash 满足难度条件；验证远比生成便宜。

最小结构是：

```text
block_i = data_i + hash(block_{i-1}) + consensus metadata
```

改变旧 block 会改变其 hash，并要求重做其后工作；digital signatures 证明 transaction authorization，hash/Merkle structure 组织验证，consensus rule 在 competing histories 中选择状态。
[Bitcoin 原始论文](https://bitcoin.org/en/bitcoin-paper.html)给出了 hash-based proof-of-work chain 的原始设计。

“append-only”不是物理上绝对不可改，而是 tampering cost 与 consensus/finality 的性质。
短期 fork/reorganization 可能发生；等待更多 confirmations 是用 latency 换更低 reversal probability。

### 7.2 低效来自 threat model

在互不信任且 permissionless 的 participants 间达成 consensus，需要 Sybil resistance、replication 和 incentive；PoW 故意让 proposal 昂贵。
这不是所有 append-only log 都应采用的设计：若组织已有可信 operator，数据库 WAL、Raft/Paxos replicated log 或签名 transparency log 通常更直接高效。

也不能把“blockchain”与 PoW 永久绑定；例如当前 Ethereum 使用 proof-of-stake consensus，官方[共识机制说明](https://ethereum.org/developers/docs/consensus-mechanisms/)明确区分这些设计。

### 7.3 CIA 取舍

- integrity：hash linkage、signature 与 consensus 让 unauthorized history rewrite 困难；
- availability：多 replica 能容忍部分 node 离线，但 network partition、censorship、software bug 和资源攻击仍存在；
- confidentiality：public ledger 原生并不隐藏 transaction data，pseudonymity 也不等于 anonymity。

PPT 用“洗钱”和冷钱包助记词作带讽刺的 killer-application 案例。
技术上应提炼为两点：公开 permissionless transfer 会产生合法与非法用途；控制 seed/private key 往往意味着控制 asset，泄漏 mnemonic 的后果极大。
课堂中的具体人物传闻不是理解 consensus 的证据，本章不把未经可靠一手材料证实的轶闻当作事实。

---

## 8. 实现 Confidentiality 和 Integrity

### 8.1 进程与虚拟内存先划出 isolation domain

现代 OS 给每个 process 一个 virtual address space；page table permission 控制 user-mode read/write/execute。
process 不能仅凭普通 load/store 访问 kernel page 或另一 process 的 private mapping。

共享 OS objects 通常通过 syscall 获得或操作：open file、connect socket、attach shared memory、map device、send signal。
kernel 在这些边界验证 caller credentials、object policy 和 arguments。

这个论证有明确假设：

- CPU privilege/page protection 正确；
- kernel 与 driver 未被攻破；
- DMA/IOMMU 与 device policy 正确；
- microarchitectural/physical side channels 暂时排除；
- process 没有从 parent 继承过宽的 fd/capability。

后半讲会逐一削弱这些假设。

### 8.2 Reference monitor 的三个要求

理想 reference monitor 应：

1. complete mediation：每次 relevant access 都不可绕过检查；
2. tamper-resistant：被检查对象不能改写 monitor/policy；
3. small/verifiable：TCB 足够小，能分析和测试。

VFS permission check、LSM hook、seccomp filter、DB authorization middleware 都在做部分 reference-monitor 工作。
若先检查 pathname、稍后重新解析使用，就违反了对同一 object 的完整 mediation；若 privileged helper 可被环境变量劫持，monitor 本身就不可信。

### 8.3 Confidentiality、Integrity、Availability 的 enforcement

- 拒绝 unauthorized read，保护 confidentiality；
- 拒绝 unauthorized write/metadata change，保护 integrity；
- scheduler、quota、rate/resource isolation 约束相互干扰，支持 availability。

PPT 的“公平系统调用实现 → Availability”抓住了资源仲裁，但真实可用性还跨 network、storage、dependency、recovery 和 physical failure。

---

## 9. 访问控制原理：一张表

### 9.1 Access control matrix

把 subject/principal 放在行、object 放在列，每个 cell 保存 operation set：

| 主体 \ 对象 | `/etc/passwd` | `/tmp/hello.txt` | grade DB row |
|---|---|---|---|
| admin process | read/write | read/write | read/write |
| ordinary process | read | read/write if owner/mode permits | none |
| course teacher | read | read | update own course |

判定函数可写成：

```text
allow(subject, object, operation, context) → true / false
```

`context` 可能包含 time、network、tenant、process label、request purpose 和 previous approvals。
若 deny file access，Linux 常返回 `EACCES`；某些不允许的 privileged operation 返回 `EPERM`。PPT 写的 `EACCESS` 不是 POSIX errno 名称。

### 9.2 为什么表会爆炸

若有 S 个 subjects、O 个 objects、A 种 operations，概念空间近似 `S×O×A`，而且 subject/object 不断创建销毁。
直接存 dense matrix 既浪费，也难回答 inheritance、delegation、revocation 和 default policy。

真实系统用规则压缩：

- UNIX mode：把 subjects 压成 owner/group/other，把 operations 压成 rwx；
- ACL：围绕一个 object 存有权 principals，像 matrix 的列；
- capability list/token：围绕一个 subject/holder 存 object authority，像 matrix 的行；
- role-based access control：subject → role → permissions；
- label/MAC：用 subject/object labels 与 global rules 计算；
- attribute-based policy：把 context 纳入 predicate。

PPT 的“low-rank decomposition”是好问题：身份/role/object class 的 factorization 确实能压缩 policy，但安全规则通常包含例外、deny precedence、dynamic context，不能只用近似矩阵分解；误差就是越权或误拒。

### 9.3 Deny-by-default 与 delegation

安全默认应是未明确授权则拒绝，但 usability 需要 delegation：parent 把 fd 传给 child、service 给短期 token、user 授权 Agent 只读某个目录。
delegation 必须绑定 scope、expiry、audience 和 revocation/recovery；“继承 parent 全部权限”简单，却让 compromised child 获得巨大 blast radius。

---

## 10. UNIX: 用整数表示身份

UNIX 的基本压缩方案是 `uid`、`gid`、supplementary groups 与 inode mode bits。
kernel permission path 主要处理数字 credential，不需要知道字符串 username 的社会含义。

### 10.1 mode bits 不是三个简单开关

```text
owner: rwx   group: rwx   other: rwx
```

对 regular file：read 允许读 bytes，write 允许改内容，execute 允许作为程序执行。
对 directory：read 允许列名字，write 允许改 directory entries，execute/search 允许路径穿越与 lookup；“目录可读不可执行”可能列出名字却无法 `stat/open` child。

例：owner 只写、audit group 可读的 append pipeline 可设想为：

```text
owner class: write
group audit: read
other: none
```

但普通 owner 通常仍可 `chmod` 自己文件、truncate/replace，严格 tamper-resistant audit log 需要独立 writer service、MAC/append-only storage 或 remote log，不是一个奇特 mode 就完成。

### 10.2 UID 0 与 root 的精确边界

传统 UNIX 把 effective UID 0 视作 superuser，能绕过许多 discretionary checks。
Linux 从 2.2 起把传统 root privilege 拆成 per-thread capability sets，例如 `CAP_DAC_OVERRIDE`、`CAP_SETUID`、`CAP_NET_RAW`；所以“uid=0 可做一切”是历史近似，现实还受 capabilities、user namespace、LSM、seccomp、lockdown 和 mount policy 约束。

反过来，非零 euid 也可能持有 file/process capability，做特定 privileged operation。
详见 [`capabilities(7)`](https://man7.org/linux/man-pages/man7/capabilities.7.html)。

### 10.3 Inheritance 与 ambient authority

`fork` 创建的 child 继承 credentials、open file descriptors、environment、working directory 等大量 ambient state；`execve` 又按 setuid bits、file capabilities、`no_new_privs` 等规则变换 credentials。

已打开 fd 本身很像 capability：即使 pathname permission 随后改变，process 通常仍可通过 fd 操作已经授权的 object。
因此：

- 敏感 fd 创建时使用 `O_CLOEXEC`；
- spawn child 前关闭无关 fd；
- 不把“child 不知道 pathname”当安全边界；
- delegation fd 时按 object 和 operation 缩小 authority。

### 10.4 Android 的 app UID 思路

PPT 用 Android 举例：不同 app 进程以不同 Linux UID/sandbox 身份运行，使普通 kernel permission 成为 app isolation 的底层机制之一。
实际 Android 还叠加 SELinux、permission broker、Binder identity、user/profile 和 platform signing；“每 app 一个 UID”是重要骨架，不是完整 mobile security model。

---

## 11. /etc/passwd: 每行一个用户

### 11.1 名字是用户态解释，kernel authorization 使用数字凭据

传统 `/etc/passwd` 每行七个 colon-separated fields：

```text
name:password:UID:GID:GECOS:home:shell
```

例如 `ls -l` 显示 owner name 时，工具把 inode 中的 numeric uid 通过 account database 映射成字符串。
kernel 的 inode permission check 不需要先读取用户名；它比较 process credentials 与 inode uid/gid/mode/ACL/LSM state。

[`passwd(5)`](https://man7.org/linux/man-pages/man5/passwd.5.html)说明 `/etc/passwd` 通常可供所有用户读取，以便完成这种映射，但只允许管理员修改。
这也说明 username 不是内核 object identity：改名时 UID 可保持不变；反过来，若删除后重用同一 UID，旧文件会被新账号“继承”。UID allocation/reuse 是 security-sensitive lifecycle policy。

### 11.2 Password hash 为什么移到 `/etc/shadow`

现代系统的 password field 常是 `x`，真正 verifier 与 aging metadata 位于普通用户不可读的 `/etc/shadow`。
即使 hash 不能直接“解密”，任何人能读取它就能 offline guess：不再受 login rate limit、lockout 或监控约束。

[`shadow(5)`](https://man7.org/linux/man-pages/man5/shadow.5.html)还记录 last-change、minimum/maximum age、warning、inactivity 和 account expiry。
锁定 password authentication 也不必然锁定 SSH key、existing process、scheduled job 或其他 authentication method；account disable policy 要覆盖所有入口。

### 11.3 `/etc/passwd` 不是唯一 name service

application 通常调用 `getpwnam/getpwuid` 等 libc API；Name Service Switch 可以把查询指向 files、LDAP、SSSD 或其他 provider。
因此：

```text
kernel credential: numeric IDs + groups + capabilities + security labels
libc identity lookup: name-service configuration
authentication: PAM/SSH/OIDC/... policy
```

不要硬编码解析 `/etc/passwd` 来替代 account API，也不要假设本地文件中没有 name 就不存在 principal。
container/user namespace 还会在 namespace ID 与 host ID 之间做映射，下一讲再展开。

### 11.4 `passwd`/`chsh` 不是“随手打开文件写几行”

PPT 的幽默点是：kernel 不理解“用户名/登录 shell”，最终 state 的确落在用户态维护的数据中。
但真实 `passwd`、`chsh` 是 privileged mediation：验证 caller、检查 policy、加锁、更新临时文件并替换、处理 PAM/NSS/SELinux/audit，具体实现因发行版而异。

若普通程序做：

```text
check(path)
  ── attacker renames/replaces/symlinks path ──
open(path)
```

就会产生 TOCTOU。权限检查与 object use 必须绑定稳定 fd/handle，或由 kernel 在一次 pathname resolution 中执行约束。
上一讲的 symlink/path race 在 privileged account tool 中会直接变成 privilege escalation。

---

## 12. UID：没有那么简单

“一个 process 有一个 uid”只是入门近似。Linux/POSIX credentials 至少包含：

| 名称 | 常见用途 | 典型问题 |
|---|---|---|
| real UID (ruid) | 启动者/owner identity；部分 signal/accounting checks | 谁运行了程序？ |
| effective UID (euid) | 多数 discretionary permission/privilege check | 现在以谁的权限行动？ |
| saved set-user-ID (suid) | 保存 exec 后 privilege identity，允许受控切换 | 能否暂时 drop 后恢复？ |
| filesystem UID (fsuid) | Linux filesystem permission check 的专用 ID | filesystem access 以谁计算？ |
| real/effective/saved GID | group 对应状态 | primary group 如何参与？ |
| supplementary groups | 额外 group memberships | 是否命中 inode group/ACL？ |

Linux `fsuid` 最初服务于 file server 场景；现代 application 很少直接设置。
`setresuid` 改 euid 时 Linux 也同步 fsuid；内核仍在 filesystem checks 使用它。
详见 [`credentials(7)`](https://man7.org/linux/man-pages/man7/credentials.7.html)与 [`setresuid(2)`](https://man7.org/linux/man-pages/man2/setresuid.2.html)。

### 12.1 Set-user-ID exec 的状态变化

假设 ordinary user 执行 owner 为 root、带 set-user-ID bit 的 binary：

```text
before exec: ruid=user, euid=user, suid=user
exec setuid-root file
after exec:  ruid=user, euid=root, suid=root
```

real UID 不变，effective UID 变成 executable owner，随后新的 effective UID 被复制到 saved ID。
program 可在 privileged setup 时用 euid=root，暂时切回 user，再按规则恢复 saved root identity。

但 [`execve(2)`](https://man7.org/linux/man-pages/man2/execve.2.html)列出 setuid/file-capability 会被忽略的条件，包括 `no_new_privs`、`nosuid` mount 和 being ptraced。
user namespace、capability sets、LSM 也会改变最终 authority，不能只看 `ls -l` 的 `s`。

### 12.2 暂时 drop 与永久 drop

privileged program 常采用：

```text
以最小 privilege 打开必要 resource
  → 清理 groups/capabilities
  → 把 real/effective/saved IDs 全部降到 service account
  → 安装 no_new_privs/seccomp
  → 处理不可信输入
```

只改 euid 可能保留 saved privileged ID，后来仍可恢复；这对确实需要临时升降的程序是 feature，对想永久降权的 daemon 则是危险。
应使用明确的 `setresgid/setgroups/setresuid` sequence，检查每个 return value，并验证降权后不能恢复。

在 multi-threaded process 中更复杂：kernel credential 本质上是 per-thread，而 glibc/NPTL wrapper 需要协调其他 threads 以满足 POSIX process-wide view。
最佳设计是 privilege separation：小而可审计的 helper 保留最小 authority，大 parser/业务 process 永久低权运行。

### 12.3 Setuid program 的输入远不止 argv

privileged execution 必须把以下都当作不可信：

- argv、environment、locale；
- cwd、umask、rlimits；
- inherited file descriptors 与 standard streams；
- signal disposition；
- pathname components、symlink、mount namespace；
- dynamic loader/library behavior；
- IPC peer credentials。

使用 `system()`、依赖 attacker-controlled `PATH`、在 `/tmp` 猜名字、先 access 再 open、打印 secret 到 inherited stderr，都可能让 tiny helper 失守。
setuid 扩大的是 authority，不会自动让 C code 更正确。

### 12.4 Linux capabilities：拆分 root，但不是零复杂度

Linux capabilities 把传统 root privilege 拆成 named units；例如 raw socket 相关的 `CAP_NET_RAW` 与任意 UID 改写的 `CAP_SETUID` 可分别授予。
它们是 per-thread attributes，并有 permitted、effective、inheritable、bounding、ambient 等 sets；file capabilities 在 `execve` 时参与变换。

好处是 service 不必为一个操作拿到全部 root authority。
边界包括：

- `CAP_SYS_ADMIN` 仍非常宽，不是“安全的万能小 root”；
- capability 与 user namespace 绑定，在该 namespace 中有效不等同于 host root；
- executable/plugin 若被攻破，仍继承它持有的全部 capability；
- capability 不限制 ordinary files/network endpoints，需要再叠加 DAC/MAC/seccomp/namespace。

[`no_new_privs`](https://docs.kernel.org/userspace-api/no_new_privs.html)保证后续 `execve` 不因 setuid/setgid/file capability 获得新权限，常作为 unprivileged seccomp sandbox 的地基；它不撤销已经持有的 fd/capability，也不阻止不经 exec 的合法 privilege change。

### 12.5 实验 1：只读观察自己的 credential layers

该实验不切换身份、不读取 `/etc/shadow` 内容，只看公开 metadata 和当前 process status：

```bash
id

python3 - <<'PY'
import os
print("real/effective/saved uid:", os.getresuid())
print("real/effective/saved gid:", os.getresgid())
print("supplementary groups:", os.getgroups())
PY

sed -n -E '/^(Uid|Gid|Groups|Cap(Inh|Prm|Eff|Bnd|Amb)|NoNewPrivs|Seccomp):/p' \
  /proc/self/status

stat -c '%A %U:%G %n' /etc/passwd /etc/shadow /usr/bin/passwd

if command -v getcap >/dev/null; then
  getcap /usr/bin/passwd /usr/bin/ping 2>/dev/null || true
else
  echo 'getcap unavailable; skip file-capability display'
fi
```

非特权 login shell 常看到 real/effective/saved UID 相同；container/user namespace 中也可能显示 0，但 `CapEff/CapBnd` 并非 host root 的全集。
`/etc/passwd` 通常 world-readable，`/etc/shadow` 不允许 ordinary user 读取，`/usr/bin/passwd` 常显示 owner execute 位上的 `s`；发行版可能改用其他 layout/capability，所以应解释实际输出，不硬编码。

`/proc/self/status` 的 `Cap*` 是 bitmask；用 `capsh --decode=HEX` 可在已安装 libcap 工具时解码。
`Seccomp`/`NoNewPrivs` 展示本实验 process 当前 sandbox 状态，但不证明其外层没有 container/LSM restriction。

---

## 13. 回到访问控制

UID/GID/mode 是 access-control matrix 的一种紧凑实现，不是唯一实现，也表达不了“只允许 service A 在 office network 更新本 tenant 的特定 records”这类 policy。

### 13.1 ACL：按 object 展开 principals

POSIX access ACL 可为一个 file/directory 增加 named user/group entries，通常存储在 filesystem extended attributes。
ACL 中的 mask 会限制 named user、named group 和 owning-group class 的 effective permissions；看到 entry 有 `rwx` 不检查 mask 可能误判。

default ACL 用于 directory child creation inheritance，不是对现有 descendants 的递归 policy rewrite。
详见 [`acl(5)`](https://man7.org/linux/man-pages/man5/acl.5.html)。

从 matrix 看，ACL 近似“存一列”：问这个 object 允许哪些 subjects。
好处是 object owner/administrator 易管理；代价是回答“某 user 到底能访问全系统哪些 objects”需要遍历/索引，revocation 与 backup/xattr preservation 也要小心。

### 13.2 Capability：按 holder/operation 切片

经典 capability security 中，不可伪造 token/handle 同时命名 object 和 authority，近似“存一行”；file descriptor 就有这种味道。
把只读 fd 经 Unix-domain socket `SCM_RIGHTS` 交给 child，是直接 delegation object authority，而不是让 child 重走 pathname ACL。

Linux named capabilities 则主要是把 root-only global operations 切片；它们与 capability-system 理论相关，但不是“每个 object 一个 token”的完整实现。
PPT 的 `capsh --drop=cap_net_raw ... ping` 用于观察某 behavior slice 被移除后的失败；现代 ping 也可能用 datagram ICMP socket、file capabilities 或 sysctl policy，输出依系统而异，不能把一次成功/失败当普遍结论。

### 13.3 SELinux/AppArmor：强制访问控制

DAC 允许 object owner 改 mode/ACL；Mandatory Access Control 由 system policy 对 subject/object label/profile 再做检查，owner 不能随意绕过。

- SELinux 以 labels/types 与 rules 表达细粒度 mediation；
- AppArmor 主要以 program profile/path-oriented rules 描述可访问资源；
- Linux Security Module framework 在 kernel security hooks 处承载多种 modules。

MAC 可以在 web service 被攻破后阻止读取用户 home 或写 system config，但 policy omission、过宽 transition、unconfined domain 与 kernel bug 仍是边界。
[Linux LSM 文档](https://docs.kernel.org/admin-guide/LSM/index.html)是当前 kernel integration 的入口。

### 13.4 Seccomp 与 BPF LSM：写 access-control function 的边界

seccomp filter 对 syscall number、architecture、argument words 等 `struct seccomp_data` 做 BPF decision，可 allow、deny(errno)、kill、trap、notify 等。
它适合缩小 syscall attack surface，不适合直接 dereference pathname string；path-based object policy 应由 filesystem/LSM/broker 用不会 race 的 handle 实施。

[kernel seccomp 文档](https://docs.kernel.org/userspace-api/seccomp_filter.html)明确指出：seccomp 不是完整 sandbox，只是最小化 exposed kernel surface 的工具。
BPF LSM program 则挂到 LSM hooks，可编程地参与 object/action authorization；部署通常需要 kernel support 与管理 authority，同样必须验证 policy、map lifecycle 和 observability。

### 13.5 分层 enforcement

| 层 | 可见 identity/object | 擅长的约束 | 盲点 |
|---|---|---|---|
| application/DB | account、tenant、row、business state | 业务授权、workflow、rate policy | process 被攻破后可能绕过同层检查 |
| UNIX DAC/ACL | numeric creds、inode/socket | owner/group/object permission | 难表达业务 context |
| capabilities/seccomp | privileged action/syscall | least privilege、kernel surface | 单独不懂 tenant/data semantics |
| LSM | process/object labels、kernel hooks | system-wide mandatory policy | policy complexity、kernel TCB |
| namespace/container/VM | object view/whole machine | blast-radius isolation | 配置错误、shared-kernel/hypervisor bugs |

真正的 defense in depth 要让各层 failure mode 尽量独立，而不是把同一个“管理员 token”复制到每层。

### 13.6 Least privilege、sandbox 与 secret handling

一个处理 untrusted document 的 service 可拆成：

```text
network front end (无文件秘密)
  → parser worker (无网络、只读输入 fd、CPU/memory/time limit)
  → narrow broker (校验结构化请求，只访问允许对象)
  → database (独立最小角色、row policy)
```

secret 应按 task scope 短期注入，而不是烘焙进 image、command line、environment dump 或 repository；日志做字段 allowlist/redaction，错误信息不回显 token。
sandbox 还要限制 resource usage 和 egress，否则 compromised parser 虽不能读 host file，仍可做 DoS 或外传它已获得的数据。

---

## 14. 找到 “意外” 的行为

### 14.1 程序路径远超人工直觉

一个 parser 的 behavior 由 input bytes、length、state、allocation result、thread interleaving、locale、filesystem、dependency version 等共同决定。
人类只测试“合理输入”，攻击者专门组合：

- empty/truncated/oversized records；
- integer boundary 与 encoding ambiguity；
- duplicate/conflicting fields；
- deep nesting、cycles、compression bomb；
- fail/retry/timeout 的罕见序列；
- 跨 API 层不一致的 canonicalization。

“用户不会这样用”不是 invariant；如果 interface 能表达，adversarial user 就会尝试。

### 14.2 Fuzz testing 的 feedback loop

coverage-guided fuzzing 不只是生成 random garbage：

```text
seed corpus
  → mutate/generate input
  → execute isolated target with instrumentation
  → retain inputs that discover new coverage/behavior
  → detect crash, sanitizer error, timeout, assertion
  → minimize + deduplicate + reproduce + regress
```

AFL、libFuzzer 和 OSS-Fuzz 代表这条路线。
[LLVM libFuzzer 文档](https://llvm.org/docs/LibFuzzer.html)强调 target 应 deterministic、fast、能接受任意 bytes，并常与 ASan/UBSan/MSan 组合。

截至 OSS-Fuzz 项目 README 标注的 **2025 年 5 月**，其累计帮助发现并修复超过 13,000 个 vulnerabilities 和 50,000 个 bugs、覆盖约 1,000 projects；这是带日期的项目统计，不应写成永久不变数字。见 [OSS-Fuzz 官方仓库](https://github.com/google/oss-fuzz)。

### 14.3 Fuzzer 找到的是 symptom，不自动给出安全结论

crash 可能是 availability bug，也可能可发展为 confidentiality/integrity compromise；no crash 也不表示没有 logic auth bypass、race 或 side channel。

好的 fuzz campaign 需要：

- narrow harness 与真实 parser state；
- sanitizer/oracle/invariant；
- bounded CPU/RAM/output/network；
- coverage 与 corpus quality；
- stable reproducer 和 root-cause triage；
- 修复后的 regression test；
- coordinated disclosure。

LLM 可帮助生成 structured inputs/harness/grammar 和阅读 crash，但它也会产生 invalid test、重复 bug、unsafe repro；“海量 0day”是 PPT 的夸张提醒，不能替代 reproducibility 和 human review。

---

## 15. 攻破一个进程

### 15.1 从 length mismatch 到 memory corruption

考虑：

```c
char buffer[16];
read(fd, buffer, attacker_controlled_size);  // 反例：size 未受 buffer 容量约束
```

若 `size > sizeof buffer`，kernel 会按 caller 请求把 bytes copy 到这段 user address；kernel 不知道 C object boundary。
越界写在 C/C++ 中是 undefined behavior：可能立即 `SIGSEGV`，也可能覆盖相邻 local、saved register、function pointer、allocator metadata，暂时“看似正常”。

关键不是“是否崩溃”，而是 attacker 是否能影响：

```text
write primitive（写到哪里、写什么、多少）
  + address/control-data knowledge
  + reachable privileged behavior
  → security impact
```

memory-safe language、bounds-checked API 和 ownership/lifetime discipline 在源头消除大类 bugs；compiler mitigation 主要让剩余 bug 更难利用/更易检测。

### 15.2 Stack frame 是 ABI/编译器结果，不是 C 语言承诺

教学图常画：

```text
high address
  saved return address
  saved frame pointer
  locals / char buffer
low address
```

真实 layout 受 architecture ABI、optimization、inlining、register allocation、stack alignment、red zone 与 protector 影响。
因此“写 N bytes 就覆盖 return address”不是 portable rule；依赖 UB 的 demo 也可能被 compiler 删除或重排。

### 15.3 Return-oriented programming 的概念链

NX/W^X 让 writable stack/heap 不可直接执行，攻击者于是可能复用已有 executable code 中以 indirect branch/`ret` 结束的 snippets（gadgets）。
概念上，corrupted control data 让这些 snippets 串成 computation，最终调用已有功能。

PPT 的 `pop rdi; ret`、`pop rsi; ret` 是 x86-64 calling-convention 直觉：控制 argument registers，再转到已有 function。
本章止于 defense reasoning，不提供具体 binary gadget 地址、payload 布局或现实目标 exploit chain。

ROP 说明两点：

- 不注入新 code 也可能获得恶意 behavior；
- defense 必须同时保护 forward edge、return edge、code pointer 与 data-only invariants。

---

## 16. [Stack Buffer Overflow](/OS/demos/intro/stackoverflow)

课堂 [Stack Buffer Overflow demo](https://jyywiki.cn/OS/demos/intro/stackoverflow)要观察的不是背诵一个 payload，而是 protection ladder：同一个越界 bug 在关闭/开启 stack protector、PIE/ASLR、NX 等条件下，failure mode 和 exploitability 如何变化。

### 16.1 漏洞、利用条件、缓解要分开

```text
bug:       program performs out-of-bounds access
primitive: attacker controls useful read/write/control-data effect
exploit:   primitive 跨越 security boundary 达成目标
mitigation:破坏 exploit chain 的某个 assumption
fix:       消除越界或改成 memory-safe design
```

stack canary abort 仍是 availability failure；ASLR 被 info leak 绕过后 bug 仍在；NX 面对 ROP 不够。
[CWE-121](https://cwe.mitre.org/data/definitions/121.html)也把 canary/ASLR 归为 defense in depth，而把 bounds checking/避免危险操作作为直接修复方向。

### 16.2 实验 2：不触发溢出，观察 canary、PIE/ASLR 与 NX

实验用 bounded `fgets`，不会故意越界；只在 `/tmp` 编译自建 program，并在退出时清理：

```bash
set -eu
lab_dir=$(mktemp -d /tmp/lect28-hardening.XXXXXX) || exit 1
case "$lab_dir" in /tmp/lect28-hardening.*) [ -d "$lab_dir" ] || exit 1 ;; *) exit 1 ;; esac
trap 'rm -rf -- "$lab_dir"' EXIT HUP INT TERM

cc -x c -O0 -Wall -Wextra -fstack-protector-all -fPIE -pie \
  -Wl,-z,noexecstack -o "$lab_dir/layout" - <<'C'
#include <stdio.h>
#include <stdlib.h>

static int global_marker;

__attribute__((noinline))
static int read_bounded_line(void) {
  char line[16];
  if (fgets(line, sizeof line, stdin) == NULL) {
    if (ferror(stdin)) {
      perror("fgets");
      return -1;
    }
    return 0;
  }
  printf("line=%s", line);
  return 0;
}

int main(void) {
  int stack_marker;
  void *heap_marker = malloc(1);
  if (heap_marker == NULL) {
    perror("malloc");
    return EXIT_FAILURE;
  }
  printf("global=%p stack=%p heap=%p\n",
         (void *)&global_marker, (void *)&stack_marker, heap_marker);
  int result = read_bounded_line();
  free(heap_marker);
  return result == 0 ? EXIT_SUCCESS : EXIT_FAILURE;
}
C

printf 'abcdefghijklmnopqrstuvwxyz\n' | "$lab_dir/layout"
"$lab_dir/layout" </dev/null
"$lab_dir/layout" </dev/null

readelf -h "$lab_dir/layout" | sed -n '/Type:/p'
readelf -W -l "$lab_dir/layout" | sed -n '/GNU_STACK/p'
readelf -Ws "$lab_dir/layout" | sed -n '/__stack_chk_fail/p'
```

预期：

- 第一行最多读取 15 chars 加 NUL，超长输入被截断，不发生 overflow；
- 多次 process launch 的 global/stack/heap virtual addresses 通常变化，体现 PIE + ASLR；受 container/kernel 配置影响，具体地址不可硬编码；
- ELF type 常为 `DYN`，表示 PIE executable；
- `GNU_STACK` flags 有 `RW` 而没有 `E`，表示请求 non-executable stack；
- symbol table 引用 `__stack_chk_fail`，表明 compiler 插入 stack-protector failure path。

`__stack_chk_fail` 出现不证明每个 function 都受到同样保护；`-fstack-protector-all` 是本实验刻意选择。
ASLR 需要 kernel 支持，PIE 让主 executable 可随机 relocation；NX 需要 architecture/page-table enforcement。

该实验不禁用系统保护、不生成 shellcode、不查 gadgets，也不触碰其他 binary。

---

## 17. 防御一个进程

单一“安全开关”不存在。可靠策略是消除 bug、缩小攻击面、破坏 exploit assumptions、限制成功后的 authority，并保留检测/recovery。

### 17.1 Stack canary

compiler 在 sensitive stack data 与 control data 附近放置 per-process/thread secret-like value，function return 前验证；overwrite 若改变 canary，就调用 failure handler 终止。

边界：

- 只检测经过 canary 的特定 overwrite path；
- information leak 可能暴露 canary；
- 不保护 heap、全局、所有 function pointer/data-only corruption；
- 检测后的 abort 保护 integrity，却损失当前 request/process availability。

### 17.2 ASLR 与 PIE

ASLR 随机化 stack、heap、shared libraries、mmap 等位置；PIE 让 main executable 也可 relocation。
它把稳定 absolute address assumption 变成概率问题，但 entropy 受 architecture、alignment、fork model 影响，memory disclosure 往往直接削弱它。

ASLR 是 mitigation，不是 access control；同一 process 内合法 pointer leak 可能同时泄露 layout。

### 17.3 NX/W^X

page permission 阻止 writable data page 直接执行，W^X policy 进一步避免 page 同时 writable 与 executable。
JIT compiler 需要受控地在 write/execute phases 切换或使用 dual mappings；若任意 plugin 能 `mprotect` 生成 executable memory，policy surface 又扩大。

ROP/JOP 和 data-oriented attack 会复用已有 code 或只改关键 data，所以 NX 必须与 control/data integrity 配合。

### 17.4 CFI、CET 与 shadow stack

Control-Flow Integrity 为 indirect call/jump/return 限定合法 targets。
粗粒度 target set 仍可能包含足够多恶意路径；fine-grained CFI 需要 whole-program/type information，并面对 dynamic linking、JIT、assembly、callback compatibility。

Intel CET 的 Indirect Branch Tracking 使用 `endbr64` 标记允许的 indirect branch landing，shadow stack 保护 return addresses；hardware availability、OS/toolchain enablement 与整个 module chain 都影响实际 coverage。
[Clang CFI design](https://clang.llvm.org/docs/ControlFlowIntegrityDesign.html)明确区分 forward-edge CFI 与 backward-edge return protection。

### 17.5 Sanitizer、fuzzing、审计与阻断

ASan/UBSan/MSan 适合测试构建中快速暴露 memory/UB/uninitialized bugs，通常有显著 overhead，不能简单视作 production access-control layer。
fuzzer 提供 adversarial inputs，sanitizer 提供 oracle，二者互补。

auditd/eBPF observability/Tetragon 等可记录或阻断 process behavior，但“预期行为”必须被精确定义；日志 queue 可能丢失，kernel instrumentation 需要权限，policy 可能被 bypass 或造成 false positive。
监控是 defense layer，不替代修复与最小权限。

### 17.6 防御矩阵

| 攻击链步骤 | 首选措施 | 典型第二层 |
|---|---|---|
| 产生 memory bug | memory-safe language、bounds/lifetime correctness | review、static analysis、fuzz+sanitizer |
| 获得可预测 layout | 不泄露 pointer/secret | ASLR/PIE |
| 执行 injected code | correct page permission | NX/W^X |
| 复用已有 control flow | 保护 code pointers/returns | CFI/CET/PAC/shadow stack |
| 利用后访问资产 | least privilege | DAC/MAC/seccomp/namespace/VM |
| 持久化或横向移动 | immutable/reproducible deployment | credential rotation、egress policy、audit/recovery |

最后一行最重要：即使前面全失守，一个只能读单个 input fd、没有 network 和 secret 的 parser，影响仍可被 containment。

---

## 18. 防了，没完全防住 😭

到这里，architectural access control 看似完整：user process 不能读取 kernel page，password checker 只返回 success/failure，NX/ASLR/canary 又提高了内存漏洞利用成本。
但 computer 会通过时间、cache、page fault、功耗、电磁辐射等“非设计输出”泄漏内部状态。

### 18.1 合法执行路径也会泄密

PPT 的 password checker 逐 byte 比较，遇到第一个 mismatch 就返回：

```c
for (i = 0; i <= strlen(correct_pass); i++)
  if (correct_pass[i] != given_pass[i]) {
    sleep(3);
    return EACCES;
  }
```

即使每次失败都 sleep，早停位置仍改变 compare 数量、memory access 和 microarchitectural state；`strlen` 在循环中重复扫描又增加 data-dependent work。
network jitter 可能淹没单次差异，但 attacker 可重复 sample、做统计，或利用 page boundary/fault 构造更强 oracle。

TENEX password 案例的核心不是“某条越权 load 成功”，而是合法 checker 触碰了哪一页、何时 fault，泄漏了 correct prefix。
它提醒我们：API value 相同，不代表全部 observable behavior 相同。

### 18.2 Side channel、covert channel 与普通 bug

- side channel：实现中附带的可观察量泄漏 secret-dependent state；
- covert channel：两个主体故意利用非设计 channel 通信；
- direct disclosure：程序直接把不该返回的 bytes 返回。

三者 mitigation 不同。
把 error message 统一可修 direct oracle，却不必然消除 cache/timing；把 function 写成 fixed loop，也不必然消除 compiler instruction choice、memory hierarchy 与 system noise。

### 18.3 实验 3：复用仓库示例观察 early exit

本实验使用仓库已有的 [constant_time_compare.c](../../examples/constant_time_compare.c)，只比较命令行中的教学字符串；它不猜真实密码，不访问账户或网络。
binary 编译到 `/tmp`，不修改仓库：

```bash
set -eu
demo_bin=$(mktemp /tmp/lect28-compare.XXXXXX) || exit 1
case "$demo_bin" in /tmp/lect28-compare.*) [ -f "$demo_bin" ] || exit 1 ;; *) exit 1 ;; esac
trap 'rm -f -- "$demo_bin"' EXIT HUP INT TERM

cc -O2 -Wall -Wextra \
  examples/constant_time_compare.c -o "$demo_bin"

"$demo_bin" secret xxxxxx
"$demo_bin" secret secrxx
"$demo_bin" secret secret
```

上述命令从 repository root 运行；若当前目录是 `tutorial/lectures/`，source path 应改为 `../../examples/constant_time_compare.c`。
预期核心输出为：

```text
insecure: equal=0 compared=1; constant-time: equal=0 compared=6
insecure: equal=0 compared=5; constant-time: equal=0 compared=6
insecure: equal=1 compared=6; constant-time: equal=1 compared=6
```

early-exit version 的 `compared` 直接泄漏 matching-prefix length；toy constant-time loop 对等长输入始终做 6 次 XOR/OR。

这只是教学模型，不是经过验证的 cryptographic primitive：

- `main` 先比较 `strlen`，会泄漏 length；
- operation count 相同不保证 generated machine code/CPU timing 完全相同；
- compiler 可能优化 source；
- surrounding protocol、cache 与 error path 仍可能泄漏。

production code 应调用 cryptographic library 提供的 constant-time comparison，并按其 length/precondition contract 使用；不要仅靠 `volatile`、sleep 或肉眼检查 C source 宣称 constant-time。

### 18.4 Constant-time 是 threat-model-specific engineering

“constant”通常不是 wall-clock 每次完全相等，而是在指定 model 下 control flow、memory access 和 instructions 不依赖 secret。
还要决定 length 是否公开、attacker 能否 co-locate、能否精确计时、能否控制 inputs 与重复次数。

降低 signal 的方法包括 constant-time primitive、blinding、rate limit、request batching/noise，但随机 delay 只增加 samples，通常不消除 systematic bias。
最小权限则限制即使比较 oracle 被利用，获得的 credential 能做什么。

---

## 19. 看似精妙的设计，实际……

### 19.1 Architectural rollback 不会自动擦除 microarchitectural trace

PPT 的核心片段是：

```c
raise_exception();
uint8_t volatile x = probe_array[data * 4096];
```

从 architecture 看，exception 前后的非法 instruction 不应 retire，program 不能直接观察 `x`。
但 out-of-order/speculative CPU 可能暂时执行后续 operations；secret-dependent array access 把某个 cache line 变热。
exception/abort 恢复 registers 与 architectural state，却未必恢复 cache、TLB、predictor 等 microarchitectural state。

攻击链抽象为：

```text
transiently access secret
  → encode secret into shared microarchitectural resource
  → squash architectural result
  → measure resource timing
  → infer secret statistically
```

这就是 Meltdown 类漏洞带来的反直觉：permission check 最终拒绝了 load，confidentiality 仍可能通过 side effect 失败。
[Meltdown 原始论文](https://www.usenix.org/system/files/conference/usenixsecurity18/sec18-lipp.pdf)描述了 exception、out-of-order execution 与 cache channel 的组合。

### 19.2 PTI 为什么有用，又为什么不是通用答案

Kernel Page-Table Isolation 让 user mode page table 不再长期映射大部分 kernel memory；即使某些 CPU 对权限检查与 transient execution 处理有缺陷，目标 mapping 不在当前 translation context，经典 Meltdown 路径被切断。

代价是 user/kernel transition 时切换 page tables、影响 TLB/cache behavior；PCID、硬件改进和 workload 决定 overhead。
PTI 针对特定 threat mechanism，不修复 Spectre-style mistraining、其他 data sampling 或物理 side channel。

不要通过关闭 mitigation 来做课堂 benchmark。
只读查看本机公开状态即可：

```bash
for report in /sys/devices/system/cpu/vulnerabilities/*; do
  printf '%s: ' "${report##*/}"
  sed -n '1p' "$report"
done
```

输出由 CPU、microcode、kernel version、boot options 和 hypervisor 共同决定；`Mitigation:` 也不是对未来 variants 的永久证明。
[Linux hardware vulnerabilities 文档](https://www.kernel.org/doc/html/latest/admin-guide/hw-vuln/)是解释这些 sysfs reports 的权威入口。

### 19.3 Meltdown 之后：同一种根因，不同细节

PPT 列出三个案例，不能把它们都简化为“又一个 Meltdown”：

- **Downfall / Gather Data Sampling (CVE-2022-40982)**：特定 Intel processors 的 gather behavior 可能让 local code 推断先前 vector-register stale data；Intel 提供 microcode mitigation。见 [Intel GDS advisory](https://www.intel.com/content/www/us/en/developer/articles/technical/software-security-guidance/advisory-guidance/gather-data-sampling.html)。
- **Inception (CVE-2023-20569)**：针对 AMD Zen 的 transient-execution/return prediction attack surface；需要 vendor microcode/firmware 与 OS guidance。见 [AMD bulletin](https://www.amd.com/en/resources/product-security/bulletin/amd-sb-7005.html)与[论文](https://comsec.ethz.ch/wp-content/files/inception_sec23.pdf)。
- **GhostRace (CVE-2024-2193)**：研究 speculative paths 上 synchronization primitive 可被 microarchitecturally bypass，形成 speculative race conditions；见 [USENIX Security 2024 论文页](https://www.usenix.org/conference/usenixsecurity24/presentation/ragab)。

这些研究要求精确 processor/model/privilege/co-location assumptions。
管理员应跟随 CPU vendor、OS vendor 和 cloud provider advisories 更新 microcode/kernel；不要根据名字自行关闭 mitigation，也不要把 lab proof-of-concept 扩散到未授权系统。

### 19.4 Security property 跨越 ISA abstraction

ISA 告诉 program 哪些 architectural states 合法，却不承诺 timing、power、RF emission 全无信息。
高性能机制——cache、speculation、shared predictor、SMT——让不同 protection domains 分享 microarchitectural resources。

因此隔离设计需要回答：

- 是否允许互不信任 tenants 同 core/SMT sibling？
- secret code 是否 constant-time？
- context switch 时哪些 state 要 flush/partition？
- firmware/microcode 是否在 patch baseline？
- mitigation 对 performance/SLA 的代价如何测量？

---

## 20. 你甚至看不见你的对手在哪 (1)

### 20.1 超视距电磁窃听

电子设备切换电压与传输高速信号时会产生电磁辐射。
display cable/interface 的周期视频信号与 pixels 相关；具有合适 antenna、receiver、signal processing 和重复 averaging 的 observer 可能从 unintended emission 重建 screen content。

PPT 引用 Markus Kuhn 的 [flat-panel display 电磁窃听研究](https://www.cl.cam.ac.uk/~mgk25/pet2004-fpd.pdf)：实验展示 modern flat-panel 并不天然免疫，课堂特别强调相距约 10 m、隔着三层石膏板墙的场景。
这是 controlled setup 下的 threat demonstration，不意味着任意屏幕、距离和建筑都同样可读。

### 20.2 Threat boundary 从 syscall 扩展到空间

access-control matrix 中原本没有“隔壁房间的 receiver”这一行；物理 side channel 迫使我们加入：

- attacker proximity 与停留时间；
- cable/device model；
- shielding、grounding 与 building boundary；
- 可否选择 screen content/repetition；
- emission collection 是否会被检测。

高保障环境可采用物理 security zone、经过测试的屏蔽/滤波设备、距离与视线控制、限制敏感显示，并按目标频段做测量验证。
普通软件设置不能证明消除 RF leakage；降低显示对比/随机化也可能只改变 signal quality。

本章不提供收集他人显示信号的设备配置或解码步骤。

---

## 21. 你甚至看不见你的对手在哪 (2)

### 21.1 不看屏幕，也可以“看”CPU 在算什么

cryptographic operation 使 transistor switching、memory access 和 control flow 随 intermediate values 变化，进而影响：

- execution time；
- power consumption；
- electromagnetic emanation；
- acoustic noise；
- chassis/ground potential 等可测信号。

PPT 引用 [Physical Key Extraction Attacks on PCs](https://doi.org/10.1145/2851486)，说明 commodity PC 上运行正确 cryptographic algorithm，仍可能通过物理泄漏提取 key information。
攻击可行性高度依赖 algorithm implementation、chosen inputs、测量距离/传感器、noise 与采样量。

### 21.2 密码学证明不包括所有 implementation traces

算法证明通常把 encryption/signature 视作 abstract oracle；真实机器还输出 trace：

```text
ciphertext + return code
timing + cache misses + branch pattern + power + EM + acoustic signal
```

如果 trace 与 secret 相关，数学 primitive 仍可能被 implementation 泄漏击穿。
防御包括 constant-time/control-flow、regular memory access、masking/blinding、shielding/filtering、noise-aware physical design、限制 chosen-query rate 和 key rotation；每种只覆盖相应 leakage model。

“算法是 AES/RSA/ECC 标准”不等于 implementation side-channel resistant。
硬件 security module 可缩小 key exposure，但 device interface、firmware、power/EM 和 supply chain 又成为新的 TCB。

### 21.3 两类“看不见”案例的区别

display eavesdropping 主要恢复 I/O signal/pixels；CPU physical key extraction 从 computation-dependent emanation 推断 secret state。
二者共同点是 attacker 不需要进入 OS account，也不触发传统 failed-login log。
不同点是 signal model、设备、采样与 mitigation，不能用一个“屏蔽就行”笼统概括。

---

## 22. 或者，更暴力一点

### 22.1 Cold boot：断电不等于 DRAM 立刻清零

PPT 的 cold-boot attack 把 physical threat model 推到极端：DRAM 的 data remanence 使 bits 在断电后一段时间内仍可辨认，低温可减慢 decay；有物理控制的 attacker 可能重启到采集环境或转移 memory module，再从带 bit errors 的 image 恢复 cryptographic keys。

Halderman 等人的 [USENIX Security 2008 原始论文](https://www.usenix.org/conference/17th-usenix-security-symposium/presentation/lest-we-remember-cold-boot-attacks-encryption)展示了对当时多种 full-disk encryption systems 的 key recovery，并利用 key schedule redundancy 修复部分 decay errors。

本章不复现冷冻、拆卸或 memory acquisition；这涉及设备损坏、数据侵犯和现实 credential extraction。

### 22.2 Full-disk encryption 的正确承诺

full-disk encryption 擅长保护关机且 key 不在设备上的 data at rest。
当系统已解锁，OS 必须在某处持有可用 key/material；screen lock 或 suspend 不必然把它清除。

所以：

```text
stolen, fully powered-off device
    ≠ stolen, running/unlocked device
    ≠ stolen, suspended device
```

防御要组合 physical access control、真正 power-off policy、pre-boot authentication、快速 key erasure、减少 plaintext/key residency、memory encryption/secure hardware 与 incident response。
TPM 可保护 sealed key 的释放条件，但若 key 已释放到 RAM，不能仅凭“有 TPM”断言 cold-boot safe。

### 22.3 物理拥有常改变根信任

有持久 physical access 的 attacker 还可能换 firmware、植入 input logger、连接 DMA device 或替换整机。
secure boot、measured boot、IOMMU、tamper evidence 与 remote attestation 各覆盖一部分，但 recovery/root keys、manufacturer update chain 和 physical inspection 仍在 TCB 中。

安全结论必须说明 physical attacker 是否在 scope；把它排除可以是合理工程选择，但必须明写，而不是默认“机房门会解决”。

---

## 23. Agents 时代的新安全问题

### 23.1 Prompt injection 不是普通聊天中的“说服”而已

direct prompt injection 由 user 在输入中要求 model 偏离 developer policy；indirect prompt injection 则把恶意 instruction 放进 Agent 会读取的网页、邮件、issue、PDF、tool result 或 repository file。

PPT 所说的“奶奶漏洞”是这类 jailbreak 的课堂俗称：把原本被拒绝的请求包装成祖母讲故事、角色扮演或其他看似无害的上下文。具体话术会随 model 与防御更新而失效；它说明 natural-language safety filter 可被输入 framing 影响，不是一条稳定、通用的攻击咒语。

tool-free chatbot 的失败可能只是错误文字；拥有 shell、browser、email、calendar、cloud API、credential 的 Agent 则可能把文本影响转成真实 side effect。
[NIST 2025 agent hijacking 说明](https://www.nist.gov/news-events/news/2025/01/technical-blog-strengthening-ai-agent-hijacking-evaluations)把它概括为 trusted instruction 与 untrusted external data 分离不清的老问题在 Agent 中重现。

### 23.2 ROP 类比：每一步合法，组合起来越权

PPT 把多步 injection 类比 ROP 很有启发：

```text
ROP:   复用一个个合法 executable snippets → 形成恶意 computation
Agent: 复用一个个合法 tool calls          → 形成越权 workflow
```

例如“读文档”“总结内容”“上传报告”分别可能允许，但恶意文档让 summary 带入 secret，再让 upload 发往 attacker destination，组合后发生 exfiltration。

所以只检查每个 tool 名是否在 allowlist 不够；authorization 要绑定 arguments、data provenance、destination、sequence、budget 与 initiating principal intent。

### 23.3 Agent 是 confused deputy

Agent 同时接触：

```text
trusted policy
user request
untrusted retrieved data
tool descriptions/results
memory/history
high-value credentials
```

若 model 无法可靠区分哪段有 command authority，attacker-controlled data 就借用了 Agent 的 credential，形成 confused-deputy problem。
“系统提示说不要听网页”是 defense layer，不是不可绕过 reference monitor；model 仍是 probabilistic interpreter。

### 23.4 把 authority 放到模型之外

更稳健的 architecture 是：

```text
untrusted content
  → parser/label/provenance
  → model proposes typed action
  → deterministic policy engine validates subject/object/action/context
  → user approval for high-impact boundary
  → narrow broker uses scoped short-lived credential
  → sandboxed execution + audit + result validation
```

具体措施：

- 每个 tool 独立最小权限；read 与 write/delete/send 分开；
- token 限 tenant、resource、operation、destination、expiry，不给长期万能 credential；
- tool arguments 结构化校验，path/domain/recipient 做 allowlist 与 canonicalization；
- untrusted document parser 无 secret、无 egress，workspace 临时且可丢弃；
- confirmation 显示最终 object/diff/recipient/cost，不让 model 自己替 user 批准；
- 限制 step、CPU、money、API quota，避免 loop 与 cost DoS；
- side effects 使用 idempotency key、transaction、staging/dry-run 和 rollback；
- audit 记录 policy decision、tool arguments、credential scope、artifact digest，日志不含 secret；
- tool output 继续视为 untrusted，不自动提升为 instruction。

human approval 也会被 fatigue、misleading summary 和批量 click-through 击穿；只在真正 privilege boundary 请求、展示可核对 diff，才有价值。

### 23.5 Secret handling

不要把所有 secrets 塞进 model context。“模型承诺不输出”不是 access control。

broker 可持有 secret 并替 Agent 完成窄操作，例如“向固定 repository 创建 draft PR”，而不把 raw token 返回给 model。
使用 ephemeral credential、single-task workspace、egress restriction、redacted tool output；任务结束立即 revoke/expire。

如果 input 同时含 untrusted content 与 high-value secrets/egress authority，应优先做 privilege separation，而不是继续堆 prompt classifier。

### 23.6 时效说明

Agent security 仍快速演进。NIST 在 2026 年推进 [AI Agent Standards Initiative](https://www.nist.gov/artificial-intelligence/ai-agent-standards-initiative)；现阶段 guidance/evaluation 不等于“prompt injection 已被解决”。
设计应假设 model-level defense 会失败，把 deterministic authorization 与 sandbox 作为最后边界，并持续 red-team/回归测试。

---

## 24. 供应链攻击：你甚至不能信任你的软件

### 24.1 我们执行的远不止自己写的 source

现代 artifact 的供应链是 DAG：

```text
source commits + generated code + dependencies + compiler/build tools
       ↓
CI runner + scripts + caches + environment + secrets
       ↓
artifact/package/container + provenance/signature
       ↓
registry/mirror/update channel
       ↓
installer/runtime + transitive dependencies
```

任一节点被控制，都可能让“review 过的 source”与最终运行 bytes 不一致。
威胁包括 maintainer account takeover、恶意 contributor、dependency confusion/typosquatting、install hook、compromised build worker/cache、registry token theft、mirror replacement 和 malicious update。

### 24.2 Package install hook 是直接 code execution

PPT 构造 `plain-crypto-js@4.2.1` 场景：攻击者先发布看似合理 package，再把它作为 feature dependency 混入新版本，installation hook 获得 consumer/CI 的 execution authority。
这里的 package 名应视作课堂假设，不应据此指控现实 package。

package manager lifecycle script 本质上就是 code execution。
审查 top-level dependency source 不够，因为 transitive dependency、platform-specific optional package 和 downloaded binary 也可能执行。

安全做法包括：

- 明确 registry scope，防 dependency confusion；
- lock version 与 artifact digest，review lockfile diff；
- 默认隔离 build/install，限制 network、secret、host filesystem；
- 对不需要 hook 的场景禁用 scripts，但理解可能破坏 legitimate build；
- 扫描 dependency behavior/license/vulnerability，减少不必要 dependencies；
- PR build 不接触 production signing/publish credentials。

### 24.3 xz Utils：source、release tarball 与 build path 的组合攻击

PPT 用 xz backdoor 说明长期 social engineering：攻击者身份经过多年 contribution/信任积累，最终恶意内容进入 release/build path。

2024 年披露的 CVE-2024-3094 影响 xz/liblzma 5.6.0、5.6.1 的特定构建条件；malicious test artifacts 与 build machinery 组合，在部分 x86-64 Debian/RPM packaging path 中把 backdoor 注入 liblzma，并可能通过 systemd/OpenSSH integration 影响 `sshd` authentication。
不是所有 source checkout、OS、architecture 或 build 都触发同一 payload。

事件因 performance/behavior anomaly 被调查而发现，说明 observability 与愿意追根究底的人仍是供应链防线。
[OpenSSF 的事件说明](https://openssf.org/blog/2024/03/30/xz-backdoor-cve-2024-3094/)给出 affected versions/build conditions 与处置建议。

关键教训：

- “repository diff 看起来正常”不覆盖 generated/release tarball/build script；
- maintainer reputation 是 risk signal，不是 cryptographic proof；
- compressed/binary test fixture 可藏 review UI 无法解释的内容；
- build-time conditional activation 会逃过普通 developer environment；
- low-level library 的 downstream blast radius 可能远超自身 API。

### 24.4 从账号到 artifact 的多层控制

| 供应链阶段 | 主要风险 | 防御示例 |
|---|---|---|
| maintainer identity | phishing、session/token theft | phishing-resistant MFA、hardware key、短期 token、recovery control |
| source change | 单人恶意 push、混淆 diff | protected branch、two-person review、signed/attested change、binary rendering |
| dependency selection | typosquat/confusion/unreviewed update | scoped registry、lock+hash、policy bot、manual semantic review |
| build | compromised runner/tool/cache、secret theft | hermetic/ephemeral isolated build、minimal secrets、pinned builder image |
| artifact publish | stolen signing/registry credential | separate release role、short-lived identity、transparency/audit |
| consume/deploy | provenance ignored、unsafe install hook | verify digest/signature/provenance against expected source/builder policy |
| incident | slow discovery/revocation | SBOM/inventory、rapid rollback、key revoke、dependency reachability |

### 24.5 Signature、SBOM、reproducibility 与 provenance 各自证明什么

- signature：artifact/statement 由对应 key/identity 签发；不证明 signer 善意或 source 无漏洞；
- SBOM：列出 components，支持 inventory/query；不证明它们被安全构建；
- reproducible build：独立构建在定义条件下得到相同 bytes；不证明相同 bytes 是安全设计；
- provenance：描述 artifact 从何 source、由何 builder/parameters 产生；必须验证它符合预期，不能只“附带一个 JSON”。

截至本章撰写时，[SLSA 1.2](https://slsa.dev/spec/v1.2/tracks)把 source/build tracks 与不同 assurance levels 分开；higher level 提高伪造 provenance/绕过 process 的难度，但 SLSA 自己也明确有 threat-model scope，不解决 malicious producer、所有 dependency/runtime vulnerability。
[OpenSSF package repository principles](https://repos.openssf.org/principles-for-package-repository-security.html)还涵盖 account recovery、MFA、malware reporting、provenance 等 registry responsibilities。

### 24.6 Agent 与供应链会互相放大

coding Agent 读取 issue/README 后执行 build，indirect prompt injection 可诱导它新增 dependency、运行 install hook 或外发 token；恶意 dependency 又能污染 Agent 的 tool output、workspace 与 generated artifact。

因此 Agent workflow 需要把 repository content 当 untrusted data，把 dependency installation/build 放隔离 worker，不给 PR code release credential；最终 publish 必须经过 deterministic policy、review、artifact digest/provenance 验证。

“Agent 生成得快”扩大了 change volume，也扩大 reviewer fatigue。
安全 gate 应按 risk/authority 分层，优先验证 binary/source correspondence、dependency diff 与 privileged side effects，而不是只读自然语言 summary。

---

## 25. 从 CIA 到 Agent：一张统一的安全设计表

| 场景 | asset/principal | policy | mechanism | 残余风险 |
|---|---|---|---|---|
| grade database | grade/student/teacher | teacher 只改自己课程 | authn、row authz、transaction、audit | stolen session、business logic bug |
| setuid `passwd` | shadow record/caller UID | user 只改自己 password | euid/suid、PAM、locking、atomic replace | helper parser/path/env bug |
| crypto compare | secret/remote caller | 只泄漏 equal bit | constant-time primitive、rate limit | length/system/physical side channel |
| parser service | host data/untrusted file | parser 只读一个 input | memory safety、sandbox、fd delegation | kernel/sandbox bug、DoS |
| tool-using Agent | repo/mail/token/user | 仅执行用户批准 scope | typed broker、scoped token、approval/audit | prompt injection、approval fatigue |
| build pipeline | source/artifact/maintainer | artifact 来自 approved source/build | review、isolation、signature/provenance | malicious producer、unknown vuln |

每一行都要问 fail mode：deny 是否 fail closed？availability 是否被过度拒绝破坏？日志是否反而泄密？恢复是否能撤销 credential 和 rollback artifact？

---

## 26. 常见误解与精确辨析

| 常见说法 | 更精确的结论 |
|---|---|
| “安全就是没有 bug” | 安全是相对 threat model 的 properties；正确功能也会经 side channel/authority misuse 失守。 |
| “加密保证 CIA” | encryption 主要保护 confidentiality；integrity/authenticity、availability、key lifecycle 需另行设计。 |
| “hash 无法逆向，所以能存密码” | password 低熵，可离线猜；需要 salt 与 password KDF。 |
| “数字签名就是私钥加密” | signature 有独立 scheme/security definition；不能随意反用 encryption。 |
| “区块链绝对不可修改” | tamper resistance/finality 依 consensus、assumptions、confirmations；fork/reorg 仍可能。 |
| “数据库 ACID 保证成绩不会被改坏” | ACID 保事务状态，不判断 caller 是否获得业务授权。 |
| “kernel 只要检查一次 pathname” | namespace 可并发变化；应把 authorization 与稳定 object handle/单次 resolution 绑定。 |
| “用户名就是内核身份” | kernel 主要使用 numeric credentials；name service 在用户态映射，UID 会重用/映射。 |
| “进程只有一个 UID” | real/effective/saved/fsuid 与 groups/capabilities 共同决定行为。 |
| “setuid bit 一定让程序变 root” | owner、nosuid、no_new_privs、ptrace、namespace/capability/LSM 都影响结果。 |
| “capability 后就不需要 sandbox” | capability 只拆一部分 privilege；ordinary resources、syscalls、network 和业务权限仍需约束。 |
| “seccomp 能按 pathname 做完整 policy” | filter 不安全 dereference user path；它主要缩 syscall surface，需与 broker/LSM/DAC 组合。 |
| “fuzzer 没崩就安全” | oracle/coverage 有盲区，logic/race/side-channel bugs 可能不崩。 |
| “canary/ASLR/NX 修复了 overflow” | 它们破坏部分 exploit chain；越界 bug 仍需修复。 |
| “NX 阻止任意代码执行” | code reuse 与 data-oriented attacks 不需执行 injected writable bytes。 |
| “CFI 允许的 target 都安全” | target set 粒度、module coverage、JIT/assembly 与 data-only state 仍是边界。 |
| “sleep 一个固定时间就是 constant-time” | early work/cache/page trace 仍可能相关；random delay也只增加统计成本。 |
| “permission-denied load 没有输出” | transient execution 可能留下 cache/predictor traces，形成 side channel。 |
| “断电后 RAM 清零，磁盘加密就够” | DRAM remanence 与已解锁 key 使 physical threat 仍存在。 |
| “system prompt 能禁止 prompt injection” | probabilistic model 不是 reference monitor；工具 authority 必须由外部 deterministic controls 限制。 |
| “用户点了确认就已授权” | misleading summary/approval fatigue 会破坏意图；应展示最终对象、diff、recipient 和 cost。 |
| “签名 package 就可信” | signature 证明 origin，不证明 signer/内容 benign；还要验证预期 source/build policy。 |
| “锁版本就解决供应链” | pin 防 surprise update，却会冻结 known vulnerability；需要 inventory、update/review/recovery。 |
| “容器就是绝对安全边界” | 容器通常共享 host kernel；下一讲将比较 namespace/container 与 VM 的 TCB。 |

---

## 27. Takeaways

1. 安全结论必须绑定 asset、principal、attacker capability、policy、mechanism 与 trust assumptions。
2. CIA 是三种不同性质；改善一项可能损害另一项，密码学原语不等于完整系统。
3. Access control matrix 是统一模型；UID/mode、ACL、capability、MAC、seccomp 只是不同压缩和 enforcement points。
4. Authentication 回答“是谁”，authorization 回答“能否做”，audit 回答“发生了什么”；三者不能互相替代。
5. Memory corruption 应先从 memory safety/正确 bounds 消除；canary、ASLR、NX、CFI 与 sandbox 是 defense in depth。
6. Architectural access control 不覆盖 timing/cache/power/EM/DRAM remanence；side channel 会扩展 threat boundary。
7. Agent 的根风险不是文字冒犯，而是 untrusted data 借用 tool credentials；authority 应放到 model 外的 broker/policy/sandbox。
8. 软件 artifact 的可信度取决于 source、review、build、dependency、registry、provenance 和 recovery 整条链。

---

## 28. 思考题与下一讲衔接

### 28.1 思考题

1. 为教务系统列出三类 assets、四类 principals、两个 trust boundaries 和一个明确不在 scope 的 attacker。
2. backup 同时怎样帮助 availability，又怎样扩大 confidentiality attack surface？
3. 为什么有 signature 的转账仍可能被 replay？应把哪些 context 纳入 signed message？
4. 比较 ACL、file descriptor delegation 与 Linux named capability 分别对应 access matrix 的什么切片。
5. real/effective/saved UID 为什么都存在？永久 drop privilege 只改 euid 会留下什么问题？
6. setuid helper 已检查 input pathname owner，为什么稍后再 `open` 仍可能越权？
7. ASLR、NX、canary、CFI 各破坏 buffer-overflow exploit chain 的哪个 assumption？
8. constant-time source loop 为什么不能单凭 C operation count 给出硬件级证明？
9. Meltdown 中 architectural state 被 squash 后，attacker 还观察到了什么？PTI 改变哪项前提？
10. 显示器电磁窃听、CPU key extraction、cold boot 的 attacker capability 有何不同？
11. 一个 Agent 只允许 `read_file`、`create_draft`、`send_email`，为什么 tool allowlist 仍不足？
12. 为“Agent 根据 issue 修 bug”设计一次高风险 action approval：应展示哪些 final parameters？
13. signature、SBOM、reproducible build、provenance 分别能证明什么，不能证明什么？
14. xz 案例中，为什么普通 source review 很难覆盖 release tarball/build-time condition？
15. 若 parser 已在 container 中，什么威胁促使你升级为 VM？什么 workload 又使 container 更合适？

### 28.2 引向虚拟机和容器

本讲反复使用“把 compromised component 的 authority 和 blast radius 限住”，但还没有系统比较 isolation mechanism。

下一讲[虚拟机和容器](29-vm-containers.md)会回答：

```text
VM：模拟/虚拟整台机器，guest kernel 也在隔离域内
container：同一 kernel 为进程虚拟化 namespace，并用 cgroup 控资源
```

虚拟机通常给 untrusted guest 更厚的 kernel boundary，但 hypervisor/device emulation 仍是 TCB；container 启动快、密度高，却共享 host kernel。
namespace 解决“看见哪些 objects”，cgroup 解决“能用多少资源”，capability/seccomp/LSM 解决“能做哪些 operations”，OverlayFS 构造 root view。

这正是本讲 access-control matrix、least privilege、availability 和 side-channel threat model 的系统化落地。

---

## 29. 扩展阅读（PPT 之外，优先一手资料）

以下资料用于校正接口、历史案例和时效性；它们不替代 PPT 主线。

- 安全模型：Saltzer 与 Schroeder，[*The Protection of Information in Computer Systems*](https://www.cs.virginia.edu/~evans/cs551/saltzer/)；
- 密码学标准：[NIST FIPS 186-5 Digital Signature Standard](https://csrc.nist.gov/pubs/fips/186-5/final)；
- algorithmic DoS：Crosby 与 Wallach，[USENIX Security 2003](https://www.usenix.org/conference/12th-usenix-security-symposium/denial-service-algorithmic-complexity-attacks)；
- Linux identity/access control：[`credentials(7)`](https://man7.org/linux/man-pages/man7/credentials.7.html)、[`setresuid(2)`](https://man7.org/linux/man-pages/man2/setresuid.2.html)、[`capabilities(7)`](https://man7.org/linux/man-pages/man7/capabilities.7.html)、[`acl(5)`](https://man7.org/linux/man-pages/man5/acl.5.html)；
- Linux sandbox/security hooks：[seccomp filter](https://docs.kernel.org/userspace-api/seccomp_filter.html)、[no_new_privs](https://docs.kernel.org/userspace-api/no_new_privs.html)、[LSM](https://docs.kernel.org/admin-guide/LSM/index.html)；
- memory corruption：[CWE-121](https://cwe.mitre.org/data/definitions/121.html)、[Clang CFI design](https://clang.llvm.org/docs/ControlFlowIntegrityDesign.html)、[LLVM libFuzzer](https://llvm.org/docs/LibFuzzer.html)、[OSS-Fuzz](https://github.com/google/oss-fuzz)；
- transient execution：[Meltdown paper](https://www.usenix.org/system/files/conference/usenixsecurity18/sec18-lipp.pdf)、[Linux hardware-vulnerability guide](https://www.kernel.org/doc/html/latest/admin-guide/hw-vuln/)、[Intel GDS](https://www.intel.com/content/www/us/en/developer/articles/technical/software-security-guidance/advisory-guidance/gather-data-sampling.html)、[AMD Inception bulletin](https://www.amd.com/en/resources/product-security/bulletin/amd-sb-7005.html)、[GhostRace](https://www.usenix.org/conference/usenixsecurity24/presentation/ragab)；
- physical side channels：Kuhn 的 [flat-panel electromagnetic eavesdropping](https://www.cl.cam.ac.uk/~mgk25/pet2004-fpd.pdf)、Genkin 等的 [Physical Key Extraction Attacks on PCs](https://doi.org/10.1145/2851486)、Halderman 等的 [Cold Boot Attacks](https://www.usenix.org/conference/17th-usenix-security-symposium/presentation/lest-we-remember-cold-boot-attacks-encryption)；
- Agent security：Greshake 等的 [indirect prompt injection 原始研究](https://arxiv.org/abs/2302.12173)、[NIST agent hijacking evaluation](https://www.nist.gov/news-events/news/2025/01/technical-blog-strengthening-ai-agent-hijacking-evaluations)与[NIST AI Agent Standards Initiative](https://www.nist.gov/artificial-intelligence/ai-agent-standards-initiative)；
- supply chain：[OpenSSF package repository principles](https://repos.openssf.org/principles-for-package-repository-security.html)、[SLSA 1.2 tracks](https://slsa.dev/spec/v1.2/tracks)、[SLSA provenance](https://slsa.dev/spec/v1.2/provenance)、[OpenSSF xz CVE-2024-3094 analysis](https://openssf.org/blog/2024/03/30/xz-backdoor-cve-2024-3094/)。

SLSA/Agent standards 与 CPU mitigation 状态会继续变化；本章对版本/统计均标注了时间，实践时应重新核对官方文档和 vendor advisory。

---

## 30. PPT 一级标题覆盖表

第一列逐字保留 `sources/notes/lect28.md` 的全部非重复一级标题，并保持原顺序。

| PPT 一级标题（逐字） | 本章位置 | 覆盖内容 |
|---|---|---|
| 计算机安全简介 | §0–§1 | 数据库之后的安全问题、threat model、asset/principal/policy/mechanism |
| 回到美好的 “裸奔” 时代 | §2 | 8086 real mode、IVT/BIOS 类比、CIH、BBS 信任边界 |
| 保密性 Confidentiality | §3 | disclosure、残留数据、quick format、key/metadata/side channel |
| 完整性 Integrity | §4 | unauthorized change、来源、freshness、replay、成绩案例 |
| 可用性 Availability | §5 | DoS、fork bomb（禁止运行）、hash complexity、resource fairness |
| 一分钟密码学 | §6 | one-way/hash、trapdoor 直觉、公钥加密、签名与原语边界 |
| 应用：区块链 | §7 | PoW、hash chain、replication、fork/finality、CIA 取舍与课堂讽刺案例 |
| 实现 Confidentiality 和 Integrity | §8 | process/VM isolation、syscall、reference monitor 与假设 |
| 访问控制原理：一张表 | §9 | access-control matrix、EACCES/EPERM、ACL/capability/role/label 分解 |
| UNIX: 用整数表示身份 | §10 | uid/gid/mode、directory rwx、root/capabilities、Android app UID |
| /etc/passwd: 每行一个用户 | §11 | 七字段、shadow、NSS、privileged update 与 TOCTOU |
| UID：没有那么简单 | §12 | real/effective/saved/fsuid、setuid、capability、credential 实验 |
| 回到访问控制 | §13 | ACL、SELinux/AppArmor、capability、seccomp/BPF LSM、least privilege |
| 找到 “意外” 的行为 | §14 | adversarial paths、AFL/libFuzzer/OSS-Fuzz、oracle 与 LLM 边界 |
| 攻破一个进程 | §15 | unchecked length、UB、stack layout、control-data corruption、ROP |
| [Stack Buffer Overflow](/OS/demos/intro/stackoverflow) | §16 | vulnerability/exploit/mitigation 区分、PIE/ASLR/NX/canary 安全实验 |
| 防御一个进程 | §17 | canary、ASLR、NX、CFI/CET、sanitizer、audit/sandbox 防御矩阵 |
| 防了，没完全防住 😭 | §18 | TENEX/early-exit timing、constant-time compare 实验与边界 |
| 看似精妙的设计，实际…… | §19 | transient execution/cache encoding、Meltdown/PTI、Downfall/Inception/GhostRace |
| 你甚至看不见你的对手在哪 (1) | §20 | flat-panel/display electromagnetic eavesdropping 与物理边界 |
| 你甚至看不见你的对手在哪 (2) | §21 | CPU timing/power/EM/acoustic leakage 与 physical key extraction |
| 或者，更暴力一点 | §22 | DRAM remanence、cold boot、full-disk encryption/TPM 边界 |
| Agents 时代的新安全问题 | §23 | direct/indirect prompt injection、ROP 类比、tool authority 与 sandbox |
| 供应链攻击：你甚至不能信任你的软件 | §24 | install hook、xz、source/build/artifact trust、SLSA/provenance |

### 30.1 课堂案例与细目审计

| PPT 案例/细目 | 对应位置 |
|---|---|
| 8086 `CS:IP`、firmware mapping、`int $x` | §2.1 |
| 病毒/加壳、CIH、BBS | §2.2–§2.4 |
| 快速格式化、邮箱/成绩、DDoS/fork bomb/hash table | §3–§5 |
| one-way/trapdoor、confidentiality/integrity 类比 | §6 |
| 狗/骨头 PoW、Ethereum、replica、无 confidentiality、killer application | §7 |
| process+VM/syscall 访问共享对象 | §8 |
| `(进程, 对象, 访问) → bool` 与 low-rank 玩笑 | §9 |
| uid=0、gid、mode、Android app UID | §10 |
| passwd 七字段、shadow、chsh/passwd、TOCTOU 图 | §11 |
| ruid/euid/suid/fsuid、`chmod +s`、`/bin/passwd` | §12 |
| ACL/xattr、SELinux/AppArmor、Capabilities、seccomp、LSM BPF | §13 |
| 非预期用户、AFL、OSS-Fuzz、LLM fuzzing | §14 |
| oversized `read`、UB、stack smashing、ROP gadgets 概念 | §15 |
| `vulnerable.c`/Stack Protector/ASLR | §16 |
| access control、ASLR/canary/NX/CFI/CET、auditd/Tetragon | §17 |
| TENEX password checker/timing | §18 |
| fault/transient array/cache、Meltdown/PTI | §19 |
| Downfall、Inception、GhostRace | §19.3 |
| 10 m/隔墙 flat-panel eavesdropping | §20 |
| Physical Key Extraction Attacks on PCs | §21 |
| 冷冻/拆内存的 cold boot（只讲威胁，不复现） | §22 |
| 奶奶漏洞、inject 链、ROP 类比、Agent 工具 | §23 |
| 假设 npm hook、social engineering、xz/liblzma/sshd/Ed448 build path | §24 |
