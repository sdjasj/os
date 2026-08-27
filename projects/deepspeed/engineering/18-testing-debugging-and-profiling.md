# 18. 测试、调试与性能分析：从单进程断言到分布式可执行规格

DeepSpeed 的 bug 常同时受 world size、dtype、stage、硬件和异步时序影响。有效方法是建立从纯函数到多进程、从正确性到性能的测试阶梯，并用 Engine/comm/accelerator 已有观测点定位，不从完整大模型训练开始猜。

## 仓库测试分层

| 层 | 目录/形式 | 适合验证 |
| --- | --- | --- |
| 纯单元 | `tests/unit/**` 普通 pytest | 配置、shape、映射、序列化、纯算法 |
| 分布式单元 | `DistributedTest` | collective、ZeRO partition、process group |
| Op 单元 | `tests/unit/ops/**` | 本地扩展输出、梯度、兼容性 |
| 集成/模型 | `tests/model/**` | 端到端功能与收敛 |
| 性能 | `tests/perf/**`、benchmark | 吞吐、延迟、带宽、内存 |

新功能应尽量把大部分契约压到低层、快速测试，再用少量端到端证据确认组合。

## `DistributedTest` 如何工作

[`tests/unit/common.py`](common.py) 的 `DistributedExec`/`DistributedTest` 不是普通 pytest 参数化。`tests/conftest.py` 的 hook 发现测试类标记后：

1. 实例化测试类；
2. 根据 `world_size` 创建多个进程；
3. 设置 rank/world/设备环境；
4. 初始化 `deepspeed.comm`；
5. 在每个 rank 执行同一 `test_*` 方法；
6. 汇总异常/skip；
7. 清理 process group 和子进程。

```python
from unit.common import DistributedTest


class TestCollectiveContract(DistributedTest):
    world_size = 2

    def test_result(self):
        ...
```

`world_size` 也可为列表，测试框架会覆盖多个规模；方法级 marker 能覆盖类默认。

## 为什么需要 `pytest --forked`

贡献指南要求 CUDA 分布式单元测试使用：

```bash
pytest --forked tests/unit/path/to/test_file.py
```

外层 fork isolation 防止一个测试留下的 CUDA/distributed 全局状态污染下一个测试。当前公共 import 已避免过早创建 CUDA context，使 forked 测试安全；这也是 `deepspeed/__init__.py` 设置 NVML 检查的背景。

测试内部还会选择 `forkserver`/`spawn` 处理不同 accelerator 的约束。

## 一个分布式断言应验证什么

不要只在 rank 0 验证“没报错”。以 ZeRO partition 为例应检查：

- 每 rank 本地 partition shape/value；
- gather 后完整值；
- owner update 后所有 rank 一致；
- padding 未进入真实参数；
- 不同 world size；
- accumulation boundary 前后；
- dtype 与 overflow；
- checkpoint round trip。

失败时打印 rank 和最小摘要，不输出整个大 tensor。

## 正确性基线的选择

性能优化应与最简单参考比较：

```text
同一初始 seed / state dict
同一输入 batch
reference PyTorch / stage 0
vs 新 ZeRO/TP/op/compile 路径
```

比较层级：

1. 单次 forward output；
2. scalar loss；
3. 每参数 gradient；
4. 一个 optimizer update 后参数；
5. 多步 loss trajectory；
6. 端到端收敛指标。

浮点并行 reduction 顺序不同，bitwise 相等通常不合理；误差阈值要按 dtype、规模和累计步数设计。

## 配置矩阵不要全排列

FP16/BF16 × stage 0/1/2/3 × offload × world size × optimizer 的笛卡尔积巨大。使用风险导向矩阵：

- 每个独立 feature 的最小 happy path；
- 每个已支持组合至少一个测试；
- 每个明确不支持组合一个错误测试；
- 过去出 bug 的边界做 regression；
- 默认配置和最常用生产配置优先。

参数化时给 case 有意义 id，失败日志才能定位组合。

## Hang 的系统排查

分布式“卡住”通常是某 rank 没到同一 collective。顺序：

1. 找最早异常/退出的 rank；
2. 确认所有 rank 的 global step/micro-step 相同；
3. 记录下一 collective 的 group、op、shape、dtype；
4. 检查条件分支、unused param、dataloader 长度；
5. 关闭 overlap/async 缩小时序复杂度；
6. 从多机缩到单机两 rank；
7. 开启 backend debug/comm logging；
8. 设置超时，避免 CI 永久挂起。

不要先在所有行加 barrier。Barrier 可能移动或掩盖竞态，并让根因离报错位置更远。

## NaN/overflow 的排查

按时间定位首个非有限值：

