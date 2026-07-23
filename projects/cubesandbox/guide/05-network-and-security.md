# 模块 5：网络与安全代理

## 1. 学习目标

本章覆盖 Sandbox 网络的完整往返路径。读完后，你应能：

- 区分 network-agent、CubeVS、CubeProxy 和 CubeEgress；
- 解释 TAP、FD 传递、eBPF map、NAT 和连接跟踪；
- 解释 Host 模式与 Path 模式如何路由到 Sandbox；
- 理解 L3/L4 与 L7 策略怎样叠加；
- 理解自动暂停请求为什么需要 Proxy gate；
- 用分层方法排查“创建成功但网络不通”。

## 2. 四个组件不要混淆

| 组件 | 流量方向 | 主要职责 |
|---|---|---|
| network-agent | 控制/编排 | 创建 TAP、分配 IP/端口、写 CubeVS map、持久化状态 |
| CubeVS | 内核逐包数据面 | NAT、连接跟踪、策略、ARP、redirect |
| CubeProxy | 外部 → Sandbox | 按 Sandbox ID/port 路由入站 HTTP/HTTPS |
| CubeEgress | Sandbox → 外部 | 透明 L7 策略、TLS 检查、凭证注入、审计 |

network-agent 本身不处理每个正常数据包；它配置内核中的 CubeVS。CubeProxy 也不是 Sandbox 默认网关；它只处理面向 Sandbox 服务的入站请求。

## 3. 每个 Sandbox 的基础网络对象

```text
Guest virtio-net
      │
      ▼
Host TAP（每 Sandbox 独立）
      │ TC ingress/egress eBPF
      ▼
CubeVS maps / host NIC / cube-dev / TPROXY
```

独立 TAP 的 ifindex 既是转发信息，也可作为 per-sandbox policy map 的 key。

## 4. network-agent API

协议在 [`network-agent/api/v1/network_agent.proto`](../../network-agent/api/v1/network_agent.proto)：

```protobuf
service NetworkAgent {
  rpc EnsureNetwork(EnsureNetworkRequest) returns (EnsureNetworkResponse);
  rpc ReleaseNetwork(ReleaseNetworkRequest) returns (ReleaseNetworkResponse);
  rpc ReconcileNetwork(ReconcileNetworkRequest) returns (ReconcileNetworkResponse);
  rpc GetNetwork(GetNetworkRequest) returns (GetNetworkResponse);
  rpc Health(HealthRequest) returns (HealthResponse);
  rpc ListNetworks(ListNetworksRequest) returns (ListNetworksResponse);
}
```

### 4.1 Ensure / Release / Reconcile

- `EnsureNetwork`：声明期望状态；同一 sandbox/idempotency 重复请求应返回相同或等价结果；
- `ReleaseNetwork`：释放 TAP、IP、port、proxy 和 map entry；不存在也应尽量幂等成功；
- `ReconcileNetwork`：进程重启或内核状态漂移后，重新收敛到期望状态；
- `Get/List`：观察本地已管理状态。

这比只有 `Create/Delete` 更适合节点守护进程，因为 Linux 网络对象可能被运维脚本、重启或异常清理改变。

## 5. LocalService

核心实现在 [`internal/service/local_service.go`](../../network-agent/internal/service/local_service.go)。主要状态：

- `states map[sandboxID]*managedState`；
- IP allocator；
- port allocator；
- TAP pool、abnormal pool、destroy-failed set；
- state store；
- host proxies；
- CubeEgress policy push 状态。

`managedState` 在 persisted state 外还持有 live TAP FD/object 和 proxy goroutine，这些不能直接序列化。重启恢复时要用持久字段重新打开或重建内核对象。

## 6. IPAM 与端口分配

### 6.1 IPAM

默认 CIDR 可在 Cubelet 配置看到，例如 `192.168.0.0/18`。allocator 要保留：

- 网络地址；
- 网关；
- 广播地址；
- 已被恢复状态占用的地址。

分配器不仅要线程安全，还要在服务启动读取 state store 后先 mark 已用地址，再接受新请求，否则会重复分配。

### 6.2 Host port

端口 allocator 避开：

- OS ephemeral port range；
- `/proc/sys/net/ipv4/ip_local_reserved_ports`；
- 当前已分配和已监听端口。

端口检查与真正 bind 之间仍可能竞态，所以最终创建 listener/写 map 失败时必须释放 reservation 并重试。

## 7. TAP 池与 FD 传递

