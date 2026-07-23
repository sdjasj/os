# 模块 2：控制面——CubeAPI 与 CubeMaster

## 1. 学习目标

本章沿 `POST /sandboxes` 向下阅读，重点掌握：

- CubeAPI 的路由、中间件、handler、service、backend client 分层；
- E2B 模型怎样翻译成 CubeMaster 内部模型；
- CubeMaster 怎样解析模板、调度节点、调用 Cubelet并处理重试；
- 创建成功后为什么还要写 Redis、持久化 spec 和发布事件；
- 怎样用 request ID 和错误码定位控制面问题。

## 2. CubeAPI 的启动和分层

入口是 [`CubeAPI/src/main.rs`](../../CubeAPI/src/main.rs)。启动顺序可以概括为：

1. Clap 解析 CLI；
2. 从环境读取 `ServerConfig`；
3. CLI 覆盖环境/默认配置；
4. 初始化 tracing 和结构化日志；
5. 建立 Tokio 多线程 runtime；
6. 创建 `AppState`；
7. 构建 Axum Router；
8. 监听 HTTP 并注册 graceful shutdown。

配置优先级是 CLI > 环境变量 > 默认值。分析“明明设置了环境变量但没生效”时，先确认 systemd/启动脚本有没有同时传 CLI 参数。

CubeAPI 的主要代码层次：

```text
routes.rs
   │ 选择 handler + 中间件
handlers/sandboxes.rs
   │ HTTP 提取/响应
services/sandboxes.rs
   │ 业务校验与模型转换
cubemaster/mod.rs
   │ reqwest HTTP client
CubeMaster REST API
```

### 2.1 路由与横切层

[`CubeAPI/src/routes.rs`](../../CubeAPI/src/routes.rs) 中的 `build_router` 把普通路由和长耗时路由分开：

- 普通路由 timeout：30 秒；
- 创建快照、回滚、删除模板等同步长操作：240 秒；
- 所有路由统一添加 request ID、trace、压缩、CORS；
- 鉴权开启时，Sandbox 路由再叠加按 API key 的限流。

路由注册本身就是最可靠的 API 清单。例如当前代码实际注册了：

```rust
.route("/sandboxes", post(sandboxes::create_sandbox))
.route("/sandboxes/:sandboxID/pause", post(sandboxes::pause_sandbox))
.route("/sandboxes/:sandboxID/connect", post(sandboxes::connect_sandbox))
```

组件 README 中的“待实现”清单可能落后于当前路由，核实能力时要继续检查 service 和 CubeMaster 对应 handler，而不能只看 README 表格。

### 2.2 AppState 的意义

Axum handler 通过 `State(state): State<AppState>` 获得共享依赖。通常包含：

- 解析后的配置；
- `SandboxService`、Template/Snapshot/Volume service；
- 可复用的 `reqwest::Client` 连接池；
- 日志器；
- 限流器等进程内状态。

把 HTTP client 放入共享 state 很重要：每请求新建 client 会失去连接池，增加握手和端口压力。

## 3. 鉴权与限流

CubeAPI 支持两种鉴权来源：

- `AUTH_CALLBACK_URL`：把凭据与请求信息转发给外部鉴权服务；
- `CUBE_API_KEY`：与本地配置的简单 key 比较。

Callback 模式优先。健康检查 `/health` 不走业务鉴权。中间件位于 [`CubeAPI/src/middleware/auth.rs`](../../CubeAPI/src/middleware/auth.rs)，限流位于 [`rate_limit.rs`](../../CubeAPI/src/middleware/rate_limit.rs)。

安全阅读要点：

- `Authorization: Bearer` 与 `X-API-Key` 都可能是凭据来源；
- 日志不应打印完整凭据；
- rate limiter 的 key 应来自认证身份，而不是所有请求共享一个桶；
- `CorsLayer::permissive()` 适合 API 兼容，但生产边界还要由部署网络、认证和反向代理共同限制。

## 4. Handler 与 Service 的职责

[`handlers/sandboxes.rs`](../../CubeAPI/src/handlers/sandboxes.rs) 中的 handler 主要做：

- 从 Path/Query/JSON 提取 HTTP 参数；
- 对声明了 validator 规则的请求调用 `Validate`；创建请求中的环境变量、卷和网络组合则在 service 中做专门校验；
- 写 API 进入/完成日志；
- 调 service；
- 把结果映射为 HTTP status 和 JSON。

