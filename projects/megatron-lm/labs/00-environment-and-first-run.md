# 00. 实践环境与第一次运行：先验证最小闭环

Megatron-LM 依赖 CUDA、NCCL、特定 PyTorch、Transformer Engine 和原生扩展。裸主机上临时拼装依赖既脆弱又难复现；仓库维护约定是使用 CI dev 容器，容器内已有 `/opt/venv` 并在 `PATH` 上。

## 练习分三级

### A. 纯静态阅读

只需 Git、`rg` 和编辑器：

```bash
git rev-parse HEAD
rg -n "^def pretrain|^def train_step" megatron/training/training.py
rg -n "class GPTModel" megatron/core/models/gpt/gpt_model.py
```

适合无 NVIDIA GPU 的机器。前两条教程轨道完全可用这种方式完成。

### B. 两 GPU 最小 MCore 闭环

使用仓库 `examples/run_simple_mcore_train_loop.py`。它包含：

```text
init_process_group + initialize_model_parallel(TP=2)
small GPTModel (2 layers, H=12)
MockGPTDataset
Megatron DDP
forward/backward schedule
finalize_model_grads + Adam step
distributed checkpoint save/load
```

### C. 完整 pretrain_gpt mock-data

在 B 成功后，再阅读并运行 `examples/llama/train_llama3_8b_h100_fp8.sh` 等硬件匹配示例。生产示例对 GPU 架构、显存和 TE kernel 有具体要求，不要在未知硬件上原样启动大模型。

## 构建 dev 容器

默认只使用 dev 变体。公开/本地 build 必须停在 `main` stage，避免需要内部 secret 的 `jet` stage：

```bash
docker build \
  --target main \
  --build-arg FROM_IMAGE_NAME=$(cat docker/.ngc_version.dev) \
  --build-arg IMAGE_TYPE=dev \
  -f docker/Dockerfile.ci.dev \
  -t megatron-lm:local .
```

LTS 是显式兼容性通道，本教程不主动构建或运行它。

## 启动容器

```bash
docker run --rm --gpus all \
  -v "$(pwd):/workspace" \
  -w /workspace \
  megatron-lm:local \
  bash
```

进入容器后确认：

```bash
which python
python -c "import torch; print(torch.__version__, torch.cuda.device_count())"
which uv
```

依赖工作只在容器内运行：

```bash
uv sync --locked --group dev --group test
```

不要在 host 用裸 `pip` 或 `uv sync` 试图复现完整 GPU 环境。

## 第一次运行

容器内：

```bash
uv run python -m torch.distributed.run \
  --nproc-per-node 2 \
  examples/run_simple_mcore_train_loop.py
```

官方 quickstart 写作 `torchrun`；这里显式使用 venv 的 `uv run python -m torch.distributed.run`，可避免入口脚本指向错误解释器。

## 边跑边读

把示例分成七个断点：

1. `initialize_distributed`：检查 rank/world/device/TP；
2. `model_provider`：记录模型 shape 与 spec；
3. `get_train_data_iterator`：观察 mock batch keys；
4. `forward_step_func`：观察 tokens 与 loss closure；
5. `get_forward_backward_func`：当前 TP=2、PP=1，会选 no-pipeline schedule；
6. `finalize_model_grads` 与 `Adam.step`；
7. distributed checkpoint save/load。

用 `print` 调试多 rank 会交错；更稳妥的是只在指定 rank 输出：

```python
if torch.distributed.get_rank() == 0:
    print(tokens.shape)
```

练习结束后不要把临时输出和 `ckpt/` 纳入提交。

## 成功标准

- 两个进程都初始化，无 NCCL error；
- 连续五次 iteration 输出 loss；
- `finalize_model_grads` 与 optimizer 正常执行；
- checkpoint 可被同一脚本加载；
- 你能解释每次 collective 属于 TP 还是 DP（此例 TP=2、DP=1）。

## 常见失败

| 现象 | 检查 |
| --- | --- |
| `ModuleNotFoundError` | 是否在正确 dev 容器和 `/opt/venv` |
| CUDA device 数不足 | `--nproc-per-node` 是否超过可见 GPU |
| native extension build 失败 | 是否用仓库 CI image、是否完成 locked sync |
| NCCL hang | 找最早 rank traceback，核对两个进程命令一致 |
| checkpoint 目录已存在/状态混杂 | 使用新的练习目录，不覆盖重要 checkpoint |

## 自测

1. 为什么先跑 simple loop，再跑完整 LLaMA 示例？
2. Docker build 为什么要 `--target main`？
3. `/opt/venv` 在环境中扮演什么角色？
4. 最小示例的 TP/DP/PP 分别是多少？
5. 什么证据说明 checkpoint 闭环真的完成？

## 源码定位

- [Quickstart](https://github.com/NVIDIA/Megatron-LM/blob/e79cb4c1bae1afd04322d979d08cb63832991ebe/docs/get-started/quickstart.md)
- [最小训练循环](https://github.com/NVIDIA/Megatron-LM/blob/e79cb4c1bae1afd04322d979d08cb63832991ebe/examples/run_simple_mcore_train_loop.py)
- [dev Dockerfile](https://github.com/NVIDIA/Megatron-LM/blob/e79cb4c1bae1afd04322d979d08cb63832991ebe/docker/Dockerfile.ci.dev)

下一章用纸面推演和轻量 instrumentation 验证 rank、shape 与通信账本。
