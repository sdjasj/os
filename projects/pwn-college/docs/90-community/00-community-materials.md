# Community Material：社区材料索引与学习路线

> 本页是依据 pwn.college 公开目录独立整理的中文导航，不是官方分类，也不是挑战题解。

- 来源快照：**2026-07-26（Asia/Shanghai）**
- 官方动态目录：[pwn.college Dojos — Community Material](https://pwn.college/dojos)
- 来源、许可与解答边界：[仓库 NOTICE](../../NOTICE.md)

## 1. 这份索引怎样使用

快照时，官网 Community Material 区域显示 **49 个入口**。官网以卡片平铺展示，没有把它们组织成本页的五类；下面的分类和“建议用途”都是为了帮助学习者选择路线而作的**编辑性整理**。材料的作者、维护状态、难度、许可证和教学目的可能各不相同，不能因为它们出现在同一个页面，就推定它们属于同一套课程或采用同一许可。

建议按下面的方法使用本页：

1. 先用本仓库 `00`—`07` 的主教程建立连续知识结构；
2. 再从一个社区专题进入，不要一次铺开几十个 dojo；
3. 打开入口后，先看其简介、模块列表、维护者、先修要求和来源仓库；
4. 遇到失效依赖、旧工具链或历史系统时，优先在隔离虚拟机或容器中复现；
5. 将社区材料当作补充视角与练习来源，不把其顺序当作官方主路径。

本页只记录快照时官网展示的名称和入口。若名称、内容或可用状态与本页不一致，以[当前官方目录](https://pwn.college/dojos)为准。

## 2. 完整分类索引

### 2.1 基础、工具与学习方法（10）

这组更适合在进入专门系统或漏洞方向前补齐命令行、编程、自动化和背景知识。

| 材料 | 建议用途（编辑性提示） |
| --- | --- |
| [pwn.college Archives](https://pwn.college/dojo/archive) | 查找历史材料；使用前核对它与当前平台、工具版本的差异。 |
| [Demo dojo](https://pwn.college/dojo/demo-dojo) | 熟悉 dojo、module 与 challenge 的页面组织方式。 |
| [Intro to Programming Languages](https://pwn.college/dojo/intro-to-programming-languages) | 补充程序语言概念，为阅读不同语言实现建立词汇。 |
| [The Art of the Shell](https://pwn.college/dojo/shell-lin-do) | 强化命令组合、管道和文本处理能力。 |
| [The Quarterly Quiz](https://pwn.college/dojo/quarterly-quiz) | 用作阶段性复盘；不要把单次测验范围当成永久大纲。 |
| [Desert CodeSprouts](https://pwn.college/dojo/codesprouts~a2cb8d41) | 偏入门的编程探索，可用于检查基础是否牢固。 |
| [DSU Cyber Camps](https://pwn.college/dojo/dsu-cyber-camp~aad191b4) | 营队式综合入口，适合作为主题浏览和基础复习。 |
| [Hacker History](https://pwn.college/dojo/hacker-history~43f7181b) | 补充技术史与安全文化背景，帮助理解术语来源。 |
| [Pwndamentals](https://pwn.college/dojo/pwndamentals~cfe9c1cb) | 综合巩固 pwn 基础；建议在主路径入门内容之后查看。 |
| [Pwntools Tutorials](https://pwn.college/dojo/pwntools~9b09c9dc) | 学习自动化进程与协议交互；先理解手工过程，再编写脚本。 |

### 2.2 架构、操作系统、内核与固件（9）

这组会明显受平台和工具链影响。进入前至少应能读基础汇编、使用调试器，并理解进程、虚拟内存和权限边界。

| 材料 | 建议用途（编辑性提示） |
| --- | --- |
| [ARM Architecture](https://pwn.college/dojo/arm-architecture) | 从指令集与调用约定切入 ARM，适合作为跨架构起点。 |
| [Windows Warzone](https://pwn.college/dojo/windows-warzone) | 进入 Windows 平台主题前，先补齐其对象、权限与调试模型。 |
| [XNU Dojo](https://pwn.college/dojo/xnu) | 面向 XNU 相关系统内容；需要较扎实的内核基础。 |
| [ARM Dojo](https://pwn.college/dojo/robwaz-dojo~289c5b68) | ARM 方向的另一社区入口，可与架构基础材料交叉学习。 |
| [DOS Dojo](https://pwn.college/dojo/dos-dojo~c41cb03a) | 观察历史执行环境；注意模拟器和旧工具的兼容问题。 |
| [Kernel Exercise Collection](https://pwn.college/dojo/kernel-exercise-collection~433e348b) | 集中练习内核概念；应在隔离环境中操作。 |
| [Linux Firmware Rehosting](https://pwn.college/dojo/rehosting~fbf8a0a3) | 了解固件重托管工作流；先掌握 Linux、网络和文件系统基础。 |
| [Linux Lunacy](https://pwn.college/dojo/linux-lunacy~9b739db1) | 扩展 Linux 系统主题，适合在 Linux Luminarium 之后探索。 |
| [x86 Exploitation](https://pwn.college/dojo/x86-exploitation~a6fb34db) | 聚焦 x86 语境下的利用知识；先完成汇编、调试和内存基础。 |

### 2.3 专门安全方向（9）

这组适合在主路径后选一个方向深入。标题相近不表示内容范围与本仓库同名章节完全相同。

| 材料 | 建议用途（编辑性提示） |
| --- | --- |
| [Cryptographic Exploitation](https://pwn.college/dojo/cryptomania) | 从实现和误用角度观察密码系统；先理解基础密码学概念。 |
| [Adversarial Machine Learning Dojo](https://pwn.college/dojo/adversarial-ml-dojo~3c016843) | 探索机器学习系统的对抗面；需要基本的模型与数据知识。 |
| [Content Injection](https://pwn.college/dojo/content-injection~24cec712) | 研究内容进入解释器或渲染链后的边界问题。 |
| [Fuzz Dojo](https://pwn.college/dojo/fuzz~c7f7b8c2) | 学习自动生成输入、观察崩溃和缩减样本的思路。 |
| [Privilege Escalation](https://pwn.college/dojo/privilege-escalation~6d04fe7a) | 聚焦权限边界；仅在自己拥有或明确授权的环境中实践。 |
| [Red Team Dojo](https://pwn.college/dojo/red-team-dojo~a9fb8d5a) | 了解红队工作流时同步学习授权范围、记录和处置规范。 |
| [RII Router Dojo](https://pwn.college/dojo/rii-router-dojo~ae00dd3a) | 面向路由器和嵌入式场景；建议先学网络与固件基础。 |
| [The House Always Wins](https://pwn.college/dojo/thaw~84f102b7) | 作为独立专题探索；先阅读入口说明再判断所需先修知识。 |
| [Web Security](https://pwn.college/dojo/web-security~f98637a0) | 扩展 Web 安全主题；先掌握 HTTP、会话、数据库和浏览器边界。 |

### 2.4 CTF、会议与活动归档（8）

这组材料常以活动时间和题目集合为中心，不保证拥有统一的知识递进。更适合学完相应基础后做综合检验。

| 材料 | 建议用途（编辑性提示） |
| --- | --- |
| [ACSAC CTFs](https://pwn.college/dojo/acsac-ctfs) | 按活动上下文浏览题目集合，先确认年份与依赖。 |
| [Advent of Pwn](https://pwn.college/dojo/advent-of-pwn) | 按系列节奏练习，适合阶段性综合复盘。 |
| [CTF Archive](https://pwn.college/dojo/ctf-archive) | 查找历史 CTF 材料；预期会遇到过时环境或链接。 |
| [Academy CTF v2](https://pwn.college/dojo/academy-ctf-v2~020f0262) | 活动型综合入口，宜在主路径之后按题目领域选做。 |
| [Arizona CTF 2025](https://pwn.college/dojo/az-ctf-2025~6fbdc1d4) | 2025 活动材料；结合题目所属方向选择先修教程。 |
| [Defcon 33 Defcon Academy Dojo](https://pwn.college/dojo/dc33-dca-dojo~49335f5f) | 会议配套入口；先读活动说明和环境要求。 |
| [DistrictCon pwn.college Challenges](https://pwn.college/dojo/districtcon~f1b3d7f0) | 会议挑战集合，适合在相关专题之后做迁移练习。 |
| [GCA CTF](https://pwn.college/dojo/gca-ctf~8018193d) | CTF 型综合材料；不要把入口顺序误当成课程先修图。 |

### 2.5 社区、叙事与实验性入口（13）

这一组主要按其独立命名和社区属性归拢，不表示难度较低或内容彼此相似。打开后应以各自页面的实际模块为准。

| 材料 | 建议用途（编辑性提示） |
| --- | --- |
| [aturt13 Dojo](https://pwn.college/dojo/aturt13-dojo~4fac9429) | 独立社区入口；先看模块列表，再映射到已学知识。 |
| [Fluffy's Adventure](https://pwn.college/dojo/fluffy~ea96493b) | 叙事式命名入口，可作为主路径后的探索材料。 |
| [Hanto Dojo](https://pwn.college/dojo/hanto-dojo~8c1cc454) | 独立社区入口；按其当前简介判断主题与先修要求。 |
| [Honors Dojo（入口 A）](https://pwn.college/dojo/honors-dojo~9d345510) | 官网同名卡片之一；以 URL 区分，不假定与另两项内容相同。 |
| [Honors Dojo（入口 B）](https://pwn.college/dojo/honors-dojo~28e0e34e) | 官网同名卡片之一；进入后核对维护者和模块。 |
| [Honors Dojo（入口 C）](https://pwn.college/dojo/honors-dojo~ef9ed69f) | 官网同名卡片之一；不要仅凭标题合并学习进度。 |
| [Hunter Dojo](https://pwn.college/dojo/m0nst3r-dojo~5b4ffee2) | 独立社区入口；适合在具备基础后按模块选学。 |
| [Hydra Dojo](https://pwn.college/dojo/hydra~792145b7) | 独立社区入口；先核对范围、依赖和安全边界。 |
| [imattas dojo](https://pwn.college/dojo/imattasdojo~894900d9) | 独立社区入口；以当前页面说明作为内容依据。 |
| [Kalevala](https://pwn.college/dojo/kalevala~64ddc78a) | 独立命名入口；适合作为完成主线后的主题探索。 |
| [Kitten Playground](https://pwn.college/dojo/kitten-dojo~d5c9bdf3) | Playground 型入口；先确认每个模块的目标和环境。 |
| [Pancake House](https://pwn.college/dojo/pancake-house~e3289d98) | 独立社区入口；按实际模块选择对应基础章节。 |
| [Westworld Dojo](https://pwn.college/dojo/westworld~d30d9828) | 独立社区入口；建议在主路径后以小范围试学。 |

合计检查：`10 + 9 + 9 + 8 + 13 = 49`。其中三个 Honors Dojo 是官网同时显示的三个不同入口，所以分别保留；同名不等于重复链接。

## 3. 为什么主教程不逐题改写这些材料

“完整索引”不等于“公开全部解法”。本仓库不会为上述 dojo 制作逐关答案，原因有五类。

### 3.1 官方明确请求不要公开挑战解答

[pwn.college 官网](https://pwn.college/)说明，这些挑战服务于学习和大学课程评分，并请求参与者不要发布解题文章、walkthrough 视频或解题直播。因此主教程不会给出 flag、精确输入、偏移、密钥、payload、solver 或可直接提交的答案。

### 3.2 社区材料没有统一的许可结论

社区入口可能来自不同作者、课程、会议和组织。被平台收录只说明有一个公开入口，不能据此推定所有题面、源码、图像、视频和讲义都可复制或翻译。任何实质性复用都必须逐项核对作者、来源仓库、许可证和第三方通知；更详细的判断见 [NOTICE](../../NOTICE.md)。

### 3.3 动态内容不适合固化成逐题教程

社区 dojo 可能新增模块、调整顺序、迁移仓库、隐藏旧挑战或改变运行环境。逐题复述很容易在页面更新后变成错误指引；按原理组织的教程则更容易迁移到新题目和新版本。

### 3.4 学习价值来自独立建模

安全题的关键训练是从现象建立假设、选择观测工具、验证边界并解释根因。若教程直接对应每一关给出下一条命令，读者得到的是输入序列，而不是可迁移的方法。本仓库因此使用自建玩具程序、回环服务、纸面推演和检查清单来讲机制。

### 3.5 真实目标需要授权和隔离

某些主题涉及提权、红队、固件、路由器、内核或漏洞利用。教程只支持在自有设备、隔离实验环境或具有明确书面授权的范围内练习。历史 CTF 镜像和旧工具还可能包含已知漏洞、弱默认配置或不再维护的依赖，不应直接暴露到公网或日常工作环境。

## 4. 建议的后续专题顺序

下面不是唯一排名，而是一条降低知识断层的默认路线。某个入口的当前模块如果列出更具体先修条件，应以入口说明为准。

### 第一步：完成连续主路径

依次学习本仓库 `00-start-here` 到 `07-software-exploitation`。至少应能使用 Linux 命令行、阅读基础 C 和汇编、理解进程与虚拟内存、使用调试器，并能解释常见 Web、密码和内存安全边界。

### 第二步：补齐工具与自动化

推荐顺序：**The Art of the Shell → Pwndamentals → Pwntools Tutorials → The Quarterly Quiz**。手工理解输入输出、进程状态和协议后，再把重复步骤自动化；脚本应记录判断依据，而不只是发送一串常量。

### 第三步：选择一个系统纵深

- 想学跨架构：先 **ARM Architecture**，再比较 **ARM Dojo** 与 **x86 Exploitation**；
- 想学操作系统：从 **Linux Lunacy** 扩展，再按兴趣进入 **Windows Warzone**、**DOS Dojo** 或 **XNU Dojo**；
- 想学底层设备：在系统与网络基础之后进入 **Kernel Exercise Collection**、**Linux Firmware Rehosting** 和 **RII Router Dojo**。

不要同时追三条线。选一条完成若干模块，并写下“执行模型、内存模型、权限模型、调试方式”四项对比，再切换平台。

### 第四步：选择一个安全专题

- Web 路线：**Web Security → Content Injection**；
- 软件测试路线：**Fuzz Dojo → 对应的程序安全或利用材料**；
- 密码路线：先复习数学和密码基础，再进入 **Cryptographic Exploitation**；
- 权限与攻防路线：**Privilege Escalation → Red Team Dojo**，全程坚持授权和记录边界；
- 新兴方向：具备机器学习基础后再进入 **Adversarial Machine Learning Dojo**。

### 第五步：用活动与归档做综合检验

完成对应专题后，再从 ACSAC、Advent of Pwn、CTF Archive、Academy CTF、Arizona CTF、Defcon Academy、DistrictCon 或 GCA CTF 中选一组。先按领域筛题，再设置时间盒，最后只复盘通用知识缺口。归档题出现旧版本行为时，要记录环境差异，不要把偶然兼容问题误认为漏洞原理。

### 第六步：自由探索社区叙事入口

其余社区 dojo 适合作为兴趣驱动的拓展。一次只试一个入口：先浏览模块标题，选一项与已有知识相邻的内容，完成后写一页“已知条件、观测、假设、验证、根因、防御”的复盘。这样即使材料风格不同，也能沉淀成统一的方法论。

## 5. 维护本索引时的核对清单

更新本页时应：

1. 以官网 Community Material 区域为准重新统计卡片；
2. 保留同名但 URL 不同的入口，并明确区分；
3. 对新增、删除、改名和 URL 变化记录新的快照日期；
4. 不从挑战页面复制题面、提示、flag 或解答；
5. 不把本页编辑性分类描述成官方分类；
6. 随机打开入口，核对重定向、维护者、模块和依赖；
7. 在复用任何内容前重新检查对应许可证。

---

[← 上一章：Software Exploitation](../07-software-exploitation/README.md) · [返回总目录](../../README.md) · [下一章：附录 →](../99-appendices/README.md)
