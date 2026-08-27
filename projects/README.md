# 外部项目教程清单与维护说明

`projects/` 保存从外部项目导入的教程内容快照，供网站展示使用。它不是上游源码镜像，也不替代本仓库原有的课程材料：OS 相关内容仍分别维护在根目录的 `tutorial/`、`sources/` 和 `examples/` 中。

## 已导入项目

下表中的“快照”通常是教程生成或校对时所依据的上游仓库 `HEAD`。教程文件可能来自该快照之上的本地工作树，因此提交号用于标记源码语境，不表示教程文件已经进入上游提交。对于本地独立生成的教程，另行记录本站中的不可变内容快照。

| 项目 | 导入源 | 站点 slug | 展示章节 | 上游快照与地址 |
| --- | --- | --- | ---: | --- |
| CubeSandbox | `<project-root>/CubeSandbox/docs/learning-guide/*.md` | `cubesandbox` | 11 | [`07c95b9`](https://github.com/TencentCloud/CubeSandbox/commit/07c95b99c27124694bc09e2bfdfbfa9de611f77f) · [上游仓库](https://github.com/TencentCloud/CubeSandbox) |
| E2B | `<project-root>/E2B/docs/zh-cn/PROJECT_OVERVIEW.md`、`<project-root>/E2B/docs/zh-cn/tutorial/*.md` | `e2b` | 12 | [`be1ffa1`](https://github.com/e2b-dev/E2B/commit/be1ffa19f6ad6d7b1003d714ce45faf3cf2c3e21) · [上游仓库](https://github.com/e2b-dev/E2B) |
| MiniMind | `<project-root>/minimind/tutorial/*.md`、`<project-root>/minimind/tutorial/agentic-rl/*.md` | `minimind` | 24 | [`512eed0`](https://github.com/jingyaogong/minimind/commit/512eed0b6556e741d80864f054d45d271459772a) · [上游仓库](https://github.com/jingyaogong/minimind) |
| Ray | `<project-root>/ray/ray_learning_tutorial/*.md`、`<project-root>/ray/ray_usage_guide/` 中指定内容 | `ray` | 30 | [`6623e6b`](https://github.com/ray-project/ray/commit/6623e6b1e71fcdb7161d6ec0b190e345665d5ba3) · [上游仓库](https://github.com/ray-project/ray) |
| Strix | `<project-root>/strix/docs/learning-guide/*.md`、`<project-root>/strix/docs/PROJECT_OVERVIEW_ZH.md` | `strix` | 14 | [`48b4821`](https://github.com/usestrix/strix/commit/48b4821f6960f38a289118a5c17b7e88e3a168b2) · [上游仓库](https://github.com/usestrix/strix) |
| ARVO | `<project-root>/arvo/docs/ARVO_论文与数据构造解读.md`、`<project-root>/arvo/docs/CyberGym-E2E_从_ARVO_构造数据集解读.md` | `arvo` | 2 | ARVO [`bceb742`](https://github.com/n132/arvo/commit/bceb742e4a8e563f0d53ea2e000496d85291168c) · CyberGym-E2E [`b861317`](https://github.com/sunblaze-ucb/cybergym-e2e/commit/b861317f11641b14ab6ba08b5179d0b044601057) |
| mini-swe-agent | `<project-root>/mini-swe-agent/PROJECT_GUIDE_ZH.md` | `mini-swe-agent` | 1 | [`38c01a1`](https://github.com/SWE-agent/mini-swe-agent/commit/38c01a19ed1a58dd17dd7c95010e4f69d059c777) · [上游仓库](https://github.com/SWE-agent/mini-swe-agent) |
| OpenHands | 基于 `<project-root>/OpenHands/{README.md,Development.md,pyproject.toml,openhands/**,frontend/**,enterprise/**,tests/**}` 中的固定快照创作，仅导入 `guide/*.md` 教程 | `openhands` | 15 | [`6b04532`](https://github.com/OpenHands/OpenHands/commit/6b04532541bf2b757d4820d31387b6cba6ffcaea) · [上游仓库](https://github.com/OpenHands/OpenHands) |
| Codex | 基于 `<project-root>/codex/{README.md,AGENTS.md,LICENSE,NOTICE,justfile,defs.bzl,docs/**,codex-cli/**,codex-rs/**,sdk/**}` 中的固定快照独立创作，仅导入 `guide/*.md` 教程 | `codex` | 19 | [`61a4488`](https://github.com/openai/codex/commit/61a44880a85d2fd0d8770908dea5733495e571c8) · [上游仓库](https://github.com/openai/codex) |
| OpenClaw | 基于 `<project-root>/openclaw/docs/internal/openclaw-code-study/*.md` 的用户授权教程快照，仅导入指定 Markdown | `openclaw` | 14 | [`fc3476b`](https://github.com/openclaw/openclaw/commit/fc3476b116b982d96e94cc86e3daf0f080c84ada) · [上游仓库](https://github.com/openclaw/openclaw) |
| Hands-On Modern RL | 基于 `<project-root>/hands-on-modern-rl/{README.md,LICENSE,code/**,docs/**}` 固定快照独立创作，仅导入 `guide/*.md` 教程 | `hands-on-modern-rl` | 14 | [`7c0372d`](https://github.com/walkinglabs/hands-on-modern-rl/commit/7c0372d4806c0dc478df46ed522ab64e58dda1d6) · [上游仓库](https://github.com/walkinglabs/hands-on-modern-rl) |
| verl | 基于 `<project-root>/verl/{README.md,LICENSE,Notice.txt,setup.py,examples/grpo_trainer/**,examples/data_preprocess/gsm8k_tool_agent_loop.py,docs/advance/**,docs/sglang_multiturn/**,verl/trainer/**,verl/experimental/agent_loop/**,verl/experimental/reward_loop/**,verl/tools/**,verl/workers/rollout/sglang_rollout/**,verl/utils/dataset/rl_dataset.py}` 与 `<project-root>/arvo/cybergym-e2e-upstream/{README.md,LICENSE,scripts/validate.py,scripts/run_agent.py,scripts/utils.py}` 固定快照独立创作，仅导入 `guide/*.md` 教程 | `verl` | 13 | verl [`983cb0f`](https://github.com/verl-project/verl/commit/983cb0f24443f87b3d161fad318445130a620b07) · CyberGym-E2E [`b861317`](https://github.com/sunblaze-ucb/cybergym-e2e/commit/b861317f11641b14ab6ba08b5179d0b044601057) |
| DeepSpeed | 基于 `<project-root>/DeepSpeed/{README.md,LICENSE,setup.py,CONTRIBUTING.md,.pre-commit-config.yaml,.flake8,.style.yapf,deepspeed/__init__.py,deepspeed/runtime/**,deepspeed/comm/**,deepspeed/sequence/**,deepspeed/moe/**,deepspeed/inference/**,deepspeed/launcher/**,deepspeed/compile/**,deepspeed/module_inject/**,accelerator/**,op_builder/**,tests/**}` 固定快照独立创作，仅导入 `foundations/*.md`、`zero/*.md`、`parallel/*.md`、`engineering/*.md` 教程 | `deepspeed` | 20 | [`32e301f`](https://github.com/deepspeedai/DeepSpeed/commit/32e301ffaf5a7b2ae74be7a25b22c917bb4bf05a) · [上游仓库](https://github.com/deepspeedai/DeepSpeed) |
| Megatron-LM | 基于 `<project-root>/megatron-lm/{README.md,LICENSE,pyproject.toml,pretrain_gpt.py,model_provider.py,gpt_builders.py,megatron/core/**,megatron/training/**,docs/**,examples/run_simple_mcore_train_loop.py,tests/**}` 固定快照独立创作，仅导入 `foundations/*.md`、`source/*.md`、`labs/*.md` 教程 | `megatron-lm` | 24 | [`e79cb4c`](https://github.com/NVIDIA/Megatron-LM/commit/e79cb4c1bae1afd04322d979d08cb63832991ebe) · [上游仓库](https://github.com/NVIDIA/Megatron-LM) |
| pwn.college 中文原理教程 | 用户明确授权的 `<project-root>/security/{README.md,NOTICE.md,docs/00-start-here/*.md,docs/01-linux-luminarium/*.md,docs/02-computing-101/*.md,docs/03-playing-with-programs/*.md,docs/04-intro-to-cybersecurity/*.md,docs/05-program-security/*.md,docs/06-system-security/*.md,docs/07-software-exploitation/*.md,docs/90-community/README.md,docs/99-appendices/*.md}` 本地教程快照 | `pwn-college` | 67 | 官方内容语境 [`25334e8`](https://github.com/pwncollege/challenges/commit/25334e88d440fc1a45c1f445c88eda7ea00865f2) · 教程内容 [`e543c39`](https://github.com/sdjasj/os/commit/e543c397957abed3be810a3a31fc5f321fbdb29a) |

## 章节计数与辅助文件

展示章节数只计算网站正文，不计算索引、许可证和可下载示例：

- CubeSandbox：`00` 至 `10` 共 11 章；`guide/README.md` 和 `UPSTREAM_LICENSE` 是辅助文件。
- E2B：项目总览加 `01` 至 `11` 共 12 章；`guide/tutorial/README.md` 和 `UPSTREAM_LICENSE` 是辅助文件。
- MiniMind：主教程 `00` 至 `12` 共 13 章，Agentic RL 教程 `00` 至 `10` 共 11 章；两个目录的 `README.md` 和 `UPSTREAM_LICENSE` 是辅助文件。
- Ray：源码教程的 14 个编号章节及 glossary 共 15 章，使用指南 `00` 至 `14` 共 15 章；两个教程 `README.md`、`usage/examples/` 下的 README 与 Python 示例，以及 `UPSTREAM_LICENSE` 都是辅助文件。
- Strix：项目总览加 `00` 至 `12` 共 14 章；学习指南 `README.md` 和 `UPSTREAM_LICENSE` 是辅助文件。
- ARVO：两篇中文解读均计为章节。组合目录没有统一的根许可证，因此没有推测或合成 `UPSTREAM_LICENSE`。
- mini-swe-agent：`PROJECT_GUIDE_ZH.md` 计 1 章；`UPSTREAM_LICENSE` 是辅助文件。
- OpenHands：`00` 至 `14` 共 15 章；`guide/README.md` 和 `UPSTREAM_LICENSE` 是辅助文件。教程为基于固定提交独立创作的源码导读，不声称教程文件存在于上游提交；每章的源码入口映射到该提交中实际存在的代表性文件。根许可证说明 OpenHands 开源部分使用 MIT，而 `enterprise/` 使用其独立许可证，因此导入的 `UPSTREAM_LICENSE` 仅保留这一上游归属边界，不扩大 Enterprise 授权。
- Codex：`00` 至 `18` 共 19 章；`guide/README.md` 和 `UPSTREAM_LICENSE` 是辅助文件。教程为基于固定提交独立创作的源码导读，不声称教程文件存在于上游提交；每章的源码入口映射到该提交中实际存在的代表性文件。上游整体采用 Apache-2.0，`NOTICE` 还标注了部分 Ratatui 衍生代码的 MIT 归属；导入许可证仅用于保留这一上游边界。
- OpenClaw：`00` 至 `13` 共 14 章；`guide/README.md` 和 `UPSTREAM_LICENSE` 是辅助文件。教程是基于固定提交独立生成并经用户明确授权发布的中文源码导读，不声称教程文件存在于上游提交；正文中的相对源码链接映射到该提交中的真实文件。`UPSTREAM_LICENSE` 原样保留上游 MIT 许可证，不重新授权教程内容。
- Hands-On Modern RL：`00` 至 `13` 共 14 章；`guide/README.md` 和 `UPSTREAM_LICENSE` 是辅助文件。教程基于固定提交独立创作，每章的源码入口映射到该提交中实际存在的代表性文件。用户本轮授权生成并本地集成，但未请求推送或部署；教程衍生内容遵守上游 CC BY-NC-SA 4.0，`UPSTREAM_LICENSE` 原样保留许可证文本，不扩大授权。
- verl：`00` 至 `12` 共 13 章；`guide/README.md` 是辅助文件。教程以 verl 的 GRPO、SGLang、Agent Loop、Reward Loop 源码学习为主线，以 CyberGym-E2E 作为多阶段环境接入案例；教程为基于两个固定提交独立创作，不声称文件存在于任一上游提交。两个上游仓库分别声明 Apache License 2.0，本站不合并许可证文件，也不重新授权教程、源码或用户任务数据。用户本轮授权生成并本地集成，但未请求推送或部署。
- DeepSpeed：基础轨道 `00` 至 `04` 共 5 章、ZeRO 轨道 `05` 至 `10` 共 6 章、组合并行轨道 `11` 至 `15` 共 5 章、工程轨道 `16` 至 `19` 共 4 章，合计 20 章；根 `README.md` 与 `UPSTREAM_LICENSE` 是辅助文件。教程基于固定提交独立创作，每章源码入口映射到该提交中的真实代表文件，不声称教程文件存在于上游提交。`UPSTREAM_LICENSE` 原样保留上游 Apache-2.0 许可证，不扩大授权。用户本轮明确授权生成、集成并部署到 GitHub Pages。
- Megatron-LM：背景轨道 `00` 至 `04` 共 5 章、源码轨道 `00` 至 `13` 共 14 章、实践轨道 `00` 至 `04` 共 5 章，合计 24 章；根 `README.md` 与 `UPSTREAM_LICENSE` 是辅助文件。教程基于固定提交独立创作，每章源码入口映射到该提交中的真实代表文件，不声称教程文件存在于上游提交。`UPSTREAM_LICENSE` 原样保留上游根许可证及其中列出的第三方归属边界，不扩大授权。用户已在本轮明确要求提交、推送并部署到 GitHub Pages。
- pwn.college：59 篇官方主路径 module 教程、7 篇参考附录及 1 篇 Community Material 索引共 67 个展示章节。发布副本将 Community 的 `README.md` 改名为 `00-community-materials.md`；根 `README.md`、`NOTICE.md`、8 个主分区索引和附录索引是辅助文件。教程由本站工作区独立生成，并经用户本轮明确授权公开展示；它没有项目级许可证，因此不创建 `UPSTREAM_LICENSE`，公开可读不表示获得再利用授权，也不重新授权 pwn.college 或第三方材料。

许可证只是保留上游归属和许可信息，不代表本仓库重新授权教程或上游项目。教程中的源码路径和相对链接仍以对应快照的上游仓库结构为语境。

## PDF 阅读书库

`pdf/*.pdf` 是用户在本轮明确授权公开展示的精确文件白名单，共 10 本、948 页，站点入口为 `projects/pdf-library/`。这些文件不是外部项目源码快照，因此不登记虚构的上游仓库或统一许可证；页面保留 PDF 内已有的作者、来源、整理与许可说明，本站不重新授权文件内容。构建校验以文件名和 SHA-256 固定每一份公开快照，新增或替换文件时必须同步复核目录、页数、许可与安全边界。

书库包含大模型基础、智能体架构、强化学习、CUDA、AI 安全和网络安全资料。发布前已对可提取文本扫描私钥、常见服务令牌、JWT 与本机用户路径，未发现命中。CTF、越狱和安全 Benchmark 文档属于双用途材料；用户已明确授权公开展示，页面同时标注仅限合法学习、防御研究，以及自有、隔离或明确授权环境。本站没有随文发布挑战二进制、真实目标、凭据、漏洞数据库、模型、数据集或运行产物。

为避免在公开仓库中暴露本机目录，发布副本会把少量形如 `/home/<user>/...` 的环境路径规范化为 `/path/to/...`；除这项发布适配外，教程正文保持原有内容与章节结构。

## 明确排除的内容

- CS336 Assignment 1 的作业说明和个人实现按用户要求排除，不进入 `projects/`。
- 不复制 `.env` 或其他凭据配置、模型与 checkpoint、训练或评测数据、日志、缓存、虚拟环境、构建产物、`node_modules` 和 Git 元数据。
- `projects/` 不复制漏洞数据库、漏洞样本、利用代码或 PoC。Strix 与 ARVO 仅导入指定的教程 Markdown，不导入扫描数据、漏洞语料或复现材料；verl 教程也只引用 CyberGym-E2E 的通用环境与验证接口，不导入任务数据、补丁或运行产物。`pdf/` 中经用户明确授权的双用途教材按上一节的独立边界公开展示，但不附带真实目标、挑战文件、漏洞语料或运行产物。
- pwn.college 项目只导入原创教程 Markdown，不导入挑战二进制、题面副本、flag、solver、精确 payload 或 walkthrough。双用途章节仅使用本地玩具程序、符号模型和防御分析，并要求只在自有、隔离或明确授权环境中学习。
- 除 Ray 明确列出的使用示例外，不复制任何项目源码；Ray 示例也只限 `ray_usage_guide/examples/` 中的 Python 文件和 README。Codex、Hands-On Modern RL、DeepSpeed 与 Megatron-LM 教程同样不复制源码、用户配置、认证信息、模型、checkpoint、数据、日志、缓存、虚拟环境或构建产物。

## 新增项目的安全导入检查清单

1. 明确项目 slug、展示章节和精确的源文件白名单；不要以整个仓库或宽泛通配符作为复制范围。
2. 记录上游仓库地址和教程所依据的提交快照；确认教程文件的许可证来源。没有统一许可证时不要猜测、拼接或另行授权。
3. 在复制前检查源文件类型、普通文件状态和符号链接，拒绝超出白名单的文件及指向仓库外部的链接目标。
4. 在复制前对候选内容扫描私钥头、云厂商密钥、GitHub/OpenAI 等服务令牌、JWT 和高熵通用凭据赋值。疑似秘密命中时停止导入该文件，只报告文件与命中规则，不输出秘密内容。
5. 明确排除环境文件、源码、模型、数据集、日志、缓存、依赖目录、构建产物、Git 元数据，以及漏洞数据库、PoC 和其他不应公开的安全材料。
6. 只创建约定的内容目录，机械复制原文和必要许可证；仅对本机绝对路径做 `/path/to/...` 规范化，其他正文改写需另行授权。
7. 复制后逐文件做字节一致性检查，并再次执行同一套秘密扫描；确认目标树只包含允许的扩展名和文件名。
8. 汇总每组文件数与字节数，核对展示章节计数，并在本清单中更新源路径、slug、辅助文件和快照信息。
