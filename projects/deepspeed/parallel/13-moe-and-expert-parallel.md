# 13. DeepSpeed-MoE：路由、容量、All-to-All 与专家并行

Mixture of Experts（MoE）让每个 token 只经过少数专家，从而用接近稠密模型部分计算量扩展总参数。系统难点不在专家 MLP 本身，而在动态路由、负载均衡、容量限制和跨 rank token dispatch。

## 一个 MoE 层的数据流

设输入 flatten 为 (X\in\mathbb{R}^{T\times H})，有 (E) 个专家，每 token 选择 top-(k)：

```text
X [tokens, hidden]
  → gate logits [tokens, experts]
  → top-k expert id + weight
  → capacity / drop policy
  → dispatch tokens to expert ranks (All-to-All)
  → local expert MLP
  → reverse All-to-All
  → 按 gate weight combine
  → output [tokens, hidden]
```

[`MoE`](layer.py) 是用户层封装；`TopKGate` 和 `MOELayer` 位于 `sharded_moe.py`，`Experts` 包装本地专家副本。

## Gate 不是普通分类器

Gate 通常用线性投影产生 logits：

\[
G=XW_g^T\in\mathbb{R}^{T\times E}
\]

softmax 后选择 top-1 或 top-2 专家。Gate 输出还要形成：

- `combine_weights`：返回时怎样加权专家结果；
- `dispatch_mask`：每 token 放进哪个 expert capacity slot；
- `l_aux`：负载均衡辅助损失；
- expert count：观察负载。

只拿 top-k index 不够，因为 batching 需要把变长 token 集合装进规则 tensor。

## Capacity 解决什么

理想平均每个专家接收 (T/E) 个 token。实际路由不均，定义容量：

\[
C=\max(C_{min},\lceil capacity\_factor\cdot T/E\rceil)
\]

每个专家最多处理 (C) 个 token，dispatch tensor 可表示为 `[E, C, H]`。容量过小会 drop/绕过 token，影响质量；过大则为最坏负载预留大量空 slot，增加通信和计算。

训练和 eval 可用不同 capacity factor；`drop_tokens=false` 可能通过全局 max 扩容，减少丢弃但让最拥挤专家决定成本。

## 负载均衡辅助损失

若只优化主任务，gate 可能把大多数 token 发给少数专家，产生热点和塌缩。辅助损失鼓励路由概率与实际 token 分配更均匀。概念上希望每个专家的概率质量和 token fraction 接近 (1/E)。

用户模型必须把 `l_aux` 以合适系数加入总 loss；只记录不反向传播不会改善路由。系数太大又可能牺牲主任务。

## Expert Parallel group

设 `ep_size=4`、`num_experts=8`，每个 expert-parallel rank 通常持有 2 个本地专家。进入 MoE 前，各 rank 的 token 按目标 expert 重新分发：

```text
rank 0 local tokens → expert owners 0,1,2,3
rank 1 local tokens → expert owners 0,1,2,3
...
              All-to-All
每个 rank 收到属于本地 experts 的 token
```

专家参数不是在 EP group 中复制，而是在 expert-data-parallel group 中寻找相同 expert shard 的副本并同步梯度。Engine 对普通参数和 MoE 参数使用不同 gradient reduction group。

## `ep_size`、expert 数与 data parallel

一般要求 expert 数能合理分配给 EP ranks。若全局 world 同时做 EP 和 DP：

\[
N=N_{ep}\times N_{edp}
\]

这里 EDP 表示专家副本的数据并行维。若再加入 TP/PP，必须明确每个 process group 的笛卡尔积关系。

配置 `ep_size` 只说明专家放置维度，不自动解释整个训练拓扑。

## `MOELayer.forward()` 的形状转换

源码主线可抽象为：

1. 记录原输入 shape；
2. flatten token 维为 `[T, H]`；
3. gate 得到 auxiliary loss、combine weights、dispatch mask 和 counts；
4. einsum/索引把 token 放入 `[E, C, H]`；
5. 第一次 All-to-All 按 expert owner 重排；
6. reshape 为本地 expert batch，调用 experts；
7. 第二次 All-to-All 把输出送回 token owner；
8. combine weights 加权并恢复原 shape。

两次 All-to-All 是互逆方向，但中间 local expert 改变了值。

## Top-1 与 Top-2 的取舍

| 路由 | 每 token 计算 | 容错/表达 | 通信与容量 |
| --- | ---: | --- | --- |
| top-1 | 一个专家 | 简单、稀疏 | 最低 |
| top-2 | 两个专家 | 更平滑，能组合 | 近似翻倍 token dispatch |

Top-2 还需处理第二专家采样、归一化权重和各自容量。不要只改 `k=2` 而不重估 capacity、通信和 loss。

## Noisy gate 与 RTS

训练中可向 gate 加噪声促进探索，Random Token Selection（RTS）在专家超容量时随机保留 token，避免总是丢弃固定位置。它们引入随机性：

- 所有 rank 的 RNG/seed 管理要可复现；
- 测试应统计性质而非要求每个 token 恒定；
- eval 通常关闭相应随机机制。

## Residual MoE

`use_residual` 路径将 MoE 输出与稠密 MLP 路径通过系数组合，提供更稳健的基线，但增加参数和计算。源码中 residual module、coefficient layer 和 MoE output 同时参与 forward，不应把它当普通 skip connection。

## Tutel 与优化路径

DeepSpeed 可选择 Tutel 优化 dispatch/encode/decode。第三方优化改变内部表示和 kernel，但 gate、capacity、All-to-All、combine 的数学契约仍应保持。排查正确性时先用基础路径建立参考，再切优化实现。

## MoE 最常见的性能瓶颈

- gate imbalance：少数专家溢出、其余空闲；
- capacity padding：大量空 slot 仍通信/计算；
- All-to-All 跨慢网络；
- token 很少，消息受 latency 主导；
- local experts 太多，单 rank 参数/optimizer state 大；
- EP 与 DP/TP group 排列不符合硬件拓扑；
- ZeRO/precision 对专家参数走错 group。

应同时记录 expert counts、drop rate、All-to-All 时间、本地 expert compute 和 auxiliary loss。

## 本章实验：手算 dispatch

有 6 个 token、3 个专家、top-1、`capacity_factor=1.0`、最小容量忽略。Gate 选择：

```text
token:   0 1 2 3 4 5
expert:  0 0 0 1 1 2
```

1. 每专家容量 (C=2)；
2. 专家 0 的第三个 token 超容量；
3. 写出 `[E,C]` slot 中保存的 token id；
4. 计算各 expert count 与 drop rate；
5. 将 capacity factor 改为 1.5，重新计算。

源码导航：

```bash
rg -n '^class (MoE|TopKGate|MOELayer|Experts)' deepspeed/moe
rg -n 'capacity|drop_tokens|use_rts|l_aux|exp_counts' deepspeed/moe
rg -n 'all_to_all' deepspeed/moe tests/unit/moe
```

## 常见误区

- 只优化主 loss，忘记把 `l_aux` 加入训练。
- 把 `num_experts` 当每 rank 专家数。
- capacity 越大越好，忽略空 slot 成本。
- All-to-All 使用 world group，而不是 expert group。
- 只看平均 token 数，不看尾部最拥挤专家。
- top-2 只增加少量 gate 计算，却忽略 token dispatch 近似翻倍。

## 自测

1. 为什么 MoE 需要两次 All-to-All？
2. Capacity factor 如何同时影响质量、显存与吞吐？
3. EP group 和 expert-data-parallel group 有何不同？
4. Gate 已经使用 softmax，为什么仍需要辅助负载均衡损失？
