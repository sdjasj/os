# CubeSandbox 项目总览与使用说明

> 这是一份面向“第一次接触本仓库的人”的入口文档。它先回答两个最实际的问题：这个项目解决什么问题，以及怎样把它用起来。若要继续读源码，请从同目录的 [`README.md`](./README.md) 开始按路线学习。

## 1. 一句话认识 CubeSandbox

CubeSandbox 是一个面向 AI Agent 的安全代码执行平台：客户端通过 E2B 兼容 API 创建一个沙箱，平台在 KVM MicroVM 中运行不可信代码，并同时提供模板、快照、克隆、暂停/恢复、网络策略、凭证注入、持久卷、集群调度和 Web 管理能力。

它不是“给 Docker 再包一层 HTTP API”。每个沙箱拥有独立 Guest 内核，宿主侧由调度器、节点 Agent、containerd Shim、VMM、eBPF 网络和 Copy-on-Write 存储共同完成创建与隔离。

典型使用场景包括：

- 让大模型生成并执行 Python、Shell 或工程代码；
- 为编程 Agent、SWE-bench、强化学习任务批量提供短生命周期环境；
- 在隔离环境中运行浏览器，再通过 Playwright/CDP 控制；
- 保存运行中环境的快照，并从同一点回滚或克隆出多个分支；
- 限制沙箱只能访问指定域名，同时由宿主代理注入 API Key，避免密钥进入沙箱；
- 用 E2B SDK、CubeSandbox 官方 Python/Node/Go SDK 或 REST API 接入。

## 2. 项目提供的主要能力

| 能力 | 对使用者的意义 | 主要实现位置 |
|---|---|---|
| 硬件级隔离 | 不可信代码运行在独立 Guest 内核中 | `hypervisor/`、`CubeShim/`、`agent/` |
| E2B 兼容 API | 现有 E2B 客户端只需改服务地址 | `CubeAPI/` |
| 集群调度 | 根据资源、节点状态和模板位置选择计算节点 | `CubeMaster/` |
| 节点生命周期管理 | 准备镜像、网络、存储和 cgroup，并创建/销毁沙箱 | `Cubelet/` |
| 毫秒级恢复 | 从预制 MicroVM 内存/设备快照恢复，而非每次完整冷启动 | `CubeShim/`、`hypervisor/` |
| 快照、回滚、克隆 | 保存运行现场并快速派生新环境 | `cubecow/`、`Cubelet/storage/` |
| 高密度网络数据面 | 用 eBPF 完成 TAP、NAT、连接跟踪和 L3/L4 策略 | `CubeNet/`、`network-agent/` |
| L7 出站安全 | 域名/路径策略、TLS 检查、凭证注入和审计 | `CubeEgress/` |
| 沙箱入口路由 | 将域名或路径中的沙箱 ID/端口路由到正确节点 | `CubeProxy/` |
| 自动暂停/恢复 | 空闲后保存状态，请求到来时透明唤醒 | `cube-lifecycle-manager/` |
| 运维与控制台 | 管理节点、模板、沙箱、版本和 AgentHub | `CubeOps/`、`web/`、`CubeDB/` |
| 多语言 SDK | 创建沙箱、执行命令、读写文件、PTY、快照 | `sdk/python/`、`sdk/node/`、`sdk/go/` |

## 3. 系统全景

下面把系统分成两条相互配合的链路。

### 3.1 控制面：创建和管理沙箱

```text
E2B / Cube SDK
      │ HTTP :3000
      ▼
  CubeAPI (Rust/Axum)
      │ HTTP
      ▼
  CubeMaster (Go/Gin)
      │ 过滤、打分、选节点
      │ gRPC :9999
      ▼
  Cubelet (Go + containerd plugins)
      │ containerd Shim v2
      ▼
  CubeShim (Rust)
      │ 内嵌 VMM API
      ▼
  CubeHypervisor (RustVMM/KVM)
      │ vsock/ttrpc
      ▼
  cube-agent (Guest PID 1)
```

CubeAPI 对外保持 E2B 风格；CubeMaster 负责集群级决策；Cubelet 负责单节点上的资源准备；CubeShim 把 containerd 的容器生命周期翻译成 VM 和 Guest Agent 操作；Hypervisor 最终与 KVM 交互。

### 3.2 数据面：进入沙箱和访问互联网

```text
客户端 ── HTTP/HTTPS ──> CubeProxy ──> 正确宿主机/端口 ──> 沙箱内 envd/Jupyter/用户服务

沙箱 ── TAP ──> CubeVS eBPF ──┬─> SNAT ──> Internet
                              └─> TPROXY ──> CubeEgress ──> Internet
```

