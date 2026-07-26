# Codex 源码学习教程索引

本目录是一套基于 OpenAI Codex 提交 `61a44880a85d2fd0d8770908dea5733495e571c8` 独立编写的中文源码教程。它不是源码镜像，也不假定教程文件存在于上游提交；正文中的源码入口都指向该固定快照，产品使用背景则以 OpenAI 官方 Codex 文档为补充。

## 学习目标

完成全部章节后，你应该能够：

- 从 `codex` 命令追踪到 TUI、app-server、core session 和 Responses API；
- 解释 Thread、Turn、Item、Submission、Event 与 Rollout 的区别；
- 读懂模型流式输出触发工具调用、审批、沙箱执行和结果回填的闭环；
- 判断新能力应落在 CLI、TUI、app-server protocol、core、独立 crate 还是 SDK；
- 理解 `AGENTS.md`、skill、plugin、hook、MCP 和 app 各自解决的问题；
- 使用集成测试、快照测试、JSON-RPC 测试客户端和 tracing 定位问题；
- 设计一项跨协议、核心、界面和测试的功能，并列出兼容性检查项。

## 推荐顺序

1. `00`—`02`：建立学习方法、Rust/Agent 背景和工作区地图。
2. `03`—`07`：沿 CLI → TUI/app-server → core → Responses API 走通主请求链。
3. `08`—`12`：深入工具、命令执行、安全边界和扩展系统。
4. `13`—`15`：理解上下文、持久化、恢复/分叉和多 Agent 协作。
5. `16`—`18`：掌握非交互接口、测试调试方法，并完成综合设计练习。

## 章节清单

- `00-learning-roadmap.md`：学习路线、环境分级、读码方法与总调用链
- `01-rust-async-agent-foundations.md`：Rust 所有权、异步消息、流与工具型 Agent 背景
- `02-workspace-and-crate-map.md`：Cargo workspace、crate 分层和依赖方向
- `03-cli-bootstrap-and-dispatch.md`：Clap 命令树、配置引导与多入口分发
- `04-tui-event-loop.md`：Ratatui、AppEvent、嵌入式 app-server 与渲染循环
- `05-app-server-jsonrpc.md`：JSON-RPC v2、Thread/Turn/Item 生命周期与通知
- `06-core-session-protocol.md`：SQ/EQ、Session、CodexThread、ThreadManager 与任务生命周期
- `07-responses-turn-loop.md`：Prompt、Responses API、SSE/WebSocket 和采样循环
- `08-tool-routing-dispatch.md`：工具规格、ToolRouter、Registry、hook 与并行调用
- `09-shell-apply-patch-unified-exec.md`：shell、统一 exec、PTY、apply_patch 和结果回填
- `10-config-approval-sandbox.md`：配置分层、管理约束、审批策略和三平台沙箱
- `11-mcp-apps-extensions.md`：MCP 连接、工具发现、Apps 与扩展边界
- `12-agents-skills-plugins-hooks.md`：持久指令、技能、插件和生命周期 hook
- `13-context-history-compaction.md`：模型可见上下文、归一化、截断和压缩
- `14-rollout-resume-fork.md`：JSONL rollout、SQLite 投影、恢复、回滚与分叉
- `15-multi-agent-and-goals.md`：Agent 树、通信、并发限制、预算和持久目标
- `16-exec-sdk-programmatic.md`：`codex exec`、JSONL、TypeScript/Python SDK
- `17-testing-debugging-observability.md`：nextest、wiremock、insta、tracing 与分层排错
- `18-feature-workshop-and-glossary.md`：端到端功能设计、检查清单和术语表

## 使用约定

- `<project-root>` 表示 Codex 仓库根目录。
- `<project-root>/codex-rs` 是 Cargo workspace；根 `justfile` 会自动把多数 Rust 命令切到该目录。
- 所有命令默认只读；带有“会写文件”“会调用模型”或“可能产生费用”的实验会明确标注。
- 章节展示的是固定提交中的结构。若你的本地分支不同，先用 `git rev-parse HEAD` 记录快照，再根据符号搜索，而不要死记行号。
- 本教程不会复制源码树、凭据、本地配置、rollout、日志或构建产物。

## 归属与许可

Codex 上游源码采用 Apache License 2.0，根 `NOTICE` 标注 “OpenAI Codex, Copyright 2025 OpenAI”，并说明部分代码源自 Ratatui。本目录的 `UPSTREAM_LICENSE` 原样保留上游许可证；教程中的短源码片段用于解释固定快照，源码归属仍属于上游贡献者。教程文件的创作不推定或扩大上游项目授权。
