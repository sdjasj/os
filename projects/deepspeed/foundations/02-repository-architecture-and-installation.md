# 02. 仓库地图与安装：Python 运行时如何连接设备和本地算子

DeepSpeed 同时是 Python 包、分布式运行时和本地扩展集合。读目录前先区分“纯 Python 编排”和“需要编译的性能路径”，可以避免把环境兼容问题误判成算法问题。

## 顶层目录按职责分层

```text
DeepSpeed/
├── deepspeed/       Python 公共 API 与主要运行时
├── accelerator/     多硬件抽象及自动选择
├── op_builder/      构建/JIT 本地算子的 builder
├── csrc/            C++、CUDA、HIP 等算子源码
├── tests/           单元、分布式、模型与性能测试
├── docs/            配置、API 和教程站点内容
├── examples/        集成与功能示例
├── setup.py         包构建、预编译开关和元数据
└── requirements/    按用途拆分的依赖集合
```

最重要的边界是：

```text
用户代码
  → deepspeed/__init__.py
  → deepspeed/runtime/*
  → deepspeed/comm/*
  → accelerator/*
  → op_builder/* → csrc/*
```

不是每次训练都会穿过最后两层。普通 PyTorch 算子和通信可直接走框架后端；FusedAdam、CPUAdam、AIO 等功能才会加载特定扩展。

## `deepspeed/` 内部的主干

| 目录/文件 | 职责 | 建议阅读时机 |
| --- | --- | --- |
| `__init__.py` | `initialize`、`init_inference`、公共导出 | 第一站 |
| `runtime/engine.py` | 训练生命周期和功能编排 | 主线 |
| `runtime/config.py` | 顶层配置解析与一致性校验 | 主线 |
| `runtime/zero/` | ZeRO optimizer、参数协调与 offload | 熟悉 Engine 后 |
| `comm/` | collective 门面、后端和通信日志 | 学 ZeRO 前 |
| `runtime/pipe/` | pipeline engine、schedule、P2P | 并行专题 |
| `module_inject/` | 模型替换、AutoTP、policy | 推理/TP 专题 |
| `moe/` | gate、expert dispatch、EP group | MoE 专题 |
| `checkpoint/` | checkpoint reshape 和 universal 格式 | checkpoint 专题 |
| `inference/` | 经典 InferenceEngine 与配置 | 推理专题 |
| `compile/` | DeepCompile backend 和 passes | 最后一站 |

## 导入阶段已经做了什么

公共包导入并非完全无副作用。[`deepspeed/__init__.py`](deepspeed/__init__.py) 在导入 `torch` 前设置 `PYTORCH_NVML_BASED_CUDA_CHECK` 的默认值，目的是避免设备探测过早创建 CUDA context，破坏后续基于 `fork()` 的多进程流程。它还探测 Triton，并导入公共 Engine、ops 和模块注入功能。

这提示两个调试原则：

1. import 卡住或失败时，问题可能发生在真正训练之前；
2. 多进程启动问题要检查 import 顺序和设备 context，而不只是训练函数。

## 三种安装/加载模式

### 1. 发布包 + 按需 JIT

上游 README 的默认方式是安装 Python 包，在第一次使用某个扩展时由 PyTorch extension loader 和 Ninja 编译：

```bash
python -m pip install deepspeed
ds_report
```

优点是安装快、只编译用到的 op；代价是首个训练 step 可能承担编译时间，多进程同时 JIT 时还要关注共享缓存和文件锁。

### 2. 源码 editable 安装

开发源码时通常从仓库根执行：

```bash
python -m pip install -e .
ds_report
```

Python 修改立即生效，本地扩展是否重编译则取决于 builder、缓存路径、源码和编译参数。不要看到 editable 就假定 `.so` 一定是最新的。

### 3. 安装时预编译

[`setup.py`](setup.py) 枚举 op builder，并读取每个 builder 的环境变量决定是否把扩展加入 wheel。预编译适合固定 CI/容器镜像，但要求构建节点的 PyTorch、CUDA/ROCm 和目标架构与运行环境兼容。

预编译与 JIT 的共同核心都是 `OpBuilder`：声明源码、include path、编译参数、兼容性检查和 Python 模块名。区别主要是何时构建、产物放在哪里。

## 版本矩阵为什么难

本地扩展同时依赖：

- Python ABI；
- PyTorch 主次版本及其 C++ ABI；
- PyTorch 编译时使用的 CUDA/ROCm 版本；
- 系统工具链中的 `nvcc`/`hipcc`；
- GPU 架构和编译 flags；
- Ninja、系统头文件与库。

