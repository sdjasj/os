# 模块 8：CubeOps、数据库与 WebUI

## 1. 学习目标

读完本章，你应能：

- 区分 CubeAPI 与 CubeOps 的职责；
- 理解 CubeDB migration fingerprint 和分布式锁；
- 理解 CubeOps JWT access/refresh token 流程；
- 从 React 页面追到 API wrapper，再追到 CubeOps/CubeMaster；
- 理解 TanStack Query 的 query、mutation、invalidate；
- 知道本地 mock 与真实后端模式怎样切换。

## 2. CubeAPI 与 CubeOps

| 服务 | 技术 | 面向对象 | 状态 |
|---|---|---|---|
| CubeAPI | Rust/Axum | E2B/官方 SDK 客户端 | 尽量 stateless |
| CubeOps | Go/Gin | WebUI、运维、AgentHub | 数据库/JWT/业务状态 |

CubeOps 默认 `:3010`，提供：

- `/api/v1/auth` 登录、刷新、会话、登出、改密；
- cluster/node/version；
- AgentHub；
- template store；
- runtime config；
- `/api/v1/sdk/*` 的 Sandbox/Template/Snapshot/Volume 管理代理。

WebUI 当前代码以 CubeOps JWT 为主要认证机制。部分早期文档仍把 WebUI 描述为 CubeAPI + `X-API-Key` 直连，调试当前分支应以路由和部署 nginx 为准。

## 3. CubeOps 启动

入口 [`CubeOps/cmd/cubeops/main.go`](../../CubeOps/cmd/cubeops/main.go) 大致：

1. load YAML + env config；
2. 初始化日志；
3. 建数据库连接；
4. 运行 CubeDB migration（可配置关闭）；
5. 初始化 JWT manager、store、service、handler；
6. 建 Gin router；
7. listen + graceful shutdown。

配置优先级是环境变量 > YAML > 默认值。生产不要直接使用 `make run` 中的测试 JWT secret；构建后直接启动 binary 并提供真实 secret，或让服务生成并持久化安全 secret。

## 4. 路由结构

[`CubeOps/internal/server/server.go`](../../CubeOps/internal/server/server.go) 分组：

```text
/health                              public
/api/v1/auth/login|refresh           public
/api/v1/...                          JWT middleware
/api/v1/sdk/...                      JWT middleware + SDK handler
/api/v1/sdk/v2/sandboxes...          JWT middleware
```

Public refresh 是必要的：access token 过期后，客户端无法携带有效 access token 进入 authenticated group，只能用 refresh token 换新 token。

## 5. JWT 会话

### 5.1 登录

```text
POST /api/v1/auth/login
  → 校验账号/密码
  → 生成短期 access token
  → 生成长期 refresh token
  → refresh token 记录/哈希入库
```

Access token 用于每个 API 的 Bearer auth；refresh token 只用于刷新，暴露面应更小。

### 5.2 Refresh rotation

当前 WebUI [`web/src/lib/api.ts`](../../web/src/lib/api.ts) 在 refresh 成功后同时保存新的 access token 和新的 refresh token。代码注释解释：服务端每次刷新会撤销旧 refresh token。

若前端只更新 access token，下一次刷新仍用已撤销旧 token，用户会在第二轮过期后被踢出。

### 5.3 并发 401

页面多个 query 可能同时收到 401。前端用 module-level `refreshing: Promise` 合并刷新：

```text
第一个 401 → 创建 refresh Promise
其他 401   → await 同一个 Promise
refresh 完成 → 各自用新 access token retry
```

否则每个请求都轮换一次 refresh token，只有第一个成功，后续会互相撤销。

## 6. CubeDB

[`CubeDB/`](../../CubeDB) 是 CubeMaster/CubeOps 共享的 Go module，支持 MySQL 与 PostgreSQL。

### 6.1 DAO driver

`dao/driver.go` 定义 driver 抽象，`dao/driver/mysql` 与 `postgres` 实现 dialect 差异。上层代码不要到处拼 `?`/`$1`、锁语法和 upsert 方言，应集中在 driver/dialect。

### 6.2 Migration

[`CubeDB/migrate/migrate.go`](../../CubeDB/migrate/migrate.go) 基于 goose：

- 内嵌/读取 migration SQL；
- 自动建表升级；
- 支持 MySQL/PostgreSQL 对齐；
- cluster-wide lock 避免多个服务实例同时迁移；
- fingerprint 检测历史 migration 是否被篡改。

