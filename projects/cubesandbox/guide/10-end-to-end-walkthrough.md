# 模块 10：端到端源码导读与分层练习

## 1. 本章要完成什么

前面各章按组件讲解，本章改用一个具体场景把它们串起来：

> 客户端从模板创建一个允许有限出网、禁止无令牌公开访问、超时自动暂停的 Sandbox，进入其中执行 Python，随后再次连接触发自动恢复，最后销毁。

重点不是记住所有函数，而是形成一种源码阅读方法：每到一个组件边界，都能说清“输入模型、状态变化、下游调用、失败补偿、可观测标识”。

## 2. 场景与请求

先用抽象请求描述目标：

```json
{
  "templateID": "python-data-science-v1",
  "timeout": 600,
  "metadata": {
    "course": "cube-source-reading"
  },
  "envs": {
    "LESSON": "end-to-end"
  },
  "allow_internet_access": false,
  "network": {
    "allowPublicTraffic": false,
    "allowOut": [
      "pypi.org",
      "files.pythonhosted.org"
    ]
  },
  "lifecycle": {
    "onTimeout": "pause",
    "autoResume": true
  }
}
```

字段名以当前公开模型为参照，但不同 SDK 的构造器命名可能使用 snake_case。实际调用时应以 [`CubeAPI/src/models/mod.rs`](../../CubeAPI/src/models/mod.rs) 和所用 SDK 类型为准。

我们希望最终得到：

```json
{
  "templateID": "python-data-science-v1",
  "sandboxID": "...",
  "clientID": "...",
  "envdVersion": "...",
  "envdAccessToken": "...",
  "trafficAccessToken": "..."
}
```

`sandboxID` 是后续数据面路由和生命周期操作的主键；`envdAccessToken`、`trafficAccessToken` 只在相应安全模式下返回，用于连接沙箱服务，不能写入日志或前端持久存储。

## 3. 全链路总图

```text
应用/SDK
  │ POST /sandboxes
  ▼
CubeAPI (Axum)
  │ 校验公开模型，翻译内部请求
  │ POST /cube/sandbox
  ▼
CubeMaster (Gin + scheduler)
  │ 合并模板，选择节点，构造 gRPC
  ▼
Cubelet (containerd plugin + workflow)
  │ 存储 ─ 网络 ─ OCI spec ─ task
  ▼
containerd → CubeShim → CubeHypervisor/KVM
                         │ vsock
                         ▼
                    Guest cube-agent/PID1

应用/SDK
  │ <port>-<sandbox-id>.<proxy-domain>
  ▼
CubeProxy ──► 节点/沙箱 envd ──► Guest 内进程

Guest 出站 ─► TAP ─► CubeVS/eBPF ─► CubeEgress（若启用 L7 规则）─► Internet
```

这张图有两个独立入口：

- 管理请求走 CubeAPI/CubeMaster/Cubelet，即控制面；
- 命令、文件和用户端口走 CubeProxy 到沙箱，即数据面。

因此“创建成功”只证明控制面完成资源交付，并不自动证明 envd、Proxy、DNS 和出站策略都正确。

## 4. 第 1 站：SDK 只负责表达意图

官方 Python SDK 的入口可从 [`sdk/python/cubesandbox/sandbox.py`](../../sdk/python/cubesandbox/sandbox.py) 开始阅读，配置在 [`_config.py`](../../sdk/python/cubesandbox/_config.py)。

应用侧示意：

```python
from cubesandbox import Sandbox

sandbox = Sandbox.create(
    template="python-data-science-v1",
    timeout=600,
    env_vars={"LESSON": "end-to-end"},
    metadata={"course": "cube-source-reading"},
    allow_internet_access=False,
    network={
        "allow_public_traffic": False,
        "allow_out": ["pypi.org", "files.pythonhosted.org"],
    },
    lifecycle={"on_timeout": "pause", "auto_resume": True},
)

print(sandbox.sandbox_id)
```

阅读 SDK 时逐项检查：