业务核心在 [`services/sandboxes.rs`](../../CubeAPI/src/services/sandboxes.rs)。这种拆分让 service 可以不依赖 Axum extractor，便于单元测试。

一个带 validator 规则的 handler 常见骨架是：

```rust
pub async fn create_sandbox(...) -> AppResult<impl IntoResponse> {
    // 若该请求模型声明了 validator 规则，在这里调用 body.validate()；
    // NewSandbox 的跨字段/安全校验主要在 SandboxService 中完成。
    let sandbox = state.services.sandboxes.create_sandbox(body).await?;
    Ok((StatusCode::CREATED, Json(sandbox)))
}
```

具体代码还包含结构化日志和错误处理，但理解时先抓住“HTTP 适配层”和“业务层”的边界。

## 5. 创建请求的模型转换

`SandboxService::create_sandbox` 是第一处值得逐行读的核心代码。输入是 E2B 风格 `NewSandbox`，输出是 CubeMaster `CreateSandboxRequest`。

### 5.1 环境变量安全校验

代码限制变量名/值长度，并拒绝一组能改变加载器或语言运行时行为的变量，例如：

- `LD_PRELOAD`、`LD_LIBRARY_PATH`；
- `PYTHONPATH`、`NODE_PATH`；
- `BASH_ENV`、`ENV`；
- `PATH`、`IFS`。

背景原因：这些不是普通业务变量，可能在 Guest 进程初始化前改变动态链接、命令解析或代码加载路径。服务端校验比依赖 SDK 校验更重要，因为攻击者可以绕过 SDK 直接发 HTTP。

### 5.2 模板通过 annotation 传递

service 会写入：

```text
cube.master.appsnapshot.template.id = <template_id>
cube.master.appsnapshot.template.version = v2
```

模板 ID 不是简单保留在外层字段，而是进入 CubeMaster 已有 annotation 协议。之后 CubeMaster 的模板解析逻辑会据此填充真正的容器、镜像、快照和资源信息。

### 5.3 metadata 与 host mount

普通 `metadata` 变成 labels；特殊键 `host-mount` 会被挪到 annotations。原因是 labels 适合索引/过滤，host mount 却会改变运行时行为，不应只当展示标签。

### 5.4 生命周期语义

E2B 风格：

```json
{
  "lifecycle": {
    "onTimeout": "pause",
    "autoResume": true
  }
}
```

会翻译为 CubeMaster 两个布尔值：

```text
auto_pause = onTimeout == "pause"
auto_resume = lifecycle.autoResume
```

未传 lifecycle 时保持默认 timeout kill 行为。`timeout` 本身按原值透传：缺失、0、正数和 -1 具有不同语义，不能在 SDK/API 层随意用 `unwrap_or(default)` 合并。

### 5.5 持久卷转换

E2B `volumeMounts` 同时影响：

- Pod 级 `volumes` 声明；
- 容器级挂载点。

CubeAPI 把卷名放入 `VolumeSpec`，又把路径列表序列化到 `plugin-volume-mounts` annotation。它刻意让 `containers = []`，由 CubeMaster 将挂载注入模板原有容器，避免覆盖模板的 image、command 等字段。

这是一个典型兼容层技巧：公开模型和内部模型不一一对应，需要一个不会破坏原有模板信息的旁路字段。

### 5.6 网络模型

`build_cube_network_config` 把：

- `allow_internet_access`；
- `allowOut` / `denyOut`；
- `allowPublicTraffic`；
- `maskRequestHost`；
- L7 `rules`

转换为 CubeMaster 能下发到 Cubelet/network-agent 的结构。这里同时涉及出站访问和入站公共访问，不要把公开请求的 `allow_internet_access=false` 与网络对象中的 `allowPublicTraffic=false` 混为一谈：前者限制沙箱访问外部，后者限制外部访问沙箱服务。

## 6. CubeAPI 到 CubeMaster

[`CubeAPI/src/cubemaster/mod.rs`](../../CubeAPI/src/cubemaster/mod.rs) 的 `CubeMasterClient` 是轻量 reqwest 封装：

```rust
pub async fn create_sandbox(&self, req: &CreateSandboxRequest)
    -> Result<CreateSandboxResponse, CubeMasterError>
{
    let url = format!("{}/cube/sandbox", self.base_url);
    let resp = self.inner.post(&url).json(req).send().await?;
    parse_response(resp).await
}
```

