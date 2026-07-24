# 11. Enterprise 扩展：应用组合、组织权限、数据库与集成

`enterprise/` 不是简单的“多几个页面”，它在 OSS App Server 上组合认证、组织、RBAC、计费、共享会话、外部集成和 PostgreSQL 存储。理解它的最好方式是找“替换点”和“追加点”。

## 先尊重许可证边界

根许可证明确：`enterprise/` 使用 `enterprise/LICENSE` 的 Polyform Free Trial 条款，不属于根 MIT 部分。学习、修改和部署前都应阅读该许可证；本章只做架构导读，不重新授权 enterprise 内容。

## `saas_server.py` 如何组合应用

启动顺序非常有信息量：

```python
if not os.getenv('OPENHANDS_CONFIG_CLS'):
    os.environ['OPENHANDS_CONFIG_CLS'] = 'server.config.SaaSServerConfig'
os.environ['SERVE_FRONTEND'] = 'false'

from openhands.app_server.app import app as base_app
```

它先设置配置类和静态服务行为，再 import base app。之后：

```text
追加 auth/oauth/device routes
追加 billing/org/admin/shared/integration routes
覆盖 /api/v1/users/me
添加 SaaS middleware
最后 mount frontend
app = base_app
```

这是 composition root：决定所有模块如何装配。调试“为什么 SaaS 用了 OSS service”时，应先看这里和配置注入，而不是直接改 route。

## 追加与覆盖的区别

大部分企业能力用 `include_router` 追加新 URL；`users/me` 需要在同一路径扩展 org/role/permissions，于是通过 `override_users_me_endpoint(base_app)` 替换。

覆盖已有 route 风险更高：

- 注册顺序和 route matching 必须可预测；
- OpenAPI 可能出现重复 operation；
- OSS 签名变化需同步；
- 测试要验证最终 app 实际调用 enterprise handler。

能通过 service injection 扩展时，优先注入实现；只有 response contract 确实变化才覆盖 route。

## SaaS 配置如何进入 OSS 抽象

`SaaSServerConfig` 描述 app mode、auth URL、provider、feature flags 等 web config。另一方面 `openhands/app_server/config.py` 检查 `OPENHANDS_CONFIG_CLS` 中是否含 `saas`，选择 SaaS lifespan。

此外 SettingsStore、SecretsStore、UserAuth 等通过 class path 或 injector 替换为 enterprise 实现。结果是：

```text
OSS router/service interface
  + SaaS injector/store/auth implementation
  = enterprise behavior
```

这降低 fork 成本，但 import path 和环境变量成为契约，拼写错误可能只在运行时暴露。

## 身份认证与授权要分开

- Authentication：用户是谁？由 cookie、Keycloak token、API key 等证明。
- Authorization：这个用户能否对某组织/资源做某动作？由 role、permission、resource owner 决定。

Enterprise route 常用：

```python
user_id: str = Depends(require_permission(Permission.CREATE_ORGANIZATION))
```

dependency 同时完成身份解析和权限检查，endpoint 得到已授权 user id。不要只在 UI 隐藏按钮；后端必须执行授权。

## 三个作用域

常见权限作用域：

```text
实例级   superadmin、全局配置、用户 provisioning
组织级   org owner/admin/member、预算、组织设置
用户级   个人 settings、个人 secrets、自己的 conversation
```

同名 action 在不同 scope 可能需要不同 permission。例如查看自己的 usage 与查看组织成员 usage 不是同一权限。

## Effective organization

用户可能属于多个组织。请求需要解析 effective org，来源可能是 selected org、path `org_id` 或用户当前组织。源码还有专门 dependency 拒绝 `X-Org-ID` 与 path org id 不一致，防止客户端 header 和 URL 指向不同租户。

多租户安全原则：

> 先解析唯一 effective tenant，再让所有 store/service query 都带 tenant 条件；不要让各层各自选择组织。

## Superadmin 的安全不变量

`super_admins.py` 展示了清晰的领域规则：

- 只有 `MANAGE_SUPER_ADMINS` 权限可调用；
- grant 幂等；
- 可通过 user id 或 email 定位，但必须恰好提供一个；
- 不允许撤销最后一个 superadmin；
- 最后管理员检查在 Store 内原子执行。

最后一点很重要。若 route 先 count 再 delete，并发两个请求可能都看到 count=2，最终删光。安全不变量必须在数据库 transaction/lock 边界内保证。

## Service 与 Store 分层

Enterprise 常见：

```text
Router       HTTP、validation、status code
Service      业务流程、权限后的领域操作、外部系统协调
Store        SQLAlchemy query、transaction、持久模型
Integration  GitHub/GitLab/Jira/Slack client 与 webhook adapter
```

例如 org route 不应直接在多处写 SQL；`OrgService` 组合 org store、membership 和 LiteLLM。复杂流程的异常被映射为 404/409/500 等稳定 HTTP 语义。

## 异步与同步数据库

Enterprise 同时可能存在 SQLAlchemy async engine（应用请求）和 sync engine（Alembic migration）。测试配置常用 SQLite memory，但生产是 PostgreSQL/Cloud SQL。