`op_builder/builder.py` 会比较 PyTorch 与系统 CUDA 版本，并区分可以接受的 minor mismatch 和不兼容的 major mismatch。`DS_SKIP_CUDA_CHECK=1` 只是绕过保护，不会让二进制真正兼容；学习环境中不应把它作为第一解决方案。

## accelerator 抽象解决什么

DeepSpeed 不能在运行时到处写 `torch.cuda.*`。`accelerator/abstract_accelerator.py` 定义设备名、通信后端、stream/event、内存统计、dtype、RNG、op builder 等契约，`accelerator/real_accelerator.py` 根据环境选择 CUDA、ROCm、CPU、XPU、HPU、NPU 等实现。

因此源码中常见：

```python
from deepspeed.accelerator import get_accelerator

device = get_accelerator().current_device_name()
stream = get_accelerator().Stream()
backend = get_accelerator().communication_backend_name()
```

读到这些调用时，应继续追当前 accelerator 的实现，而不是默认它一定是 CUDA。

## 为什么 `ds_report` 是第一诊断工具

环境报告把“是否安装”“是否兼容”“版本信息”分开。一个 op 没有预安装不代表不可用，它可能在首次使用时 JIT；`compatible=no` 才说明 builder 探测到依赖不足。

建议保存以下最小诊断信息，而不是只贴一句“DeepSpeed 不工作”：

```bash
python - <<'PY'
import torch
import deepspeed
from deepspeed.accelerator import get_accelerator

print("torch", torch.__version__)
print("deepspeed", deepspeed.__version__)
print("accelerator", get_accelerator().device_name())
print("backend", get_accelerator().communication_backend_name())
PY
ds_report
```

公开问题报告前要移除主机名、内部路径和其他环境敏感信息。

## 从 Python 到 C++/CUDA 的一条示例链

以 FusedAdam 为例，概念链路是：

```text
配置 optimizer.type = Adam/AdamW
  → DeepSpeedEngine._configure_basic_optimizer
  → deepspeed.ops.adam.FusedAdam
  → 对应 OpBuilder.load()
  → 已安装模块，或 JIT load
  → csrc/adam 中的本地实现
```

如果失败，要先判断失败在哪一箭头：配置没选中 fused 路径、Python module 找不到、builder 判定不兼容、编译失败、动态链接失败，处理方式完全不同。

## 阅读大型仓库的目录策略

不要按目录字母顺序通读。使用“垂直切片”：

1. 选一个用户可见行为，如 `zero_optimization.stage=2`；
2. 找配置模型和默认值；
3. 找 Engine 的分支；
4. 找具体 optimizer/coordinator；
5. 找 collective 和本地 op；
6. 找单元/分布式测试。

下面的命令能快速建立切片：

```bash
rg -n 'zero_optimization_stage|_configure_zero_optimizer' deepspeed
rg -n 'DeepSpeedZeroOptimizer' deepspeed tests
rg -n 'reduce_scatter' deepspeed/runtime/zero tests/unit/runtime/zero
```

## 本章实验：制作环境与目录审计表

### 静态部分

```bash
git rev-parse HEAD
find deepspeed -maxdepth 2 -type d | sort
rg -n 'class .*Builder' op_builder deepspeed/ops/op_builder
rg -n 'def get_accelerator|class DeepSpeedAccelerator' accelerator
```

记录当前提交、主要目录、accelerator 选择点和至少三个 op builder。

### 可运行部分

若环境已经安装依赖，执行 `ds_report`，为 `cpu_adam`、`fused_adam`、`async_io` 分别记录：已安装、兼容、首次使用是否可能 JIT。不要为了完成本章强行安装全部扩展。

## 常见误区

- 把 Python import 成功当作所有 fused op 都可用。
- 把首次 JIT 时间当作训练死锁。
- 只比较系统 `nvcc --version`，忽略 PyTorch 自身的构建版本。
- 默认所有路径都用 CUDA，忽略 accelerator 抽象。
- 修改 `csrc/` 后继续使用旧缓存产物，却只调试 Python。

## 自测

1. editable 安装为什么不保证本地扩展自动更新？
2. `installed=no, compatible=yes` 可能意味着什么？
3. accelerator 与 op builder 各自解决哪一层问题？
4. 为什么设置跳过版本检查不等于解决 ABI 不兼容？
