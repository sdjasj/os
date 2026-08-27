# 10. ZeRO-Offload 与 ZeRO-Infinity：CPU/NVMe 分层存储和流水化 I/O

当 GPU 聚合内存仍不足时，DeepSpeed 可以把 optimizer state、参数 partition 迁移到 CPU 或 NVMe。Offload 不是“把 tensor `.cpu()`”这么简单：它要让计算、PCIe 传输、主机内存、异步 I/O 和 optimizer update 形成可控流水线。

## 两类 offload 的适用范围

[`offload_config.py`](offload_config.py) 定义两个配置模型：

| 类型 | 可用 stage | 移出的状态 | 计算位置 |
| --- | --- | --- | --- |
| `offload_optimizer` | ZeRO 1/2/3 | master weights、moments、optimizer partitions | 通常 CPU optimizer update |
| `offload_param` | 仅 ZeRO 3 | 低精度 parameter partitions | 使用前 fetch 到 accelerator |

Optimizer offload 即使配置 `device=nvme`，optimizer 计算仍由 CPU 完成；NVMe 是更下层的状态存储，数据需分块换入主机内存。

## 存储层次的差异

```text
GPU HBM       容量小，带宽最高，kernel 直接访问
   ↕ PCIe / interconnect
CPU DRAM      容量较大，CPU optimizer 可直接访问
   ↕ async I/O
NVMe SSD      容量最大，延迟高、按块吞吐，不能直接做普通 optimizer 运算
```

Offload 的目标不是让慢层变快，而是通过 partition、buffer 和 overlap，让慢层传输尽量藏在 GPU 计算或其他分块更新背后。

## 参数 offload 配置

```json
{
  "zero_optimization": {
    "stage": 3,
    "offload_param": {
      "device": "cpu",
      "pin_memory": true
    }
  }
}
```

NVMe 版本还需要路径、buffer 和驻留限制：

```json
{
  "zero_optimization": {
    "stage": 3,
    "offload_param": {
      "device": "nvme",
      "nvme_path": "/path/to/local-nvme/deepspeed",
      "buffer_count": 5,
      "buffer_size": 100000000,
      "max_in_cpu": 1000000000,
      "pin_memory": true
    }
  }
}
```

`nvme_path` 应是本机专用高速盘，而不是所有节点竞争的普通网络目录。教程中的路径只是占位符。

## Optimizer offload 配置

```json
{
  "zero_optimization": {
    "stage": 2,
    "offload_optimizer": {
      "device": "cpu",
      "pin_memory": true,
      "fast_init": false,
      "ratio": 1.0
    }
  }
}
```

`ratio` 可表达部分 offload；`super_offload`、`cpuadam_cores_perc` 等字段控制当前提交中的更专门路径。使用前应从配置模型确认硬件/optimizer 约束，而不是照抄旧版本博客。

## Pin memory 为什么有用也有成本

Pinned host memory 不能被操作系统随意换页，DMA 可更高效地在 host/device 间传输。好处是提高并发拷贝和带宽；成本是：

- 占用不可分页内存；
- 分配成本较高；
- 过多 pinned buffer 会挤压系统；
- NUMA 放置错误会跨 socket 访问；
- 容器的 memlock/资源限制可能阻止分配。

因此 `pin_memory=true` 要与 buffer 数量、大小和主机内存预算一起评估。

## NVMe buffer pool

异步 I/O 不能让同一块 buffer 同时承担读、GPU/CPU 消费和写。系统维护多个 buffer，形成流水：

```text
buffer A: 从 NVMe 预取下一个 partition
buffer B: 当前 partition 在 CPU update
buffer C: 上一个 updated partition 写回 NVMe
```

`buffer_count` 太少无法覆盖各流水阶段，太多会占用大量 DRAM/pinned memory。optimizer state 的状态数也影响最小 buffer 数；例如 Adam 有参数、梯度、m、v 等多个逻辑 tensor。

## Tile / sub-group 为什么必要

模型极大时，即使只处理一个 flat group，其 FP32 optimizer state 也可能放不进 CPU 内存或可用 buffer。`sub_group_size` 将参数 partition 再切成 tile：

```text
for tile in optimizer_partition:
    swap in tile states
    apply CPU optimizer
    swap out updated tile
```

tile 小：峰值低，但 I/O 次数和启动开销高；tile 大：吞吐更好，但占用 DRAM/pinned buffer 更高。

