# 04. 对象、资源、运行环境与调度

Task 和 Actor 是“计算”，ObjectRef 是“数据依赖”，Resource 是“运行条件”，Runtime Environment 是“软件依赖”。真正把程序扩展到集群前，必须把这四部分分清。

## 1. 分布式对象存储

### 1.1 ObjectRef 的含义

```python
ref = task.remote(input_data)
```

`ref` 不是值本身，而是对未来对象的引用。它可以：

- 交给 `ray.get()` 解析；
- 直接作为下游 Task/Actor 参数；
- 放在 Python 容器中保存；
- 由 `ray.wait()` 检查就绪状态。

对象进入 Ray 对象存储后按不可变值处理。要“修改”对象，应产生一个新对象；可变共享状态使用 Actor 或外部存储。

### 1.2 `ray.put`

```python
lookup_ref = ray.put(large_lookup_table)
refs = [score.remote(batch, lookup_ref) for batch in batches]
```

适合让多个任务共享同一大型只读输入的引用。不要在循环里重复 `ray.put()` 同一对象，也不要对 Task 的返回值再做一次不必要的 `ray.put()`。

### 1.3 顶层引用与嵌套引用

当 ObjectRef 作为顶层参数传递时，Ray 会解析依赖后调用函数：

```python
upstream_ref = upstream.remote()
downstream_ref = downstream.remote(upstream_ref)
```

如果把引用藏在嵌套容器中，接收端可能得到引用本身而不是自动解析后的值。需要有意识地区分“按值传递”和“按引用传递”，并查看对应版本的对象传递文档。

### 1.4 生命周期与内存

只要集群中仍有引用，对象通常就不能回收。常见内存泄漏来源：

- Driver 列表无限保存 ObjectRef；
- Actor 字段长期保存旧引用；
- 待处理队列增长而没有背压；
- 大对象被重复复制或拉回 Driver；
- 下游太慢，导致中间对象堆积。

当对象存储压力高时，Ray 可以把对象 spill 到磁盘，但这会增加 I/O 和延迟，并不能替代容量规划。

诊断命令：

```bash
ray memory
```

## 2. 资源是逻辑调度配额

```python
@ray.remote(num_cpus=2, num_gpus=1)
def train_one_model(config):
    ...
```

调度器只在可用逻辑资源满足请求时启动工作。重要语义：

- `num_cpus=1` 不会把进程硬绑定到一个物理核心；
- Ray 不阻止任务内部启动额外线程；
- GPU 资源会影响 `CUDA_VISIBLE_DEVICES` 等可见设备设置；
- 声明资源主要用于准入、放置和并发控制；
- 资源容量在节点启动后不能随意动态修改。

Ray Task 默认请求 1 个逻辑 CPU。Actor 的历史默认 CPU 语义特殊，推荐始终显式配置 `num_cpus`。

## 3. CPU、GPU、内存和自定义资源

### 3.1 CPU

```python
@ray.remote(num_cpus=0.5)
def io_heavy_call(...):
    ...
```

分数 CPU 可提高 I/O 型任务并发。CPU 密集任务一般从 1 开始，根据内部线程数调整。

### 3.2 GPU

```python
@ray.remote(num_gpus=1)
def gpu_infer(batch):
    import torch
    assert torch.cuda.is_available()
    ...
```

分数 GPU 可让多个进程共享一块 GPU，但 Ray 不替你管理显存。只有模型小、框架支持且经过压力测试后才使用。

### 3.3 Memory

可以声明任务/Actor 的逻辑内存需求帮助调度，但这不是 cgroup 硬限制。对象存储内存与 Worker 堆内存也应分开观察。

### 3.4 自定义资源

节点启动时定义：

```bash
ray start --head --resources='{"special_hardware": 1}'
```

任务请求：

```python
@ray.remote(resources={"special_hardware": 1})
def use_device():
    ...
```

自定义资源适合表示许可证、特殊加速器或数量型能力。若只是节点标签和亲和性，查看 label-based scheduling。

## 4. 调度策略

默认调度器会考虑资源、数据局部性和负载。你也可以在 `.options()` 中指定策略，例如 Node Affinity 或 Placement Group Scheduling Strategy。

不要把节点 IP 硬编码为常规调度方式；节点可能被替换或扩缩。只有确实存在节点本地数据/设备约束时才使用强亲和性，并准备节点不可用时的策略。

## 5. Placement Group

Placement Group 把一组资源 bundle 作为整体预留，常用于需要多个 Worker 同时启动的训练或多组件应用。

```python
from ray.util.placement_group import placement_group

pg = placement_group(
    bundles=[{"CPU": 1, "GPU": 1}, {"CPU": 1, "GPU": 1}],
    strategy="PACK",
)
ray.get(pg.ready())
```

常见策略：

- `PACK`：尽量放在少量节点，减少跨节点通信；
- `SPREAD`：尽量分散，提高节点故障隔离；
- `STRICT_PACK`：所有 bundle 必须在同一节点；
- `STRICT_SPREAD`：每个 bundle 必须在不同节点。