1. API base URL 怎样得到；
2. API key 放在哪个 header；
3. Python 参数怎样映射成 JSON 字段；
4. timeout 是 HTTP 超时还是 Sandbox 生命周期超时；
5. response 凭据保存在哪个对象；
6. `close`、`kill`、上下文管理器的语义是否一致。

这里要避免一个常见误解：SDK 的 HTTP client timeout 与请求中的 Sandbox `timeout` 是两个概念。前者限制一次网络调用等多久，后者控制沙箱空闲/生命周期行为。

## 5. 第 2 站：CubeAPI 接住公开协议

### 5.1 路由

[`CubeAPI/src/routes.rs`](../../CubeAPI/src/routes.rs) 把：

```rust
.route("/sandboxes", post(sandboxes::create_sandbox))
```

注册到标准超时路由，并叠加 request ID、trace、压缩、CORS、鉴权和限流层。调试 401/429/请求超时时，应先确认请求是否真正进入 handler。

### 5.2 handler

[`CubeAPI/src/handlers/sandboxes.rs`](../../CubeAPI/src/handlers/sandboxes.rs) 的 `create_sandbox`：

1. 用 `Json<NewSandbox>` 反序列化；
2. 记录 template 和 timeout；
3. 调 `state.services.sandboxes.create_sandbox(body)`；
4. 成功后记录 `sandbox.created`；
5. 返回 `201 Created`。

handler 很薄，这意味着字段行为不应只在这里查。真正转换在 service。

### 5.3 service

在 [`CubeAPI/src/services/sandboxes.rs`](../../CubeAPI/src/services/sandboxes.rs) 中跟进 `create_sandbox`，把本场景字段逐一对照：

| 公开字段 | 内部结果 |
|---|---|
| `templateID` | 模板 ID/version annotations |
| `metadata` | labels；特殊行为字段可能转 annotation |
| `envs` | 校验后进入内部 env map |
| `timeout` | 保留缺失/0/正数/-1 的语义 |
| `lifecycle.onTimeout=pause` | `auto_pause=true` |
| `lifecycle.autoResume=true` | `auto_resume=true` |
| 网络 allow/deny | `CubeNetworkConfig` |
| `network.allowPublicTraffic=false` | CubeMaster 生成 traffic token，CubeProxy 禁止无令牌公共访问 |

环境变量会拒绝 `LD_PRELOAD`、`PYTHONPATH`、`PATH` 等危险名字。这里失败属于确定性参数错误，不应被下游调度重试。

### 5.4 CubeMaster client

[`CubeAPI/src/cubemaster/mod.rs`](../../CubeAPI/src/cubemaster/mod.rs) 使用共享 `reqwest::Client` 调 CubeMaster 的 `/cube/sandbox`。阅读 client 时记录：

- URL 拼接；
- header/request ID 传播；
- JSON request/response 类型；
- 非 2xx 和内部 `ret_code` 怎样映射；
- 网络超时与业务错误如何区分。

到这里，第一个边界表应写成：

| 项 | 内容 |
|---|---|
| 输入 | `NewSandbox` |
| 状态变化 | 尚未创建节点资源 |
| 下游 | CubeMaster HTTP |
| 失败补偿 | 无资源可回滚，直接返回参数/后端错误 |
| 观察键 | HTTP request ID、template ID |

## 6. 第 3 站：CubeMaster 解析模板并调度

### 6.1 HTTP 入口

CubeMaster 的创建入口位于 [`pkg/service/httpservice/cube/sandbox_create.go`](../../CubeMaster/pkg/service/httpservice/cube/sandbox_create.go)。`constructCreateReq` 解析请求，之后会执行白名单/模板等逻辑并进入 sandbox service。

模板合并集中在 [`cubeboxutil.go`](../../CubeMaster/pkg/service/httpservice/cube/cubeboxutil.go)。本场景只传模板 ID，没有重新描述完整容器，CubeMaster 要从模板补出：

