# 模块 9：构建、测试、调试与贡献

## 1. 学习目标

本章把“读懂代码”转换成“能安全修改代码”的工作流。完成后你应当能够：

- 选择统一 builder 或组件本地工具链；
- 只构建、测试受改动影响的部分；
- 区分单元测试、集成测试和需要真实 KVM/网络环境的系统测试；
- 用 `request_id`、`sandbox_id` 和组件边界定位故障；
- 修改协议、Web API 或 eBPF 代码后执行正确的生成步骤；
- 在提交前完成格式化、差异审查和项目要求的人工合规检查。

## 2. 为什么这个项目不适合“一条命令在宿主机上全编译”

CubeSandbox 同时包含多套技术栈：

| 目录 | 主要语言/运行环境 | 额外依赖 |
|---|---|---|
| `CubeAPI`、`CubeShim`、`agent`、`hypervisor`、`cubecow` | Rust | musl、KVM、bindgen/clang、系统库 |
| `CubeMaster`、`Cubelet`、`network-agent`、`CubeOps` | Go | protobuf、containerd、CGO（部分包） |
| `CubeNet/cubevs` | Go + C/eBPF | clang/LLVM、内核 BTF/头文件、bpftool |
| `CubeProxy` | Lua/OpenResty | nginx/OpenResty、Lua 测试环境 |
| `web`、`sdk/node` | TypeScript | Node.js、npm |
| `sdk/python` | Python | Python 包工具、测试依赖 |

不同 Rust workspace 还各自持有工具链文件；Go 模块版本也可能不同。直接依赖宿主机工具链，常见结果是“某个组件能编译，另一个组件因版本或系统头文件失败”。

仓库因此在顶层 [`Makefile`](../../Makefile) 提供统一 builder 镜像。它把编译依赖封装起来，并把产物集中到 `_output/bin`。学习阶段除 WebUI、SDK 等轻量模块外，优先走这个入口。

## 3. 建立开发环境

### 3.1 先做只读检查

在仓库根目录执行：

```bash
git status --short
make help
docker version
uname -m
```

`git status --short` 很重要：工作区可能已有他人的修改。后续格式化、代码生成或构建清理不能误覆盖这些文件。

### 3.2 构建统一 builder

```bash
make builder-image
```

在中国大陆网络环境中，顶层 Makefile 支持：

```bash
make builder-image MIRROR=cn
```

已有镜像时目标会跳过重建；确实需要刷新镜像，可显式设置：

```bash
make builder-image BUILDER_FORCE_REBUILD=1
```

### 3.3 交互式与非交互式使用

进入持久化依赖缓存的交互式 shell：

```bash
make builder-shell
```

执行一次性命令：

```bash
make builder-run BUILDER_CMD='cd /workspace/CubeAPI && cargo check --locked'
```

顶层 Makefile 会把仓库挂到 `/workspace`，并把 builder 的 Cargo、Go 和普通缓存保存在独立目录中。这样既不会把容器内 `$HOME` 指向宿主机，也能避免每次重下所有依赖。

## 4. 构建策略

### 4.1 第一次不要直接构建全部内核和部署镜像

先构建与你要学习的链路对应的组件：

```bash
make cubeapi
make cubemaster
make cubelet
make shim
make agent
make network-agent
make cubeops
```

主产物会进入：

```text
_output/bin/
```

`make all` 构建顶层 `BINARIES` 中的用户态组件，但它不等于构建完整可部署系统：Guest kernel、系统镜像、WebUI、部署包仍有独立目标。

### 4.2 理解构建依赖，而不是把 Make 当黑盒

以 Cubelet 为例，顶层 [`Makefile`](../../Makefile) 的 `cubelet` 目标先：

1. 构建 CubeCoW Rust 静态库；
2. 把 `libcubecow.a` 和 C 头文件安装到 `Cubelet/third_party/cubecow`；
3. 下载 Go 模块；
4. 生成 protobuf；
5. 编译 `cubelet` 和 `cubecli`。

