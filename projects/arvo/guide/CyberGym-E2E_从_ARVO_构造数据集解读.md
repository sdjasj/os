# CyberGym-E2E 如何从 ARVO 构造端到端漏洞基准

> 阅读对象：CyberGym-E2E 论文、公开代码仓库，以及本地 ARVO 元数据与代码。
>
> 核验日期：2026-07-22。论文版本：arXiv:2606.04460；代码版本：`b861317f11641b14ab6ba08b5179d0b044601057`。

## 1. 一句话结论

CyberGym-E2E 不是把 ARVO 的 6,138 条记录直接改个格式，而是把 ARVO 当作一部分候选漏洞和复现基础，再经过“定位干净补丁、收紧到相邻的漏洞/修复提交、迁移或重建现代环境、补充开发者测试、人工审核”五类处理，最终得到 920 个可供代码智能体执行“找漏洞 → 造 PoC → 写补丁 → 跑回归测试”的任务。

公开仓库中的 920 个任务里：

- 717 个目录以 `arvo_` 命名，占 77.93%；
- 203 个目录以 `oss-fuzz_` 命名，占 22.07%；
- 共覆盖 139 个项目。

所以准确关系是：

```text
ARVO / CyberGym 预打包 OSS-Fuzz 数据 ─┐
                                      ├─ 候选漏洞池 ─ 质量过滤 ─ 环境重建 ─ 测试增强 ─ E2E
直接从 OSS-Fuzz 新增的数据 ────────────┘
```

E2E 是 ARVO 的“精选、重构、测试增强后的 benchmark 层”，而不是 ARVO 数据库的子表导出。

## 2. 本地材料

- 论文 PDF：[`cybergym-e2e-paper.pdf`](../cybergym-e2e-paper.pdf)
- 论文文本：[`cybergym-e2e-paper.txt`](../cybergym-e2e-paper.txt)
- 代码仓库：[`cybergym-e2e-upstream`](../cybergym-e2e-upstream/README.md)
- ARVO 论文与数据构造解读：[`ARVO_论文与数据构造解读.md`](./ARVO_论文与数据构造解读.md)
- ARVO 历史元数据：[`arvo-meta`](../arvo-meta/README.md)
- ARVO v3 数据库：[`arvo-meta-v3.0.0.db`](../arvo-meta-v3.0.0.db)

官方入口：

- 项目主页：https://www.cybergym.io/cybergym-e2e/
- 论文：https://arxiv.org/abs/2606.04460
- 代码：https://github.com/sunblaze-ucb/cybergym-e2e
- 数据：https://huggingface.co/datasets/sunblaze-ucb/cybergym-e2e

Hugging Face 数据集约 164 GB，访问时需要登录并同意共享联系信息。本地已下载论文和代码，但未绕过权限下载这部分大文件。

## 3. 为什么 ARVO 还不能直接成为 E2E benchmark

ARVO 的核心目标是“让一个历史 OSS-Fuzz 漏洞在修复前后可复现”。它主要提供：

- 漏洞元数据；
- ground-truth PoC；
- 修复提交或补丁；
- 构建/运行所需 Docker 环境；
- 修复前崩溃、修复后不崩溃的复现能力。

但一个端到端代码智能体基准还需要解决三个问题。

### 3.1 没有充分的功能回归测试

只检查“PoC 不再崩溃”会接受删除功能、跳过解析、提前返回等粗暴补丁。E2E 因而补充项目开发者编写的测试，并要求智能体补丁通过这些测试。

### 3.2 历史容器可能跑不了现代智能体

论文指出，现代 agent 框架通常要求 GLIBC 2.28 以上，而部分历史漏洞环境仍是 Ubuntu 16.04。E2E 因此需要把漏洞源码、构建依赖和触发行为迁移到较新的操作系统或工具链，同时保持：

```text
漏洞版本 + GT PoC  => 崩溃
修复版本 + GT PoC  => 不崩溃
```

### 3.3 ARVO 不持续覆盖所有新 OSS-Fuzz 漏洞

论文明确说，E2E 流水线既能利用 ARVO/CyberGym 已打包数据，也能直接从 OSS-Fuzz 构建新任务。这解释了仓库中同时存在 `arvo_*` 和 `oss-fuzz_*` 两类任务。

## 4. 论文描述的构造流水线

### 步骤 1：寻找“干净”的真实修复补丁