- 镜像与 command；
- CPU/内存等资源；
- runtime/快照绑定；
- 容器和卷配置；
- 模板的 annotations/labels。

这是为什么 CubeAPI 不能擅自造一个空容器覆盖模板容器。

### 6.2 创建上下文

[`pkg/service/sandbox/sandbox_run.go`](../../CubeMaster/pkg/service/sandbox/sandbox_run.go) 的 `CreateSandbox` 创建 `createSandboxContext`。`Handle`/`handleCubelet` 把一次逻辑请求组织为：

```text
校验/资源换算
  → schedule
  → ConstructCubeletReq
  → callCubelet
  → 成功登记与持久化
  ↘ 失败分类、退避、failover
```

阅读时特别关注：

- `newContext`：哪些请求信息进入上下文；
- `schedule`：怎样选择 host；
- `refreshAndAdmitHost`：调度结果在调用前是否再次校验；
- `callCubelet`：gRPC 调用及返回；
- `errorCodeRetry`/`errRetry`：重试条件；
- `failover`：旧节点资源/记账怎样处理；
- `dealSuccResult`：成功后的 Redis、事件和 spec。

### 6.3 调度不是只选 CPU 最空的机器

一个模板恢复请求可能受到多重约束：

- CPU、内存和节点最大 MicroVM 数；
- 模板/快照副本是否在该节点；
- runtime component 版本兼容；
- 本地存储与设备能力；
- affinity/anti-affinity；
- 网络和资源元数据是否完整。

所以“节点还有内存”并不能证明调度应成功。学习调度器时，把过滤条件和打分条件分开：过滤决定能不能去，打分决定更愿意去哪。

### 6.4 构造 Cubelet 请求

[`pkg/service/sandbox/util.go`](../../CubeMaster/pkg/service/sandbox/util.go) 的 `ConstructCubeletReq` 是第二个模型转换关键点。它将 CubeMaster 类型转换为 protobuf `RunCubeSandboxRequest`，包括：

- containers/images/command/env；
- CPU、memory、instance type；
- volumes 和 annotations；
- exposed ports；
- network type/config；
- request ID 与 namespace。

在此处漏字段，CubeAPI 与 CubeMaster 日志看起来都正确，Cubelet 却永远收不到它。这是跨层新增字段最常见的断点。

## 7. 第 4 站：Cubelet 执行可回滚工作流

### 7.1 gRPC service

[`Cubelet/services/cubebox/service.go`](../../Cubelet/services/cubebox/service.go) 的 `Create` 先：

1. 建立 response，默认 success code；
2. 校验并补默认值；
3. 建立 `workflow.CreateContext`，设置 `Failover=true`；
4. 记录 trace、资源与指标；
5. 选择 runtime；
6. Cube runtime 走 `s.engine.Create`；
7. 把 workflow 错误转换成稳定 error code；
8. 从 context 填回 sandbox ID、IP、端口映射。

注意 gRPC transport 成功不代表业务成功。很多业务错误通过 response 的 `Ret.RetCode` 表达，CubeMaster 必须同时检查 transport error 和 ret code。

### 7.2 workflow DAG

工作流实现位于 [`Cubelet/plugins/workflow`](../../Cubelet/plugins/workflow)，默认配置可从 [`Cubelet/config/config.toml`](../../Cubelet/config/config.toml) 的 `io.cubelet.workflow.v1.workflow` 段开始读。

执行模型是：

```text
步骤 1：多个 action 并行
     全部成功
步骤 2：多个 action 并行
     全部成功
步骤 3：……
```

失败时 engine 触发配置中独立定义的 destroy workflow；它不会自动把“已完成 action 列表”倒放，因此各 `Destroy` 必须根据 Sandbox ID、节点状态和 context 幂等地判断资源是否存在。这里的 `CreateContext` 是创建阶段的数据总线，也是回滚能否找到部分资源的重要线索，典型内容包括：

- sandbox ID；
- storage/rootfs/volume 结果；
- TAP/网络信息；
- OCI/container/task 信息；
- VM 和 probe 状态；
- 指标时间点与回滚所需句柄。

