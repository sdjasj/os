# 模块 9：CLI 的设计与执行链

E2B CLI 是 JS SDK 的交互式外壳：Commander 负责命令结构，CLI 负责凭据、参数、终端和输出，资源操作仍委托给 `e2b` 包。本模块既讲使用，也讲实现。

## 1. 入口与命令树

[`packages/cli/src/index.ts`](../../../packages/cli/src/index.ts) 做四件事：

1. 声明 Node shebang；
2. 启动每 8 小时一次的版本更新检查；
3. 设置 CLI 版本；
4. `program.parseAsync()`。

命令树在 [`commands/index.ts`](../../../packages/cli/src/commands/index.ts)：

```text
e2b
├── auth
│   ├── login
│   ├── logout
│   ├── info
│   └── configure
├── template (tpl)
│   ├── create
│   ├── list
│   ├── init
│   ├── delete
│   ├── publish / unpublish
│   └── migrate
└── sandbox (sbx)
    ├── create
    ├── connect
    ├── exec
    ├── list
    ├── info
    ├── logs
    ├── metrics
    ├── pause / resume
    └── kill
```

每个子命令是独立文件并导出 `new commander.Command(...)`。命令组只负责 `.addCommand()`。

## 2. Commander 基础

以 [`sandbox exec`](../../../packages/cli/src/commands/sandbox/exec.ts) 为例：

```ts
new Command('exec')
  .description(...)
  .argument('<sandboxID>', ...)
  .argument('<command...>', ...)
  .option('-b, --background', ...)
  .option('-c, --cwd <dir>', ...)
  .action(async (sandboxID, commandParts, opts) => { ... })
```

Commander 区分：

- argument：位置参数，`<...>` 必填、`[...]` 可选、`...` 可变长；
- option：命名选项，camelCase 后放入 opts；
- alias：短命令别名；
- parser：在 action 前把字符串转换并校验。

参数错误应在 parser 中抛 `commander.InvalidArgumentError`，用户会得到一致的 usage 信息。例如 [`parsePositiveInt`](../../../packages/cli/src/options.ts) 拒绝 NaN、非整数和小于 1。

## 3. CLI 凭据来源

[`src/api.ts`](../../../packages/cli/src/api.ts) 集中处理凭据：

```text
API Key:
  E2B_API_KEY
    ↓ 若没有
  ~/.e2b/config.json 的 teamApiKey

Access Token:
  E2B_ACCESS_TOKEN
    ↓ 若没有
  ~/.e2b/config.json 的 tokens.access_token
```

`ensureAPIKey()` 用于 Sandbox/Template 等团队 API；`ensureAccessToken()` 用于账户级操作。`resolveTeamId()` 的优先级：

```text
--team
  > E2B_TEAM_ID
  > 本地 e2b.toml team_id
  > 用户配置 teamId（仅当没有显式 E2B_API_KEY）
```

最后一条避免“环境变量 API Key 属于团队 A，但配置文件 teamId 属于团队 B”的错配。

## 4. 登录流程

[`auth/login.ts`](../../../packages/cli/src/commands/auth/login.ts) 的浏览器 OAuth-like 流程：

1. 本地监听 `127.0.0.1` 随机端口；
2. 打开 E2B docs 登录 URL，携带回调地址和 CLI 版本；
3. 浏览器认证后重定向回 localhost；
4. CLI 验证回调字段；
5. 用 Access Token 查询 teams；
6. 选择默认 team，保存 Access/Refresh Token 和 team API Key；
7. 浏览器再次重定向到成功/失败页面。

[`user.ts`](../../../packages/cli/src/user.ts) 将目录设 `0700`、文件设 `0600`。配置包含长期敏感凭据，所以这不只是格式细节，而是安全要求。

无浏览器 CI 应使用环境变量，不要试图自动化读取或复制本地配置：

```bash
E2B_API_KEY='e2b_***' e2b sandbox list
E2B_ACCESS_TOKEN='...' e2b <需要账户 token 的命令>
```

## 5. `sandbox create` 执行链

[`commands/sandbox/create.ts`](../../../packages/cli/src/commands/sandbox/create.ts)：

