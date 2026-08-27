# 03. GPU 性能与混合精度：FLOPs、字节和生命周期

数学等价不代表 GPU 上同样快。训练吞吐取决于矩阵规模、显存带宽、kernel 启动、通信、精度与 tensor 生命周期。本章给出一套够用性能模型，用来解释融合、重计算、FP8 和通信重叠。

## 计算受限与带宽受限

```text
arithmetic intensity = operations / bytes moved
```

大 GEMM 通常算术强度高，容易发挥 Tensor Core；LayerNorm、dropout、逐元素激活常更受显存带宽和 kernel 启动影响。因此项目会：

- 保持每个 rank 的 GEMM 足够大；
- 融合 bias、activation、dropout、residual；
- 使用 Transformer Engine fused layer；
- 把通信放入可与 GEMM 重叠的窗口。

TP 过大时，每个 rank 的矩阵变窄，显存下降却可能让利用率更差。

## MFU 是端到端指标

```text
MFU = 实际吞吐对应的模型 FLOPs / 硬件理论峰值 FLOPs
```

数据加载、通信、optimizer、日志、pipeline bubble 都进入耗时。MFU 下降不能直接证明某个 kernel 慢，必须把 iteration 分解为计算、通信、空闲、I/O 与同步。

## 混合精度的四类对象

不要只问“模型是 BF16 还是 FP16”，应区分：

1. 参数存储 dtype；
2. forward/backward GEMM 与激活 dtype；
3. 梯度累积 buffer dtype；
4. optimizer master parameter 和状态 dtype。

常见方案是 BF16 参数/激活配合 FP32 optimizer 状态。`ModelParallelConfig`、DDP config 和 optimizer config 共同决定真实布局。

### FP16、BF16、FP8/FP4

- FP16 指数范围较窄，常需 loss scaling；
- BF16 指数范围接近 FP32，现代训练常优先使用；
- FP8/FP4 进一步省带宽和存储，但需要 scale、amax 历史、量化 recipe 与专用 kernel。

低精度不是简单 `.to(dtype)`；layer spec、Transformer Engine、量化状态和 checkpoint 必须协同。

## Loss scaling

```text
scaled_loss = scale * loss
scaled_grad = scale * grad
```

optimizer 更新前 unscale 并检查 Inf/NaN。若 overflow，跳过更新并调整 scale。于是 `train_step` 的 `update_successful` 可能为 false，学习率调度也不应当作成功更新推进。

## Fusion 的本质

未融合 bias + activation 可能多次写回/读取 global memory。融合把中间值留在寄存器或 shared memory，减少流量和 kernel launch。`MLP.forward` 的 `bias_activation_fusion` 分支选择 fused GELU/SwiGLU，否则走清晰 PyTorch 回退路径。

## Activation recomputation

```text
不重计算：更高显存，较少 FLOPs
重计算：  更低显存，更多 FLOPs
```

full/selective recompute 改变“保存哪些中间值”，不改变训练目标。是否值得取决于额外计算与释放激活字节的比例。

## Microbatch 的双重作用

更小 microbatch 降低单次激活峰值，但可能让 GEMM 变小、增加调度开销、改变 PP bubble 并增加梯度累积次数。因此它是性能参数，不只是 OOM 旋钮。

## 显存账本

```text
parameters
+ gradients / main_grad buffers
+ optimizer states and master params
+ saved activations
+ temporary workspace
+ communication buckets
+ graph/allocator fragmentation
```

- TP/PP/EP 分片部分参数和激活；
- distributed optimizer 分片 optimizer state；
- SP/CP 分片序列激活；
- recompute 减少 saved activations；
- FSDP 进一步分片参数、梯度、状态，但增加 gather/reshard。

只计算参数 GB 无法预测训练 OOM。

## 通信重叠的依赖条件

以 DP gradient overlap 为例：一个 bucket 的梯度准备好后异步 reduce，同时更早层继续 backward。成功要求 bucket 顺序匹配、通信 stream 推进、资源不严重争用、用参数前正确 wait。DDP 的 bucket group、`start_grad_sync`、`finish_grad_sync` 管理这些条件。

## 实验：预测四项变化

1. TP 从 2 墠到 8：局部内存、GEMM 尺寸和通信如何变？
2. micro batch 从 8 降到 1：峰值激活与利用率如何变？
3. selective recompute：时间与内存各怎样变？
4. overlap-grad-reduce：理想时间线怎样变化，为什么未必加速？

```bash
rg -n "recompute_granularity|bias_activation_fusion|tp_comm_overlap" \
  megatron/core/transformer megatron/core/model_parallel_config.py
rg -n "overlap_grad_reduce|overlap_param_gather" \
  megatron/core/distributed megatron/training
```

## 自测

1. 为什么 TP 越大不一定越快？
2. “BF16 训练”为何不能描述所有状态 dtype？
3. fusion 主要减少什么？
4. recomputation 交换哪两种资源？
5. distributed optimizer 主要减少哪项显存？

## 源码定位

- [ModelParallelConfig](https://github.com/NVIDIA/Megatron-LM/blob/e79cb4c1bae1afd04322d979d08cb63832991ebe/megatron/core/model_parallel_config.py)
- [TransformerConfig](https://github.com/NVIDIA/Megatron-LM/blob/e79cb4c1bae1afd04322d979d08cb63832991ebe/megatron/core/transformer/transformer_config.py)
- [MLP fusion](https://github.com/NVIDIA/Megatron-LM/blob/e79cb4c1bae1afd04322d979d08cb63832991ebe/megatron/core/transformer/mlp.py)
- [DDP overlap](https://github.com/NVIDIA/Megatron-LM/blob/e79cb4c1bae1afd04322d979d08cb63832991ebe/megatron/core/distributed/distributed_data_parallel.py)

下一章把各种并行放进同一张拓扑图。