这里有两层错误：

1. HTTP/网络错误，如连接失败、timeout；
2. HTTP 成功但 JSON envelope 中 `ret_code != 0` 的业务错误。

阅读调用者时要确认两层都处理了。仅检查 `resp.status().is_success()` 会漏掉 CubeMaster 用 200 + 业务错误码表达的失败。

## 7. CubeMaster 的 HTTP 入口

CubeMaster 入口是 [`cmd/cubemaster/main.go`](../../CubeMaster/cmd/cubemaster/main.go)，HTTP 路由集中在 [`pkg/service/httpservice/cube/routes.go`](../../CubeMaster/pkg/service/httpservice/cube/routes.go)。它使用 Gin 注册 `/cube/sandbox`、snapshot、template、volume 等 API。

创建 handler 的真实链路：

```text
createSandboxGinHandler
  → createSandbox(http.Request, RequestTrace)
    → constructCreateReq
    → dealCubeboxCreateReqWithTemplate
    → runInsReq2Affinity
    → sandbox.CreateSandbox
```

[`sandbox_create.go`](../../CubeMaster/pkg/service/httpservice/cube/sandbox_create.go) 做了几件重要工作：

- 构造请求并补 namespace/network/label 默认值；
- 解析模板，将模板信息合入创建请求；
- 将明确的模板不存在映射为 NotFound；
- 将 stale template 映射为 Conflict；
- 创建成功后注册 snapshot runtime reference；
- 回传模板中的 envd 版本。

这表明模板解析发生在调度之前：调度器必须知道模板位置和资源需求才能正确选择节点。

## 8. CubeMaster 创建状态机

核心文件是 [`pkg/service/sandbox/sandbox_run.go`](../../CubeMaster/pkg/service/sandbox/sandbox_run.go)。`CreateSandbox` 建立 `createSandboxContext`，随后把它放进 scheduler buffer，等待 `done` 或 context 取消。

简化后的状态：

```text
newContext
   │ 构造 Cubelet 请求、资源需求、deadline
   ▼
进入调度 buffer
   ▼
Handle
   ▼
schedule → final admission → callCubelet
   │                │
   │失败可重试       └─ 节点 cordon/消失则重新调度
   ▼
dealSuccResult
   ├─ 写 Proxy Redis
   ├─ 持久化 sandbox spec
   └─ 运行 post-create hooks
```

### 8.1 为什么 Handle 和 Wait 分离

请求 goroutine 调 `Wait`，scheduler worker 调 `Handle`。这样可以在调度队列里控制并发和排队时间，同时原 HTTP 请求仍能等待最终结果或 deadline。

### 8.2 最终 admission gate

节点经过 scheduler 选择后，`refreshAndAdmitHost` 会重新从 cache 读取节点并检查 `SchedulingAllowed()`。这是为了关闭一个竞态窗口：节点可能在“被选中”与“真正调用 Cubelet”之间被 cordon。

分布式调度中，filter 通过不代表结果永久有效；在执行不可逆动作前重新验证关键前提是一种通用模式。

### 8.3 Cubelet 调用

[`pkg/cubelet/actions.go`](../../CubeMaster/pkg/cubelet/actions.go) 中：

```go
c := cubebox.NewCubeboxMgrClient(conn.Value())
return c.Create(ctx, req)
```

地址由节点 HostIP 和 Cubelet 配置端口组成。gRPC context 继承创建 deadline，所以 CubeAPI、CubeMaster、Cubelet 上各自的 timeout 需要整体协调；外层 timeout 太短会导致内层成功但调用者已取消的复杂状态。

### 8.4 重试与 failover

`callCubelet` 后会按网络错误或业务错误码判断：

- 是否重试同一类操作；
- 是否把当前节点加入 bad node；
- 是否重新调度其他节点；
- 是否做指数/随机 backoff。

不要把所有错误都重试。参数错误、模板不存在等确定性失败重试没有意义；连接、节点瞬时资源等才可能重试。

## 9. 调度器：过滤和打分

[`pkg/scheduler/schedule.go`](../../CubeMaster/pkg/scheduler/schedule.go) 的 `Select` 顺序：

1. `runPreFilter` 得到初始节点集合；
2. `runFilter` 并行运行所有硬性过滤器；
3. 对过滤结果取交集；
4. `runScoreFilter` 计算偏好；
5. 从优先候选中选择节点。

