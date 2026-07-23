# 模块 10：测试、代码生成与贡献实战

本模块把前面的架构知识转化为实际贡献流程：怎样选择测试层、怎样改协议、怎样验证跨语言一致性，以及提交发布包前还要做什么。

## 1. 先判断改动属于哪一层

开始写代码前回答：

| 问题                                | 若答案为是                        |
| ----------------------------------- | --------------------------------- |
| 服务端请求/响应需要新字段或端点？   | 修改 `spec/` + codegen + 高层适配 |
| 只是公开 API 命名、校验或便利方法？ | 修改手写 SDK 层，通常不改 spec    |
| JS SDK 的用户可观察能力变化？       | 审计 Python sync/async 等价实现   |
| 只是 CLI 参数/显示变化？            | 改 CLI；底层能力已有则无需改 SDK  |
| 发布包行为或 API 变化？             | 创建 changeset                    |

先分类能避免手改生成文件、重复实现后端已有逻辑，或只改一个语言。

## 2. 测试金字塔在本仓库的落地

### 2.1 纯函数单元测试

适合：

- 参数校验；
- URL/命令构造；
- Git status 解析；
- Dockerfile 解析；
- 错误码映射；
- Paginator token；
- CLI helper。

特点：无凭据、快速、失败易定位。应覆盖边界表，而不只 happy path。

### 2.2 Mock HTTP 测试

适合验证：

- HTTP method/path/query/body/Header；
- 空 body、404、401、429、500；
- API 模型到 SDK 类型的映射；
- proxy/config 传播。

JS 使用 MSW。参考 [`tests/volume/volume.test.ts`](../../../packages/js-sdk/tests/volume/volume.test.ts)：handler 是内存后端，测试既能验证 CRUD，又不会产生真实 Volume。

### 2.3 协议/流测试

命令 UTF-8 分块、disconnect 回调、stream cleanup 可用构造的 AsyncIterable/ReadableStream 测试，无需云资源。此层要有意制造：

- Unicode 字符跨 chunk；
- 流结束前异常；
- 没有 end event；
- cancel 与 end 竞争；
- 空 body；
- idle timeout。

### 2.4 真实 Sandbox 集成测试

适合验证 Linux、Git、PTY、权限、实际 envd 版本和端到端网络。使用现有 fixture，禁止测试自己创建后忘记清理。

JS：

```ts
sandboxTest('example', async ({ sandbox }) => {
  const result = await sandbox.commands.run('echo hello')
  expect(result.stdout).toBe('hello\n')
})
```

fixture 在 finally kill，失败时打印 ID。

Python：

```python
def test_example(sandbox):
    result = sandbox.commands.run("echo hello")
    assert result.stdout == "hello\n"


async def test_async_example(async_sandbox):
    result = await async_sandbox.commands.run("echo hello")
    assert result.stdout == "hello\n"
```

## 3. 测试资源清理

云测试最重要的不变量：无论测试成功、断言失败、超时或部分创建，都尽量回收资源。

JS fixture 模式：

```ts
const sandbox = await Sandbox.create(...)
try {
  await use(sandbox)
} finally {
  await sandbox.kill()
}
```

Python async 批量清理：

```python
results = await asyncio.gather(
    *(sandbox.kill() for sandbox in sandboxes),
    return_exceptions=True,
)
```

创建本身失败时对象可能尚未返回。涉及多步骤创建的测试可以给 metadata 加唯一 test ID，失败后通过列表过滤补偿清理。

Volume、Snapshot、Template 是持久资源，不能只 kill Sandbox。创建它们的测试必须有各自 destroy/delete 策略和唯一名称。

## 4. 测试命令

全仓：

```bash
pnpm run test
```

该命令递归调用所有 workspace 的 `test`。JS SDK `pretest` 会安装 Playwright Chromium，完整测试可能访问真实云服务。

针对性 JS：

