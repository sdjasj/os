# 03. 后端启动：FastAPI、lifespan、配置解析与依赖注入

OpenHands App Server 的可替换性主要来自配置和 Injector，而不是在每个路由里写大量 `if OSS else SaaS`。本章从 import `app` 开始，追踪一个请求如何得到用户、数据库、Sandbox 和事件服务。

## `app.py` 在 import 时做了什么

核心顺序如下：

```python
init_tavily_proxy()
mcp_app = mcp_server.http_app(path='/mcp', stateless_http=True)

lifespans = [mcp_app.lifespan]
app_lifespan_ = get_app_lifespan_service()
if app_lifespan_:
    lifespans.append(app_lifespan_.lifespan)

app = FastAPI(
    lifespan=combine_lifespans(*lifespans),
    routes=[Mount(path='/mcp', app=mcp_app)],
)
app.include_router(v1_router.router)
```

这里有四件事：

1. 初始化 MCP proxy；
2. 合并 MCP 与应用自己的 lifespan；
3. 创建 FastAPI app 并挂载 `/mcp`；
4. 注册 V1 和 health routes，再增加中间件与可选静态前端。

这是 import-time composition。测试如果导入该模块，就会触发配置初始化，因此项目常把复杂依赖推迟到函数或 Injector 内，以减少副作用。

## lifespan 是什么

ASGI lifespan 描述“应用开始接收请求前”和“停止后”的资源管理：

```text
process start
  -> lifespan enter
  -> accept requests
  -> lifespan exit
process stop
```

`combine_lifespans` 使用 `AsyncExitStack` 依次进入多个 async context，并保证逆序退出：

```python
@contextlib.asynccontextmanager
async def combined_lifespan(app):
    async with contextlib.AsyncExitStack() as stack:
        for lifespan in lifespans:
            await stack.enter_async_context(lifespan(app))
        yield
```

OSS 的 `OssAppLifespanService` 默认在进入时执行 Alembic `upgrade head`。SaaS lifespan 则初始化 PostHog，并在退出时 flush 分析事件、关闭长期数据库资源。

背景知识：lifespan 比旧式 `@app.on_event("startup")` 更适合组合资源，因为 context manager 能把初始化和释放绑定在一起。

## `AppServerConfig` 不只是普通配置值

它同时保存：

- 值配置：`persistence_dir`、`web_url`、CORS origins；
- service injector：event、sandbox、user、jwt、db session 等；
- 生命周期和 app mode；
- web client 配置 injector。

简化结构：

```python
class AppServerConfig(OpenHandsModel):
    persistence_dir: Path
    event: EventServiceInjector | None = None
    sandbox: SandboxServiceInjector | None = None
    app_conversation: AppConversationServiceInjector | None = None
    user: UserContextInjector | None = None
    jwt: JwtServiceInjector | None = None
    lifespan: AppLifespanService | None
```

把“使用哪种实现”也放入配置，等价于轻量 dependency injection container。

## 环境变量如何变成实现选择

`config_from_env()` 先调用 SDK 的 `from_env(AppServerConfig, 'OH')`，允许用 `OH_*` 注入字段；未指定的服务再按默认规则补齐。

Sandbox 是最清楚的例子：

```python
if os.getenv('RUNTIME') == 'remote':
    config.sandbox = RemoteSandboxServiceInjector(...)
elif os.getenv('RUNTIME') in ('local', 'process'):
    config.sandbox = ProcessSandboxServiceInjector()
else:
    config.sandbox = DockerSandboxServiceInjector(...)
```

事件存储则根据 `StorageProvider` 选择 AWS、GCP 或 filesystem。上层路由只依赖 `SandboxService`/`EventService` 抽象，不需要知道实现。

## Injector 协议

基础类只有三个关键方法：

```python
class Injector(Generic[T], ABC):
    async def inject(self, state, request=None) -> AsyncGenerator[T, None]: ...

    @contextlib.asynccontextmanager
    async def context(self, state, request=None): ...

    async def depends(self, request): ...
```

它同时服务两个场景：

- `Depends(injector.depends)`：FastAPI 请求生命周期；
- `async with injector.context(state)`：后台任务或流式响应自行管理生命周期。

为什么返回 async generator 而不是直接返回对象？因为数据库 session、HTTP client 等需要在 `yield` 后释放。

## `request.state` 是一次请求的作用域缓存

多个 Injector 会嵌套。例如 AppConversation service 需要 UserContext、SandboxService、HTTP client、DB session。如果每个嵌套都新建一次资源，会产生重复 session 或丢失身份上下文。

Injector 接收同一个 `request.state`，可以把已经解析的对象缓存其中。`AuthUserContextInjector` 的逻辑是：

```python
user_context = getattr(state, USER_CONTEXT_ATTR, None)
if user_context is None:
    user_auth = await get_user_auth(request)
    user_context = AuthUserContext(user_auth=user_auth)
    setattr(state, USER_CONTEXT_ATTR, user_context)
yield user_context
```

这是一种显式 request scope。

## 路由怎样声明依赖

`config.py` 提供工厂：

```python
def depends_sandbox_service():
    injector = get_global_config().sandbox
    assert injector is not None
    return Depends(injector.depends)
```

