# 12. 测试、调试与贡献工作流

## 12.1 大仓库的验证原则

Ray 全量测试不适合个人机器。有效策略是建立“最小充分验证金字塔”：

```text
静态检查/目标单测（快、定位准）
       ↓
组件测试（覆盖真实边界）
       ↓
少量跨进程/多节点集成测试
       ↓
CI / release scale test（成本最高）
```

每次修改先明确不变量，再选择能直接证明它的最小测试。测试越大，不一定越能定位问题。

## 12.2 Python 环境与两种开发模式

所有 Python 工作都应在虚拟环境：

```bash
python -m venv .venv-ray-dev
source .venv-ray-dev/bin/activate
python -m pip install --upgrade pip wheel
```

### Python-only 快循环

按 [development.md](../doc/source/ray-contribute/development.md) 安装兼容 wheel，再运行 `python python/ray/setup-dev.py` 把本地 Python 目录链接进已安装包。适合 Data/Train/Tune/Serve/RLlib 的多数 Python 修改。

### 完整 C++ editable build

修改 `_raylet.pyx`、protobuf、CoreWorker、raylet、GCS 或对象管理时需要完整构建。官方当前使用 Bazel 7.5.0，并在 `python/` 下 `pip install -e . --verbose`。不要在没有 C++ 修改时承担完整构建成本。

## 12.3 Python 测试

安装测试依赖：

```bash
python -m pip install \
  -c python/requirements_compiled.txt \
  -r python/requirements/test-requirements.txt
```

运行单个测试优先用 `python -m pytest`，以保留正确 import path：

```bash
python -m pytest -v -s \
  python/ray/tests/test_basic.py::test_release_cpu_resources

python -m pytest -v -s \
  python/ray/data/tests/test_map.py -k 'map_batches and not gpu'

python -m pytest -v -s \
  python/ray/serve/tests/test_api.py -k 'deployment'
```

第一次不要直接跑整个 `python/ray/tests`；许多测试需要额外依赖、Docker、Redis、GPU 或平台能力。

## 12.4 Pytest fixture 表达集群拓扑

[python/ray/tests/conftest.py](../python/ray/tests/conftest.py) 中常见：

- `shutdown_only`：测试自己调用 `ray.init`，fixture 保证清理；
- `ray_start_regular`：启动普通单节点实例；
- `ray_start_regular_shared`：多个测试复用实例，速度更快但隔离较弱；
- `ray_start_cluster`：提供可动态增加节点的 Cluster；
- 带参数 fixture：配置 CPU、object store、system config。

选择 fixture 的原则：能用单节点就不启多节点；测试生命周期/崩溃时不复用 shared cluster；只有涉及节点位置/对象传输/节点失败才使用 cluster fixture。

```python
def test_my_feature(shutdown_only):
    ray.init(num_cpus=2)
    ...
```

测试结束不要依赖手写清理的偶然成功；使用现有 fixture 模式，避免残留进程影响下一测试。

## 12.5 C++ Bazel 单测

几个与教程对应的准确 target：

```bash
bazel test \
  //src/ray/core_worker/task_submission/tests:normal_task_submitter_test

bazel test \
  //src/ray/core_worker/tests:reference_counter_test

bazel test \
  //src/ray/raylet/scheduling/tests:cluster_resource_scheduler_test
```

过滤 gtest case 并显示输出：

```bash
bazel test \
  //src/ray/core_worker/tests:reference_counter_test \
  --test_filter='*Nested*' \
  --test_output=streamed
```

确切 target 从同目录 `BUILD.bazel` 的 `name` 获取，不要猜：

```bash
rg -n 'name = ".*reference.*test"' src/ray/core_worker/tests/BUILD.bazel
```

## 12.6 如何写一个高价值测试

测试应清楚表达：

1. 前置状态；
2. 唯一触发动作；
3. 要保护的不变量；
4. 故障/并发时序如何受控；
5. 清理。

对异步分布式代码，避免随意 `time.sleep(5)`。优先使用：

- SignalActor/barrier；
- event/callback；
- `wait_for_condition`/`wait_for_assertion`；
- mock clock；
- fake RPC client；
- 明确 timeout 的 `ray.get`/`ray.wait`。

固定 sleep 会让测试既慢又 flaky：快机器浪费时间，慢机器仍可能失败。

## 12.7 从状态而不是最终超时调试

一个 `ray.get` 超时只说明结果没回来。应将 Task 分阶段：

```text
SUBMITTED
  -> waiting for scheduling/resources
  -> waiting for runtime env/worker
  -> waiting for dependencies
  -> RUNNING
  -> waiting inside user code / ray.get
  -> FINISHED / FAILED
```

先定位停在哪一阶段，再选日志：

- scheduling：raylet、resource demand；
- runtime env：runtime_env agent；
- dependency：ObjectManager/owner/object state；
- execution：Worker log 和用户 stack；
- Actor reconnect：ActorTaskSubmitter/GCS actor；
- Serve：Controller/Replica/Proxy；
- Data：StreamingExecutor/operator stats。

## 12.8 State API

入口在 [python/ray/util/state/api.py](../python/ray/util/state/api.py)：

```python
from ray.util.state import list_actors, list_objects, list_tasks

running = list_tasks(
    filters=[("state", "=", "RUNNING")],
    detail=True,
)

dead_actors = list_actors(
    filters=[("state", "=", "DEAD")],
    detail=True,
)

objects = list_objects(detail=True)
```

State API 可能因数据源不可达、数量截断而缺少条目；`raise_on_missing_output` 和 limit 影响结果。它是诊断快照，不应当作业务强一致数据库。

CLI/Dashboard 常用视角：

