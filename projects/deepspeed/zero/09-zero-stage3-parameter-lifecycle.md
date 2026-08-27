# 09. ZeRO Stage 3 源码：参数状态机、hook 与预取释放

ZeRO-3 连模型参数也分片。模块里的 `torch.nn.Parameter` 仍然存在，但完整 `.data` 不再长期驻留；执行某个模块前必须 fetch，计算完成后再按复用策略 release。Stage 3 因而更像参数虚拟内存系统，而不只是 optimizer 分片。

## 四个核心组件

从职责而非文件名理解：

| 组件 | 代表文件 | 职责 |
| --- | --- | --- |
| 参数改造与初始化 | `partition_parameters.py` | 给 Parameter 添加 ZeRO 元数据、立即 partition、提供 gather API |
| 模块 hook/offload | `parameter_offload.py` | 在 forward/backward 边界触发 fetch/release |
| 参数协调器 | `partitioned_param_coordinator.py` | 追踪执行序列、预取、驻留量和复用距离 |
| Stage 3 optimizer | [`stage3.py`](stage3.py) | 梯度 partition、FP32 flat partition、optimizer step、swap/checkpoint |

Engine 构造 Stage 3 optimizer 后，这四部分共同维护参数生命周期。

## Parameter 被增加了什么语义

普通 Parameter 主要有 `.data`、`.grad`、shape/dtype。ZeRO parameter 还会记录类似：

- 全局唯一 `ds_id`；
- 原始 `ds_shape` 与 `ds_numel`；
- 本 rank partition `ds_tensor`；
- process group；
- 当前可用状态；
- 是否 persistent、external、active；
- partition/offload/swap 元数据。

因此调试 Stage 3 时，`param.numel()==0` 或 `.data` 很小不表示模型真的没有权重；应查看 `ds_shape`、`ds_numel` 和 `ds_tensor`。

## 参数状态机

概念状态可以写成：

```text
NOT_AVAILABLE
   | fetch / all-gather
   v
INFLIGHT
   | handle complete
   v
AVAILABLE
   | release / partition
   v
NOT_AVAILABLE
```

同时还要区分 partition 本身是在 GPU、CPU 还是 NVMe。状态转移必须尊重异步 handle；在 INFLIGHT 时重复 fetch 或提前 release 都会破坏数据。

## `zero.Init` 为什么必要

若模型巨大到单个进程不能先构造完整 FP32 权重，再在 Engine 初始化时分片，那么“先完整创建、后切分”已经太晚。[`Init`](partition_parameters.py) context 会拦截参数创建过程：

1. 选择创建/remote device 和 dtype；
2. 参数构造后立即广播必要初值；
3. 记录全局 shape/numel；
4. 只保留当前 rank partition；
5. 可替换 memory-efficient linear 路径。

```python
import deepspeed

with deepspeed.zero.Init(config_dict_or_path=config):
    model = HugeModel()
```

这样模型大小由聚合内存决定，而不要求每个进程都经历完整副本峰值。

## Forward 前后的生命周期

对一个子模块，概念顺序是：

```text
pre-forward hook
  → coordinator.fetch_sub_module(module)
  → gather module 所需参数
  → 等待依赖完成

module.forward

post-forward hook
  → 记录执行 trace / reuse
  → 若不需近期复用，release params
```

Backward 还需要重新获得 forward 后已释放的参数，用来计算输入梯度和参数梯度；因此有 pre-backward/post-backward hook。协调器必须理解模型执行次序，才能预取下一个模块并决定当前参数何时安全释放。

## Prefetch 与 reuse distance

只在调用前同步 gather 会暴露全部通信延迟。Stage 3 根据执行 trace 提前取未来模块参数：

```text
compute layer k
comm stream fetch layer k+1 / k+2
```

相关约束：

- `stage3_prefetch_bucket_size`：最多提前取多少元素；
- `stage3_max_live_parameters`：GPU 同时驻留参数上限；
- `stage3_max_reuse_distance`：预计很快复用的参数可暂不释放；
- `stage3_param_persistence_threshold`：小参数可不分片，减少小消息；
- `stage3_model_persistence_threshold`：所有 persistent 参数总量上限。

调大 prefetch/reuse 阈值通常提高重叠、减少重复通信，但占用更多显存。

## Trace cache 为什么会失效

动态控制流可能让本轮模块执行序列与上轮不同：条件分支、MoE routing、递归/共享模块、训练和评估路径切换等。协调器用 trace 预取时必须检测不一致并重建；否则可能取错参数或错过释放。