```text
input / parameter
  → forward activation
  → loss
  → scaled loss
  → local gradient
  → reduced gradient
  → unscaled/clipped partition
  → optimizer state
  → updated parameter
```

同时记录 loss scale、global grad norm、skipped step、LR 和 precision dtype。若 Stage 0 正常、Stage 2 异常，先比较 reduction 前后和 partition mapping；若 FP32 正常、FP16 异常，先比较 scaler/overflow。

## OOM 的阶段化分析

使用 accelerator memory API 和 `see_memory_usage()` 在少量边界采样：

```text
after model construction
after engine initialization
before/after forward
before/after backward
before/after step
before/after save
```

并区分 allocated、reserved、peak。每次实验重启进程或重置 peak，避免 allocator cache 让阶段比较失真。

OOM 优先修改与阶段直接相关的变量：forward activation 调 micro-batch/checkpoint，backward bucket 调 communication buffers，step 调 optimizer/offload，save 调 gather 策略。

## Engine timers 与 wall-clock breakdown

`wall_clock_breakdown=true` 会记录 forward、backward inner、backward reduce、step 等同步 timer。它能回答“慢在哪一阶段”，但 timer 同步本身有开销。

测量规范：

1. 丢弃 JIT、allocator、cache warm-up；
2. 固定 batch/sequence/model/并行度；
3. 多个稳定 step；
4. 报 median/percentile，而非单步；
5. 同时报 samples/s、tokens/s 与 peak memory；
6. 多 rank 报 max/straggler，不只 rank 0 平均。

## Communication logger

Comm logger 按 op、消息大小和耗时聚合，还能辅助 straggler 分析。由于 profiling 会同步：

- 先用短窗口定位；
- 不与正式吞吐结果混用；
- 将 op 时间与 Engine backward reduce timer 对照；
- 按消息大小判断 latency/bandwidth 区域。

如果 All-Reduce 总时间高，进一步问是消息多、消息大、某 rank 慢，还是 overlap 消失。

## Flops Profiler 的边界

Flops profiler 能统计 module 参数、MACs/FLOPs 和 forward latency，帮助找计算热点和 stage imbalance。它不自动包含所有通信、I/O、kernel fusion 和动态 control flow 成本。

理论 FLOPs 高但 GPU utilization 低，可能是 memory-bound、通信等待、小 kernel 或 CPU launch；不能只根据 FLOPs 排序优化。

## CI 与格式检查

DeepSpeed 的修改纪律：

```bash
pre-commit run --files <changed-file-1> <changed-file-2>
```

只检查实际修改文件，避免全仓无关改动。Hooks 包括 YAPF、flake8、license、禁止直接 torch distributed/CUDA 使用等。新源码需要 SPDX/DeepSpeed Team 头；提交需 `git commit --signoff`。

测试也应从精确文件开始：

```bash
pytest --forked tests/unit/runtime/test_ds_config_dict.py
pytest --forked tests/unit/comm/test_dist.py -k test_name
```

改核心 runtime/comm/accelerator 需要更广回归，但不是未经判断地一次跑完整 GPU suite。

## Diff-based CI selection

`ci/tests_fetcher.py` 从 merge-base 和 import graph 选择受影响测试；核心 runtime、shared fixtures、build/CI 等变动会回退全量。动态注入、JIT、registry 依赖通过 curated dynamic edges 补充。

本地可预览：

```bash
python ci/tests_fetcher.py --base origin/master
python ci/tests_fetcher.py --base origin/master --explain
```

它优化 CI 选择，不替代开发者对动态依赖的判断。

## 本章实验：写一份最小排障报告

选择一个虚构现象：“ZeRO-2 两卡第 17 step 卡住”。报告必须包含：

1. commit、PyTorch/DeepSpeed/accelerator/backend；
2. 最小 config 和 world size；
3. 最后成功的 micro/global step；
4. 每 rank 最后 collective 位置和 group；
5. 是否有最早异常 rank；
6. 关闭 overlap 后结果；
7. Stage 0/单卡对照；
8. 精确复现测试命令。

这份模板本身就是本章产物。

## 常见误区

- 从完整模型训练开始调试一个纯 partition 公式。
- 只在 rank 0 断言。
- 为排 hang 到处加 barrier。
- 性能对比包含首次 JIT/warm-up。
- 只报平均吞吐，不报最慢 rank 和峰值内存。
- 改功能只跑 happy path，不测 unsupported combination。
- 对全仓运行格式化，制造无关 diff。

## 自测

1. 为什么分布式测试需要同时验证 local partition 和 gathered result？
2. `pytest --forked` 解决哪类全局状态污染？
3. Comm profiling 为何可能降低被测吞吐？
4. OOM 发生阶段怎样指导你选择最先调整的配置？
