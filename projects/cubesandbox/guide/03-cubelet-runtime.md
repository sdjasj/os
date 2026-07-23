# 模块 3：节点运行时——Cubelet 工作流

## 1. 学习目标

读完本章，你应能：

- 解释 Cubelet 为什么既像 kubelet，又像内嵌 containerd；
- 从 gRPC `Create` 进入 workflow engine；
- 读懂“步骤串行、步骤内并行”的配置；
- 找到镜像、存储、网络、cgroup 和最终容器创建的位置；
- 理解创建失败后的 failover/cleanup；
- 知道怎样缩小 Cubelet 问题的测试范围。

## 2. Cubelet 的进程模型

入口 [`Cubelet/cmd/cubelet/main.go`](../../Cubelet/cmd/cubelet/main.go) 不只是普通 `main → listen`。它先处理 mount namespace：

1. 锁定 OS thread；
2. 创建新的 PID/mount namespace；
3. 设置 root mount propagation；
4. 建立 `/run/cube-containers/shared` 共享挂载；
5. bind 一个稳定的 namespace 文件；
6. 重新启动自身进入该 mount namespace。

背景原因：Sandbox 创建会进行大量 host/Guest 文件共享和 bind mount。独立 mount namespace 防止 Cubelet 内部 mount 污染宿主全局 namespace，同时 `rslave` 又允许宿主后来挂载的存储传播进 Cubelet。

这里很容易出现“宿主路径明明存在，Cubelet 看不到”的问题，本质通常是 mount propagation 而不是 Go 文件 API。

## 3. containerd 插件式架构

[`cmd/cubelet/builtins.go`](../../Cubelet/cmd/cubelet/builtins.go) 通过大量 blank import 注册：

- containerd 自带 content、metadata、snapshot、task、events 等插件；
- Cubelet 自己的 images、storage、network、cgroup、workflow、cubebox service；
- Cube runtime 与 CBRI 扩展。

这些包的 `init()` 调用 `registry.Register`。进程启动时 containerd plugin framework 根据 `Requires` 解析依赖并初始化插件。

因此阅读 Cubelet 不能只搜 `main()` 中“new service”。许多组件是在包初始化时注册，由配置中的 plugin ID 关联起来。

## 4. 配置是执行图

[`Cubelet/config/config.toml`](../../Cubelet/config/config.toml) 不只是端口和路径，它定义了生命周期工作流：

```toml
[plugins."io.cubelet.workflow.v1.workflow".flows.create]
concurrent = 100
actions = [
  ["createid", "appsnapshot"],
  ["images", "volume", "storage", "network", "netfile", "cube-sandbox-store"],
  ["cgroup"],
  ["cubebox"]
]
```

语义是：

```text
Step 1: createid || appsnapshot
                  ↓ 全部成功
Step 2: images || volume || storage || network || netfile || local store
                  ↓ 全部成功
Step 3: cgroup
                  ↓
Step 4: cubebox
```

为什么这样分组：

- 第二步多数准备工作彼此独立，并行能降低启动时延；
- cgroup 依赖前面已获得的资源上下文；
- 最终 `cubebox` 创建 containerd task/VM，必须在依赖资源都准备好后执行。

修改 action 分组等于修改启动 DAG，必须明确数据依赖和失败清理顺序。

## 5. gRPC 创建入口

CubeMaster 调用的服务实现在 [`Cubelet/services/cubebox/service.go`](../../Cubelet/services/cubebox/service.go)：

```go
func (s *service) Create(ctx context.Context,
    req *cubebox.RunCubeSandboxRequest,
) (*cubebox.RunCubeSandboxResponse, error)
```

主要步骤：

1. `checkParam` 校验请求；
2. `SetRunCubeSandboxRequestDefaultValue` 补 runtime、network、image storage 默认值；
3. 创建 `workflow.CreateContext`；
4. 设置 trace、namespace、resource；
5. 选择 Cube runtime 或其他 OCI runtime；
6. Cube runtime 调 `s.engine.Create(ctx, createInfo)`；
7. 将 workflow error 映射为 Cubelet ret code；
8. 返回 sandbox ID、IP、port mapping 和每阶段 metric。

注意 gRPC transport error 与响应中的 `Ret` 仍是两层。多数业务失败会返回一个合法 gRPC response，其中 `RetCode` 非成功。

## 6. CreateContext 是跨插件的数据总线

[`plugins/workflow/engine.go`](../../Cubelet/plugins/workflow/engine.go) 定义 `CreateContext`，包含：

- 原始 `RunCubeSandboxRequest`；
- `SandboxID`、CPU、内存、NUMA；
- `NetworkInfo`；
- `StorageInfo`、`VolumeInfo`、`CgroupInfo`；
- `NetFile`；
- `LocalRunTemplate`；
- metric 列表；
- volume ref transition events；
- `Failover` 与 `CubeBoxCreated` 标志。

不同 action 把结果写入同一个 context，后续 step 再读取。因为同一步 action 并行，任何共享字段都要明确唯一写入者或做好同步。

