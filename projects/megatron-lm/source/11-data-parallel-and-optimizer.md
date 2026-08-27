# 11. Data Parallel、DDP 与分布式优化器：谁拥有梯度和状态

DP 让不同 replica 处理不同样本，再合并梯度。Megatron 的 DDP 不只是 PyTorch wrapper：它把参数梯度放进连续 buffer，按 bucket 调度通信，并与 distributed optimizer 的 reduce-scatter/all-gather 配合。

## 普通 DP 的数学

每个 DP rank 计算局部 loss 和梯度：

```text
g = sum_or_average(g_rank across DP group)
```

所有 replica 从相同参数开始、应用相同全局梯度和 optimizer step，因而继续保持一致。TP/PP/CP ranks 是一个模型副本内部的协作者，DP ranks 才表示不同数据副本。

## 为什么用连续 grad buffer

逐参数启动 collective 数量太多。DDP 为兼容 dtype/参数类别构造连续 buffer，并把参数的 `main_grad` 指向 buffer slice。Backward hook 在某个参数梯度准备好时把它登记到 bucket。

收益：

- 更少、更大的 collective；
- 可按 backward 顺序尽早启动 bucket；
- gradient accumulation 直接写 main buffer；
- 更容易与 distributed optimizer 对齐 shard。

## `no_sync` 与最后一次同步

多个 microbatch 构成 global batch。前几个 microbatch 只累积 main_grad，不启动完整同步；schedule 在合适边界退出 `no_sync`，让最后梯度触发 bucket communication。

`zero_grad_buffer()` 在 iteration 开始重置 buffer 与 dispatch state，不等价于只对 `param.grad=None`。

## 两种 grad sync

普通 optimizer：

```text
DP all-reduce -> 每 rank 完整 global grad
```

Distributed optimizer：

```text
DP reduce-scatter -> 每 rank 只拥有 grad buffer 的一段
local optimizer updates owned parameter shards
DP all-gather -> 重建下一次 forward 所需参数
```

后者类似 ZeRO-1 思想，主要分片 optimizer state 和更新责任。

## `start/finish` API 表达异步生命周期

```text
start_grad_sync()    发起 AR/RS
finish_grad_sync()   等待并完成后处理
start_param_sync()   发起 parameter AG
```

`overlap_grad_reduce` 让通信与 backward 重叠；`overlap_param_gather` 让下一轮参数 gather 尽量与计算/optimizer 重叠。Start 与 finish 之间不能覆写或释放 buffer。

## DistributedOptimizer 的 range map

它把整个 grad buffer 概念上均分给 DP ranks，不要求 shard 与参数边界对齐。一个参数可能只在当前 rank 拥有部分 range。代码维护：

```text
gbuf_world
gbuf_world_in_bucket
gbuf_local
param sub-range
```

这些映射决定本 rank 更新哪段参数、保存哪段 optimizer state，以及如何做 checkpoint reshard。

## Dense 与 expert 参数使用不同 DP group

Dense 参数通常在 `dp_cp` group 上复制/同步；expert 参数只在拥有同一 expert shard 的 `expt_dp` group 上同步。DDP 用参数的 `allreduce`/expert metadata 选择正确 buffer/group。

把 expert grad 错发到普通 DP group 会混合不同专家或导致 shape/group 不匹配。

## Finalize gradients

`train_step` 在 schedule 后调用 `finalize_model_grads`，不仅等待 DP bucket，还可能处理：

- sequence-parallel LayerNorm gradient；
- shared embedding gradient；
- token-based loss scaling；
- expert/dense group差异。

所以“autograd.backward 返回”不等于全局梯度已可供 optimizer 使用。

## DDP、Megatron-FSDP、Torch-FSDP2

- DDP：参数副本常驻，梯度可 bucket 化；
- DistOpt：在 DDP buffer 上分片 optimizer state/update；
- FSDP：进一步在生命周期中 gather/reshard 参数与梯度。

三者的环境变量、overlap 与 checkpoint 路径不同。不要把某个 DDP 调优规则直接套到 FSDP。

## 实验：16 元素 buffer、DP=4

假设 grad buffer 有 16 元素：

```text
rank0 owns [0:4)
rank1 owns [4:8)
rank2 owns [8:12)
rank3 owns [12:16)
```

若一个参数占 `[3:7)`，rank0 更新其 `[0:1)` 子段，rank1 更新其 `[1:4)` 子段。解释为什么 shard 不必对齐参数边界，以及 all-gather 如何恢复完整参数。

```bash
rg -n "class DistributedDataParallel|start_grad_sync|start_param_sync" \
  megatron/core/distributed/distributed_data_parallel.py
rg -n "class DistributedOptimizer|gbuf_world" \
  megatron/core/optimizer/distrib_optimizer.py
```

## 自测

1. 为什么需要连续 grad buffer？
2. DistOpt 的 RS→update→AG 各做什么？
3. `start_*` 与 `finish_*` 为什么必须成对？
4. Expert 参数为什么使用不同 DP group？
5. backward 返回后还要 finalize 哪些梯度语义？

## 源码定位

- [Megatron DDP](https://github.com/NVIDIA/Megatron-LM/blob/e79cb4c1bae1afd04322d979d08cb63832991ebe/megatron/core/distributed/distributed_data_parallel.py)
- [DistributedOptimizer](https://github.com/NVIDIA/Megatron-LM/blob/e79cb4c1bae1afd04322d979d08cb63832991ebe/megatron/core/optimizer/distrib_optimizer.py)
- [finalize_model_grads](https://github.com/NVIDIA/Megatron-LM/blob/e79cb4c1bae1afd04322d979d08cb63832991ebe/megatron/core/distributed/finalize_model_grads.py)

下一章把 schedule、finalize、optimizer 和 scheduler 合成一个 `train_step`。
