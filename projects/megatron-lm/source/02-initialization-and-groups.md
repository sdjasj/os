# 02. 初始化与进程组：把 world 切成可用拓扑

参数校验回答“配置是否合法”，初始化则把它物化成 CUDA device、PyTorch 默认 group、TP/PP/DP/CP/EP 子组、随机数流和全局服务。此阶段任何 rank 分歧都可能让后续 collective 永久等待。

## `initialize_megatron()` 的职责

可把初始化分为：

1. 建立/确认 `torch.distributed`；
2. 选择本地 CUDA device；
3. 调用 `initialize_model_parallel()` 创建子组；
4. 初始化随机种子与 model-parallel RNG tracker；
5. 建立 tokenizer、tensorboard、timers 等全局对象；
6. 配置 fused/JIT/批次不变性等运行选项。

初始化不是模型构造；模型要等 process groups 可用后，才能把正确 group 传给 TP、CP、EP 模块。

## 默认 group 与模型并行 group

默认 world group 包含所有进程，用于最基础全局协调。模型实际计算应尽量使用更小、更精确的 group：

```text
world
  ├─ TP groups
  ├─ PP groups
  ├─ CP groups
  ├─ DP / DP×CP groups
  ├─ EP / expert-DP groups
  └─ embedding / position-embedding groups
```

Embedding group 是 PP 的特殊非连续组：若输入 embedding 与输出权重共享，首尾 stage 需要同步相同参数。

## Group 创建必须全局一致

PyTorch 要求所有进程以一致顺序调用 group creation，即使某进程最终不属于该 group。`parallel_state.py` 集中构造 group，就是为了维护这项全局顺序。

不要在任意 layer 构造函数里按本地条件随意 `new_group()`；不同 rank 分支稍有不同就会产生错配。

## Rank generator 的坐标思想

初始化根据维度大小与顺序把全局 rank 映射成多维坐标，再枚举固定某些坐标的 rank 列表。读代码时重点不是背枚举顺序，而是回答：

```text
这个 group 改变哪些坐标？固定哪些坐标？
```

例如 TP group 改变 TP 坐标，固定 PP/DP/CP；DP group 则反之。

## `ProcessGroupCollection` 的物化

训练搭好全局 MPU group 后，可用兼容入口组装 `ProcessGroupCollection`，再显式传给 model/layer。当前代码允许初始化/bootstrap 读取 MPU 全局状态，因为这里正是“从全局兼容接口物化显式依赖”的边界。

深层 Core 模块则应接收：

```python
pg_collection: ProcessGroupCollection
# 或某个明确的 torch.distributed.ProcessGroup
```

这样一个模块可在测试或多模型场景中使用不同 group 集合。

## 随机数为何也要并行感知

Dropout、参数初始化、data shuffling 都使用随机数。并行语义要求：

- 某些 TP ranks 对复制区域使用相同随机流；
- 某些分片参数需要不同但可复现的流；
- checkpoint resume 必须恢复各 rank RNG 状态；
- DP replicas 的数据顺序应按设计一致或互补。

因此只调用一次 `torch.manual_seed` 不足以保证模型并行训练可复现。项目维护 CUDA RNG tracker 与模型并行 seed 偏移。

## 初始化失败的定位顺序

1. 检查每个 rank 的 `RANK/WORLD_SIZE/LOCAL_RANK`；
2. 验算 `WORLD_SIZE = TP*PP*CP*DP` 与额外 EP 整除；
3. 确认所有节点运行同一命令和代码快照；
4. 检查 `MASTER_ADDR/MASTER_PORT` 可达；
5. 找最早 Python 异常，再看 NCCL 日志；
6. 确认 device mapping 没有让两个进程误用同一 GPU。

## 实验：手算一个 group

设 `WORLD_SIZE=8, TP=2, PP=2, CP=1, DP=2`。选择 rank 3：

1. 写出其四维坐标；
2. 列出其 TP/PP/DP group；
3. 判断它是否可能属于 embedding group；
4. 在 `parallel_state.py` 中查找创建这些组的循环。

```bash
rg -n "def initialize_model_parallel|embedding_group|data_parallel_group" \
  megatron/core/parallel_state.py
```

## 自测

1. 为什么必须先建 group 再构造 TP layer？
2. group creation 为什么要求所有 rank 顺序一致？
3. embedding group 与普通 PP group 有何区别？
4. 为什么随机数状态也是并行系统状态？
5. 哪一层适合从 MPU 全局接口物化 `ProcessGroupCollection`？

## 源码定位

- [initialize.py](https://github.com/NVIDIA/Megatron-LM/blob/e79cb4c1bae1afd04322d979d08cb63832991ebe/megatron/training/initialize.py)
- [parallel_state.py](https://github.com/NVIDIA/Megatron-LM/blob/e79cb4c1bae1afd04322d979d08cb63832991ebe/megatron/core/parallel_state.py)
- [process_groups_config.py](https://github.com/NVIDIA/Megatron-LM/blob/e79cb4c1bae1afd04322d979d08cb63832991ebe/megatron/core/process_groups_config.py)

下一章追踪原始 token 如何变成当前 rank 真正消费的 batch。