代码审查时可问：

- 这个字段在哪一步产生？
- 同一步是否有多个 goroutine 写它？
- 失败 cleanup 需要哪些字段？
- context 取消后 action 是否能及时退出？

## 7. Workflow Engine

[`plugins/workflow/plugin/plugin.go`](../../Cubelet/plugins/workflow/plugin/plugin.go) 读取 TOML 中的 action 名，从已注册 internal plugin map 找到实现 `workflow.Flow` 的对象，再组装 `Workflow`。

[`plugins/workflow/engine.go`](../../Cubelet/plugins/workflow/engine.go) 的 `run`：

1. 用 limiter 控制 flow 并发；
2. 遍历 steps；
3. 对每个 step 调 `parallelRunSteps`；
4. step 内用 `errgroup.WithContext` 并行 action；
5. 任一 action 失败，取消同组并返回；
6. create 失败且 `Failover=true`，异步触发 destroy；
7. destroy 失败再执行 cleanup flow。

简化代码：

```go
for _, step := range flow.Steps {
    if err := e.parallelRunSteps(do, ctx, opts, step); err != nil {
        if do == flow_create && opts.(*CreateContext).Failover {
            go e.failover(ctx, opts)
        }
        return err
    }
}
```

### 7.1 limiter

create flow 默认 `concurrent = 100`。`TryAcquire` 是立即失败，而不是无限排队；超过限制会返回 `ConcurrentFailed`。外层 CubeMaster 可据此重试/换节点，避免一个过载节点内部积累无界请求。

### 7.2 errgroup 取消不是强制终止

同一步一个 action 失败后，`ctxWithCancel` 会取消，但其他 goroutine 必须主动检查 context。阻塞在不支持 context 的系统调用上仍可能延迟返回。为新 action 设计外部命令或 I/O 时，应设置独立 timeout。

### 7.3 failover 的 context

原始 create context 可能已取消，所以 failover 会用 background context + 新 timeout，并保留 namespace、sandbox ID 和 trace 信息。补偿操作若继续使用已经 canceled 的 ctx，通常什么也清不掉。

## 8. 各 action 做什么

### 8.1 createid

生成 Sandbox ID，并把它放入 `CreateContext`。后续网络、存储和日志都以它为键。

### 8.2 appsnapshot

判断请求是模板创建、模板恢复还是普通冷启动，解析本地模板副本/快照目录和运行时绑定。

### 8.3 images

确保 OCI image/content 在本地存在，解析 image config 与 rootfs layer。对于模板恢复，很多基础制品已提前准备。

### 8.4 storage 与 volume

`storage` 管理 Sandbox rootfs 和内存快照对象，当前默认后端为 CubeCoW；`volume` 处理外部持久卷插件挂载。两者不是同一个概念：前者是运行时基础存储，后者是用户声明的业务数据卷。

### 8.5 network 与 netfile

network 通过 network-agent 确保 TAP、IP、路由、端口和策略；netfile 生成 Guest `/etc/hosts`、`resolv.conf`、hostname 等网络文件/共享配置。

### 8.6 cgroup

计算并设置宿主侧 CPU/内存限制。VM 规格与宿主 overhead 可能分别计算，不能只看 Guest 请求内存。

### 8.7 cube-sandbox-store

保存节点本地 Sandbox 元数据，支持 list、恢复和 cleanup。

### 8.8 cubebox

最终组装 OCI spec、创建 containerd container/task，触发 CubeShim 启动 MicroVM。

## 9. 从 cubebox action 到 containerd

[`services/cubebox/cube_container_create.go`](../../Cubelet/services/cubebox/cube_container_create.go) 是大文件，建议分四段读。

### 9.1 建立 Sandbox 元数据

`createContainers` 创建 `cubeboxstore.CubeBox`，记录：

- ID、namespace、labels、annotations；
- IP、port mappings；
- runtime 与 resource；
- snapshot restore binding；
- 容器列表与第一容器。

第一容器代表 Sandbox/pod 容器，ID通常等于 Sandbox ID；额外容器有独立 ID。

### 9.2 准备 rootfs 与挂载

`prepareContainerFiles` 根据 image storage 类型：

- ext4/pmem image：设置 pmem file；
- 普通 OCI layer：`EnsureImage`、`LocalResolve`，生成 virtiofs/overlay 共享目录；
- 外部卷：转换为 virtiofs mount config；
- 网络文件也作为共享 mount 加入。

### 9.3 生成 OCI Spec

`containerOciSpec` 叠加多个 `oci.SpecOpts`：

- image config 和 rootfs；
- VM runtime annotation；
- hooks；
- process/env/mount；
- cgroup、capability、rlimit、seccomp、sysctl；
- no-new-privileges；
- CBRI 的 VM 设备/快照 annotation。

`SpecOpts` 是函数列表，最后按顺序修改同一个 OCI Spec。后加入的 option 可能覆盖前面的字段，审查顺序非常重要。

### 9.4 CBRI：把 OCI Spec 扩展成 VM 配置

