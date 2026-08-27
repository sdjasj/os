# 03. 性能与故障诊断：从症状到最小证据

大规模训练故障常互相伪装：一个 rank 的 Python 异常会让其他 rank 报 NCCL timeout；数据停顿会表现为 GPU 利用率低；错误精度会先表现为 loss spike。可靠方法是先建立可重复 baseline，再按控制流、shape、group、资源四层缩小。

## 先建立 baseline

任何调优前固定：

```text
commit + container image
GPU type/count/topology
model dimensions and precision
TP/PP/CP/EP/DP/SP
micro/global batch and sequence length
data mode (mock or real)
checkpoint/profile/log options
warmup and measured iteration range
```

至少记录 iteration time、tokens/s、MFU、peak memory、loss 和关键通信时间。只给“快了 8%”却不记录配置没有可复现意义。

## 分层观测

### 训练循环层

回答：慢在 data、forward/backward、optimizer、checkpoint 还是 evaluation？`training.py` timers 与 throughput 日志是入口。

### Schedule 层

回答：PP bubble、microbatch 数、send/recv wait、grad/param sync 是否占主要时间？

### Layer/kernel 层

回答：GEMM 尺寸、fused attention/MLP、LayerNorm、MoE dispatch 是否高效？需要 NVTX/Nsight 等 profiler。

### 系统层

回答：GPU clocks、NVLink/IB、CPU data loader、filesystem、NUMA 是否成为瓶颈？

不要一开始就查看单个 kernel，因为端到端慢可能根本没进入 GPU。

## Profile 窗口

应跳过初始化和最早 warmup iteration，只抓短稳定窗口。项目参数支持 profile start/end；选择 3～10 个代表 iteration，避免巨大 trace 和 profile 扰动。

源码中的 NVTX range（如 MLP `linear_fc1`/`activation`/`linear_fc2`）帮助把 kernel 映射回模块。新增 range 时保持 rank/层名可解释，并确认不会破坏 CUDA graph capture。

## OOM 诊断

先记录：

```text
rank and GPU
forward/backward/optimizer/checkpoint phase
allocated/reserved/peak memory
B,S,H,layers and parallel sizes
recompute/offload/FSDP/DistOpt settings
是否只有某个 PP/EP rank OOM
```

按账本分类：

- 所有 stage 相似：microbatch、sequence、通用激活；
- 某 PP stage：层数不均、embedding/output、MTP；
- 某 EP rank：router 负载倾斜；
- optimizer step：master params/state 或 param gather；
- save/load：checkpoint staging 与临时 buffer。

逐项改变一个变量，不同时打开多个省显存开关。

## Hang/NCCL timeout

排查顺序：

1. 收集所有 rank stderr；
2. 按时间找最早非 NCCL Python/CUDA 错误；
3. 若无，核对每 rank 当前 collective、group、shape、peer；
4. 检查某 rank 是否卡在 data/I/O/checkpoint；
5. 检查 master address、端口、allocation、网络；
6. 只在证据指向通信层时提高 NCCL 日志。

最后一个 timeout rank 很少是最先出错的 rank。

## NaN、Inf 与 loss spike

区分：

```text
data problem: invalid token/mask/label
forward numeric: attention logits, norm, overflow
backward numeric: grad overflow, bad scaling
optimizer: LR/state/update
distributed inconsistency: one rank diverges before reduction
```

项目可启用 local loss NaN/Inf 检查与 spiky loss rerun state machine。在 DP all-reduce 前检查 local loss 很重要，否则一个 rank 的 NaN 会污染全组并丢失来源。

诊断动作：降低 LR/固定 batch 只是定位手段，不是自动修复。要比较第一个异常 tensor、rank 和 iteration。

## 低利用率决策树

```text
GPU idle?
  yes -> CPU/data/I/O/synchronization/PP bubble
  no  -> kernels small or memory-bound?
           small -> TP过大、microbatch过小、shape不友好
           memory -> fusion、SP/CP、layout、dtype
       communication exposed?
           -> topology、bucket、overlap window、负载倾斜
```

先缩小瓶颈类别，再调旋钮。

## 推荐调优顺序

1. 用 mock data 排除 I/O；
2. 验证正确性与稳定 loss；
3. 选择能放下的最小 TP/PP/CP；
4. 调 microbatch 与 microbatch count；
5. 开启支持的 fused/precision path；
6. 再尝试 communication overlap；
7. 若内存不足，按成本选择 SP/CP/recompute/DistOpt/FSDP；
8. 回到真实数据验证端到端。

每步保存前后配置和 profile 证据。

## 实验：对比矩阵

在小模型上设计单变量实验：

| Run | 变化 | 预期 | 实测项 |
| --- | --- | --- | --- |
| A | baseline | 基线 | time/memory/MFU |
| B | TP 2→4 | 内存降、通信升 | GEMM size/TP comm |
| C | micro 2→1 | activation 降 | kernel 利用/bubble |
| D | recompute on | memory 降 | extra forward time |
| E | grad overlap | exposed comm 降 | overlap timeline |

若两项同时变化，结果不能归因。

## 自测

1. 为什么 profile 要避开初始化和早期 warmup？
2. 只有某个 EP rank OOM 最可能先检查什么？
3. NCCL timeout 的第一证据为什么是所有 rank 日志？
4. NaN 为什么应在 DP reduction 前检查？
5. 调优为什么要坚持单变量对比？

## 源码定位

- [training timers/logging](https://github.com/NVIDIA/Megatron-LM/blob/e79cb4c1bae1afd04322d979d08cb63832991ebe/megatron/training/training.py)
- [StragglerDetector](https://github.com/NVIDIA/Megatron-LM/blob/e79cb4c1bae1afd04322d979d08cb63832991ebe/megatron/core/utils.py)
- [rerun state machine](https://github.com/NVIDIA/Megatron-LM/blob/e79cb4c1bae1afd04322d979d08cb63832991ebe/megatron/core/rerun_state_machine.py)
- [observability docs](https://github.com/NVIDIA/Megatron-LM/tree/e79cb4c1bae1afd04322d979d08cb63832991ebe/docs/user-guide/observability)

最后一章把本机练习扩展到 SLURM，并给出继续学习和贡献路线。
