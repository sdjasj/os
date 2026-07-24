# 13. 端到端功能演练：安全地新增一个用户设置

这一章不直接修改项目，而是以假想设置 `show_tool_timestamps` 为例，完整走一遍需求澄清、后端模型、API、前端表单、运行时消费和测试。重点是掌握方法，而不是照抄字段名。

## 第一步：把需求变成可验证语义

假设需求是：“用户可以选择是否在聊天工具卡片上显示精确时间，默认关闭。”先回答：

- scope：个人设置还是组织默认？这里先做 personal，可继承组织默认需另设计。
- 默认值：`false`。
- 保存模式：与其他 Application settings 一起手动保存。
- 敏感性：普通 boolean，不是 secret。
- 生效时机：保存后立即影响 UI，无需重启 Sandbox。
- 权威来源：SettingsStore；前端 Query cache 是投影。
- 兼容性：旧 settings 文件缺字段时用 false。

这些答案决定数据流。若字段其实影响 Agent 启动，就还要写入 `ConversationSettings` 并规定仅新会话生效。

## 第二步：画变更矩阵

```text
后端模型
  openhands/app_server/settings/settings_models.py

后端读取/保存
  settings_router.py / SettingsStore（若通用序列化已覆盖，可能无需额外代码）

前端类型与默认
  frontend/src/types/settings.ts
  frontend/src/services/settings.ts

前端读取映射
  frontend/src/hooks/query/use-settings.ts

前端保存映射
  frontend/src/hooks/mutation/use-save-settings.ts

UI
  frontend/src/routes/app-settings.tsx 或对应 feature component

i18n
  frontend/src/i18n/translation.json
  npm run make-i18n 生成 declaration

消费
  tool card timestamp renderer

测试
  backend settings API + frontend hook/component
```

先列矩阵再编辑，可以避免漏层。

## 第三步：后端模型与默认

概念代码：

```python
class Settings(BaseModel):
    show_tool_timestamps: bool = False
```

但真正修改前先检查 Settings 是否有 custom serializer、版本迁移和 legacy conversion。若字段属于 SDK dynamic schema，可能不应直接加平坦字段，而应进入 `agent_settings` 或 `conversation_settings`。

判断标准：

- 仅 Web UI 偏好：App-level Settings 字段；
- 改变 Agent 行为：SDK AgentSettings；
- 改变单次 conversation 控制：ConversationSettings；
- 独立多实体：单独 resource API。

## 第四步：API round-trip 测试先行

写测试表达契约：

```python
async def test_show_tool_timestamps_round_trip(client):
    response = await client.post(
        '/api/v1/settings',
        json={'show_tool_timestamps': True, ...},
    )
    assert response.status_code == 200

    response = await client.get('/api/v1/settings')
    assert response.json()['show_tool_timestamps'] is True
```

还要覆盖：

- 旧记录无字段 → false；
- 显式 false 不被 `or default` 错写；
- 非 boolean → 422；
- 另一个用户看不到该设置；
- 若支持 org scope，personal/org query 不串。

boolean 最常见 bug 是用 truthiness：

```python
# 错：False 会回退
value = stored_value or default_value

# 对：只在 None/缺失时回退
value = stored_value if stored_value is not None else default_value
```

## 第五步：前端类型和默认值

在 `Settings` type 加：

```typescript
show_tool_timestamps: boolean;
```

在 `DEFAULT_SETTINGS` 加：

```typescript
show_tool_timestamps: false,
```

如果 API type 与 UI type 分开，两处都需更新。不要用 `as Settings` 掩盖缺失字段；让 TypeScript 提示所有构造点。

## 第六步：读取 normalization

显式使用 nullish coalescing：

```typescript
show_tool_timestamps:
  settings.show_tool_timestamps ?? DEFAULT_SETTINGS.show_tool_timestamps,
```

不能用 `||`，因为合法 `false` 会被当成缺失。对于 number 0 和空字符串也同理，要按字段语义选择 fallback。

Query key 无需因字段新增而变化，因为它仍属于整个 settings resource；但 personal/org scope key 必须保持分离。

## 第七步：保存 payload

`useSaveSettings` 往往重建 payload，而不是原样发送 UI Settings。必须加入：

```typescript
show_tool_timestamps: settings.show_tool_timestamps,
```

然后检查 mutation success：

- 是否更新相同 scope 的 cache；
- 是否 invalidate；
- 是否保留后端 normalize 后的新 response；
- save button dirty state 是否清零；
- mutation error 是否保持用户未保存值。

## 第八步：UI 与 i18n

Application settings 页使用现有 toggle 组件和 manual-save pattern。不要新造一套 local save API。

文案应说明范围和时机：

```text
标题：显示工具时间
说明：在聊天中的工具调用卡片上显示事件发生时间。保存后立即应用。
```

更新 `translation.json` 后运行 `npm run make-i18n`，让 declaration 与实际 key 同步。不要手改生成文件后忘记源 JSON。

## 第九步：消费设置

Tool card component 不应直接调用 SettingsService：

```tsx
const { data: settings } = useSettings();

return (
  <ToolCard>
    {settings?.show_tool_timestamps && <time>{formattedTimestamp}</time>}
  </ToolCard>
);
```