[`plugins/cbri/cubeboxcbri/cubebox.go`](../../Cubelet/plugins/cbri/cubeboxcbri/cubebox.go) 的 `CreateSandbox` 添加：

- `/dev/console`、`/dev/kmsg`；
- Guest kernel 路径；
- product 标识；
- snapshot create/restore/disable annotation；
- snapshot metadata 与 memory volume；
- virtiofs、pmem、视频等设备配置。

CubeShim 之后从 OCI annotations 解析出真正的 VM config。这是 containerd 抽象与 VMM 配置之间的关键契约。

## 10. Runtime 选择

Cubelet 配置：

```toml
[plugins."io.cubelet.internal.v1.cubebox".runtimes.cube]
runtime_type = "io.containerd.cube.rs"
runtime_cfg_path = "/usr/local/services/cubetoolbox/cube-shim/conf/config-cube.toml"
```

`getSandboxRuntime` 按 request 的 runtime handler 或默认 `cube` 查配置。若切到 runc 路径，workflow 外层相似，但最终隔离边界不同。调试“为什么没有启动 VM”时，先确认 runtime handler 和最终 OCI container 的 runtime type。

## 11. 失败和清理

创建可能在以下位置失败：

- image 拉取了一半；
- CubeCoW volume 已创建；
- TAP/IP 已分配；
- cgroup 已建立；
- container metadata 已保存但 task 未启动；
- VM 已启动但 probe 未通过。

workflow failover 会用 destroy 流程逆向清理。destroy 配置大致是：

```text
cubebox
  ↓
images || storage || cgroup || network || volume || netfile || store
  ↓
cleanup
```

先停运行实体，再回收它引用的资源。若顺序反过来，可能先删除仍在使用的 TAP/磁盘。

开发新 action 时必须同时实现 `Create`、`Destroy`、`CleanUp` 的合理语义，并保证幂等：重复释放不存在的资源通常应视为成功。

## 12. 网络 Agent 集成点

Cubelet 配置默认：

```toml
enable_network_agent = true
network_agent_endpoint = "grpc+unix:///tmp/cube/network-agent-grpc.sock"
network_agent_tap_socket = "/tmp/cube/network-agent-tap.sock"
```

控制请求走 gRPC Unix socket，TAP FD 通过单独 Unix socket 的 `SCM_RIGHTS` 传递。FD 不能放进普通 protobuf 字节字段后仍保持内核对象语义，所以需要专门的文件描述符传递通道。

## 13. 节点状态与 CubeMaster

Cubelet 定期上报：

- 节点 ready/health；
- CPU、内存与并发资源；
- 组件版本；
- 模板/快照本地性；
- 调度开关和 labels。

CubeMaster local cache 使用这些数据做 filter/score。若上报过期，即使 Cubelet 本身仍活着，调度器也可能正确地拒绝新请求。

## 14. 指标设计

每个 flow action 调用前后都会追加 `Metric{id, error, duration}`，service 返回时把它们放入 `ExtInfo`。CubeMaster再汇总 end-to-end、retry、Redis 等耗时。

若新增 action：

- ID 应稳定且不会与现有阶段冲突；
- error 也要记录时长；
- 不要只记录最终成功路径；
- high-cardinality 的 sandbox ID 不适合直接作为 Prometheus label，但适合日志字段。

## 15. 测试策略

优先从小到大：

```bash
cd Cubelet

# 工具/纯逻辑
go test ./pkg/allocator ./pkg/multilock ./pkg/pathutil

# workflow
go test ./plugins/workflow/...

# cubebox service
go test ./services/cubebox/...

# network client
go test ./pkg/networkagentclient/...
```

完整组件测试：

```bash
make cubelet-test
```

涉及 cgo CubeCoW、mount namespace、containerd、TAP 或 KVM 的测试可能需要 builder 镜像、root 和专用节点。不要为了让纯逻辑测试通过而把需要真实内核能力的集成逻辑全部 mock 掉；应分层保留两类测试。

## 16. 动手练习

### 练习 1：输出工作流 DAG

从 `config.toml` 手工写出 init/create/destroy/cleanup 四张 DAG，并为每个 action 标注其产物和清理对象。

### 练习 2：追踪 SandboxID

从 createid action 开始，找到 SandboxID 如何进入：

- `CreateContext`；
- network request；
- CubeCoW object name；
- containerd container ID；
- CubeShim sandbox config。

### 练习 3：故障注入思考

假设 network action 成功、storage action 失败：

1. errgroup 对同组其他 action 做什么？
2. failover destroy 在哪个 context 下运行？
3. network release 如何保证重复调用安全？
4. CubeMaster 是否应该换节点重试？

## 17. 自测题

1. 为什么 Cubelet 需要自己的 mount namespace？
2. blank import 为什么能注册服务？
3. 为什么 create workflow 的第二步可以并行？
4. `SpecOpts` 顺序为什么可能引入 bug？
5. 为什么 FD server 不能被普通 gRPC response 完全替代？