控制面只负责“创建、查询、暂停、销毁”等管理操作。创建完成后，执行代码、运行命令和文件操作会访问沙箱内的 Jupyter/envd 服务，这些请求通过 CubeProxy，而不是继续穿过 CubeMaster。

## 4. 目录地图

### 4.1 核心运行链路

- `CubeAPI/`：Rust + Axum 的公开 REST API，负责鉴权、限流、参数校验和协议转换。
- `CubeMaster/`：Go 控制面，管理模板与节点元数据，调度请求并调用 Cubelet。
- `Cubelet/`：Go 节点 Agent，同时集成 containerd 插件体系和可配置工作流。
- `CubeShim/`：Rust containerd Shim v2，将 OCI/containerd 抽象接到 MicroVM。
- `hypervisor/`：基于 RustVMM/KVM 的 VMM，负责 vCPU、内存、virtio 设备和快照恢复。
- `agent/`：运行在 Guest 内、充当 PID 1 的 Agent，执行容器/进程/挂载/网络操作。

### 4.2 数据面与状态

- `network-agent/`：节点网络编排服务，分配 IP/TAP/端口并持久化本地网络状态。
- `CubeNet/`：CubeVS 的 eBPF C 程序及其 Go 控制库。
- `CubeProxy/`：面向入站请求的 OpenResty 路由代理。
- `CubeEgress/`：面向出站流量的透明 L7 安全代理。
- `cubecow/`：基于 `FICLONE`/XFS reflink 的 Rust CoW 存储引擎。
- `cube-lifecycle-manager/`：基于 Redis 事件协调自动暂停和恢复。
- `CubeDB/`：MySQL/PostgreSQL DAO 与迁移库。

### 4.3 用户入口与工程支持

- `sdk/`：Python、Node.js、Go 官方 SDK。
- `web/`：React + TypeScript + Vite 管理控制台。
- `CubeOps/`：WebUI 对应的运维/鉴权后端。
- `examples/`：代码执行、浏览器、快照、网络策略、Agent 集成等示例。
- `deploy/`：一键部署、PVM、Kubernetes 和 Guest 镜像构建资源。
- `configs/`：内核及单机配置。
- `docs/`：用户、架构、开发和变更文档。

## 5. 使用前必须理解的环境要求

完整平台依赖 Linux 内核能力，不能把它当成普通的跨平台 Web 项目直接在任意笔记本上跑起来。

### 5.1 运行完整沙箱平台

- Linux x86_64 或 aarch64；
- 原生 KVM、嵌套虚拟化，或 x86_64 普通云主机上的 PVM；
- root 权限；
- Docker；
- glibc 2.31 或更高；
- `/data/cubelet` 位于支持 reflink 的 XFS 文件系统；
- 功能体验至少约 4 CPU、8 GB 内存、50 GB 磁盘，开发多个模板时建议更大。

检查原生 KVM：

```bash
test -r /dev/kvm && test -w /dev/kvm
lsmod | grep kvm
```

检查文件系统：

```bash
findmnt -no FSTYPE,OPTIONS /data/cubelet
xfs_info /data/cubelet | grep reflink
```

如果只学习某个用户态组件，可以在普通开发机上单独运行其单元测试。例如 CubeAPI、SDK、CubeMaster 的纯单元测试不一定要求本机真的启动 MicroVM；但涉及 eBPF、TAP、KVM、挂载命名空间和 XFS reflink 的集成测试仍需要对应内核能力。

## 6. 最快使用方式：安装发布包

### 6.1 已有原生 KVM 的裸金属/物理机

项目提供在线安装脚本。国内镜像路径和国外路径不同，权威命令应以仓库当前的中文[快速开始](../zh/guide/quickstart.md)和[裸金属部署](../zh/guide/bare-metal-deploy.md)为准。

安装后主要入口为：

- CubeAPI：`http://<控制节点>:3000`
- WebUI：`http://<控制节点>:12088`
- CubeMaster：默认 `127.0.0.1:8089`
- Cubelet gRPC：默认 `:9999`

### 6.2 普通 x86_64 云服务器

普通云服务器若没有 `/dev/kvm`，先按[快速开始](../zh/guide/quickstart.md)安装 PVM 宿主内核，再执行一键安装。PVM 路线目前面向 x86_64；ARM64 应使用已暴露原生 KVM 的机器。

### 6.3 从源码构建完整发布包

根 [`Makefile`](../../Makefile) 使用统一 builder 镜像保证 Go/Rust/C 工具链一致：

```bash
make builder-image
make all
make manual-release
```

产物默认写入：

- 二进制：`_output/bin/`
- 发布包：`_output/release/`

随后遵循[本地构建部署](../zh/guide/self-build-deploy.md)中的 `install.sh` 流程。完整构建会下载较多依赖和镜像，且发布包应在与目标机相同的 CPU 架构上原生构建。

