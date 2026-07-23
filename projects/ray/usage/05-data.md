# 05. Ray Data：数据处理与批量推理

## 1. Ray Data 解决什么问题

Ray Data 用统一的 `Dataset` API 处理超出单机内存或需要多核、多机、CPU/GPU 混合执行的数据。典型工作是：

- 从文件、对象存储、数据库或 Python 对象读取数据；
- 对记录或批次做转换、过滤、聚合和重分区；
- 用 CPU 做解码/预处理，再用 GPU 做批量推理；
- 把数据分片流式送给 Ray Train Worker；
- 把结果写回 Parquet、CSV、数据库或对象存储。

安装：

```bash
python -m pip install "ray[data]"
```

## 2. 核心抽象：Dataset、Block 和算子

`Dataset` 是分布式数据集合的逻辑描述。数据底层按多个 Block 切分，算子作用于记录或批次，执行器把 Block 分配给 Task/Actor。

```python
import ray

ray.init()

ds = ray.data.range(10)
transformed = (
    ds
    .filter(lambda row: row["id"] % 2 == 0)
    .map(lambda row: {"id": row["id"], "square": row["id"] ** 2})
)

print(transformed.take_all())
```

大多数转换是惰性的：构建 `transformed` 主要是在描述执行计划，`take_all()`、`materialize()`、`iter_batches()` 或 `write_*()` 等消费操作才触发执行。

完整本地示例见 [`examples/data_pipeline.py`](examples/data_pipeline.py)。

## 3. 读取数据

### 3.1 文件和对象存储

```python
ds = ray.data.read_parquet("s3://bucket/events/")
ds = ray.data.read_csv(["part-000.csv", "part-001.csv"])
ds = ray.data.read_json("gs://bucket/logs/")
```

Ray Data 会根据文件和数据源生成读取 Task。为了并行读取，输入应包含足够多、大小适中的文件或可切分数据块。一个超大压缩文件可能限制并行度；数百万个极小文件又会增加元数据开销。

### 3.2 Python 对象

```python
ds = ray.data.from_items([
    {"user_id": 1, "score": 0.8},
    {"user_id": 2, "score": 0.4},
])
```

适合测试和小规模输入。不要先把 TB 级数据读进 Driver 的 Python 列表，再调用 `from_items`；应让分布式读取器直接读取数据源。

### 3.3 读取并行度

当前 API 常通过 `override_num_blocks` 控制初始 Block 数量：

```python
ds = ray.data.read_parquet(
    "s3://bucket/events/",
    override_num_blocks=200,
)
```

Block 太少会限制并行，太多会增加调度开销。观察每个算子的任务数量、Block 大小、对象存储压力和下游吞吐，再调整。

## 4. 转换：逐行还是按批次

### 4.1 `map`

```python
ds = ds.map(lambda row: {**row, "valid": row["score"] >= 0})
```

简单直观，但逐行 Python 调用对数值密集处理开销较高。

### 4.2 `map_batches`

```python
from typing import Dict
import numpy as np

def add_feature(batch: Dict[str, np.ndarray]) -> Dict[str, np.ndarray]:
    batch["score2"] = batch["score"] ** 2
    return batch

ds = ds.map_batches(
    add_feature,
    batch_format="numpy",
    batch_size=1024,
)
```

`map_batches` 让 UDF 一次处理一批数据，更适合 NumPy、Pandas、PyArrow 和深度学习框架。常用 `batch_format`：

- `"numpy"`：字典列到 NumPy 数组；
- `"pandas"`：Pandas DataFrame；
- `"pyarrow"`：Arrow Table。

批大小是性能参数，不等于最终 Block 大小，也不应假设每一批永远精确等长，尤其是最后一批。

### 4.3 常见关系算子

```python
filtered = ds.filter(lambda row: row["score"] > 0.5)
grouped = ds.groupby("category").mean("score")
sorted_ds = ds.sort("timestamp")
repartitioned = ds.repartition(100)
```

`groupby`、全局 `sort`、某些 `repartition` 会触发 shuffle，带来网络、磁盘和对象存储成本。不要把它们当作免费的本地 DataFrame 操作。

## 5. 有状态批量推理

模型加载应使用 callable class，让每个 Actor 只初始化一次：

```python
import ray

class Predictor:
    def __init__(self):
        self.model = load_model()

    def __call__(self, batch):
        batch["prediction"] = self.model.predict(batch["features"])
        return batch

predictions = ds.map_batches(
    Predictor,
    batch_format="numpy",
    batch_size=256,
    compute=ray.data.ActorPoolStrategy(size=4),
    num_cpus=1,
)
```

GPU 推理：

```python
predictions = ds.map_batches(
    GpuPredictor,
    batch_size=128,
    compute=ray.data.ActorPoolStrategy(size=2),
    num_gpus=1,
)
```