### 6.3 为什么要 fingerprint

数据库 migration 一旦在线上执行，旧文件应视为不可变。若有人修改 `0001_baseline.sql` 而不新增 migration：

- 新库从修改后的历史得到 schema A；
- 老库已经执行原历史，通过新增 migration 得到 schema B；
- 两者 goose version 相同但结构不同。

Fingerprint store 保存已执行 SQL 的内容摘要，启动时对比可及时发现 silent schema drift。开发环境可显式 skip，但生产不应把 skip 当常态。

### 6.4 为什么有自动迁移开关

生产 runtime DB account 常只有 DML 权限。设置 `CUBE_AUTO_MIGRATION=false` 后由单独高权限流水线应用 migration，应用进程只验证/使用 schema。这是最小权限原则。

## 7. 数据模型范围

当前 migrations 覆盖：

- template definition、replica、artifact placement；
- runtime snapshot binding；
- volume 与 node ref count；
- AgentHub instance/template/settings；
- system settings；
- refresh token；
- component version 等。

Redis 保存低延时路由/生命周期状态，不等于这些关系数据可以完全丢进 Redis。选择存储时看查询、一致性、寿命和恢复要求。

## 8. CubeOps 分层

```text
internal/server        路由/中间件
internal/auth          JWT、login handler、rate limit
internal/handler       HTTP DTO 与编排
internal/service       业务规则
internal/store         数据库访问
internal/cubemaster    CubeMaster HTTP client
internal/model         共享类型
internal/translator    外部/内部模型转换
```

例如 AgentHub create 不是简单 insert：可能创建 Sandbox、写数据库、配置 OpenClaw、失败补偿。handler/service 中的 compensation test 是学习分布式业务事务的好例子。

## 9. SDK handler

CubeOps 的 [`internal/handler/sdk.go`](../../CubeOps/internal/handler/sdk.go) 为 WebUI提供 Sandbox/Template/Snapshot 等操作，并直接调用 CubeMaster REST。

这意味着当前 WebUI 链路可能是：

```text
Browser → nginx same-origin → CubeOps /api/v1/sdk → CubeMaster
```

而外部 E2B SDK 是：

```text
SDK → CubeAPI :3000 → CubeMaster
```

两条公开适配层最终汇聚到 CubeMaster，但认证模型不同。

## 10. Web 技术栈

[`web/package.json`](../../web/package.json)：

- React 18 + TypeScript；
- Vite；
- React Router；
- TanStack Query；
- Tailwind CSS；
- Zustand；
- i18next；
- MSW mock；
- openapi-typescript。

入口 [`web/src/main.tsx`](../../web/src/main.tsx) 注册 QueryClient、ThemeProvider、Router 和 AuthGuard。

## 11. 路由和 AuthGuard

页面路由：

```text
/login
/
/sandboxes
/sandboxes/new
/sandboxes/:sandboxID
/templates
/templates/:templateID
/nodes
/nodes/:nodeID
/versions
/network
/observability
/store
/agenthub
/settings
```

除 login 外都嵌套在 `AuthGuard`。Guard 应完成：

- 本地是否有 token；
- session 是否有效；
- loading 时避免页面闪烁；
- 无效时清 token 并跳登录；
- 保存/恢复用户原目标路径（若实现）。

## 12. API wrapper

[`web/src/lib/api.ts`](../../web/src/lib/api.ts) 提供两个函数：

- `api(path)`：SDK/E2B 操作的同源路径；
- `ops(path)`：`/opsapi/v1` 运维路径。

共同逻辑：

1. 拼 query，跳过 undefined/null/空字符串；
2. 从 localStorage 取 access token；
3. 添加 JSON Content-Type 和 Bearer；
4. 401 时合并 refresh；
5. 成功后解析 text/JSON；
6. 非 2xx 抛含 status/body 的 `ApiError`。

页面不应直接散落裸 fetch，否则会绕过 refresh、错误格式和 base path。

## 13. OpenAPI 类型

根 [`openapi.yml`](../../openapi.yml) 由 CubeAPI 导出，前端生成 [`web/src/api/generated/schema.ts`](../../web/src/api/generated/schema.ts)。命令：

```bash
make web-api-sync
```

API 模型变更后的正确流程：

