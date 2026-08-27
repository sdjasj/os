# 07. ZeRO 原理：从消除冗余到按生命周期调度状态

ZeRO 的全名是 Zero Redundancy Optimizer。它保留同步数据并行的训练语义，却逐阶段消除每个数据并行 rank 上的冗余状态。理解它的关键不是背“1/2/3”，而是为参数、梯度、optimizer state 分别写出 owner、通信和可用时间。

## Stage 枚举就是分片边界

[`DeepSpeedZeroConfig`](config.py) 中的枚举清楚表达：

```text
0 disabled
1 optimizer_states
2 gradients
3 weights
```

Stage 2 包含 Stage 1，Stage 3 包含 Stage 1/2。每升一级，都把一种此前在 DP ranks 间复制的持久状态改成 partition。

## 用一个 8 元素参数手算

设数据并行 world size 为 4，参数：

```text
w = [w0 w1 | w2 w3 | w4 w5 | w6 w7]
       r0      r1      r2      r3 owner
```

### 普通 DP

每个 rank 都有完整 `w`、完整梯度 `g`、完整 Adam state。All-Reduce 后每个 rank 独立算出同样更新。

### Stage 1

每个 rank 仍有完整低精度 `w` 和梯度，但只拥有对应 partition 的 FP32 master/moments。每个 owner 更新自己的两元素参数，然后 All-Gather 更新片，恢复所有 rank 的完整低精度 `w`。

### Stage 2

梯度不再在每个 rank 形成完整持久副本。Reduce-Scatter 求和并把 `g0:g1` 给 rank 0、`g2:g3` 给 rank 1……owner 用自己的梯度片和 optimizer state 更新，再 All-Gather 低精度参数。

### Stage 3

低精度参数也只保存 partition。执行某个模块前 gather 该模块所需参数，计算后在安全时机 release/partition。持久状态近似都除以 DP world size，但增加动态 fetch 的时序和 buffer。

## Stage 1/2 为什么 step 后要 All-Gather 参数

Forward 的数据并行语义要求每个 rank 用同一完整模型处理不同数据。Stage 1/2 只让一个 rank 更新每个参数 partition，若不传播更新，其余 rank 的完整低精度副本就过期。

```text
partitioned optimizer step
  rank 0 更新 slice 0
  rank 1 更新 slice 1
  ...
       ↓
All-Gather updated low-precision partitions
       ↓
每个 rank 重新拥有一致的完整参数
```

Stage 3 则不维持长期完整副本，只在模块执行窗口 gather。

## 通信量与显存不是同时免费下降

ZeRO-1/2 可以复用 All-Reduce 的结构：Reduce-Scatter 处理梯度、All-Gather 传播更新，通信量级与普通 DP 相近，但布局更有用。Stage 3 还需在 forward/backward 按模块 fetch 参数，通信模式和延迟更敏感。

所以 stage 选择是：

| 需求 | 倾向 |
| --- | --- |
| 模型能放下，只想减少 optimizer state | Stage 1 |
| 参数能放下，梯度/optimizer state 压力大 | Stage 2 |
| 单卡连参数副本都放不下 | Stage 3 |
| GPU 总内存仍不够 | Stage 3 + CPU/NVMe offload |

不应因为 Stage 3 省得最多，就默认它一定最快。

## `DeepSpeedZeroConfig` 的配置族

配置项可按功能分组：

### 分片级别

- `stage`；
- `offload_optimizer`；
- `offload_param`（只对 Stage 3 参数）；
- `sub_group_size`（超大模型分块处理）。

### 梯度通信

- `reduce_scatter`；
- `reduce_bucket_size`；
- `contiguous_gradients`；
- `overlap_comm`；
- `use_multi_rank_bucket_allreduce`。

### 参数传播/fetch

- `allgather_partitions`；
- `allgather_bucket_size`；
- `stage3_prefetch_bucket_size`；
- `stage3_use_all_reduce_for_fetch_params`；
- `stage3_allgather_sequential`。

### Stage 3 驻留策略

- `stage3_param_persistence_threshold`；
- `stage3_model_persistence_threshold`；
- `stage3_max_live_parameters`；
- `stage3_max_reuse_distance`；
- `stage3_module_granularity_threshold`。

