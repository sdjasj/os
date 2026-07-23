# 06. Ray Train：分布式训练

## 1. Train 管理什么

Ray Train 的目标不是替换 PyTorch、JAX、Transformers 等训练框架，而是管理分布式运行：

- 申请一组 CPU/GPU Worker；
- 初始化框架的分布式通信；
- 在每个 Worker 上执行同一训练函数；
- 分片 Ray Data 数据集；
- 聚合指标、报告进度；
- 保存、恢复和传播 Checkpoint；
- 与 Ray Tune 和集群存储集成。

安装基础 Train 依赖及所用框架：

```bash
python -m pip install "ray[train]" torch
```

## 2. 最小心智模型

```text
Driver
  └─ TorchTrainer.fit()
       ├─ Worker 0: train_func()  ─┐
       ├─ Worker 1: train_func()   ├─ distributed process group
       ├─ Worker 2: train_func()   │
       └─ Worker 3: train_func()  ─┘
```

训练函数在每个 Worker 中各执行一次。函数里的普通局部变量不是全局共享状态；模型参数同步由 DDP/FSDP 等框架机制完成。

## 3. 最小 TorchTrainer

```python
import ray
from ray import train
from ray.train import ScalingConfig
from ray.train.torch import TorchTrainer

def train_func():
    # 每个 Worker 都执行这里。
    model = build_model()
    model = train.torch.prepare_model(model)
    optimizer = build_optimizer(model)

    for epoch in range(5):
        loss = train_one_epoch(model, optimizer)
        train.report({"loss": loss, "epoch": epoch})

trainer = TorchTrainer(
    train_func,
    scaling_config=ScalingConfig(num_workers=2, use_gpu=True),
)

result = trainer.fit()
print(result.metrics)
```

完整的可改造骨架见 [`examples/train_torch.py`](examples/train_torch.py)。它依赖 `torch` 和 `ray[train]`。

## 4. 把单机 PyTorch 改为分布式

### 4.1 包装模型

```python
model = train.torch.prepare_model(model)
```

这个辅助函数把模型移动到正确设备，并在需要时包装 DistributedDataParallel。不要先硬编码 `cuda:0`；每个 Worker 看到的设备映射由 Ray 管理。

### 4.2 包装 DataLoader

```python
loader = torch.utils.data.DataLoader(
    dataset,
    batch_size=64,
    shuffle=True,
)
loader = train.torch.prepare_data_loader(loader)
```

辅助函数会配置分布式采样和设备移动。每个 Worker 的 `batch_size=64` 是本地 batch size；若有 4 Worker，全局 batch size 通常是 256。

每个 epoch 更新 sampler：

```python
if train.get_context().get_world_size() > 1:
    loader.sampler.set_epoch(epoch)
```

若使用 Ray Data 提供数据，不需要再让普通 DataLoader 自己对全量数据做重复分片。

### 4.3 报告指标

```python
train.report({"loss": float(loss), "epoch": epoch})
```

所有 Worker 应以一致节奏调用 `train.report`。通常只让 rank 0 写检查点或外部副作用，避免多 Worker 覆盖同一路径：

```python
context = train.get_context()
if context.get_world_rank() == 0:
    ...
```

## 5. Checkpoint

```python
import os
import tempfile
import torch
from ray import train

with tempfile.TemporaryDirectory() as checkpoint_dir:
    torch.save(model.module.state_dict(), os.path.join(checkpoint_dir, "model.pt"))
    checkpoint = train.Checkpoint.from_directory(checkpoint_dir)
    train.report({"loss": loss}, checkpoint=checkpoint)
```

注意模型可能被 DDP 包装，示例中的 `model.module` 取决于具体包装状态；生产代码可使用框架辅助 API 或统一的 unwrapped model 逻辑。

多节点生产训练应在 `RunConfig` 中配置所有节点可访问的持久存储：

```python
trainer = TorchTrainer(
    train_func,
    scaling_config=scaling_config,
    run_config=train.RunConfig(storage_path="s3://bucket/ray-results"),
)
```

不要把节点本地 `/tmp` 当作最终检查点位置。`TemporaryDirectory` 只是用于构造一次报告的本地内容，最终应由 Train 持久化到配置存储。

## 6. 使用 Ray Data 供数

Driver：

```python
train_ds = ray.data.read_parquet("s3://bucket/train/")
valid_ds = ray.data.read_parquet("s3://bucket/valid/")

trainer = TorchTrainer(
    train_func,
    scaling_config=ScalingConfig(num_workers=4, use_gpu=True),
    datasets={"train": train_ds, "validation": valid_ds},
)
```

Worker 训练函数：

```python
def train_func():
    train_shard = train.get_dataset_shard("train")
    for batch in train_shard.iter_torch_batches(batch_size=64):
        ...
```