### 7.3 本场景的资源变化

可以把创建过程简化成下表：

| 阶段 | 新增资源 | 失败时必须清理 |
|---|---|---|
| storage | 基于模板的 CoW rootfs、卷引用 | volume/refcount、挂载目录 |
| network | TAP、IP、策略状态、可能的 FD | TAP、IPAM、BPF map/state |
| OCI | bundle、config.json、container metadata | bundle、container record |
| task/VM | containerd task、Shim、VMM、Guest | task、shim、VM、socket |
| probe | envd 初始化、环境变量 | 已创建的前序资源 |

这解释了为什么不应把所有创建逻辑写进一个长函数：每个 action 必须明确 `Create` 和 `Destroy/rollback` 的对称性。

### 7.4 存储路径

模板 rootfs 通过 CubeCoW 的 reflink/volume 管理快速克隆，详见 [`Cubelet/storage/cubecow_volume_manager.go`](../../Cubelet/storage/cubecow_volume_manager.go)。如果是带内存快照的模板，还要准备 memory volume 和恢复元数据。

逻辑上的“克隆很快”不代表零空间：首次 clone 共享 extent，后续写入会分配新块；节点仍需做空间水位和 reflink 能力检查。

### 7.5 网络路径

TAP action 位于 [`Cubelet/network/plugin_tap.go`](../../Cubelet/network/plugin_tap.go)。在 network-agent 模式下，Cubelet 请求节点 agent 准备网络，并获得后续 VM 使用的 TAP/FD/状态。

本场景先用 `allow_internet_access=false` 设默认拒绝，再用 `allowOut` 添加域名例外；这些规则最终需要同时考虑：

- DNS 能否访问；
- CubeVS 的 L3/L4 allow/deny；
- CubeEgress 的域名/L7 决策；
- HTTPS 是否需要透明代理证书链。

只在控制面保存 `pypi.org` 字符串不会自动产生数据面隔离；必须确认规则被翻译并下发到实际执行点。

## 8. 第 5 站：containerd、Shim 与 MicroVM

Cubelet 准备 OCI spec 并创建 containerd task。runtime 配置把 task 交给 CubeShim，而不是普通 runc。

[`CubeShim/shim/src`](../../CubeShim/shim/src) 中的 Shim v2 实现负责把 containerd task 生命周期翻译成 VM 生命周期：

```text
containerd Create/Start
  → Shim 读取 OCI annotations/config
  → 创建 VMM 配置
  → CubeHypervisor 创建 KVM VM
  → 配置 vCPU、内存、virtio 设备
  → 启动 Guest kernel
  → 通过 vsock 连接 Guest Agent
```

从模板恢复时，路径会变成：

```text
恢复设备/VMM 状态
  + 映射/加载 guest memory
  + 绑定克隆后的 rootfs/数据盘
  → 恢复 vCPU 执行
```

关键源码入口：

- [`CubeShim/shim/src/sandbox`](../../CubeShim/shim/src/sandbox)：sandbox/task 管理；
- [`CubeShim/shim/src/hypervisor`](../../CubeShim/shim/src/hypervisor)：Shim 到 VMM 的适配；
- [`hypervisor/src`](../../hypervisor/src)：KVM、内存、设备、snapshot/restore；
- [`agent/src`](../../agent/src)：Guest PID1、ttrpc 服务和进程管理。

出现 VM 启动失败时按层查：OCI annotation 是否完整 → Shim 是否选对 start/restore → KVM ioctl/内存/设备是否成功 → Guest 是否启动 → vsock 是否连通。

## 9. 第 6 站：成功回传与控制面登记

Guest/envd probe 成功后，Cubelet response 填入：

- `sandbox_id`；
- sandbox IP；
- 暴露端口映射；
- `ext_info` 中的资源事件等扩展数据；
- success ret code。

CubeMaster 的 `dealSuccResult` 随后完成控制面登记，相关逻辑包括：

