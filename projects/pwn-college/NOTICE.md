# 来源、归属与使用边界

## 1. 项目身份

本仓库是独立编写的中文网络安全原理教程，不是 pwn.college、Arizona State University（ASU）或其课程团队制作、审核或认可的官方教材。

`pwn.college` 名称仅用于说明课程脉络和资料来源。仓库没有使用该名称暗示合作、认证、隶属或品牌授权。若教程与官方页面存在差异，应以官方页面和当前课程要求为准。

本教程的正文组织、中文解释、示意图、纸面练习、答案和代码示例由本仓库独立编写或制作。代码只处理自建玩具数据、临时对象、`127.0.0.1` 回环服务或本机只读系统内省，不复制官方挑战程序，不给出站内 flag、逐关输入、solver、精确利用链或 walkthrough。

## 2. 来源快照

教程目录与资料边界核对日期为 **2026-07-26**，时区为 Asia/Shanghai。主要入口：

- [pwn.college 官网](https://pwn.college/)
- [当前 Dojo 总目录](https://pwn.college/dojos)
- [pwn.college GitHub 组织](https://github.com/pwncollege)
- [官方 Dojo 仓库索引](https://github.com/pwncollege/official-dojos)
- [当前挑战 monorepo](https://github.com/pwncollege/challenges)
- [官方 YouTube 频道](https://www.youtube.com/pwncollege)
- [本仓库的 Community Material 索引](docs/90-community/00-community-materials.md)

pwn.college 是持续更新的在线课程。模块名称、顺序、挑战数量、页面 URL、仓库结构和许可文件都可能在快照日期后变化。本仓库中的“当前”“官方课程范围”等表述只代表上述快照时点。

### 2.1 当前主学习路径

快照时，本教程参考下列官方路径：

1. [Start Here](https://pwn.college/welcome/)
2. [Linux Luminarium](https://pwn.college/linux-luminarium/)
3. [Computing 101](https://pwn.college/computing-101/)
4. [Playing With Programs](https://pwn.college/fundamentals/)
5. [Intro to Cybersecurity](https://pwn.college/intro-to-cybersecurity/)
6. [Program Security](https://pwn.college/program-security/)
7. [System Security](https://pwn.college/system-security/)
8. [Software Exploitation](https://pwn.college/software-exploitation/)

官方总目录说明这些 dojo 按先后关系设计。教程据此保留学习顺序，但不把动态挑战数量当成永久事实。

### 2.2 仓库迁移状态

快照时，课程内容正从多个独立 dojo 仓库迁移到 [pwncollege/challenges](https://github.com/pwncollege/challenges)。该仓库 README 也说明了旧多仓库结构和迁移过程。

例如，旧的 [linux-luminarium](https://github.com/pwncollege/linux-luminarium) 与 [computing-101](https://github.com/pwncollege/computing-101) 仓库已归档，而活跃内容逐步进入 monorepo。归档仓库、monorepo YAML 和在线页面可能短期不完全一致。因此本教程采用以下来源优先级：

```text
当前官方在线 dojo/module 页面
  -> 当前 monorepo 中对应 dojo.yml / module.yml
  -> 仍在维护的独立官方 dojo 仓库
  -> 已归档仓库，仅作历史和结构参考
```

教程维护者更新目录时，应同时记录访问日期；若需要精确复现来源，还应记录仓库 commit，而不能只保存会移动的 `main` 链接。

## 3. 官方关于挑战解答的规则

[pwn.college 官网规则](https://pwn.college/)说明，挑战首先是教学和大学课程评分材料，并请求参与者不要在互联网上发布挑战解题文章、walkthrough 视频或解题直播。

本仓库尊重这一规则，采用以下编辑边界：

- 不发布 flag 或可推导有效 flag 的材料；
- 不按关卡编号给出精确输入、偏移、地址、密钥、payload 或 solver；
- 不复制挑战题面后逐句提示下一步；
- 不上传挑战二进制、私有测试、官方解答或解密材料；
- 不把站内挑战截图、终端解题记录或完成路径当作教程；
- 不针对当前课程作业提供可直接提交的答案；
- 只讲可迁移的机制、分析方法、防御原则和独立玩具示例。

“公开可访问”不等于“适合公开解答”。即使某个挑战源码可见，本仓库仍不会把它改写成逐关答案。

教程读者若正在参加使用 pwn.college 的正式课程，还应遵守所在课程当期的学术诚信要求。课程规则可能比官网通用请求更严格。

## 4. 视频与幻灯片

[pwn.college 官网的 Sharing is Caring 说明](https://pwn.college/)允许在**非商业用途**中使用 pwn.college 讲座视频和幻灯片，并要求署名。

本仓库对这些材料采取保守方式：

- 仅链接官方视频、playlist、slide 或对应 module 页面；
- 不重新托管完整视频、幻灯片文件或整套截图；
- 不逐页翻译幻灯片并作为本仓库正文；
- 从讲座主题提炼课程脉络后，以新的结构、语言和示例独立讲解；
- 在每篇教程顶部就近链接对应官方 module；
- 不把官方视频、幻灯片或其中的第三方素材纳入本仓库自己的授权声明。

若要商业使用、重新分发完整素材、制作大规模翻译版幻灯片或以不明确的方式嵌入官方内容，应先通过官网提供的联系方式向权利人取得许可。

视频画面、幻灯片中的图片、字体、商标、代码和引用材料还可能分别属于其他权利人；pwn.college 对自身材料的使用说明不能自动覆盖所有第三方内容。

## 5. GitHub 仓库许可边界

### 5.1 默认分支根目录检测到许可证的仓库

快照核查时，下列相关仓库的默认分支根目录检测到名为 `LICENSE` 的文件，其内容为 BSD 2-Clause：

- [welcome-dojo LICENSE](https://github.com/pwncollege/welcome-dojo/blob/main/LICENSE)
- [linux-luminarium LICENSE](https://github.com/pwncollege/linux-luminarium/blob/master/LICENSE)
- [computing-101 LICENSE](https://github.com/pwncollege/computing-101/blob/main/LICENSE)
- [dojo 平台基础设施 LICENSE](https://github.com/pwncollege/dojo/blob/master/LICENSE)
- [example-dojo LICENSE](https://github.com/pwncollege/example-dojo/blob/main/LICENSE)

BSD 2-Clause 通常允许在满足其条件的前提下重新分发和修改受其覆盖的内容。源码形式再分发须保留版权声明、两项条件及免责声明；二进制形式再分发须在文档或其他随附材料中重现这些内容。根目录存在许可证仍不自动证明每个文件都由它覆盖，复用者必须检查目标文件、子目录声明和第三方通知。

本教程的编辑政策另外要求：直接复用时清楚标明所作修改，避免暗示上游背书，并继续尊重官网关于不公开挑战解答的教学请求。这些是本项目选择的边界，不应误写成 BSD 2-Clause 自带的附加条件。

本教程目前没有因为上述许可证而复制官方关卡实现；许可允许做某事与本项目选择是否做某事是两个问题。

### 5.2 默认分支根目录未检测到 LICENSE 的课程仓库

快照核查时，以下仓库的默认分支根目录未检测到名为 `LICENSE` 的文件：

- [pwncollege/challenges](https://github.com/pwncollege/challenges)
- [fundamentals-dojo](https://github.com/pwncollege/fundamentals-dojo)
- [intro-to-cybersecurity-dojo](https://github.com/pwncollege/intro-to-cybersecurity-dojo)
- [program-security-dojo](https://github.com/pwncollege/program-security-dojo)
- [system-security-dojo](https://github.com/pwncollege/system-security-dojo)
- [software-exploitation-dojo](https://github.com/pwncollege/software-exploitation-dojo)
- [official-dojos](https://github.com/pwncollege/official-dojos)

此列表只描述 2026-07-26 对默认分支根目录的观察，未固定 commit，不断言某个单独文件绝无其他许可，也不替代法律意见。维护者在任何复用前都应重新核查目标 commit、文件历史、子目录说明和第三方通知。

[GitHub 的仓库许可说明](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/licensing-a-repository)指出：公开仓库若没有许可证，默认版权规则仍然适用；GitHub 用户按平台条款拥有查看和 fork 等权利，但不能据此推定可自由复制、分发或创作派生作品。

据此，本教程不会大段复制或逐句翻译这些无统一许可仓库中的：

- `DESCRIPTION.md` 与挑战题面；
- `dojo.yml` / `module.yml` 内的实质性讲义正文；
- 挑战源码、模板、生成逻辑或测试；
- Discord 摘要、提示和官方解题思路；
- 图表、幻灯片截图或视频逐字稿。

模块名称、课程顺序、公开 URL 和挑战数量等必要事实可以用于建立索引；教程正文则重新组织原理，并采用自行设计的数据、代码和练习。

### 5.3 平台源码不等于课程内容

[pwncollege/dojo](https://github.com/pwncollege/dojo) 是平台基础设施仓库。它的 BSD 2-Clause 许可证不能自动外推为所有课程、视频、幻灯片或挑战内容的统一许可证。

同样，某个历史 dojo 仓库有 BSD 许可证，也不能自动证明迁移后的 monorepo、其他贡献者 dojo 或外部链接材料采用同一许可。许可应逐仓库、逐目录、必要时逐文件核对。

### 5.4 加密的解答和私有测试

[challenges monorepo README](https://github.com/pwncollege/challenges/blob/main/README.md)说明部分 solution 和 private tests 使用 `git-crypt` 加密，访问需要被授予相应密钥。

本仓库不会尝试绕过该访问控制，不会寻找泄漏的密钥，不会解密、还原或重新分发这些内容。公开仓库中出现加密文件并不构成解密授权。

## 6. Community Material 与第三方内容

[官方 Dojo 总目录](https://pwn.college/dojos)中的 Community Material 可能由 pwn.college 团队、社区成员、课程、会议或其他组织分别维护。出现在官方平台页面不代表它们共享同一作者、质量保证、维护周期或许可证。

本仓库的 [Community Material 索引](docs/90-community/00-community-materials.md)只记录快照时公开显示的名称与官方页面链接，并提供编辑性的学习分类。分类不是 pwn.college 官方分类，也不复制各 dojo 题目。

准备复用社区材料前，应分别检查：

- dojo 页面显示的维护者与来源仓库；
- 根许可证、子目录许可证和第三方依赖通知；
- 会议或 CTF 原始题目的再发布条款；
- 是否包含仍用于教学、竞赛或评分的挑战；
- 页面是否已经归档、隐藏、更名或被替换。

## 7. 本仓库的引用方式

每篇主教程应至少包含：

```text
对应官方模块：[模块名](官方 module URL)
```

若某个事实来自特定规范、手册或项目文档，应优先就近链接该一手来源。不要只在总参考文献中放一个官网链接，让读者无法判断哪项陈述由哪个来源支持。

若已另行取得转载或再发布本教程的授权，建议保留以下说明：

```text
本材料是独立编写的非官方中文教程，课程脉络参考 pwn.college。
不包含 pwn.college 挑战答案；官方材料与本教程分别受各自条款约束。
来源快照：2026-07-26。
```

本 `NOTICE.md` 用于说明来源和边界，不授予上游材料的任何额外权利，也不替代本仓库未来可能提供的项目许可证。

### 7.1 本教程自身的授权状态

当前仓库**没有附带项目级 `LICENSE` 文件**。因此，除适用法律允许的情形外，不能仅凭仓库可见就推定本教程正文与原创代码已获自由复制、修改或再发布授权。计划分发、翻译、改编或合并本教程时，应先向仓库权利人确认许可；仓库维护者若日后选择开源许可证，也应明确哪些原创文件属于该许可证范围，并继续排除上游和第三方材料。

上面建议保留的署名文字是引用格式建议，不构成许可授予。pwn.college、规范、项目文档及其他链接资料仍分别受其自身条款约束。

## 8. 安全示例与授权范围

教程中的安全代码遵循以下限制：

- 网络监听只使用 `127.0.0.1`，不绑定公网接口；
- 数据库使用内存数据库或自建虚构记录；
- 密码学中的固定密钥、小整数参数和固定盐均明确标为不可部署的玩具值；
- 越界、释放后使用等内存错误 C 程序只在本地用 sanitizer 观察；其他故意有缺陷的 C 示例也仅限无网络的玩具进程，并在正文标出风险；
- 不包含用于真实服务、设备或账户的凭据；
- 不鼓励对没有明确书面授权的系统扫描、拦截、利用或绕过访问控制。

概念性学习不构成对任意目标的测试授权。读者应在自己拥有的设备、隔离实验环境或明确授权范围内实践，并遵守适用法律、组织政策和协调披露流程。

## 9. 更新与纠错

后续维护时，应重新核对：

1. [官网规则与 Sharing is Caring 说明](https://pwn.college/)；
2. [Dojo 总目录](https://pwn.college/dojos)的主路径和 Community Material；
3. `pwncollege/challenges` 的迁移状态和根许可证；
4. 每个直接引用仓库的目标 commit 与许可证；
5. 归档仓库是否已有替代路径；
6. 本仓库是否误含官方题面、flag、solver、视频、幻灯片或第三方素材。

若发现归属、许可或课程规则描述不准确，应优先撤下有争议的复制内容，保留链接和原创概念讲解，再向权利人或项目维护者核实。

---

最后核对日期：**2026-07-26**。
