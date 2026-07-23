# E2B 中文源码学习教程

这套教程面向两类读者：希望系统理解 E2B SDK 如何工作的使用者，以及准备为本仓库贡献代码的开发者。内容以当前仓库的真实实现为准，所有代码链接都指向项目文件。

开始之前，先阅读[项目总览与使用指南](../PROJECT_OVERVIEW.md)，至少成功创建一次 Sandbox 并执行一条命令。

## 教程目录

| 顺序 | 模块                                                           | 学完后能够                                              |
| ---- | -------------------------------------------------------------- | ------------------------------------------------------- |
| 1    | [背景知识：隔离、控制面与数据面](01-background.md)             | 解释 Sandbox、Template、envd、OpenAPI、RPC 和流式通信   |
| 2    | [仓库结构与开发工具链](02-repository-and-toolchain.md)         | 在 monorepo 中定位功能，安装依赖并运行检查              |
| 3    | [Sandbox 生命周期与创建调用链](03-sandbox-lifecycle.md)        | 从公开 API 追到 HTTP 请求，理解创建、暂停、快照、Fork   |
| 4    | [命令、事件流与 PTY](04-commands-streaming-pty.md)             | 读懂进程协议、后台句柄、stdout/stderr 流和交互终端      |
| 5    | [文件系统、Git 与 Volume](05-files-git-volume.md)              | 区分临时文件系统与持久卷，并理解 Git 封装方式           |
| 6    | [Template 构建系统](06-template-build.md)                      | 从 Builder 指令追踪到上传、缓存、远端构建和日志轮询     |
| 7    | [API、连接配置、超时与错误](07-api-connection-errors.md)       | 理解多种超时、鉴权、错误映射及版本兼容                  |
| 8    | [Python 同步/异步双实现](08-python-sync-async.md)              | 在 JS、Python sync、Python async 之间做等价修改         |
| 9    | [CLI 的设计与执行链](09-cli.md)                                | 读懂 Commander 命令、凭据来源、Template 与 Sandbox 命令 |
| 10   | [测试、代码生成与贡献实战](10-testing-codegen-contribution.md) | 写测试、运行检查、修改协议、生成 changeset              |
| 11   | [循序渐进的源码实验](11-labs.md)                               | 用 8 个实验把知识串成可验证的能力                       |

## 推荐路线

### 路线 A：以使用为主

按 1 → 3 → 4 → 5 → 6 的顺序阅读，然后完成实验 1～5。这样能快速建立“怎样安全运行代码”和“怎样预构建环境”的完整心智模型。

### 路线 B：准备贡献 SDK

完整阅读 1～10，然后完成实验 6～8。尤其要关注跨语言等价性、生成文件边界、测试 fixture 和三类超时。

### 路线 C：只研究某条调用链

- `Sandbox.create()`：模块 3、7、8；
- `commands.run()`：模块 4、7；
- `files.read/write()`：模块 5、7；
- `Template.build()`：模块 6、7；
- CLI：模块 9，再回看它调用的 SDK 模块。

## 阅读源码的方法

每学一个功能，建议坚持四步：

1. 从公开导出或 CLI 命令入手，确认用户看到的 API；
2. 找到参数类型，明确默认值、单位和返回类型；
3. 沿调用链追到 OpenAPI/Connect RPC 请求；
4. 阅读对应测试，确认边界条件和预期行为。

例如 `Sandbox.create()` 的最短阅读路径为：

```text
packages/js-sdk/src/index.ts
  → packages/js-sdk/src/sandbox/index.ts
  → packages/js-sdk/src/sandbox/sandboxApi.ts
  → packages/js-sdk/src/api/index.ts
  → spec/openapi.yml
  → packages/js-sdk/tests/sandbox/create.test.ts
```

不要一开始通读所有生成文件。`schema.gen.ts`、`e2b/api/client/` 和 `*_pb2.py` 主要用于提供类型与协议胶水；先理解手写适配层，遇到字段疑问时再回查生成代码和 `spec/`。

## 术语约定

- **Sandbox**：云端隔离运行环境；
- **Template**：用于启动 Sandbox 的预构建镜像/配方；
- **Snapshot**：从某个 Sandbox 状态创建的持久模板版本；
- **Volume**：独立于单个 Sandbox 生命周期的持久文件存储；
- **控制面**：负责资源创建、状态和生命周期的 E2B API；
- **envd**：运行在 Sandbox 中、供 SDK 操作进程和文件的服务；
- **SDK API**：开发者直接调用的手写高级 API；
- **生成客户端**：由 OpenAPI/Protobuf/JSON Schema 生成的底层类型和客户端。

## 学习完成标准

完成教程后，你应当可以不依赖搜索做到：

- 画出创建 Sandbox 和运行命令的端到端调用链；
- 判断一个新功能应修改手写层、协议层还是两者；
- 正确处理 JS 毫秒与 Python 秒的差异；
- 为 JS、Python 同步、Python 异步实现等价功能；
- 选择 mock 单元测试、debug envd 测试或真实云集成测试；
- 修改协议后重新生成客户端，并避免手改生成文件；
- 在提交包变更时完成格式、lint、类型检查、测试和 changeset。
