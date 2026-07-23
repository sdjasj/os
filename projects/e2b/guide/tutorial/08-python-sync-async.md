# 模块 8：Python 同步/异步双实现

Python SDK 的难点不在语法，而在保证同步、异步以及 JS 三种表面 API 的行为一致。本模块解释代码组织、I/O 模型、上下文管理器和等价修改方法。

## 1. 为什么同时提供 sync 和 async

同步 API 适合脚本、数据任务和传统同步服务：

```python
from e2b import Sandbox

with Sandbox.create() as sandbox:
    result = sandbox.commands.run("echo hello")
```

异步 API 适合 FastAPI、async worker 或需要并发管理大量 Sandbox 的服务：

```python
from e2b import AsyncSandbox

async with await AsyncSandbox.create() as sandbox:
    result = await sandbox.commands.run("echo hello")
```

如果异步服务调用同步 SDK，网络等待会阻塞 event loop；如果简单脚本强行使用 async，又会增加调度与资源管理复杂度。因此两套 API 都有价值。

## 2. 目录分层

共享定义：

```text
e2b/sandbox/
├── main.py               # SandboxBase、URL、签名等共享逻辑
├── sandbox_api.py        # TypedDict/dataclass、network/lifecycle 类型
├── commands/main.py      # ProcessInfo 等共享类型
├── commands/command_handle.py # CommandResult/异常数据结构
└── filesystem/filesystem.py   # EntryInfo/FileType 等共享类型
```

同步 I/O：

```text
e2b/sandbox_sync/
├── main.py
├── sandbox_api.py
├── commands/
├── filesystem/
└── git.py
```

异步 I/O：

```text
e2b/sandbox_async/
├── main.py
├── sandbox_api.py
├── commands/
├── filesystem/
└── git.py
```

Template 与 Volume 也按 sync/async 分开。不要看到 `e2b/sandbox/main.py` 就误以为所有 Sandbox 行为在共享基类中；它主要保存纯计算和共同状态。

## 3. `SandboxBase` 应放什么

[`SandboxBase`](../../../packages/python-sdk/e2b/sandbox/main.py) 包含不需要 await 的逻辑：

- 保存连接配置、ID、域名、envd 版本/Token；
- 计算 envd URL；
- 生成 upload/download URL；
- 生成公开端口 host；
- MCP URL。

文件签名计算是本地 CPU 操作，也可共享。相反，读取 MCP token 需要文件 I/O，所以 sync/async 高层类各自实现。

判断逻辑是否可共享的方法：它是否依赖具体 HTTP client、Connect client、生成器迭代、await 或资源关闭语义？若是，通常需要双实现。

## 4. 创建的等价调用链

同步：

```text
Sandbox.create
  → SandboxApi._create
  → 同步 OpenAPI client
  → Sandbox(...)
  → httpx.Client / sync Connect clients
```

异步：

```text
await AsyncSandbox.create
  → await SandboxApi._create
  → 异步 OpenAPI client
  → AsyncSandbox(...)
  → httpx.AsyncClient / async Connect clients
```

两边应对齐：默认 template、timeout、metadata、network、lifecycle、volume mounts、MCP 启动、错误类型和响应字段。

## 5. Python 的时间单位

Python 公共 API 以秒为主：

```python
Sandbox.create(timeout=300)
sandbox.commands.run("job", timeout=60, request_timeout=10)
sandbox.files.watch_dir(path, callback, timeout=0)
```

JS 对应多数为毫秒。Python 的默认 Sandbox timeout 是 300 秒，命令连接默认 60 秒。

协议层可能也使用秒，但实现仍应明确转换/归一化，不要因为“这次数值正好一致”省略单位文档。

## 6. 上下文管理器

同步：

```python
def __enter__(self):
    return self

def __exit__(self, exc_type, exc_value, traceback):
    self.kill()
```

异步：

```python
async def __aenter__(self):
    return self

async def __aexit__(self, exc_type, exc_value, traceback):
    await self.kill()
```

所以创建语法略特别：

```python
async with await AsyncSandbox.create() as sandbox:
    ...
```

`create()` 本身是 awaitable，返回的对象才实现 async context manager。

上下文退出默认 kill，即使 body 抛异常也会清理。这是 Python 路线优于裸对象的推荐用法。

