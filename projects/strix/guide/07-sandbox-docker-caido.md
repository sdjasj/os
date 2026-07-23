# 07. 沙箱运行时、Docker 与 Caido

Agent 会执行 shell、浏览器和安全工具。运行时层的目标是：提供足够能力完成授权测试，同时把执行环境与宿主项目进程隔开，并让 HTTP 流量可观察。

## 1. 可插拔后端注册表

[`strix/runtime/backends.py`](../../strix/runtime/backends.py) 定义：

```python
SandboxBackend = Callable[..., Awaitable[tuple[Any, Any]]]
```

内置 `_BACKENDS = {"docker": _docker_backend}`。`get_backend(name)` 精确匹配，未知值直接报错，不静默 fallback。外部代码可用 `register_backend()` 覆盖或添加后端。

后端接收：

- image
- manifest
- exposed_ports
- bind_mounts

返回 `(client, session)`。对 Docker，后端创建 session 后必须 `await session.start()`，因为 SDK 的 `client.create()` 只构造内部会话，`start()` 才真正应用 manifest entries。

## 2. `session_manager` 的每扫描生命周期

[`create_or_reuse()`](../../strix/runtime/session_manager.py) 用 `_SESSION_CACHE[scan_id]` 保证同一进程中同一扫描复用一个 sandbox bundle：

```python
{
    "client": client,
    "session": session,
    "caido_client": caido_client,
}
```

新建过程：

1. 把 local sources 分成复制 entries 与 bind mounts。
2. 创建 manifest，设置工作区和代理环境变量。
3. 根据配置选择 backend。
4. 创建并启动 sandbox。
5. 解析 Caido 暴露端口。
6. 登录 Caido、创建临时 project。
7. 缓存 bundle。

`cleanup(scan_id)` 则关闭 Caido client、删除 session/container、关闭 docker-py client，并从 cache 删除。清理是 best-effort：失败记录日志但不阻止后续扫描流程结束。

## 3. Manifest 与 bind mount 是两个通道

`build_session_entries()` 返回三项：

```text
entries      -> SDK Manifest 中的 LocalDir，启动后复制
bind_mounts  -> Docker create 时加入，只读挂载
staged_dirs  -> 为处理 symlink 创建的临时宿主目录
```

目标路径统一为 `/workspace/<workspace_subdir>`。

复制模式给 Agent 一个容器内副本；mount 模式把宿主目录直接暴露成只读。只读只限制该 mount 的写入，不代表容器其他路径不可写。

## 4. Symlink 安全暂存

SDK `LocalDir` walker 拒绝包含 symlink 的树。项目没有简单地 `followlinks=True`，而是由 [`local_dir_staging.py`](../../strix/runtime/local_dir_staging.py) 生成安全临时副本：

- 指向树内的 symlink：解引用，将目标内容实体化。
- 指向树外的 symlink：丢弃，避免宿主敏感文件被带入容器。
- dangling link：丢弃。
- cycle：丢弃。
- 普通文件：优先 hard link，跨文件系统失败才 copy。
- socket/FIFO/device：跳过。

核心判断 `_is_within(target, root)` 使用解析后的 Path 和 `relative_to()`，不是用不安全的字符串前缀比较。

后端完成上传后，`create_or_reuse()` 在 `finally` 中删除这些 staging 目录，即使容器创建失败也会清理。

## 5. Manifest 环境中的代理设置

容器内 Caido 固定监听 48080。Manifest 为 Agent 启动的进程注入：

```text
http_proxy=http://127.0.0.1:48080
https_proxy=http://127.0.0.1:48080
ALL_PROXY=http://127.0.0.1:48080
NO_PROXY=localhost,127.0.0.1
```

`NO_PROXY` 防止本地 browser/CDP 控制流又绕回代理形成回环。`HOST_GATEWAY=host.docker.internal` 供容器访问宿主服务。

## 6. 为什么要定制 Docker client

[`StrixDockerSandboxClient`](../../strix/runtime/docker_client.py) 继承 SDK client，但重写 `_create_container()`。文件头写明它与固定 SDK 版本 `openai-agents==0.14.6` 同步，升级 SDK 时必须重新比对父类实现。

主要差异有五个：

### 6.1 保留镜像 ENTRYPOINT

上游 SDK 会覆盖 entrypoint 为 `tail`，那会导致 `docker-entrypoint.sh` 不运行，Caido 和 CA trust 不会初始化。

Strix 保留镜像 ENTRYPOINT，只传：

```python
"command": ["tail", "-f", "/dev/null"]
```

entrypoint 完成初始化后 `exec "$@"`，最终用 tail 保持容器存活。

### 6.2 增加网络能力

追加 `NET_ADMIN` 与 `NET_RAW`，支持 nmap SYN scan 等工具。如果 manifest 已因 FUSE 需要 `SYS_ADMIN`，代码使用 append 而不是覆盖。

### 6.3 增加 host gateway

```python
extra_hosts["host.docker.internal"] = "host-gateway"
```

与 CLI 的 localhost URL 改写配合。

### 6.4 可选资源限制和默认日志轮转

环境变量可限制 memory、shared memory、CPU、PID。容器 JSON 日志默认启用 `50m * 3` 轮转，防止失控工具写满宿主磁盘；可显式关闭。

