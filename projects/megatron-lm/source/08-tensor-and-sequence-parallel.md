# 08. Tensor/Sequence Parallel：矩阵分片与通信对偶

Tensor Parallelism 把单层大矩阵分给多个 rank；Sequence Parallelism 则把 TP 之外仍重复的序列激活切开。理解它们的关键是同时写出权重形状、输入/输出局部形状，以及 forward/backward 的 collective。

## ColumnParallelLinear

项目用 PyTorch 的 `F.linear` 约定存权重转置，若逻辑映射是 `input_size -> output_size`，每 rank 参数形状为：

```text
[output_size / TP, input_size]
```

前向：

```text
X [S,B,H]
Ai [O/TP,H]
Yi = X Ai^T -> [S,B,O/TP]
```

若 `gather_output=False`，每 rank 保留输出 shard。QKV、MLP fc1、词表 projection 都适合这种形式。

## RowParallelLinear

权重按输入维切，输入通常已经分片：

```text
Xi [S,B,H/TP]
Ai [O,H/TP]
local Yi [S,B,O]
Y = sum_i Yi
```

前向需要 TP reduction，MLP fc2 和 attention output projection 常用它。Bias 不分片，通常在 reduction 后或融合 BDA 时添加一次。

## 为什么配对减少通信

```text
ColumnParallel -> local activation -> RowParallel
```

中间 activation 对每个 shard 独立，因此无需 gather；只在配对末尾 reduction。若在每个 Linear 后都恢复完整 tensor，通信量会大幅增加。

## Backward 通信对偶

Column parallel 的输入梯度需要汇总各输出 shard 的贡献；Row parallel 的前向输出需要汇总各输入 shard 的贡献。源码把这些通信嵌入自定义 autograd 和 `linear_with_grad_accumulation_and_async_allreduce`，还能把 dgrad reduction 与 wgrad GEMM 重叠。

分析一个层时写表：

| 阶段 | local GEMM | collective | 结果布局 |
| --- | --- | --- | --- |
| column fwd | `X @ Aiᵀ` | 可选 AG | output-sharded |
| column bwd dX | `dYi @ Ai` | AR/RS | full 或 SP-sharded |
| row fwd | `Xi @ Aiᵀ` | AR/RS | full 或 SP-sharded |
| row bwd dX | local | 通常无需合并 | input-sharded |

具体 AR/RS 取决于 SP 和实现路径。

## Sequence Parallelism

TP layer 之间的 LayerNorm、dropout、residual 若每 rank 都保存完整 `[S,B,H]`，会重复激活。SP 让这些区域沿 `S` 切分：

```text
full [S,B,H]
  -> TP reduce-scatter -> local [S/TP,B,H]
  -> norm/dropout locally
  -> all-gather before需要完整输入的 column GEMM
```

它复用 TP group，所以 `TP=1` 时 SP 没有意义，代码会禁用或告警。

## 通信重叠与环境约束

TP async communication 能与 GEMM 重叠，但依赖 CUDA stream 调度。项目在某些 pre-Blackwell、TP/CP 非 FSDP 配置下建议或要求 `CUDA_DEVICE_MAX_CONNECTIONS=1`；FSDP 和某些 MoE overlap 配置规则不同，不能无条件设置。

教程实践会按硬件/模式给出决策表，不把这个环境变量写成万能命令。

## Vocab parallel 的延伸

Embedding 和 output projection 也沿 vocab 切分。输入 token 只在拥有对应 vocab range 的 rank 查表，再 TP reduce；输出 logits 保持 `[S,B,V/TP]` 并用 vocab-parallel cross entropy。它复用同样的“局部算、必要时规约”思想。

## Sharded state dict

层不仅要算对，还要告诉 distributed checkpoint 权重沿哪一维分片。`ColumnParallelLinear.sharded_state_dict` 标记 axis 0，RowParallel 则对应输入轴。若自定义 TP layer 没有正确 metadata，训练可能正常，保存/跨 TP 加载却失败。

## 实验：手算 MLP

设 `H=4096,F=11008,TP=4,S=1024,B=2`：

1. fc1 每 rank 权重 `[2752,4096]`（非 GLU）；
2. fc1 输出 `[1024,2,2752]`；
3. fc2 每 rank 权重 `[4096,2752]`；
4. fc2 local 输出 `[1024,2,4096]`，随后 TP reduction；
5. SwiGLU 时重新计算 fc1 参数/局部输出。

```bash
rg -n "class (ColumnParallelLinear|RowParallelLinear)" \
  megatron/core/tensor_parallel/layers.py
rg -n "scatter_to_sequence|gather_from_sequence" \
  megatron/core/tensor_parallel
```

## 自测

1. ColumnParallel 的权重实际存储形状是什么？
2. RowParallel 前向为什么需要 reduction？
3. 配对为何能省掉中间 gather？
4. SP 主要减少哪类激活冗余？
5. 自定义 TP layer 为何必须实现正确 sharded metadata？

## 源码定位

- [TP layers](https://github.com/NVIDIA/Megatron-LM/blob/e79cb4c1bae1afd04322d979d08cb63832991ebe/megatron/core/tensor_parallel/layers.py)
- [TP mappings](https://github.com/NVIDIA/Megatron-LM/blob/e79cb4c1bae1afd04322d979d08cb63832991ebe/megatron/core/tensor_parallel/mappings.py)
- [Vocab parallel cross entropy](https://github.com/NVIDIA/Megatron-LM/blob/e79cb4c1bae1afd04322d979d08cb63832991ebe/megatron/core/tensor_parallel/cross_entropy.py)

下一章研究 pipeline schedule 如何编排多个 microbatch。
