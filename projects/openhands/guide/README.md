# OpenHands 源码学习教程索引

本目录是一套基于 OpenHands 提交 `6b04532541bf2b757d4820d31387b6cba6ffcaea` 编写的中文源码教程。教程是独立创作的学习材料，不是上游源码镜像；所有源码链接都固定到该提交，以避免主分支变化造成讲解与代码错位。

## 推荐顺序

1. `00`—`02`：建立背景、学习方法与仓库全景。
2. `03`—`07`：沿后端启动、会话、SDK 边界和 Sandbox 读通一次请求。
3. `08`—`09`：沿 React、TanStack Query、Zustand 与 WebSocket 读通前端数据流。
4. `10`—`11`：理解设置/密钥边界与 Enterprise 扩展方式。
5. `12`—`14`：掌握测试调试方法，完成一次端到端功能设计和综合练习。

## 章节清单

- `00-learning-roadmap.md`：学习路线、环境和源码阅读方法
- `01-coding-agent-foundations.md`：Coding Agent、事件流、工具调用与沙箱背景
- `02-repository-architecture.md`：仓库地图、迁移中的架构和进程边界
- `03-backend-bootstrap-and-di.md`：FastAPI 启动、lifespan、配置与依赖注入
- `04-conversation-lifecycle.md`：创建、查询、发消息、暂停和归档会话
- `05-agent-server-and-sdk-boundary.md`：App Server 如何调用 Agent Server 与 SDK
- `06-events-streaming-and-state.md`：事件模型、持久化、流式输出与状态投影
- `07-sandbox-runtime-and-security.md`：Docker/Process/Remote Sandbox 与安全边界
- `08-frontend-architecture.md`：React Router、TanStack Query、Zustand 与组件层次
- `09-realtime-chat-dataflow.md`：WebSocket、历史回放、乐观消息和去重
- `10-settings-secrets-and-auth.md`：设置、SecretSource、会话密钥与认证
- `11-enterprise-extension.md`：Enterprise 路由、组织权限、数据库与迁移
- `12-testing-and-debugging.md`：pytest、Vitest、分层测试与调用链调试
- `13-build-an-end-to-end-feature.md`：以新增设置为例走通完整功能开发
- `14-capstone-and-glossary.md`：综合源码练习、排障剧本和术语表

## 使用约定

- `<project-root>` 表示 OpenHands 仓库根目录。
- 命令默认从 `<project-root>` 执行；标注 `frontend/` 或 `enterprise/` 的命令需要先进入相应目录。
- “本仓库”指 OpenHands/OpenHands；“SDK 仓库”指 `OpenHands/software-agent-sdk`。当前架构中真正的 Agent 循环主要由依赖包提供，本教程不会假装它仍位于本仓库旧目录中。
- 实验优先使用静态阅读、单元测试和 mock；启动本地运行时前，请先理解第 07 章的权限边界。

## 归属与许可

教程引用的 OpenHands 开源部分遵循仓库根许可证；`enterprise/` 内容使用其自己的 Polyform Free Trial 许可证。`UPSTREAM_LICENSE` 原样保留了上游根许可证说明。教程本身不据此推定或扩大授权。