所以 Cubelet 出现链接错误时，不应只检查 Go 代码，还要检查 CubeCoW SDK 是否已经按当前源码重建。

CubeAPI 则构建 musl 静态目标：

```text
<host-arch>-unknown-linux-musl
```

这解释了为什么宿主机直接 `cargo build` 成功，并不保证顶层发布构建成功。

### 4.3 Guest kernel 是独立输入

仓库提供内核配置，但需要你指定 Linux 源码树：

```bash
make guest-kernel KERNEL_SRC=/absolute/path/to/linux
```

交叉构建示例：

```bash
make guest-kernel \
  KERNEL_SRC=/absolute/path/to/linux \
  KERNEL_TARGET_ARCH=aarch64
```

产物默认进入 `_output/kernel/<arch>`。内核源码作为独立挂载输入，并通过 out-of-tree build 使用，避免把编译产物写进其源码树。

### 4.4 手工更新包

```bash
make manual-release
```

它会把指定二进制打成带时间戳的 tar 包，并生成 SHA-256 文件和部署脚本，输出在 `_output/release`。这不是完整生产发布流程，但适合已有集群上的受控二进制更新。

## 5. 测试金字塔

### 5.1 第一层：最快的静态检查和定向单测

修改 Rust 时：

```bash
cd CubeAPI
cargo fmt --check
cargo test <test_name>
```

修改 Go 时：

```bash
cd CubeMaster
gofmt -w path/to/changed.go
go test ./path/to/package -run TestName -count=1
```

修改 WebUI 时：

```bash
cd web
npm run lint
npm run build
```

修改 Node SDK 时：

```bash
cd sdk/node
npm test
npm run typecheck
npm run build
```

定向测试适合快速反馈，但不能作为最终验证，因为跨包接口、生成代码和构建标签可能未被覆盖。

### 5.2 第二层：组件级测试

仓库根目录提供稳定入口：

```bash
make cube-api-test
make cubemaster-test
make cubelet-test
make shim-test
make network-agent-test
make cube-proxy-test
make cubeops-test
make cubecow-test-native
```

推荐按改动影响选择：

| 改动 | 最少应跑 | 建议追加 |
|---|---|---|
| CubeAPI handler/model | `make cube-api-test` | Node/Python SDK 测试、OpenAPI 同步检查 |
| CubeMaster 调度/生命周期 | `make cubemaster-test` | CubeAPI 测试、相关集成测试 |
| Cubelet workflow/action | `make cubelet-test` | CubeCoW 或 network-agent 测试 |
| CubeShim/hypervisor 协议 | `make shim-test` | agent、真实 KVM 冒烟测试 |
| CubeCoW FFI/磁盘布局 | `make cubecow-test-native` | Cubelet storage 测试、XFS reflink 实测 |
| CubeVS/network-agent | `make network-agent-test` | eBPF 加载、网络命名空间实测 |
| CubeProxy Lua | `make cube-proxy-test` | 部署环境入口访问测试 |
| CubeOps/WebUI | `make cubeops-test`、`make web-lint`、`make web-build` | 登录/刷新 token 的端到端测试 |

### 5.3 第三层：集成与系统测试

以下功能通常不能被普通单元测试充分证明：

- `/dev/kvm` 可用及 VM 真正启动；
- containerd 插件注册、Shim v2 生命周期；
- TAP FD 跨进程传递；
- eBPF 程序装载、map pinning 和实际 NAT；
- XFS reflink 的 CoW 行为与磁盘满时恢复；
- Guest vsock ttrpc 和 envd/Jupyter 数据面；
- pause、snapshot、restore 后的跨层状态一致性。

这类测试应在项目支持的 Linux 发行版、内核与部署拓扑中运行。Mac/Windows 开发机即使能编译控制面，也不能直接替代 Linux KVM 系统测试。

## 6. 代码生成：什么时候必须执行

### 6.1 protobuf/ttrpc

修改 `.proto` 后要使用组件 Makefile 中的生成目标，而不是手工编辑 `*.pb.go` 或生成的 Rust 文件。常见入口：

