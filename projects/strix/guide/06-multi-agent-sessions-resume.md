# 06. 多 Agent 编排、会话与恢复

Strix 的多 Agent 不是简单地“同时调用几次模型”。它需要可寻址身份、父子拓扑、消息投递、状态机、独立对话历史和进程重启后的恢复。本章沿这些责任逐一解释。

## 1. Coordinator 是单一图状态所有者

[`AgentCoordinator`](../../strix/core/agents.py) 维护：

```python
self.statuses: dict[str, Status]
self.parent_of: dict[str, str | None]
self.names: dict[str, str]
self.metadata: dict[str, dict[str, Any]]
self.pending_counts: dict[str, int]
self.runtimes: dict[str, AgentRuntime]
```

字段含义：

- `statuses`：业务生命周期状态。
- `parent_of`：树边；根 Agent 的 parent 是 `None`。
- `names`：人类可读名，ID 才是真正地址。
- `metadata`：恢复子 Agent 所需的 task 和 skills。
- `pending_counts`：会话末尾有多少条尚未消费的外部消息。
- `runtimes`：当前进程中的 Session、Task、Stream、wake Event。

前五项可快照；`asyncio.Task`、网络 stream、Event 无法跨进程序列化，因此 `AgentRuntime` 只存在内存中，恢复时重新构造。

## 2. ID、名称与父子关系

新根 Agent 和子 Agent 都使用 `uuid.uuid4().hex[:8]` 作为 ID。名称可以重复，消息必须使用 ID。

注册子 Agent：

```python
await coordinator.register(
    child_id,
    name,
    parent_id,
    task=task,
    skills=skills,
)
```

`register()` 把初始状态设为 `running`，创建空 runtime，然后立即尝试写快照。这样即使模型还没开始响应，拓扑已经可恢复/可观察。

## 3. 状态机

```text
                  工具/消息开始处理
        ┌─────────────────────────────────┐
        ▼                                 │
     running ── wait_for_message ──> waiting
        │  │                             │
        │  └── 异常 ──> failed/crashed  └── 消息到达 ──> running
        │
        ├── stop_agent/预算 ──> stopped
        └── lifecycle tool ──> completed
```

`failed` 通常表示 SDK/API 可识别错误，`crashed` 表示未分类意外异常。`stopped` 是显式停止、最大轮次或预算停止。消息可以唤醒已注册 Agent；交互产品因此能对 parked 或终态 Agent 发送新的 instruction，但业务调用者必须清楚这是“继续该身份的旧会话”，不是创建全新 Agent。

## 4. 子 Agent 的创建链

从模型工具调用到异步任务的完整链：

```text
create_agent 工具
  -> 从 ctx 取 spawn_child_agent callback
  -> runner 内部 closure
  -> execution.spawn_child_agent()
  -> factory(name, skills) 创建 SandboxAgent
  -> coordinator.register()
  -> child_initial_input()
  -> _start_child_runner()
  -> asyncio.create_task(_child_loop())
```

为什么 `create_agent` 工具不直接 import 并调用 Runner？因为工具只应描述业务动作。Runner 把一个闭包放进 context，闭包已经捕获 `RunConfig`、agents DB 路径、沙箱、hook、interactive 等执行细节。

## 5. 子 Agent 的继承上下文

`create_agent(..., inherit_context=True)` 取 `ctx.turn_input`，传给 [`child_initial_input()`](../../strix/core/inputs.py)。该函数：

1. 用 `scrub_images_from_items()` 把父历史中的图片替换成文本占位符。
2. JSON 序列化为“background only”区块。
3. 附加子 Agent 身份、父 ID 和必须调用 `agent_finish` 的规则。
4. 附加具体 task。
5. 把所有内容合成**一条** user message。

合成一条消息是为了兼容要求 user/assistant 严格交替的 provider，避免连续 user message 被拒绝。

继承的是当前 turn input，不是父 Agent 整个数据库的无限复制；图片被清理可减少上下文体积和 provider 拒绝。

