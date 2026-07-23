# 10. 集群、Ray Jobs 与 KubeRay

## 1. 从单机到集群，代码为什么通常不用改

Ray 的 Task、Actor 和上层库都通过逻辑资源调度。本机：

```python
ray.init()
```

已有集群或 Job 内：

```python
ray.init(address="auto")
```

业务代码中的 `.remote()`、Data、Train、Tune、Serve、RLlib API 通常保持不变。真正需要改变的是运行入口、依赖分发、共享存储、资源规模和运维方式。

## 2. Ray Cluster 的组成

```text
Ray Cluster
  ├─ Head Node
  │    ├─ GCS / control plane
  │    ├─ Dashboard / Jobs server
  │    ├─ Raylet / object store / workers
  │    └─ optional application processes
  └─ Worker Nodes (0..N)
       ├─ Raylet
       ├─ object store
       └─ task/actor worker processes
```

Head 是集群控制面入口，不等于专用 Driver，也不应该无条件承载大量业务任务。生产环境常把 Head 的逻辑 CPU 设置较低或为 0，尽量把应用计算调度到 Worker，保护控制面稳定性。

## 3. 手工启动一个本地/局域网集群

### 3.1 Head 节点

```bash
ray start --head --port=6379
```

命令会打印 Worker 加入所需地址和密码/参数。应复制本次实际输出，不要照搬教程里的示例 IP。

### 3.2 Worker 节点

在网络可达、Ray/Python 版本一致的另一台 Linux 机器上，使用 Head 输出的命令：

```bash
ray start --address=<HEAD_IP>:6379
```

### 3.3 Driver 连接

在集群节点内运行：

```python
ray.init(address="auto")
```

检查：

```bash
ray status
```

手工集群适合实验和受控 on-prem 环境，不包含云实例生命周期、Kubernetes 调度、自动恢复、TLS/入口策略等完整生产能力。

> 多节点 Ray 集群正式支持的目标平台是 Linux。Windows/macOS 适合本机开发，不应作为常规多节点生产方案。

## 4. 为什么生产提交优先使用 Ray Jobs

SSH 到 Head 后直接运行 `python app.py` 有几个问题：Shell 断开可能影响进程、代码如何到其他节点不清楚、作业状态不统一、历史和日志难管理。

Ray Jobs 把一次应用入口提交给已有集群的 Job Server，提供：

- entrypoint 命令；
- working directory 上传；
- Runtime Environment；
- Job ID、状态、日志和停止；
- CLI、Python SDK 和 REST API。

Job 的入口进程默认运行在 Head，但它提交的 Task/Actor 会按资源分布到集群。可使用 entrypoint 资源参数改变入口进程资源需求。

## 5. Ray Jobs CLI 完整流程

### 5.1 启动可接收 Job 的本地集群

```bash
ray start --head
```

Dashboard/Job Server 默认地址：`http://127.0.0.1:8265`。

### 5.2 准备应用目录

```text
my_job/
  ├─ app.py
  ├─ requirements.txt
  └─ my_package/
```

`app.py`：

```python
import ray

ray.init()

@ray.remote
def hello():
    return "hello from cluster"

print(ray.get(hello.remote()))
```

### 5.3 提交

```bash
ray job submit \
  --address http://127.0.0.1:8265 \
  --working-dir my_job \
  -- python app.py
```

双横线 `--` 把 Job 提交参数和应用 entrypoint 参数分开。若脚本需要参数：

```bash
ray job submit --working-dir my_job -- python app.py --epochs 10
```

### 5.4 后台运行与管理

```bash
ray job submit --no-wait --working-dir my_job -- python app.py
ray job status <JOB_ID>
ray job logs <JOB_ID>
ray job stop <JOB_ID>
ray job list
```

`stop` 是有状态操作，生产自动化中应先确认 Job ID、重试策略和业务副作用。

## 6. Job Runtime Environment

命令行 JSON：