## 7. 同一个名字同时支持实例与类调用

Python `Sandbox` 的 `connect`、`kill`、`set_timeout`、`get_info` 等既能：

```python
sandbox.kill()
Sandbox.kill(sandbox_id)
```

代码通过 [`class_method_variant`](../../../packages/python-sdk/e2b/sandbox/utils.py) 实现这种双形态，并用 overload 向类型检查器描述。

实例方法会把 `self.connection_config.get_api_params()` 合入调用，确保创建时的 domain、proxy、API Key 等继续生效；类调用则完全依赖当前参数/环境。

修改这些方法时必须检查两种调用形式，而不是只测试 `sandbox.method()`。

## 8. HTTP 客户端生命周期

同步 `Sandbox` 的 Filesystem/Commands 持有 `httpx.Client` 与同步 Connect client；异步 `AsyncSandbox` 创建共享 transport 和 `httpx.AsyncClient`，传给各子模块。

共享异步 transport 能复用连接池，但也意味着关闭顺序很重要：

- 流仍在消费时不能提前关闭 client；
- Sandbox kill 是远端生命周期操作，不一定等同于关闭本地所有 client；
- 异步取消需要 `finally`/`async with` 确保响应关闭。

阅读文件 stream 实现时，重点找 `r.close()/aclose()`、context manager 和异常分支，而不只是正常 return。

## 9. 命令句柄的同步与异步

同步 [`CommandHandle`](../../../packages/python-sdk/e2b/sandbox_sync/commands/command_handle.py)：

- 底层事件是 `Generator`；
- `__iter__` 返回事件消费生成器；
- `wait()` 普通循环；
- 回调是同步 callable；
- `disconnect()` 关闭 generator。

异步 [`AsyncCommandHandle`](../../../packages/python-sdk/e2b/sandbox_async/commands/command_handle.py)：

- 底层事件是 async stream；
- 消费用 `async for`；
- `wait()` 是 coroutine；
- 输出处理支持 awaitable；
- disconnect/kill/send_stdin 需要 await。

二者都必须：增量 UTF-8 解码、累积 stdout/stderr、收到 end 保存结果、非零退出抛 `CommandExitException`、传输错误映射并做健康检查。

## 10. 回调语义

同步：

```python
result = sandbox.commands.run(
    "echo hello",
    on_stdout=lambda chunk: print(chunk, end=""),
)
```

异步可以提供适合异步消费的 handler（以当前类型定义为准）：

```python
async def on_stdout(chunk: str) -> None:
    await queue.put(chunk)

result = await sandbox.commands.run(
    "echo hello",
    on_stdout=on_stdout,
)
```

回调处理过慢会对事件消费形成背压。同步 handler 阻塞线程，异步 handler await 外部资源。若要高吞吐日志，可让回调快速写入有界队列，由独立 worker 批处理；有界队列还能避免远端输出无限占内存。

## 11. 文件流差异

同步读取流通常暴露 `httpx` 同步字节迭代/包装对象，异步读取用 async iterator。两个实现都要处理：

- 初始 request timeout；
- 流 idle timeout；
- 用户取消；
- 404 时关闭未消费 response；
- 中途 Sandbox 结束时健康检查；
- 空文件的正确类型。

行为测试应覆盖同样的场景，而不是只验证两边都有名为 `read()` 的方法。

## 12. Template 的共享与双实现

[`e2b/template/main.py`](../../../packages/python-sdk/e2b/template/main.py) 的 Builder 主要是纯数据变换，可共享：添加 instruction、解析 Dockerfile、计算本地上下文、序列化。

网络 I/O 分开：

- [`template_sync/main.py`](../../../packages/python-sdk/e2b/template_sync/main.py)：同步请求、上传、轮询；
- [`template_async/main.py`](../../../packages/python-sdk/e2b/template_async/main.py)：异步请求、上传、sleep 和日志轮询。

`AsyncTemplate` 仍可复用同一个同步 Builder 对象，因为“定义模板”不需要 I/O；只有 build 是异步。

## 13. Volume 的双实现

[`volume_sync.py`](../../../packages/python-sdk/e2b/volume/volume_sync.py) 与 [`volume_async.py`](../../../packages/python-sdk/e2b/volume/volume_async.py) 结构近似，包括：

