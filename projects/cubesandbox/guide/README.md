# CubeSandbox 源码学习教程

这套教程面向希望从“会使用”走到“能定位问题、能修改代码”的学习者。内容以本仓库当前代码为准，不仅描述组件职责，还会把一次 Sandbox 请求放进真实函数、协议和配置中解释。

## 如何使用这套教程

建议先读项目说明，再按顺序学习。每一章末尾都有动手练习和自测题。第一次阅读时不用钻进所有第三方依赖；先建立请求链路，再按工作方向深入。

| 顺序 | 模块 | 目标 |
|---|---|---|
| 0 | [项目总览与使用说明](./00-project-overview-and-usage.md) | 知道项目做什么并运行第一个沙箱 |
| 1 | [背景知识与总体架构](./01-background-and-architecture.md) | 补足 KVM、MicroVM、OCI、containerd、eBPF、CoW 等概念 |
| 2 | [控制面：CubeAPI 与 CubeMaster](./02-control-plane.md) | 读懂 API 翻译、调度、重试和元数据写入 |
| 3 | [节点运行时：Cubelet 工作流](./03-cubelet-runtime.md) | 读懂节点插件、并行步骤、资源准备和回滚 |
| 4 | [虚拟化链路：CubeShim、Hypervisor 与 Guest Agent](./04-virtualization-and-guest.md) | 读懂 containerd 到 KVM、再到 Guest 进程的桥接 |
| 5 | [网络与安全代理](./05-network-and-security.md) | 读懂 TAP、eBPF NAT/策略、入口路由和透明出口代理 |
| 6 | [存储、模板、快照与克隆](./06-storage-snapshot-template.md) | 读懂 XFS reflink、CubeCoW、内存快照和模板恢复 |
| 7 | [SDK 与沙箱数据面](./07-sdk-and-data-plane.md) | 读懂控制面/数据面的分离、流式协议和多语言 SDK |
| 8 | [CubeOps、数据库与 WebUI](./08-ops-db-webui.md) | 读懂鉴权、迁移、运维 API 和 React 查询/变更 |
| 9 | [构建、测试、调试与贡献](./09-development-workflow.md) | 建立安全高效的本地开发工作流 |
| 10 | [端到端源码导读与练习](./10-end-to-end-walkthrough.md) | 用一个创建请求串起全栈，并完成分层练习 |

## 三条可选路线

### 应用接入路线

适合只想用好 Sandbox 的开发者：

```text
00 → 01 的前半 → 07 → 05 的 CubeProxy/CubeEgress 部分 → 10 的练习 A
```

### 控制面/平台路线

适合开发 API、调度、模板、控制台和集群功能：

```text
00 → 01 → 02 → 03 → 06 → 08 → 09 → 10
```

### 运行时/系统路线

适合开发 MicroVM、网络、存储和性能功能：

```text
00 → 01 → 03 → 04 → 05 → 06 → 09 → 10
```

## 阅读代码时统一使用的几个标识

- `request_id`：一次管理请求的链路标识，适合跨 CubeAPI、CubeMaster 和 Cubelet 对日志。
- `sandbox_id`：一个沙箱的逻辑 ID，也是 Proxy 路由、网络状态和快照绑定的重要键。
- `template_id`：可复用运行环境/快照模板的逻辑 ID。
- `host_id` / `host_ip`：调度后承载沙箱的计算节点。
- `container_port`：沙箱内服务端口；Proxy 会把它与 `sandbox_id` 一起解析。
- `traffic_access_token`：关闭公共访问后，CubeProxy 校验的数据面访问令牌。

## 版本与文档边界

仓库包含演进中的代码和历史文档。若说明与实现不一致，学习教程按以下优先级判断：

1. 当前分支的路由注册、协议定义和配置；
2. 当前分支的单元测试；
3. 组件 README 与架构文档；
4. 较早的部署说明或注释。

例如当前 WebUI 源码通过 CubeOps 的 JWT 与 SDK/Ops 路径工作，而部分较早的 WebUI 文档仍以 CubeAPI 直连描述。遇到这类差异，应从 [`web/src/lib/api.ts`](../../web/src/lib/api.ts)、[`CubeOps/internal/server/server.go`](../../CubeOps/internal/server/server.go) 和部署 nginx 配置共同确认。

## 学习成果检查

完成全部章节后，你应该能回答：

1. 为什么创建 Sandbox 和执行 Sandbox 内命令走不同的网络路径？
2. CubeMaster 为什么能重试到另一节点，Cubelet 又怎样清理半完成资源？
3. 为什么 Cubelet 的 workflow 是“步骤串行、步骤内并行”？
4. containerd 看见的是容器，CubeSandbox 为什么实际启动的是 MicroVM？
5. 一条沙箱出站 HTTPS 请求分别在哪些层做 L3/L4 与 L7 决策？
6. `FICLONE` 为什么能让快照很快，又为什么仍需要 XFS 空间规划？
7. 从模板恢复时，设备状态、内存数据和 rootfs 各自来自哪里？
8. WebUI 的 401 自动刷新与 CubeOps refresh token 轮换怎样配合？