### 6.5 加入只读 bind mounts

`strix_bind_mounts` 被转换为 Docker SDK `Mount(type="bind", read_only=True)`，绕过 LocalDir 逐文件复制。

## 7. 自定义 Docker network

设置 `STRIX_DOCKER_SANDBOX_NETWORK` 后，Docker create 使用指定 network，并移除 host port publishing。此时 `StrixDockerSandboxSession._resolve_exposed_port()` 从容器 network settings 解析容器 IP，直接返回 `<container-ip>:port`。

这适合宿主进程可访问该 Docker network 的部署方式；若容器没有加入指定网络或拿不到 IP，会抛带 backend/network context 的 `ExposedPortUnavailableError`。

## 8. 镜像里有什么

[`containers/Dockerfile`](../../containers/Dockerfile) 基于 Kali rolling，创建无密码 sudo 的 `pentester` 用户，并安装：

- 常规 shell、Git、Python、Go、Node 工具链；
- nmap、sqlmap、nuclei、subfinder、naabu、ffuf；
- agent-browser + Chromium；
- semgrep、bandit、trivy、gitleaks、trufflehog 等；
- Caido CLI 与 Python client；
- 测试专用 CA。

最终以 `pentester` 运行，workdir 是 `/workspace`。虽然不是 root，用户有 passwordless sudo，且容器拥有额外 capabilities；因此这是“隔离的高能力测试容器”，不能视为强敌对多租户边界。不要把不可信宿主路径可写挂载进去，不要把宿主 Docker socket 挂载进去。

## 9. Entrypoint 启动流程

[`containers/docker-entrypoint.sh`](../../containers/docker-entrypoint.sh) 大致做：

1. 验证 CA p12 存在。
2. 启动 Caido，允许 guest，不打开 UI。
3. 最多等待 30 秒，检查进程存活和 GraphQL readiness。
4. 写 `/etc/profile.d/proxy.sh`、`/etc/environment`、`/etc/wgetrc`。
5. 把测试 CA 加入 Chromium NSS trust store。
6. 创建 screenshot 目录。
7. `cd /workspace && exec "$@"`。

它既配置 manifest 注入进程的环境，也配置登录 shell/wget/browser trust，因为不同工具读取代理与证书的方式不同。

## 10. Caido bootstrap

容器启动不等于 Caido SDK 可用。[`bootstrap_caido()`](../../strix/runtime/caido_bootstrap.py)：

1. 用 `session.exec(curl ...)` 从**容器内部**请求 `loginAsGuest`。
2. 最多重试 10 次，递增等待，兼作 readiness probe。
3. 用 token 在宿主进程创建 `caido_sdk_client.Client(host_url)`。
4. connect 后创建并选择临时 project。
5. project 设置失败时立即关闭 client，避免泄漏 transport。

这里有两个 URL：

- `container_url=http://127.0.0.1:48080`：容器内 curl 登录。
- `host_url=http://<mapped-host>:<port>`：宿主 Python 工具查询 Caido。

## 11. HTTP 工具与 shell 的数据路径

```text
Shell/Browser 发请求
  -> 容器代理环境
  -> Caido project 记录请求/响应
  -> 目标

Agent 调用 proxy tool
  -> RunContext 中的 caido_client
  -> 宿主映射端口
  -> 查询/查看/重放同一 project 的记录
```

这种设计让通用命令行工具无需感知 Strix API，同时 Agent 仍能结构化查询流量。

## 12. 常见故障分层排查

### Docker CLI 不存在

`check_docker_installed()` 失败；先确认 `which docker`。

### Docker daemon 不可用

拉镜像/connection 检查失败；确认 `docker info` 和当前用户权限。

### Entrypoint 没执行

Caido 端口始终不可用；检查是否有人恢复了 SDK 的 entrypoint override，或镜像 ENTRYPOINT 变化。

### Caido 进程死亡

entrypoint 会打印 `/tmp/caido_startup.log`；从容器日志开始看。

### HTTPS 请求证书错误

检查系统 CA、浏览器 NSS store、`REQUESTS_CA_BUNDLE` 与工具是否尊重这些配置。

### 本地目标复制失败

检查目录大小、symlink、权限；大型树改用 `--mount`。

### 宿主 localhost 不可达

确认目标 URL 已改写、extra host 存在、宿主服务监听地址允许来自 Docker gateway 的连接。

## 13. 本章实验

不启动容器也可以测试源码装载分类：

```bash
uv run pytest \
  tests/test_local_dir_staging.py \
  tests/test_local_sources.py \
  tests/test_docker_client_delete.py -q
```

如果 Docker 可用，再只检查镜像/daemon：

```bash
docker info
docker image inspect ghcr.io/usestrix/strix-sandbox:1.0.0 >/dev/null
```

## 14. 自测题

1. 为什么 LocalDir symlink 不能简单 follow？
2. 为什么保留 ENTRYPOINT 但用 tail 作为 command？
3. container URL 与 host URL 分别给谁用？
4. 只读 bind mount 提供了哪些保护，又没有提供哪些保护？
5. 为什么 cleanup 选择 best-effort 而不是让删除容器失败覆盖原异常？