### 量化与层次化分片

- `zero_quantized_weights`；
- `zero_quantized_gradients`；
- `zero_quantized_nontrainable_weights`；
- `zero_hpz_partition_size`；
- `zeropp_loco_param`。

先按功能分组，再看默认值，比逐行背 JSON 有效。

## 动态默认值为何依赖 stage

`overlap_comm` 默认是 `None`，validator 会根据 stage 决定实际值；当前配置对 Stage 3 默认打开。这样的字段不能只读类型声明，应继续读 model validator。

Pydantic alias 也很重要：Python 字段名可能是 `prefetch_bucket_size`，用户 JSON 中常写 `stage3_prefetch_bucket_size`。搜索配置时两种名称都要查。

## Contiguous gradients 的意义

Autograd 为不同参数产生的 gradient allocation 大小和时间不同，频繁分配/释放容易造成碎片。`contiguous_gradients` 将 ready gradients 复制到预分配连续 buffer：

- 便于形成大 bucket；
- 减少 allocator 碎片；
- 容易按 partition narrow；
- 代价是复制和预留 buffer 空间。

它不是“压缩梯度”，只是改变物理布局。

## Partition 为什么需要 padding

若 flat group 元素数不能整除 (N)，各 rank partition 仍需等长以满足 collective：

\[
partition\_size=\left\lceil\frac{numel}{N}\right\rceil
\]

最后一片的尾部是 padding。更新、state dict、gather 和恢复原 shape 时必须记录真实 numel 与 padding。源码里大量 `narrow()`、offset、partition id 和 padding 计算都服务于这一契约。

## ZeRO 与普通 Sharded Optimizer 的差别

只切 optimizer state 可以得到 Stage 1 类似效果；ZeRO 完整系统还处理：

- 梯度 ready hook 与 reduction overlap；
- 参数 flatten、partition、all-gather；
- 混合精度和 loss scaling；
- CPU/NVMe swap；
- checkpoint 分片与恢复；
- external parameter 和动态 module；
- Pipeline、MoE 等组合边界。

因此不能只看 optimizer.step 的几行切片代码就理解 ZeRO。

## 一个选择 stage 的决策流程

```text
1. 参数 + activation 能否在单卡 forward？
   否 → checkpoint activation / 减 micro-batch / TP/PP / Stage 3
   是 → 继续

2. 创建 optimizer state 后是否 OOM？
   是 → Stage 1 或 optimizer offload
   否 → 继续

3. backward 梯度/通信 buffer 是否 OOM？
   是 → Stage 2，调 bucket/overlap
   否 → Stage 0/1 可能更快

4. 聚合总显存仍不足？
   → Stage 3 + CPU/NVMe，或增加模型并行
```

选择后用 profile 验证，不靠 stage 编号猜性能。

## 本章实验：为配置做因果表

选下面配置：

```json
{
  "zero_optimization": {
    "stage": 3,
    "reduce_bucket_size": 50000000,
    "stage3_prefetch_bucket_size": 25000000,
    "stage3_param_persistence_threshold": 100000,
    "stage3_max_live_parameters": 100000000
  }
}
```

为每项写：直接控制的 buffer/状态、预期显存方向、预期消息数/带宽方向、可能副作用。然后在源码中确认字段：

```bash
rg -n 'reduce_bucket_size|prefetch_bucket_size|param_persistence_threshold|max_live_parameters' \
  deepspeed/runtime/zero
```

## 常见误区

- 把 stage 当作彼此独立的算法，而不是递进分片。
- 只计算稳态 partition，忽略 gather 和通信 buffer 峰值。
- 认为 Stage 3 一定比 Stage 2 快。
- 把 contiguous gradients 误解为压缩。
- 修改多个 bucket/persistence 参数后，只凭最终吞吐猜哪个生效。
- 忽略 DP group size，拿全局 world size 估算 partition。

## 自测

1. Stage 1/2 为什么在 step 后传播更新后的参数片？
2. Stage 3 为什么还会出现短暂的完整模块参数？
3. padding 为何是 collective 契约的一部分？
4. 什么时候 Stage 1 可能比 Stage 3 更合适？