```bash
cd CubeMaster && make proto
cd Cubelet && make proto
cd network-agent && make proto
```

随后检查生成差异：

```bash
git status --short
git diff --stat
git diff -- path/to/generated/files
```

协议改动要同时审查生产者和消费者。例如 CubeMaster 与 Cubelet 共享 cubebox gRPC 语义；Shim 与 Guest Agent 共享 ttrpc/配置语义。只让一端编译通过是不够的。

### 6.2 eBPF skeleton/Go binding

CubeVS 的 C/eBPF 代码变更后，需进入 [`CubeNet/cubevs`](../../CubeNet/cubevs) 执行其 `make gen`。生成过程依赖 clang/LLVM 和正确的目标架构，优先在统一 builder 中完成。

### 6.3 OpenAPI 到 WebUI 类型

当 CubeOps 暴露给 WebUI 的 schema 变化时：

```bash
make web-api-sync
make web-lint
make web-build
```

同步后应检查类型变化是否只是预期字段，而不是因为服务启动失败生成了空文件或旧 schema。

## 7. 格式化与最小差异原则

仓库提供：

```bash
make fmt
make web-fmt
```

不过在多人或已有脏工作区中，不要第一步就对整个仓库格式化。更安全的顺序是：

1. `git status --short` 记录已有改动；
2. 只改任务涉及的文件；
3. 先运行对应组件 formatter；
4. `git diff --stat` 检查是否出现大范围机械差异；
5. 发现无关变化时停止并定位 formatter/生成器范围。

不要为了“让 diff 干净”删除不认识的未跟踪文件，也不要用破坏性 Git 命令覆盖现有改动。

## 8. 一套可重复的调试方法

### 8.1 先判定故障在哪个平面

| 现象 | 优先检查 |
|---|---|
| `POST /sandboxes` 立即 4xx | CubeAPI 校验、鉴权、限流、请求模型 |
| 创建等待后失败且换过节点 | CubeMaster 调度、Cubelet 返回码、failover |
| 已调度但 VM 未起来 | Cubelet workflow、containerd、CubeShim、KVM |
| Sandbox 显示 running，但执行命令失败 | CubeProxy、envd、Guest Agent、traffic token |
| Sandbox 能执行但不能出网 | network-agent、CubeVS policy/NAT、CubeEgress |
| pause 成功、resume 失败 | 内存/设备快照、模板绑定、节点资源、CubeShim restore |
| WebUI 401 循环 | CubeOps access/refresh token、cookie/header、前端重试 |

### 8.2 用稳定标识串日志

一次创建至少记录：

```text
request_id → sandbox_id → host_id/host_ip → template_id
```

推荐查询顺序：

1. CubeAPI 是否收到同一个 HTTP request ID；
2. CubeAPI 发给 CubeMaster 的内部请求 ID；
3. CubeMaster 选中了哪个 host，是否发生重试；
4. Cubelet 的 `RunCubeSandboxRequest` 与 workflow 步骤；
5. containerd task/shim/VM ID 是否与 sandbox 对应；
6. network-agent 是否保存了同一 sandbox 的网络状态；
7. CubeProxy 查路由时解析到哪个 node IP。

注意日志脱敏：创建请求可能含环境变量、挂载信息和访问凭据。不要为了调试把完整 token 或 secret 加入日志。

### 8.3 从“最后一个成功边界”定位

分布式链路不要只盯最终错误。记录每个边界的输入输出：

```text
SDK HTTP 成功？
  → CubeAPI 到 CubeMaster HTTP 成功？
    → CubeMaster 到 Cubelet gRPC 成功？
      → Cubelet workflow 哪一步最后成功？
        → Shim/VMM 是否收到 start？
          → Guest Agent 是否响应？
```

最后一个成功边界比最终的“500”更有信息量。例如 CubeMaster 已拿到 Cubelet 的 `NoSpaceLeftOnDevice`，问题应落到节点存储；若 Cubelet 已创建 VM 但 envd probe 超时，则不应继续修改调度器。

### 8.4 区分可重试和不可重试错误

