# 教程示例

这些脚本对应教程各功能模块，目标是展示清晰的最小用法。建议在独立虚拟环境中从上到下运行。

## 1. 环境

```bash
python -m venv .venv
source .venv/bin/activate
python -m pip install -U pip
```

按示例安装：

```bash
# Core、Dashboard、Jobs
python -m pip install "ray[default]"

# Data
python -m pip install "ray[data]" numpy

# Train
python -m pip install "ray[train]" torch

# Tune
python -m pip install "ray[tune]"

# Serve
python -m pip install "ray[serve]"

# RLlib
python -m pip install "ray[rllib]" torch gymnasium
```

当前源码仓库是 `3.0.0.dev0` 开发快照。若运行 PyPI 稳定版出现 API 差异，请对照对应版本文档。

## 2. 运行顺序

| 脚本 | 功能 | 依赖 | 预期行为 |
| --- | --- | --- | --- |
| [`core_tasks.py`](core_tasks.py) | Task、ObjectRef、并行提交 | Ray Core | 8 个慢平方任务并行完成 |
| [`bounded_tasks.py`](bounded_tasks.py) | `ray.wait` 背压 | Ray Core | 最多 4 个在途任务，按完成顺序消费 |
| [`actors.py`](actors.py) | Actor 状态和多个 Worker | Ray Core | 计数器保持状态，Worker 池并行处理 |
| [`data_pipeline.py`](data_pipeline.py) | Dataset、`map_batches` | `ray[data]`, NumPy | 生成、过滤并批量转换数据 |
| [`tune_search.py`](tune_search.py) | Tuner、搜索空间、最佳结果 | `ray[tune]` | 搜索使 `x` 接近 3 的配置 |
| [`train_torch.py`](train_torch.py) | TorchTrainer、DDP helpers | `ray[train]`, PyTorch | 2 个 CPU Worker 训练线性模型 |
| [`serve_app.py`](serve_app.py) | Deployment、HTTP | `ray[serve]` | 启动服务、自请求并关闭 |
| [`rllib_ppo.py`](rllib_ppo.py) | PPO AlgorithmConfig | `ray[rllib]`, PyTorch | 本地 EnvRunner 完成一次训练迭代 |
| [`job_app.py`](job_app.py) | Ray Job 入口 | `ray[default]` | 提交到现有集群并运行 Task |

例如：

```bash
python ray_usage_guide/examples/core_tasks.py
python ray_usage_guide/examples/data_pipeline.py
```

## 3. 提交 Job 示例

先启动集群：

```bash
ray start --head
```

再从仓库根目录提交：

```bash
ray job submit \
  --address http://127.0.0.1:8265 \
  --working-dir ray_usage_guide/examples \
  -- python job_app.py
```

最后：

```bash
ray stop
```

## 4. 示例边界

- 示例数据很小，只用于理解，不代表性能基准。
- 示例会创建本地 Ray 进程和临时结果；脚本正常结束时会清理/断开。
- Train 和 RLlib 示例在 CPU 上运行，便于学习；生产 GPU 配置见对应教程。
- Serve 示例自行发起一次 HTTP 请求后关闭，不是长时生产服务。
- 不要用系统 Python 安装依赖。
