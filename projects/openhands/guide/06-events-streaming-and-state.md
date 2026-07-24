# 06. 事件、流式输出与状态：从持久事实到 UI 投影

OpenHands 的“实时感”来自事件，但最难的 bug 也常发生在事件的排序、重复、持久化和投影上。本章把事件分成持久层、传输层和展示层，解释每层为何不能简单共用一个数组。

## 三层事件模型

```text
领域事实层    SDK Event：Message / Action / Observation / State Update ...
传输与存储层  Agent Server WebSocket、App Server EventService、文件/云存储
展示投影层    Zustand events/uiEvents、AgentState、chat cards、metrics
```

同一事实可能以不同形式出现。例如模型文本先以多个 `StreamingDeltaEvent` 传输，最后形成持久 `MessageEvent` 或 `FinishAction`。展示层需要把它们合成一个气泡。

## EventService 抽象

`EventService` 定义：

```python
async def get_event(conversation_id, event_id) -> Event | None: ...
async def search_events(..., page_id, limit) -> EventPage: ...
async def count_events(...) -> int: ...
async def save_event(conversation_id, event): ...
```

它还提供默认 `batch_get_events` 和用于导出的 async iterator。接口显式携带 `conversation_id`，避免只凭 event id 跨会话读取。

## 文件实现怎样组织路径

`FilesystemEventService` 继承 `EventServiceBase`，负责：

- 把 `Event.model_dump_json()` 写入文件；
- 用 `Event.model_validate_json()` 恢复 discriminator 对应的具体类型；
- 搜索目录中的 event files；
- 结合 user id 与 conversation metadata 计算隔离路径。

它适合 OSS 本地部署；配置层可替换为 AWS/GCP 实现。上层 event router 和 callback service 不关心存储后端。

## 查询接口为何支持过滤和分页

事件会非常多，尤其长对话包含每次工具调用和指标更新。`/conversation/{conversation_id}/events/search` 支持：

- `kind__eq`；
- timestamp 范围；
- sort order；
- page id；
- 最大 100 条的 limit。

前端加载历史时要处理多页，导出则用 iterator 避免一次把全部轨迹放进内存。

背景知识：offset pagination 简单但大数据和并发写入时可能不稳定；cursor/page token 更稳定。接口把 token 抽象成字符串，让实现可以演化。

## WebSocket 历史与 REST 历史的竞态

页面打开时常同时发生：

```text
REST/history request ───────────────► 返回旧到新的持久事件
WebSocket connect ──► replay + live ─► 可能先到、可能后到
```

两条路径可能包含相同 id，也可能对 streaming delta 的包含策略不同。因此前端必须：

- 按 id 去重；
- 必要时按 timestamp 排序；
- 丢弃比最新 durable event 更旧的 delta；
- 对 final event 与 preview delta 对账。

没有这些规则，网络时序稍变就会出现重复、倒序或“幽灵思考气泡”。

## `useEventStore` 为什么保存两个数组

核心 state：

```typescript
interface EventState {
  events: OHEvent[];
  eventIds: Set<string | number>;
  uiEvents: OHEvent[];
  addEvent: (event: OHEvent) => void;
}
```

- `events`：尽量接近完整事件，供查找和非聊天视图使用；
- `eventIds`：O(1) 去重索引；
- `uiEvents`：经过 `handleEventForUI` 合并/替换后的展示序列。

将 `Set` 单独存储比每次 `array.some` 更适合长对话；更新时创建新 Set 保持 Zustand/React 的不可变更新语义。

## 连续 delta 怎么合并

逐 token 事件如果每个都保存为数组元素，会导致：

- 数组快速增长；
- React 高频重渲染；
- 聊天气泡碎片化；
- final reconciliation 更复杂。

所以相邻 streaming delta 合并到最后一个元素，保留第一个 delta id：

```text
"我" + "先" + "检查" -> 一个 content="我先检查" 的 delta
```

`uiEvents` 的合并更宽松：中间若夹着 metrics state update，仍把后续 delta 合到最近 delta，因为 metrics 不应切断一条文本流。

## stale delta 判定

`findNewestDurableTimestamp` 只查看 source 为 agent/environment 且不是 delta/metrics 的事件。新 delta 若 timestamp 更早，就丢弃：

```typescript
if (event.timestamp < newestDurableTimestamp) {
  return newUiEvents;
}
```

这是一种领域化 watermark：已经显示了更新的持久事实，就不再接受更旧的预览。

注意不能简单用“数组最后一项 timestamp”，因为最后一项可能是 metrics 或乱序到达的其他事件。

## final event 如何与 delta 对账

对账分三种：