CubeMaster 的 [`sandbox_run.go`](../../CubeMaster/pkg/service/sandbox/sandbox_run.go) 同时处理：

- 网络/调用错误；
- Cubelet 业务错误码；
- 退避；
- failover 到其他节点；
- 最终响应。

调试时必须问两个问题：

1. 这个错误是否节点特有，例如磁盘满、资源瞬时不足？
2. 前一次失败是否已经由 Cubelet 回滚干净，能否安全换节点重试？

把参数错误误标成可重试会放大请求并掩盖根因；把瞬时节点故障标成不可重试又会降低可用性。

## 9. 推荐的修改闭环

假设要给 `POST /sandboxes` 增加一个字段：

1. 在公开模型中定义字段和省略/默认语义；
2. 给 CubeAPI 校验和模型转换写测试；
3. 确认 CubeMaster 内部 JSON/protobuf 是否需要新字段；
4. 若下传 Cubelet，修改协议并重新生成；
5. 在 Cubelet workflow 中确定资源创建与回滚归属；
6. 更新 SDK 类型和序列化测试；
7. 若暴露给控制台，同步 CubeOps schema 和 WebUI；
8. 运行每层定向测试，再跑组件级测试；
9. 在支持 KVM 的环境做一次创建、执行、销毁；
10. 最后审阅 diff 和文档。

这里最难的不是“字段加在哪个 struct”，而是定义它在缺失、空值、零值、旧模板、旧节点和失败回滚时的语义。

## 10. 提交与合规要求

本仓库根级 `AGENTS.md` 规定：

- AI 代理不得添加 `Signed-off-by`；
- 人类提交者必须审查 AI 生成内容、核实许可证并自行完成 DCO 签署；
- AI 辅助的 commit/PR 需要 `Assisted-by: AGENT_NAME:MODEL_VERSION`；
- 完全由代理完成的 commit/PR 使用 `Autonomously-by: AGENT_NAME:MODEL_VERSION`。

这两类 attribution tag 与 DCO 的 `Signed-off-by` 不是一回事。实际提交前，以当前仓库的 `AGENTS.md`、贡献指南和 CI 规则为准。本教程只生成学习文档，不代替人类审查或签署。

提交前建议执行：

```bash
git diff --check
git status --short
git diff --stat
git diff
```

并确认：

- 没有密钥、token、主机地址或构建缓存；
- 没有无关格式化和生成文件；
- 新行为有测试和文档；
- 删除/失败路径与成功路径一样被覆盖；
- 变更没有绕过鉴权、网络策略或资源上限。

## 11. 动手练习

### 练习 1：建立最小测试矩阵

选择一个最近修改过的文件，回答：

1. 它属于哪个组件？
2. 直接消费者是谁？
3. 它是否改变协议或生成代码？
4. 最快定向测试是什么？
5. 最终至少应跑哪些组件目标？

把答案写成五行 checklist，再与本章表格比较。

### 练习 2：追踪一个已存在测试

从 [`Cubelet/integration/cubebox_lifecycle_test.go`](../../Cubelet/integration/cubebox_lifecycle_test.go) 选一个失败场景，追到：

```text
测试输入 → gRPC service → workflow action → errorcode → response
```

说明该错误是否适合被 CubeMaster failover。

### 练习 3：只读构建审计

不执行构建，仅阅读顶层 Makefile，列出 `make cubelet` 比 `go build ./...` 多做的事情，并解释每一步缺失时可能出现的错误。

## 12. 自测题

1. 为什么宿主机 `cargo test` 通过不能证明 musl 发布构建通过？
2. Cubelet 代码没改 Rust，为什么仍可能依赖 CubeCoW 静态库重建？
3. 什么改动必须执行 protobuf 或 OpenAPI 生成？
4. 为什么真实 KVM、TAP 和 eBPF 测试不能完全由 mock 替代？
5. 一次创建失败时，怎样找到“最后一个成功边界”？
6. `Assisted-by`、`Autonomously-by` 和人类 DCO `Signed-off-by` 有何区别？
