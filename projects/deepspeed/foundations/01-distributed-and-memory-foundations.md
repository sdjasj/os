# 01. 背景补课：分布式训练、collective 与显存账本

读 DeepSpeed 前最重要的准备不是记 API，而是能为一个参数写出完整显存账本，并能说清 All-Reduce、Reduce-Scatter、All-Gather 改变了什么。ZeRO 的每个 stage 都只是对这两套基础模型的重新编排。

## 单卡训练到底保存了什么

设模型有 (P) 个参数元素，采用低精度权重和 Adam 类优化器。一个常见的近似账本是：

| 状态 | 每元素字节 | 说明 |
| --- | ---: | --- |
| FP16/BF16 模型参数 | 2 | 前向和反向使用 |
| 低精度梯度 | 2 | 反向产生 |
| FP32 master parameter | 4 | 稳定更新低精度权重 |
| Adam 一阶矩 | 4 | momentum |
| Adam 二阶矩 | 4 | variance |
| 合计 | 16 | 尚未包含激活、临时 buffer 与碎片 |

所以仅模型状态约为 (16P) 字节。十亿参数对应约 16 GB，这还没有算 activation、attention 中间量、通信 bucket、CUDA context 和 allocator 保留空间。

这个 16 字节不是所有配置下的绝对常数。BF16 optimizer state、无 master weight 的路径、SGD、量化和 fused 实现都会改变账本。正确方法是先确认当前优化器 wrapper 实际持有哪些张量，再代公式。

## 激活为什么是另一条轴

模型状态主要随参数量增长；激活主要随以下量增长：

\[
\text{activation} \propto
\text{micro batch}\times\text{sequence length}\times
\text{hidden size}\times\text{layers}
\]

ZeRO 主要消除状态冗余，不会自动消除全部 activation。出现 OOM 时要先区分：

- 初始化就 OOM：多半是参数构造、权重加载或 optimizer state；
- forward 中 OOM：多半是 activation 或临时 kernel workspace；
- backward 中 OOM：可能是 activation、梯度 bucket 或通信重叠峰值；
- step 中 OOM：可能是 master weights、optimizer states 或参数 gather；
- save 时 OOM：可能是 ZeRO-3 权重聚合。

[运行时工具](utils.py) 中的 `see_memory_usage()` 同时采集 accelerator 已分配/峰值和 CPU virtual memory。它适合定位阶段边界，但日志本身也会同步或增加开销，不应无节制地放在热路径。

## 数据并行的基本语义

设 (N) 个数据并行 rank 以相同参数 (w) 处理不同 micro-batch，rank (i) 得到局部梯度 (g_i)。同步数据并行需要：

\[
g=\frac{1}{N}\sum_{i=0}^{N-1}g_i
\]

然后每个 rank 使用相同的 (g) 更新相同的 (w)，才能保持副本一致。普通 DDP 让每个 rank 保存完整参数、梯度和优化器状态，因此计算吞吐扩展了，状态显存却仍然重复 (N) 份。

## 四个必须分清的 collective

### All-Reduce

每个 rank 提供等形状张量，先做 reduce，再让所有 rank 得到结果：

```text
rank 0: [a0, a1] ─┐
rank 1: [b0, b1] ─┼─ sum ─→ 每个 rank 都得到 [a0+b0, a1+b1]
rank 2: [c0, c1] ─┘             再加 rank 2 对应元素
```

普通数据并行用它同步完整梯度。

### Reduce-Scatter

先 reduce，再把结果切成 (N) 片；每个 rank 只得到一片。它正好符合“梯度已求和，但后续只由拥有该 partition 的 rank 更新”的 ZeRO 语义。

### All-Gather

每个 rank 提供自己的 partition，所有 rank 拼出完整张量。ZeRO-1/2 更新各自拥有的参数片后，需要重建低精度参数副本；ZeRO-3 在模块计算前也会获取所需参数。

### All-to-All

每个 rank 给每个目标 rank 发不同片段，同时接收来自所有源 rank 的片段。Sequence Parallel 与 MoE token dispatch 常用它，数据重排语义与求和不同。

一个常见实现视角是：All-Reduce 可以分解为 Reduce-Scatter + All-Gather。ZeRO 利用这个结构，在中间阶段不再强制每个 rank 保存完整结果。

## 延迟、带宽与消息大小

一次通信的粗略时间模型是：

\[
T \approx \alpha + \frac{S}{B}
\]

- (alpha)：启动延迟，很多小消息时占主导；
- (S)：消息字节数；
- (B)：有效带宽，大消息时占主导。

这解释了 bucket 的存在：把许多小梯度合并成更大的通信，减少启动次数；但 bucket 太大又会增加峰值内存，并推迟第一批通信，降低与 backward compute 的重叠。

