# 2. 仓库地图与开发环境

## 2.1 顶层目录地图

```text
ray/
├── python/ray/          Python 公共 API、私有运行时绑定、Data/Train/Tune/Serve
├── src/ray/             C++ CoreWorker、raylet、GCS、对象管理器、protobuf
├── rllib/               RLlib 主源码（python/ray/rllib 指向它）
├── doc/source/          Sphinx/MyST 官方文档和文档示例
├── cpp/                 C++ 用户 API 与示例
├── java/                Java API、runtime、Serve
├── python/ray/tests/    Ray Core Python 测试
├── release/             大规模、长时间、性能与发布测试
├── ci/ 与 .buildkite/   CI 编排、镜像、lint、测试脚本
├── bazel/               Bazel 辅助规则和测试
└── thirdparty/          第三方依赖与补丁
```

第一条重要经验：`python/ray` 不等于“纯 Python”。公共 API 通过编译扩展 `ray._raylet` 进入 C++。第二条经验：不要把 `release/` 的测试当成本地单元测试，它们常需要集群、云资源或很长运行时间。

## 2.2 Python 层的入口

[python/ray/__init__.py](../python/ray/__init__.py) 是用户 `import ray` 的入口。它做三类工作：

1. 加载 `_raylet.so`/`_raylet.pyd` 并暴露 `ObjectRef`、`ActorID`、`TaskID` 等扩展类型；
2. 从 [python/ray/_private/worker.py](../python/ray/_private/worker.py) 导出 `init/get/put/wait/remote`；
3. 注册自动初始化包装。

核心 Python 文件：

| 行为 | 入口文件 | 关键符号 |
|---|---|---|
| 初始化与公共对象 API | `python/ray/_private/worker.py` | `init`, `get`, `put`, `wait`, `connect` |
| 远程函数 | `python/ray/remote_function.py` | `RemoteFunction`, `RemoteFunction._remote` |
| Actor | `python/ray/actor.py` | `ActorClass`, `ActorHandle`, `_actor_method_call` |
| Python/C++ 桥 | `python/ray/_raylet.pyx` | `CoreWorker.submit_task`, `create_actor`, `get_objects` |
| 函数/类分发 | `python/ray/_private/function_manager.py` | 函数和 Actor class 的导出、加载 |
| 序列化 | `python/ray/_common/serialization.py` | `SerializationContext` |
| runtime env | `python/ray/_private/runtime_env/` | 包、环境、工作目录准备 |

## 2.3 C++ 层的入口

| 组件 | 目录/文件 | 责任 |
|---|---|---|
| CoreWorker | `src/ray/core_worker/` | 每个 Driver/Worker 的本地运行时、提交/执行任务、对象引用 |
| 普通任务提交 | `src/ray/core_worker/task_submission/normal_task_submitter.*` | 请求 worker lease、缓存 worker、发送任务 |
| Actor 任务提交 | `src/ray/core_worker/task_submission/actor_task_submitter.*` | 连接目标 Actor、维护顺序和重试 |
| raylet | `src/ray/raylet/` | 节点管理、Worker 池、资源和 lease 调度 |
| 调度 | `src/ray/raylet/scheduling/` | 集群资源视图、本地/集群 lease 管理 |
| GCS | `src/ray/gcs/` | 集群控制面元数据和服务 |
| 对象管理 | `src/ray/object_manager/` | Plasma、跨节点对象传输、spill |
| 协议 | `src/ray/protobuf/` | RPC message/service schema |

程序入口可从 [src/ray/raylet/main.cc](../src/ray/raylet/main.cc) 和
[src/ray/gcs/gcs_server_main.cc](../src/ray/gcs/gcs_server_main.cc) 开始，但学习时更建议从某个 RPC handler 反向追踪。

## 2.4 上层库入口

```text
python/ray/data/       Dataset API、逻辑计划、流式执行器、datasource
python/ray/train/      Trainer、worker group、session/report/checkpoint
python/ray/tune/       Tuner、Trial、搜索算法、Trial scheduler、Trainable
python/ray/serve/      Deployment API、Controller、Replica、Router、Proxy
rllib/                 Algorithm、EnvRunner、RLModule、Learner、Connector
```

它们不是互相隔离的产品。常见组合包括 Data → Train、Train 作为 Tune 的 trainable、训练结果通过 Serve 部署、RLlib Algorithm 由 Tune 管理。