预创建 TAP 能把创建延迟从“netlink 创建设备 + attach BPF”移出请求关键路径。TAP 状态大致：

```text
free pool → assigned → returned/free
                    ↘ abnormal → repair/destroy
```

Cubelet/CubeShim 需要把同一个 TAP file descriptor 交给 VMM。network-agent 的 [`internal/fdserver/server.go`](../../network-agent/internal/fdserver/server.go) 使用 Unix `SCM_RIGHTS` 传 FD，而控制信息仍走 gRPC。

安全点：FD server 的 socket 权限必须严格；拿到 TAP FD 就能直接读写 Sandbox 二层流量。

## 8. 状态持久化

[`state_store.go`](../../network-agent/internal/service/state_store.go) 为每个 Sandbox 保存 JSON，内容包括 Sandbox ID、network handle、TAP 名/ifindex、IP、routes、ARP、port mapping 和 policy。

正确写文件通常需要：

1. 写临时文件；
2. fsync；
3. rename 原子替换；
4. 必要时 fsync 目录。

检查代码时关注半写 JSON、旧文件残留和进程在“内核已成功、状态未落盘”窗口崩溃的处理。

## 9. CubeVS 控制面与数据面

### 9.1 Go 控制库

[`CubeNet/cubevs/`](../../CubeNet/cubevs) 使用 cilium/ebpf：

- 加载/attach TC program；
- 管理 TAP device map；
- 配置 SNAT 与 port mapping；
- 为每个 TAP 创建 LPM trie policy inner map；
- 清理失效 session/policy。

### 9.2 BPF 程序

主要 C 文件：

- [`mvmtap.bpf.c`](../../CubeNet/src/mvmtap.bpf.c)：来自/去往 MicroVM TAP；
- [`nodenic.bpf.c`](../../CubeNet/src/nodenic.bpf.c)：宿主 NIC ingress；
- [`localgw.bpf.c`](../../CubeNet/src/localgw.bpf.c)：本地网关/代理相关路径。

每个包会解析 Ethernet/IP/TCP/UDP/ICMP，查 map 后修改地址、端口和 checksum，再用 `bpf_redirect` 转发。

## 10. NAT 与连接跟踪

Sandbox 出站连接需要把 Guest 私网 IP/port 转换为宿主可路由地址/port，并在返回包到达时反向转换。CubeVS 维护 egress/ingress session map，key 包含：

```text
src_ip, dst_ip, src_port, dst_port, protocol, version
```

TCP 不是简单“有包就刷新 TTL”，还要跟踪 SYN/ACK/FIN/RST 状态，才能在连接结束后及时清理而不误删活连接。UDP/ICMP 用不同 timeout 语义。

### 10.1 checksum

修改 IP/port 后必须更新 IPv4 header checksum 和 TCP/UDP pseudo-header checksum。BPF 代码大量使用：

- `bpf_l3_csum_replace`；
- `bpf_l4_csum_replace`；
- `bpf_skb_store_bytes`。

这些 helper 可能使原有 packet pointer 对 verifier 失效，所以代码常先缓存字段、改 L2，再用 helper，之后必要时重新 pull header。调整顺序容易导致 verifier 拒绝或运行时 checksum 错误。

## 11. L3/L4 网络策略

[`CubeNet/cubevs/netpolicy.go`](../../CubeNet/cubevs/netpolicy.go) 为每个 ifindex 建立 LPM trie。默认拒绝一组私网/loopback/link-local：

```text
10.0.0.0/8
127.0.0.0/8
169.254.0.0/16
172.16.0.0/12
192.168.0.0/16
```

这是阻止 Sandbox 探测宿主/内网的基础防线。实际 allow/deny 还会根据请求策略覆盖/组合。

LPM（Longest Prefix Match）让更具体前缀优先。例如 `/32` 可表达单 IP 例外，`/0` 表达默认规则。

DNS hostname policy 还需要学习 DNS response 中的 IP，把域名规则转换为有生命周期的 IP allow entry；这也是为什么 CubeVS 包含 DNS parser/reaper。

## 12. CubeProxy 入站路由

[`CubeProxy/nginx.conf`](../../CubeProxy/nginx.conf) 定义两个主要入口：

- `8080` HTTPS；
- `8081` HTTP。

部署时通常映射到宿主 `443/80`。

### 12.1 Host 模式

[`lua/rewrite_phase.lua`](../../CubeProxy/lua/rewrite_phase.lua) 从 Host 解析：

