# Strix 项目功能与使用速览

这份文档用于在较短时间内理解 Strix：它解决什么问题、内部怎样工作、如何运行，以及应该从哪些源码开始阅读。

> Strix 是安全测试工具。只能扫描自己拥有或已获得明确授权的代码、网站、域名和 IP。

## 1. 一句话介绍

Strix 是一个开源的 AI 渗透测试框架。它把大语言模型、Docker 安全工具箱、HTTP 拦截代理和多 Agent 协作组合起来，对应用进行源码分析和动态安全验证，并将确认的漏洞输出为 Markdown、JSON、CSV 和 SARIF 报告。

它与只做规则匹配的传统扫描器不同：Agent 可以阅读代码、运行命令、操作浏览器、观察和重放 HTTP 请求，并要求用实际证据或 PoC 验证漏洞后再提交报告。

## 2. 项目的主要功能

### 2.1 支持多种扫描目标

Strix 可以接收：

- 本地代码目录；
- Git 仓库 URL；
- 已部署的 Web 应用 URL；
- 域名或 IP 地址；
- 多个目标的组合，例如“源码 + 测试环境 URL”。

常见用法：

```bash
# 本地源码白盒分析
strix --target ./my-app

# Git 仓库分析
strix --target https://github.com/example/my-app.git

# Web 应用黑盒测试
strix --target https://staging.example.com

# 同时提供源码和部署环境
strix -t ./my-app -t https://staging.example.com
```

### 2.2 多 Agent 协作

扫描由一个根 Agent 负责统筹。根 Agent 可以创建多个专门的子 Agent，例如：

- 侦察与攻击面梳理；
- 身份认证和 JWT；
- 访问控制与 IDOR；
- SQL 注入、XSS、SSRF 等专项验证；
- 源码静态分析或依赖漏洞分析。

每个 Agent 有独立的模型会话、任务、技能和状态。子 Agent 完成后把结果发回父 Agent，根 Agent 汇总所有已验证发现并生成最终报告。

### 2.3 隔离的安全测试环境

Agent 不直接在 Strix 主进程中执行安全命令，而是在 Docker 沙箱中工作。官方沙箱包含：

- Python、Go、Node.js、Git 等开发工具；
- nmap、nuclei、sqlmap、ffuf、subfinder、naabu；
- Semgrep、Bandit、Trivy、Gitleaks 等代码与依赖分析工具；
- Chromium 和自动化浏览器；
- Caido HTTP 代理。

本地源码会被复制到容器的 `/workspace/<项目名>`。大型仓库可以通过 `--mount` 只读挂载，避免逐文件复制：

```bash
strix --mount ./large-monorepo
```

### 2.4 HTTP 流量分析

沙箱中的 HTTP/HTTPS 请求默认经过 Caido。Agent 可以：

- 查看请求和响应；
- 浏览站点结构；
- 修改并重放请求；
- 分析认证、会话和输入处理行为；
- 保存漏洞验证证据。

这使得浏览器、curl 和其他扫描工具产生的流量能够被统一观察。

### 2.5 技能系统

`strix/skills/` 中的 Markdown 文件向 Agent 提供专项知识，例如：

- 漏洞类型：SQL 注入、XSS、SSRF、XXE、IDOR 等；
- 框架：Django、FastAPI、Next.js、NestJS；
- 协议：OAuth、GraphQL；
- 云环境：AWS、GCP、Kubernetes；
- 工具：nmap、nuclei、sqlmap、Semgrep 等。

技能不是可执行代码，而是注入 Agent 上下文的测试方法、验证流程和误报排除知识。根 Agent还会根据扫描模式和目标类型自动加载必要技能。

### 2.6 漏洞验证与报告

Agent 提交普通漏洞时，需要提供描述、影响、技术分析、PoC、证据、前置条件、修复建议和 CVSS 指标。项目会：

1. 校验必填字段；
2. 根据 CVSS 指标计算严重度；
3. 检查是否与已有漏洞重复；
4. 分配 `vuln-0001` 形式的编号；
5. 立即保存到扫描目录。

依赖组件的已知 CVE 使用单独的依赖报告流程，根据 CVE、包名和生态进行识别和去重。

### 2.7 扫描恢复和成本限制

扫描状态会持续写入磁盘。如果模型限流、终端中断或主动停止，可以恢复：

```bash
strix --resume <run-name>
```

还可以限制 LLM 成本：

```bash
strix --target ./my-app --max-budget-usd 5
```

达到预算后，系统会停止整个 Agent 图，并保留已有状态和报告。

### 2.8 本地结果查看器