1. 改后端 model/utoipa schema；
2. 导出 OpenAPI；
3. 生成 TS type；
4. 修复前端类型错误；
5. 后端与前端测试一起提交。

手改 generated schema 会在下次生成时丢失。

## 14. Sandboxes 页面示例

[`web/src/pages/Sandboxes.tsx`](../../web/src/pages/Sandboxes.tsx) 展示标准 TanStack Query 模式。

### 14.1 Query

```tsx
const { data, isLoading, refetch } = useQuery({
  queryKey: ['sandboxes'],
  queryFn: () => sandboxApi.list(),
  refetchInterval: 5_000,
});
```

`queryKey` 是缓存身份；5 秒轮询适合状态列表。若 filter 由服务端处理，应把 filter 放进 queryKey，否则不同筛选会共享错误缓存。

### 14.2 Mutation

pause/resume/kill 都：

- mutate 前清旧错误；
- 设置 pending ID；
- onError 统一格式化；
- onSettled 清 pending，并 invalidate `['sandboxes']`。

为什么 `onSettled` 而不只 `onSuccess`：失败也可能是请求已在服务端生效但响应丢失，重新拉取能让 UI 回到真实状态。

### 14.3 Client filter

页面先按 state，再按 sandbox/template/node 文本过滤。数据量大后应改为后端 pagination/filter；当前适合小型运维列表。

## 15. 国际化和主题

- `web/src/i18n/resources.ts` 管中英文资源；
- 页面使用 `useTranslation(namespace)`；
- ThemeProvider/Zustand 管主题；
- 新增文案不要硬编码一种语言；
- 错误中来自后端的动态信息可保留，但固定前缀/操作名应国际化。

## 16. MSW Mock

`main.tsx` 只在 DEV 且 mock flag 开启时动态 import [`mocks/browser.ts`](../../web/src/mocks/browser.ts)。优点：

- production bundle/运行不启动 worker；
- UI 可不依赖真实 KVM 集群开发；
- fixture 可稳定复现 paused/error/loading。

Mock 必须尽量遵守真实 API shape；否则 UI 在 mock 正常、接后端失败。生成 OpenAPI type 可降低漂移。

## 17. 前端本地开发

```bash
make web-install
make web-dev
# http://localhost:5173
```

检查与构建：

```bash
make web-lint
make web-build
make web-fmt
```

`web-lint` 当前主要运行 TypeScript `tsc --noEmit`，不是 ESLint。命令名不能替代对实际 script 的理解。

## 18. CubeOps 本地开发

```bash
cd CubeOps
export DATABASE_URL='mysql://cube:cube_pass@127.0.0.1:3306/cube_mvp'
export CUBE_MASTER_ADDR='http://127.0.0.1:8089'
export JWT_SECRET="$(openssl rand -hex 32)"
make build
./bin/cubeops
```

不要用文档示例默认密码部署到公开网络。登录、refresh、store refresh 等端点还应配合 rate limit。

## 19. 测试

```bash
# CubeDB
cd CubeDB
go test ./...

# CubeOps
cd ../CubeOps
go test ./...

# Web
cd ../web
npm ci
npm run lint
npm run build
```

数据库 dialect/integration tests 可能使用 dockertest 拉 MySQL/PostgreSQL；纯 handler/service test 使用 fake client/store 更快。

## 20. 动手练习

### 练习 1：追 pause 按钮

从 `Sandboxes.tsx` 的 pause button 开始，找到：

1. mutation；
2. `sandboxApi.pause`；
3. API wrapper URL；
4. nginx 路径映射；
5. CubeOps SDK handler；
6. CubeMaster update action。

### 练习 2：模拟 token 过期

用 MSW/测试 server 让三个并发请求同时返回 401，验证浏览器只发一个 refresh 请求，并且所有原请求使用新 token retry。

### 练习 3：写 migration

设计一个只新增 nullable column 的 MySQL/PostgreSQL migration：不要改历史文件，给出 up/down，说明 runtime account 无 DDL 权限时如何发布。

## 21. 自测题

1. CubeAPI 与 CubeOps 为什么不能简单合成一个完全相同的接口？
2. migration fingerprint 防止什么问题？
3. 为什么 refresh 请求不能放在需要有效 access token 的 group 中？
4. 多个 401 为什么必须合并 refresh？
5. mutation 失败后为什么仍可能需要 invalidate query？