- create/connect/get_info/list/destroy；
- list/make_dir/exists/get_info/update_metadata；
- read_file/write_file/remove；
- text/bytes/stream 格式；
- request/idle timeout；
- Volume token 与 proxy。

这类近似文件容易出现“只修 sync，async 仍泄漏 response”的问题。代码审查应逐方法对照 diff，而不只是依赖命名搜索。

## 14. 类型工具

Python SDK 使用：

- `TypedDict` 表示字典配置，如 network/lifecycle；
- `dataclass` 表示结果，如 `CommandResult`；
- `Literal`/`Union` 表示 discriminated union；
- `overload` 表示 format 或实例/类调用带来的返回类型；
- `Unpack[ApiParams]` 传播连接参数；
- `Self` 保留子类类型。

例如生命周期把 pause 与 kill 对象分成不同 TypedDict，让 `keep_memory` 只出现在 pause：

```python
SandboxOnTimeout = Union[
    Literal["pause", "kill"],
    SandboxOnTimeoutPause,
    SandboxOnTimeoutKill,
]
```

与 TypeScript 一样，静态类型后仍需要运行时校验未类型化调用。

## 15. 一次跨语言等价修改的检查表

假设给文件读取新增 `verify_checksum`：

1. 先确认服务端协议是否需要字段；
2. JS `FilesystemReadOpts` 加 `verifyChecksum`；
3. JS text/bytes/blob/stream 路径都传递字段；
4. Python 共享公开类型/文档加 `verify_checksum`；
5. Python sync 各 overload 与实现传递；
6. Python async 各 overload 与实现传递；
7. 错误映射、版本门槛和默认值三边一致；
8. JS、Python sync、Python async 分别测试正常、失败、stream；
9. 更新公开导出与文档；
10. 三个 SDK 包受影响时生成 changeset。

若只是 JS 语言特有类型便利，不一定需要 Python 同名结构；但用户可观察的能力与行为必须对等。

## 16. 如何用 diff 对照 sync/async

推荐逐个符号比较，而不是把两个大文件肉眼从头扫到尾：

```bash
rg -n "def read_file|async def read_file" \
  packages/python-sdk/e2b/volume/volume_sync.py \
  packages/python-sdk/e2b/volume/volume_async.py
```

然后对照这几类差异：

| 应有差异                             | 不应有差异        |
| ------------------------------------ | ----------------- |
| `def` / `async def`                  | 参数默认值        |
| `with` / `async with`                | 错误类型          |
| iterator / async iterator            | 返回数据字段      |
| client / async client                | 版本门槛          |
| `time.sleep` / `await asyncio.sleep` | 鉴权和 proxy 传播 |

## 17. 测试组织

[`tests/conftest.py`](../../../packages/python-sdk/tests/conftest.py) 提供：

- `sandbox_factory`：创建同步 Sandbox 并 finalizer kill；
- `async_sandbox_factory`：追踪多个异步 Sandbox，teardown 时 `asyncio.gather` 并清理；
- build/async_build；
- Volume 条件 fixture；
- 失败时打印资源 ID。

异步 teardown 用 `return_exceptions=True`，保证一个 kill 失败不会阻止清理其余 Sandbox。这是批量资源清理值得采用的模式。

## 18. 常见不一致陷阱

- JS 新增选项，Python 没有；
- Python sync 修复 response close，async 未修；
- JS 毫秒默认值原样复制到 Python，导致放大 1000 倍；
- sync 的 404 返回 false，async 却抛异常；
- async 回调忘记 await；
- 实例方法传播 proxy/API Key，类方法测试没覆盖；
- `__aexit__` 清理失败覆盖了 body 的原始异常；
- 公共类型加入实现，但 `e2b/__init__.py` 未导出。

## 19. 本模块练习

1. 用 `asyncio.gather` 并发创建三个 Sandbox，逐个执行命令并在 finally 并发 kill。
2. 比较 sync/async `Commands.run` 的所有参数、默认值和错误。
3. 选择 `Volume.read_file` 的 stream 分支，列出所有 response close 路径。
4. 找到一个实例/类双形态方法，分别写测试调用两种形式。
5. 选择一个最近的 JS 文件功能，审计 Python sync/async 是否行为等价。

下一步阅读[模块 9：CLI 的设计与执行链](09-cli.md)。