## 7. 创建模板

Sandbox 不是直接从任意 OCI 镜像“临时冷启动”的。通常先把 OCI 镜像制作成可快速恢复的模板：

```bash
cubemastercli tpl create-from-image \
  --image cube-sandbox-int.tencentcloudcr.com/cube-sandbox/sandbox-code:latest \
  --writable-layer-size 1G \
  --expose-port 49999 \
  --expose-port 49983 \
  --probe 49999
```

国内网络可使用仓库文档中列出的 `cube-sandbox-cn.tencentcloudcr.com` 镜像。命令返回 `job_id` 后查看进度：

```bash
cubemastercli tpl watch --job-id <job_id>
```

模板状态成为 `READY` 后，保存它的 `template_id`。

两个端口的角色是：

- `49999`：代码解释器/Jupyter 数据面；
- `49983`：envd 的命令、文件系统和 PTY 数据面。

## 8. 用 Python 调用

### 8.1 E2B 兼容 SDK

```bash
python3 -m pip install e2b-code-interpreter

export E2B_API_URL=http://127.0.0.1:3000
export E2B_API_KEY=e2b_000000
export CUBE_TEMPLATE_ID=<template_id>
export SSL_CERT_FILE=/root/.local/share/mkcert/rootCA.pem
```

```python
import os
from e2b_code_interpreter import Sandbox

with Sandbox.create(template=os.environ["CUBE_TEMPLATE_ID"]) as sandbox:
    result = sandbox.run_code("print(sum(range(10)))")
    print(result)

    cmd = sandbox.commands.run("uname -a")
    print(cmd.stdout)

    sandbox.files.write("/tmp/hello.txt", "hello CubeSandbox")
    print(sandbox.files.read("/tmp/hello.txt"))
```

`E2B_API_KEY` 是否能填任意非空值取决于部署是否启用了 CubeAPI 鉴权。未启用鉴权的本地体验环境中，它主要用于满足 E2B SDK 的非空校验；生产环境应配置并使用真实密钥。

### 8.2 官方 CubeSandbox Python SDK

```bash
python3 -m pip install cubesandbox

export CUBE_API_URL=http://127.0.0.1:3000
export CUBE_TEMPLATE_ID=<template_id>
export CUBE_PROXY_NODE_IP=<cube-proxy-node-ip>
```

```python
from cubesandbox import Sandbox

with Sandbox.create(timeout=300) as sandbox:
    print(sandbox.run_code("21 * 2").text)
    print(sandbox.commands.run("id").stdout)
```

官方 SDK 的实现和更多文件、PTY、卷、网络策略示例位于 [`sdk/python/`](../../sdk/python/README.zh.md)。

## 9. 直接使用 REST API

健康检查：

```bash
curl -s http://127.0.0.1:3000/health
```

创建沙箱：

```bash
curl -sS http://127.0.0.1:3000/sandboxes \
  -H 'Content-Type: application/json' \
  -H 'X-API-Key: <key>' \
  -d '{
    "templateID": "<template_id>",
    "timeout": 300,
    "metadata": {"purpose": "learning"}
  }'
```

列出、暂停、连接和删除：

```bash
curl -sS http://127.0.0.1:3000/sandboxes
curl -sS -X POST http://127.0.0.1:3000/sandboxes/<sandbox_id>/pause
curl -sS -X POST http://127.0.0.1:3000/sandboxes/<sandbox_id>/connect \
  -H 'Content-Type: application/json' -d '{}'
curl -sS -X DELETE http://127.0.0.1:3000/sandboxes/<sandbox_id>
```

若部署未启用鉴权，可省略 `X-API-Key`；若启用了鉴权，每个管理请求都必须带合法凭据。

## 10. 数据面地址为什么长这样

SDK 创建沙箱后，会构造如下域名：

```text
<port>-<sandbox_id>.<sandbox_domain>
```

例如：

```text
49999-7c8fbcd45ffe450fb8f7fb223ad45507.cube.app
```

CubeProxy 在 [`rewrite_phase.lua`](../../CubeProxy/lua/rewrite_phase.lua) 中解析端口和沙箱 ID，再从 Redis 读取 CubeMaster 写入的后端映射。如果客户端没有 wildcard DNS，也可以使用路径模式：

```text
http://<proxy-ip>:<port>/sandbox/<sandbox_id>/<container_port>/<原始路径>
```

远程客户端常通过 `CUBE_PROXY_NODE_IP` 直接连接 Proxy IP，同时保留上述 `Host` 头完成路由。

## 11. WebUI

一键部署默认可通过 `http://<控制节点>:12088` 打开控制台。当前源码中：

