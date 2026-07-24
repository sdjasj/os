# 外部项目教程清单与维护说明

`projects/` 保存从外部项目导入的教程内容快照，供网站展示使用。它不是上游源码镜像，也不替代本仓库原有的课程材料：OS 相关内容仍分别维护在根目录的 `tutorial/`、`sources/` 和 `examples/` 中。

## 已导入项目

下表中的“快照”是教程生成或校对时所依据的上游仓库 `HEAD`。教程文件可能来自该快照之上的本地工作树，因此提交号用于标记源码语境，不表示教程文件已经进入上游提交。

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

许可证只是保留上游归属和许可信息，不代表本仓库重新授权教程或上游项目。教程中的源码路径和相对链接仍以对应快照的上游仓库结构为语境。

为避免在公开仓库中暴露本机目录，发布副本会把少量形如 `/home/<user>/...` 的环境路径规范化为 `/path/to/...`；除这项发布适配外，教程正文保持原有内容与章节结构。

## 明确排除的内容

- CS336 Assignment 1 的作业说明和个人实现按用户要求排除，不进入 `projects/`。
- 不复制 `.env` 或其他凭据配置、模型与 checkpoint、训练或评测数据、日志、缓存、虚拟环境、构建产物、`node_modules` 和 Git 元数据。
- 不复制漏洞数据库、漏洞样本、利用代码或 PoC。Strix 与 ARVO 仅导入指定的教程 Markdown，不导入扫描数据、漏洞语料或复现材料。
- 除 Ray 明确列出的使用示例外，不复制任何项目源码；Ray 示例也只限 `ray_usage_guide/examples/` 中的 Python 文件和 README。

## 新增项目的安全导入检查清单

1. 明确项目 slug、展示章节和精确的源文件白名单；不要以整个仓库或宽泛通配符作为复制范围。
2. 记录上游仓库地址和教程所依据的提交快照；确认教程文件的许可证来源。没有统一许可证时不要猜测、拼接或另行授权。
3. 在复制前检查源文件类型、普通文件状态和符号链接，拒绝超出白名单的文件及指向仓库外部的链接目标。
4. 在复制前对候选内容扫描私钥头、云厂商密钥、GitHub/OpenAI 等服务令牌、JWT 和高熵通用凭据赋值。疑似秘密命中时停止导入该文件，只报告文件与命中规则，不输出秘密内容。
5. 明确排除环境文件、源码、模型、数据集、日志、缓存、依赖目录、构建产物、Git 元数据，以及漏洞数据库、PoC 和其他不应公开的安全材料。
6. 只创建约定的内容目录，机械复制原文和必要许可证；仅对本机绝对路径做 `/path/to/...` 规范化，其他正文改写需另行授权。
7. 复制后逐文件做字节一致性检查，并再次执行同一套秘密扫描；确认目标树只包含允许的扩展名和文件名。
8. 汇总每组文件数与字节数，核对展示章节计数，并在本清单中更新源路径、slug、辅助文件和快照信息。
