# 模块 2：仓库结构与开发工具链

本模块的目标是让你能在几分钟内判断“一个功能在哪里”“哪些文件是生成的”“该运行什么命令”。

## 1. Monorepo 与 workspace 背景

Monorepo 把多个相互关联的包放在同一个 Git 仓库。E2B 用 [`pnpm-workspace.yaml`](../../../pnpm-workspace.yaml) 把 `packages/*` 和 `spec` 纳入 workspace，根 [`package.json`](../../../package.json) 通过 `pnpm --recursive` 统一调用各包脚本。

```text
E2B/
├── packages/
│   ├── js-sdk/          # npm: e2b
│   ├── python-sdk/      # PyPI: e2b
│   ├── cli/             # npm: @e2b/cli
│   └── connect-python/  # 自定义 Protobuf/Connect Python 生成器
├── spec/                # 协议事实来源
├── templates/base/      # 基础模板
├── .github/workflows/   # CI/CD
├── .changeset/          # 包发布变更说明
└── Makefile             # 跨语言 codegen 入口
```

根脚本的递归行为：

```json
{
  "test": "pnpm test --recursive --if-present",
  "lint": "pnpm --if-present --recursive run lint",
  "typecheck": "pnpm --if-present --recursive run typecheck",
  "format": "pnpm --if-present --recursive run format"
}
```

这意味着根命令会进入各 workspace 包运行对应脚本。它不是单一测试套件，而是多个包测试的聚合器。

## 2. JavaScript SDK 的分层

入口是 [`packages/js-sdk/src/index.ts`](../../../packages/js-sdk/src/index.ts)，它决定 npm 用户能导入什么。内部结构：

```text
src/
├── index.ts                 # 公开导出
├── connectionConfig.ts      # 域名、凭据、超时、代理、AbortSignal
├── errors.ts                # 公开错误类
├── api/
│   ├── index.ts             # 控制面 ApiClient 与错误映射
│   └── schema.gen.ts        # OpenAPI 生成
├── envd/
│   ├── api.ts               # envd HTTP 适配
│   ├── rpc.ts               # Connect RPC 错误映射与用户名鉴权
│   ├── process/*            # Protobuf 生成
│   └── filesystem/*         # Protobuf 生成
├── sandbox/
│   ├── index.ts             # 高层 Sandbox，组装子模块
│   ├── sandboxApi.ts        # 控制面生命周期 API
│   ├── commands/*           # 命令、句柄、PTY
│   ├── filesystem/*         # 文件内容和元数据
│   └── git/*                # Git 命令封装
├── template/*               # Builder、Dockerfile 解析、构建上传
└── volume/*                 # Volume 控制面和内容 API
```

快速定位规则：

- 用户可见类型/导出有问题：先看 `src/index.ts`；
- 创建、暂停、Snapshot：`sandbox/sandboxApi.ts`；
- 实例怎样组装：`sandbox/index.ts` 构造函数；
- 命令流：`commands/index.ts` 与 `commandHandle.ts`；
- 协议字段：先查 `spec/`，不要先改 `*.gen.ts`。

## 3. Python SDK 为什么分三层

Python SDK 同时提供：

```python
from e2b import Sandbox       # 同步
from e2b import AsyncSandbox  # asyncio
```

目录按“共享定义 + 两套 I/O 实现”组织：

```text
e2b/
├── __init__.py              # 公开导出
├── sandbox/                 # 共享类型、基础类、协议无关辅助函数
├── sandbox_sync/            # httpx.Client + 同步 Connect 客户端
├── sandbox_async/           # httpx.AsyncClient + 异步 Connect 客户端
├── template/                # 共享 Builder 数据结构
├── template_sync/           # 同步构建 API
├── template_async/          # 异步构建 API
├── volume/volume_sync.py
├── volume/volume_async.py
├── api/client/              # OpenAPI 生成
└── envd/*                   # Protobuf/Connect 生成和适配
```

