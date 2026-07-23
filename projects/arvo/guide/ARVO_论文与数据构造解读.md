# ARVO：论文、源码与数据构造解读

> 论文：*ARVO: Atlas of Reproducible Vulnerabilities for Open-Source Software*  
> 作者：Xiang Mei 等  
> 会议：IEEE EuroS&P 2026（Distinguished Paper Award）  
> 本文核验日期：2026-07-22  
> 阅读版本：arXiv 2408.02153v2 / 14 页 EuroS&P 版本

## 0. 这份文档研究了什么

这不是对摘要的翻译，而是把三层材料对在一起后的学习笔记：

1. 论文 v2：作者提出了什么、实验数字如何理解、结论边界在哪里。
2. 生成代码：OSS-Fuzz issue、source map、PoC、历史构建、补丁搜索和 Docker 镜像究竟怎样串起来。
3. 发布制品：对官方 v3.0.0 SQLite 数据库和论文评估仓进行实查，判断哪些结果能够复算，哪些环节没有公开。

本地材料固定在以下快照，避免日后上游更新导致本文与代码错位：

| 材料 | 本地位置 | 固定版本 |
|---|---|---|
| 论文 PDF | [2026155803.pdf](../arvo-upstream/2026155803.pdf) | 2026 EuroS&P 版，14 页 |
| 数据生成源码 | [arvo-upstream](../arvo-upstream/) | <code>bceb742e4a8e563f0d53ea2e000496d85291168c</code> |
| 数据说明仓 | [arvo-meta](../arvo-meta/) | <code>588baee081fce79267d5b3df20a5aeb055869635</code> |
| 论文评估仓 | [arvo-evaluation](../arvo-evaluation/) | <code>c213f61599ce5f384c1305edbcf0658758b7f1d6</code> |
| v3.0.0 数据库 | [arvo-meta-v3.0.0.db](../arvo-meta-v3.0.0.db) | SHA-256：<code>331184ca807c2f136f98dac9f1df94c893f4ee2fdf9329dca517ff88e72f97ce</code> |

权威在线入口：