Placement Group 是资源预留，不是进程组或通信库。Ray Train/Tune 通常会替你管理它；只有构建自定义 gang scheduling 时才直接使用。

一个常见“永远 pending”问题是请求的 bundle 形状无法装入任何节点。例如集群总共有 8 GPU，但每个节点只有 2 GPU，`STRICT_PACK` 请求 4 GPU 仍然无法调度。

## 6. Runtime Environment

多机环境中，“我的笔记本能 import”不代表 Worker 能 import。Runtime Environment 用来分发代码和声明依赖：

```python
import ray

ray.init(
    runtime_env={
        "working_dir": ".",
        "pip": ["requests==2.32.3"],
        "env_vars": {"APP_ENV": "demo"},
    }
)
```

主要字段：

- `working_dir`：上传工作目录；
- `py_modules`：上传指定 Python 模块；
- `pip`：创建基于基础环境的虚拟环境并安装包；
- `conda`：使用隔离 Conda 环境；
- `env_vars`：给 Worker 设置环境变量；
- `excludes`：排除不需上传的文件；
- `config`：控制超时、缓存/安装行为等。

`pip` 和 `conda` 不能在同一 Runtime Environment 中同时使用。大型二进制依赖每次动态安装会很慢，生产集群通常把稳定基础依赖预装在镜像，再用 Runtime Environment 分发应用层差异。

## 7. Runtime Environment 的作用域

### 7.1 Job/Driver 级

```python
ray.init(runtime_env={"pip": ["emoji"]})
```

这会应用于该 Driver 创建的子 Task 和 Actor，但不会 retroactively 改变 Driver 自己已经运行的 Python 环境。

### 7.2 Task/Actor 级

```python
ref = task.options(
    runtime_env={"env_vars": {"MODE": "special"}}
).remote()
```

细粒度环境灵活，但环境种类太多会增加安装、缓存和调度等待。尽量让同一应用使用少量可复用环境。

### 7.3 Ray Job 级

```bash
ray job submit \
  --address http://127.0.0.1:8265 \
  --working-dir . \
  --runtime-env-json='{"pip": ["requests==2.32.3"]}' \
  -- python app.py
```

这是远端生产提交的常见方式。

## 8. 代码和数据如何进入集群

需要分别规划：

| 内容 | 推荐方式 |
| --- | --- |
| Python 应用代码 | 容器镜像、`working_dir`、`py_modules` 或安装包 |
| Python 依赖 | 基础镜像 + Runtime Environment |
| 大型训练数据 | S3/GCS/Azure Blob/HDFS/NFS 等共享存储 |
| 模型检查点 | 所有 Worker 可访问的持久存储 |
| 密钥 | Kubernetes Secret、云 IAM、专用密钥系统 |
| 节点本地临时结果 | 仅作缓存，不能当唯一副本 |

不要把 TB 级数据放进 `working_dir` 上传。代码包应该小而稳定，数据通过专门存储读取。

## 9. Autoscaler 看的是资源请求

Ray Autoscaler主要根据逻辑资源需求和节点类型做决策，而不是看到 CPU 利用率高就自动扩容。若所有 Task 都声明 `num_cpus=0`，即使机器很忙，资源需求也可能无法正确驱动扩容。

因此，准确资源声明同时影响：

- 单节点并发；
- 节点选择；
- Placement Group 可调度性；
- Autoscaler 是否添加节点；
- 成本和利用率。

## 10. 常见故障与判断

### Task 长期 Pending

检查：

1. 请求资源是否大于任一节点容量；
2. 自定义资源名称是否拼错；
3. Placement Group 是否无法装箱；
4. Actor 是否长期占住资源；
5. Autoscaler 是否有可用节点类型和配额。

### Worker ImportError

检查代码是否上传、依赖是否在 Worker 环境、包版本是否一致、Runtime Environment 安装是否失败。

### Object Store Full

检查 ObjectRef 是否被长期持有、下游是否慢、是否一次提交过多、对象是否太大、spill 磁盘是否足够。

### GPU OOM

资源调度成功只表示获得逻辑 GPU，不表示模型一定放得下。减少 batch、降低并发、避免分数 GPU 或采用模型并行。

## 11. 本章对应的项目代码

- 对象 API 与序列化：[`../doc/source/ray-core/objects.rst`](../doc/source/ray-core/objects.rst)
- 资源语义：[`../doc/source/ray-core/scheduling/resources.rst`](../doc/source/ray-core/scheduling/resources.rst)
- Placement Group：[`../doc/source/ray-core/scheduling/placement-group.rst`](../doc/source/ray-core/scheduling/placement-group.rst)
- Runtime Environment：[`../doc/source/ray-core/handling-dependencies.rst`](../doc/source/ray-core/handling-dependencies.rst)
- 调度实现入口：[`../python/ray/util/scheduling_strategies.py`](../python/ray/util/scheduling_strategies.py)

接下来进入上层库，先从贯穿离线 AI 流水线的 Ray Data 开始。