共享层不代表“只改一处即可”。凡是涉及网络、文件 I/O、流和等待的功能，通常在 sync/async 各有实现；仓库规则要求 SDK 变更同时覆盖 JS、Python sync 和 Python async。

一个常见阅读方法是并排比较：

- [`sandbox_sync/commands/command.py`](../../../packages/python-sdk/e2b/sandbox_sync/commands/command.py)
- [`sandbox_async/commands/command.py`](../../../packages/python-sdk/e2b/sandbox_async/commands/command.py)

它们的类型和行为应该等价，区别主要是 `await`、客户端类型、生成器类型和资源关闭方式。

## 4. CLI 不是另一套后端客户端

CLI 在 [`packages/cli/src`](../../../packages/cli/src) 中，使用 Commander 构建命令树，并把大部分工作委托给 JS SDK：

```text
e2b CLI command
  → 参数解析和人机交互
  → ensureAPIKey()/ensureAccessToken()
  → import { Sandbox, Template } from 'e2b'
  → SDK
```

因此 CLI 功能出错时要先判断：

- 参数、输出、凭据选择错误：改 CLI；
- SDK 调用行为错误：改 JS SDK，并同步 Python；
- 服务契约缺字段：改 `spec/` 并 codegen。

## 5. 手写文件和生成文件

生成文件有明确来源：

| 来源                             | JS 生成物                             | Python 生成物                          |
| -------------------------------- | ------------------------------------- | -------------------------------------- |
| `spec/openapi.yml`               | `src/api/schema.gen.ts`               | `e2b/api/client/`                      |
| `spec/openapi-volumecontent.yml` | `src/volume/schema.gen.ts`            | `e2b/volume/client/`                   |
| `spec/envd/*.proto`              | `src/envd/**/*_pb.ts`、`*_connect.ts` | `e2b/envd/**/*_pb2.py`、Connect 客户端 |
| `spec/mcp-server.json`           | `src/sandbox/mcp.d.ts`                | `e2b/sandbox/mcp.py`                   |

原则：

1. 协议变化先改 `spec/`；
2. 在仓库根运行 `make codegen`；
3. 审查所有生成 diff；
4. 手写高层适配层把协议字段映射为稳定的 SDK 命名和类型；
5. 不把长期修复只留在生成文件中，否则下次 codegen 会覆盖。

[`codegen.Dockerfile`](../../../codegen.Dockerfile) 固定 protoc、buf、Node、pnpm 和 Python 生成器版本，目的是让开发机与 CI 生成结果一致。

## 6. 开发环境

版本来源是 [`.tool-versions`](../../../.tool-versions)：

```text
nodejs 22.18.0
pnpm 9.15.5
python 3.10
uv 0.10.0
```

安装依赖：

```bash
pnpm install

cd packages/python-sdk
uv sync
cd ../..
```

为什么分别使用 pnpm 和 uv：pnpm 管理 JS workspace、锁文件和递归脚本；uv 管理 Python 虚拟环境、依赖锁定和运行命令。不要用 npm/yarn 或直接 pip 改依赖状态，否则容易产生与项目约定不一致的锁文件。

## 7. 凭据和运行模式

默认凭据位置由仓库约定为：

- 根目录 `.env.local`；
- `~/.e2b/config.json`。

JS SDK 自身通过环境变量读取 `E2B_API_KEY` 等配置，但测试如何加载 `.env.local` 取决于测试配置。不要假设所有命令都会自动 source 该文件。

常见环境变量：

| 变量                   | 作用                      |
| ---------------------- | ------------------------- |
| `E2B_API_KEY`          | SDK API Key               |
| `E2B_ACCESS_TOKEN`     | CLI 账户访问 Token        |
| `E2B_TEAM_ID`          | CLI 团队选择              |
| `E2B_DOMAIN`           | API/Sandbox 域名          |
| `E2B_API_URL`          | 覆盖控制面 URL            |
| `E2B_SANDBOX_URL`      | 覆盖 envd URL             |
| `E2B_DEBUG`            | 连接本地服务的 debug 模式 |
| `E2B_INTEGRATION_TEST` | 开启 JS 集成测试路径      |
| `ENABLE_VOLUME_TESTS`  | 开启真实 Volume 测试      |

