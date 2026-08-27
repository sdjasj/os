# 16. Launcher 与多机启动：资源池怎样变成 rank 环境

分布式训练的第一个 collective 之前，系统必须先让每个进程对 world、rank、设备和 rendezvous 达成一致。DeepSpeed launcher 的职责是读取资源、筛选 slots、选择多机后端、把 world_info 分发到各节点，再由节点内 launcher 创建本地训练进程。

## 两层 launcher

不要把 `runner.py` 和 `launch.py` 当成重复代码：

```text
deepspeed CLI / launcher.runner
  → 解析 hostfile 与 include/exclude
  → 生成 active_resources / world_info
  → 选择 PDSH/OpenMPI/Slurm/... 或本地命令
  → 每个节点启动 deepspeed.launcher.launch
       → 解码 world_info
       → 计算 node_rank、global rank、world size
       → 为每个 local slot 创建训练子进程
       → 设置环境并执行 user script
```

[`runner.py`](runner.py) 是资源和跨节点控制面；`launch.py` 是节点内进程管理器。

## Hostfile 是可用资源池

MPI 风格 hostfile：

```text
worker-0 slots=8
worker-1 slots=8
```

`fetch_hostfile()` 解析为：

```python
{
    "worker-0": [0, 1, 2, 3, 4, 5, 6, 7],
    "worker-1": [0, 1, 2, 3, 4, 5, 6, 7],
}
```

Slot 是 accelerator id 的逻辑资源，不自动证明该设备健康、互联正确或其他作业没有占用。

## Include / exclude 过滤

```bash
deepspeed \
  --hostfile hostfile \
  --include 'worker-0@worker-1:0,2' \
  train.py
```

表示使用 worker-0 全部 slots 和 worker-1 的 0、2。Exclude 语法相同，但两者互斥。

源码还禁止把 `--num_nodes/--num_gpus` 与 include/exclude 混用，因为两套规则可能冲突。资源选择应只有一个权威来源。

## `CUDA_VISIBLE_DEVICES` 与显式资源参数

单机时 runner 可以检测 `CUDA_VISIBLE_DEVICES` 并转成 localhost include。若又传 include/exclude/num_gpus/num_nodes，源码会提示忽略可见设备变量或拒绝冲突。

这避免三种编号混乱：

- 物理设备 id；
- `CUDA_VISIBLE_DEVICES` 重映射后的进程内 id；
- launcher slot id。

训练脚本通常使用 LOCAL_RANK 选择“当前可见列表中的第几个设备”，不应重新解释为物理 id。

## World info 如何传输

过滤后的 active resources 被 JSON 编码，再做 URL-safe base64：

```python
world_info_base64 = base64.urlsafe_b64encode(
    json.dumps(active_resources).encode("utf-8")
).decode("utf-8")
```

它作为 `--world_info` 传给每个节点的 `deepspeed.launcher.launch`。这不是安全加密，只是让结构化参数安全穿过命令行；不要在 world_info 中放秘密。

节点端按相同 node list 和 local accelerator ids 计算：

```text
global world size = 所有节点 slots 数之和
global rank offset = 此节点之前所有节点 slots 数之和
global rank = offset + local process index
```

## 每个训练进程的关键环境

节点内 launcher 设置或传递：

| 变量 | 含义 |
| --- | --- |
| `MASTER_ADDR` | rendezvous 主节点可达地址 |
| `MASTER_PORT` | rendezvous 端口 |
| `WORLD_SIZE` | 全局训练进程数 |
| `RANK` | 当前全局 rank |
| `LOCAL_RANK` | 当前节点内 rank/设备索引 |
| accelerator visible env | 当前节点允许进程看到的 slots |

用户脚本还常收到 `--local_rank` 参数，除非启用 `--no_local_rank`。现代代码应能从环境/参数一致地获取本地 rank。

## Master 地址必须跨节点可达

单机可用 `127.0.0.1`；多机不能让每个节点都把 localhost 当 master。Runner 默认尝试从第一台 host 推断 IP，失败时应显式指定：

```bash
deepspeed \
  --hostfile hostfile \
  --master_addr 10.0.0.10 \
  --master_port 29500 \
  train.py
```

防火墙、容器网络、NAT、DNS 和端口占用都可能让“SSH 能连”但 rendezvous 不通。

