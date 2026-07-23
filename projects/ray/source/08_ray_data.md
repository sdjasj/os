# 8. Ray Data 数据流水线

## 8.1 Ray Data 解决什么问题

Ray Core 给出 Task、Actor、ObjectRef，但没有替你决定：数据如何切 block、算子如何形成 DAG、何时启动任务、如何在内存限制下保持流水。Ray Data 在 Core 上增加这些数据系统能力。

```python
import ray

ds = ray.data.range(1000, override_num_blocks=10)
result = (
    ds.map_batches(lambda b: {"id": b["id"] * 2})
      .filter(lambda row: row["id"] % 3 == 0)
)

print(result.take(5))
```

`map_batches` 和 `filter` 主要构建计划；`take` 是消费操作，触发执行。

## 8.2 三个核心数据单位

### Row/Batch

这是 UDF 看见的数据。Batch 可表现为 `Dict[str, np.ndarray]`、Pandas DataFrame、PyArrow Table 等。

### Block

Block 是 Ray Data 的存储和并行基本单位。一个 block 通常包含多行，常驻对象存储，由 `ObjectRef[Block]` 指代。Block 太小会产生过多 Task 和元数据开销，太大会降低并行度并加剧内存峰值。

### RefBundle

执行器不仅要传 block ref，还需要 metadata、ownership、schema 等，因此用 `RefBundle` 在 operator 间传一组 block 与元数据。定义见
[python/ray/data/_internal/execution/interfaces/ref_bundle.py](../python/ray/data/_internal/execution/interfaces/ref_bundle.py)。

Dataset 类自身的 docstring 已明确：Dataset 是产生 `ObjectRef[Block]` 的分布式 pipeline，见
[dataset.py](../python/ray/data/dataset.py) 的 `Dataset`。

## 8.3 读数据如何变成逻辑计划

公共读取 API 位于 [read_api.py](../python/ray/data/read_api.py)：`range`、`read_parquet`、`read_csv` 等最终建立 Read 逻辑 operator 和 `LogicalPlan`，并返回 Dataset。

Datasource 的职责不是亲自把全部数据读进 Driver，而是生成可并行执行的 `ReadTask`：每个 ReadTask 描述如何读取一个分片及其 metadata。文件列表、分区过滤、并行度估计等会在计划或 datasource 层完成。

```text
read_parquet(paths)
  -> 解析 datasource/reader 参数
  -> 创建并行 ReadTask 或读取逻辑信息
  -> LogicalPlan(Read(...))
  -> Dataset（尚未完整读取数据）
```

Datasource 接口位于 [python/ray/data/datasource](../python/ray/data/datasource)。学习一个数据源时先找 `Datasource` 如何生成 read tasks，再看 block conversion。

## 8.4 Transformation 是不可变的计划扩展

```python
ds2 = ds.map_batches(fn)
```

它不会原地修改 `ds`。`Dataset.map_batches`：

1. 校验 UDF、batch format、资源和 compute strategy；
2. 判断 UDF 是函数还是 callable class；
3. 创建 `MapBatches` 逻辑 operator，父节点是原 Dataset 的 DAG；
4. 构建新的 `LogicalPlan` 和 Dataset。

因此可以从同一个 `ds` 分出两条支路。不可变计划使优化与复用更容易推理，但真正执行两条支路时是否共享物化结果，要看是否显式 materialize/缓存，而不是只看 Python 变量共享。

## 8.5 函数 UDF 与 callable class

```python
# 无状态：底层用 Ray Tasks
ds.map_batches(fn, compute=ray.data.TaskPoolStrategy(size=8))

# 有状态/模型常驻：底层用 Actor pool
class Predictor:
    def __init__(self):
        self.model = load_model()

    def __call__(self, batch):
        return self.model(batch)

ds.map_batches(
    Predictor,
    compute=ray.data.ActorPoolStrategy(min_size=2, max_size=8),
    num_gpus=1,
    batch_size=64,
)
```