`log_trace_cache_warnings` 用于暴露这些 invalidation。出现频繁 invalidation 时，先理解模型动态性，不要只继续增大 prefetch。

## External parameter

正常情况下，模块在自己的 forward 中使用自己的参数，hook 能推断生命周期。但以下模式会越界：

```python
def forward(self, hidden):
    return torch.nn.functional.linear(hidden, other_module.weight)
```

`other_module.weight` 对当前模块是 external parameter。DeepSpeed 提供自动发现和显式 `register_external_parameter(module, param)`，确保当前模块执行期间参数保持 available。

权重 tying、返回参数供外层使用、函数式调用都要警惕这个边界。

## `GatheredParameters` 的正确使用

需要在 Stage 3 下读取/修改完整参数时：

```python
with deepspeed.zero.GatheredParameters(
    [module.weight],
    modifier_rank=0,
):
    if dist.get_rank() == 0:
        module.weight.data.zero_()
```

context 进入时 gather，退出时 broadcast 修改并重新 partition。若会修改参数，应给 `modifier_rank`，既保证各 rank 一致，也使退出时完整 GPU storage 能正确释放。

不要在训练热路径频繁手工 gather 大量参数；这会绕开协调器的预取收益并制造显存峰值。

## Stage 3 梯度路径

参数 gradient ready 后：

1. 检查/累计梯度；
2. 加入 reduction bucket；
3. Reduce-Scatter 得到当前 rank gradient partition；
4. 释放原始 full gradient；
5. 在 accumulation boundary 将 partition 对齐到 FP32 flat group；
6. basic optimizer 更新本 rank state；
7. 低精度 parameter partition 更新，不需长期 All-Gather 全模型。

相比 Stage 2，最后一步不再恢复所有参数的完整常驻副本。

## Leaf module 与动态子图

MoE 等模型可能只让部分 rank 执行某些子模块，导致 hook 顺序不同、collective 次序不一致。ZeRO leaf module 把某个父模块视为整体：在进入时一次 gather 所有后代参数，避免按动态子模块顺序逐个 fetch。

代价是更大的 gather 和驻留峰值，所以 leaf 应标在真正需要收敛动态执行边界的层级，而不是整个模型。

## 保存模型为何要显式 gather

Stage 3 的普通 `state_dict()` 中参数不一定是完整权重。`stage3_gather_16bit_weights_on_model_save` / `gather_16bit_weights_on_model_save` 控制保存 16-bit 模型时是否聚合。打开后方便获得常规模型文件，但可能制造接近完整模型大小的内存和通信峰值。

另一条路线是保存 ZeRO 分片 checkpoint，离线或通过 universal checkpoint 工具重建。

## 本章实验：跟踪一个参数

选择一个两层模型，在每个关键点记录：

```python
def describe(param):
    return {
        "shape": tuple(param.shape),
        "numel": param.numel(),
        "ds_shape": tuple(getattr(param, "ds_shape", ())),
        "ds_numel": getattr(param, "ds_numel", None),
        "status": str(getattr(param, "ds_status", None)),
        "partition_numel": getattr(getattr(param, "ds_tensor", None), "numel", lambda: None)(),
    }
```

分别在 `zero.Init` 后、Engine 初始化后、`GatheredParameters` 内外记录。不要在 forward hook 中做大规模同步打印；先用单个参数、小 world size 验证状态。

静态追踪：

```bash
rg -n 'class (Init|GatheredParameters|ZeroParamStatus)' \
  deepspeed/runtime/zero/partition_parameters.py
rg -n 'fetch_sub_module|release_sub_module|prefetch' \
  deepspeed/runtime/zero/partitioned_param_coordinator.py
rg -n 'register_external_parameter|leaf' deepspeed/runtime/zero
```

## 常见误区

- 看见 `param.numel()==0` 就认为参数丢失。
- 在 `GatheredParameters` 中修改参数却不指定 modifier rank。
- 把所有参数都设 persistent，最后退化成高显存常驻。
- 动态模型频繁 trace invalidation，却只调 bucket。
- 在热路径手工 gather 全模型。
- 认为 Stage 3 save 与普通 `torch.save(model.state_dict())` 完全等价。

## 自测

1. `Parameter` Python 对象存在，为什么其完整数据仍可不在 GPU？
2. prefetch bucket、max live parameters 和 reuse distance 如何相互制约？
3. external parameter 为什么会破坏普通 module hook 的生命周期推断？
4. leaf module 解决什么一致性问题，代价是什么？
