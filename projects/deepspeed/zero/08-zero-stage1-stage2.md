# 08. ZeRO Stage 1/2 源码：flat group、梯度 bucket 与 owner update

Stage 1/2 共用 [`DeepSpeedZeroOptimizer`](stage_1_and_2.py)。它们的共同前提是每个 rank 长期保存完整低精度参数；区别在于 Stage 2 还分片梯度。源码的复杂性主要来自把原始参数组映射到 flat partition，并让 backward hook、reduction 与 optimizer step 使用同一份映射。

## 初始化时建立了哪些表示

对 basic optimizer 的每个 parameter group，ZeRO 大致建立：

```text
原始 bit16 parameters
  → flatten/aligned group
  → 按 DP world size 划分 partition
  → 当前 rank 的 fp32 master partition
  → optimizer param group 指向 master partition
```

关键结构可按语义理解：

- `bit16_groups`：用户模型中的低精度参数组；
- `bit16_groups_flat`：flatten 后的完整低精度 group 表示；
- `parallel_partitioned_bit16_groups`：按 rank 划分的低精度片；
- `single_partition_of_fp32_groups`：当前 rank 真正被 basic optimizer 更新的 FP32 master partition；
- 参数到 group、offset、partition owner 的映射；
- gradient accumulation / reduction bucket。

变量名随版本会演化，但这五种角色是读码的稳定锚点。

## 为什么先 flatten

若逐参数分片，大量小 tensor 会导致：

- optimizer 遍历和 Python 调用多；
- collective 消息小；
- partition 负载不均；
- checkpoint 元数据复杂；
- allocator 碎片。

Flatten 让一组参数成为连续区间，再按几乎等长的 partition 分给 ranks。一个原始参数可能完整属于某一 partition，也可能跨 partition 边界，映射表必须记录重叠区间。

## Stage 1 的主路径

Stage 1 不在 backward 中持久切梯度。概念流程是：

```text
每个 rank 得到完整模型梯度
  → 在 DP group reduction/average
  → 当前 rank 从 flat gradient 取自己的 partition
  → copy 到 FP32 master partition.grad
  → basic_optimizer.step() 只更新本 rank master partition
  → master partition 复制回 bit16 partition
  → All-Gather 所有 bit16 partitions
  → 每个 rank 的完整模型参数一致
```

省下的是其余 ranks 的 master weight 和 moments；完整低精度梯度仍存在。

## Stage 2 的主路径

Stage 2 在梯度 ready 时进入 `reduce_ready_partitions_and_remove_grads()` 一类路径：

```text
autograd 产生 param.grad
  → grad hook / reduce_ready...
  → 连续 IPG bucket
  → bucket 满或 backward 结束
  → Reduce-Scatter / partitioned reduction
  → 只保留当前 rank 拥有的 averaged gradient slice
  → 释放原 param.grad
```

到 step 时，owner gradient 已与 FP32 master partition 对齐，basic optimizer 只更新本 rank partition；随后同样 All-Gather 低精度参数。

Stage 2 的显存收益来自“梯度产生后尽早放进分片布局并释放原副本”，而不是在 step 末尾才切一次完整梯度。

## IPG bucket 是什么

IPG 可理解为 independent partition gradient bucket。它暂存已经 ready 的 gradients，达到 `reduce_bucket_size` 后发起 reduction。

若 `contiguous_gradients=true`，梯度被复制进连续 bucket；`overlap_comm=true` 时通常使用独立 reduction stream，并管理双 buffer/事件，避免下一批覆盖仍在通信的数据。

Bucket flush 的触发包括：

- 加入下一个 gradient 会超过容量；
- dtype 发生变化；
- backward epilogue 收尾；
- 特殊 module/unused parameter 路径；
- coalesced reduction context 退出。

## Reduce-Scatter 与 reduce-to-owner

配置 `reduce_scatter=true` 时，输入 bucket 按 partition 组织，collective 直接让每个 rank 获得求和后的片。其他兼容路径可能用 reduce 或组合操作完成相同 owner 语义。

需要满足：

- partition shape 在 ranks 间一致；
- reduction dtype 受支持；
- gradient average/predivide 规则一致；
- 每个 rank 以同样顺序处理参数；
- unused parameter 不让 collective 序列分叉。

`ignore_unused_parameters` 当前主要服务 Stage 2，因为其 hook/reduction 顺序对缺失梯度更敏感。