这直接复用第 4、6 章：函数 UDF 走普通 Task；callable class 在 Actor 中只加载一次模型。Actor pool 还要处理启动成本、autoscaling、Actor ready 与 task queue。

物理 operator 位于：

- [map_operator.py](../python/ray/data/_internal/execution/operators/map_operator.py)：共同 MapOperator；
- `task_pool_map_operator.py`：Task pool；
- `actor_pool_map_operator.py`：Actor pool。

## 8.6 Logical Plan 到 Physical Plan

入口是 [logical/optimizers.py](../python/ray/data/_internal/logical/optimizers.py) 的 `get_execution_plan`：

```text
LogicalPlan
  -> LogicalOptimizer.optimize
  -> Planner.plan
  -> PhysicalOptimizer.optimize
  -> PhysicalPlan
```

- **逻辑优化**关注不依赖执行实现的等价变换，例如 pushdown、表达式/算子重写；
- **Planner** 把 Read/Map/Shuffle 等逻辑节点翻译成 physical operator；
- **物理优化**可做 operator fusion、选择执行细节等。

`LogicalPlan` 和 `PhysicalPlan` 都包装 DAG，但节点类型不同，见
[logical/interfaces](../python/ray/data/_internal/logical/interfaces)。

不要把 Python 链式调用顺序直接等同于最终 Task 边界。优化器可能融合多个 map-style transformation，减少 block materialization 与 Task 开销。

## 8.7 消费操作触发执行

常见触发器：

- `take`, `take_all`, `show`；
- `iter_batches`, `iter_torch_batches`；
- `materialize`；
- aggregation；
- `write_*`。

Dataset 的 `_execute_to_iterator`/`_execute` 获取优化后的 physical plan，创建 `StreamingExecutor` 并返回输出 iterator。`materialize` 会执行全图，把结果 block 固定为 `MaterializedDataset` 的 input data。

```python
lazy = ray.data.range(100).map_batches(fn)
cached = lazy.materialize()

# cached 后续消费从已物化 block 开始，不重跑前面的逻辑流水。
print(cached.count())
```

物化能避免重算，但会长期占对象存储；是否值得取决于重用次数、成本和内存。

## 8.8 StreamingExecutor 控制循环

[streaming_executor.py](../python/ray/data/_internal/execution/streaming_executor.py) 的类注释给出核心设计：建立 operator topology，在资源限制下路由 block，最大化吞吐。

`execute` 主要初始化：

- physical topology 与每个 operator 的 `OpState`；
- `ResourceManager`；
- backpressure policies；
- cluster/actor autoscaler；
- progress/metrics；
- output node；
- 独立 control thread。

控制循环的抽象伪代码：

```text
while output not finished:
    处理已完成的 Ray tasks/actor calls
    将输出 RefBundle 推给下游 operator
    更新资源、内存、进度和 backpressure 状态
    选择当前可运行的 operator
    提交新的 task 或 actor call
    若无事可做，等待下一次完成/资源事件
```

它会用 `ray.wait` 等机制感知异步完成，而不是每提交一个 block 就 `ray.get`。控制循环放在独立线程，避免用户 iterator 暂停消费时完全卡住状态处理；输出背压仍会防止无限生产。

## 8.9 Operator topology 与资源管理

每个 physical operator 描述：

- 输入依赖与内部队列；
- 当前 active tasks；
- 增量资源使用；
- 是否能接收更多输入/产生更多输出；
- completion 条件；
- metrics。

`ResourceManager` 不只是数集群 CPU；它还估计 operator 内存、object store、downstream queues 和 execution options。Data 在 Core 资源准入之上增加 pipeline 级调度，否则每个 operator 都尽量占满集群会使上游淹没下游。

## 8.10 背压与内存

一个典型流水：

```text
Read(快) -> Decode(快) -> GPU inference(慢) -> Write(中等)
```

如果只按“资源空闲就提交”，CPU Read/Decode 会快速堆积大量 GPU 待处理 block。Ray Data 的 backpressure policy 和 operator queue 限制在途输出，StreamingExecutor 根据 topology 决定何时暂停上游。