## AIO 配置影响什么

DeepSpeed 的 AIO 路径通过本地扩展提交异步读写。典型配置涉及：

- block size；
- queue depth；
- single submit；
- overlap events；
- thread count。

这些参数必须匹配 SSD、文件系统和 I/O 大小。queue depth 很大但 buffer 不够，或 block size 与实际请求不匹配，都不会自动提高吞吐。

先用 `ds_report` 确认 async I/O op 是否兼容/安装，再讨论性能。

## 带宽下界估算

设每 step 必须从 NVMe 读写 (D) 字节，可持续双向有效带宽为 (B)，仅 I/O 下界约为：

\[
T_{io}\ge \frac{D}{B}
\]

若 GPU compute 只有 0.3 秒，而 I/O 下界 2 秒，无论怎样 overlap，step 仍至少暴露约 1.7 秒。优化前先做量纲估算，避免用线程数修复物理带宽不足。

## CPU optimizer 的核心绑定

CPUAdam 是多线程向量计算。性能受：

- 物理核心数和 SMT；
- NUMA socket 与 GPU/SSD 拓扑；
- 训练进程、dataloader worker、I/O thread 的核心竞争；
- 内存带宽；
- CPU frequency 和容器 quota。

多节点时每个 rank 都盲目使用全部 CPU cores 会互相争抢。当前配置中的 core percentage、launcher core binding 和环境线程数应统一规划。

## Offload 与 Stage 3 fetch 的组合

参数 partition 在 NVMe 时，一次模块 fetch 可能包含两跳：

```text
NVMe → CPU buffer → GPU gather buffer → module parameter
```

协调器预取的不只是 collective，还要提前触发 swap-in。若 trace 不稳定、prefetch 太晚或 CPU cache 太小，GPU 会等待 I/O，吞吐急剧下降。

`max_in_cpu` 控制多少参数元素可以留在 CPU 作为 NVMe 上层 cache。值大减少磁盘 I/O但占 DRAM；值小反之。

## 一个安全的实验阶梯

1. Stage 2，无 offload，确认训练正确；
2. Stage 2 + CPU optimizer offload，比较 state 位置和吞吐；
3. Stage 3 + CPU parameter/optimizer offload；
4. 使用本机空闲 NVMe，先小模型验证 AIO；
5. 再逐步增加模型和 buffer；
6. 同时记录 GPU utilization、PCIe、CPU、DRAM、disk bandwidth 和 step breakdown。

不要第一步就用多机 + Stage 3 + NVMe + 巨大模型；任何层出错都会表现为低利用率或 timeout。

## 本章实验：做一份资源预算

假设当前 rank 的 optimizer partition 为 12 GB、参数 partition 4 GB，CPU 可安全提供 32 GB，SSD 连续带宽 6 GB/s：

1. 估算 CPU-only offload 的最低 DRAM 占用；
2. 若用 5 个 400 MB parameter buffers，加上 4 个 1 GB optimizer buffers，buffer pool 多大；
3. 每 step 需读写 16 GB 时，I/O 时间下界多少；
4. compute 为 1.5 秒时，理论上最多能隐藏多少 I/O；
5. 哪些状态适合留在 `max_in_cpu` cache。

源码导航：

```bash
rg -n 'class DeepSpeedZeroOffload|buffer_count|buffer_size|max_in_cpu|ratio' \
  deepspeed/runtime/zero/offload_config.py
rg -n 'swap_in|swap_out|AsyncIO|aio' \
  deepspeed/runtime/swap_tensor deepspeed/runtime/zero deepspeed/ops/aio
```

## 常见误区

- 认为 NVMe offload 后 optimizer 直接在 SSD 上计算。
- 把网络文件系统路径当本地 NVMe。
- 无限增大 pinned buffer，不计算主机内存。
- 只看 GPU 显存下降，不看 step time 和磁盘写放大。
- CPUAdam 与 dataloader/I/O threads 争抢全部核心。
- I/O 下界已经超过 compute，却期待完全隐藏。
- 未安装 AIO op 就直接调 queue depth。

## 自测

1. `offload_param` 为什么只适用于 Stage 3？
2. NVMe optimizer offload 为什么仍依赖 CPU DRAM 和 CPU 计算？
3. `buffer_count`、`sub_group_size` 和 `max_in_cpu` 分别控制什么？
4. 什么情况下 offload 让模型能训练，却明显降低吞吐？
