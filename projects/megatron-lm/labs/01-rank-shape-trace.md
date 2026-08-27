# 01. Rank/Shape 追踪实验：给一次 forward 建三张账本

本实验不追求大吞吐，而是让你能解释“某个 rank 在某个时刻持有什么”。完成后，多数 shape error、group mismatch 与 OOM 都能被系统定位。

## 实验配置

先做纸面配置：

```text
WORLD_SIZE=8
TP=2, PP=2, CP=1, DP=2
layers=4, H=256, heads=8, F=1024
S=128, micro_batch=2, global_batch=8
```

由 batch 公式：

```text
num_microbatches = 8 / (2 * 2) = 2
```

均匀 PP 时每 stage 两层。

## 账本一：rank 坐标

建立表：

| global rank | dp | pp | cp | tp | stage role |
| ---: | ---: | ---: | ---: | ---: | --- |
| 0 |  |  | 0 |  |  |
| ... |  |  | 0 |  |  |

你需要先从当前 rank generator 顺序确认坐标映射，不能凭假设填写。然后为每个 rank 列 TP、PP、DP group。

```bash
rg -n "RankGenerator|initialize_model_parallel" \
  megatron/core/parallel_state.py
```

## 账本二：张量形状

为一个 microbatch 填写：

| 节点 | 全局逻辑形状 | 本 rank 形状 | 所在 stage |
| --- | --- | --- | --- |
| tokens | `[2,128]` |  | PP first |
| embedding | `[128,2,256]` |  | PP first |
| Q heads | `[128,2,8,32]` | `[128,2,4,32]` | local |
| MLP fc1 | `[128,2,1024]` | `[128,2,512]` | local |
| PP activation | `[128,2,256]` |  | stage boundary |
| vocab logits | `[128,2,V]` | `[128,2,V/2]` | PP last |

再写 backward 的相反方向 gradient 形状。

## 账本三：通信

| 时刻 | collective/P2P | group | tensor | 原因 |
| --- | --- | --- | --- | --- |
| batch | broadcast | TP | tokens/labels subset | TP 同伴需一致输入 |
| attention proj end | all-reduce/RS | TP | `[S,B,H]` | 合并 row shards |
| PP boundary | send/recv | PP peers | activation | 下一 stage 输入 |
| final grads | AR/RS | DP | grad buckets | 合并不同样本 |

对每条通信再标 forward/backward 与是否可 overlap。

## 安全 instrumentation

不要在所有层、所有 rank 无限制打印。可写一个临时 helper：

```python
def trace_tensor(name, tensor, *, ranks=(0,)):
    rank = torch.distributed.get_rank()
    if rank in ranks:
        print(
            f"rank={rank} name={name} "
            f"shape={tuple(tensor.shape)} dtype={tensor.dtype}"
        )
```

只打印 shape/dtype，不打印 token 内容、数据路径或大 tensor。调试改动不提交。

## 用 hook 观察模块边界

PyTorch forward hook 可观察输入输出，但 wrapper/tuple/bias 需要处理：

```python
def shape_of(value):
    if isinstance(value, torch.Tensor):
        return tuple(value.shape)
    if isinstance(value, (list, tuple)):
        return [shape_of(item) for item in value]
    return type(value).__name__
```

只给一个 layer 的 `self_attention`、`mlp` 注册 hook。CUDA graph、compile 或 fused module 场景下 hook 可能改变执行行为，所以它只用于小型 debug 路径。

## 验证数据所有权

PP first rank 应有 tokens/position；PP last rank 应有 labels/loss mask。中间 stage 在无 packed/MTP 时可拿 None。对照 `get_batch_on_this_tp_rank` 的分支，检查你的账本是否符合。

## 加入 SP/CP 的第二轮

第一轮闭合后改成：

```text
WORLD_SIZE=8, TP=2, PP=1, CP=2, DP=2, SP=True
```

重新回答：

- SP 区域 sequence 是否变 `[S/TP,B,H]`；
- CP 后本地 token sequence 大小；
- 哪些通信用 TP group，哪些用 CP group；
- global batch 是否改变。

## 故意制造一个可控错误

只在本地练习分支把 heads 改成不能被 TP 合理切分的值，观察：

1. 哪个 rank 最先抛出错误；
2. 最早 traceback 是配置校验还是 layer shape；
3. 其他 rank 是否出现派生 NCCL 错误；
4. 恢复配置后确认所有进程干净退出。

不要在共享训练作业或重要 checkpoint 目录做故障注入。

## 自测

1. 三张账本各自回答什么？
2. 为什么 rank 坐标顺序必须从当前代码确认？
3. PP first/last 的 batch 所有权有何不同？
4. Hook 为什么可能改变 optimized 路径行为？
5. 加入 CP 后 global batch 公式为何不变？

## 源码定位

- [parallel_state.py](https://github.com/NVIDIA/Megatron-LM/blob/e79cb4c1bae1afd04322d979d08cb63832991ebe/megatron/core/parallel_state.py)
- [batch distribution](https://github.com/NVIDIA/Megatron-LM/blob/e79cb4c1bae1afd04322d979d08cb63832991ebe/megatron/core/utils.py)
- [TP layers](https://github.com/NVIDIA/Megatron-LM/blob/e79cb4c1bae1afd04322d979d08cb63832991ebe/megatron/core/tensor_parallel/layers.py)
- [PP schedules](https://github.com/NVIDIA/Megatron-LM/blob/e79cb4c1bae1afd04322d979d08cb63832991ebe/megatron/core/pipeline_parallel/schedules.py)

下一章用测试体系把纸面不变量变成可执行规格。
