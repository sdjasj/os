# 10. Ray Serve 在线服务

## 10.1 Serve 在 Core 上增加了什么

Actor 能常驻模型，但生产服务还需要：

- 声明和版本化部署目标；
- 多 Replica 与滚动更新；
- HTTP/gRPC/Handle 入口；
- 请求路由、队列、背压；
- 健康检查与故障重建；
- autoscaling；
- 多 Deployment 组合。

Serve 把这些控制面与数据面能力建立在 Ray Actor 上。

## 10.2 最小例子

```python
from ray import serve

@serve.deployment(num_replicas=2, ray_actor_options={"num_cpus": 1})
class Doubler:
    def __call__(self, value: int):
        return value * 2

app = Doubler.bind()
handle = serve.run(app)
response = handle.remote(21)
print(response.result())
```

`@serve.deployment` 没创建 Actor；`.bind()` 没执行构造函数；`serve.run` 才把目标应用交给 Serve controller 收敛。

## 10.3 Deployment、Application、Replica

- **Deployment**：用户 class/function 加部署配置的声明对象；
- **Application**：若干 bound Deployment 组成的应用图；
- **Replica**：某 Deployment 的一个实际 Ray Actor 实例；
- **DeploymentHandle**：向某 Deployment 发请求的客户端；
- **Controller**：保存目标状态并不断 reconcile；
- **Proxy**：接收 HTTP/gRPC，转换并路由请求。

一个 Deployment 有多个 Replica；一个 Application 可以有多个 Deployment；一个 Serve 集群可以有多个命名 Application。

## 10.4 装饰器与 bind

[api.py](../python/ray/serve/api.py) 的 `deployment` 把 class/function 转为
[deployment.py](../python/ray/serve/deployment.py) 的 `Deployment`，同时验证：

- replicas/autoscaling；
- Actor resources；
- max ongoing/queued requests；
- health check 与 graceful shutdown；
- placement group/gang scheduling；
- rolling update 等。

`.bind(args)` 创建 DAG/Application node，把下游 Deployment 作为构造参数连接起来。此时主要是可序列化声明，不启动 Replica。

## 10.5 `serve.run` 提交路径

```text
serve.run(Application)
  -> _run
  -> _run_many
     - build app/deployment descriptors
     - serve_start：获取或创建 Serve Controller 与 proxies
     - ServeControllerClient.deploy_applications
  -> Controller.deploy_applications / apply target state
  -> 等待 ingress 创建/应用 RUNNING（取决于参数）
  -> 返回 ingress DeploymentHandle
```

入口见 [api.py](../python/ray/serve/api.py)，客户端见
[client.py](../python/ray/serve/_private/client.py)，Controller 见
[controller.py](../python/ray/serve/_private/controller.py)。

Controller 通常是命名、detached Actor，使 Serve 应用不依赖提交 Driver 长期存活。用户再次调用 `serve.run` 是更新目标状态，不是绕过 Controller 直接创建若干 Actor。

## 10.6 Controller 的 reconcile 模型

声明式系统不把“创建 3 个 Replica”当一次性命令，而维护：

```text
target state: Deployment A 应有 3 个、版本 v2、资源 X
current state: 2 个 RUNNING(v1) + 1 个 STARTING(v2)
reconcile: 启动/停止/更新，直到 current 接近 target
```

Controller 内：

- `ApplicationStateManager` 管应用构建和状态；
- `DeploymentStateManager` 管每个 Deployment；
- `DeploymentState` 管 target config/version 与 Replica 容器；
- `DeploymentScheduler` 选择 Replica 放置；
- autoscaling state 根据请求指标调整 target replicas。

核心文件是 [application_state.py](../python/ray/serve/_private/application_state.py) 和
[deployment_state.py](../python/ray/serve/_private/deployment_state.py)。它们很长，阅读时从 `update`/reconcile 方法和状态 enum 开始，不要从辅助 dataclass 顺读。

## 10.7 Replica 是 Ray Actor

[replica.py](../python/ray/serve/_private/replica.py) 的 `ReplicaActor` 定义 Controller、Handle、Proxy 与副本交互的 Actor 接口：

- `is_allocated`：Worker slot 已分配；
- `initialize_and_get_metadata`：加载用户 callable 并初始化；
- `check_health`；
- `reconfigure`；
- `handle_request`/`handle_request_streaming`；
- `handle_request_with_rejection`：严格容量拒绝；
- graceful shutdown 等。

`ReplicaActor` 内部创建 `Replica` 实现和 `UserCallableWrapper`，所有用户 class/function 调用通过 wrapper 处理。它还维护 Serve context、method selection、ASGI/gRPC、batching、metrics 和异常。

## 10.8 Replica 生命周期状态

高层阶段：

```text
PENDING_ALLOCATION
  -> PENDING_INITIALIZATION
  -> RUNNING
  -> STOPPING
  -> removed
```

还可能出现 constructor/health failure、recovering、updating。Controller 区分“Actor 已拿到资源”和“用户构造已成功”，因为这两种失败的诊断与重试完全不同。

滚动更新时，DeploymentState 同时管理旧版本和新版本副本，按健康、容量和 `rolling_update_percentage` 决定批次，不能简单一次杀光旧版本。

## 10.9 请求数据路径

DeploymentHandle 路径：