每个 Worker 获得不同数据分片，读取和训练可流水重叠。验证集是否分片、每个 Worker 是否都评估，需要根据统计方式设计；全局指标要正确聚合，不能直接把一个 Worker 的局部均值当全局均值。

## 7. ScalingConfig

```python
scaling_config = ScalingConfig(
    num_workers=4,
    use_gpu=True,
    resources_per_worker={"CPU": 4, "GPU": 1},
)
```

关键问题：

- `num_workers` 是否小于或等于可调度 GPU 数；
- 每 Worker CPU 是否足以供数据加载、增强和框架线程；
- Worker 资源 bundle 能否装入单个节点；
- Head 是否应保留 CPU 运行控制面；
- 网络是否能承载梯度同步；
- 全局 batch size 和学习率是否随 Worker 数调整。

增加 Worker 不保证线性加速。模型太小、batch 太小、通信量大或数据供给慢时，扩容可能更慢。

## 8. 训练上下文

```python
context = train.get_context()

world_size = context.get_world_size()
world_rank = context.get_world_rank()
local_rank = context.get_local_rank()
node_rank = context.get_node_rank()
```

- `world_rank`：全体 Worker 中的序号；
- `local_rank`：当前节点内的序号，框架常用来绑定设备；
- `world_size`：Worker 总数；
- `node_rank`：节点序号。

优先使用 Train/框架辅助函数，不要自己从环境变量猜 GPU 设备。

## 9. 与 Tune 组合

Train 负责一次分布式训练，Tune 负责多组配置：

```python
from ray import tune

trainer = TorchTrainer(
    train_func,
    train_loop_config={
        "lr": tune.loguniform(1e-5, 1e-2),
        "batch_size": tune.choice([32, 64, 128]),
    },
    scaling_config=ScalingConfig(num_workers=2, use_gpu=True),
)

tuner = tune.Tuner(
    trainer,
    tune_config=tune.TuneConfig(num_samples=8),
)
results = tuner.fit()
```

这里每个 Trial 都会申请一整组 Train Worker。若集群有 8 GPU、每个 Trial 需要 2 GPU，理论上最多并发 4 个，还要考虑 Driver/额外资源和 Placement Group。

## 10. 容错的正确理解

分布式训练故障来源包括 Worker 进程、节点、网络、数据读取和用户代码异常。恢复依赖：

- 训练循环定期报告 Checkpoint；
- Checkpoint 位于可靠共享存储；
- 输入可重新读取；
- 外部副作用幂等；
- `RunConfig`/Trainer 的失败配置允许重试；
- 集群有替换 Worker 的容量。

没有检查点时，重启通常只能从头训练。检查点频率太低会丢大量进度，太高会拖慢训练；按恢复时间目标和写入成本选择。

## 11. 常见错误

- `num_workers=4, use_gpu=True`，但集群只有 2 GPU；
- 每个 Worker 都下载同一份数据到节点本地盘；
- 每个 Worker 都向同一文件写 Checkpoint；
- 忘记 `prepare_model`，实际没有 DDP 同步；
- 把每 Worker batch size 当成全局 batch size；
- 在训练函数外创建 GPU 模型并通过闭包序列化；
- 只增加 GPU，不检查数据加载和梯度通信；
- 在多节点使用仅 Head 可见的本地输出路径。

## 12. 何时不使用 Train

- 只需单机单进程且已足够快；
- 框架原生启动器已经完全满足需求，且不需要 Ray Data/Tune/集群集成；
- 训练不是 Python 入口，无法适配 Worker 模型；
- 目标是在线推理，应该使用 Serve；
- 目标是搜索参数，Train 可作为单 Trial，但仍需 Tune。

## 13. 本章对应的项目代码

- PyTorch 入门：[`../doc/source/train/getting-started-pytorch.rst`](../doc/source/train/getting-started-pytorch.rst)
- TorchTrainer：[`../python/ray/train/torch/torch_trainer.py`](../python/ray/train/torch/torch_trainer.py)
- ScalingConfig：[`../python/ray/air/config.py`](../python/ray/air/config.py)（当前分支还包含 Train v2 配置实现）
- 数据供给：[`../doc/source/train/user-guides/data-loading-preprocessing.rst`](../doc/source/train/user-guides/data-loading-preprocessing.rst)
- 检查点：[`../doc/source/train/user-guides/checkpoints.rst`](../doc/source/train/user-guides/checkpoints.rst)

> 若某个链接在未来分支改名，可在 `python/ray/train` 或 `doc/source/train` 中搜索类名。当前开发分支的组织可能继续演进。

下一章使用 Ray Tune 同时运行多组训练配置，并用 Scheduler 提前停止差试验。
