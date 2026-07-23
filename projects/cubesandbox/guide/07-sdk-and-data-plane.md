# 模块 7：SDK 与沙箱数据面

## 1. 学习目标

本章从用户视角重新串起系统，重点掌握：

- 官方 SDK 与 E2B 兼容 SDK 的关系；
- 管理面和 Sandbox 数据面的不同 URL/认证/超时；
- `Sandbox.create` 如何序列化生命周期、网络和卷；
- `run_code`、commands、files、PTY 的传输方式；
- Proxy Node IP 模式怎样绕过 wildcard DNS；
- 流式协议为什么要按 chunk 增量解析。

## 2. SDK 目录

```text
sdk/
├── python/   # cubesandbox，Python 3.9+
├── node/     # TypeScript/Node
└── go/       # Go client
```

此外 [`CubeAPI/examples/`](../../CubeAPI/examples) 使用官方 E2B SDK 演示兼容性。两套入口都可用：

- 已有 E2B 应用：改 `E2B_API_URL`，尽量不改业务代码；
- 新项目或要使用 Cube 扩展：使用 `cubesandbox` 官方 SDK。

## 3. 两类 HTTP 请求

### 3.1 控制面

目标为 CubeAPI：

```text
GET/POST/DELETE http://<cube-api>:3000/sandboxes...
```

用途：create/list/info/pause/connect/kill/snapshot/template/volume。认证是 CubeAPI API key/Bearer，timeout 通常是普通 HTTP 请求或长操作 timeout。

### 3.2 数据面

目标为 CubeProxy 后面的 Sandbox 内服务：

```text
http(s)://49999-<sandbox_id>.cube.app/execute
http(s)://49983-<sandbox_id>.cube.app/process.Process/Start
```

用途：run code、commands、files、watch、PTY。认证可能包括 per-sandbox traffic access token，读取 timeout 通常是流式 idle timeout。

把同一个 HTTP client/config 无条件用于两类请求容易出错：DNS、TLS CA、Host header、proxy node IP、timeout 和 token 都不同。

## 4. Python Config

[`sdk/python/cubesandbox/_config.py`](../../sdk/python/cubesandbox/_config.py) 从环境/显式对象读取：

- `CUBE_API_URL`；
- `CUBE_TEMPLATE_ID`；
- `CUBE_PROXY_NODE_IP`；
- Proxy HTTP port/scheme；
- Sandbox domain；
- API key/token；
- timeout。

显式 `Config` 适合多集群程序，避免进程级环境变量互相覆盖：

```python
from cubesandbox import Config, Sandbox

dev = Config(
    api_url="http://10.0.0.10:3000",
    template_id="tpl-dev",
    proxy_node_ip="10.0.0.10",
)

with Sandbox.create(config=dev) as sb:
    print(sb.run_code("2 + 2").text)
```

## 5. `Sandbox.create`

[`sdk/python/cubesandbox/sandbox.py`](../../sdk/python/cubesandbox/sandbox.py) 的 `create` 构造控制面 payload。

### 5.1 模板选择

优先使用参数 `template`，否则使用 `Config.template_id`。两者都没有时在发送网络请求前抛 `ValueError`。SDK early validation 能提供更明确错误，但服务端仍会独立校验。

### 5.2 timeout

只有显式传入时才发送：

```python
payload = {"templateID": tpl}
if timeout is not None:
    payload["timeout"] = timeout
```

这是为了保留“缺失＝服务端默认”和“0＝立即到期”的区别。

### 5.3 lifecycle

Python snake_case：

```python
lifecycle={"on_timeout": "pause", "auto_resume": True}
```

线上的 E2B camelCase：

```json
{"onTimeout": "pause", "autoResume": true}
```

`_serialize_lifecycle` 只接受 `kill|pause`，防止拼写错误变成后端模糊 4xx。

### 5.4 network

SDK 将：

```python
network={
    "allow_out": [...],
    "deny_out": [...],
    "allow_public_traffic": False,
    "mask_request_host": "service-${PORT}.internal",
    "rules": [...],
}
```

转换为 camelCase wire shape，并验证 domain allow list 与 deny-all 的安全组合。rules 可接受类型化 Rule 列表或 E2B host transform map，但不允许一次混用两种形态。

### 5.5 volume mounts

Python 方便形态：

```python
Sandbox.create(volume_mounts={"/workspace": volume})
```

会转换为 E2B 列表，每项包含 volume name/ID 和 Sandbox path。传对象、info 或 ID 字符串最终都要解析成服务端已有 volume。

## 6. Create response 与 Sandbox 对象

返回数据包含：

