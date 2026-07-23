# 9. Ray Train 与 Ray Tune

## 9.1 先区分职责

| 库 | 管理对象 | 核心问题 |
|---|---|---|
| Ray Train | 一次分布式训练 run 的 worker group | 如何同时启动、配置、监控多个训练进程并汇报 checkpoint？ |
| Ray Tune | 多个 Trial | 下一组超参是什么、哪些 Trial 运行/暂停/停止、资源如何复用？ |

Train 可以独立运行，也可以作为 Tune 的 trainable。不要把“4 个训练 worker”误认为“4 个超参 Trial”：前者协作训练一个模型，后者通常训练 4 个独立模型。

## 9.2 数据并行背景

SPMD（Single Program, Multiple Data）模式：同一个 `train_loop_per_worker` 在多个进程执行，每个进程拿不同 rank 和数据 shard，模型参数通过 collective 同步。

```text
Controller
  ├── Worker rank 0: data shard 0, model replica
  ├── Worker rank 1: data shard 1, model replica
  └── Worker rank 2: data shard 2, model replica
                 ↕ all-reduce gradients
```

Ray 负责进程与资源，PyTorch Distributed/NCCL/Gloo 等负责集合通信。Ray Train 在二者之间配置地址、rank、world size、device 和生命周期。

## 9.3 当前仓库的 Train v1/v2

[python/ray/train/__init__.py](../python/ray/train/__init__.py) 会根据 `is_v2_enabled()` 条件导出 v1 或 v2 的 config、context、report 等实现。当前源码同时保留：

- v1：`python/ray/train/data_parallel_trainer.py`、`_internal/backend_executor.py`；
- v2：`python/ray/train/v2/api/data_parallel_trainer.py`、`v2/_internal/execution/`。

阅读 issue、日志和堆栈时先确认使用哪套实现。教程重点解释共同模型，并标出差异，不把内部 v1/v2 API 混用。

## 9.4 TorchTrainer 的用户模型

```python
import ray
from ray import train
from ray.train import ScalingConfig
from ray.train.torch import TorchTrainer

def train_loop(config):
    import torch

    ctx = train.get_context()
    model = torch.nn.Linear(1, 1)
    model = train.torch.prepare_model(model)

    # 实际项目从 train.get_dataset_shard("train") 取数据。
    loss = torch.tensor(float(ctx.get_world_rank()))
    train.report({"loss": loss.item()})

trainer = TorchTrainer(
    train_loop_per_worker=train_loop,
    train_loop_config={"lr": 1e-3},
    scaling_config=ScalingConfig(num_workers=2, use_gpu=False),
)

result = trainer.fit()
```

API 名在 Train v1/v2 下保持相似，但启用方式、故障策略和内部 controller 不同；运行前以当前官方文档和环境配置为准。

## 9.5 Train v2 `fit` 调用链

关键入口：[v2/api/data_parallel_trainer.py](../python/ray/train/v2/api/data_parallel_trainer.py)。

```text
DataParallelTrainer.fit
  -> construct_train_func(train_loop_per_worker, config)
  -> 创建 TrainController（通常是远程控制实体）
     - ScalingPolicy
     - FailurePolicy
     - CheckpointManager
     - Datasets/Backend/Accelerator callbacks
  -> Controller 建立 WorkerGroup
     - 创建 Placement Group
     - 每个 bundle 创建 train worker Actor
     - 设置 rank/world metadata
     - backend setup
  -> 所有 worker 执行 train function
  -> report/checkpoint 回到 Controller
  -> poll health / resize / failure decision
  -> 返回 Result 或抛 TrainingFailedError
```

[controller.py](../python/ray/train/v2/_internal/execution/controller/controller.py) 的 `TrainController` 类注释明确列出：运行训练函数、监控 WorkerGroup、处理扩缩容和失败、执行 callbacks。

## 9.6 WorkerGroup 为什么使用 Actor 与 PG

训练 Worker 需要长期进程状态：初始化 collective、持有模型/optimizer、执行多 epoch，所以用 Actor 合理。多个 worker 还要 gang scheduling，因此
[worker_group.py](../python/ray/train/v2/_internal/execution/worker_group/worker_group.py) 会：

