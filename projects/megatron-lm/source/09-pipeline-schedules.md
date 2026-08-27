# 09. Pipeline Parallel：schedule、P2P 与 microbatch 生命周期

PP 把层分到不同 rank，却必须让 autograd 像一条完整模型那样工作。`schedules.py` 的职责是决定每个时刻做 forward、backward、send、recv 还是同步，而不是实现 Transformer 数学。

## Schedule 选择器

`get_forward_backward_func()` 根据 PP/VPP size 返回：

```text
PP=1                  -> forward_backward_no_pipelining
PP>1, VPP absent      -> pipelining_without_interleaving
PP>1, VPP enabled     -> pipelining_with_interleaving
```

训练循环只调用返回的统一函数，不需要充斥 PP 分支。

## 无 PP 路径也是 schedule

`forward_backward_no_pipelining` 仍负责：

- 遍历 microbatches；
- 调用 task `forward_step_func`；
- 在最后一个 microbatch 前使用 DDP `no_sync` 抑制过早梯度规约；
- 调用 backward；
- 累计 token 数和 loss data。

所以 schedule 不是 PP 专属，它统一拥有“一个 global batch 内的 F/B 编排”。

## 非交错 1F1B 的三段

```text
warmup:
  只 forward，填满 pipeline

steady:
  每轮一个 forward + 一个 backward

cooldown:
  只 backward，排空 pipeline
```

stage 位置不同，warmup microbatch 数也不同。首 stage 最早开始 forward，末 stage 最早得到 loss 并开始 backward。

## Stage 间传什么

通常相邻 PP stage 发送 hidden activation `[S,B,H]`，反向发送对应梯度。首 stage 从 tokens 产生 activation；中间 stage 调用 `model.set_input_tensor(received)`；末 stage 计算 loss closure。

P2PCommunicator 封装 send/recv 和 batch 组合，schedule 决定顺序。shape metadata 必须在各 stage 一致，否则一端等待的字节与另一端发送不匹配。

## 为什么 task forward 返回 closure

```python
output, loss_func = forward_step_func(data_iterator, model)
```

中间 stage 的 output 是要发送的 hidden state；末 stage 才调用 `loss_func(output)` 得到 loss、token 数和日志 dict。这样 schedule 无需知道 GPT 的 `loss_mask`。

## VPP 与 model chunks

VPP 把一个物理 PP rank 的层分为多个虚拟 chunk，交错顺序类似：

```text
physical rank 0: chunk 0, chunk 1, ...
physical rank 1: chunk 0, chunk 1, ...
```

更细粒度可缩小 bubble，但要求：

- model 与 data iterator 可能都是 list；
- 虚拟 stage 状态在调度中切换；
- layer offset/checkpoint key 正确；
- 参数/梯度同步与 chunk 顺序协调。

## `no_sync` 的位置

一个 global batch 含多个 microbatch，DDP 不应每个 microbatch 都做完整 gradient reduction。schedule 在前若干 microbatch 进入 `no_sync`，最后或 bucket 就绪时再同步，既保持累积语义，又减少通信。

PP 与 DP overlap 组合时，schedule 会把 `grad_sync_func`、`param_sync_func` 放在特定 microbatch/chunk 边界。这也是 schedules 文件复杂的主要原因。

## Bubble 的粗略直觉

非交错 pipeline 若有 `p` stages、`m` microbatches，bubble 比例数量级约：

```text
(p-1) / (m+p-1)
```

`m` 越大 bubble 越小，但 microbatch 太小会降低 GEMM 效率并增加调度成本。选择是端到端权衡。

## 排错时间线

PP hang 时为每 rank 记录：

```text
global rank / pp rank / virtual chunk
microbatch id
expected op: recv_fwd, send_fwd, recv_bwd, send_bwd
tensor shape/dtype
peer rank
```

最早不匹配的 send/recv 才是根因，后续 NCCL timeout 只是结果。

## 实验：3 stages、5 microbatches

在纸上画非交错时间线，标出：

1. 每个 stage 的 warmup 数；
2. 何时末 stage 第一次算 loss；
3. steady 期每个 stage 的 F/B；
4. 最后一个 backward 何时完成；
5. 若 microbatch 数降为 1，哪些 stage 大部分时间空闲？

```bash
rg -n "^def (get_forward_backward_func|forward_backward_)" \
  megatron/core/pipeline_parallel/schedules.py
```

## 自测

1. PP=1 为什么仍使用 schedule？
2. Warmup/steady/cooldown 各做什么？
3. 为什么只有末 stage 调 loss closure？
4. VPP 用什么复杂度换取更小 bubble？
5. `no_sync` 为什么由 schedule 控制？

## 源码定位

- [schedules.py](https://github.com/NVIDIA/Megatron-LM/blob/e79cb4c1bae1afd04322d979d08cb63832991ebe/megatron/core/pipeline_parallel/schedules.py)
- [P2P communication](https://github.com/NVIDIA/Megatron-LM/blob/e79cb4c1bae1afd04322d979d08cb63832991ebe/megatron/core/pipeline_parallel/p2p_communication.py)
- [PP utilities](https://github.com/NVIDIA/Megatron-LM/blob/e79cb4c1bae1afd04322d979d08cb63832991ebe/megatron/core/pipeline_parallel/utils.py)

下一章回到 sequence 维，理解 CP 与 packed sequence 怎样协同。