## 梯度累积增加了哪一维状态

GAS>1 时，optimizer 不能在每个 micro-step 丢弃当前 rank 已累积的 partition。源码需要区分：

- 当前 micro-step 刚 reduce 的 slice；
- 此前 micro-steps 的 accumulation buffer；
- 当前是否 accumulation boundary；
- 梯度应该 copy 还是 add；
- accumulation dtype。

Stage 2 的“每个 param.grad ready 就处理”与“多 micro-step 后才更新”并不矛盾：前者将每次局部结果放入 owner partition，后者控制何时消费累积结果。

## Step 的分阶段思考

阅读 `step()` 时将其拆为：

### 1. 准备

- 完成尚未结束的 reduction；
- 检查 overflow；
- 计算 partition/global grad norm；
- unscale 和 clip；
- 将 owner gradient 放到 FP32 master partition。

### 2. 更新

- basic optimizer 更新当前 rank 的 master partition；
- 清空 optimizer gradient；
- master partition 转回低精度 partition。

### 3. 重建

- All-Gather 或 broadcast updated partitions；
- 更新完整 bit16 flat group/原始参数 view；
- 释放临时 buffer，准备下一 step。

这个拆法有助于判断 OOM、NaN 或参数不一致发生在哪一段。

## 一个 10 元素 flat group 的 partition

world size 为 4 时，可用 ceiling 得到 partition size 3，总 flat storage padding 到 12：

```text
真实: [0 1 2 | 3 4 5 | 6 7 8 | 9]
补齐: [0 1 2 | 3 4 5 | 6 7 8 | 9 x x]
owner:   r0      r1      r2      r3
```

rank 3 optimizer state 仍为 3 元素，但只有第一个对应真实参数。保存/加载和 unflatten 时必须剔除 padding。

## 参数跨 partition 的情况

若某原始参数覆盖 flat offset 2 到 5，它横跨 rank 0 和 rank 1。Stage 2 reduction 不能假定“一个 Parameter 只有一个 owner”；映射会记录参数与多个 partition 的重叠，分别 narrow 对应 slice。

这解释了源码里 `param_to_partition_ids`、`grad_start_offset`、`first_offset` 等结构为何必要。

## 读测试而不是猜约束

```bash
find tests/unit/runtime/zero -maxdepth 2 -type f -name '*.py' | sort
rg -n 'stage.: [12]|zero_optimization.*stage' tests/unit/runtime/zero
rg -n 'contiguous_gradients|overlap_comm|reduce_scatter' tests/unit/runtime/zero
```

优先找小模型、`world_size=2`、明确比较参数/梯度的测试。性能测试不适合作为第一份正确性规格。

## 本章实验：画 flat-offset 表

假设三个参数 numel 分别是 3、4、5，总数 12，world size 2：

1. 写出 flat offsets；
2. 写出每 rank partition 范围；
3. 标出哪个参数跨边界；
4. 对每个参数写 owner partition ids 和局部 slice；
5. 模拟 rank 0/1 更新后 All-Gather 恢复完整 flat group。

再在源码中找相应映射建立位置：

```bash
rg -n 'partition_size|param_to_partition|grad_start_offset|first_offset' \
  deepspeed/runtime/zero/stage_1_and_2.py
```

## 性能调参的因果顺序

1. 先确认 stage 和数值正确；
2. 记录 backward compute、reduction、step、all-gather 时间；
3. 判断是 latency-bound 还是 bandwidth-bound；
4. 一次只改 `reduce_bucket_size` 或 `overlap_comm`；
5. 同时记录吞吐和峰值显存；
6. 多个稳定 step 后再比较，排除 JIT/warmup。

## 常见误区

- 认为 Stage 2 完全不产生完整梯度；autograd 会先产出局部参数梯度，但系统尽早处理并释放。
- 认为一个原始 Parameter 只属于一个 rank。
- 只看 reduction，忘记 step 后还要传播 updated parameter partitions。
- 把 padding 当作参数的一部分进入 loss/更新。
- GAS>1 时覆盖 accumulation buffer，而不是 add。
- 在所有模型上盲目增大 bucket。

## 自测

1. Stage 1 与 2 为什么能共享大部分 optimizer 实现？
2. Flatten 对通信、optimizer 和 checkpoint 各有什么收益？
3. Stage 2 在 backward 期间释放原梯度的前提是什么？
4. 一个参数跨 partition 时，owner 和 offset 应怎样表示？