```bash
ray status
ray list tasks --detail
ray list actors --detail
ray list objects --detail
ray memory
```

具体 CLI 字段可能随版本变化，可用 `--help` 查看当前环境。

## 12.9 日志目录和文件

本地 Ray session 通常位于临时目录下的 `session_latest/logs`。常见日志：

- `raylet.out/err`：lease、资源、Worker、对象管理；
- `gcs_server.out/err`：Actor/PG/节点/控制面；
- `python-core-worker-*.log`：CoreWorker；
- `worker-*.out/err`：用户 Task/Actor；
- dashboard/agent；
- runtime_env agent；
- Serve controller/proxy/replica 组件日志。

不要只搜 `ERROR`。很多根因先以 `WARNING`、lease canceled、worker died 或 object lost 出现，后续错误只是连锁结果。用 TaskID、ActorID、WorkerID、ObjectID 串联多文件。

## 12.10 Backend debug 日志

官方 [debugging.md](../doc/source/ray-contribute/debugging.md) 支持：

```bash
export RAY_BACKEND_LOG_LEVEL=debug
python reproduce.py
```

Debug 日志量很大，应只在最小复现中使用，并在启动 Ray 前设置。进程还可通过 `RAY_{PROCESS_NAME}_{DEBUGGER}` 进入 gdb/valgrind/perf 等环境；例如 raylet gdb 需要按文档配合 tmux。不要在生产集群临时开启海量 debug 日志而无磁盘预算。

## 12.11 分布式 debugger 与 profiling

- Dashboard 可看 Worker stack trace/CPU flame graph；
- Task timeline 可导出 Chrome trace，用 Perfetto 查看；
- Ray distributed debugger 可在远端 Task/Actor 断点；
- C++ crash 用 core dump + gdb/lldb；
- Python CPU 用 py-spy，原生栈可用 perf；
- 内存先区分 heap 与 Plasma，再选择 tracemalloc/memray 或 `ray memory`。

Profile 前先写清问题是 latency、throughput、CPU、heap、object store 还是网络。一个 profiler 不会同时回答所有问题。

## 12.12 二分定位一条跨层 bug

以“Task 选项没有生效”为例：

1. Python 层打印/断言 `RemoteFunction._remote` 中 options；
2. Cython 单测/日志确认 `TaskOptions` 转换；
3. 检查 `TaskSpec` protobuf 字段；
4. NormalTaskSubmitter 的 LeaseSpecification 是否保留；
5. raylet scheduler 是否读取；
6. Worker resource mapping 是否返回；
7. runtime context 是否呈现。

每层只验证输入输出，把“整个系统不工作”切成“哪一条边丢了信息”。

## 12.13 Lint 与格式化

仓库使用 `.pre-commit-config.yaml` 管理 ruff、black、buildifier、cpplint、mypy 等。按仓库要求安装固定版本：

```bash
python -m pip install -U pre-commit==3.5.0
pre-commit install
pre-commit run
```

只检查某些文件也可：

```bash
pre-commit run --files python/ray/path/to/file.py
```

自动格式化后的每一行仍需人工 review，特别是生成文件、protobuf、BUILD target 和 import side effect。

## 12.14 贡献前的强制流程

本仓库根 [AGENTS.md](../AGENTS.md) 对 AI 辅助贡献有明确规则。若准备提交 PR：

### 先查重复工作

```bash
# 有对应 issue 时
gh issue view <issue_number> --repo ray-project/ray --comments
gh pr list --repo ray-project/ray --state open --search "<issue_number> in:body"

# 按区域搜索开放 PR
gh pr list --repo ray-project/ray --state open --search "<short area keywords>"
```

已有相同 PR 时不要再开；方案实质不同也应先在 issue/PR 说明差异。

### 不提交低价值 busywork

孤立错字、单个样式、单处无实质价值的机械清理，不值得消耗 CODEOWNERS 和 CI。应与实质工作组合或先与维护者协调。

### 人类负责

纯 agent PR 不允许。提交者必须理解并能解释每一行，亲自运行相关测试。PR 描述要写：

- 为什么不是重复 issue/PR；
- 测试命令和结果；
- 使用了 AI assistance。

### DCO 与 pre-commit

每个 commit 必须 sign-off：

```bash
git commit -s -m "Your commit message"
```

没有完成重复检查、人工 review 和本地测试，就不应开 PR。

## 12.15 修改范围到测试矩阵

| 修改 | 最小测试 | 额外检查 |
|---|---|---|
| `RemoteFunction` Python 校验 | 目标 Python unit test | client mode、options override |
| `_raylet.pyx` 参数转换 | Python integration + build | Python/C++ ownership、ref leak |
| TaskSpec/protobuf | C++ builder/consumer tests | 多语言、向后兼容、generated code |
| scheduler | resource scheduler/lease manager test | stale view、spillback、PG、labels |
| Actor submitter | actor task submitter test | restart、ordering、multiple handles |
| Data operator | operator unit + small pipeline | fusion、backpressure、block ownership |
| Train worker group | targeted Train test | PG cleanup、partial failure、checkpoint |
| Serve deployment state | controller/deployment unit test | rolling update、recovery、health |
| RLlib learner/module | component test + short algo run | checkpoint、新旧 stack、multi-agent |

## 12.16 自测题

1. 为什么单个目标测试通常比整个组件测试更适合第一轮验证？
2. 什么情况下应使用多节点 fixture？
3. 如何区分 Task 在等待资源、依赖还是用户代码？
4. 调试对象泄漏时 `ray memory` 与 Python heap profiler 各看什么？
5. 修改 protobuf 为什么需要检查跨语言与多个 consumer？
6. AI 辅助 PR 的提交者必须在描述中声明哪些信息？

