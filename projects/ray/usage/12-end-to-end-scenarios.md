# 12. 端到端场景：功能怎样组合

本章不追求一个巨大的“全家桶”示例，而是从业务目标出发拆分边界。Ray 的各库可以组合，但并不意味着每个应用都要用完所有库。

## 场景 1：并行处理一批独立文件

### 目标

把 10,000 个输入文件转换成输出文件，每个文件处理 1–10 秒，结果互相独立。

### 选择

先用 Ray Core Task。输入是简单路径列表、不需要关系算子，Data 不是必需。

```text
Driver
  ├─ process_file(file_1) ─→ output_1
  ├─ process_file(file_2) ─→ output_2
  └─ ... bounded window ...
```

```python
@ray.remote(num_cpus=1, max_retries=2)
def process_file(input_uri, output_uri):
    data = read(input_uri)
    result = transform(data)
    write_atomically(output_uri, result)
    return {"input": input_uri, "output": output_uri}
```

关键设计：

- 使用 [`bounded_tasks.py`](examples/bounded_tasks.py) 的窗口限制在途任务；
- 输出使用确定性路径和幂等写入；
- Task 返回小型元数据，不把整个文件内容拉回 Driver；
- 对永久业务错误不盲目重试；
- 每个 Task 粒度足够大。

何时改用 Data：输入变成 Parquet/表格，需要批次 UDF、过滤、聚合、重分区或批量推理。

## 场景 2：大规模 ETL + GPU 批量推理

### 目标

从对象存储读取文本，CPU 清洗/分词，GPU 生成 embedding，再写回 Parquet。

### 选择

Ray Data。

```text
Object Storage
  → read_parquet
  → CPU map_batches(clean/tokenize)
  → GPU ActorPool map_batches(model)
  → write_parquet
```

```python
import ray

ds = ray.data.read_parquet("s3://bucket/raw/")
ds = ds.filter(lambda row: bool(row["text"]))
ds = ds.map_batches(
    tokenize,
    batch_format="pandas",
    batch_size=2048,
    num_cpus=1,
)
ds = ds.map_batches(
    EmbeddingModel,
    batch_format="numpy",
    batch_size=128,
    compute=ray.data.ActorPoolStrategy(size=8),
    num_gpus=1,
)
ds.write_parquet("s3://bucket/embeddings/run-20260720/")
```

容量规划：

- 8 个模型 Actor 需要 8 GPU；
- CPU tokenizer 并发应能持续供满 GPU；
- batch 过大可能显存 OOM，过小降低吞吐；
- 避免在中间 `materialize` 全部 embedding；
- 输出使用新目录，完成后再更新外部元数据/表指针。

## 场景 3：多 GPU 训练 + 超参数搜索

### 目标

每次训练使用 2 GPU，共搜索 12 组学习率和 dropout，差 Trial 提前停止。

### 选择

Ray Data + Train + Tune。

```text
Tune Experiment
  ├─ Trial A → TorchTrainer → 2 GPU Workers
  ├─ Trial B → TorchTrainer → 2 GPU Workers
  └─ ... ASHA stop/promote ...
          ↑
       Ray Data shards
```

资源计算：若集群 8 GPU，每 Trial 2 GPU，最多约 4 个 Trial 同时训练；还要考虑 CPU、对象存储和数据源吞吐。

```python
from ray import tune, train
from ray.train import ScalingConfig
from ray.train.torch import TorchTrainer
from ray.tune.schedulers import ASHAScheduler

train_ds = ray.data.read_parquet("s3://bucket/train/")

trainer = TorchTrainer(
    train_loop_per_worker,
    train_loop_config={
        "lr": tune.loguniform(1e-5, 1e-2),
        "dropout": tune.uniform(0.0, 0.5),
    },
    scaling_config=ScalingConfig(num_workers=2, use_gpu=True),
    datasets={"train": train_ds},
)

tuner = tune.Tuner(
    trainer,
    tune_config=tune.TuneConfig(
        metric="val_loss",
        mode="min",
        num_samples=12,
        scheduler=ASHAScheduler(
            metric="val_loss",
            mode="min",
            grace_period=3,
        ),
    ),
    run_config=train.RunConfig(
        storage_path="s3://bucket/experiments",
        name="model-search-20260720",
    ),
)
results = tuner.fit()
```

关键设计：

- 训练函数每 epoch 报告指标，ASHA 才能提前停止；
- Checkpoint 写共享存储；
- 数据读取能力能支撑多个 Trial；
- 最佳 Trial 用独立测试集复验，不把 Tune 验证最高分当最终结论。

## 场景 4：把模型部署为在线 API

### 目标

