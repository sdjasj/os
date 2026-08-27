# 07. MLP 与 MoE：从两次 GEMM 到动态 token 路由

Dense MLP 对每个 token 执行同一组参数；MoE 则先为 token 选择专家，再把 token 发到专家所在 rank。两者在 TransformerLayer 中占据同一个 `mlp` 插槽，因此 spec 可以按层选择 dense 或 MoE，而 residual 骨架无需改变。

## Dense MLP 主路径

```text
hidden [S,B,H]
  -> ColumnParallelLinear fc1
  -> bias + GELU/SwiGLU
  -> RowParallelLinear fc2
  -> output [S,B,H] + bias
```

源码注释直接给出 fc1 的局部输出 `[s,b,4h/p]`。若启用 gated linear unit，fc1 输出先拆 gate/up 两半，激活后相乘，再进入 fc2。

## 为什么 fc1/fc2 这样配对

fc1 沿输出维切分，激活函数可独立作用在每个 shard，不需 gather。fc2 已接收分片输入，沿输入维做局部 GEMM，最后 reduction 合并结果。这让两个大 GEMM 之间没有额外全量通信。

## MoE 的四步

`MoELayer.forward` 文档明确列出：

```text
1. Routing & preprocessing
2. Dispatch
3. Expert computation
4. Combine
```

更具体：

```text
hidden [tokens,H]
  -> router logits/probabilities + routing map
  -> permute by expert
  -> all-to-all/all-gather/flex dispatch
  -> local expert MLPs
  -> inverse communication
  -> weighted combine + unpermute
```

## EP 与本地专家数

初始化计算：

```text
num_local_experts = num_moe_experts / ep_size
```

所以 `num_moe_experts % ep_size == 0` 是基本不变量。每个 EP rank 只构造其本地专家索引；router 仍要对全局专家空间做选择。

## Token dispatcher 是可替换策略

当前代码支持 `allgather`、`alltoall`、`flex` 等 dispatcher。选择影响：

- 通信字节和拓扑适配；
- token permutation 与 metadata；
- expert load 不均时的代价；
- 是否能与 shared expert/计算重叠。

Router 决定“去哪里”，dispatcher 决定“怎样送过去”，experts 决定“到了以后怎么算”。

## Shared expert 与 routed expert

Shared expert 对所有 token 提供稳定 dense 路径，routed experts 提供稀疏容量。若开启 overlap，shared expert 计算可与 token dispatch 并行，最后相加。这增加 stream/event 生命周期，排错时要分别观察 routed 与 shared 输出。

## 负载均衡为什么重要

若大量 token 选择同一专家：

- 该 rank GEMM/token buffer 更大；
- 其他专家空闲；
- all-to-all 接收量倾斜；
- step 时间由最慢 rank 决定。

Router auxiliary loss、capacity/drop policy 等机制尝试改善分布，但会改变训练目标或 token 处理语义，不能只按吞吐开关理解。

## TP、EP 与 SP 的组合

专家 MLP 还可使用 expert tensor parallel。当前代码在训练时若 attention TP>1、MoE 启用但未启用 sequence parallel，会警告/拒绝可能的低效组合。原因是 replicated sequence activation 会放大 MoE 通信和内存。

注意普通 TP group 与 expert TP group 可不同，生产模块应从 `pg_collection` 取准确 group，而不是默认两者相同。

## MoE Debug 账本

每层记录：

```text
tokens before routing
tokens per expert
tokens sent/received per EP peer
local expert input/output shape
dropped/padded tokens
router auxiliary loss
```

这比只看总 loss 更容易定位 hang、OOM 和吞吐离群。

## 实验：8 专家、EP=4

设 8 experts、EP=4、top-k=2、当前 microbatch 有 1024 tokens：

1. 每个 rank 本地 2 experts；
2. 总 expert assignments 为 2048（忽略 drop）；
3. 均匀时每 expert 约 256 assignments；
4. 若一个 expert 收到 800，说明哪几项资源会倾斜？

```bash
rg -n "class MoELayer|num_local_experts|token_dispatcher" \
  megatron/core/transformer/moe/moe_layer.py
rg -n "class MLP|def forward" megatron/core/transformer/mlp.py
```

## 自测

1. Dense MLP 为何在两个 GEMM 间无需 gather？
2. Router 与 dispatcher 的职责区别是什么？
3. `num_local_experts` 怎样计算？
4. 负载倾斜为什么会拖慢全局 step？
5. 普通 TP 与 expert TP 为什么不能默认相同？

## 源码定位

- [Dense MLP](https://github.com/NVIDIA/Megatron-LM/blob/e79cb4c1bae1afd04322d979d08cb63832991ebe/megatron/core/transformer/mlp.py)
- [MoE layer](https://github.com/NVIDIA/Megatron-LM/blob/e79cb4c1bae1afd04322d979d08cb63832991ebe/megatron/core/transformer/moe/moe_layer.py)
- [MoE router](https://github.com/NVIDIA/Megatron-LM/blob/e79cb4c1bae1afd04322d979d08cb63832991ebe/megatron/core/transformer/moe/router.py)
- [Token dispatcher](https://github.com/NVIDIA/Megatron-LM/blob/e79cb4c1bae1afd04322d979d08cb63832991ebe/megatron/core/transformer/moe/token_dispatcher.py)

下一章深入 TP 的列并行、行并行与 forward/backward 通信对偶。
