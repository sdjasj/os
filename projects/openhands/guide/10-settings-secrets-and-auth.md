# 10. 设置、密钥与认证：从用户表单到 Sandbox 按需取值

OpenHands 同时处理普通设置、LLM 凭据、Git provider token、自定义 secret、组织继承和 Sandbox capability。把它们都当作一个 JSON 设置对象会造成泄漏或优先级混乱。本章从数据分类开始，追踪安全传递链。

## 先分类，而不是先看字段

| 类型 | 例子 | 典型保存/传输策略 |
| --- | --- | --- |
| 普通偏好 | language、sound notification | 可直接返回前端 |
| Agent 配置 | model、condenser、max iterations | schema 校验、版本化 |
| 应用 Secret | LLM key、search key | 存储加密/掩码，按需暴露 |
| Provider token | GitHub/GitLab token | provider 专用接口与刷新逻辑 |
| Sandbox capability | session API key | 短作用域访问 Sandbox |
| 用户身份凭据 | cookie/Bearer/OpenHands API key | 认证中间件和 UserAuth |

相同的字符串形式不代表相同安全语义。尤其不要把 session key、LLM key 和登录 token 混为一类。

## 后端 Settings 模型

`Settings` 聚合兼容字段与 SDK settings。当前项目正向 schema 驱动的 `agent_settings`、`conversation_settings` 演进，同时仍向前端提供 `llm_model`、`confirmation_mode` 等便利字段。

这导致读取时需要 normalization：

```text
持久化/SDK nested settings
  -> backend compatibility projection
  -> frontend normalizeSettingsResponse
  -> Settings UI 的平坦便利字段
```

写入时又要把 UI 字段合回 nested SDK settings。新增字段时若只改一层，常表现为“UI 能改但刷新丢失”或“后端保存了但运行时不用”。

## Pydantic serialization context

Secret 字段不能简单依赖 `model_dump()` 默认行为。项目使用 context 控制：

```python
settings.model_dump(context={'expose_secrets': True})
```

不同场景：

- 普通 `/users/me`：返回 masked/flag，不返回 raw；
- FileSettingsStore 内部持久化：需要真实值；
- App Server → Agent Server：在受控边界内可能需要序列化 SecretSource；
- 浏览器读取 settings：常返回 `llm_api_key_set=true` 而不是 key。

“对象里有 secret”与“序列化时公开 secret”必须分离。

## `SecretStr` 解决什么，不解决什么

Pydantic `SecretStr` 默认 repr/JSON 可掩码，降低日志和调试输出误泄漏。但它不能：

- 自动加密磁盘存储；
- 阻止显式 `get_secret_value()`；
- 替代 API 权限校验；
- 阻止开发者把 raw value 拼进异常。

因此它只是防误用的一层，不是完整 secret management。

## SecretSource：值与取值方式分离

SDK 使用 `SecretSource` 抽象。两种核心形式：

```text
StaticSecret  直接携带值
LookupSecret  携带“到哪里、用什么受限凭据获取值”的说明
```

在本地 OSS，App Server 和 Sandbox 往往属于同一信任域，可使用 StaticSecret。SaaS 更倾向 LookupSecret，让 raw secret 只沿 SaaS → Sandbox 的按需请求流动，不经过 SDK 客户端或浏览器。

这是 secret reference 模式：控制面下发引用，执行面在最后一刻解析。

## `/users/me?expose_secrets=true` 的双重证明

普通用户 API 有 Bearer/cookie，只能证明“你是谁”。当 Sandbox 内 SDK 请求完整 LLM 配置时，还必须证明“你控制一个属于该用户的活跃 Sandbox”。因此 endpoint 额外要求：

```http
X-Session-API-Key: <sandbox capability>
```

服务端 `validate_session_key_ownership` 组合校验：

```text
登录身份 -> user id
session key -> sandbox record -> owner id
两者相等 -> 可返回 unmasked settings
```

单独知道 session key 不应越权到其他用户，单独登录也不应让普通浏览器轻易请求 raw secret。

## Sandbox secret endpoint

另一路径是按 secret 名读取：

```text
GET /api/v1/sandboxes/{id}/settings/secrets
  -> 仅 names + descriptions

GET /api/v1/sandboxes/{id}/settings/secrets/{name}
  -> 单个 raw value
```

同样用 session key 验证 Sandbox。list 不返回值，既降低泄漏面，也允许 Agent 只解析真正要用的 secret。

## 普通 OpenHands Agent 与 ACP 的差异

普通 Agent 在 SaaS 可使用带受限 header 的 LookupSecret。ACP 子进程路径有兼容限制：SDK serializer 可能把 header 名中含敏感词的字段 redaction，导致 lookup 认证信息消失。因此当前实现为 ACP 解析成 StaticSecret，并明确清理不应传入 provider 子进程的普通 LLM proxy 设置。

这里的教训不是“StaticSecret 更好”，而是：安全抽象跨进程/序列化器时，必须验证 wire representation，不能只看 Python 对象。

## JWT、JWS 与 JWE

`JwtService` 支持：

- JWS：签名，防篡改但 payload 可读；
- JWE：加密，使用限定的 `dir + A256GCM`；
- key id：支持轮换；
- legacy Fernet fallback：读取旧数据，新数据写 JWE。