```bash
ray job submit \
  --address http://127.0.0.1:8265 \
  --working-dir my_job \
  --runtime-env-json='{"pip": ["requests==2.32.3"], "env_vars": {"APP_ENV": "prod"}}' \
  -- python app.py
```

也可使用 YAML 文件描述环境。实践建议：

- 大型框架和系统库预装到节点镜像；
- 小型应用差异用 Runtime Environment；
- `working_dir` 只包含代码和必要配置；
- 用 `.gitignore`/`excludes` 排除数据、虚拟环境、日志和模型大文件；
- 生产依赖固定版本并保存 lockfile；
- 凭证由平台注入，不写进上传目录或命令历史。

## 7. Python SDK

```python
from ray.job_submission import JobSubmissionClient

client = JobSubmissionClient("http://127.0.0.1:8265")
job_id = client.submit_job(
    entrypoint="python app.py",
    runtime_env={"working_dir": "./my_job"},
    metadata={"job_name": "daily-batch"},
)

print(job_id)
print(client.get_job_status(job_id))
print(client.get_job_logs(job_id))
```

SDK 适合平台集成和调度系统。调用端应保存返回的 Job ID，实现提交幂等、超时、重试和状态对账，避免网络超时后重复提交同一业务工作。

## 8. Ray Client 与 Jobs 如何选

| 场景 | Ray Client | Ray Jobs |
| --- | --- | --- |
| Notebook 交互开发 | 合适 | 不够交互 |
| 短期远程调试 | 合适 | 合适 |
| 长时训练/批处理 | 不优先 | 推荐 |
| 调用端断网后继续运行 | 风险较高 | 更合适 |
| 统一 Job 状态和历史 | 有限 | 原生支持 |
| 生产自动化 | 谨慎 | 推荐 |

Ray Client 地址通常是 `ray://host:10001`；Ray Jobs 地址是 Dashboard HTTP 地址，如 `http://host:8265`，两者不要混淆。

## 9. VM Cluster Launcher

Ray 提供 VM 集群配置，描述 provider、节点类型、镜像、资源、初始化命令和 autoscaling：

```bash
ray up cluster.yaml
ray exec cluster.yaml 'ray status'
ray dashboard cluster.yaml
ray down cluster.yaml
```

适合 AWS、GCP、Azure 等 VM 环境。生产使用前要审查：

- 云账号与最小权限；
- 子网、安全组、SSH；
- 镜像和依赖；
- Head/Worker 节点类型；
- 最小/最大 Worker；
- Spot/抢占式实例恢复策略；
- 对象 spill 和持久存储；
- 日志、指标与成本标签。

不要在不了解云资源影响时直接执行创建/销毁命令。本教程只说明接口，不在当前仓库中发起任何云资源变更。

## 10. KubeRay

KubeRay Operator 用 Kubernetes 自定义资源管理 Ray。当前文档列出四种主要 CRD：

| CRD | 适用场景 | 生命周期 |
| --- | --- | --- |
| `RayCluster` | 开发、共享或长期集群 | 集群独立存在，多次提交应用 |
| `RayJob` | 一次性批处理/训练 | 可为 Job 创建并在完成后删除集群 |
| `RayService` | Ray Serve 生产服务 | 管理集群 + Serve，支持高可用/低停机升级 |
| `RayCronJob` | 周期性批任务 | 按 cron 创建 RayJob |

选择建议：

- 在线模型服务：RayService；
- 每次任务需要独立版本/资源且完成后释放：RayJob；
- 周期任务：RayCronJob；
- 低提交延迟、共享集群或开发：RayCluster。

KubeRay 负责 Ray 资源的 Kubernetes 生命周期，但仍需配置：Operator、RBAC、ServiceAccount、镜像、存储、网络、Pod 安全、节点选择、GPU Operator、监控和备份。

## 11. 两层资源与自动扩缩

在 Kubernetes 上同时存在：