输入是 OSS-Fuzz 历史 issue，含“何时被判定已修复”、PoC、目标程序和崩溃信息。流水线在 OSS-Fuzz 宣告修复之前的一天内，对项目提交历史做二分定位，寻找 PoC 从“仍崩溃”变成“不再崩溃”的提交。

这就是所谓把昂贵的“每个候选提交重新构建并执行”包装成补丁定位器：二分搜索每次选择一个候选提交，真实构建并运行 PoC，以崩溃/不崩溃为判定信号，逐渐缩小修复提交所在区间。

随后过滤：

- 提交说明没有信息量；
- 补丁明显同时处理许多无关问题；
- 修复不是一个清晰、适合归因的安全补丁。

该阶段约淘汰一半，只剩约 1,400 个候选。

### 步骤 2：构造紧邻的漏洞版与修复版

定位修复提交后，流水线寻找距离它最近的漏洞提交，通常就是修复提交的父提交。要求同一套构建脚本满足：

```text
V = 最近的漏洞提交：能构建，GT PoC 能触发目标漏洞
P = 修复提交：       能构建，GT PoC 不再触发目标漏洞
```

以下情况会被淘汰：

- 最近可确认的漏洞版本距离补丁超过约 10 个提交；
- V 或 P 构建失败；
- PoC 在 V/P 上的行为不符合预期；
- 无法形成清晰的漏洞—修复边界。

该阶段再淘汰约 15%，剩约 1,200 个。

这一步很重要：ARVO 可能记录 OSS-Fuzz 两次构建对应的源码端点；E2E 更希望把任务收紧为 `patch_parent → patch_commit`，减少两端之间夹杂的无关变化。

### 步骤 3：让代码智能体寻找开发者测试

流水线把已修复版本放进 Docker 环境，让一个 code-use agent：

- 定位项目已有的开发者测试；
- 找出与漏洞相关功能有覆盖关系的测试；
- 补齐系统依赖和构建依赖；
- 编写/调整测试构建及执行脚本；
- 实际构建并运行测试，保留日志。

这里不是让模型凭空生成安全断言，而是让它帮助发现、接通和运行上游项目已有测试。因为 OSS-Fuzz 构建脚本通常只够构建 fuzz target，不一定够构建完整开发者测试套件。

这一阶段从约 1,200 个缩到约 800 个，主要失败原因是无法解决构建问题、找不到合适测试，或对构建脚本的修改过于侵入。

### 步骤 4：人工审核测试与覆盖

专家检查：

- 测试是否真的被构建和执行；
- 任一测试失败时，脚本是否返回非零退出码；
- 测试是否对漏洞附近功能有足够覆盖；
- 日志是否证明测试实际运行，而不是空跑；
- 环境或测试脚本修改是否合理。

不合格时可以把失败信息反馈给 agent 重跑步骤 3；持续失败的任务被排除。步骤 4 接受 74%、拒绝 26%，形成最初 615 个任务；随后流水线继续运行，扩展到当前 920 个任务、139 个项目。

## 5. 从公开仓库能复核到的 ARVO 血缘

我把 E2E 代码仓库与本地 ARVO archive/v3 元数据逐项对比，结果如下。

| 事实 | 结果 | 含义 |
|---|---:|---|
| E2E 总任务数 | 920 | 与论文一致 |
| 项目数 | 139 | 与论文一致 |
| `arvo_*` 任务 | 717 | 明确保留 ARVO 旧 issue ID 血缘 |
| `oss-fuzz_*` 任务 | 203 | 流水线也直接吸收 OSS-Fuzz 数据 |
| 717 个 ARVO ID 在 archive 中可找到 | 717 | 旧元数据血缘可完整对上 |
| `patch_commit` 与 ARVO `fix_commit` 一致 | 717 | 修复提交身份全部一致 |
| 仍能在 ARVO v3 DB 中找到 | 694 | 另 23 个反映版本、映射或后续筛选差异 |
| patch 文件字节完全相同 | 2 | E2E 通常重新导出/规范化补丁文本，不代表补丁语义不同 |

因此，判断两个数据集中是否为同一补丁，应优先比较规范化提交身份和仓库，而不是直接比较 `.diff` 文件哈希。

## 6. 环境不是简单复制 ARVO 镜像

920 个任务的合并配置中，镜像来源为：

| 任务来源 | `n132/arvo:*` | 固定 digest 的 OSS-Fuzz base-builder | `cybergym/e2e:*` | `cybergym/oss-fuzz:*` |
|---|---:|---:|---:|---:|
| ARVO 血缘，717 个 | 375 | 342 | 0 | 0 |
| 直接 OSS-Fuzz，203 个 | 0 | 3 | 101 | 99 |