- `sandboxID`；
- `templateID`；
- `domain`；
- envd version/access token（按版本）；
- traffic access token（restricted public access 时）。

`Sandbox.get_host(port)` 只做确定性拼接：

```python
return f"{port}-{self.sandbox_id}.{self.domain}"
```

不要把 `get_host` 当成 DNS 探测；域名是否能解析由 CoreDNS/wildcard DNS/客户端网络决定。

## 7. Proxy Node IP 模式

远程开发机常无法解析 `*.cube.app`，但知道 Proxy 节点 IP。SDK transport 会：

```text
TCP connect: http://<proxy_node_ip>:<proxy_port>
HTTP Host:   49983-<sandbox_id>.cube.app
```

CubeProxy 仍能按 Host 路由。HTTPS 下还要处理 SNI/证书域名：不同语言 SDK 的 transport 实现可能使用自定义 dialer/dispatcher，使 TCP 连 IP 但 TLS servername 保持 Sandbox host。

Python transport 在 [`_transport.py`](../../sdk/python/cubesandbox/_transport.py)，Node 在 [`src/transport.ts`](../../sdk/node/src/transport.ts)，Go 在 client transport/config 中。

## 8. `run_code`

Python/Go/Node 都把请求发到 Jupyter port 49999 的 `/execute`，payload 典型为：

```json
{
  "code": "print('hello')",
  "language": null,
  "env_vars": null
}
```

响应是流式事件而不是一次性 JSON。事件可能包含：

- stdout/stderr log；
- result text/data；
- execution error；
- completion。

SDK一边解析一边调用 `on_stdout/on_stderr/on_result/on_error`，最终聚合成 `Execution`。

### 8.1 idle timeout

长代码可能运行几分钟但持续输出。合理 timeout 是“连续多久没有收到新 chunk”，而不是从请求开始的绝对总时长。Node SDK 的 `timeoutMs` 明确是 read idle timeout，每次 chunk 重置。

## 9. commands/envd

commands 使用 envd port 49983。不同 envd 版本可能使用 Connect 风格 envelope 或 protobuf/gRPC-Web 风格 framing。Python [`_commands.py`](../../sdk/python/cubesandbox/_commands.py) 同时处理：

- HTTP status；
- length-prefixed frame；
- compressed/end-stream flag；
- stdout/stderr bytes/base64；
- EndEvent exit code；
- stream 完成但无 EndEvent 的协议错误。

为什么不能直接 `resp.text`：一个 TCP chunk 可能只包含半个 frame，也可能包含多个 frame。解析器必须维护 buffer：

```text
收到 chunk → append buffer
while buffer >= header:
  读 length
  若完整 frame 未到：等待下一 chunk
  否则切出 frame并继续
```

还要限制最大 frame size，防止恶意/损坏 length 导致无界内存分配。

## 10. 文件系统

SDK 文件模块提供：

- read/write；
- batch write；
- list/stat/exists；
- mkdir/remove/rename；
- watch directory。

小文件可以简单请求，大文件/批量文件需要流式上传或 multipart/帧协议。设计调用时不要默认整个文件会一次放进内存。

目录 watch 是长连接。退出 context manager/iterator 时必须关闭 response 和后台 reader，否则连接池会泄漏。

## 11. PTY

PTY 与普通 command 的区别：

- 有 terminal size；
- stdin/stdout 是双向流；
- 支持 resize；
- signal/kill 语义不同；
- 输出可能包含 ANSI 控制字符。

SDK 的 PTY object 管理 create/connect/send/resize/kill。断线重连要区分“PTY process 已退出”和“客户端 transport 断开”。

## 12. traffic token 自动附带

`allow_public_traffic=False` 时，SDK 从 create response 保存 token，并在数据面请求附：

```text
e2b-traffic-access-token: <token>
cube-traffic-access-token: <token>
```

Node SDK注释明确两者都发送，CubeProxy 接受任一个。管理面的 API key 不能代替此 token。

若用户只保存 `sandbox_id` 而丢掉 token，之后 connect 到 restricted Sandbox可能无法访问数据面。应用层应把 token 当 Sandbox handle 的一部分安全保存。

## 13. Pause、Resume 与 Connect

`pause(wait=True)`：

1. POST pause；
2. 周期 GET info；
3. 直到 state=paused；
4. timeout 或 context cancel 时失败。

`connect(sandbox_id)` 是推荐恢复方式：服务端发现 paused 后恢复并返回新的 Sandbox response。旧 `resume` 为兼容保留。

为什么 pause API 不能只看 POST 200：保存内存快照是异步/长操作，200 可能只代表动作已接受。SDK默认轮询终态让调用者获得更强语义。