- [`web/src/main.tsx`](../../web/src/main.tsx) 定义页面路由；
- [`web/src/lib/api.ts`](../../web/src/lib/api.ts) 封装 SDK 与 Ops 请求；
- CubeOps 默认监听 `:3010`，负责登录、JWT、集群和 AgentHub 等运维 API；
- WebUI 使用 access token，并在 401 时尝试用 refresh token 换取新令牌。

本地前端开发：

```bash
make web-install
make web-dev
# 浏览器访问 http://localhost:5173
```

构建与检查：

```bash
make web-lint
make web-build
```

## 12. 常用开发命令

根目录提供统一入口：

```bash
make help

# 单组件构建
make cubeapi
make cubemaster
make cubelet
make shim
make agent
make network-agent

# 单组件测试（多数在 builder 容器内）
make cube-api-test
make cubemaster-test
make cubelet-test
make shim-test
make network-agent-test
make cube-proxy-test
make cubeops-test

# 格式化各组件
make fmt
```

若只修改一个组件，优先进入该目录运行较小范围测试，例如：

```bash
cd CubeAPI && cargo test
cd CubeMaster && go test ./pkg/scheduler/...
cd network-agent && go test ./internal/service/...
cd cubecow && cargo test --lib
```

命令是否需要 root、KVM、XFS 或 eBPF 权限取决于测试类型。先跑纯单元测试，再在满足内核条件的测试节点执行集成/E2E 测试。

## 13. 运行后如何排查

### 13.1 先判断故障在哪条链路

1. `GET :3000/health` 不通：先查 CubeAPI 进程、监听地址和鉴权前置配置。
2. 创建请求返回调度错误：查 CubeMaster 节点缓存、节点资源、模板副本和 Cubelet gRPC。
3. 创建时卡在节点准备：查 Cubelet 工作流各步骤、containerd 和 network-agent。
4. VM 启动/恢复失败：查 CubeShim、Hypervisor、KVM、快照制品和 Guest Agent。
5. 创建成功但代码/命令不通：查 DNS/Host、CubeProxy、Redis 后端映射、端口暴露和沙箱内 envd。
6. 沙箱不能访问外网：查 network-agent/CubeVS 的 L3/L4 策略，再查 CubeEgress 的 L7 策略。

### 13.2 一键部署的常见日志目录

| 组件 | 默认路径 |
|---|---|
| CubeAPI | `/data/log/CubeAPI/` |
| CubeMaster | `/data/log/CubeMaster/` |
| Cubelet | `/data/log/Cubelet/` |
| CubeShim | `/data/log/CubeShim/` |
| Hypervisor | `/data/log/CubeVmm/` |
| CubeProxy | `/data/log/cube-proxy/` |
| CubeOps | `/data/log/CubeOps/` |

尽量用同一个 `request_id`/`sandbox_id` 跨组件检索，它们是串起分布式调用的主线。

## 14. 推荐的源码阅读顺序

不建议从 Hypervisor 的几万行设备模型开始。按一次真实请求向下读更容易建立心智模型：

1. [`CubeAPI/src/routes.rs`](../../CubeAPI/src/routes.rs)：有哪些公开 API；
2. [`CubeAPI/src/services/sandboxes.rs`](../../CubeAPI/src/services/sandboxes.rs)：公开模型怎样翻译为 CubeMaster 请求；
3. [`CubeMaster/pkg/service/sandbox/sandbox_run.go`](../../CubeMaster/pkg/service/sandbox/sandbox_run.go)：调度、重试和 Cubelet 调用；
4. [`Cubelet/services/cubebox/service.go`](../../Cubelet/services/cubebox/service.go)：节点创建入口；
5. [`Cubelet/config/config.toml`](../../Cubelet/config/config.toml)：节点工作流实际顺序；
6. [`Cubelet/plugins/workflow/engine.go`](../../Cubelet/plugins/workflow/engine.go)：步骤串行、步骤内并行和失败回滚；
7. [`CubeShim/shim/src/sandbox/sb.rs`](../../CubeShim/shim/src/sandbox/sb.rs)：VM 启动/恢复和 Guest Agent 连接；
8. [`CubeShim/shim/src/hypervisor/cube_hypervisor.rs`](../../CubeShim/shim/src/hypervisor/cube_hypervisor.rs)：Shim 如何调用 VMM；
9. [`agent/src/rpc.rs`](../../agent/src/rpc.rs)：Guest 内最终执行的 RPC；
10. 网络和存储再分别沿 `network-agent → CubeNet`、`Cubelet/storage → cubecow` 阅读。

## 15. 继续学习

回到教程索引 [`README.md`](./README.md)，按背景知识、控制面、节点运行时、虚拟化、网络、存储、SDK 与运维等模块逐步学习。每一章都包含源码入口、关键代码解读、动手练习和自测问题。