```text
Ray Task/Actor 资源请求
       ↓
Ray Autoscaler 决定需要哪些 Ray Worker Pod
       ↓
Kubernetes Scheduler 放置 Pod
       ↓
Cluster Autoscaler 决定是否增加 Kubernetes Node
```

某个 Task Pending 可能卡在任一层：

- Ray 没有满足 bundle 的节点类型；
- Worker Pod Pending，Kubernetes 无资源；
- Kubernetes Cluster Autoscaler 无云配额；
- GPU/节点标签/污点不匹配；
- 镜像拉取或 Runtime Environment 安装失败。

排障要同时看 `ray status`、Ray Dashboard、`kubectl get pods` 和 Pod event。

## 12. Autoscaler 的重要语义

Ray Autoscaler主要响应不可满足的逻辑资源请求，而不是物理 CPU 利用率或业务 QPS。示例：

- 100 个 `num_cpus=1` Task Pending，会形成 CPU 资源需求；
- 一个 Serve Deployment 扩到 8 Replica，每 Replica `num_gpus=1`，会形成 8 GPU 需求；
- Task 错误声明 `num_cpus=0`，CPU 已满也未必正确触发扩容；
- 请求形状没有任何节点类型能满足时，增加很多小节点也没用。

因此节点类型必须能容纳最大单个 Task/Actor/Placement Group bundle。

## 13. 网络与安全

Ray 集群应运行在受信任网络边界内。不要把 GCS、Ray Client、Dashboard、Jobs Server 或 Serve 管理端口未经保护暴露到公网。生产至少要有：

- VPC/安全组或 Kubernetes NetworkPolicy；
- 入口鉴权、TLS 和审计；
- Dashboard/Jobs 的访问控制；
- 最小权限云 IAM/ServiceAccount；
- Runtime Environment 依赖来源控制；
- 容器非 root、镜像扫描和秘密管理；
- 不同信任级别工作负载的隔离。

提交 Ray Job 本质上允许在集群执行代码，所以 Job Server 是高权限入口。

## 14. 生产检查表

- Ray、Python、CUDA、框架版本在节点间一致；
- Head 有足够内存并避免重业务负载；
- Worker 资源声明与物理硬件匹配；
- 代码和依赖可在每个节点获取；
- 数据/检查点使用共享持久存储；
- Job 有唯一标识、幂等和失败策略；
- Autoscaler 节点类型能满足最大资源 bundle；
- Dashboard、Prometheus、Grafana和日志汇聚已配置；
- 端口未公开暴露，权限与凭证最小化；
- 已演练 Worker/节点失败和作业恢复；
- 有成本上限、空闲缩容和资源清理策略。

## 15. 本章对应的项目代码

- 集群概览：[`../doc/source/cluster/getting-started.rst`](../doc/source/cluster/getting-started.rst)
- Jobs 快速入门：[`../doc/source/cluster/running-applications/job-submission/quickstart.rst`](../doc/source/cluster/running-applications/job-submission/quickstart.rst)
- Jobs SDK：[`../doc/source/cluster/running-applications/job-submission/sdk.rst`](../doc/source/cluster/running-applications/job-submission/sdk.rst)
- VM 入门：[`../doc/source/cluster/vms/getting-started.rst`](../doc/source/cluster/vms/getting-started.rst)
- KubeRay：[`../doc/source/cluster/kubernetes/getting-started.md`](../doc/source/cluster/kubernetes/getting-started.md)
- RayJob：[`../doc/source/cluster/kubernetes/getting-started/rayjob-quick-start.md`](../doc/source/cluster/kubernetes/getting-started/rayjob-quick-start.md)
- RayService：[`../doc/source/cluster/kubernetes/getting-started/rayservice-quick-start.md`](../doc/source/cluster/kubernetes/getting-started/rayservice-quick-start.md)

下一章从运行状态、日志、指标、内存和性能五个层面学习观测与排障。