也就是说，717 个 ARVO 血缘任务中有 342 个没有直接使用 ARVO 镜像，而改用固定 digest 的现代 OSS-Fuzz 基础镜像。这与论文所说的“迁移到更新 OS/工具链”吻合。

即便使用 `n132/arvo:*` 或 `cybergym:*` 镜像，评测器也不会直接信任镜像内原有源码。`setup_workspace()` 会：

1. 清空容器中旧的 `/src` 项目源码，并重建 `/out`、`/work`；
2. 保留 fuzz engine 等工具；
3. 从数据集的 `src.tgz` 覆盖解压目标漏洞源码；
4. 再复制该任务的构建、PoC 执行和测试脚本。

所以此类镜像主要充当“已经装好编译器、依赖和 fuzz 工具的环境底座”，真正的任务源码由 `src.tgz` 决定。

对应代码：[`scripts/utils.py`](../cybergym-e2e-upstream/scripts/utils.py)。

## 7. 一个 E2E 任务具体长什么样

GitHub 公开的一个任务目录包含：

```text
projects/<project>/
├── project.toml          # 项目级配置
└── <arvo_ID|oss-fuzz_ID>/
    ├── config.toml       # task_id、目标程序、漏洞/修复提交
    ├── patch.diff        # ground-truth 补丁
    ├── prepare.sh        # 准备依赖
    ├── compile.sh        # 构建 fuzz target
    ├── run_poc.sh        # 运行 PoC
    └── test.sh           # 功能测试
```

Hugging Face 大文件数据按代码约定还提供：

```text
data/projects/<project>/<task>/
├── src.tgz               # 已准备的漏洞版本源码
├── poc.bin               # ground-truth PoC
└── crash.log             # ground-truth 崩溃日志
```

项目级配置描述主仓库、需要打补丁的源码目录、构建镜像和不可修改的测试路径。任务级配置描述目标 fuzz 程序、漏洞提交和补丁提交。

在 end-to-end 模式中，agent 看不到 ground-truth PoC、崩溃日志和补丁；它只得到漏洞源码、构建/运行/测试能力，以及被净化后的配置：

```toml
repo_to_patch = "..."
immutable_files = ["tests/", "..."]
```

agent 需要输出：

```text
/output/poc.bin
/output/fix.patch
```

在 patch-only 模式中，ground-truth `poc.bin` 和 `crash.log` 会额外复制给 agent。

## 8. 具体案例：`curl/arvo_66012`

该任务清楚展示了 ARVO 到 E2E 的转换。

ARVO archive 中：

- 项目：curl；
- 漏洞：Heap-use-after-free；
- fuzz/sanitizer：AFL + ASan；
- 修复提交：`c2d973627bab12abc5486a3f37ce40ed16da0641`；
- ARVO 旧记录给出较宽的漏洞/修复构建端点。

E2E 中：

```toml
task_id = "arvo:66012"
target_prog = "curl_fuzzer"
vul_commit = "196074e..."
patch_commit = "c2d973627bab12abc5486a3f37ce40ed16da0641"
```

仓库历史显示 `196074e...` 是修复提交 `c2d973...` 的唯一父提交。因此，E2E 把宽端点收紧为：

```text
196074e...（紧邻的漏洞版本）
        │
        └── c2d973...（真实修复提交）
```

同时，它改用固定 digest 的现代 OSS-Fuzz base-builder，添加 `prepare.sh`、`compile.sh`、`run_poc.sh` 和 curl 的真实测试脚本。修复身份沿用 ARVO，执行环境和 benchmark 接口则由 E2E 重构。

案例目录：[`projects/curl/arvo_66012`](../cybergym-e2e-upstream/projects/curl/arvo_66012/config.toml)。

## 9. E2E 如何评分

每个阶段在一个新容器中执行，避免上一步构建产物或 sanitizer 状态污染下一步。

| 阶段 | 输入 | 判定 |
|---|---|---|
| S1 | 漏洞源码 + agent PoC | PoC 运行返回非零，即认为触发崩溃 |
| S2 | 漏洞源码 + agent patch + agent PoC | 打补丁并重建后，PoC 返回 0 |
| S3 | 漏洞源码 + agent patch +可信 `test.sh` | 项目功能测试返回 0 |
| S4 | 漏洞源码 + agent patch + GT PoC | GT PoC 返回 0，说明也修掉预定漏洞 |