```bash
pnpm --dir packages/js-sdk exec vitest run tests/paginator.test.ts
pnpm --dir packages/js-sdk exec vitest run tests/sandbox/commands/commandHandle.test.ts
```

针对性 CLI：

```bash
pnpm --dir packages/cli exec vitest run tests/utils/errors.test.ts
```

针对性 Python：

```bash
cd packages/python-sdk
uv run pytest tests/<file>.py -q
```

真实 Volume 测试需要：

```bash
ENABLE_VOLUME_TESTS=1 <test command>
```

集成测试开关以包脚本和 fixture 当前实现为准，运行前确认 `E2B_API_KEY` 与目标 domain，避免误用生产团队额度。

## 5. 静态检查

仓库规则要求提交前：

```bash
pnpm run format
pnpm run lint
pnpm run typecheck
```

分别会递归调用：

- JS/CLI：Prettier、oxlint、TypeScript；
- Python：ruff format/check、ty；
- spec：Prettier YAML。

`format` 会改文件；应在执行后重新审查 `git diff`，防止无关大范围格式变化。然后再次运行 lint/typecheck，不能只信编辑器提示。

## 6. OpenAPI codegen

控制面协议：[`spec/openapi.yml`](../../../spec/openapi.yml)。Volume 内容协议：[`spec/openapi-volumecontent.yml`](../../../spec/openapi-volumecontent.yml)。

根命令：

```bash
make codegen
```

[`Makefile`](../../../Makefile) 会：

1. 构建 `codegen.Dockerfile` 镜像；
2. 把仓库挂载到 `/workspace`；
3. 执行 `make generate`；
4. JS 与 Python 都重新生成。

JS `generate:api` 先运行 `remove_extra_tags.py` 产生筛选 spec，再用 `openapi-typescript` 写 `schema.gen.ts`。Python 用定制 `openapi-python-client` 写 client/model/endpoint 文件。

改 spec 后不要只运行某一个语言的生成器并提交；仓库要求 JS/Python 生成结果同步。

## 7. Protobuf/Connect codegen

envd 协议：

- [`process.proto`](../../../spec/envd/process/process.proto)；
- [`filesystem.proto`](../../../spec/envd/filesystem/filesystem.proto)。

Buf 配置分别指定 JS 与 Python 插件。`codegen.Dockerfile` 安装固定版本的 buf、protoc、Connect ES 和仓库内 `connect-python` 插件。

增加 RPC 或字段时：

1. 遵守 Protobuf field number 向后兼容，不复用已删除编号；
2. 新字段尽量可选/有安全默认值；
3. 重新生成 JS/Python；
4. 在高层 SDK 做 envd 版本门槛；
5. 老 envd 的降级路径要测试；
6. sync/async 两套 Python client 调用都更新。

协议兼容不是“代码能编译”就完成。新 SDK 连接旧 Template 是正常场景，必须决定 fallback、警告还是拒绝。

## 8. MCP JSON Schema codegen

[`spec/mcp-server.json`](../../../spec/mcp-server.json) 生成：

- JS `sandbox/mcp.d.ts`；
- Python `sandbox/mcp.py` TypedDict。

JS 使用 `json-schema-to-typescript` 工具，Python 使用 `datamodel-code-generator`。修改 Schema 后同样通过根 codegen 保持一致。

## 9. 怎样审查生成 diff

生成后先看：

```bash
git status --short
git diff --stat
git diff -- spec packages/js-sdk/src/api packages/python-sdk/e2b/api
```

检查：

- 是否只出现预期端点/模型字段；
- 是否因为工具版本变化导致全文件重排；
- nullable/optional 是否符合意图；
- 枚举是否改变公共兼容性；
- query array 序列化是否正确；
- Python sync/async endpoint 是否都生成；
- 高层适配是否还在引用旧字段。

若生成 diff 异常大，先确认使用根 Docker codegen，而不是本机不同版本工具。

## 10. 跨语言行为测试矩阵

为一个新 SDK 能力至少列矩阵：

