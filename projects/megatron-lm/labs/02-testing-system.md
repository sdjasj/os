# 02. 测试体系实践：单元测试、功能 recipe 与 golden values

Megatron 测试不能简单分成“快 unit、慢 integration”。许多 unit test 也初始化分布式 group 并需要 8 GPU；functional test 则通过真实训练脚本和 golden metrics 验证跨层行为。选择测试要从被修改的契约出发。

## 测试布局

```text
tests/
├─ unit_tests/          pytest，常用 1 node × 8 GPUs
├─ functional_tests/
│  └─ test_cases/{model}/{case}/
│     ├─ model_config.yaml
│     └─ golden_values_{env}_{platform}.json
└─ test_utils/
   ├─ recipes/h100|gb200/
   └─ python_scripts/
```

## 先跑一个精确 unit test

必须在准备好的 GPU dev 容器中，经 distributed runner：

```bash
uv run python -m torch.distributed.run \
  --nproc-per-node 8 \
  -m pytest -q \
  tests/unit_tests/models/test_gpt_model.py::TestGPTModel::test_constructor
```

不要直接 `pytest` 运行这类文件：测试 fixture 与 Core 组件预期 distributed group 已初始化。

逐步扩大：

```bash
# 单文件
uv run python -m torch.distributed.run --nproc-per-node 8 \
  -m pytest -q tests/unit_tests/models/test_gpt_model.py

# 名称过滤
uv run python -m torch.distributed.run --nproc-per-node 8 \
  -m pytest -q tests/unit_tests -k optimizer
```

开发时可排除标记：

```bash
... -m "not flaky and not flaky_in_dev"
```

`flaky_in_dev` 跳过默认 dev 环境；`flaky` 对应 LTS。禁用测试不应删除 case。

## 一个好的 Core unit test

应明确：

- 需要哪些 process groups；
- 每 rank 参数/shape 期望；
- forward 与 backward 是否都验证；
- 是否比较跨 rank 一致性；
- teardown 是否销毁 group/释放 CUDA state；
- 多种 TP/PP size 是否必要。

新增显式 PG 接口时，参考 `TestGPTModelWithCustomPG`，验证模块确实使用传入 group，而非偷偷读取全局 group。

## Functional case

一个 case 的 `model_config.yaml` 定义 `MODEL_ARGS`、环境变量和测试类型。Shell runner 启动真实 `pretrain_gpt.py`，只让 rank 0 运行结果验证，并收集所有 rank 日志。

Golden values 不是“测试失败就更新”的快照。它们是数值回归基线；只有确认变化预期、运行干净且分析了偏差后才能刷新。

## Recipe YAML

`tests/test_utils/recipes/` 用 products 笛卡尔积扩展环境、平台与 case：

```yaml
spec:
  model: gpt
  nodes: 1
  gpus: 8
  script: |-
    bash tests/functional_tests/shell_test_utils/run_ci_test.sh ...
products:
  - test_case: [my_case]
    products:
      - environment: [dev]
        scope: [mr-github]
        platforms: [dgx_h100]
```

临时禁用时保留条目并把 scope 改为 `mr-github-broken`，便于发现和恢复。

## CI parity 与日志

要复现 CI bucket，使用 `tests/unit_tests/run_ci_test.sh`。CI 的 per-rank log 写入 assets；rank 0 和 3 可 tee 到 stdout。多 rank 最终 NCCL timeout 时，扫描所有 rank 日志，寻找最早非 NCCL traceback。

`pyproject.toml` 默认 pytest `-s`，stdout 不捕获，多 rank 输出会交错。调试特定问题可加 `--capture=fd`。

## Golden 更新流程的边界

功能测试新 case 一般：

1. 新建 test case 与 model config；
2. 加 h100 recipe，必要时加 gb200；
3. PR 触发真实 CI；
4. 检查训练与数值变化；
5. 用下载脚本按 workflow run 获取 golden；
6. 只提交本次预期文件。

下载/更新 golden 涉及外部 run 与认证，本教程不执行这些动作。

## 实验：为 TP Linear 设计测试矩阵

设计三层覆盖：

| 层次 | 验证 |
| --- | --- |
| unit | Column/Row local shape、forward 与 grad |
| composed unit | MLP TP=1 vs TP=2 的全局输出一致 |
| functional | 小 GPT 多 step loss、resume、golden |

说明为什么只测构造函数无法发现 backward collective 错误，为什么只跑 functional 又不利于定位。

## 自测

1. 为什么 unit test 也要 distributed runner？
2. `flaky_in_dev` 与 `mr-github-broken` 各作用在哪层？
3. Golden mismatch 为什么不能直接接受？
4. CI timeout 时为何要扫描所有 rank 日志？
5. 显式 PG 改动应增加什么测试？

## 源码定位

- [GPTModel unit test](https://github.com/NVIDIA/Megatron-LM/blob/e79cb4c1bae1afd04322d979d08cb63832991ebe/tests/unit_tests/models/test_gpt_model.py)
- [unit CI runner](https://github.com/NVIDIA/Megatron-LM/blob/e79cb4c1bae1afd04322d979d08cb63832991ebe/tests/unit_tests/run_ci_test.sh)
- [GPT recipe](https://github.com/NVIDIA/Megatron-LM/blob/e79cb4c1bae1afd04322d979d08cb63832991ebe/tests/test_utils/recipes/h100/gpt.yaml)
- [functional runner](https://github.com/NVIDIA/Megatron-LM/blob/e79cb4c1bae1afd04322d979d08cb63832991ebe/tests/functional_tests/shell_test_utils/run_ci_test.sh)

下一章建立性能与故障诊断流程。