扫描结果可以通过本地 Web 页面查看：

```bash
# 打开最近一次运行
strix view

# 打开指定运行
strix view <run-name>
```

Viewer 可以显示：

- 扫描状态和严重度分布；
- 漏洞详情、PoC 和修复建议；
- 多 Agent 拓扑与执行记录；
- token 和成本信息；
- 历史运行。

由交互式 TUI 启动的 Viewer 还可以向正在运行的 Agent 发送调整指令。单独执行 `strix view` 时只读取磁盘结果，不能控制已经结束或位于其他进程中的扫描。

## 3. 一次扫描是怎样运行的

可以把主流程理解为：

```text
用户执行 strix
  ↓
解析参数、目标和配置
  ↓
检查 Docker，连接并预热 LLM
  ↓
创建运行目录和 ReportState
  ↓
创建 Docker 沙箱和 Caido HTTP 代理
  ↓
构建根 Agent、系统提示词、技能和工具
  ↓
模型通过工具读取代码、执行命令和测试应用
  ↓
根 Agent按需要创建专项子 Agent
  ↓
确认的漏洞立即写入磁盘
  ↓
根 Agent调用 finish_scan 生成最终报告
  ↓
清理容器，通过 CLI、TUI 或 Viewer 展示结果
```

项目中最重要的调用链是：

```text
pyproject.toml
  -> strix.interface.main:main
  -> run_cli() 或 run_tui()
  -> run_strix_scan()
  -> run_agent_loop()
  -> Agents SDK Runner.run_streamed()
  -> 各类工具和子 Agent
```

## 4. 快速开始

### 4.1 环境要求

- Python 3.12 或更高版本；
- 正在运行的 Docker；
- `uv`，用于本地开发；
- 一个受支持的 LLM 提供商及相应凭证。

### 4.2 从源码安装依赖

在项目根目录执行：

```bash
uv sync
```

确认 CLI：

```bash
uv run strix --version
uv run strix --help
```

### 4.3 配置模型

最常见的配置方式：

```bash
export STRIX_LLM="openai/gpt-5.4"
export LLM_API_KEY="你的 API Key"
```

项目也通过 LiteLLM 支持多种带 provider 前缀的模型，例如 Anthropic、Gemini、OpenRouter、Bedrock、Vertex AI 和本地 OpenAI 兼容端点。

使用自定义 API 地址时：

```bash
export STRIX_LLM="ollama/qwen3"
export LLM_API_BASE="http://localhost:11434"
```

不要把 API Key 写入仓库或提交记录。

### 4.4 运行第一次本地源码扫描

交互式模式：

```bash
uv run strix --target ./your-project --scan-mode quick
```

非交互模式：

```bash
uv run strix -n --target ./your-project --scan-mode quick
```

第一次运行需要拉取沙箱镜像，耗时会明显长于之后的扫描。

## 5. 扫描模式怎么选

| 模式 | 适用场景 | 特点 |
| --- | --- | --- |
| `quick` | PR、CI、快速检查 | 时间短，优先高价值路径 |
| `standard` | 日常安全测试 | 覆盖与成本平衡 |
| `deep` | 完整安全评估 | 更全面，默认模式，耗时和成本更高 |

示例：

```bash
strix -n -t ./my-app --scan-mode quick
strix -t https://staging.example.com --scan-mode standard
strix -t ./my-app -t https://staging.example.com --scan-mode deep
```

## 6. 常用高级参数

### 自定义测试重点

```bash
strix -t https://staging.example.com \
  --instruction "重点检查登录、JWT 和越权访问"
```

长说明可以放入文件：

```bash
strix -t https://staging.example.com \
  --instruction-file ./rules-of-engagement.md
```

`--instruction` 和 `--instruction-file` 不能同时使用。附加说明不能扩大最初指定的授权目标范围。

### PR 差异范围

```bash
strix -n -t ./ --scan-mode quick --scope-mode diff --diff-base origin/main
```

`--scope-mode` 可选：

- `auto`：在合适的非交互 CI/PR 环境自动启用；
- `diff`：强制聚焦相对 base 的变更；
- `full`：扫描完整代码范围。

Diff 模式需要可访问的完整 Git 历史。CI checkout 通常要设置 `fetch-depth: 0`。

### 批量目标

目标文件每行一个目标，支持空行和以 `#` 开始的注释：

```bash
strix --target-list ./targets.txt
```

## 7. 扫描结果在哪里

结果保存在当前工作目录：

