# 17. Accelerator 与 OpBuilder：跨硬件抽象和自定义算子生命周期

DeepSpeed 支持 CUDA/ROCm、CPU、XPU、HPU、NPU 等设备。上层 runtime 通过 Accelerator 获取设备、stream、event、内存和通信后端；性能扩展通过 OpBuilder 描述源码与构建。两层共同把“算法编排”与“硬件实现”分开。

## Accelerator 是能力接口，不只是 device string

`DeepSpeedAccelerator` 的契约覆盖：

```text
设备：device_name/current_device/set_device/device_count
通信：communication_backend_name
并发：Stream/Event/current_stream/default_stream
同步：synchronize/resolves_data_dependency
内存：memory_allocated/max_memory_allocated/empty_cache
随机：get_rng_state/set_rng_state/manual_seed
dtype：supported_dtypes/is_fp16_supported/is_bf16_supported
编译：op_builder_dir/create_op_builder/get_compile_backend
可见性：visible_accelerator_envs/set_visible_devices_envs
```

这说明替换 `torch.cuda` 不是简单字符串搜索。每个平台的 stream 依赖、内存统计、设备可见变量和 compiler backend 都可能不同。

## 选择具体 accelerator

[`real_accelerator.py`](real_accelerator.py) 维护全局 singleton。首次 `get_accelerator()` 时根据显式 override、已安装的 accelerator 包和平台探测选择实现，并缓存对象。

导入时过早探测设备可能创建 context，因此公共包先设置 NVML-based CUDA check 默认值。自定义 accelerator 应让轻量探测与实际 context 初始化分离。

调试第一步：

```python
from deepspeed.accelerator import get_accelerator

accelerator = get_accelerator()
print(type(accelerator).__name__)
print(accelerator.device_name())
print(accelerator.communication_backend_name())
print(accelerator.supported_dtypes())
```

## Stream/Event 抽象为何重要

ZeRO overlap、参数预取和 offload 依赖 compute stream、communication stream、copy stream 之间的 event：

```text
compute produces gradient
  → event
comm stream waits → Reduce-Scatter
  → event
optimizer/copy waits → consume partition
```

某些 accelerator 自动解析数据依赖，某些需要显式 synchronize/event。Runtime 通过 `resolves_data_dependency()` 等能力决定是否额外同步。

错误实现可能有两种极端：少同步导致竞态，多同步导致所有 overlap 消失。

## 内存 API 是诊断契约

`see_memory_usage()` 不直接假定 CUDA，而调用 accelerator 的 allocated/reserved/max memory 接口。新设备实现若返回含义不同，OOM 日志和 profiler 会误导。

需要区分：

- 当前 tensor 实际 allocated；
- allocator reserved/cache；
- 进程/设备全局使用；
- 历史 peak；
- reset peak 的副作用。

## OpBuilder 的角色

[`OpBuilder`](../op_builder/builder.py) 是本地扩展的构建规格。具体 builder 至少定义：

- `absolute_name()`：Python 导入名；
- `sources()`：C++/CUDA/HIP 源码；
- `include_paths()`；
- `cxx_args()` / `nvcc_args()`；
- `is_compatible()`；
- build-time 环境变量名；
- 可选 hipify/SYCL 转换。

`load()` 先尝试已安装 op，版本匹配则导入；否则进入 `jit_load()`，由 PyTorch extension loader 编译并缓存。

## 预编译与 JIT 的状态机

```text
调用 Python op wrapper
  → builder.load()
      ├─ compatible op 已随 wheel 安装
      |    → 校验 torch/CUDA/HIP 版本 → import
      └─ 未安装
           → is_compatible
           → 收集源码/flags
           → JIT compile + link
           → import cached module
```

任何一步失败都应有不同诊断：

| 阶段 | 常见失败 |
| --- | --- |
| compatibility | 缺头文件/库、平台不支持 |
| compile | compiler 缺失、架构/flag 错、资源不足 |
| link | ABI、库路径、符号缺失 |
| import | Python/Torch/CUDA 版本与构建时不匹配 |
| runtime | kernel shape/dtype/device 不支持 |