- sandbox 到 host/node 的关系；
- Proxy 路由所需 Redis 信息；
- 原始/归一化 spec 持久化；
- 模板、卷等引用变化；
- 生命周期计时与事件；
- 返回 CubeAPI 所需字段。

这是一个重要一致性窗口：节点资源可能已经成功，但登记 Redis/spec 失败。阅读代码时要确认失败处理是删除节点资源、重试登记，还是通过后续 reconcile 修复，不能假设一次 RPC 能天然原子化跨进程状态。

CubeAPI 收到成功响应后，把内部模型转换成公开 `Sandbox`，返回 201。至此控制面创建结束。

## 10. 第 7 站：执行 Python 走的是数据面

使用 E2B 兼容 SDK 时，示意代码是：

```python
from e2b_code_interpreter import Sandbox

sb = Sandbox(template="python-data-science-v1")
execution = sb.run_code("print(sum(i * i for i in range(10)))")
print(execution.text)
sb.kill()
```

`run_code` 不会再次让 CubeMaster 创建容器。SDK 根据 sandbox ID、目标端口和 proxy domain 构造数据面 host，类似：

```text
<port>-<sandbox-id>.<proxy-domain>
```

CubeProxy 的 Lua/OpenResty 逻辑解析 host/path，查 Sandbox 所在节点，校验 traffic token 和生命周期状态，再转发到 envd/Jupyter。

一次流式执行可能传回：

- stdout/stderr 片段；
- rich result；
- execution error；
- exit/完成状态。

SDK 必须持续消费流，不能把“HTTP 连接成功”误当作“代码执行成功”。对应实现可从 [`sdk/python/cubesandbox`](../../sdk/python/cubesandbox) 和 E2B SDK 依赖接口两侧对照阅读。

## 11. 第 8 站：Sandbox 的出站请求

如果 Python 执行：

```python
import urllib.request
print(urllib.request.urlopen("https://pypi.org/simple/", timeout=10).status)
```

数据包大致经历：

```text
Guest socket
  → virtio-net
  → host TAP
  → CubeVS eBPF policy/NAT
  → CubeEgress transparent proxy（按配置）
  → DNS/Internet
```

拒绝访问时逐层检查：

1. Guest DNS 配置和 DNS allow 规则；
2. network-agent 为 sandbox 保存的 policy；
3. CubeVS LPM/CIDR/端口 map；
4. TPROXY/策略路由是否把流量送到 CubeEgress；
5. CubeEgress 域名规则和 SNI/HTTP host 解析；
6. HTTPS 客户端是否信任所需证书。

如果 `pypi.org` 能开但 `files.pythonhosted.org` 不能开，应用层“pip 失败”可能只是第二个域名未加入 allow list。这也是为什么出站策略必须按真实依赖域名设计。

## 12. 第 9 站：超时暂停与自动恢复

600 秒超时到达且 `onTimeout=pause` 时，生命周期管理器发起 pause，而不是 destroy。pause 需要持久化足以恢复的状态：

- VMM/设备状态；
- Guest 内存；
- rootfs/卷关系；
- Sandbox 元数据和原节点/模板约束；
- Proxy 可见的生命周期状态。

随后客户端再次连接：

1. CubeProxy 或管理入口发现 Sandbox paused；
2. `auto_resume=true` 允许发起内部恢复；
3. CubeMaster 做容量/节点/模板检查；
4. Cubelet 走 restore workflow；
5. CubeShim/Hypervisor 恢复 VM；
6. 数据面等待 Sandbox ready 后再转发。

自动恢复不能简单地“先返回 200 再后台处理”，否则首个数据面请求会打到尚未 ready 的 envd。源码和测试中要特别关注并发连接、重复 resume、pause-in-progress 以及 `Retry-After` 语义。

## 13. 第 10 站：销毁与引用释放

最终 `DELETE /sandboxes/:id` 或 SDK `kill/close` 触发逆向清理：