不要把 JWT 一概理解为“加密 token”。普通 JWS payload 只是 base64url 编码，可被读取。需要保密时必须使用 JWE 或其他加密存储。

限制算法集合可防 algorithm agility 问题。读取 `kid` 决定 key 后仍必须用允许的算法验证，不能信任 token 自报任意算法。

## UserAuth 与 UserContext

`UserAuth` 负责底层认证和存储访问；`UserContext` 为业务 service 提供稳定接口：

```text
get_user_id / get_user_email
get_user_info(resolve_agent_profile=...)
get_provider_tokens
get_authenticated_git_url
get_secrets
get_effective_org_id
```

`AuthUserContext` 会在一个请求中缓存普通和 resolved profile 两种 UserInfo，避免重复解析。但一次性 profile override 不缓存，以免污染后续调用。

这是 facade + request cache：业务层不直接知道 OSS file store 或 SaaS database/Keycloak。

## 前端 settings normalization

`useSettings` 的 query function 读取 personal 或 org scope，再用 `normalizeSettingsResponse`：

```typescript
return {
  ...DEFAULT_SETTINGS,
  ...settings,
  llm_model: resolveSdkString(agentSettings, "llm.model", defaultModel),
  confirmation_mode: pickFirstBoolean(
    conversationSettings.confirmation_mode,
  ) ?? defaultConfirmation,
};
```

先铺 defaults，再铺服务端 response，再显式派生兼容字段。显式派生放最后，避免浅 spread 让 nested schema 与平坦字段不一致。

404 时 hook 向 UI 返回 defaults，但不把 defaults 作为 `initialData` 填入 Query cache，避免 cache 看起来像成功读取到真实设置。

## 保存模式与 cache invalidation

表单设置使用 `useSaveSettings`，成功后更新/失效 settings query；Secrets 等实体使用独立 mutation 即时保存。

敏感输入保存后通常应该：

- 清空输入框 raw value；
- 只显示 `*_set` 标志；
- 不把 raw secret 写回长期 Query cache；
- 错误 toast 不包含请求 body；
- analytics 只记录动作，不记录字段值。

## 设置继承与优先级

SaaS 可能有：

```text
系统默认
  -> 组织默认
  -> 用户设置/diff
  -> active Agent Profile
  -> 单次 conversation override
```

不同字段可能采用 merge、replace 或禁止用户覆盖。必须在后端产生“effective settings”，前端不应自行猜组织继承规则。

保存时也要明确 scope。个人页不能误写 org defaults，org settings query key 必须包含 selected organization id。

## 本章实验：追踪一个 LLM key

不要使用真实 key。以占位值为例，画出：

1. Settings UI input；
2. `useSaveSettings` payload；
3. settings router；
4. SettingsStore 持久化；
5. 普通读取返回什么；
6. 会话启动如何变成 StaticSecret/LookupSecret；
7. Sandbox 最终如何获得值；
8. 日志、Query cache、浏览器 response 中哪些位置绝不能出现 raw value。

再阅读 secret API tests，检查未授权、错误 owner、无 session key、masked response 四类用例。

## 常见误区

- 认为 `SecretStr` 自动解决存储加密和授权。
- 认为所有 JWT payload 都保密。
- 把 raw secret 放入 TanStack Query 长期 cache。
- 在前端合并组织继承规则。
- 新增设置只改 UI type 和 default，不改后端模型/运行时消费。
- 让一次性 Agent Profile override 进入 request cache。

## 自测

1. StaticSecret 和 LookupSecret 的信任边界有何不同？
2. 为什么 expose secrets 需要用户身份与 Sandbox capability 两个证明？
3. JWS 与 JWE 分别保证什么？
4. 404 settings 为什么不适合用 Query `initialData` 伪装？
5. 保存 secret 后前端应保留什么状态？

## 源码定位

- [Settings 后端模型](https://github.com/OpenHands/OpenHands/blob/6b04532541bf2b757d4820d31387b6cba6ffcaea/openhands/app_server/settings/settings_models.py)
- [Settings 路由](https://github.com/OpenHands/OpenHands/blob/6b04532541bf2b757d4820d31387b6cba6ffcaea/openhands/app_server/settings/settings_router.py)
- [Secret 模型](https://github.com/OpenHands/OpenHands/blob/6b04532541bf2b757d4820d31387b6cba6ffcaea/openhands/app_server/secrets/secrets_models.py)
- [User expose-secrets 校验](https://github.com/OpenHands/OpenHands/blob/6b04532541bf2b757d4820d31387b6cba6ffcaea/openhands/app_server/user/user_router.py)
- [JWT/JWE 服务](https://github.com/OpenHands/OpenHands/blob/6b04532541bf2b757d4820d31387b6cba6ffcaea/openhands/app_server/services/jwt_service.py)
- [前端 settings query](https://github.com/OpenHands/OpenHands/blob/6b04532541bf2b757d4820d31387b6cba6ffcaea/frontend/src/hooks/query/use-settings.ts)

下一章解释 Enterprise 如何复用 OSS 核心，并增加组织、权限、存储和集成。