1. final text 以 streamed text 开头：把 final 中未流式到达的 suffix 补到最后 delta；
2. delta segments 能按顺序在 final text 中找到：处理 provider 分块差异；
3. 无法匹配：删除 content preview，显示 durable final event。

第三条最重要：宁可牺牲一点流式连续性，也不能保留错误预览再重复最终结果。最终持久事件是 canonical。

## Action 和 Observation 的替换

当 ActionEvent 到达，它可能自带 thought；此前的 delta 可能正是同一段 thought。UI 会清除重复 content delta。Observation 到达后，按 `action_id` 替换对应 Action。

例外：

- ThinkObservation 不展示，因为内容在 ThinkAction；
- FinishObservation 不展示，因为 FinishAction 已包含消息；
- ACPToolCallEvent 以 `tool_call_id` 折叠 in-progress → completed/failed 状态。

这些都不是通用事件规则，而是“某种卡片如何表示生命周期”的 UI policy。

## 执行状态是另一种投影

`useAgentState` 组合：

- WebSocket 收到的 live execution status；
- Query cache 中 conversation status；
- Sandbox status；
- archived 判定。

优先级中，live WebSocket 状态通常比缓存 API 新；但 `sandbox_status === "MISSING"` 必须让 UI 进入 archived。测试明确验证这些优先级。

这说明不要在多个组件各自写状态判断。集中 hook 才能保证 Chat、Terminal、VS Code 和 Planner 一致。

## Event callback 与 webhook

会话创建时会注册默认 `SetTitleCallbackProcessor`，也可添加其他 processor。Callback service 根据 event kind 处理副作用，如：

- 自动生成/更新会话标题；
- 向外部系统发 webhook；
- 集成平台同步状态；
- 收集指标。

把副作用挂在持久事件上，比塞进 send-message proxy 更一致：无论消息从浏览器、API 还是 Agent Server 直接进入，只要事件产生，处理规则相同。

## 导出 trajectory 的工程问题

导出不是简单 `json.dumps(all_events)`：

- 对话可能很大，需要流式 zip；
- 同一会话要有 export lock；
- 长流要刷新 lock，避免被误认为超时；
- 先验证大小和权限，再发送 response headers；
- 出错要区分 lock unavailable、already running、too large。

这是从“事件很多”自然产生的后台资源管理问题。学习项目时别只关注 happy path。

## 本章实验：手工模拟乱序

写一个小表格，按到达顺序加入：

```text
t=10 delta "修复"
t=12 metrics
t=13 final message "修复完成"
t=11 delta "完成"
```

回答：

1. `events` 是否按 timestamp 重排？
2. final 到达时 UI 如何补 suffix？
3. t=11 delta 最后到达时为何应丢弃？
4. 如果 final id 被 WebSocket replay 和 REST history 各送一次，哪一层去重？

再阅读 `handle-event-for-ui.ts` 的单元测试或为这一顺序补一条 Vitest，是理解算法最有效的方式。

## 常见误区

- 用一个数组同时承担审计事实和聊天展示。
- 认为到达顺序等于事件时间顺序。
- 对所有事件按 timestamp 排序，却忽略同 timestamp 或无 timestamp 的稳定性。
- 让 delta 覆盖 final durable event。
- 以数组线性扫描做每个 token 的去重。

## 自测

1. `events` 和 `uiEvents` 为什么不能合并？
2. metrics event 为什么不切断 streaming delta？
3. stale delta 的 watermark 如何选择？
4. Observation 为什么通过 `action_id` 替换 Action？
5. callback 为什么优于 send-message 中的定制副作用？

## 源码定位

- [EventService 接口](https://github.com/OpenHands/OpenHands/blob/6b04532541bf2b757d4820d31387b6cba6ffcaea/openhands/app_server/event/event_service.py)
- [文件事件服务](https://github.com/OpenHands/OpenHands/blob/6b04532541bf2b757d4820d31387b6cba6ffcaea/openhands/app_server/event/filesystem_event_service.py)
- [事件 HTTP 路由](https://github.com/OpenHands/OpenHands/blob/6b04532541bf2b757d4820d31387b6cba6ffcaea/openhands/app_server/event/event_router.py)
- [Zustand 事件 Store](https://github.com/OpenHands/OpenHands/blob/6b04532541bf2b757d4820d31387b6cba6ffcaea/frontend/src/stores/use-event-store.ts)
- [UI 事件投影算法](https://github.com/OpenHands/OpenHands/blob/6b04532541bf2b757d4820d31387b6cba6ffcaea/frontend/src/utils/handle-event-for-ui.ts)

下一章进入 Sandbox 后端、健康检查、会话 key 与安全边界。