并行 filter 的关键逻辑不是“任一 filter 通过就行”，而是用计数确认节点出现在每一个 filter 结果中：

```go
expectedCnt := len(filters)
for _, n := range selCtx.Nodes() {
    if expectedCnt == tmpStat.Get(n.ID()) {
        result.Append(n)
    }
}
```

背景知识：

- Filter 是 AND：资源足够、节点健康、模板可用等条件必须都满足；
- Score 是 preference：在可用节点中优化负载、局部性等；
- Template locality filter 失败时有时不能走普通 backoff，否则可能选到根本没有制品的节点。

## 10. 创建成功后的状态写入

`dealSuccResult` 在 Cubelet 成功后并行执行两个无数据依赖的动作：

- `setProxyToRedis`；
- `persistSandboxSpec`。

### 10.1 Proxy Redis 映射

CubeMaster 写入类似以下元数据：

```text
HostIP
SandboxID
SandboxIP
SandboxPort
ContainerToHostPorts
AllowPublicTraffic
TrafficAccessToken
MaskRequestHost
```

CubeProxy 后续按 `sandbox_id + container_port` 查它。如果该写入失败，创建响应被转成 DBError，因为返回一个无法访问的数据面沙箱对调用者没有意义。

当 `allow_public_traffic=false` 时，CubeMaster生成随机 token。代码只在 Redis 映射成功后才把 token 放入响应，避免客户端拿到 token 时 Proxy 尚不能校验。

### 10.2 Sandbox spec

原始创建请求通过 post-create hook 持久化。它是 best effort：失败会警告但不推翻成功响应，后续需要 spec 的流程可以回退到基础模板。

这与 Proxy 映射的失败策略不同，说明“后置写失败是否应让创建失败”取决于它是否影响沙箱的立即可用性。

### 10.3 生命周期事件

CubeMaster 的 lifecycle hook 把 create/update/delete 等事件写入 Redis stream/meta。`cube-lifecycle-manager` 消费它们，向所有 CubeProxy 副本同步 meta/state，并驱动空闲暂停/请求恢复。

## 11. 错误映射方法

同一失败需要跨三套语义：

```text
Cubelet gRPC/ret code
       ↓
CubeMaster ret_code + ret_msg（常在 HTTP 200 envelope）
       ↓
CubeAPI AppError
       ↓
HTTP status + E2B 风格错误体
```

排查时记录全部信息：HTTP status、CubeMaster ret_code、request_id、sandbox_id、原始 message。只保留最终 `500` 会失去最有价值的分类。

## 12. 测试入口

### 12.1 CubeAPI

```bash
cd CubeAPI
cargo test
```

路由测试会启动本地 Axum mock CubeMaster，验证业务错误到 HTTP 的映射。这类测试不需要真实 KVM。

### 12.2 CubeMaster

```bash
cd CubeMaster
go test ./pkg/scheduler/...
go test ./pkg/service/sandbox/...
go test ./pkg/service/httpservice/cube/...
```

根目录统一 builder：

```bash
make cube-api-test
make cubemaster-test
```

## 13. 动手练习

### 练习 1：追一个字段

选 `allowPublicTraffic`，按下面顺序记录每层字段名和类型：

1. CubeAPI model；
2. `build_cube_network_config`；
3. CubeMaster create types；
4. `setProxyToRedis`；
5. CubeProxy `sandbox_backend.lua`。

目标：理解一个公开参数如何变成真实执行策略。

### 练习 2：为新错误设计映射

假设 Cubelet 新增“模板副本校验和不匹配”错误。写一页设计：

- 是否可重试/换节点；
- CubeMaster ret_code；
- CubeAPI HTTP status；
- SDK 应抛什么异常；
- 日志是否可以包含实际/期望 digest。

### 练习 3：观察创建链路

在测试部署中创建带 metadata 的沙箱，并按 request ID 查 CubeAPI、CubeMaster、Cubelet 日志。记录每层耗时字段，判断排队、调度、Cubelet和后置 Redis 写各占多少。

## 14. 自测题

1. 为什么 CubeAPI 的 `containers` 可以为空，Cubelet 最终却有容器配置？
2. 为什么节点刚被 scheduler 选中后还要做一次 admission？
3. Proxy Redis 写失败为什么比 spec 持久化失败更严重？
4. HTTP 200 为什么仍可能代表创建失败？
5. Filter 并行执行后为什么要取交集？