- [arXiv 主记录 2408.02153](https://arxiv.org/abs/2408.02153)
- [EuroS&P 2026 接收与获奖页](https://www.ieee-security.org/TC/EuroSP2026/accepted_and_awards.html)
- [生成源码 n132/ARVO](https://github.com/n132/ARVO)
- [数据仓 n132/ARVO-Meta](https://github.com/n132/ARVO-Meta)
- [v3.0.0 Release](https://github.com/n132/ARVO-Meta/releases/tag/v3.0.0)
- [评估材料 sefcom/ARVO](https://github.com/sefcom/ARVO)
- [Docker Hub n132/arvo](https://hub.docker.com/r/n132/arvo)

注意：arXiv 2606.17283 是一次重复投稿，作者已撤回并说明正确条目是 2408.02153。旧的 v1 又只有 5,001 个补丁、273 个项目，内容与 v2 明显不同；本文只使用 v2。

---

## 1. 先说结论

ARVO 不是漏洞发现器。它更像 OSS-Fuzz 之上的“历史漏洞重建与证据化层”：

> 输入一条旧的 OSS-Fuzz 崩溃记录，恢复当时的主项目、全部依赖、OSS-Fuzz 构建脚本和基础镜像；用原 PoC 验证旧版本会崩溃、后续版本不再崩溃；再在两个端点之间逐提交构建和测试，寻找最早让 PoC 停止触发的提交。

它的核心贡献不是某个全新的分析算法，而是把五件很难长期稳定工作的工程任务组成了一条可规模运行的证据链：

1. 恢复历史源码与构建环境。
2. 固定主项目之外的所有组件。
3. 修复多年后已失效的下载地址和构建步骤。
4. 用同一 PoC 对 vulnerable/fixed 两端做动态验证。
5. 把昂贵的“每个候选提交重新构建并执行”包装成补丁定位器。

最重要的五个阅读要点是：

- ARVO 所谓 reproducible 是“能从源码重建并重新触发”，不是二进制逐字节相同的 reproducible build。
- 一条 ARVO 记录的粒度是一个 OSS-Fuzz issue/crash/PoC，不必然等于一个独立漏洞根因。
- 论文的 81% 是随机 100 条对照实验的成功率；已发布全量结果是 <code>6,138 / 8,921 = 68.8%</code>，约 69%。
- 89.4% 是对 300 条分层人工样本加权推断出的补丁准确率，不是人工逐条确认了全部 6,138 条。
- 发布物证明了算法骨架和成功结果，但缺少假阳性清单、失败日志、全量调度入口和 release 生成清单；公开仓库目前不能一键从零重建同一份数据集。

---

## 2. 论文要解决的研究问题

### 2.1 漏洞数据集长期存在“三选二”

作者把数据集质量归纳成三项：

- quantity：数据量；
- diversity：项目、依赖和漏洞类型的多样性；
- reproducibility：能恢复源码和环境，并可靠重触发。

人工构造的数据通常真实、可靠，却很难扩大规模；自动注入或合成的数据规模大，但真实性和标签质量不足；从真实项目挖出的历史漏洞很多，却常常缺少能重新编译、运行和验证的完整环境。

传统漏洞库主要回答“哪个版本受影响、维护者该打哪个补丁”。安全研究却还需要：

- 实际触发输入；
- 可重建的历史环境；
- 能执行的 vulnerable/fixed 对；
- 候选修复是否真的阻止原 PoC 的反馈信号。

ARVO 要补上的正是这层执行证据。

### 2.2 为什么 OSS-Fuzz 有数据，却仍难复现

OSS-Fuzz 会持续保存 issue、PoC、构建信息和部分归档产物，但多年后从源码恢复旧版本会遇到：

1. **依赖漂移**：只回滚主仓库，依赖却保持最新，API 或构建接口已经不兼容。
2. **构建环境漂移**：基础镜像、编译器、系统包和 OSS-Fuzz 项目配置都变了。
3. **资源腐烂**：Git 地址迁移、HTTP 下载失效、压缩包消失。
4. **初始化状态丢失**：若在容器构建完成后才替换源码，Dockerfile 中与下载同时发生的初始化可能已经不可逆。
5. **补丁端点粗糙**：OSS-Fuzz 通常按批次或每日检查，只能给出“某次构建还崩、下一次构建不崩”的提交区间，区间末端不一定是真正补丁。

论文的 ImageMagick 示例很典型：官方标注的 fixed endpoint 只是更新 ChangeLog，真正修复在区间内更早的位置。

### 2.3 “完全复现”的操作性定义

论文把复现资源与复现流水线分开：

- Reproducing Resources：报告、全部组件源码、构建环境、脚本、PoC、已有二进制、补丁等。
- Reproducing Pipeline：能用这些资源重演预期行为，并尽量容忍资源缺失。

在 ARVO 中，一条记录通过以下行为测试才算成功：

1. vulnerable 端能从源码构建；
2. 原 PoC 在 vulnerable 端触发 crash；
3. fixed 端能从源码构建；
4. 同一 PoC 在 fixed 端不再 crash。

这里没有要求两次构建生成相同哈希，也没有形式化证明根因已经修复。

---

## 3. 系统全景：一条记录怎样产生

~~~mermaid
flowchart TD
    A[OSS-Fuzz verified vulnerability issue] --> B[抓报告字段与 PoC URL]
    A --> C[下载 regression / verified-fixed 两个 source map]
    B --> D[用 OSS-Fuzz 归档二进制筛查上游假阳性]
    C --> E[恢复历史 OSS-Fuzz 配置和基础镜像]
    E --> F[固定主项目及所有依赖 revision]
    F --> G[修复迁移仓库、失效 URL 与构建脚本]
    B --> H[下载 PoC]
    G --> I[构建 vulnerable 端]
    H --> I
    I --> J{PoC 是否 crash}
    J -- 否 --> X[失败，不进入发布 DB]
    J -- 是 --> K[构建 verified-fixed 端]
    K --> L{同一 PoC 是否不再 crash}
    L -- 否 --> X
    L -- 是 --> M[在两端主仓 revision 之间搜索提交]
    M --> N[候选提交逐个重建并跑 PoC]
    N --> O[定位最早不再 crash 的提交或提交范围]
    O --> P[生成 vul/fix 镜像，嵌入源码、PoC、编译脚本]
    P --> Q[成功记录写入 arvo.db]
~~~

这条图中有三个容易混淆的 revision：

| 名称 | 含义 |
|---|---|
| vulnerable endpoint | OSS-Fuzz 首个或某个已知可触发构建的主项目 revision |
| verified-fixed endpoint | OSS-Fuzz 后来验证 PoC 不再触发的构建 revision |
| located patch | ARVO 在两端之间找到的、最早让 PoC 停止触发的提交 |

fixed 镜像按第二个 source map 构造；数据库中的 <code>fix_commit</code>/<code>patch_url</code> 则指第三项。二者经常不是同一个提交。

---

## 4. 从代码还原数据构造过程

以下路径都基于固定源码提交 <code>bceb742...</code>。

### 4.1 第一步：抓取 OSS-Fuzz issue 元数据

入口在 [utils_meta.py](../arvo-upstream/arvo/utils_meta.py)：

- <code>getIssueIds()</code>（57–101 行）访问新 issue tracker 391，按年份分页查询。
- 当前代码的查询是 <code>type:vulnerability status:verified</code>，每页 500 条；某年达到 2,500 条会直接退出并提示需按月拆分。
- <code>meta_getIssue()</code> 与 <code>parse_oss_fuzz_report()</code>（103–193 行）抓 issue events，并用正则提取字段。
- 结果逐行追加写入 [metadata.jsonl](../arvo-upstream/arvo/NewTracker/metadata.jsonl)，中断后可以按已有 localId 续跑。

单条原始记录包含：

| 字段 | 作用 |
|---|---|
| <code>localId</code> | 新 tracker issue ID |
| <code>project</code> | OSS-Fuzz 项目 |
| <code>job_type</code> | fuzz engine、sanitizer、架构和项目编码 |
| <code>crash_type/address</code> | 上游报告的崩溃类型与地址 |
| <code>severity</code> | 安全严重性 |
| <code>regressed</code> | vulnerable 构建 revision URL |
| <code>verified_fixed</code> | 后续不再触发的 revision/range URL |
| <code>reproducer</code> | PoC 下载 URL |
| <code>fuzz_target</code> | 目标二进制 |

论文写的旧 tracker 条件是 <code>Type=Bug-Security + label:Reproducible + status:Verified</code>；当前新 tracker 代码只写 <code>type:vulnerability + status:verified</code>。这更可能是 tracker 迁移后的字段语义变化，不能简单判为论文错误，但复现实验时必须记录所用 tracker 与查询。

当前本地原始元数据实查：

- 10,440 行，379 个 project 名；
- libFuzzer 8,003、AFL 1,737、Honggfuzz 700；
- address 7,135、memory 2,251、undefined 1,054。

### 4.2 第二步：下载两个 source map

仍在 [utils_meta.py](../arvo-upstream/arvo/utils_meta.py)：

- <code>parse_job_type()</code>（195–219 行）解析 engine/sanitizer/architecture。
- <code>download_build_artifacts()</code>（221–305 行）据此选择 <code>clusterfuzz-builds*</code> GCS bucket。
- 当前循环只下载 <code>*.srcmap.json</code>；下载构建 zip 的代码已被注释。
- <code>data_download()</code>（306–344 行）分别从 regression 与 verified-fixed URL 下载一个 source map，并要求是 C/C++ issue。

source map 不是源码压缩包，而是一张“当次构建用了哪些源”的清单：

~~~json
{
  "/src/muparser": {
    "type": "git",
    "url": "https://github.com/beltoforion/muparser.git",
    "rev": "dd0efc8a..."
  },
  "/src/afl": {
    "type": "git",
    "url": "https://github.com/google/AFL.git",
    "rev": "82b5e359..."
  }
}
~~~

当前仓库中：

- [NewTracker/Issues](../arvo-upstream/arvo/NewTracker/Issues/) 有 10,424 个 issue 目录；
- 每个现存目录恰有两个 source map，共 20,848 个；
- 另有 16 条 JSONL 元数据没有对应目录。

这也说明数据不是一个单文件：issue 描述在 JSONL，完整组件 revision 在 source map，PoC 仍由 URL 获取。

### 4.3 第三步：筛查 OSS-Fuzz 上游假阳性

实现位于 [utils_detector.py](../arvo-upstream/arvo/utils_detector.py)：

1. <code>_false_positive()</code>（468–567 行）下载 OSS-Fuzz 当时归档的 vulnerable/fixed 两套目标二进制。
2. 下载同一个 PoC。
3. 在 runner 镜像中分别执行。
4. 只有结果严格为“旧端 crash、新端不 crash”才当作行为正确的候选；行为不匹配归入上游假阳性，基础设施错误则保留为“无法判断”。
5. 判断写进本地 <code>upstream_false_positives.db</code>，表定义在 29–52 行。

这个步骤很关键：它把“ARVO 无法重建”与“上游原始二进制本来就不支持报告中的行为”区分开。

但公开制品存在断点：

- <code>upstream_false_positives.db</code> 被 gitignore，没有发布；
- 1,519 个确认排除 ID 和逐项理由没有完整公开；
- 干净 checkout 只能新建空表；
- 因此图 5 从 10,440 到 8,921 的筛选无法由现有公开材料逐项重放。

论文 §6.3 报告 1,519 个确认的上游错误；引言却写 1,518，这是明显的差一口径。Ethics 又写 2,381 个 potential false positives，论文没有交代它与 1,519 个 confirmed 的集合关系。

作者把确认问题大致分成三类：不稳定 crash/OSS-Fuzz 基础设施问题、真正补丁落在上游给定范围之外、以及最新代码仍能触发而其实尚未修复；其中 300 多个“最新版本仍有问题”的案例被反馈给上游。

### 4.4 第四步：重建历史 vulnerable/fixed 环境

主逻辑在 [reproducer.py](../arvo-upstream/arvo/reproducer.py)。

#### 恢复历史 OSS-Fuzz 配置

<code>reproducerPrepareOssFuzz()</code>（51–82 行）：

- clone OSS-Fuzz；
- 若 source map 有 <code>/src</code> 对应的 OSS-Fuzz revision，就直接 checkout；
- 否则取 issue 时间之前最近的 OSS-Fuzz commit；
- 同时兼容早期 <code>targets/</code> 与后来 <code>projects/</code> 目录。

这一步恢复的是“当时如何构建这个 fuzz target”，不只是项目代码。

#### 匹配历史基础镜像

<code>build_fuzzer_with_source()</code> 在构建前调用
[utils_core.py](../arvo-upstream/arvo/utils_core.py) 的 <code>rebaseDockerfile()</code>（141–180 行），从维护的历史 base image digest 列表中选择目标时间之前最近的一项。

论文消融实验称这个机制为 Matching Base Environment（BE）。

#### 固定全部组件，而不只固定主仓库

<code>build_fuzzer_with_source()</code>（102–284 行）遍历 source map 的所有组件：

- 根据 path、URL、VCS type 和 revision 处理 Git/Hg/SVN；
- 优先在原始 Dockerfile 中最小插入 checkout；
- 无法安全改写时，才在宿主 clone 后挂载进构建容器；
- revision 不可达时可退化为按时间选择邻近提交。

论文认为这是相对官方 reproducer 最重要的差异。其理由是多组件项目中，主项目和依赖的历史 API、生成脚本、子模块状态往往必须共同回滚。

#### 修复资源腐烂与项目特例

两类代码共同承担修复：

- [transform.py](../arvo-upstream/arvo/transform.py)：维护迁移仓库表、旧 URL 到新 URL 的替换、移除不再需要的 corpus 仓库、去掉 shallow clone 等。
- [utils_core.py](../arvo-upstream/arvo/utils_core.py)：大量按项目、时间和构建脚本编写的特例。

论文把资源分为 core 与 non-core：

- seed corpus、文档工具等 non-core 资源可跳过；
- 依赖库、构建工具等 core 资源要找到新地址并形成可复用规则。

论文称八年中共修复 53 个唯一失效资源，平均每年约 7 个。因此“每条漏洞的流水线自动化”基本成立，但整个系统不是零人工维护。代码现实也比论文抽象描述更杂乱：当前规则表中有相当多项目特例，这是长期兼容真实工程不可避免的成本。

### 4.5 第五步：PoC 双端行为验证

<code>verify()</code> 位于 [reproducer.py](../arvo-upstream/arvo/reproducer.py) 455–571 行：

1. 拒绝已知上游假阳性。
2. 要求恰好两个 source map。
3. 下载 PoC。
4. 构建旧 source map；若 PoC 不 crash，则失败。
5. 构建新 source map；若 PoC 仍 crash，则失败。
6. 仅当两端都符合预期时，才允许保存镜像。

实际 crash 判据在 [utils.py](../arvo-upstream/arvo/utils.py) 的 <code>pocResultChecker()</code>（698–725 行）：

- 正常退出、timeout、OOM 被当作“不 crash”；
- 其他非零退出通常被当作 crash；
- 没有强制比较上游记录的 crash type、地址或堆栈。

所以 ARVO 的动态证据是：

> 同一输入在这两个重建环境里呈现 crash → no-crash 转换。

它没有证明 crash 必然来自同一根因；fixed 端不崩也可能是 harness、编译选项或代码可达性改变。论文把这点列为局限，人工分析也发现它是补丁误报的重要来源。

### 4.6 第六步：构造交互式镜像

[reproducer.py](../arvo-upstream/arvo/reproducer.py) 的 <code>saveCommand()</code> / <code>pushImgRemote()</code>（383–454 行）会：

- 把源码、依赖和 <code>/out</code> 编译产物复制进最终容器；
- 把 PoC 放到 <code>/tmp/poc</code>；
- 写入 <code>/bin/arvo</code>；
- 支持 <code>arvo</code> 执行 PoC，<code>arvo compile</code> 重新编译；
- 生成 <code>n132/arvo:&lt;id&gt;-vul</code> 与 <code>&lt;id&gt;-fix</code> 两个 tag。

论文的 6,138 条成功记录由此对应 12,276 个 vul/fix 镜像。

数据库中保存的是 tag 命令，不保存 image digest。tag 可变，所以严格实验应该额外记录拉取日期与 <code>RepoDigest</code>。

### 4.7 第七步：动态搜索补丁

主逻辑在 [Locator.py](../arvo-upstream/arvo/Locator.py)：

- <code>list_commits()</code>（156–185 行）从两张 source map 的主项目 revision 列出候选提交；精确 ancestry 失败时按时间范围回退。
- <code>checkBuild()</code>（56–90 行）为候选 commit 生成临时 source map，完整构建，再执行 PoC。
- <code>dichotomy_search()</code>（97–155 行）做递归二分。
- <code>vulCommit()</code>（186–319 行）组织主仓搜索并处理边界。
- 320–360 行另有 submodule 搜索。

二分判定是：

- PoC 仍 crash：补丁在更晚一半；
- PoC 不 crash：补丁在当前或更早一半；
- 候选无法构建：把该提交与相邻候选合并，并消耗容错预算；
- 构建失败过多时，可能只给出提交范围。

它不是普通的 <code>git bisect</code>：每一步都要恢复环境、编译整个 fuzz target、运行 PoC；一次全量数据生成在论文配置的 192 核/256 GB 服务器上约耗时四周。

#### 依赖按候选时间对齐：论文意图与当前代码有偏差

论文说，补丁定位时应把非主组件对齐到候选主提交的时间。当前
[utils_tracer.py](../arvo-upstream/arvo/utils_tracer.py) 的 <code>customSrcmap()</code>（76–135 行）确实有这套框架，但 92 行写成：

~~~python
if sm0[x] == sm0[x]:
    not_changed_components.append(x)
~~~

该条件恒真。按函数注释和上下文，它很可能原本要比较 <code>sm0[x] == sm1[x]</code>。当前写法会把两个端点都存在的依赖一律标为“未变化”，从而跳过后续按候选时间滚动 revision。

应把它记为**当前公开 HEAD 的高度疑似实现缺陷**，而不能据此断言 v3 数据库一定受影响：release 没有记录生成它所用的精确代码提交，无法反推当时运行的代码版本。

### 4.8 第八步：写入 SQLite 成品表

表结构定义在 [utils_sql.py](../arvo-upstream/arvo/utils_sql.py) 15–42 行。真正的单条成品流水线是
[Locator.py](../arvo-upstream/arvo/Locator.py) 的 <code>reproduce()</code>（798–869 行）：

1. 生成/验证 vul 与 fix 镜像；
2. 定位补丁；
3. 从 vulnerable 镜像再取一次 crash output；
4. 整理项目、目标、引擎、sanitizer、补丁与报告信息；
5. 插入 <code>arvo</code> 表。

这里有一个文档与接口差异：

- CLI 的 <code>arvo reproduce</code> 只调用 <code>verify(localId, False)</code>，不保存镜像、不定位补丁、不写 DB；
- <code>arvo report</code> 只打印一条补丁报告；
- 完整 <code>Locator.reproduce()</code> 没暴露成 CLI；
- <code>arvo summary</code> 目前是空实现；
- CI 只对旧 ID 25402 跑一次 report，再 grep 预期 patch URL。

因此 README 中“Rebuild the Database”的示例更接近“重算一条报告”，不是公开的全量数据库构建器。

---

## 5. 发布数据库 v3.0.0 实查

### 5.1 数据规模与分布

对官方 release asset 的只读查询结果：

| 指标 | 实查值 |
|---|---:|
| 行数 | 6,138 |
| 独立项目 | 311 |
| <code>reproduced=1</code> | 6,138 |
| <code>patch_located=1</code> | 6,138 |
| <code>verified=1</code> | 0 |
| submodule case | 44 |
| C++ / C | 5,394 / 744 |
| libFuzzer / AFL / Honggfuzz | 4,557 / 1,138 / 443 |
| ASan / MSan / UBSan | 4,293 / 1,293 / 552 |
| Medium / High | 4,476 / 1,662 |

这里 <code>verified</code> 全为 0 不表示 6,138 个 fix 都没验证。生成代码中的 <code>fileReport()</code> 把该字段硬编码为 False；它更像未启用的后续人工标志，而不是论文“PoC 双端验证”的结果。

### 5.2 19 个字段应该怎样读

| 字段组 | 字段 | 含义与注意点 |
|---|---|---|
| 身份 | <code>localId, project</code> | OSS-Fuzz issue 与项目 |
| 成功状态 | <code>reproduced, patch_located</code> | v3 只发布成功子集，所以全为 1 |
| 使用命令 | <code>reproducer_vul, reproducer_fix</code> | 指向 Docker tag，不是不可变 digest |
| 补丁 | <code>patch_url, fix_commit, repo_addr, submodule_bug</code> | 可为主仓或子模块；部分 <code>fix_commit</code> 是多行提交范围 |
| 运行上下文 | <code>fuzz_target, fuzz_engine, sanitizer, language</code> | 用于选择构建和执行方式 |
| 漏洞表现 | <code>crash_type, crash_output, severity</code> | crash output 是生成时执行 vulnerable 镜像得到的日志 |
| 来源 | <code>report</code> | 新 OSS-Fuzz issue URL |
| 占位状态 | <code>verified</code> | 当前全 0，不宜作质量字段 |

数据库没有：

- PoC 原始字节或哈希；
- vulnerable/fixed endpoint 的主项目 commit；
- 两张 source map 和完整依赖图；
- patch diff；
- Docker image digest、签名或 SBOM；
- CVE 字段。

README 所说“一条记录包含 POC”应理解为 PoC 封装在相关镜像的 <code>/tmp/poc</code>，而不是 SQLite 有 PoC 列。

### 5.3 重复项与“6,138 个漏洞”的口径

论文保留同补丁的多个 issue，因为它们可能：

- 来自不同 PoC；
- 使用不同 fuzz harness；
- 使用不同 fuzz engine；
- 通过不同路径到达同一根因。

论文称重复记录为 1,550。v3 数据库按不同规则实算：

- 独立 <code>patch_url</code>：4,623，故按 URL 重复 1,515 条；
- 独立 <code>fix_commit</code>：4,640，故按字符串重复 1,498 条；
- 独立 <code>repo_addr + fix_commit</code>：4,642，故重复 1,496 条。

差异可能来自论文快照、提交范围字符串或去重规则。稳妥表述应是：

> v3 有 6,138 个可复现 issue/PoC 实例，不等于 6,138 个唯一漏洞根因；按 patch URL 约对应 4,623 个不同补丁标识。

另有 394 条记录的 <code>fix_commit</code> 包含多行候选提交，最长可达 64 个。这对应无法稳定压缩到唯一 SHA 的补丁范围。

### 5.4 数据谱系为什么仍不完整

公开材料分散在三个位置：

| 位置 | 保存内容 |
|---|---|
| 生成源码仓 | 原始 JSONL、source map、算法实现 |
| GitHub Release | 仅成功条目的 SQLite 结果 |
| Docker Hub | 源码、构建环境、PoC、目标二进制 |

没有一个 manifest 把“DB 行 → 两张 source map → PoC 哈希 → 镜像 digest → 生成代码 commit”不可变地连起来。外部 Git/Hg/SVN 仓库和下载地址也可能继续消失。因此 ARVO 的复现保证主要是行为级与工程级，不是严格的长期供应链可验证性。

---

## 6. 贯穿案例：muparser issue 42487096

这是最适合学习数据血缘的一条。旧 tracker ID 为 25402，新 tracker 映射见
[oss_fuzz_mappings.csv](../arvo-upstream/arvo/oss_fuzz_mappings.csv) 第 17,116 行。

### 6.1 原始 issue 元数据

[metadata.jsonl](../arvo-upstream/arvo/NewTracker/metadata.jsonl) 第 3,270 行给出：

- project：muparser；
- job：<code>libfuzzer_asan_muparser</code>；
- fuzz target：<code>set_eval_fuzzer</code>；
- crash：<code>Heap-buffer-overflow READ 8</code>；
- PoC testcase ID：5758791700971520；
- vulnerable build：2020-09-03 06:26；
- verified-fixed range 末端：2020-09-17 06:17。

### 6.2 两个构建端点

目录 [42487096_files](../arvo-upstream/arvo/NewTracker/Issues/42487096_files/) 中：

| 端点 | muparser revision | AFL revision |
|---|---|---|
| vulnerable | <code>dd0efc8aee586eb3370025677f6ec9dee1da4729</code> | <code>82b5e359...</code> |
| verified-fixed | <code>438150c9198436a9ad0beb36d758b87d835c3cf8</code> | <code>82b5e359...</code> |

这里 AFL revision 没变，而主仓跨过了多个提交。

### 6.3 ARVO 找到的真正补丁

v3 DB 给出：

- located patch：<code>322716256d60e316c9a3b905a387be36d4e47368</code>；
- [上游提交](https://github.com/beltoforion/muparser/commit/322716256d60e316c9a3b905a387be36d4e47368)；
- 镜像命令：<code>n132/arvo:42487096-vul</code> 与 <code>42487096-fix</code>；
- 生成时保存了一份 ASan heap-buffer-overflow 堆栈。

评估仓保存的 [patch diff](../arvo-evaluation/data/patch-statistics/patch_diffs/42487096_4b9fba86ba.diff) 共改 5 个文件、增加 24 行、删除 9 行。核心修复位于 <code>muParserBase.cpp</code>：确保值栈内容以正确的浮点值处理，并在调整栈大小前清理残余元素；提交标题也明确关联旧 issue 25402。

这个例子精确展示了 ARVO 的价值：

~~~text
已知会崩的 endpoint dd0efc8...
        ↓ 中间有若干提交
真正修复 3227162...
        ↓ 还有 README 等无关提交
OSS-Fuzz verified-fixed endpoint 438150c...
~~~

如果只拿区间末端当修复，会把后面的无关提交也算进去；动态搜索才把补丁缩到 <code>3227162...</code>。

### 6.4 另一个提醒：论文中的 libheif 示例会漂移

论文讨论 42486945：OSS-Fuzz 曾把 README 修改误认为修复，真正代码修复在近两年后。但这个 ID 当前不在 v3 DB，其 Docker tag 也不存在。

相关的重复 issue 42502614 则仍在 v3 DB，定位到
<code>11ffeffadd980f9f96019fe180fc1e81827e3790</code>。它的两端 source map 还从 AFL 漂移到 AFL++、组件数从 4 变为 5，正好说明只回滚主仓库为什么不够。

阅读论文案例时，应区分“论文历史时点的诊断样例”和“当前 release 中仍可直接使用的教程 ID”。

---

## 7. 论文主要实验结果怎样解释

### 7.1 数据集规模

论文 v2 报告：

| 阶段 | 数量 |
|---|---:|
| OSS-Fuzz 原始记录 | 10,440 |
| 排除确认上游错误后候选 | 8,921 |
| 成功复现并定位补丁 | 6,138 |
| 成功项目 | 311 |
| 与 CVE 关联 | 221 |
| 交互式 vul/fix 镜像 | 12,276 |

成功结果占候选 <code>68.8%</code>。作者将其写成约 69%，并说明全量流水线受到时间成本限制。

多样性方面，top 10 项目只占成功记录的 35.71%。ARVO 全集平均涉及 4.05 个依赖，而它与 OSS-Fuzz-OSV 的重叠子集平均只有 0.83 个；作者据此认为只保存现成二进制/PoC 的 OSV 子集明显偏向依赖简单的项目。

### 7.2 与官方 OSS-Fuzz reproducer 的对照

作者从候选中随机取 100 条，覆盖 67 个项目：

| 组件数 | 样本 | OSS-Fuzz 成功 | ARVO 成功 |
|---|---:|---:|---:|
| 1 | 47 | 27 | 41 |
| 2–4 | 29 | 10 | 19 |
| 5–10 | 10 | 0 | 9 |
| >10 | 14 | 0 | 12 |
| 合计 | 100 | 37 | 81 |

结论不是“所有漏洞都能达到 81%”，而是：

- 在这组同样本对照中，ARVO 是 81/100，官方工具是 37/100；
- 优势集中于多组件项目；
- 这支持全依赖版本控制和历史环境恢复的必要性。

### 7.3 消融实验

在 ARVO 已成功的 81 条上关闭机制：

| 关闭机制 | 成功数 | 相对 81 条成功率 |
|---|---:|---:|
| Resource Fixing（RF） | 54 | 66.7% |
| Base Environment（BE） | 50 | 61.7% |
| 非主组件 Revision Control（RC） | 46 | 56.8% |
| RF + BE | 46 | 56.8% |
| RC + RF | 42 | 51.9% |
| RC + BE | 37 | 45.7% |
| 三项全关 | 34 | 42.0% |

RC 单项影响最大，三项互补。但论文 §4.3 介绍的三大策略是“最小侵入插桩、版本控制、资源修复”，消融表却用 BE 替换了插桩，没有单独量化最小侵入构建插桩。

### 7.4 补丁准确率

ARVO 与 OSS-Fuzz-OSV 重叠 2,219 条，按补丁关系分组：

- 完全一致：66.61%；
- 部分一致：12.48%；
- 不一致：20.91%。

论文从每组各抽 100 条人工判断，报告：

- 一致组 ARVO 正确 97%；
- 部分一致组 93%；
- 不一致组中 ARVO 63%、OSV 32%；
- 按三组比例加权，ARVO 89.4%，OSV 82.9%。

这里有两层限制：

1. 89.4% 是分层样本估计，不是全体逐条真值。
2. 当前评估仓的人工日志与论文数字存在漂移：
   - <code>CHOSEN_SAME.log</code> 实数是 96 True / 4 False；
   - <code>CHOSEN_PARTIAL.log</code> 是 92 / 8；
   - <code>CHOSEN_DIFF.log</code> 汇总为 ARVO-only 46、OSV-only 15、both 17、none 22；
   - 按论文组权重与现有标签计算，ARVO 约 88.6%，不是 89.4%。

评估仓没有抽样 seed 或生成准确率的完整脚本，因此不能从当前 artifact 无歧义地复算论文 89.4%。学习时应引用论文正式结果，同时保留这项 artifact 一致性提醒。

### 7.5 补丁形态

论文对去重后的可分析补丁报告：

- 90% 修改不超过 4 个文件；
- 2,895 个、63.22% 只修改一个文件；
- 增加/删除行中位数为 +6/-2；
- 均值为 +228.7/-115.1，说明少数大提交形成长尾；
- 90% 小于 +62/-32 行；
- 53.68%、2,458 个补丁修改了 sanitizer 堆栈中出现的文件和函数。

评估仓当前有：

- <code>all_patch_urls.csv</code> 6,138 行；
- 4,623 个唯一 patch URL；
- 实际下载 4,584 个 diff；
- <code>missing_patch_urls.csv</code> 记录 40 个未下载 diff。

所以这些统计来自“可下载、可解析、去重后的子集”，不能解读为全部 6,138 条都完成了同样的静态 patch 统计。

### 7.6 syzbot 外部迁移

作者把重建思想移植到 Linux/syzbot：

- 随机取 144 条；
- 44 条引用 mainline 不可达的孤立树提交，排除；
- 剩余 100 条中 78 条成功；
- 20 条能构建运行但超时内不 crash，多与竞态有关；
- 2 条构建失败。

所以成功率可写成“可达样本中的 78%”，若以原 144 条为分母则是 54.2%。Linux 的单一构建系统也比 OSS-Fuzz 多项目环境统一，外部实验说明方法可迁移，却不能证明所有漏洞类型都同样有效。

### 7.7 自动回植漏洞

作者把已定位补丁反向应用到新版本，再用原 PoC 检验能否构造新 benchmark：

| 项目 | 成功回植漏洞 | 影响文件 |
|---|---:|---:|
| ghostscript | 45 | 27 |
| assimp | 43 | 26 |
| mupdf | 30 | 26 |
| selinux | 14 | 11 |
| opensc | 13 | 10 |
| 合计 | 145 | 100 |

ghostpdl 的 177 条历史记录中只有 45 条成功。其余主要因为浅层崩溃遮蔽目标、补丁无法反向应用、或旧 PoC 在新版本不再触发。它证明 ARVO 可帮助自动造 benchmark，但并不是无条件的漏洞移植器。

---

## 8. 对论文与仓库的批判性阅读

### 8.1 论文明确承认的局限

1. **上游依赖**：输入元数据错，ARVO 也会继承错误。
2. **漏洞范围**：主要是有确定 PoC、以 crash 表现的 C/C++ 内存安全问题；不覆盖大量逻辑漏洞、竞态和非崩溃安全问题。
3. **PoC 判定偏弱**：没有严格匹配 crash type/address。
4. **补丁定义有限**：多提交修复、超大提交或“使路径不可达”的提交会破坏最早 no-crash 即补丁的假设。
5. **计算昂贵**：全量生成需要高核数机器运行数周。
6. **重复记录**：同补丁可以对应多个 issue，一个大提交也可能同时修多个根因。

### 8.2 论文数字和表述需要限定

| 表述 | 更准确的读法 |
|---|---|
| “成功复现 81%” | 100 条随机同样本对照中的 81%；当前全量成功结果是 6,138/8,921≈68.8% |
| “补丁准确率 89.4%” | 对 2,219 条重叠记录做三组、每组 100 条人工抽样后的加权估计 |
| “6,138 个漏洞” | 6,138 个 issue/PoC 实例，含同补丁重复项 |
| “全自动” | 单条处理高度自动化，但系统级 URL 和项目特例需要人工维护 |
| “fixed” | 同 PoC 在所测环境不再 crash，不等价于形式化证明根因消失 |

论文内部还存在：

- 1,518 与 1,519 的差一；
- 2,381 potential 与 1,519 confirmed 的关系未解释；
- reproducer “正在集成”与“已合并”的修订时态不一致；
- 表 1 对自动化使用混合符号，需要连脚注阅读。

### 8.3 公开仓库无法完整闭环的部分

虽然核心算法公开，但以下材料缺失：

- 1,519 条上游假阳性数据库/ID 清单；
- 失败条目的构建与运行日志；
- 构造 8,921 条候选的固定输入 ID 清单；
- 完整批处理入口与任务调度配置；
- 12,276 个镜像的批量推送脚本；
- GitHub release asset 的上传/签名流程；
- “这份 v3 DB 由哪个源码 commit 生成”的 provenance manifest。

[utils_rep.py](../arvo-upstream/arvo/utils_rep.py) 虽有随机取任务、JSONL 续跑和 file lock 的批处理辅助函数，但没有固定输入清单和公开的完整调用入口。ARVO-Meta 的 v2.0.0 与 v3.0.0 tag 又都指向 2025-07-09 的同一提交 <code>fe1bd1f...</code>，而 v3 数据库 asset 是后来上传的；tag 本身无法证明数据库由哪一版生成代码产出。

评估仓的 <code>data/arvo.db</code> 也不是 SQLite，只是指向 release 和 SHA-256 的两行文本；运行脚本前要手动下载数据库。图 5 脚本还依赖未提交的 <code>upstream_false_positives.db</code>。

因此合理结论是：

> 公开仓库足以追踪算法设计、检查许多成功案例和部分论文统计，但不足以从干净环境端到端重建与论文完全相同的数据集。

### 8.4 当前 Quickstart 也不是 clean-room turnkey

源码快照中：

- [profile.template](../arvo-upstream/profile.template) 没定义代码直接访问的 <code>EVAL_NOREBASE</code>、<code>EVAL_NOURLFIX</code>、<code>EVAL_NOCOMPONENT</code>、<code>EVAL_NOSRCMAP</code> 和 <code>CLEAN_OUT_BUILD</code>；
- [pyproject.toml](../arvo-upstream/pyproject.toml) 未声明 SQLAlchemy，但 [reproducer.py](../arvo-upstream/arvo/reproducer.py) 第一行直接 import；
- <code>requests</code> 也由代码直接 import，却未作为直接依赖列出；
- 还需要 Docker、sudo、gcloud、特定 <code>/src</code>/<code>/data</code> 布局和 base-builder cache；
- CI 只验证单个 muparser patch URL，没有单元测试、DB schema/count 校验，也不执行发布镜像的 crash/no-crash 对。

这些不否定论文方法，但意味着 README 命令不能被视为“从新机器一键重建论文数据”的完整复现配方。

### 8.5 数据仓文档存在旧/新 tracker 漂移

[ARVO-Meta README](../arvo-meta/README.md) 仍把 25402 和根目录 <code>./meta</code>、<code>./patches</code> 当教程。当前 main 中实际的数据目录只剩 <code>archive_data/</code>；新数据在 release 的 <code>arvo.db</code> 中，旧 ID 要经
[oss_fuzz_mappings.csv](../arvo-upstream/arvo/oss_fuzz_mappings.csv) 映射为新 ID。

此外源码仓有 BSD-2-Clause LICENSE；当前 ARVO-Meta 仓没有独立 LICENSE 文件。若要把数据用于公开再发布或商业训练，应先向维护者确认数据许可，而不要把代码许可证自动套到数据上。

---

## 9. 安全地学习和验证

### 9.1 推荐顺序

1. 先读本文与论文，不运行容器。
2. 用 SQLite 观察成功记录。
3. 从一条 DB 记录反查 JSONL 与两张 source map。
4. 阅读对应 patch diff。
5. 最后才在一次性隔离 VM 中拉取一个预构建镜像做行为验证。
6. 除非研究目标就是重建基础设施，不要一开始跑全量源码构建。

### 9.2 可直接执行的只读 SQL

在当前目录：

~~~bash
sqlite3 -readonly -header -column arvo-meta-v3.0.0.db \
  "SELECT COUNT(*) AS rows, COUNT(DISTINCT project) AS projects FROM arvo;"
~~~

查看一个项目：

~~~bash
sqlite3 -readonly -header -column arvo-meta-v3.0.0.db \
  "SELECT localId, fuzz_target, sanitizer, crash_type, patch_url
   FROM arvo
   WHERE project='muparser';"
~~~

查看单条完整记录：

~~~bash
sqlite3 -readonly -line arvo-meta-v3.0.0.db \
  "SELECT * FROM arvo WHERE localId=42487096;"
~~~

查看重复 patch URL：

~~~bash
sqlite3 -readonly -header -column arvo-meta-v3.0.0.db \
  "SELECT patch_url, COUNT(*) AS cases
   FROM arvo
   GROUP BY patch_url
   HAVING COUNT(*) > 1
   ORDER BY cases DESC
   LIMIT 20;"
~~~

验证本地 release asset：

~~~bash
sha256sum arvo-meta-v3.0.0.db
~~~

期望值：

~~~text
331184ca807c2f136f98dac9f1df94c893f4ee2fdf9329dca517ff88e72f97ce
~~~

### 9.3 不要直接在日常主机跑完整构建链

ARVO 会：

- clone 并执行多年以前的 Git/SVN/Hg 源码；
- 执行第三方 Dockerfile 和 <code>build.sh</code>；
- 在内部多处使用 Docker <code>--privileged</code>；
- 使用 sudo、chown 和删除临时构建目录；
- 运行真实 crash PoC。

如果确实要执行：

- 使用一次性 VM 和专用 Docker daemon；
- 不挂载宿主敏感目录、SSH key、云凭证或 <code>docker.sock</code>；
- 限制 CPU、内存、磁盘和运行时间；
- 构建阶段如需联网，使用受控出口；执行已下载 PoC 时尽量断网；
- 按 digest 固定镜像，并记录拉取日期；
- 不要在生产软件或生产主机上测试 PoC；
- 若为 MSAN 问题需要关闭 ASLR，只在一次性 VM 内做，别改宿主全局安全设置。

本文没有在当前主机执行漏洞镜像或真实 PoC；所有结论来自论文、源码静态审计、数据库只读查询、评估 diff/日志和 registry 元数据。

---

## 10. 建议的源码阅读路线

按下面顺序阅读，最容易建立完整心智模型：

| 顺序 | 文件 | 重点 |
|---:|---|---|
| 1 | [README.md](../arvo-upstream/README.md) | 作者给出的使用模型 |
| 2 | [utils_meta.py](../arvo-upstream/arvo/utils_meta.py) | issue、JSONL、source map 如何取得 |
| 3 | [utils.py](../arvo-upstream/arvo/utils.py) | ID 映射、source map、PoC 与 crash 判定 |
| 4 | [reproducer.py](../arvo-upstream/arvo/reproducer.py) | 历史环境恢复、双端验证、镜像打包 |
| 5 | [utils_core.py](../arvo-upstream/arvo/utils_core.py) | base image、URL 和项目构建特例 |
| 6 | [transform.py](../arvo-upstream/arvo/transform.py) | 资源迁移规则 |
| 7 | [Locator.py](../arvo-upstream/arvo/Locator.py) | 提交二分、submodule、DB 记录生成 |
| 8 | [utils_tracer.py](../arvo-upstream/arvo/utils_tracer.py) | 候选 source map 与依赖时间策略 |
| 9 | [utils_detector.py](../arvo-upstream/arvo/utils_detector.py) | 上游假阳性判断 |
| 10 | [utils_sql.py](../arvo-upstream/arvo/utils_sql.py) | 发布表 schema |
| 11 | [评估数据 README](../arvo-evaluation/README.md) | 论文实验材料入口 |
| 12 | [patch-statistics](../arvo-evaluation/data/patch-statistics/) | diff 与统计脚本 |

建议带着四个问题读每个函数：

1. 输入来自哪里，是否被不可变地固定？
2. 成功/失败的判据是什么？
3. 失败样本会留下什么证据？
4. 这一步的输出是否足以让另一个研究者独立重放？

---

## 11. 我的总体评价

ARVO 最有价值的思想是把漏洞数据从“静态标签集合”升级为“可执行证据集合”。

过去使用漏洞数据集时，研究者往往只能相信某条记录所说的 vulnerable version 和 patch。ARVO 让研究者有机会重新构建、重新触发、修改代码、再次编译，再用同一 PoC 质询候选修复。这个反馈闭环对动态分析、自动修复、AI agent、漏洞回植和 benchmark 构造都非常重要。

它的突破主要是系统工程，而非一个孤立算法：

~~~text
历史环境恢复
  + 全组件 revision 控制
  + 资源修复
  + PoC 双端验证
  + 动态补丁搜索
  = 可交互的历史漏洞实验对象
~~~

同时，ARVO 给出的仍是强动态证据，不是形式化真值。PoC 不再 crash 不能完整证明语义根因已修；公开制品的 provenance、失败样本、假阳性清单和全量运行入口也尚不完整。最恰当的评价是：

> ARVO 显著提高了真实历史漏洞数据的可执行性与可质询性，但“可重建、可触发、PoC 不再触发”仍应与“唯一根因、语义修复、长期位级可复现”严格区分。

---

## 12. 参考资料

1. Xiang Mei et al., [ARVO: Atlas of Reproducible Vulnerabilities for Open-Source Software](https://arxiv.org/abs/2408.02153), arXiv v2 / IEEE EuroS&P 2026.
2. IEEE EuroS&P 2026, [Accepted Papers and Awards](https://www.ieee-security.org/TC/EuroSP2026/accepted_and_awards.html).
3. n132, [ARVO source repository](https://github.com/n132/ARVO).
4. n132, [ARVO-Meta repository](https://github.com/n132/ARVO-Meta).
5. n132, [ARVO-Meta v3.0.0 release](https://github.com/n132/ARVO-Meta/releases/tag/v3.0.0).
6. SEFCOM, [ARVO paper evaluation artifacts](https://github.com/sefcom/ARVO).
7. Google, [OSS-Fuzz](https://github.com/google/oss-fuzz).