## 2.5 只阅读还是需要构建

### 只学习 API 与 Python 上层库

遵循官方 [development.md](../doc/source/ray-contribute/development.md) 的 Python-only 流程：在虚拟环境安装匹配的 Ray wheel，再用 `python/ray/setup-dev.py` 把相应 Python 目录链接到源码树。这适合 Tune、RLlib、Autoscaler 和大多数 Python 修改。

### 修改 Cython/C++ Core

需要完整 editable build。官方当前流程包括 Bazel 7.5.0、构建 dashboard，然后在 `python/` 下执行 `pip install -e . --verbose`。完整编译成本高，先确认问题真的跨越 C++ 边界。

### 仅阅读源码

无需安装任何依赖。`rg`、编辑器符号跳转和测试文件已经足够完成大量架构学习。

## 2.6 环境纪律

本仓库要求所有 Python 工作使用虚拟环境，不向系统 Python 安装包。示例：

```bash
python -m venv .venv-ray-study
source .venv-ray-study/bin/activate
python -m pip install --upgrade pip wheel
```

安装依赖前应再次核对官方开发文档，因为 master 的支持版本和依赖约束会变化。测试依赖使用仓库锁定约束：

```bash
python -m pip install \
  -c python/requirements_compiled.txt \
  -r python/requirements/test-requirements.txt
```

不要为了“先试一下”直接 `sudo pip install`；这会把系统环境和项目环境混在一起。

## 2.7 高效源码搜索配方

```bash
# 找定义
rg -n '^class RemoteFunction|^    def _remote' python/ray/remote_function.py

# 找 C++ 方法实现
rg -n 'CoreWorker::SubmitTask' src/ray/core_worker

# 找某协议被谁读写
rg -n 'RequestWorkerLease' src/ray -g '*.{h,cc,proto}'

# 找公共 API 的真实测试用法
rg -n 'ray\.wait\(' python/ray/tests doc/source -g '*.{py,rst,md}'

# 只列出相关文件
rg --files python/ray/data | rg 'streaming|logical|operator'

# 查 Bazel target
rg -n 'name = ".*core_worker.*"' src/ray -g 'BUILD*'
```

遇到 Python 方法被动态包装、装饰或 Cython 化时，普通 IDE 跳转可能失败，文本搜索反而更可靠。

## 2.8 阅读 protobuf 的方法

先看 [common.proto](../src/ray/protobuf/common.proto) 中的 `TaskSpec`、`TaskArg`、`ActorCreationTaskSpec`、`ActorTaskSpec` 和 `ObjectReference`，再看
[node_manager.proto](../src/ray/protobuf/node_manager.proto) 中的 `RequestWorkerLeaseRequest/Reply`，最后看
[gcs_service.proto](../src/ray/protobuf/gcs_service.proto) 的控制面服务。

阅读一个 message 时记录：

- 谁创建；
- 谁消费；
- 字段属于用户语义、调度语义还是可观测性；
- 字段缺失时的默认语义；
- 是否需要跨语言兼容。

如果给 `TaskSpec` 增加字段，影响往往横跨 Python/Cython、C++ builder、protobuf 生成代码、调度/执行与测试，绝不是只改 `.proto`。

## 2.9 测试地图

- Python Core：`python/ray/tests/`
- Data：`python/ray/data/tests/`
- Train：`python/ray/train/tests/`
- Tune：`python/ray/tune/tests/`
- Serve：`python/ray/serve/tests/`
- RLlib：`rllib/**/tests/` 和 `rllib/examples/`
- C++：各组件目录下 `tests/`
- 集成/规模/性能：`release/`

测试文件的名字通常就是最好的行为索引。例如 Actor 提交协议见
[direct_actor_transport_test.cc](../src/ray/core_worker/task_submission/tests/direct_actor_transport_test.cc)，Data map 行为见
[test_map.py](../python/ray/data/tests/test_map.py)。

## 2.10 当前快照与版本漂移

这套教程针对 `6623e6b1e7`。master 上以下区域尤其容易变化：

- Train v1/v2 切换；
- RLlib 新旧 API stack；
- raylet scheduling 中 “task” 向 “lease” 的命名迁移；
- Serve Controller、Replica 与路由策略；
- Data optimizer 和 executor。

当链接仍存在但符号名不匹配时，先在当前仓库 `rg`，再以测试和当前官方文档为准。不要把教程中的简化调用图当成稳定公共 ABI。