## 6. `run_agent_loop()` 的两种模式

### 非交互模式

调用 `_run_noninteractive_until_lifecycle()`，它反复执行 `_run_cycle()`，直到 Coordinator 状态不再是 `running`。

如果模型输出普通最终文本，却没调用 `finish_scan`/`agent_finish`：

1. 记录 warning 和输出预览。
2. 向 Session 追加一条强制 lifecycle tool 的 user message。
3. 再运行一个 cycle。
4. 尝试次数用尽后标记 crashed 并抛 `MaxTurnsExceeded`。

这样 headless CI 不会因为模型“礼貌地总结了一段文字”就静默产生不完整报告。

### 交互模式

先执行一个 cycle。若普通一轮结束且状态仍是 running，`_settle_run_result()` 将其改为 waiting。外层循环等待消息：

```python
await coordinator.wait_for_message(agent_id)
await coordinator.consume_pending(agent_id)
result = await _run_cycle(..., input_data=[])
```

新消息已经直接写进 Session，所以 `input_data=[]` 即可让 SDK 回放会话并看到它。

## 7. `_run_cycle()` 是模型流的故障边界

每个 cycle：

1. 标记 Agent running。
2. 对 Session 执行图片预算清理。
3. `Runner.run_streamed(...)` 创建 SDK stream。
4. 把 stream 挂到 Coordinator，供消息中断或 stop 使用。
5. 遍历 `stream.stream_events()`，转发给 TUI event sink。
6. 检查 SDK 在流尾保存的异常。
7. 最终 detach stream。

异常策略按类型和模式区分：

- `BudgetExceededError`：标记 stopped，触发全局 budget stop，再抛出。
- 输入被 400/404/422 拒绝且 Session 含图片：最多三次清除图片后重试。
- 非交互：一般异常继续向上抛，由顶层决定结束。
- 交互：Max turns -> stopped；SDK/API 用户错误 -> failed；其他 -> crashed，然后 park/通知父 Agent。
- 沙箱正在 teardown 时出现容器 NotFound/transport error 可忽略，避免清理竞态伪装成扫描失败。

## 8. 消息怎样投递

`AgentCoordinator.send()` 不是维护独立 inbox 队列，而是把消息转换成 SDK user item，直接追加到目标 Session：

```python
{
    "role": "user",
    "content": "[Message from ...] ...",
}
```

步骤：

1. 在锁内读取目标 runtime/session/stream。
2. 释放 Coordinator 锁。
3. 获取 `session_write_lock(session)` 后 `session.add_items()`。
4. 在 Coordinator 锁内增加 pending count、设置 wake Event。
5. 若交互模式目标正在 streaming，`stream.cancel(mode="immediate")`，让下一 cycle 尽快看到消息。
6. 保存快照。

不要在持有 Coordinator 锁时等待 Session I/O，否则其他 Agent 的状态更新都会被堵住。

## 9. 等待消息的 Event 模式

`wait_for_message(agent_id)` 循环检查：

- 已触发 budget stop：立即返回。
- pending count > 0：立即返回。
- 否则清空该 Agent 的 `wake` Event，然后 `await wake.wait()`。

先在同一把锁内“检查条件 + clear event”，避免消息恰好在检查后、clear 前到达而丢失唤醒。

工具层的 `wait_for_message` 还区分：

- 已有 pending：直接返回消息。
- interactive：标 waiting 后立即返回特殊 waiting 结果，由外层循环 park。
- non-interactive：在工具内部用 `asyncio.wait_for(..., timeout_seconds)` 真正阻塞，超时后恢复 running。

## 10. 完成通知

子 Agent 调用 `agent_finish`：

1. 确认当前不是根 Agent。
2. 生成包含身份、task、summary、findings、recommendations 的文本报告。
3. 通过 Coordinator 发到父 Session。
4. 把自己设为 completed。
5. 返回 `{agent_completed: true}`，触发 Agent tool-use 终止。