```text
停止数据面接入
  → 停 task/Guest/VM/Shim
  → 删除 container/bundle
  → 回收 TAP/IP/BPF 状态
  → 卸载并释放 volume/refcount
  → 清理 CubeMaster 元数据和 Proxy 路由
```

销毁操作要满足幂等性：客户端超时重试、控制面重复事件或节点恢复后 reconcile 都可能再次请求删除。正确结果应是“资源最终不存在”，而不是第二次删除因 not found 让整个清理链中断。

Cubelet 在 response `ext_info` 中只报告成功发生的卷引用 1→0 等转换，避免失败回滚又被控制面重复记账。这类细节体现了分布式资源计数不能只靠“请求过一次”判断。

## 14. 把链路整理成边界表

完成源码走读后，建议自己重写下面这张表：

| 边界 | 输入 | 输出 | 主要失败 | 补偿/重试责任 |
|---|---|---|---|---|
| SDK → CubeAPI | 公开 JSON | HTTP response | 参数、鉴权、网络 | SDK 只重试安全请求；服务端校验 |
| CubeAPI → CubeMaster | 内部 JSON | create result | 后端超时、内部错误码 | CubeAPI 映射错误，避免盲目创建重放 |
| CubeMaster → Cubelet | protobuf gRPC | ID/IP/ports/ret | 节点故障、资源不足 | CubeMaster 分类重试/failover |
| Cubelet → workflow actions | `CreateContext` | 节点资源 | 半完成资源 | Cubelet 执行预配置的 destroy/cleanup workflow |
| containerd → Shim/VMM | OCI/task | VM/Guest | KVM、设备、Guest | Shim/Cubelet cleanup |
| SDK → CubeProxy/envd | host/path/token/stream | 执行事件 | route、token、paused、Guest | connect/auto-resume/客户端消费流 |
| Guest → Internet | packet/domain | 外部响应 | DNS、L3/L4、L7、TLS | 策略拒绝通常不可盲重试 |

## 15. 分层动手练习

### 练习 A：应用接入——完成并观察一次生命周期

目标：不改平台代码，建立使用者视角。

1. 按 [项目总览与使用说明](./00-project-overview-and-usage.md) 部署并准备模板；
2. 用 Python SDK 创建 Sandbox；
3. 写入一个文件、执行一段代码、读取 stdout；
4. 访问一个允许域名和一个拒绝域名；
5. 调整 timeout，观察 pause；
6. 再次连接并验证自动恢复；
7. kill 后确认数据面 URL 不再可达。

记录每一步的 HTTP status、sandbox 状态和 request/sandbox ID，不记录 secret。

### 练习 B：控制面字段追踪

选 `auto_resume`，从公开模型开始，写出它经过的每个类型/函数：

```text
CubeAPI NewSandbox
  → SandboxService 模型转换
  → CubeMaster CreateCubeSandboxReq
  → 持久化 spec/lifecycle metadata
  → connect/生命周期判断
```

要求给每个箭头附一个真实文件路径，并找出至少一个默认值测试。

### 练习 C：故障注入——envd probe 失败

先阅读 [`Cubelet/services/cubebox/probe_test.go`](../../Cubelet/services/cubebox/probe_test.go)，回答：

1. HTTP 错误与 transport 错误分别怎样重试？
2. envd capability annotation 如何影响 fallback？
3. probe 最终失败后 workflow 清理哪些资源？
4. CubeMaster 是否应换节点重试，为什么？

只在隔离测试环境做真实故障注入，不要在共享集群停止 envd。

### 练习 D：调度器实验

为两个假节点构造不同资源与模板副本状态：

- 节点 A：资源较多，但没有目标 snapshot/template replica；
- 节点 B：资源刚好，已有本地 replica。

阅读 CubeMaster scheduler 与模板绑定逻辑，预测过滤/打分结果，再用单元测试验证。随后让 B 返回磁盘满错误，检查 failover 是否符合预期。

### 练习 E：workflow 对称性审查

