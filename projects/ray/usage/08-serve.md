# 08. Ray Serve：在线推理与服务组合

## 1. Serve 解决什么问题

Ray Serve 把 Python 推理代码运行成可扩缩、可组合的长时服务。它管理：

- HTTP/gRPC 或 Python Handle 请求入口；
- Deployment 的多个 Replica；
- CPU/GPU 资源和节点放置；
- Replica 故障恢复；
- 自动扩缩和请求排队；
- 多模型/多阶段应用组合；
- 动态批处理与监控指标。

安装：

```bash
python -m pip install "ray[serve]"
```

Serve 不替代外部 API Gateway、WAF、身份认证、TLS、跨地域路由和业务数据库。

## 2. 第一个 Deployment

```python
from ray import serve
from starlette.requests import Request

@serve.deployment
class Greeter:
    def __init__(self, message: str):
        self.message = message

    def __call__(self, request: Request):
        return {"message": self.message}

app = Greeter.bind("Hello from Ray Serve")
serve.run(app, route_prefix="/")
```

另一个终端请求：

```bash
curl http://127.0.0.1:8000/
```

仓库的官方最小示例见 [`../doc/source/serve/doc_code/quickstart.py`](../doc/source/serve/doc_code/quickstart.py)，本教程版本见 [`examples/serve_app.py`](examples/serve_app.py)。

## 3. Deployment、Replica、Application

- **Deployment**：类/函数及其运行配置，如资源、Replica 数和扩缩策略；
- **Replica**：Deployment 的一个实际进程副本，底层由 Actor 承载；
- **Application**：通过 `.bind()` 形成的一组 Deployment 图，是部署和升级单元；
- **DeploymentHandle**：从 Python 调用 Deployment 的异步句柄；
- **Proxy**：接收外部 HTTP/gRPC 请求并路由到 Replica。

类的 `__init__` 在每个 Replica 创建时执行，因此适合加载模型。不要在模块 import 顶层加载 GPU 模型，否则 Driver 和每个导入进程都可能加载一份。

## 4. 使用 DeploymentHandle 组合服务

```python
from ray import serve
from ray.serve.handle import DeploymentHandle

@serve.deployment
class Encoder:
    def encode(self, text: str):
        return [len(text)]

@serve.deployment
class Classifier:
    def predict(self, vector):
        return "long" if vector[0] > 10 else "short"

@serve.deployment
class Ingress:
    def __init__(
        self,
        encoder: DeploymentHandle,
        classifier: DeploymentHandle,
    ):
        self.encoder = encoder
        self.classifier = classifier

    async def __call__(self, request):
        body = await request.json()
        vector_ref = self.encoder.encode.remote(body["text"])
        label = await self.classifier.predict.remote(vector_ref)
        return {"label": label}

app = Ingress.bind(Encoder.bind(), Classifier.bind())
```

Handle 调用返回可等待的响应对象。异步入口中用 `await`，避免阻塞 Replica 的事件循环。Handle 可直接把上游返回传给下游，形成服务组合图。

## 5. FastAPI 入口

```python
from fastapi import FastAPI
from ray import serve

fastapi = FastAPI()

@serve.deployment
@serve.ingress(fastapi)
class Api:
    @fastapi.get("/health")
    def health(self):
        return {"status": "ok"}

    @fastapi.post("/predict")
    async def predict(self, payload: dict):
        return {"prediction": payload["value"] * 2}

app = Api.bind()
```

FastAPI 负责路由、参数验证和 OpenAPI；Serve 负责 Replica、分布式资源和扩缩。生产鉴权仍应明确配置，不能因为使用 FastAPI 就默认安全。

## 6. Replica 和资源配置

```python
@serve.deployment(
    num_replicas=2,
    ray_actor_options={
        "num_cpus": 2,
        "num_gpus": 1,
    },
    max_ongoing_requests=8,
)
class Model:
    ...
```

总资源大约是每 Replica 资源乘 Replica 数。`num_replicas=4, num_gpus=1` 需要 4 个可调度 GPU。

`max_ongoing_requests` 控制一个 Replica 可同时处理的在途请求。它不是越大越好：

- 同步 CPU/GPU 推理通常并发过高会增加排队和显存压力；
- 异步 I/O 服务可以适度提高；
- 必须用延迟分位数、吞吐和资源利用率压测。

## 7. 自动扩缩

```python
@serve.deployment(
    autoscaling_config={
        "min_replicas": 1,
        "max_replicas": 8,
        "target_ongoing_requests": 2,
    },
    ray_actor_options={"num_cpus": 1},
)
class ScalableModel:
    ...
```

需要理解两层扩缩：

1. Serve Autoscaler 根据请求压力增加/减少 Replica；
2. Ray Cluster Autoscaler 根据 Replica 的逻辑资源请求增加/减少节点。