## 多机后端的职责

`multinode_runner.py` 为 PDSH、OpenMPI、MPICH、Intel MPI、MVAPICH、Slurm 等生成命令。后端负责把节点端 launcher 放到每台机器并传播环境；节点端仍用相同 world_info 创建本地训练进程。

不同后端支持的 include/exclude、环境导出和网络参数不同。例如某些 MPI runner 明确不支持 worker include/exclusion。选择后端时应匹配现有集群调度器，而不是只看名称。

## no-SSH 模式

`--no_ssh` 让用户/调度器在每个节点独立启动 launcher，并显式提供 node rank、master address/port。优点是适配 Kubernetes/批处理系统；代价是外部系统必须保证：

- 每个节点启动一次且 node_rank 唯一；
- world_info/资源配置一致；
- master 先可达；
- 失败时所有节点都能终止。

## 环境传播边界

Launcher 会传播选定环境变量，也支持 `.deepspeed_env` 一类配置。环境经常包含 NCCL/UCX/代理/缓存设置，但不应把 token 或凭据写入公开脚本和日志。

异构节点还需防止把 rank 0 的硬件专用变量盲目导出到所有节点。源码维护特定环境排除规则，提示“统一环境”并不等于“复制全部环境”。

## 进程退出与信号

节点 launcher 追踪子进程，任一子进程异常时应终止其余 ranks，避免剩余进程永远卡在 collective。排查退出时区分：

- 训练进程 Python exception；
- OOM 被系统/accelerator 杀死；
- launcher/SSH/MPI 命令失败；
- rendezvous timeout；
- 某 rank 先退出导致其他 rank collective error。

第一个报错 rank 的日志通常比后续通信错误更接近根因。

## Elastic launch 与固定 world

Runner 还能接入 elastic launch，使用 min/max nodes 和 rendezvous 配置。Elastic 意味着故障后重启/成员变化，batch 和 checkpoint 必须遵循 elasticity 配置；不是给固定 launcher 加一个自动重试开关。

在掌握固定两节点前，不要同时引入 elasticity。

## 本章实验：只解析资源，不启动训练

用函数测试资源规则：

```python
from deepspeed.launcher.runner import parse_resource_filter, encode_world_info

pool = {
    "worker-0": [0, 1, 2, 3],
    "worker-1": [0, 1, 2, 3],
}

active = parse_resource_filter(pool, include_str="worker-0:0,2@worker-1:1")
print(active)
print(encode_world_info(active))
```

再解码 base64，确认结构不变。补充错误用例：未知 host、未知 slot、同时 include/exclude、重复 slot。

源码导航：

```bash
rg -n '^def (fetch_hostfile|parse_resource_filter|encode_world_info|main)' \
  deepspeed/launcher/runner.py
rg -n 'WORLD_SIZE|LOCAL_RANK|MASTER_ADDR|world_info' \
  deepspeed/launcher/launch.py
rg -n '^class .*Runner' deepspeed/launcher/multinode_runner.py
```

## 多机排障顺序

1. 每节点单卡运行用户脚本；
2. 单节点多卡确认 local ranks；
3. 两节点每节点单卡确认 rendezvous；
4. 两节点多卡确认 world_info；
5. 再加入 TP/PP/ZeRO；
6. 最后优化网络环境和 launcher backend。

每级都打印 rank、local rank、world size、hostname、device 和 group size，但不要泄露内部网络细节到公开日志。

## 常见误区

- 多机用 `127.0.0.1` 作为 master。
- 同时依赖 hostfile、CUDA_VISIBLE_DEVICES、include 和 num_gpus 四套选择。
- 把 base64 world_info 当加密。
- 假设 slot id 就是稳定物理 GPU id。
- 只看最后一个 NCCL timeout，忽略最先退出的 rank。
- 使用 no-SSH，却没有外部系统保证 node_rank 唯一。

## 自测

1. Runner 与节点内 launch 模块的职责分别是什么？
2. 为什么 include/exclude 与 num_nodes/num_gpus 互斥更安全？
3. WORLD_SIZE、RANK、LOCAL_RANK 分别用于什么？
4. 两节点 SSH 正常，为什么 distributed rendezvous 仍可能失败？