```text
strix_runs/<run-name>/
├── run.json                    # 运行配置、状态、时间、模型用量
├── strix.log                   # 扫描调试日志
├── penetration_test_report.md # 最终综合报告
├── vulnerabilities.json       # 完整漏洞数据
├── vulnerabilities.csv        # 漏洞索引
├── findings.sarif             # CI/代码扫描平台格式
├── vulnerabilities/
│   ├── vuln-0001.md
│   └── ...
└── .state/
    ├── agents.json             # Agent 拓扑和状态
    └── agents.db               # 各 Agent 的模型与工具会话
```

`run.json` 和漏洞文件是面向产品与 Viewer 的结果；`.state/` 主要用于恢复扫描和重建 Agent 执行记录。

## 8. 项目源码应该从哪里读

建议按这个顺序阅读：

1. [`pyproject.toml`](../pyproject.toml)：依赖、CLI 入口和质量工具配置。
2. [`strix/interface/main.py`](../strix/interface/main.py)：命令入口、参数解析和启动预检。
3. [`strix/interface/cli.py`](../strix/interface/cli.py)：非交互模式怎样构造扫描配置。
4. [`strix/core/runner.py`](../strix/core/runner.py)：整个扫描的装配中心。
5. [`strix/core/execution.py`](../strix/core/execution.py)：模型流、Agent 循环和异常处理。
6. [`strix/core/agents.py`](../strix/core/agents.py)：多 Agent 状态、消息和拓扑。
7. [`strix/agents/factory.py`](../strix/agents/factory.py)：提示词、工具和 Agent 的组合方式。
8. [`strix/runtime/session_manager.py`](../strix/runtime/session_manager.py)：Docker、源码装载和 Caido。
9. [`strix/report/state.py`](../strix/report/state.py)：漏洞与最终报告的持久化。
10. [`strix/viewer/server.py`](../strix/viewer/server.py)：本地 Viewer API 和安全门禁。

如果需要更深入的分模块教程，继续阅读 [`docs/learning-guide/README.md`](learning-guide/README.md)。

## 9. 理解项目时要区分的四类状态

| 状态 | 负责模块 | 保存位置 |
| --- | --- | --- |
| 扫描输入和最终状态 | `ReportState` / CLI | `run.json` |
| 漏洞和报告 | `ReportState` | JSON、CSV、Markdown、SARIF |
| Agent 拓扑与运行状态 | `AgentCoordinator` | `.state/agents.json` |
| 模型、消息和工具历史 | SDK `SQLiteSession` | `.state/agents.db` |

这四类状态不能混为一谈。例如，存在 `run.json` 不代表已经有可恢复的 Agent 会话；恢复还需要 `agents.json` 和 `agents.db`。

## 10. 常见问题

### Docker 不可用

先检查：

```bash
docker info
```

Strix 不仅需要 Docker 命令，还需要当前用户能够连接 Docker daemon。

### LLM 连接失败

检查模型名是否包含正确 provider 前缀、API Key 是否对应，以及自定义 Base URL 是否可达。不要在日志或求助信息中暴露完整 Key。

### 本地 Web 服务无法从沙箱访问

容器中的 `localhost` 指向容器自身。Strix 会把目标中的 localhost 改写为 `host.docker.internal`，但宿主服务本身仍需监听允许 Docker 网关访问的地址。

### 本地仓库太大

超过复制阈值时使用：

```bash
strix --mount ./large-repository
```

挂载是只读的，适合分析大型仓库。

### 扫描中断

查看终端输出中的 run name，然后：

```bash
strix --resume <run-name>
```

也可以先用 `strix view <run-name>` 查看已经保存的发现。

### 需要调试日志

```bash
export STRIX_DEBUG=1
```

完整日志始终保存在 `strix_runs/<run-name>/strix.log`。

## 11. 30 分钟快速理解路线

如果只想快速掌握主干，可以按以下顺序：

1. 用 5 分钟阅读本文第 1～3 节。
2. 用 5 分钟查看 `pyproject.toml` 和 `interface/main.py::main()`。
3. 用 10 分钟阅读 `core/runner.py::run_strix_scan()`，只关注它组装了哪些对象。
4. 用 5 分钟阅读 `core/agents.py::AgentCoordinator` 的字段和 `send()`。
5. 用 5 分钟查看 `report/state.py::_save_artifacts()` 和一次测试生成的 run 目录。

最终应能用一句话描述主链路：

> Strix 把用户目标标准化后，在 Docker 中为模型提供文件、Shell、浏览器和 HTTP 代理工具，由可恢复的多 Agent 系统完成授权安全验证，再把经过校验的发现持续写成标准化报告。
