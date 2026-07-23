# 07. Ray Tune：超参数搜索与实验调度

## 1. Tune 解决什么问题

普通超参数搜索很快会遇到：配置生成、并发资源、指标收集、失败重试、检查点、提前停止和最佳结果选择。Tune 把一次配置运行封装为 Trial，并统一管理这些生命周期。

安装：

```bash
python -m pip install "ray[tune]"
```

Tune 不负责定义模型正确性。你的训练函数仍要能够：

- 接收配置；
- 逐步训练；
- 定期报告指标；
- 可选地保存检查点；
- 在独立进程中可序列化和重建。

## 2. 最小示例

```python
from ray import tune

def objective(config):
    score = 0.0
    for step in range(10):
        score = 1.0 - abs(config["x"] - 3.0) / (step + 1)
        tune.report({"score": score, "step": step})

tuner = tune.Tuner(
    objective,
    param_space={"x": tune.uniform(0.0, 6.0)},
    tune_config=tune.TuneConfig(
        metric="score",
        mode="max",
        num_samples=8,
    ),
)

results = tuner.fit()
best = results.get_best_result(metric="score", mode="max")
print(best.config, best.metrics)
```

可运行示例见 [`examples/tune_search.py`](examples/tune_search.py)。

## 3. 搜索空间

```python
param_space = {
    "lr": tune.loguniform(1e-5, 1e-1),
    "batch_size": tune.choice([32, 64, 128]),
    "dropout": tune.uniform(0.0, 0.5),
    "layers": tune.randint(2, 7),
}
```

常用分布：

- `choice`：离散候选；
- `uniform`：线性均匀；
- `loguniform`：跨数量级参数，如学习率；
- `randint`：整数范围；
- `sample_from`：依赖其他配置的自定义采样。

搜索空间应先包含真正影响结果且范围合理的少量参数。把几十个无关参数一起搜索会产生巨大的组合空间，也让结果更难解释。

## 4. `TuneConfig` 与 `RunConfig`

### 4.1 TuneConfig：搜索如何进行

```python
tune.TuneConfig(
    metric="val_loss",
    mode="min",
    num_samples=20,
    scheduler=scheduler,
    search_alg=search_alg,
    max_concurrent_trials=4,
)
```

### 4.2 RunConfig：一次实验如何运行和保存

```python
from ray import train

train.RunConfig(
    name="resnet-search",
    storage_path="s3://bucket/ray-results",
    stop={"training_iteration": 50},
    failure_config=train.FailureConfig(max_failures=2),
    checkpoint_config=train.CheckpointConfig(
        num_to_keep=2,
        checkpoint_score_attribute="val_loss",
        checkpoint_score_order="min",
    ),
)
```

当前公共 API 中 Tune 复用 `ray.train.RunConfig` 等配置对象；在部分代码中也可通过 `tune.RunConfig` 兼容导入。教程推荐从 `ray.train` 导入，以表达它是跨 Train/Tune 的运行配置。

## 5. 给每个 Trial 分配资源

普通函数默认资源可能不符合训练需求。使用 `tune.with_resources`：

```python
trainable = tune.with_resources(
    objective,
    resources={"cpu": 4, "gpu": 1},
)

tuner = tune.Tuner(trainable, param_space=param_space)
```

资源决定并发上限：

```text
并发 Trial 数 ≤ min(
  总 CPU / 每 Trial CPU,
  总 GPU / 每 Trial GPU,
  max_concurrent_trials,
  其他资源约束
)
```

不要为了提高并发把资源声明得低于真实使用。一个 `gpu=0` 的 Trial 仍自行使用 GPU，会导致多个进程无控制地争抢显存。

若 Train Trainer 作为 Trainable，资源由 `ScalingConfig` 形成 Placement Group，不再只看一个简单 `{cpu, gpu}` 字典。

## 6. 报告指标和训练步

```python
for epoch in range(epochs):
    train_one_epoch()
    val_loss = evaluate()
    tune.report({"val_loss": val_loss, "epoch": epoch})
```

Scheduler 只能在你报告时做决策。一次训练 5 小时、最后才报告一次，就无法有效提前停止。

指标应：

- 名称稳定；
- 类型可序列化；
- 不混用“越大越好”和“越小越好”；
- 在 Trial 之间含义一致；
- 需要时带 step/epoch，便于比较同等预算。

## 7. Scheduler 与 Search Algorithm 的区别

### 7.1 Trial Scheduler

Scheduler 管理正在运行的 Trial，决定继续、暂停、克隆或停止。ASHA 常用于提前停止：