提供 `/predict`，自动扩到 8 个 GPU Replica，并通过动态 batch 提高吞吐。

### 选择

Ray Serve，Kubernetes 上使用 KubeRay RayService。

```text
Client
  → API Gateway/Auth/TLS
  → Serve Proxy
  → Ingress Deployment
  → Model Deployment replicas (autoscaling + batching)
  → Response
```

关键配置：

- `ray_actor_options={"num_gpus": 1}`；
- `autoscaling_config` 的 min/max/target；
- `max_ongoing_requests` 和 `max_queued_requests`；
- `@serve.batch` 的 batch size 和 wait timeout；
- 权重 URI 和版本；
- readiness、超时、重试、request ID、P99 指标。

不要把训练代码和 Serve Replica 混在一个进程。训练产生版本化 Checkpoint，部署流程验证并加载它。

## 场景 5：训练到部署的模型生命周期

### 目标

每日生成新模型，只有验证通过才升级在线服务。

```text
RayJob A: Data → Train/Tune → checkpoint + metrics
                         ↓
                 Model registry / validation
                         ↓ approved version
RayService B: Serve loads immutable model version
                         ↓
                   canary → full rollout
```

边界设计：

1. 训练 Job 只写不可变 Checkpoint 和元数据；
2. 注册/审批层决定哪个版本可部署；
3. Serve 配置引用明确版本，不读取“latest”可变路径；
4. 新 Replica 先健康检查和预热；
5. 外部流量层做金丝雀或蓝绿；
6. 指标异常可回滚到上一不可变版本。

Ray 能覆盖计算和服务运行，但模型注册、审批和流量治理通常需要外部系统配合。

## 场景 6：强化学习实验平台

### 目标

并行采样仿真环境，训练 PPO，并搜索学习率/批大小。

### 选择

RLlib + Tune。

```text
Tune
  ├─ PPO Trial 1
  │    ├─ EnvRunners → simulator actors
  │    └─ Learner GPU
  ├─ PPO Trial 2
  └─ ...
```

关键设计：

- 先验证环境 step/reset 和 reward；
- 明确每 Trial 的 EnvRunner CPU 与 Learner GPU；
- 评估使用独立 EnvRunner 和多个 seed；
- 仿真器需要许可证/特殊硬件时，用自定义资源；
- Checkpoint 包含足够状态恢复训练；
- Tune 的 Trial 并发不要压垮外部模拟服务。

## 场景 7：有状态在线协调器

### 目标

一个服务需要对租户做短期限流和缓存。

可能组合：Serve 负责 HTTP/Replica，Actor 负责分片状态，外部 Redis/数据库负责持久状态。

```text
Serve replicas
  → sharded Actor cache/rate limiter
  → durable external store
```

注意：单 Actor 是单点吞吐瓶颈；Detached Actor 也不是数据库。业务不能因 Actor 重启就丢失的重要状态必须放外部持久系统。

## 场景 8：异构资源流水线

### 目标

CPU 解析 → 需要特定设备的解码 → GPU 推理 → CPU 后处理。

```python
@ray.remote(num_cpus=1)
def parse(item): ...

@ray.remote(resources={"decoder": 1})
def decode(parsed): ...

@ray.remote(num_gpus=1)
def infer(decoded): ...

@ray.remote(num_cpus=1)
def postprocess(prediction): ...

final_refs = []
for item in items:
    a = parse.remote(item)
    b = decode.remote(a)
    c = infer.remote(b)
    final_refs.append(postprocess.remote(c))
```

若每个阶段都是大规模数据批处理，改用 Data 的连续算子更容易获得流式执行和背压。如果是一条重复执行、拓扑固定、低开销要求很高的 Ray DAG，可以进一步评估 Compiled Graph，但它是高级能力，应在普通 Core 正确且 profiling 证明调度开销显著后再使用。

## 场景选择总结

| 场景 | 最小功能集合 | 常见误用 |
| --- | --- | --- |
| 独立文件并行 | Tasks | 每个微小记录一个 Task |
| 状态/连接复用 | Actors | 把 Actor 当持久数据库 |
| ETL/批推理 | Data | Driver `take_all()` |
| 一次多卡训练 | Train | 每 Worker 重复读全量数据 |
| 参数搜索 | Tune | 不报告中间指标 |
| 在线服务 | Serve | 无队列上限和外部鉴权 |
| 强化学习 | RLlib | 环境未验证就扩集群 |
| 生产批作业 | Jobs | SSH Head 直接跑长任务 |
| K8s 在线服务 | RayService | 只部署 RayCluster 不管理 Serve 升级 |

下一章给出跨场景的选型、性能、可靠性、安全和上线检查表。