如果很多 event card 都需要，可在上层读取一次并通过 context/prop 传递，避免每个 card 建立 selector 和重复格式逻辑。TanStack Query 会 dedupe 请求，但组件架构仍应清晰。

时间显示还要处理：timezone、locale、无 timestamp、SSR/hydration 差异和 accessibility `dateTime`。

## 第十步：前端测试

至少覆盖：

```text
useSettings: API 缺字段 -> false
useSettings: API false -> 保留 false
useSettings: API true -> true
useSaveSettings: payload 包含字段
Settings UI: toggle 改变 -> Save enabled
Settings UI: 保存成功 -> dirty 清除
Tool card: false 不显示 / true 显示
```

对于日期格式，用固定 timezone 或断言 semantic attribute，避免测试依赖机器 locale。

## 第十一步：如果字段影响新会话怎么办

假设需求改成“是否让 Agent 在工具调用前请求确认”，它属于 `conversation_settings.confirmation_mode`，链路不同：

```text
Settings UI
 -> nested conversation_settings
 -> backend SDK schema validation
 -> UserContext effective settings
 -> _build_start_conversation_request_for_user
 -> StartConversationRequest
 -> Agent Server/SDK
```

还要明确：

- 只影响新会话还是能热更新；
- ACP 与 OpenHands Agent 都支持吗；
- 组织默认能否覆盖；
- running conversation 切换是否有 endpoint；
- 未支持 agent variant 的 UI 是否隐藏。

这说明“一个 toggle”可能是 UI 偏好，也可能是跨进程协议变更，不能只凭外观估算工作量。

## 第十二步：提交前验证

后端变更：

```bash
poetry run pytest tests/unit/app_server/test_settings_api.py
pre-commit run --config ./dev_config/python/.pre-commit-config.yaml
```

前端变更：

```bash
cd frontend
npm run test -- -t "tool timestamps"
npm run lint:fix
npm run build
```

检查 `git diff` 确保：

- 没有真实 settings/secret 文件；
- 没有无关 generated noise；
- i18n declaration 与 source 同步；
- API、type、default、read、write、UI、test 全覆盖。

## 扩展练习一：即时保存实体

把需求换成“管理一组 webhook endpoint”。它不适合塞进 Settings 大表单，应建：

```text
GET/POST/PATCH/DELETE /webhooks
  -> WebhookService/Store
  -> useWebhooks query
  -> useAdd/Update/DeleteWebhook mutations
  -> 每次操作立即保存并 invalidate list
```

比较两种 UX 和数据模型，解释为什么 entity CRUD 不需要全局 Save Changes。

## 扩展练习二：环境变量 feature flag

若新增 `SHOW_TOOL_TIMESTAMPS_ENABLED` 作为部署开关，后端 truthy 解析必须接受：

```python
os.getenv('SHOW_TOOL_TIMESTAMPS_ENABLED', 'false').lower() in ('true', '1')
```

测试默认 false、`true`、`1` 和无关值。部署开关与用户偏好还需要定义组合规则，例如：

```text
effective = deployment_enabled AND user_enabled
```

由后端 web client config 暴露 deployment capability，前端只在支持时显示用户设置。

## 常见误区

- 把所有设置都加到平坦 Settings，而不判断 SDK/schema/entity 边界。
- boolean normalization 使用 `||`。
- 只改读取，忘了 save payload。
- 在 UI component 直接调用 SettingsService。
- 认为新增 toggle 一定只影响前端。
- env toggle 只识别 `true`，不识别历史 Helm 的 `1`。

## 自测

1. 如何判断设置属于 App、Agent、Conversation 还是独立 entity？
2. 为什么 boolean fallback 应使用 `??`/显式 None 判断？
3. 设置影响运行时 Agent 时还需经过哪些层？
4. 为什么 org/personal scope 必须进入 query key？
5. 哪些测试能证明 round-trip，而不只是 UI 状态改变？

## 源码定位

- [后端 Settings 模型](https://github.com/OpenHands/OpenHands/blob/6b04532541bf2b757d4820d31387b6cba6ffcaea/openhands/app_server/settings/settings_models.py)
- [前端 Settings type](https://github.com/OpenHands/OpenHands/blob/6b04532541bf2b757d4820d31387b6cba6ffcaea/frontend/src/types/settings.ts)
- [前端默认设置](https://github.com/OpenHands/OpenHands/blob/6b04532541bf2b757d4820d31387b6cba6ffcaea/frontend/src/services/settings.ts)
- [Settings query normalization](https://github.com/OpenHands/OpenHands/blob/6b04532541bf2b757d4820d31387b6cba6ffcaea/frontend/src/hooks/query/use-settings.ts)
- [Settings mutation](https://github.com/OpenHands/OpenHands/blob/6b04532541bf2b757d4820d31387b6cba6ffcaea/frontend/src/hooks/mutation/use-save-settings.ts)
- [Application settings route](https://github.com/OpenHands/OpenHands/blob/6b04532541bf2b757d4820d31387b6cba6ffcaea/frontend/src/routes/app-settings.tsx)

最后一章提供综合练习、排障剧本和术语表，帮助你把全套知识真正转化为能力。
