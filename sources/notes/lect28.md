# 计算机安全简介

## 1\. 什么是计算机安全

# 回到美好的 “裸奔” 时代

## 8086, Real-Mode

  - 16-bit CS, 16-bit IP, PC = (CS \<\< 4) + IP (1 MB 寻址能力)
  - Firmware code 直接映射到地址空间中
      - `int $x` → `(*(void (*)() *)(4 * x))()` 😂
      - 16-bit 时代的 “[系统调用](https://wiki.osdev.org/BIOS)”

## 完全没有任何安全可言

  - 任何程序都可以访问**任何硬件**
      - 病毒：复制自己，然后感染更多的计算机 (“加壳”)
      - 例子：CIH 能破坏硬件的病毒

## BBS 的裸奔时代

  - [南京大学小百合](https://xiaobao.nju.edu.cn/d4/01/c18184a316417/page.htm)；今天依然还有活着的 `newsmth.net`

### 1.1. 信息安全三要素

# 保密性 Confidentiality

## 不想给别人看的，别人就看不到

  - 快速格式化：这个问题我懂

![](../site_html/static/img/leaked-photo.jpg)

# 完整性 Integrity

## 不想让别人改的，别人就改不了

  - 科创板首位 90 后 (你们的师兄)：“如何通过入侵老师邮箱拿到期末考卷和修改成绩”

![](../site_html/static/img/ljk.jpg)

# 可用性 Availability

## 我的服务，别人不能让我用不了

  - (Distributed) “Denial-of-service” 攻击
      - Fork bomb: `:(){ :|: & };:`
      - [Algorithmic complexity attack](https://ocert.org/advisories/ocert-2011-003.html)
      - 例子：[Hash table](https://nvd.nist.gov/vuln/detail/CVE-2011-4858) (影响几乎所有语言：Java, Python, PHP, Ruby, Node.js……)

![](../site_html/static/img/ds-busy.png)

### 1.2. Aside: 一分钟密码学

# 一分钟密码学

## One-way functions

  - 有一个正向好算、逆向难算的 f(x) = y
  - 例子：密码学哈希 (SHA-256, …)，表现得近乎 “完全随机”

## Trapdoor one-way functions

  - 多了个 “后门” t，有了 t 之后，f(x) = y 逆向又好算了
  - 正过来用 (confidentiality): Alice 公开 f → Bob 公开传输 f(m) → Alice 解密得到 m
  - 反过来用 (integrity): Alice 公开 f → Bob 发送一个随机的 c → Alice 用 t 求解 f(r) = c，公开 r → 任何人都可以验证 f(r) = c (证明 Alice 有 t)
      - 把 c 换成任意文件的哈希，就实现了数字签名

![](../site_html/static/img/trapdoor.png)

# 应用：区块链

## 一个全球共享的 (低效) append-only log

  - 任何一只 (想 append) 的 🐶 都可以向一个随机的位置扔一个世界上独一无二的 🦴
  - 其他 🐶 听到了，只能随机去捡，谁花的时间更多，谁就能捡到 (proof-of-work)
  - 捡到 🦴 的 🐶 把 🦴 和数据一起 append 到链上，取走自己的奖励，然后广播
      - 捡到骨头很难，使得 append 变得困难，从而减少分布式分叉
      - 这个协议可以是任何程序 (Ethereum)
  - 去中心化还带来了 availability (全世界都是 replica)
      - 不过没有 confidentiality (就是为了分布式共识而设计的)

## Killer Application

  - 洗钱 (当时想通这一点的人就都财富自由了)

> 调查人员在释永信住处搜出了一串佛珠。佛珠上刻着 24 个英文单词——那是一个比特币冷钱包的助记词。钱包里有价值约 1.3 亿美元的比特币。

## 2\. 访问控制

# 实现 Confidentiality 和 Integrity

## 进程 + 虚拟内存已经实现了隔离

  - 进程只能以 ELF 规定的权限访问自己的虚拟地址空间
  - 一切对操作系统世界里的 “共享” 对象**访问**，都通过系统调用
      - (假设，内核没有被漏洞攻破)

## 访问控制：限制程序对操作系统对象的访问

  - 拒绝越权访问 → Confidentiality
  - 拒绝越权修改 → Integrity
  - 公平的系统调用实现 → Availability

# 访问控制原理：一张表

| 进程   | 对象             | 访问    | 权限 |
| ---- | -------------- | ----- | -- |
| 1    | /etc/passwd    | read  | ✅  |
| 1    | /etc/passwd    | write | ✅  |
| 4132 | /etc/passwd    | write | ❌  |
| 4132 | /tmp/hello.txt | write | ✅  |

## “谁能怎么访问什么”

  - 越权访问，直接返回 EACCESS (Permission denied)
  - 缺点：这个表**非常大**，而且很难维护
      - 做一个 low-rank decomposition 可以吗？

# UNIX: 用整数表示身份

## uid, gid, mode

  - uid = 0 → root, 其他都是 “普通用户”
      - root 可以访问所有对象，也可以 setuid
      - 子进程继承父进程的 uid
  - gid “完全自由” (虽然一般 0 是 root)
      - 一个用户可以属于多个组
  - mode: r, w, x 的权限
      - 例子：owner 只写不可读，audit 组可以读的日志文件

## 操作系统完全看不到用户名

  - 通过 setuid, setgid, chmod 系统调用实现访问控制 💡
  - Android: 每个 app 都是不同的用户

# /etc/passwd: 每行一个用户

## username:password:uid:gid:comment:home:shell

  - 现代系统通常使用 shadow 文件存储密码的 hash
  - chsh, passwd 只是直接修改了文件 😂
      - 操作系统就真的只管 uid，不管如何解读 “用户”

![](../site_html/static/img/tocttou.png)

# UID：没有那么简单

## 没有 system (abstraction) 能逃脱成为 💩⛰️

  - Real uid (ruid)
  - Saved uid (suid)
      - 为了实现 “恢复权限” 而设计
  - Effective uid (euid)
      - 这是实际访问控制使用的 uid
  - Filesystem uid (fsuid)
      - 用于独立控制文件系统访问权限 (Since Linux 1.2)
      - 内核内部仍使用，但应用程序极少独立设置
  - setuid 机制：`chmod +s` (ls -l /bin/passwd)
  - [Setuid demystified](https://www.usenix.org/conference/11th-usenix-security-symposium/setuid-demystified)

# 回到访问控制

## 我们希望的是维护任意的 access control matrix

  - (进程、对象、访问) → bool
  - uid, gid, mode 并不是实现访问控制的唯一方法

## 从这个 matrix 里可以 “切割” 出一部分进行控制

  - Access Control List; acl (5)
      - 以文件为单位，支持为用户和组分别设置权限
      - 基于 xattr 实现
  - SELinux/AppArmor; apparmor (7)
      - 更细粒度的对象级访问控制
  - Capabilities
      - 行为类的切片
      - `capsh --drop=cap_net_raw -- -c 'ping 127.0.0.1'` (注意这是 fail on execve; getcap 查看 capabilities)
  - 我们能不能直接写一个 access control function?
      - 有的：seccomp (2); [LSM BPF](https://docs.kernel.org/bpf/prog_lsm.html); Linux Kernel 5.7+

## 3\. 软件系统安全

# 找到 “意外” 的行为

## 程序中隐藏着万千 “无人理解” 的路径

  - [你永远无法预期你的用户会如何使用你的产品](https://jyywiki.cn/OS/img/drink-water-user-friendly.gif)
  - 更不要说 “恶意” 的使用了

## Fuzz Testing: 让魔法打败魔法

  - 自动生成大量 “非预期” 输入，观察程序是否你如异常状态
      - 如果找到 memory corruption 等，也许能捡到可以利用的漏洞呢！
      - 例子：[AFL](https://lcamtuf.coredump.cx/afl/)
      - 例子：[OSS-Fuzz](https://google.github.io/oss-fuzz/): 持续 fuzz 开源项目
          - 已发现 10,000+ 漏洞
          - Linux kernel, OpenSSL, Python, Chromium 等均参与
  - LLM 入场后：海量的 0day 😂

# 攻破一个进程

## 一个有趣的 corner case

  - `read(fd, buf, size);` 读入了比 buffer 更大的数据？
  - 如果没有 Segmentation Fault 呢？

## Undefined behavior 不是和大家开玩笑的 😈

  - 1996 年 [Smashing The Stack For Fun And Profit](https://inst.eecs.berkeley.edu/~cs161/fa08/papers/stack_smashing.pdf) 开启了全新的世界
      - [x86-64 当然也可以](https://dl.packetstormsecurity.net/papers/attack/64bit-overflow.pdf)
      - Memory error 贡献了巨量的计算机系统漏洞
  - Return-oriented programming
      - 可执行内存中有大量以 ret 结尾的 “gadgets”
          - `pop rdi; ret` → 控制 rdi (第一个参数)
          - `pop rsi; ret` → 控制 rsi (第二个参数)
          - 最后一次返回到 execve，攻击完成

# [Stack Buffer Overflow](/OS/demos/intro/stackoverflow)

当输入的长度超过缓冲区大小时，vulnerable.c 的行为就变得危险。如果没有各类保护机制 (Stack Protector, ASLR 等)，这个程序就完全可以被利用执行任意代码。

# 防御一个进程

## 我们至少可以减少攻击面

  - 访问控制 (禁止对越权对象的访问)
  - 执行保护 (使漏洞难以利用)
      - 随机地址空间 (ASLR)、内存保护 Canary (stack protector), NX-bit (no execute), 控制流完整性 CFI/Intel CET (endbr64 = Indirect Branch Tracking), …
  - 审计与阻断
      - auditd: 程序只能按照 “预期” 的方式访问对象; [Tetragon](https://tetragon.io/)

![](../site_html/static/img/canary.jpg)

# 防了，没完全防住 😭

## 所有看起来都 “合法” 的访问，也可能存在非法行为

  - Tenex: Authentication system call

    int check_password(__user char *given_pass) {
        ...
        for (i = 0; i <= strlen(correct_pass); i++)
            if (correct_pass[i] != given_pass[i]) {
                sleep(3);
                return EACCESS; // access denied
            }
        return 0;
    }

# 看似精妙的设计，实际……

## Timing side channel

    raise_exception();  // even an HTM abort
    uint8_t volatile x = probe_array[data * 4096];

  - Tenex: 天道好轮回 😊 这下惨了，只能 Page Table Isolation 了 (PTI)

## Meltdown 只是个开始

  - [Downfall](https://downfall.page) (CVE-2022-40982): Intel Gather 指令优化漏洞，跨用户/内核/VM 泄露数据
  - [Inception](https://comsec.ethz.ch/wp-content/files/inception_sec23.pdf) (CVE-2023-20569): AMD Zen 分支预测器攻击
  - [GhostRace](https://www.vusec.net/projects/ghostrace/): 利用 Speculative Race Conditions，影响 Intel/AMD/ARM

![](../site_html/static/img/meltdown-exploit.jpg)

# 你甚至看不见你的对手在哪 (1)

## 超视距窃听

  - [Electromagnetic eavesdropping risks of flat-panel displays](https://www.cl.cam.ac.uk/~mgk25/pet2004-fpd-slides.pdf); 天线和显示器相距 10m，间隔三层石膏板

![](../site_html/static/img/crt-remote.jpg)

# 你甚至看不见你的对手在哪 (2)

## 不仅可以 “看” 你的屏幕，还可以 “看” 你的 CPU

  - [Physical key extraction attacks on PCs](https://dl.acm.org/doi/10.1145/2851486)

![](../site_html/static/img/sidechannel.jpg)

# 或者，更暴力一点

## 把内存条冷冻以后拆下来

  - [Cold boot attack](https://www.usenix.org/legacy/event/sec08/tech/full_papers/halderman/halderman.pdf)

![](../site_html/static/img/coldboot.jpg)

## 4\. Agent 时代的新安全威胁

# Agents 时代的新安全问题

## Prompt Injection (jailbreak)

  - LLM 已经被微调成安全了
  - 但总有一些 “ignore all previous instructions” 的方法
      - “奶奶漏洞”

## 在 Agent 能调用工具的时候就更重要了

  - 像 rop 一样，每次 inject 一点，最后就成了一个可以遵循的恶意指令
  - 无法绝对防御，只能通过沙箱/访问控制解决

![](../site_html/static/img/grandma.png)

# 供应链攻击：你甚至不能信任你的软件

## 你只需要通过社会工程学获得 Github Repo 的访问

  - 直接推送攻击的版本
      - 创建一个新的 npm package (`plain-crypto-js@4.2.1`)
          - (有危险的 installation hook)
      - 发布一个新版本，混着 feature，加上这个依赖
  - 卧薪尝胆: [xz-utils 后门](https://en.wikipedia.org/wiki/XZ_Utils_backdoor)
      - 攻击者 “Jia Tan” 花 2-3 年建立贡献者信任
      - 在 liblzma 构建系统中注入混淆恶意代码
      - 通过 systemd 影响 sshd，Ed448 密钥实现远程代码执行
          - (要不是性能 bug，影响就大了)