不要在教程实验中打印完整环境变量或配置文件内容。验证凭据是否存在只需检查变量是否为空。

## 8. 测试层级

### 8.1 纯单元测试

使用 Vitest/Pytest 测试解析、校验、错误映射等纯逻辑。例如 Git status 解析、模板路径校验和 CLI 参数构建。

### 8.2 HTTP mock 测试

JS 使用 MSW 模拟控制面。例如 [`volume.test.ts`](../../../packages/js-sdk/tests/volume/volume.test.ts) 用内存 `Map` 模拟 Volume CRUD。这类测试快、不创建云资源，适合验证请求字段、响应映射和错误状态。

### 8.3 Sandbox/Volume fixture 集成测试

[`packages/js-sdk/tests/setup.ts`](../../../packages/js-sdk/tests/setup.ts) 中的 `sandboxTest` 会真实 `Sandbox.create()`，在 `finally` 中 kill；`volumeTest` 仅在 `ENABLE_VOLUME_TESTS` 存在时开启。

Python 的 [`conftest.py`](../../../packages/python-sdk/tests/conftest.py) 为同步/异步 Sandbox 提供 fixture，并在失败时打印 Sandbox ID 便于诊断。

### 8.4 本地 envd debug 测试

`E2B_DEBUG` 使 SDK 使用本地 envd/控制面地址，跳过某些真实控制面动作。它适合 envd 协议联调，但不能覆盖真实调度、域名和云生命周期。

## 9. 常用命令及成本

```bash
# 全仓格式化（会改文件）
pnpm run format

# 全仓静态检查
pnpm run lint
pnpm run typecheck

# 全仓测试；可能安装浏览器、访问云资源
pnpm run test

# 单独的 JS SDK 测试文件
pnpm --dir packages/js-sdk exec vitest run tests/connectionConfig.test.ts

# 单独的 CLI 测试文件
pnpm --dir packages/cli exec vitest run tests/utils/errors.test.ts

# 单独的 Python 测试
cd packages/python-sdk
uv run pytest tests/<具体文件>.py -q
```

JS SDK 的 `pretest` 会执行 `npx playwright install --with-deps chromium`，因此根级完整测试可能耗时并修改系统浏览器缓存。开发循环中先跑受影响的测试文件，交付前再按仓库规则跑完整检查。

## 10. 一次改动的文件定位示例

假设要给“创建 Sandbox”新增 `region` 参数：

1. 查看 `spec/openapi.yml` 的 `NewSandbox` 是否已有字段；
2. 若没有，修改 spec 并 `make codegen`；
3. JS：`SandboxOpts` 加字段，`createSandbox` 映射请求体；
4. Python 共享类型与 sync/async `create()` 加字段，并映射到底层模型；
5. CLI 若要暴露选项，再改 `commands/sandbox/create.ts`；
6. JS、Python sync、Python async 分别加测试；
7. 运行 format/lint/typecheck/test；
8. 三个发布包受影响时创建合适的 changeset。

这个思路比“全仓搜索 create 然后逐个改”更可靠，因为它先确认了协议事实来源和公开 API 边界。

## 11. 本模块练习

无需改代码，完成以下定位：

1. 找到 `Sandbox` 的公开导出、JS 实现、Python sync 实现和 Python async 实现；
2. 找到 `POST /sandboxes` 的 OpenAPI 定义及生成类型；
3. 找到 `Process.Start` 的 Protobuf 定义及 JS 生成客户端；
4. 找到 CLI `e2b sandbox exec` 的 Commander 定义；
5. 判断 `schema.gen.ts` 和 `sandboxApi.ts` 哪个应手动维护。

下一步阅读[模块 3：Sandbox 生命周期与创建调用链](03-sandbox-lifecycle.md)。