| 场景                     | JS  | Python sync | Python async |
| ------------------------ | --- | ----------- | ------------ |
| 默认参数                 | ✓   | ✓           | ✓            |
| 显式参数                 | ✓   | ✓           | ✓            |
| 成功返回映射             | ✓   | ✓           | ✓            |
| 400/404/429              | ✓   | ✓           | ✓            |
| request timeout/cancel   | ✓   | ✓           | ✓            |
| 老 envd                  | ✓   | ✓           | ✓            |
| stream cleanup（若适用） | ✓   | ✓           | ✓            |

不一定每个格子都要三份昂贵集成测试；纯逻辑可单测，端到端可少量代表，但设计时必须确认三边语义。

## 11. Changeset

修改以下发布包时，根目录运行：

```bash
pnpm changeset
```

适用包：

- `packages/cli`；
- `packages/js-sdk`；
- `packages/python-sdk`。

选择版本级别：

- patch：bug fix，不破坏兼容；
- minor：向后兼容的新功能；
- major：破坏性变更。

changeset 内容应面向用户描述行为，不是内部实现清单。例如“Add stdin EOF support to background commands”优于“Modify process.proto and command.ts”。

纯教程文档、不改变发布包通常不需要 changeset。

## 12. PR 与提交前检查表

仓库规则还要求：

- 用户可见变化在 PR 描述中给 usage example；
- PR 描述随实现变化保持更新；
- SDK 等价修改覆盖 JS/Python sync/Python async；
- spec 变化执行 `make codegen`；
- 受影响路径有测试；
- format/lint/typecheck/test 已运行；
- 发布包变化有 changeset。

建议最终检查：

```bash
git diff --check
git status --short
git diff --stat
```

`git diff --check` 可发现尾随空格和冲突标记。还应人工确认没有 `.env.local`、Token、测试下载产物或临时归档进入 diff。

## 13. CI 工作流地图

`.github/workflows` 包含：

- `lint.yml`、`typecheck.yml`：静态检查；
- `js_sdk_tests.yml`、`python_sdk_tests.yml`、`cli_tests.yml`：包测试；
- `sdk_tests.yml`：生产/预发布环境组合；
- `generated_files.yml`：生成文件是否与 spec 一致；
- `pkg_artifacts.yml`：打包产物；
- `release*.yml`、`publish*.yml`：发布。

本地测试通过但 CI generated-files 失败，通常意味着改了 spec 未 codegen，或生成工具版本不一致。生产通过、staging 失败则优先检查 domain、部署版本和 envd 兼容，而不是盲目修改断言。

## 14. 一个完整贡献示例

需求：为命令列表添加新字段 `started_at`。

```text
1. 修改 process.proto 的 ProcessInfo，使用新 field number
2. make codegen
3. JS ProcessInfo 加 startedAt: Date，并映射 timestamp
4. Python 共享 ProcessInfo 加 started_at
5. Python sync/async list() 映射
6. 确认老 envd 未返回时字段是 optional 或有兼容默认
7. JS + Python sync + async 测试
8. pnpm run format/lint/typecheck/test
9. pnpm changeset（JS/Python SDK minor 或 patch，依产品语义）
10. PR 描述加入三种语言使用例
```

这一流程的关键不是命令本身，而是始终从协议、兼容层、公开层、测试层到发布层闭环。

## 15. 本模块练习

1. 找一个 OpenAPI 字段，从 spec 追到 JS 生成类型、Python生成模型和高层映射。
2. 找一个 Protobuf RPC，从 proto 追到 JS、Python sync、Python async 调用。
3. 为一个纯 helper 设计无需凭据的单测，并解释为什么不该用真实 Sandbox。
4. 审查 `generated_files.yml`，说明 CI 怎样发现生成结果陈旧。
5. 给一个假想用户功能写 changeset 文案和 PR usage example。

最后进入[模块 11：循序渐进的源码实验](11-labs.md)，把整套知识连起来。