路由模块在顶层创建 dependency：

```python
sandbox_service_dependency = depends_sandbox_service()

async def send_message_to_conversation(
    sandbox_service: SandboxService = sandbox_service_dependency,
): ...
```

测试可替换全局 config 中的 Injector，或直接调用路由函数并传入 mock service。后者通常更快、更聚焦。

## 为什么流式创建要重建依赖上下文

普通 FastAPI dependency 在 endpoint 返回后就会关闭。但 `StreamingResponse` 返回时，body 可能还没有迭代完。`_stream_app_conversation_start` 因而创建新的 `InjectorState`，保存既有 UserContext，并显式：

```python
async with get_app_conversation_service(state) as service:
    async for task in service.start_app_conversation(request):
        yield task.model_dump_json()
```

这解决了一个通用异步问题：响应对象的创建生命周期，不等于响应 body 的消费生命周期。

普通 `POST` 也有类似处理。它从 async generator 取第一个 task 立即返回，再用 `asyncio.create_task` 消耗其余阶段；同时把 DB 和 HTTP client 标为 keep-open，最后在后台 consumer 中关闭。

## 全局配置的优点与风险

`get_global_config()` 懒加载单例：

```python
if _global_config is None:
    _global_config = config_from_env()
return _global_config
```

优点：

- 所有路由使用一致实现；
- 避免重复解析环境；
- 注入图集中可见。

风险：

- 测试之间可能泄漏被修改的全局状态；
- import 顺序会影响环境变量读取；
- 运行时改变 env 不一定生效；
- service 若错误地存用户状态会跨请求污染。

所以 request-scoped 对象应存在 `request.state` 或 Injector yield 中，不应塞进 global config。

## 配置兼容层怎么读

项目仍支持一些旧变量，例如：

```python
return os.getenv('OPENHANDS_PROVIDER_BASE_URL') or os.getenv('LLM_BASE_URL')
```

以及 `OH_PERSISTENCE_DIR` 对旧 `FILE_STORE_PATH` 的 fallback。阅读时区分：

- 首选新配置；
- legacy fallback；
- 根据部署环境选择实现；
- 用户级设置（不能和进程 env 混为一谈）。

兼容逻辑应尽量停留在配置边界，而不是扩散到业务代码。

## 中间件顺序

FastAPI/Starlette 的中间件是包裹结构，添加顺序会影响请求和响应经过的次序。OSS 添加：

- `LocalhostCORSMiddleware`；
- `CacheControlMiddleware`；
- `RateLimitMiddleware`。

Enterprise 还会添加 cookie auth 与 API-key aware CORS。调试 401、CORS 或静态文件遮蔽时，必须同时检查：

1. route 是否注册；
2. mount 是否先匹配；
3. middleware 是否提前返回；
4. dependency 是否抛异常。

## 本章实验：手画依赖图

以 `send_message_to_conversation` 为起点，画出：

```text
FastAPI endpoint
├── AppConversationService
│   └── UserContext / DB / Sandbox ...
├── SandboxService
└── httpx.AsyncClient
```

然后查看各 Injector 的 `inject()`：哪些对象是请求共享的？哪些需要 `finally`/context 关闭？如果把 StreamingResponse 改为普通 list 返回，依赖生命周期会发生什么变化？

## 常见误区

- 把 `AppServerConfig` 只当环境变量模型，忽略它还选择 service 实现。
- 在后台 task 中继续使用已经被 FastAPI dependency 关闭的 DB session。
- 把用户身份缓存进全局 singleton。
- 在业务函数里不断读取 env，绕过集中配置。
- 调试 404 时只看 router，不看更早挂载的 `/` 静态应用。

## 自测

1. `Injector.context` 与 `Injector.depends` 分别用于什么场景？
2. 为什么流式响应需要自己的依赖上下文？
3. `request.state` 在注入系统里解决什么问题？
4. RUNTIME 未设置时默认使用哪个 Sandbox 实现？
5. 为什么 Enterprise 必须在导入 base app 前设置部分环境变量？

## 源码定位

- [FastAPI 应用组装](https://github.com/OpenHands/OpenHands/blob/6b04532541bf2b757d4820d31387b6cba6ffcaea/openhands/app_server/app.py)
- [服务配置与默认实现](https://github.com/OpenHands/OpenHands/blob/6b04532541bf2b757d4820d31387b6cba6ffcaea/openhands/app_server/config.py)
- [Injector 基类](https://github.com/OpenHands/OpenHands/blob/6b04532541bf2b757d4820d31387b6cba6ffcaea/openhands/app_server/services/injector.py)
- [OSS lifespan](https://github.com/OpenHands/OpenHands/blob/6b04532541bf2b757d4820d31387b6cba6ffcaea/openhands/app_server/app_lifespan/oss_app_lifespan_service.py)
- [SaaS lifespan](https://github.com/OpenHands/OpenHands/blob/6b04532541bf2b757d4820d31387b6cba6ffcaea/enterprise/server/app_lifespan/saas_app_lifespan_service.py)

下一章沿创建、发送消息、暂停和归档读完整个会话生命周期。