1. 按 `resources_per_worker` 创建 bundle；
2. 创建 Placement Group；
3. 用 `ray.remote` 创建 worker Actor；
4. 指定 PG 和 bundle index；
5. 等待就绪后运行 setup/train。

这把第 6、7 章组合起来：Actor 给进程常驻，PG 防止只启动部分 worker 后永久等待剩余资源。

## 9.7 Backend setup

PyTorch backend 的 [config.py](../python/ray/train/torch/config.py) 负责选择 Gloo/NCCL、建立 rendezvous 信息，并在 worker 上调用 `torch.distributed.init_process_group`。`prepare_model` 在
[train_loop_utils.py](../python/ray/train/torch/train_loop_utils.py) 中将模型放到设备并包装 DDP 等。

因此问题应分层诊断：

- Worker Actor 调度不起来：Ray resource/PG；
- Actor 已启动但 process group 卡住：网络、rank、backend、端口/NCCL；
- collective 正常但 loss 异常：用户训练代码/数据；
- report/checkpoint 卡住：Train session/controller/storage。

## 9.8 数据分片

传入 `datasets={"train": ds}` 后，Train 的 DataConfig/Datasets callback 将 Ray Data 与 worker rank 对齐。Worker 内调用：

```python
shard = train.get_dataset_shard("train")
for batch in shard.iter_torch_batches(batch_size=64):
    ...
```

Dataset shard 是流式 iterator，不应先在 Driver `ray.get` 全部数据再分给 worker。数据预处理、block 数和 worker 数会共同影响均衡：block 少于 worker 时，部分 worker 可能数据不足；shuffle、epoch 重读和 locality 也要单独设计。

## 9.9 `train.report` 与 checkpoint

训练函数不能通过普通 return 持续上报每轮状态，所以 Train 建立 session/context 通道：

```python
from ray import train
from ray.train import Checkpoint

for epoch in range(epochs):
    metrics = train_one_epoch()
    checkpoint = maybe_build_checkpoint()
    train.report(metrics, checkpoint=checkpoint)
```

Controller/CheckpointManager 聚合或选择 worker 报告，写入配置的 storage。Checkpoint 是故障恢复协议：只有代码在启动时调用 `train.get_checkpoint()` 并恢复模型、optimizer、epoch，保存文件才真正形成可恢复训练。

所有 worker 的 report 节奏通常需要一致。一个 worker 少 report 一次，协调层可能一直等待对应结果或产生不一致。

## 9.10 Train v1 的关键差异

v1 `DataParallelTrainer.training_loop` 使用 `BackendExecutor` 启动远程 actors，再由 `TrainingIterator` 驱动报告；而 `BaseTrainer.fit` 会把 Trainer 转成 Tune Trainable，并通过一个单 Trial 的 `Tuner` 执行，从而复用 Tune 的存储与恢复能力。

关键代码：

- [base_trainer.py](../python/ray/train/base_trainer.py)：`fit`, `as_trainable`, `_generate_trainable_cls`；
- [data_parallel_trainer.py](../python/ray/train/data_parallel_trainer.py)：`training_loop`；
- [backend_executor.py](../python/ray/train/_internal/backend_executor.py)；
- [worker_group.py](../python/ray/train/_internal/worker_group.py)。

看到调用栈进入 `Tuner` 不表示用户主动做了超参搜索；v1 Trainer 可能用一个 Tune Trial 承载一次训练。

## 9.11 Tune 的核心对象

- **Trainable**：一次 Trial 如何 setup、step、save、restore；可由函数或 class 表达。
- **Trial**：一组具体 config、状态、资源、checkpoint 和结果。
- **SearchAlgorithm**：根据历史结果建议新的 config，如随机/贝叶斯搜索。
- **TrialScheduler**：对已有 Trial 做 CONTINUE/PAUSE/STOP 决策，如 ASHA。
- **TuneController**：事件循环，协调 Trial actor、资源、结果和恢复。
- **Tuner/TunerInternal**：用户入口与配置适配。

Search Algorithm 回答“试什么”，Trial Scheduler 回答“已经在试的要不要继续”，两者不要混为一谈。

## 9.12 一个 Tune 例子