```text
<container_port>-<sandbox_id>.<domain>
```

然后：

1. 把 `ins_id` 放入 nginx variable；
2. 调 `sandbox_state.gate` 处理暂停状态；
3. `sandbox_backend.resolve_backend` 查后端；
4. 设置 `backend_ip/backend_port`；
5. 可选重写 upstream Host。

### 12.2 Path 模式

路径形如：

```text
/sandbox/<sandbox_id>/<container_port>/<rest>
```

Proxy 去掉前缀再转发，并重写响应中的 root-relative `Location` 与 cookie Path，使浏览器仍停留在 Sandbox 前缀下。Path 模式无需 wildcard DNS，但应用若生成绝对 URL 仍可能需要 `X-Forwarded-Prefix` 支持。

### 12.3 Backend lookup 与缓存

[`sandbox_backend.lua`](../../CubeProxy/lua/sandbox_backend.lua) 先查 `lua_shared_dict local_cache`，miss 时查 Redis 中 CubeMaster 写入的 sandbox proxy hash。缓存项不仅有 IP/port，还包括：

- allow public；
- traffic token；
- mask request host。

可选字段使用 boolean false 作为 negative cache 值，区分“已缓存为空”和“从未缓存/被淘汰”。这是 shared dict 中常见的小技巧。

### 12.4 动态 balancer

nginx upstream 只配置占位 server，真实地址由 [`balancer_phase.lua`](../../CubeProxy/lua/balancer_phase.lua) 使用 `ngx.balancer.set_current_peer` 设置。这样每请求可路由到不同宿主/端口，同时仍复用 upstream keepalive。

## 13. 数据面访问令牌

创建时若 `allowPublicTraffic=false`，CubeMaster在 Redis 保存 token，CubeProxy 要求请求携带：

- `e2b-traffic-access-token`，或
- `cube-traffic-access-token`。

不匹配返回 403。SDK 会在原始 create response 中拿到 token 并自动附带；connect/resume 后未必能重新获得原 token，所以客户端需要按 API 契约持久化。

这与 CubeAPI 的管理面 API key 不同：一个控制“谁能创建/删除 Sandbox”，一个控制“谁能访问某个 Sandbox 暴露的服务”。

## 14. 自动暂停/恢复 gate

CubeProxy shared dict 维护 meta、state、last active。每个请求的 log phase 更新 last active；`cube-lifecycle-manager` 定期拉取并根据 timeout 决定暂停或 kill。

请求命中 paused Sandbox 时：

```text
CubeProxy state.gate
  → internal subrequest /_sidecar_resume
  → cube-lifecycle-manager /internal/resume
  → Redis state lock
  → CubeMaster resume
  → 向所有 Proxy 推 running
  → 原请求继续
```

pausing 状态应返回可重试错误，避免新请求一边进入 VM、一边快照冻结。分布式锁避免多个 Proxy 副本同时 resume 同一个 Sandbox。

## 15. CubeEgress L7 代理

CubeEgress 是 OpenResty 透明代理。主要模块：

- [`access_phase.lua`](../../CubeEgress/lua/access_phase.lua)：提取请求、匹配策略、执行 allow/deny/inject；
- [`policy.lua`](../../CubeEgress/lua/policy.lua)：策略校验、存储、更新；
- [`cert_signer.lua`](../../CubeEgress/lua/cert_signer.lua)：按 SNI 动态签证书；
- [`audit.lua`](../../CubeEgress/lua/audit.lua)：记录决策；
- [`redactor.lua`](../../CubeEgress/lua/redactor.lua)：敏感信息脱敏；
- [`admin.lua`](../../CubeEgress/lua/admin.lua)：管理面下发策略。

### 15.1 规则模型

协议来自 network-agent proto，典型规则：

```json
{
  "name": "llm-api",
  "match": {
    "scheme": "https",
    "sni": "api.example.com",
    "host": "api.example.com",
    "method": ["POST"],
    "path": "/v1/"
  },
  "action": {
    "allow": true,
    "audit": "metadata",
    "inject": [{
      "header": "Authorization",
      "format": "Bearer ${SECRET}",
      "secret": "..."
    }]
  }
}
```

规则按顺序 first-match-wins。凭证注入要求安全匹配 SNI 与 Host，防止攻击者把允许域名的 Host 与另一个 TLS 目标混合后窃取凭据。

### 15.2 策略下发