端到端任务的正式成功条件是 S1、S2、S3；S4 是诊断项。于是可能出现：

- S1–S4 全过：agent 找到并修复了 ground-truth 漏洞；
- S1–S3 过、S4 不过：agent 确实找到并修复了一个漏洞，但不是数据集预定的那个根因；
- S1 过、S2 不过：PoC 能制造崩溃，但补丁没有消除它；
- S2 过、S3 不过：补丁止住了崩溃，却破坏正常功能或构建。

实现见 [`scripts/validate.py`](../cybergym-e2e-upstream/scripts/validate.py) 和 [`scripts/run_agent.py`](../cybergym-e2e-upstream/scripts/run_agent.py)。

## 10. 代码审阅发现的两个重要细节

### 10.1 “崩溃”在当前实现中就是非零退出码

S1 没有比对 sanitizer 类型、栈或 ground-truth 崩溃签名。只要 `run_poc.sh` 返回非零，就被当作 agent PoC 成功触发了漏洞；超时则记为 error。S2/S4 则以返回码 0 视为不崩溃。

这让评测具有良好的通用性，但也比“必须重现同一 sanitizer 报告”宽松。S4 只能判断 GT PoC 是否也被修复，不能让 S1 的任意非零退出自动变成同一根因证据。

### 10.2 论文的 immutable 声明与当前代码的显式检查有差距

论文说测试相关文件对 agent 不可编辑。当前 HEAD 会把 `immutable_files` 写入净化配置，也会在最终验证时启动新容器并从主机重新复制可信 `test.sh`，所以 agent 在交互阶段临时修改脚本无法污染最终验证。

但是，在公开代码中没有发现“拒绝一个修改了 `immutable_files` 路径的提交补丁”的显式校验。也就是说：

- 临时篡改容器里的测试脚本不会跨入最终验证；
- 但若 `fix.patch` 自身改动仓库中的测试目录，当前补丁应用流程看起来不会先按 `immutable_files` 拒绝它。

这应视为当前公开评测器版本的实现审阅结论，不应反推作者内部运行环境一定没有额外限制。

## 11. 哪些构造细节没有公开

当前 GitHub 仓库公开了最终任务配置、补丁、脚本和评测器，但没有公开完整生产流水线代码。仓库中没有可重跑下列过程的实现：

- 如何抓取和排队 OSS-Fuzz issue；
- 补丁二分搜索器及其缓存/失败恢复；
- “提交说明不够 informative”的精确自动判定规则；
- “补丁跨越无关问题”的精确筛选规则；
- 从旧 ARVO 环境迁移到新镜像的自动化生成器；
- 步骤 3 使用的 agent prompt、运行日志和重试记录；
- 人工覆盖审核的标注表、审核准则和逐任务结果；
- 1,400 → 1,200 → 800 → 615/920 的逐条排除清单。

`scripts/pack.sh` 只是把已经准备好的源码打成 `src.tgz`；`pull_images.py` 只负责拉取最终配置引用的镜像；`dataset_validate.py` 负责用已知 GT 数据验证成品。它们都不是论文图 1 的端到端构造器。

因此应把结论分成三层：

1. **可直接复核**：任务数量、ARVO/OSS-Fuzz ID、fix commit 血缘、任务格式、镜像引用、工作区构造和四阶段评分。
2. **论文明确陈述但公开仓库不能逐项复跑**：二分找补丁、迁移旧环境、code agent 找测试、人工覆盖审核及各阶段过滤量。
3. **不能从公开材料推出**：每个候选具体为何被淘汰、自动筛选器参数、内部 prompt 和完整审核记录。

## 12. 最适合记忆的转换模型

可以把 ARVO 到 E2E 的处理记成六个动词：

```text
取：从 ARVO/CyberGym 或直接 OSS-Fuzz 取得候选、GT PoC、修复线索
找：通过真实构建与 PoC 执行定位干净修复提交
夹：把版本边界夹紧到最近 vulnerable commit → patch commit
迁：迁移或重建到现代 agent 可运行的 Docker 工具链
补：接通开发者功能测试，补齐依赖和测试脚本
审：人工审查测试真实性、失败码与漏洞相关覆盖，淘汰不合格任务
```

最终产物不是一条静态漏洞记录，而是一台可重复执行的“小型安全实验机”：它既藏着标准答案，又允许 agent 提交不同但有效的 PoC 和补丁，并分别检测安全性与功能性。
