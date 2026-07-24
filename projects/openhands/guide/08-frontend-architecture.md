# 08. 前端架构：React Router、TanStack Query、Zustand 与组件边界

OpenHands 前端不仅展示聊天，它还管理设置、Git 集成、文件差异、终端、浏览器、VS Code、组织和计费。要读懂它，先按“路由—服务端状态—实时客户端状态—UI”分层，而不是从某个大组件顺序向下翻。

## 技术栈与各自职责

当前快照主要使用：

| 技术 | 职责 |
| --- | --- |
| React 19 | 组件和渲染 |
| React Router 7 | 路由、layout、loader 和构建 |
| TanStack Query 5 | 服务端数据缓存、请求状态、失效 |
| Zustand | 跨组件客户端状态和实时投影 |
| native WebSocket / Socket.IO | 实时事件连接（迁移中） |
| i18next | 国际化 |
| Tailwind/HeroUI | 样式与组件 |
| Vitest + Testing Library | 单元与组件测试 |
| MSW | HTTP/WebSocket mock |

重点不在“用了多少库”，而在每类状态只选一个权威机制。

## 客户端入口

`entry.client.tsx`：

```tsx
hydrateRoot(
  document,
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <PostHogWrapper>
        <HydratedRouter />
      </PostHogWrapper>
    </QueryClientProvider>
  </StrictMode>,
)
```

含义：

- 页面由 React Router hydration；
- 所有 route/component 共享同一 QueryClient；
- analytics provider 在路由外层；
- development mock 开启时，先启动 MSW 再 hydrate，避免首批请求漏过 mock。

`StrictMode` 开发环境可能让 effect 执行两次，用来暴露副作用不幂等问题。WebSocket hook 特别需要正确 cleanup。

## Route config 是页面地图

`src/routes.ts` 用显式 route config：

```text
/                         home
/launch                   创建任务
/settings/*               嵌套设置页
/conversations/:id        主会话页
/shared/conversations/:id 无需登录的共享只读页
```

`root-layout.tsx` 包裹需要统一认证/布局的页面；共享 route 放在 layout 外，避免错误施加登录 guard。

读一个页面时从 route file 开始，再进入 feature component；route 应承担页面边界和数据前置，不应包含所有细节 UI。

## Conversation route 的 Provider 层次

正常会话大致组合：

```tsx
<WebSocketProviderWrapper>
  <ConversationSubscriptionsProvider>
    <EventHandler>
      <ConversationNameWithStatus />
      <ConversationTabs />
      <ConversationMain />
    </EventHandler>
  </ConversationSubscriptionsProvider>
</WebSocketProviderWrapper>
```

这些层分别负责 runtime WebSocket、子会话订阅、事件分发和具体 UI。Provider 在 conversation id 切换时必须 cleanup，否则旧 socket 和旧事件会污染新会话。

## 归档会话为何是独立分支

route 读取 active conversation 后：

```typescript
const isArchived = conversation?.sandbox_status === "MISSING";
```

归档时仍挂 WebSocketProvider/事件处理以加载可用历史，但 UI 换成 `ArchivedConversationView`，不再渲染需要运行中 Sandbox 的交互 tabs。

这比在每个按钮上散布 `disabled={isArchived}` 更可靠：页面边界直接选择“只读能力集合”。

## API Data Access Layer

`src/api` 中 service 封装 Axios：

```typescript
const { data } = await openHands.post<V1AppConversationStartTask>(
  "/api/v1/app-conversations",
  body,
);
return data;
```

项目规则是 UI component 不直接调用 service，而通过 query/mutation hook：

```text
Component
  -> useCreateConversation / useSettings
  -> V1ConversationService / settingsService
  -> Axios
  -> API
```

好处：query key、cache invalidation、retry、toast、optimistic update 和测试 mock 集中。

## Query 与 Mutation

- `useQuery`：读取可重新获取的服务端状态；
- `useMutation`：执行写入，不自动拥有长期 cache；成功后应更新或 invalidate 相关 query。

创建会话 mutation 的返回值是 StartTask，而不是 Conversation。之后 task polling hook 负责等待 READY。这个拆分映射后端异步资源模型。

常见 query key 应包含影响响应的全部参数，例如 conversation id、organization id、filter。遗漏会导致不同页面共享错误缓存。

## 为什么不把所有状态都交给 Query

实时事件每个 token 更新，且需要 Action/Observation 投影；终端也有高频 buffer。这些不是典型“请求—缓存—过期”数据，因此 Zustand 更合适。

Zustand store 包括：

- event store；
- conversation state；
- agent state；
- command/terminal；
- optimistic user message；
- error message 等。

但服务端可查询的 settings/conversation metadata 仍应留在 Query。避免创建第二份长期真相。

## Context 和 Zustand 的区别