network-agent 在 Ensure/Reconcile 时把 Sandbox IP 与 L7 policy 推到本机 CubeEgress admin API。Egress 用 shared dict 保存当前策略。状态持久化恢复后，只有确认 policy 完整时才可重放，避免用不完整 runtime metadata 覆盖真实策略。

### 15.3 动态证书

[`cert_signer.lua`](../../CubeEgress/lua/cert_signer.lua)：

1. init 阶段加载 CA cert/key；
2. TLS handshake 取得 SNI；
3. shared cache 查叶子证书；
4. miss 时用 resty-lock 防止并发重复签发；
5. 生成 ECDSA P-256 key 和 SAN；
6. CA 签名并缓存 DER；
7. `ngx.ssl.set_der_cert/private_key` 替换本次握手证书。

模板必须信任这张 CA，否则 Sandbox 内 HTTPS 客户端会报证书不受信任。

### 15.4 密钥不进入 Sandbox

策略中的 secret 存在宿主代理侧，请求穿过 Egress 时才写 header。Agent 代码、环境变量和 Guest 文件系统都看不到原始密钥（除非外部服务主动回显）。审计使用 secret fingerprint/reference，不应记录明文。

## 16. 一条 HTTPS 出站请求

```text
Sandbox requests.get("https://api.example.com/v1")
  ↓ DNS 请求被 CubeVS 观察，学习域名/IP
  ↓ TAP TC eBPF：L3/L4 allow/deny、session/NAT
  ↓ 策略要求 L7 代理时重定向到 TPROXY
  ↓ CubeEgress 接 TLS，动态签 api.example.com 叶子证书
  ↓ 解析 SNI/Host/method/path
  ↓ first-match-wins policy
  ↓ 注入 Authorization，写审计
  ↓ 代理与真实 api.example.com 建 TLS 并发请求
```

任何一层拒绝都会表现为“外网失败”，所以排障必须分层。

## 17. 分层排障表

| 现象 | 优先检查 |
|---|---|
| Guest 没有 IP | network-agent Ensure、IPAM、Agent CreateSandbox network payload |
| Guest 有 IP 但 ping/连接都失败 | TAP link、TC attach、CubeVS maps、route/ARP |
| 只返回流量失败 | ingress session、checksum、host NIC program |
| 域名不通但 IP 能通 | DNS parser/policy、Guest resolv.conf、DNS learned entry |
| HTTP 通、HTTPS 证书失败 | CubeEgress CA 是否烘焙进模板、动态签证书日志 |
| L7 allow 仍被拒绝 | L3/L4 `allow_out/deny_out` 与规则顺序 |
| 创建成功但外部访问 404 | CubeProxy Redis mapping、Host/path 解析、container port |
| 外部访问 403 | traffic access token/public access flag |
| paused 后首次请求 503 | lifecycle manager、state lock、CubeMaster resume |

## 18. 测试

```bash
# network-agent
cd network-agent
go test ./internal/service/...
go test ./internal/grpcserver/... ./internal/httpserver/...

# CubeVS Go 控制逻辑
cd CubeNet/cubevs
go test ./...

# CubeProxy Lua
cd CubeProxy
make test

# 根目录统一入口
make network-agent-test
make cube-proxy-test
```

BPF 程序编译/加载、TAP、TC 和 TPROXY 集成测试需要 Linux capability/root。纯 policy plan、allocator 和 Lua parser 测试可在更轻环境运行。

## 19. 动手练习

### 练习 1：解析一个 Host

给定：

```text
49983-abcd1234.cube.app
```

写出 `rewrite_phase.lua` 得到的 container port、instance ID，以及 Redis lookup key 的组成。再说明 path 模式等价 URL。

### 练习 2：设计 deny-all + allow one domain

用 SDK 网络模型表达：默认拒绝所有公网，只允许 `api.example.com`，并给其 HTTPS 请求注入 token。说明 L3/L4 与 L7 分别需要什么配置。

### 练习 3：观察 map

在专用测试节点创建一个 Sandbox 前后，用 `bpftool map show` 和项目的 `cubevsmapdump` 对比 TAP、session 和 policy map。不要手工修改生产 pinned map。

## 20. 自测题

1. network-agent 与 CubeVS 谁处理每个数据包？
2. 为什么每 Sandbox TAP ifindex 很适合做策略键？
3. CubeProxy 的管理面 API key 与 traffic token 有何区别？
4. 为什么 L7 allow 不能必然绕过 L3 deny？
5. 为什么凭证注入同时匹配 SNI 和 Host 更安全？