用户仍需控制：

- `override_num_blocks` 与输入 block 大小；
- `batch_size`；
- TaskPool/ActorPool 并发；
- 每个 map worker 的 CPU/GPU/heap memory；
- UDF 输出大小；
- 消费速度；
- 是否 materialize。

## 8.11 Batch、Block 与 Task 的关系

`batch_size=128` 不表示“一个 block 恰好 128 行”或“一个 Task 恰好只调用一次 UDF”。执行器可以把小 block bundle 到一个 map task；一个 block 也可以被切成多个 batch 交给 UDF。输出又会由 block builder 按目标大小组织。

调优时分清：

- Block size：对象存储和 Task 数据交换粒度；
- Batch size：一次 UDF/模型调用粒度；
- Actor/Task concurrency：并行 worker 数；
- Pipeline in-flight：各 operator 同时积压的数据。

## 8.12 Zero-copy batch

`map_batches(..., zero_copy_batch=True)` 允许在格式相容时给 UDF 只读的零拷贝 view：

```python
def transform(batch):
    # 创建新列/新 buffer；不要原地改只读底层内存。
    return {"id": batch["id"], "score": batch["id"] * 2}
```

如果 UDF 原地修改，可能遇到只读错误或破坏共享假设。可只复制需要改的列；`zero_copy_batch=False` 会复制整批，简单但增加内存/CPU 成本。

## 8.13 Shuffle 与 all-to-all

Sort、groupby、repartition、random shuffle、join 往往需要 all-to-all：map 端按 partition 分片，reduce 端收集来自多个上游的分区。与一对一 map 不同，它带来：

- 网络全交换；
- 中间 block 数量增长；
- barrier/分区元数据；
- skew；
- 更高 spill 风险。

相关物理 operator 和 planner 位于
[python/ray/data/_internal/execution/operators](../python/ray/data/_internal/execution/operators) 与
[python/ray/data/_internal/planner](../python/ray/data/_internal/planner)。读 shuffle 时先画 map-output partition 到 reduce-input partition 的二维矩阵。

## 8.14 一个批推理案例

```python
import numpy as np
import ray

class Predictor:
    def __init__(self):
        # 实际项目在这里加载模型到 GPU。
        self.weight = 2

    def __call__(self, batch):
        return {"id": batch["id"], "prediction": batch["id"] * self.weight}

predictions = (
    ray.data.range(10_000, override_num_blocks=100)
    .map_batches(
        Predictor,
        compute=ray.data.ActorPoolStrategy(min_size=1, max_size=4),
        batch_size=256,
        num_cpus=1,
    )
)

for batch in predictions.iter_batches(batch_size=512):
    consume(batch)
```

从源码角度解释：Range 是 Read 逻辑节点；MapBatches 使用 ActorPoolMapOperator；Actor 是 Core Actor；输入/output block 是 ObjectRef；iter_batches 拉动流式输出并提供消费侧背压。

## 8.15 调试与测试

- `ds.explain()`/执行计划输出：看逻辑和物理算子是否按预期融合；
- `ds.stats()`：看各 operator 时间、block、吞吐；
- Dashboard：看 Task/Actor 和 object store；
- Data 日志：StreamingExecutor 会打印执行计划和进度；
- [test_map.py](../python/ray/data/tests/test_map.py)：函数/class UDF、并发、故障、序列化；
- [test_backpressure_e2e.py](../python/ray/data/tests/test_backpressure_e2e.py)：端到端背压；
- operator 单测：`python/ray/data/tests/` 中按 operator 搜索。

## 8.16 自测题

1. Dataset、Block、Batch、RefBundle 分别在哪一层？
2. 为什么链式 `map_batches` 不一定对应多个物理 Task stage？
3. callable class 为什么适合模型推理？
4. `batch_size` 与 block size 为什么不能混为一谈？
5. StreamingExecutor 为什么还需要在 Core Scheduler 之上调度？
6. materialize 如何在避免重算和占用对象存储之间取舍？