Context 适合“某个组件树内有生命周期的对象”，例如 WebSocket connection 与 send function；Zustand 适合“多个不相邻组件读取和更新的 serializable-ish 状态”。

WebSocket 放 Context 的原因：

- 它绑定 conversation route 生命周期；
- cleanup 与 Provider mount/unmount 直接相关；
- 提供方法与连接状态；
- 不希望任意页面在 Provider 外偷偷创建连接。

收到的事件再进入 Zustand，方便 Chat、Planner、状态条共享。

## 组件分层

以聊天输入为例，项目把：

```text
ChatInterface
  ├── use-chat-input-logic / submission / file handling
  ├── ChatInputContainer
  │   ├── ChatInputField
  │   ├── ChatInputActions
  │   └── Send/Stop buttons
  └── message list
```

复杂行为放 custom hook，纯展示放 component。这使 hook 可以用 mock context/query 单测，组件也更容易做交互测试。

## “Unified” hook 是迁移适配层

前端仍有 v0/v1 过渡痕迹，许多 hook 名为 `useUnified*`，例如：

- `useUnifiedStartConversation`；
- `useUnifiedStopConversation`；
- `useUnifiedGetGitChanges`；
- `useUnifiedWebSocketStatus`。

其作用是给 UI 一个稳定接口，在内部按当前会话类型选择实现。迁移完成后可以收敛，但在过渡期避免每个组件重复分支。

阅读时要确认 unified hook 当前是否真的还有两条有效路径，还是只剩兼容注释；不要沿已废弃路径花太多时间。

## 派生状态优于重复状态

`useAgentState` 从 live execution status、conversation 和 sandbox status 派生 `curAgentState`、`isArchived`。UI 使用这个 hook，而不是另外维护 `isRunning`。

重复存储派生状态会产生非法组合：

```text
isRunning=true
sandbox_status=MISSING
```

集中派生可以定义优先级并写测试。

## Settings 的两种 UX

项目存在两类保存模式：

1. Entity 资源即时保存：Secrets、API keys、MCP server；每次 add/edit/delete 是独立 mutation。
2. Form 设置手动保存：LLM、Application；本地积累变更，点击 Save 后统一 mutation。

选择标准不是个人偏好：独立实体适合即时写入；互相关联、需整体验证的字段适合表单保存。

## 测试层次

前端测试常用：

```text
纯函数测试       handleEventForUI、URL builder
hook 测试         useAgentState、query/mutation
组件测试          Settings、Chat、Route
MSW handler       模拟 HTTP 和 WebSocket
build/typecheck    验证路由类型和 bundling
```

对复杂实时 bug，先把时序压缩成纯函数输入数组，比在浏览器里反复点更稳定。

## 本章实验：为一个页面标注状态来源

选择 conversation page 上的五个元素：title、Agent status、message list、VS Code URL、input enabled。为每个写：

- 数据来自 Query、Context 还是 Zustand；
- 它的服务端权威来源；
- conversation id 切换时如何 cleanup；
- archived 时如何变化。

如果一个元素同时读三种状态，判断是否应该封装成派生 hook。

## 常见误区

- 在组件中直接调用 API service。
- 把 Query data 复制进 Zustand 后双向同步。
- 把 WebSocket 对象放到全局 store 且不随 route cleanup。
- 在每个按钮重复 archived 判断。
- 把 start task id 直接作为稳定 conversation cache key。

## 自测

1. 为什么 MSW 要在 hydrate 前启动？
2. Query 与 Zustand 各适合什么状态？
3. WebSocket connection 为什么适合 Context？
4. unified hook 在迁移期间解决什么问题？
5. 归档会话为什么采用页面能力分支，而不仅是 disable 按钮？

## 源码定位

- [客户端入口](https://github.com/OpenHands/OpenHands/blob/6b04532541bf2b757d4820d31387b6cba6ffcaea/frontend/src/entry.client.tsx)
- [路由配置](https://github.com/OpenHands/OpenHands/blob/6b04532541bf2b757d4820d31387b6cba6ffcaea/frontend/src/routes.ts)
- [Conversation route](https://github.com/OpenHands/OpenHands/blob/6b04532541bf2b757d4820d31387b6cba6ffcaea/frontend/src/routes/conversation.tsx)
- [API 层规范](https://github.com/OpenHands/OpenHands/blob/6b04532541bf2b757d4820d31387b6cba6ffcaea/frontend/src/api/README.md)
- [创建会话 mutation](https://github.com/OpenHands/OpenHands/blob/6b04532541bf2b757d4820d31387b6cba6ffcaea/frontend/src/hooks/mutation/use-create-conversation.ts)

下一章把 route、WebSocket、历史加载、事件 Store 和聊天 UI 连成一条实时链路。