如果集群没有可扩节点或云配额，Serve 想增加 Replica 也只会等待资源。缩容/扩容包含模型加载和节点启动冷启动时间，应设置合理最小副本并进行容量测试。

## 8. 动态批处理

```python
@serve.deployment
class BatchedModel:
    def __init__(self):
        self.model = load_model()

    @serve.batch(max_batch_size=16, batch_wait_timeout_s=0.01)
    async def predict(self, inputs: list[str]) -> list[dict]:
        outputs = self.model(inputs)
        return [{"output": value} for value in outputs]

    async def __call__(self, request):
        body = await request.json()
        return await self.predict(body["text"])
```

批处理在吞吐和延迟之间权衡：

- `max_batch_size` 大，设备利用率可能更高，但单批显存和尾延迟上升；
- `batch_wait_timeout_s` 大，更容易凑批，但低流量请求等待更久；
- 返回列表长度必须与输入请求数量对应；
- 模型本身要支持批输入。

离线海量推理使用 Ray Data；在线请求动态凑批使用 Serve。

## 9. 背压和负载保护

当所有 Replica 忙碌，请求会排队。无限排队会让尾延迟和内存持续上升。可配置队列上限：

```python
@serve.deployment(
    max_ongoing_requests=8,
    max_queued_requests=100,
)
class ProtectedModel:
    ...
```

超过上限的 HTTP 请求可返回 503。外部调用方应使用带抖动的指数退避、超时和有限重试。生产容量策略应明确“宁可拒绝还是无限等待”。

## 10. 本地开发与生产部署

### 10.1 本地代码运行

```python
serve.run(app)
```

适合单元验证和脚本内控制。

### 10.2 CLI 开发

如果 `serve_app.py` 暴露变量 `app`：

```bash
serve run ray_usage_guide.examples.serve_app:app
```

CLI 会阻塞并便于观察日志，适合本地迭代。

### 10.3 配置化部署

生产中可通过 Serve YAML 和 `serve deploy` 更新应用配置。轻量扩缩/资源更改与代码升级分开管理，结合 KubeRay RayService 实现集群和应用生命周期。

不要把一个临时 SSH Shell 中的 `serve.run()` 当作完整生产部署方案。需要持久控制器、健康检查、持久日志、指标、入口网络和升级策略。

## 11. 模型更新

常见选择：

- 代码/权重作为新应用版本，滚动更新 Replica；
- `user_config` 做轻量可重配置参数；
- 模型多路复用适合大量较小模型；
- 蓝绿/金丝雀发布通常与外部流量层结合。

权重应来自所有 Replica 可访问的存储或随镜像提供。不要依赖只在 Head 节点存在的路径。

## 12. 观测重点

至少监控：

- 请求吞吐和成功/错误码；
- P50/P95/P99 延迟；
- Handle/Proxy 排队；
- Replica 在途请求；
- Replica 启动/恢复失败；
- CPU/GPU/显存；
- Autoscaler 目标与实际副本；
- 下游依赖延迟和错误；
- 每版本请求分布。

日志中加入 request ID 并在跨 Deployment 调用中传播，才能定位一次请求经过的完整链路。

## 13. 常见错误

- 在模块顶层加载模型，而不是 Replica `__init__`；
- 异步方法里调用阻塞 I/O 或同步 `.result()`；
- 每 Replica 申请 1 GPU，却部署超过集群 GPU 数的副本；
- 没有设置请求超时、队列上限和负载保护；
- 只压平均延迟，不看 P99；
- 动态批处理返回数量与请求数不一致；
- 把本地开发 `serve.run` 当生产控制面；
- Replica 保持唯一业务状态，重启后无法恢复；
- 外部 API 无鉴权便直接暴露 Dashboard/Serve 端口。

## 14. 本章对应的项目代码

- 快速示例：[`../doc/source/serve/doc_code/quickstart.py`](../doc/source/serve/doc_code/quickstart.py)
- 组合示例：[`../doc/source/serve/doc_code/quickstart_composed.py`](../doc/source/serve/doc_code/quickstart_composed.py)
- Deployment API：[`../python/ray/serve/deployment.py`](../python/ray/serve/deployment.py)
- Handle：[`../python/ray/serve/handle.py`](../python/ray/serve/handle.py)
- 本地开发：[`../doc/source/serve/advanced-guides/dev-workflow.md`](../doc/source/serve/advanced-guides/dev-workflow.md)
- 生产实践：[`../doc/source/serve/production-guide/best-practices.md`](../doc/source/serve/production-guide/best-practices.md)
- 监控：[`../doc/source/serve/monitoring.md`](../doc/source/serve/monitoring.md)

下一章介绍 RLlib 如何把环境采样、学习和评估扩展到分布式强化学习。