## CUDA/ROCm 版本校验

Builder 比较系统 toolkit 与 `torch.version.cuda/hip`。同一 major 的某些 minor 组合可接受；major mismatch 通常直接失败。

`DS_SKIP_CUDA_CHECK=1` 只让构建继续，不会修复编译器、头文件或 ABI。只有在理解兼容性并有完整测试时才考虑使用。

## Compute capability 与可移植 wheel

预编译 CUDA op 要决定目标 GPU architectures。只编当前设备架构，wheel 较小但不能移到其他 GPU；包含多个架构，构建慢、产物大。JIT 可按当前机器生成，但在多节点共享缓存/异构 GPU 场景仍需规划。

发布构建应明确目标矩阵，不能把开发机探测结果当通用默认。

## 一个新 op 的垂直切片

假设新增 `scaled_add`，完整工作通常包括：

```text
csrc/scaled_add/          kernel 与 binding
op_builder/scaled_add.py  sources/flags/compatibility
deepspeed/ops/...         Python public wrapper
accelerator 实现          builder 映射（如需要）
tests/unit/ops/...        正确性、dtype、shape、设备、grad
setup.py                  预编译发现（遵循现有注册机制）
docs                      使用与限制
```

先写纯 PyTorch reference，再比较本地 op 输出/梯度；性能基准不能替代正确性测试。

## PyBind 与 tensor 契约

本地 binding 必须明确：

- contiguous/stride 要求；
- dtype/device；
- shape 和 alignment；
- in-place 是否修改输入；
- 当前 stream；
- async lifetime；
- error check；
- backward/autograd 由谁实现。

Python wrapper 应在便宜且明确的地方校验，kernel 也不能依赖未验证输入导致越界。

## 跨平台实现的策略

不要在业务 runtime 中散布：

```python
if cuda:
    ...
elif xpu:
    ...
```

优先把差异放进 accelerator 或 platform-specific builder。业务层只根据能力选择路径或 fallback。若一个 op 只支持部分平台：

- `is_compatible()` 清楚返回；
- public wrapper 提供可解释错误或 reference fallback；
- 测试按 accelerator capability skip；
- 文档写明 dtype/shape/平台范围。

## 本章实验：追踪 CPUAdam 的加载

```bash
rg -n 'class CPUAdamBuilder|BUILD_VAR' op_builder
rg -n 'CPUAdamBuilder|cpu_adam' deepspeed/ops setup.py
rg -n 'def load|def jit_load|validate_torch' op_builder/builder.py
rg -n 'DeepSpeedCPUAdam' tests/unit/ops
```

画出 Python optimizer 构造 → builder → C++ binding → kernel 的文件链，并为每一跳记录可能失败的环境条件。

若环境允许，先运行 `ds_report`，再只触发一个极小 CPUAdam 测试。不要为了学习一次性预编译所有 ops。

## 贡献代码时的项目约束

新 Python/C/C++/CUDA 文件需要 SPDX 和 DeepSpeed Team 头；内部通信使用 `deepspeed.comm`；设备操作优先 accelerator；修改文件需运行精确 pre-commit allowlist。自定义 op 还要测试 fallback、不同 dtype、非 contiguous/非法 shape 和版本错误。

## 常见误区

- 把 accelerator 抽象成单个 `device_name`。
- 在 runtime 中直接调用 CUDA API，破坏其他平台。
- editable 安装后认为旧 JIT cache 自动失效。
- 本地 op 输出接近 reference，就忽略 gradient/in-place/stream。
- 为绕过版本错误直接设置 skip check。
- 只在当前 GPU 架构预编译，却把 wheel 当通用产物。

## 自测

1. Accelerator 和 OpBuilder 的边界分别是什么？
2. 为什么 stream/event 能影响正确性，也能影响性能？
3. `installed=no, compatible=yes` 的 op 在首次调用时会发生什么？
4. 新 op 为什么必须有纯框架 reference 和非法输入测试？