在 create workflow 中选一个 action，制作表格：

| 项 | 你的答案 |
|---|---|
| Create 前置条件 |  |
| Create 产生资源 |  |
| 资源句柄存放位置 |  |
| Destroy 是否幂等 |  |
| 部分成功怎样识别 |  |
| 并行 action 是否共享可变状态 |  |

尝试找到一个现有失败测试证明 cleanup，而不只是阅读成功路径。

### 练习 F：网络策略追踪

选择域名 `pypi.org`，沿以下路径找到代码/数据结构：

```text
公开 allowOut
  → CubeAPI network model
  → CubeMaster/Cubelet request
  → network-agent state
  → CubeVS CIDR/LPM 或 DNS 辅助规则
  → CubeEgress domain match
```

解释 DNS 返回多个 IP、TTL 变化、HTTPS SNI 与重定向域名会怎样影响规则。

### 练习 G：快照一致性

在 Guest 中同时运行一个持续写文件和修改内存计数器的程序，设计一次 snapshot/restore 验证：

- 文件内容对应哪个时刻；
- 内存计数器对应哪个时刻；
- 设备/网络连接是否可恢复；
- snapshot 过程中是否需要 freeze/quiesce；
- 失败后原 Sandbox 是否仍可使用。

先写预期不变量，再读 Hypervisor、CubeShim 与 CubeCoW 实现判断当前代码怎样满足它。

### 练习 H：新增只读字段的设计题

假设 API 要返回 `hostArchitecture`，先不写代码，列出：

1. 信息由哪个组件最早知道；
2. 经过哪些内部 response；
3. 是否允许暴露节点信息；
4. 旧 Cubelet/CubeMaster 为空时怎样兼容；
5. SDK 和 WebUI 类型如何更新；
6. 哪些测试能证明不会破坏旧客户端。

该练习训练的不是语法，而是跨层演进能力。

## 16. 四周学习计划

### 第 1 周：建立系统地图

- 阅读 00、01、07；
- 跑通一次创建、执行、销毁；
- 画出控制面与数据面两条路径；
- 能用自己的话解释 template、sandbox、snapshot、volume。

### 第 2 周：控制面与节点工作流

- 阅读 02、03；
- 逐行追踪一次 create；
- 跑 CubeAPI、CubeMaster、Cubelet 定向测试；
- 完成练习 B、C、D。

### 第 3 周：系统底座

- 阅读 04、05、06；
- 画出 VM 启动、网络出站和 snapshot restore 序列；
- 完成练习 E、F、G；
- 在具备 KVM/XFS/eBPF 的隔离环境做一次系统验证。

### 第 4 周：工程化修改

- 阅读 08、09 和本章；
- 选择一个小的只读/可观测性改动；
- 写测试、实现、格式化、跑影响矩阵；
- 用边界表解释变更影响；
- 让人类维护者完成代码、许可与 DCO 审查。

## 17. 最终自测

如果你不看教程也能完整回答下面问题，就已经具备独立阅读和小范围修改项目的基础：

1. `POST /sandboxes` 的公开字段至少经过哪两次模型转换？
2. 哪些错误由 CubeAPI 立即拒绝，哪些错误可能由 CubeMaster failover？
3. Cubelet 怎样知道失败时该清理哪些资源？
4. containerd task 为什么最终会成为 KVM MicroVM？
5. 创建成功后为什么还可能出现 Proxy 无法访问？
6. 域名 allow list 为什么同时涉及 DNS、eBPF 和 L7 代理？
7. pause/restore 需要同时保持哪几类状态一致？
8. 销毁请求为什么必须幂等？
9. 新增一个 API 字段为什么可能波及 Rust、Go、protobuf、SDK 与 WebUI？
10. 怎样用最小测试矩阵证明改动，而不是每次盲跑全部系统？

完成后，可回到 [教程索引](./README.md) 按自己的工作方向二次阅读。第二遍应尽量直接从本章给出的源码入口跳转，而不是只读文字说明。