需要理解：

- `AsyncSession` 不能跨 event loop 或被后台 task 在关闭后使用；
- transaction 边界应覆盖业务不变量；
- connection pool 需在 lifespan exit 关闭；
- migration env 与应用 import 不能产生意外网络连接；
- SQLite 与 PostgreSQL 在约束、JSON、并发上不完全相同。

## Alembic migration

数据库 schema 改动通常包含：

1. 修改 SQLAlchemy model；
2. 新增 `enterprise/migrations/versions/` migration；
3. 明确 upgrade/downgrade；
4. 处理现有行 backfill；
5. 检查锁和大表操作；
6. 测试从上一版本升级；
7. 检查 migration head 冲突。

Enterprise migration 使用 PostgreSQL advisory lock，防止多个实例同时执行迁移。分布式部署里“应用启动即迁移”必须考虑多副本并发。

## 集成的共同结构

GitHub、GitLab、Bitbucket、Azure DevOps、Jira、Slack 通常包含：

```text
OAuth/token manager
  -> provider service/client
  -> webhook route + signature verification
  -> payload resolver
  -> conversation start/update
  -> callback processor 把结果同步回外部系统
```

新增 provider 时不要复制粘贴整条链，要先实现共同 protocol/service types，再为差异点写 adapter。

## 条件注册 router

`saas_server.py` 只在 client id/feature flag 配置时注册某些 integration router。这样未配置功能不会暴露无效 endpoint。

环境变量 boolean 必须兼容 `'true'` 和 `'1'`（项目部署历史中 Helm 可能使用 `1`）：

```python
os.getenv('FEATURE_ENABLED', 'false').lower() in ('true', '1')
```

新增开关要测试两种 truthy 形式与默认 false。

## 共享会话为何需要事件过滤

公开/共享 conversation 不能简单把内部 event stream 原样暴露。需要考虑：

- secret、token、内部路径；
- system prompt 或仅 owner 可见内容；
- tool output 中的敏感数据；
- 子会话与组织边界；
- archived 后的访问策略。

Enterprise 有 shared conversation/event service 专门处理投影和过滤。权限过滤应在服务端执行，不能只依赖前端不渲染。

## 测试 Enterprise 的 import 路径

项目要求 enterprise code 使用无 `enterprise.` 前缀的相对顶层包：

```python
from storage.database import a_session_maker
from server.auth.authorization import Permission
```

运行测试需要把 `enterprise` 加到 `PYTHONPATH`。否则本地从仓库根 import 成功/失败的表现可能与部署镜像不同。

目标测试示例：

```bash
PYTHONPATH=enterprise poetry run pytest \
  enterprise/tests/unit/server/routes/test_orgs.py
```

## 本章实验：审计一个组织 endpoint

选择 `create_org`，逐项回答：

1. 身份如何获得？
2. 需要什么 Permission？
3. effective org 是否参与？为什么创建时可能不需要现有 org？
4. 业务逻辑在哪个 Service？
5. 哪些异常映射 409，哪些 500？
6. 日志是否包含必要 id 而不包含 secret？
7. 并发创建同名 org 的唯一性在哪层保证？

再对 `revoke_super_admin` 做相同分析，特别检查最后管理员不变量。

## 常见误区

- 看到根 MIT 就认为 enterprise 也是 MIT。
- 在 UI 隐藏按钮代替后端授权。
- 先 count 再 delete 来保证最后管理员规则。
- header 和 path 各自解析 org，却不检查一致性。
- 在 route 直接写跨多个 store 的复杂 transaction。
- 新增 env toggle 只接受字符串 `true`。

## 自测

1. Enterprise 怎样复用同一个 FastAPI app？
2. 什么时候应该注入 service，什么时候才需要覆盖 route？
3. 为什么最后 superadmin 检查必须原子化？
4. effective org 为何必须唯一解析？
5. 条件 router 注册与 endpoint 内返回“未配置”相比有什么优点？

## 源码定位

- [Enterprise composition root](https://github.com/OpenHands/OpenHands/blob/6b04532541bf2b757d4820d31387b6cba6ffcaea/enterprise/saas_server.py)
- [SaaS server config](https://github.com/OpenHands/OpenHands/blob/6b04532541bf2b757d4820d31387b6cba6ffcaea/enterprise/server/config.py)
- [组织路由](https://github.com/OpenHands/OpenHands/blob/6b04532541bf2b757d4820d31387b6cba6ffcaea/enterprise/server/routes/orgs.py)
- [Superadmin 路由](https://github.com/OpenHands/OpenHands/blob/6b04532541bf2b757d4820d31387b6cba6ffcaea/enterprise/server/routes/super_admins.py)
- [SaaS UserAuth](https://github.com/OpenHands/OpenHands/blob/6b04532541bf2b757d4820d31387b6cba6ffcaea/enterprise/server/auth/saas_user_auth.py)
- [数据库与迁移目录](https://github.com/OpenHands/OpenHands/tree/6b04532541bf2b757d4820d31387b6cba6ffcaea/enterprise/migrations)

下一章把这些层次转成可执行的测试与调试策略。