## 14. Context manager 与资源 ownership

Python 示例：

```python
with Sandbox.create() as sb:
    ...
```

离开 context 通常会 kill Sandbox。Go 的 `Close()` 注释则明确只释放本地 idle connection，不等于远程 kill；需显式 `Kill`/`Pause`。

多语言 API 的同名方法可能有不同 ownership 约定，移植代码时以具体 SDK 文档/实现为准。

## 15. 错误类型

官方 SDK 将常见 HTTP error 映射为：

- `AuthenticationError`：401/403；
- `SandboxNotFoundError`；
- `TemplateNotFoundError`；
- `ApiError`；
- transport/timeout/protocol error。

403 在控制面通常是 API auth，在数据面可能是 traffic token。错误分类时要同时记录目标 URL 类别。

## 16. Node SDK 特点

[`sdk/node/src/sandbox.ts`](../../sdk/node/src/sandbox.ts) 提供：

- `CreateOptions` 支持 nested config 和 flat override；
- undici `Dispatcher` 自定义数据面连接；
- camelCase 原生 API；
- async streaming callback；
- typed network/lifecycle option；
- pause poll、snapshot 等。

配置优先级是 flat field > `config` > 环境变量。Node HTTP response body 是 stream，只能消费一次；错误处理先读取 text 再安全 JSON parse。

## 17. Go SDK 特点

[`sdk/go/sandbox.go`](../../sdk/go/sandbox.go) 使用 `context.Context` 控制取消，方法返回 `(value, error)`。常量明确：

```go
JupyterPort = 49999
EnvdPort    = 49983
```

Go `Pause` 用 timer+ticker 轮询，`RunCode` 用 stream parser；`NeverTimeout=-1` 需要从 duration/秒正确序列化。

Go 使用者应为每个请求设置合适 context deadline，但长流不要误用过短绝对 deadline。

## 18. 一个完整 Python 示例

```python
from cubesandbox import Sandbox, Rule, Match, Action, Inject

rules = [
    Rule(
        name="example-api",
        match=Match(
            scheme="https",
            sni="api.example.com",
            host="api.example.com",
            method=["GET"],
            path="/v1/",
        ),
        action=Action(
            allow=True,
            audit="metadata",
            inject=[Inject(
                header="Authorization",
                format="Bearer ${SECRET}",
                secret="replace-me",
            )],
        ),
    )
]

with Sandbox.create(
    timeout=300,
    lifecycle={"on_timeout": "pause", "auto_resume": True},
    network={
        "deny_out": ["0.0.0.0/0"],
        "allow_out": ["api.example.com"],
        "allow_public_traffic": False,
        "rules": rules,
    },
) as sb:
    print("id:", sb.sandbox_id)
    print("host:", sb.get_host(49999))
    print("token present:", bool(sb.traffic_access_token))

    sb.files.write("/tmp/input.txt", "40")
    result = sb.run_code("int(open('/tmp/input.txt').read()) + 2")
    print(result.text)
```

生产代码不要把真实 secret 写进源码；从受保护配置读取后只在控制面请求中提交给可信部署。

## 19. SDK 测试

```bash
# Python
cd sdk/python
python -m pytest tests

# Node
cd sdk/node
npm ci
npm test

# Go
cd sdk/go
go test ./...
```

具体 npm script 以 [`sdk/node/package.json`](../../sdk/node/package.json) 为准。集成测试需要运行中的 CubeAPI、模板和 Proxy；纯 serialization/stream parser 可用 fixture/mock 测试。

## 20. 动手练习

### 练习 1：用 curl 拆开 SDK

先 curl `POST /sandboxes`，取得 ID；再手工给 Proxy IP 发请求并设置正确 Host。观察控制面和数据面分别经过哪些日志。

### 练习 2：构造碎片化 frame

写单元测试把一个 length-prefixed event 拆成 1、2、3 字节的多个 chunk，验证 parser 仍能输出一个事件；再把两个 frame 合成一个 chunk。

### 练习 3：比较三语言

分别找到 Python、Node、Go 的 `get_host`、pause poll 和 run-code stream 实现，列出 API 风格不同但 wire protocol 相同的部分。

## 21. 自测题

1. 为什么 `run_code` 不访问 CubeAPI 的 `/sandboxes/:id/...`？
2. Proxy Node IP 模式为什么仍要保留 Host/SNI？
3. stream parser 为什么必须维护跨 chunk buffer？
4. pause POST 成功为什么不一定已经 paused？
5. 为什么 restricted Sandbox 的 traffic token 应与 Sandbox ID 一起保存？