```text
解析 [template]、timeout、lifecycle、detach
  → ensureAPIKey()
  → 若没给 template，尝试读 e2b.toml
  → 仍没有则使用 base
  → 把 CLI 秒转换为 SDK 毫秒
  → Sandbox.create(templateID, opts)
  → --detach: 输出 ID 并退出
  → 否则 spawnConnectedTerminal(sandbox)
```

CLI 要求 `--timeout` 至少 30 秒，在 parser 中乘 1000 后传 JS SDK。

交互终端期间，每 5 秒调用 `sandbox.setTimeout()` 保活。终端退出时清 interval，等待正在进行的 keepalive，再把 Sandbox timeout 设为显式值或 1 秒。这里的意图是终端会话活跃时保持资源，会话结束后尽快结束默认临时 Sandbox。

如果使用 `--detach`，CLI 不进入终端，Sandbox 按创建 timeout 自行结束。

## 6. `sandbox exec`：最值得读的 CLI 命令

用法：

```bash
e2b sandbox exec <sandbox-id> -- echo hello
e2b sandbox exec <sandbox-id> -c /workspace -e MODE=test -- npm test
e2b sandbox exec <sandbox-id> -b -- sleep 3600
printf 'hello\n' | e2b sandbox exec <sandbox-id> -- wc -c
```

执行链：

1. `Sandbox.connect(sandboxID)`；
2. `buildCommand(commandParts)` 还原安全命令字符串；
3. 始终用 SDK background handle 启动，这样 CLI 能即时流 stdout/stderr；
4. 安装 SIGINT/SIGTERM handler，终止时 kill 远端进程；
5. 若 stdin 是 pipe，分 64 KiB chunk 发送；
6. 本地 EOF 后调用 `closeStdin()`；
7. `handle.wait()`；
8. `CommandExitError` 的 exitCode 成为 CLI 退出码。

为什么前台 CLI 也用 `background: true`？SDK 的前台 API 只在命令完成后返回累积结果；CLI 需要边运行边写本地 stdout/stderr，还要响应信号和 stdin，所以必须直接控制句柄。

后台模式输出 PID 到 stderr，随后 `disconnect()`，远端继续运行；CLI 退出码固定为 0，因为它只确认启动成功，不知道未来命令结果。

## 7. 管道 stdin 的边界

CLI 检查本地 stdin 是否 TTY。若是 pipe 且 envd 支持 close stdin：

- 启动命令时 `stdin: true`；
- 按块转发，避免整体缓存大输入；
- 远端进程提前退出时停止发送；
- 发送 EOF 失败时 best-effort kill，防止远端永远卡住。

这段代码展示了健壮流式桥接所需的异常路径。不能只写：

```ts
for await (const chunk of process.stdin) {
  await handle.sendStdin(chunk)
}
```

还必须处理远端提前退出、close stdin 不支持、EOF RPC 失败、本地信号和 kill 失败。

## 8. List、Info、Kill

### 8.1 List

CLI list 默认 state 是 running，而 SDK list 默认 running + paused。CLI 逐页拉取，每页最多 100，并实现总数 limit；可输出 pretty 或 JSON。

```bash
e2b sandbox list --state running,paused --limit 20 --format json
e2b sandbox list --metadata job=42
```

### 8.2 Info

`Sandbox.getInfo()` 的 Date、对象和数组被格式化为人类可读字段；JSON 模式直接序列化。

### 8.3 Kill

```bash
e2b sandbox kill <id1> <id2>
e2b sandbox kill --all --state running --metadata suite=test
```

`--all` 与显式 IDs 互斥。批量模式逐页 list，再对每页 `Promise.all` kill。一个改进批量命令时要考虑单项失败是否应中断全部，以及输出的总数语义。

## 9. Pause、Resume、Connect

- pause 调 `Sandbox.pause(id)`；返回 false 时显示 already paused；
- resume 调 `Sandbox.connect(id)` 触发恢复；
- connect 恢复/连接后调用 `spawnConnectedTerminal()`。