```text
handle.remote(args)
  -> 构造 RequestMetadata
  -> Router.assign_request
  -> 根据 long-poll 的 running replicas 选择 Replica
  -> 调用 ReplicaActor.handle_request[_with_rejection]
  -> Replica/UserCallableWrapper 调用户方法
  -> DeploymentResponse / stream 返回调用者
```

HTTP/gRPC 路径在前面多一层 Proxy：

```text
client -> Proxy -> route/application -> Handle/Router -> Replica -> user code
```

Router 实现在 [router.py](../python/ray/serve/_private/router.py)，Handle 在
[handle.py](../python/ray/serve/handle.py)。Router 通过 long poll 接收 Controller 发布的 Replica 集合/配置更新，正常请求不必每次同步询问 Controller，避免控制面成为请求数据面瓶颈。

## 10.10 路由与 locality

Router 的选择会考虑可用 Replica、队列长度/容量、节点或可用区 locality、multiplexed model 等策略。选择结果仍可能过时：Replica 在收到请求时已满，因此严格路径允许副本先返回 accepted/rejected，再由 Router 选择其他 Replica。

这与 Ray Core 分布式调度相似：控制状态有传播延迟，最终接收方必须能拒绝过期决策。

## 10.11 三层背压

1. `max_ongoing_requests`：每个 Replica 同时处理的请求上限；
2. `max_queued_requests`：每个调用方 Router/Proxy 为 Deployment 排队上限；
3. 上游协议/客户端并发：HTTP 连接池、Handle 调用数量、流式消费速度。

Replica 满载不一定意味着请求立即失败；可能先在 Router 排队。无限队列会增加延迟和内存，因此生产配置应把吞吐、并发、超时、队列一起设计。

Little's Law 提供直觉：并发数约等于吞吐 × 平均延迟。若单 Replica 每请求 100ms，目标 100 req/s，至少需要约 10 个持续并发槽，再考虑波动和尾延迟。

## 10.12 Autoscaling

Serve autoscaler 根据 ongoing/queued requests 等指标调整 Replica target。它受：

- min/max replicas；
- target ongoing requests；
- upscale/downscale delays；
- Controller control loop 周期；
- Ray 集群是否有资源、集群 Autoscaler 启动节点延迟；
- Replica 构造/模型加载时间。

Serve Replica autoscaling 与 Ray cluster autoscaling 是两层环：Serve 请求更多 Actor，Ray cluster 才可能根据 resource demand 增节点。冷启动延迟是两层之和。

## 10.13 Deployment composition

```python
@serve.deployment
class Preprocessor:
    def __call__(self, x):
        return x + 1

@serve.deployment
class Model:
    def __init__(self, preprocessor):
        self.preprocessor = preprocessor

    async def __call__(self, x):
        y = await self.preprocessor.remote(x)
        return y * 2

app = Model.bind(Preprocessor.bind())
```

下游 bound deployment 在构建时变成 handle 注入上游 Replica。调用仍是分布式 RPC；`await` 不会把两个 Deployment 融合进一个进程。拆分带来独立扩缩容和故障域，也增加网络/序列化/排队。

## 10.14 Batching

`@serve.batch` 在 Replica 内把多个请求聚成一个模型 batch，提高 GPU/向量化吞吐。它与 Ray Data batch 不同：Serve batch 聚合在线请求，受最大 batch size 和等待时间约束；Ray Data batch 来自离线 block pipeline。

调优 trade-off：等待更多请求提高吞吐，但增加单请求排队延迟。低 QPS 时可能永远凑不满，因此需要 timeout。

## 10.15 健康、重启和 graceful shutdown

- Controller 周期调用 `check_health`；
- Replica Actor 崩溃由 Ray Actor 故障机制检测，DeploymentState 创建替代副本；
- 用户 constructor 失败有单独重试上限；
- 更新/缩容时先停止发新请求，等待 ongoing request 排空；
- 超过 graceful timeout 后强制终止。

请求是否自动安全重试取决于路径、错误发生阶段和配置。非幂等请求不能因为“Serve 有故障恢复”就默认重复执行安全。

## 10.16 调试顺序

1. `serve.status()`/Dashboard：Application、Deployment 是否 RUNNING；
2. Controller 日志：目标状态、构建、reconcile 失败；
3. Replica state：卡在 allocation 还是 initialization；
4. Ray resource demands：Replica Actor 是否不可调度；
5. Replica 日志：用户构造、health、request exception；
6. Router/Proxy metrics：queued、ongoing、rejected、error；
7. 延迟拆成 proxy queue、router queue、Replica queue、user code。

## 10.17 常见反模式

1. 每个请求在 Replica 内重新加载模型；
2. async handler 内跑长时间阻塞 CPU Python；
3. 一个 Deployment 串起许多极细粒度 RPC；
4. `max_queued_requests=-1` 同时没有上游限流；
5. Autoscaling max 设置很高，但集群没有对应 GPU node type；
6. 滚动更新不保留足够旧容量，导致排队尖峰；
7. 把 Replica 本地内存当持久数据库；
8. 对非幂等写请求做无条件重试。

## 10.18 自测题

1. Deployment、Application、Replica 的数量关系是什么？
2. `.bind()` 为什么没有立即创建 Actor？
3. Router 为什么通过 long poll 更新 Replica 集合，而不逐请求问 Controller？
4. Serve autoscaling 与 cluster autoscaling 如何串联？
5. allocation 与 initialization 为什么是两个状态？
6. 在线 batching 为什么要同时考虑吞吐和尾延迟？