因此 `reduce_bucket_size`、`allgather_bucket_size` 和 `overlap_comm` 不是“越大/越开越快”的独立旋钮，而是在延迟、带宽、显存和依赖关系之间找平衡。

## 全局 batch 公式

DeepSpeed 配置把三个 batch 概念和数据并行规模联系起来：

\[
B_{train}=B_{micro}\times GAS\times N_{dp}
\]

例如每卡 micro-batch 为 2、梯度累积 4 步、数据并行 8 路，则一次 optimizer update 对应 64 个样本。

注意 (N_{dp}) 不是总 GPU 数。若 16 张卡组成 TP=2、PP=2 的 3D 并行，数据并行规模通常是：

\[
N_{dp}=\frac{16}{2\times2}=4
\]

因此全局 batch 是 (2\times4\times4=32)，不是 128。

## 梯度累积与通信时机

最朴素的梯度累积在每个 micro-batch 反向后保留局部梯度，到边界再同步和更新。DeepSpeed 的具体时机取决于 stage 和 `managed_gradient_accumulation`：

- stage 0/1 可以在边界做完整梯度 reduction；
- stage 2/3 的梯度 partition 与 backward hook 紧密耦合，可能在梯度就绪时分桶处理；
- 默认 managed 模式由 Engine 的 `micro_steps` 决定边界；
- unmanaged 模式由调用方何时执行 `step()` 声明边界。

这也是 `no_sync` 不能简单用于 ZeRO-2/3 的原因：它们不只是“同步得早一点”，而是依赖 reduction 完成梯度分片布局。

## ZeRO 三阶段的近似账本

用前述 2 字节参数、2 字节梯度和 12 字节 FP32 optimizer/master state 估算：

| 模式 | 每 rank 模型状态近似 |
| --- | --- |
| 普通 DP | (16P) |
| ZeRO-1 | (4P + 12P/N) |
| ZeRO-2 | (2P + 14P/N) |
| ZeRO-3 | (16P/N) + 动态 gather/buffer |

解释：

- Stage 1 只切 12P 的 optimizer/master state，参数和梯度仍复制；
- Stage 2 再切 2P 梯度，只保留 2P 参数副本；
- Stage 3 连 2P 参数也切开，但计算时会产生临时完整模块参数。

这些是理解趋势的下界近似，不是 `nvidia-smi` 预测器。alignment padding、fragmentation、activation、communication buffer、allocator cache 和 optimizer 变体都会产生差异。

## 参数、梯度和优化器状态的生命周期

读源码时不要只问“张量在哪”，还要问“什么时候在哪”：

```text
参数：持久副本 / partition → 计算前 gather → forward/backward 使用 → release
梯度：autograd 产生 → hook 捕获 → bucket → reduce/partition → optimizer 消费 → 清空
优化器状态：初始化/懒创建 → owner rank 更新 → checkpoint 分片保存
```

ZeRO-3 的核心复杂性来自时间维度：单个 `Parameter` Python 对象仍在模块里，但其 `.data` 可能只是 placeholder，真实 partition 在 `ds_tensor`，状态由 `NOT_AVAILABLE / INFLIGHT / AVAILABLE` 一类标记约束。

## 本章实验：手算与源码互证

假设模型有 7B 参数、低精度权重、Adam，数据并行规模为 8：

1. 用四种公式估算每 rank 的模型状态下界。
2. 将结果与 80 GB GPU 比较，但另留 activation 和 bucket 空间。
3. 在源码中查找内存估算函数：

```bash
rg -n 'estimate_zero|see_memory_usage|model_to_params' deepspeed/runtime
rg -n 'reduce_bucket_size|allgather_bucket_size' deepspeed/runtime/zero
```

4. 说明为什么 Stage 3 的公式看似能放下，不代表 forward 峰值一定能放下。

参考估算：Stage 0 约 112 GB；Stage 1 约 38.5 GB；Stage 2 约 26.25 GB；Stage 3 约 14 GB。实际值会更高。

## 常见误区

- 把总 GPU 数直接代入 batch 公式。应使用数据并行组大小。
- 认为 ZeRO 会按同样比例降低 activation。ZeRO 主要处理模型状态。
- 只看参数 dtype。优化器可能仍保存 FP32 master weights 和 moments。
- 认为 bucket 只影响速度。它也改变峰值显存和通信开始时机。
- 认为 All-Gather 后参数会永久完整。ZeRO-3 的完整参数通常只是短暂驻留。

## 自测

1. 为什么 ZeRO-1 的参数和梯度项仍是 (4P)？
2. Reduce-Scatter 与 All-Reduce 的输出布局有何区别？
3. 为什么很多小 collective 即使总字节相同也更慢？
4. OOM 发生在 save 阶段时，为什么不能只调小 micro-batch？