这会创建两个 Actor，每个声明 1 GPU。若只有一块 GPU，固定大小 2 将无法同时调度。Actor 池大小、每 Actor GPU 数量、模型显存和 batch 大小必须一起规划。

当前版本也支持通过 `concurrency` 等参数配置 UDF 并发，具体形式随 UDF 类型和版本变化。教程示例使用仓库文档仍公开展示的 `ActorPoolStrategy`，升级时应核对安装版本签名。

## 6. 惰性、流式与 `materialize`

```python
result = ds.map_batches(step1).map_batches(step2)
```

Ray Data 的流式执行器可以让上游输出 Block 被下游逐步消费，避免所有中间数据同时物化。显式调用：

```python
materialized = result.materialize()
```

会执行全部惰性转换并把结果物化在对象存储中。适合：

- 同一结果会重复消费；
- 需要精确测量前置阶段；
- 需要在调试时固定一个中间边界。

不适合：

- 中间结果远大于对象存储；
- 只消费一次；
- 希望生产者和消费者流水重叠。

## 7. 消费数据

### 7.1 预览

```python
ds.show(limit=5)
rows = ds.take(5)
batch = ds.take_batch(batch_size=32)
```

只用于查看小样本。`take_all()` 会把所有数据拉到 Driver，不适合大数据集。

### 7.2 流式迭代

```python
for batch in ds.iter_batches(
    batch_size=1024,
    batch_format="numpy",
):
    consume(batch)
```

Driver 消费速度太慢仍会形成背压。若 `consume` 本身可分布式，考虑把它变成 Dataset 算子或直接写入目标存储，而不是集中到 Driver。

### 7.3 写出

```python
ds.write_parquet("s3://bucket/output/run-001/")
ds.write_csv("/shared/output/")
```

写出通常产生多个 part 文件。输出目录应使用唯一运行 ID，并通过下游表格式/目录提交机制管理原子可见性，不要让多个作业无协调地覆盖同一目录。

## 8. Data 与 Train 结合

```python
train_ds = ray.data.read_parquet("s3://bucket/train/")
train_ds = train_ds.map_batches(preprocess)

trainer = TorchTrainer(
    train_func,
    scaling_config=ScalingConfig(num_workers=4, use_gpu=True),
    datasets={"train": train_ds},
)
result = trainer.fit()
```

Train 会把 Dataset 分片给 Worker。训练函数里获取本 Worker 的分片：

```python
from ray import train

shard = train.get_dataset_shard("train")
for batch in shard.iter_torch_batches(batch_size=64):
    ...
```

这样避免每个 Worker 重复读取全量数据。全局 batch size 通常是每 Worker batch size 乘 Worker 数量，还要考虑梯度累积。

## 9. 性能调优顺序

1. **确认瓶颈**：读取、CPU UDF、GPU、shuffle、写出还是 Driver 消费。
2. **看并行度**：Block 是否足够，资源是否让算子跑满。
3. **用批处理**：将逐行 Python UDF 改为向量化 `map_batches`。
4. **调 batch size**：过小调度/调用多，过大占内存/显存。
5. **复用模型**：使用 callable class/Actor pool。
6. **减少物化**：保留流式流水线，避免中间 `take_all`。
7. **控制 shuffle**：先过滤、投影，减少进入 shuffle 的数据量。
8. **检查文件布局**：读取和写出文件数量是否合理。

不要只看 CPU 利用率。一个数据作业可能因为对象存储、网络、远端存储限速或串行 UDF 而慢。

## 10. 常见错误

- 在 Driver 先读全量数据，再 `from_items`；
- `map` UDF 捕获一个巨大模型，每个 Task 重复序列化；
- GPU callable class 却未声明 `num_gpus`；
- 把 `materialize()` 当作每一步的固定写法；
- 用 `take_all()` 收集大数据集；
- 默认认为输出顺序稳定；
- 依赖节点本地路径，在多机上找不到文件；
- Block 太少导致大集群闲置，或 Block 太多导致调度开销过大。

## 11. 本章对应的项目代码

- 快速入门：[`../doc/source/data/quickstart.rst`](../doc/source/data/quickstart.rst)
- Dataset API：[`../python/ray/data/dataset.py`](../python/ray/data/dataset.py)
- 读写入口：[`../python/ray/data/read_api.py`](../python/ray/data/read_api.py)
- 数据转换：[`../doc/source/data/transforming-data.rst`](../doc/source/data/transforming-data.rst)
- 批量推理：[`../doc/source/data/batch_inference.rst`](../doc/source/data/batch_inference.rst)
- 性能建议：[`../doc/source/data/performance-tips.rst`](../doc/source/data/performance-tips.rst)

下一章把数据分片送入 Ray Train，完成多 Worker 训练。