connect 退出时不会 kill Sandbox，因为注释明确：关闭某个用户的终端连接不应影响其他连接者。相比 create 的临时终端，这是一处有意不同的资源语义。

## 10. Logs 与 Metrics

`sandbox logs --follow` 轮询日志 API，按 timestamp 前移 offset，支持级别、logger 和 JSON/pretty 格式。

`sandbox metrics --follow` 调 SDK `Sandbox.getMetrics`，保存最后时间戳并跳过重复采样，把 bytes 转 MiB 输出 CPU/内存/磁盘。

二者都有“Sandbox 找不到”和“运行中结束”的不同提示。follow 是客户端轮询，不是长连接；间隔约 400 ms。

## 11. Template CLI

### 11.1 `template create`

```bash
e2b template create my-template \
  --dockerfile e2b.Dockerfile \
  --cmd 'python /app/server.py' \
  --ready-cmd 'curl -f http://localhost:8000/health' \
  --cpu-count 2 \
  --memory-mb 1024
```

命令校验模板名小写规则、memory 为偶数，然后把 Dockerfile 解析成 SDK Template 并调用 `Template.build()`。若指定 start command，必须同时指定 ready command。

### 11.2 `template init`

交互选择 TypeScript、Python sync 或 Python async，使用 Handlebars 模板生成 build 文件、template 文件、README，并向 package.json 或 Makefile 加构建脚本。

代码写文件和修改 package.json 的逻辑在 CLI 内，因为这是本地脚手架职责，不属于 SDK。

### 11.3 `e2b.toml`

[`config/index.ts`](../../../packages/cli/src/config/index.ts) 用 yup 校验 TOML，支持旧字段 `id → template_id`、`name → template_name` 迁移。新构建系统不再推荐依赖 TOML，但保留兼容读取。

## 12. CLI 输出与退出码原则

好的 CLI 需要区分 stdout 与 stderr：

- 远端命令 stdout 原样到本地 stdout，可继续 pipe；
- 远端 stderr 到本地 stderr；
- 后台 PID 到 stderr，避免污染可能用于机器处理的 stdout；
- 命令退出码尽量保留远端 exit code；
- SDK/认证错误使用 1。

新增机器可读命令应提供 `--format json`，JSON 模式不要混入颜色、标题或提示语。

## 13. CLI 测试方法

[`tests/setup.ts`](../../../packages/cli/tests/setup.ts) 在测试前 build CLI，然后用 `spawnSync` 或 `spawn` 执行 `node dist/index.js`。这比直接调用 action 函数更接近真实行为，可验证：

- Commander 参数解析；
- stdout/stderr；
- 退出码；
- piped stdin；
- 信号与超时。

部分 CLI 测试需要真实后端，fixture 通过环境变量控制 timeout。纯 parser/helper 应写快速单元测试，避免每次都创建 Sandbox。

## 14. 新增 CLI 选项的步骤

假设为 `sandbox create` 加 `--metadata key=value`：

1. 在 Command 上定义 repeatable option parser；
2. 明确重复 key、空 key、包含 `=` 的 value 如何处理；
3. 更新 opts TypeScript 类型；
4. 映射成 `Sandbox.create({ metadata })`；
5. 为合法、非法、多值参数加 CLI 测试；
6. 更新 CLI README/帮助输出；
7. 若 SDK 已有 metadata，不需改三 SDK；若能力本身不存在，先实现跨 SDK；
8. 为 `packages/cli` 生成 changeset；
9. PR 描述加入用户示例。

## 15. 本模块练习

1. 使用 CLI 完成 create --detach → exec → info → metrics → kill 全流程。
2. 管道一个大于 64 KiB 的输入给 `wc -c`，验证分块转发结果。
3. 阅读 `spawnConnectedTerminal`，画出本地终端尺寸变化如何传给远端 PTY。
4. 比较 `sandbox create` 终端退出与 `sandbox connect` 终端退出后的资源行为。
5. 给一个纯 helper 设计表驱动测试，包括参数边界和 shell 特殊字符。

下一步阅读[模块 10：测试、代码生成与贡献实战](10-testing-codegen-contribution.md)。