```python
import time
from ray import tune

def objective(config):
    score = 0.0
    for step in range(5):
        score += config["lr"]
        tune.report({"score": score, "step": step})
        time.sleep(0.05)

tuner = tune.Tuner(
    objective,
    param_space={"lr": tune.grid_search([0.01, 0.1, 1.0])},
    tune_config=tune.TuneConfig(metric="score", mode="max"),
    run_config=tune.RunConfig(stop={"training_iteration": 5}),
)
results = tuner.fit()
print(results.get_best_result().config)
```

每个 grid value 形成 Trial；function trainable 在独立 Ray 执行实体中运行；每次 `tune.report` 产生一个训练 iteration 结果并交给 Scheduler/Search/日志系统。

## 9.13 `Tuner.fit` 调用链

```text
Tuner.fit
  -> TunerInternal.fit
  -> _fit_internal
  -> tune.run(...)
  -> 创建 Experiment / SearchAlgorithm / TrialScheduler
  -> TuneController.step event loop
     - 请求 SearchAlgorithm 产生 Trial
     - 为可运行 Trial 申请 Placement Group / Actor
     - 调用 Trainable step / 接收 report
     - Scheduler: CONTINUE / PAUSE / STOP
     - checkpoint 与 experiment state
  -> ExperimentAnalysis
  -> ResultGrid
```

入口见 [tuner.py](../python/ray/tune/tuner.py)、[tuner_internal.py](../python/ray/tune/impl/tuner_internal.py)、
[tune_controller.py](../python/ray/tune/execution/tune_controller.py)。

## 9.14 Trial 资源

一个 Trial 可能只需要一个 CPU，也可能内部启动整个 Train worker group。Tune 用 `PlacementGroupFactory` 表达 Trial 的完整资源形状。并发 Trial 数由单 Trial resource shape、集群容量、`max_concurrent_trials` 和 Scheduler 状态共同决定。

例：集群 8 GPU，每个 Trial 是 `TorchTrainer(num_workers=4, use_gpu=True)`，最大同时完整运行通常是 2 Trial，而不是 8。

## 9.15 用 Tune 调 Train

概念示例：

```python
trainer = TorchTrainer(
    train_loop_per_worker=train_loop,
    train_loop_config={"lr": 1e-3},
    scaling_config=ScalingConfig(num_workers=2, use_gpu=True),
)

tuner = tune.Tuner(
    trainer,
    param_space={
        "train_loop_config": {
            "lr": tune.loguniform(1e-5, 1e-2),
        }
    },
    tune_config=tune.TuneConfig(num_samples=8, metric="loss", mode="min"),
)
results = tuner.fit()
```

每个 Trial 启动一个包含 2 GPU worker 的 Train run。总资源预算必须按 Trial × workers 计算。具体 Train v1/v2 支持的组合和参数结构应以当前官方文档为准。

## 9.16 Tune 恢复的安全与边界

`Tuner.restore(path, ...)` 恢复 experiment state、Trial 状态和 checkpoint。源码明确提醒：实验状态使用 pickle，从不可信路径恢复可能执行任意 Python 代码。

恢复不允许随意改变搜索空间；它要继续同一个实验。区分：

- resume unfinished；
- resume errored from checkpoint；
- restart errored from scratch；
- finished Trial 只加载结果，不重跑。

## 9.17 常见问题

1. Train worker 已分配 GPU，但每个进程都看见全部 GPU：检查 Ray resource 和 backend device setup。
2. 训练挂在 init process group：检查所有 rank 是否都已调度、网络/NCCL 和 PG。
3. Dataset 重复读取：检查 Trial 之间是否各自构建数据、是否适合物化共享。
4. Tune 并发低：按完整 Trial PG 看资源，不只看 Driver。
5. checkpoint 存了但不能恢复：训练函数没有读取并应用 checkpoint。
6. ASHA 太早停：metric、mode、time_attr、grace period 配置不匹配。
7. report 卡住：各 Train worker 报告次数不一致或某 worker 已失败。

## 9.18 自测题

1. Train worker 与 Tune Trial 的并行度有何区别？
2. WorkerGroup 为什么通常同时需要 Actor 和 Placement Group？
3. SearchAlgorithm 与 TrialScheduler 各做什么？
4. 为什么 Train v1 的 `fit` 可能出现在 Tune 调用栈里？
5. 保存 checkpoint 文件为何不等于实现了恢复？
6. 8 GPU 集群运行每 Trial 4 worker 的实验时，应如何估算并发？