```python
from ray.tune.schedulers import ASHAScheduler

scheduler = ASHAScheduler(
    metric="val_accuracy",
    mode="max",
    max_t=100,
    grace_period=5,
    reduction_factor=3,
)
```

- `grace_period` 太小可能在噪声阶段误杀；
- `max_t` 应与报告中的时间属性一致；
- Trial 必须多次报告才有意义。

### 7.2 Search Algorithm

Search Algorithm 决定接下来尝试什么参数，例如随机搜索、Bayesian Optimization、Optuna、HyperOpt。

```python
from ray.tune.search.optuna import OptunaSearch

search_alg = OptunaSearch(metric="val_loss", mode="min")
```

外部搜索算法通常需要单独安装依赖。对于初次实验，随机搜索 + ASHA 往往是清晰可靠的基线。

## 8. Checkpoint 与恢复

训练函数报告检查点：

```python
import tempfile
from ray import train

with tempfile.TemporaryDirectory() as checkpoint_dir:
    save_model(checkpoint_dir)
    checkpoint = train.Checkpoint.from_directory(checkpoint_dir)
    tune.report({"score": score}, checkpoint=checkpoint)
```

恢复 Tuner：

```python
if tune.Tuner.can_restore(experiment_path):
    tuner = tune.Tuner.restore(
        experiment_path,
        trainable=objective,
        resume_errored=True,
    )
else:
    tuner = tune.Tuner(objective, ...)
```

恢复实验状态与恢复 Trial 模型状态是两层概念。训练函数需要读取传入 Checkpoint 并恢复 optimizer/epoch 等，不能只依赖 Tune 重建 Trial 元数据。

## 9. 读取结果

```python
result_grid = tuner.fit()

best = result_grid.get_best_result(
    metric="val_accuracy",
    mode="max",
    scope="last",
)

print(best.config)
print(best.metrics)
print(best.path)
print(best.checkpoint)
```

结果可能包含失败 Trial。生产分析应记录：

- 搜索空间与随机种子；
- 代码/数据版本；
- Ray 和框架版本；
- 资源形状；
- Trial 失败原因；
- 指标选择规则；
- 最佳 Checkpoint 的持久位置。

不要只复制“最高分”而忽略试验预算、方差和数据泄漏。

## 10. Train + Tune

```python
from ray import tune
from ray.train import ScalingConfig
from ray.train.torch import TorchTrainer

trainer = TorchTrainer(
    train_func,
    train_loop_config={
        "lr": tune.loguniform(1e-5, 1e-2),
        "dropout": tune.uniform(0.0, 0.5),
    },
    scaling_config=ScalingConfig(
        num_workers=2,
        use_gpu=True,
    ),
)

tuner = tune.Tuner(
    trainer,
    tune_config=tune.TuneConfig(
        metric="val_loss",
        mode="min",
        num_samples=12,
    ),
)
results = tuner.fit()
```

这里的层次是：Tune 启动多个 Trial，每个 Trial 内部由 Train 启动多个 Worker。资源规划必须乘起来。

## 11. 常见错误

- 训练函数不调用 `report`，Scheduler 无法判断进度；
- 搜索空间过大，样本数却很小；
- 指标名与 `metric` 配置不一致；
- Trial 内部使用 GPU，却没有申请 GPU；
- 每个 Trial 都下载全量数据到同一路径，产生竞争；
- 把大型数据集捕获在闭包中，反复序列化；
- 保存 Checkpoint 到单节点本地盘；
- 失败后重新创建 Tuner，却以为会自动接着跑；
- 只报告最后指标，无法提前停止；
- 并发太高导致每个 Trial 数据加载/线程互相争抢。

## 12. 本章对应的项目代码

- 入门教程：[`../doc/source/tune/getting-started.rst`](../doc/source/tune/getting-started.rst)
- 教程实际代码：[`../python/ray/tune/tests/tutorial.py`](../python/ray/tune/tests/tutorial.py)
- Tuner：[`../python/ray/tune/tuner.py`](../python/ray/tune/tuner.py)
- 搜索空间：[`../python/ray/tune/search/sample.py`](../python/ray/tune/search/sample.py)
- Scheduler：[`../python/ray/tune/schedulers`](../python/ray/tune/schedulers)
- 资源指南：[`../doc/source/tune/tutorials/tune-resources.rst`](../doc/source/tune/tutorials/tune-resources.rst)

下一章把选出的模型部署为可扩缩在线服务。