这里的 `findings` 是叙述性摘要，不会创建漏洞记录。真实漏洞必须先调用 `create_vulnerability_report` 或 `create_dependency_report`。

根 Agent 的 `finish_scan` 会先查询 `active_agents_except(me)`；仍有 running/waiting 子 Agent 时拒绝完成，防止孤儿工作被丢弃。

## 11. SQLite Session 与写锁

[`open_agent_session()`](../../strix/core/sessions.py) 返回：

```python
SQLiteSession(session_id=agent_id, db_path=agents_db_path)
```

所有 Agent 共享数据库文件，但按 session ID 分隔历史。TUI 读取底层 `agent_messages` 表来重建事件。

为什么需要额外 `session_write_lock`？SDK 正常 run loop 会写 Session，同时以下操作也可能在循环外改写：

- Agent/用户消息注入。
- 图片清理与 context budget 重写。
- 恢复时追加新 instruction。

`WeakKeyDictionary[Session, asyncio.Lock]` 让锁生命周期跟随 Session，不造成长期引用泄漏。

## 12. 图片预算与失败恢复

截图是大上下文来源。`enforce_image_budget(session, max_images)`：

- 找到 `function_call_output` 中的 `input_image` block。
- 只保留最近 N 个。
- 更老的图片 block 替换为文字，保留同一 output 中其他文本 block。

`strip_all_images_from_session()` 用于 provider 拒绝图片后的恢复，替换全部图片。

重写会话采用事务式思路：先读取和转换，清空后写新 items；若写入失败，清空并恢复 original items，然后重新抛错。

## 13. 两份恢复状态

### `.state/agents.json`

Coordinator 的结构化快照：statuses、parent_of、names、metadata、pending_counts。写入使用同目录临时文件 + `replace()`，避免进程中断留下半个 JSON。

### `.state/agents.db`

SDK 完整会话历史。没有它，即使知道 Agent 拓扑，也无法让模型继续先前对话。

恢复条件因此同时要求两者存在。

## 14. 恢复算法

`run_strix_scan()` 看到 `agents.json` 后：

1. 解析快照并 `coordinator.restore()`。
2. 找 parent 为 `None` 的 root ID。
3. 验证 `agents.db` 存在。
4. 创建新的 Docker sandbox；容器本身不恢复。
5. 用相同 ID 打开根 Session。
6. `respawn_subagents()` 重新创建 Agent 对象、Session handle 与 asyncio Task。
7. 根初始输入设为 `[]`，依赖 Session replay。
8. 如果本次 `--resume` 带新 instruction，通过 `coordinator.send()` 写进根 Session。

非交互恢复只重启 running/waiting 子 Agent；交互恢复可重建更多已注册身份并根据旧状态先 park，等待用户需要时再唤醒。

注意 Docker 内临时文件、进程和网络状态不会恢复。可恢复的是 Agent 对话和拓扑，不是完整容器 checkpoint。

## 15. 本章实验

```bash
uv run pytest \
  tests/test_execution.py \
  tests/test_session_entries.py \
  tests/test_runner_root_prompt.py \
  tests/test_runner_rate_limit.py -q
```

再运行 Coordinator 的最小实验：

```bash
uv run python - <<'PY'
import asyncio
from strix.core.agents import AgentCoordinator

async def main():
    c = AgentCoordinator()
    await c.register("root", "strix", None)
    await c.register("child", "recon", "root", task="map endpoints")
    print(await c.snapshot())
    await c.set_status("child", "completed")
    print(await c.graph_snapshot())

asyncio.run(main())
PY
```

## 16. 自测题

1. `agents.json` 与 `agents.db` 缺一会分别失去什么？
2. 为什么消息直接写入 Session，还要维护 `pending_counts`？
3. 为什么 `send()` 不能一直持有 Coordinator lock 再写 SQLite？
4. non-interactive 模式如何防止纯文本“假完成”？
5. 恢复扫描为什么必须重新创建 Docker 容器？哪些状态因此不会恢复？

