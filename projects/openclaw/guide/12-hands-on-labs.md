# 12：递进式实战

这些实验从只读追踪逐步进入测试和小改动。每个实验都有交付物与验收标准；不要只执行命令后写“通过”。

## 实验 0：建立可复现阅读环境

时间：30–60 分钟。

### 任务

1. 记录 HEAD、package version、Node/pnpm version。
2. 运行 `pnpm docs:list`；若环境不满足，记录第一个可行动错误。
3. 用 `rg --files` 找出 core、packages、extensions 各三个入口。
4. 阅读根和目标子树 `AGENTS.md`。

### 交付物

```text
snapshot SHA:
runtime:
package manager:
source trust:
scoped guides read:
known environment blockers:
```

### 验收

他人能在相同 SHA 重复你的后续路径；环境失败没有被误写成产品失败。

## 实验 1：比较三条 CLI 启动路径

时间：2 小时。

选择：

```text
openclaw --help
openclaw gateway run
openclaw config get gateway.port
```

### 步骤

1. 从 `openclaw.mjs` 开始；
2. 标记主模块 guard、profile/container 预解析；
3. 判断 help、Gateway fast path、完整 Commander tree 的分叉；
4. 找 action handler 和统一 finalizer；
5. 找至少一个对应测试。

### 交付物

三条五到十步调用链，以及一张“加载模块数量为何不同”的解释图。

### 验收

每一跳都有真实符号；能说明为何 `gateway call` 不走前台 fast path。

## 实验 2：实现一个只读协议帧解码器

时间：2–3 小时。

不要修改生产协议。可以在临时笔记或测试文件中写一个函数：

```ts
function describeFrame(frame: GatewayFrame): string {
  switch (frame.type) {
    case "req":
      return `request ${frame.id}: ${frame.method}`;
    case "res":
      return `response ${frame.id}: ${frame.ok}`;
    case "event":
      return `event ${frame.event}`;
    default:
      return assertNever(frame);
  }
}
```

### 扩展任务

用 runtime validator 分别检查：合法 request、额外顶层字段、合法 envelope 但非法 method params。

### 验收

能解释 envelope validation 与 method-specific validation 的区别；第四种 union member 会触发穷尽错误。

## 实验 3：追踪配置 source/runtime 差异

时间：3 小时。

设计一份临时 JSON5 fixture，包含：

- 注释和尾逗号；
- 一个 `$include`；
- `env.vars`；
- `${VAR}`；
- 一个运行时默认字段未显式设置。

### 步骤

1. 从 `readConfigFileSnapshotWithPluginMetadata` 进入；
2. 标记 parse/include/env/migration/validation/materialize；
3. 对比 raw、parsed、sourceConfig、runtimeConfig；
4. 构造并发改写情景，解释 base hash 冲突；
5. 找无效 Agent binding 的 schema issue。

### 验收

不会把 runtime defaults 写回 source；能指出旧 key 迁移为何不属于 steady-state runtime。

## 实验 4：验证 Channel kernel 短路

时间：3–4 小时。

参考 `src/channels/turn/kernel.test.ts`，构造最小 fake adapter，覆盖：

```text
ingest -> null
classify -> canStartAgentTurn=false
preflight -> drop
resolve -> dispatch
```

### 断言

- 每条路径的 admission/result；
- 后续方法调用次数为 0；
- drop history 仅在策略要求时记录；
- finalize 在成功和错误路径的行为。

### 验收

测试保护阶段不变量，而不是只验证返回值。

## 实验 5：画出 Agent 两层循环

时间：4–6 小时。

阅读模块 6 后完成。要求分别画：

1. 外层 attempt loop：模型候选、恢复、压缩、重试、终态；
2. 内层 model/tool loop：prompt → model stream → toolUse → toolResult → next model call。

### 场景推演

- 模型返回纯文本；
- 模型请求两个工具；
- 工具失败但允许模型处理错误；
- context overflow 触发 compact/retry；
- abort 与 timeout 竞争。

### 验收

每种状态明确由哪层拥有；不把 fallback candidate 误画成模型的一次 tool iteration。

## 实验 6：Plugin registration mode 表

时间：3 小时。

以 Telegram entry 为样本，为以下 mode 填表：

```text
setup-only
tool-discovery
setup-runtime
discovery
full
```

列：manifest 是否已读、runtime module 是否导入、channel sidecar、secret contract、runtime setter、full registration、网络是否可启动。

### 验收

对照 `src/plugin-sdk/channel-entry-contract.test.ts` 修正；解释为什么 register 必须同步。

## 实验 7：Telegram 崩溃窗口

时间：4–6 小时。

画出 webhook 和 polling 两条时序图，然后在以下点放置 `process crash`：

1. update 到达但未 spool；
2. spool commit 后、transport ack 前；
3. claim 后、adoption 前；
4. adoption 后、模型前；
5. native reply accepted 后、最终观察前。

### 交付物

每个窗口写：平台是否重发、queue 是否 replay、Agent 是否可能重复、reply 是否可能重复、哪个 id 用于去重。

### 验收

结论与 `telegram-ingress-worker.runtime.test.ts`、`polling-session.test.ts`、`ingress-drain.test.ts` 一致。

## 实验 8：SQLite 短事务设计

时间：3–4 小时。

需求：“外部插件给出任务是否可执行的判断，若仍未被其他 worker 领取则更新为 running。”

### 错误版本

在 transaction callback 内 await 插件。

### 正确版本

```text
事务外：加载配置/调用插件/准备 plan
事务内：重读 task owner/status/version
       -> 检查仍适用
       -> 原子 update
事务后：触发异步副作用
```

### 验收

写出两个竞争用例、rollback 断言，以及为何事务回调返回 Promise 会被底层拒绝。

## 实验 9：从实现找最佳修复边界

时间：半天。

假设问题：“群组 thread 的最终回复偶尔发到父频道”。不要马上改代码。

### 证据图

```text
changed/observed surface:
entry:
owner:
caller:
callee:
sibling channels:
tests:
official docs contract:
```

### 候选方案

至少比较：

- Telegram 出站临时特判；
- 通用 `ReplyPlanFacts` 缺失 thread fact；
- route/session 装配错误；
- native encoding 错误。

### 验收

用证据排除至少两个候选，并说明最终 owner；不能因为某个文件最容易改就选择它。

## 实验 10：一个安全的小改动

时间：1 天。

选择以下之一：

- 为一个纯 helper 补边界测试；
- 改善一个非显然 invariant 的内联注释；
- 修正文档与现有源码不一致；
- 删除一个已证明无 caller 的内部死 helper；
- 为一个现有 schema 错误补更精确测试。

### 流程

1. 建 evidence map；
2. 读 scoped `AGENTS.md`；
3. 写预期失败/保护测试；
4. 实现 clean bounded fix；
5. 运行 focused proof；
6. `git diff --check`；
7. 按风险运行 changed check/build；
8. code change 运行 fresh autoreview；
9. 写验证报告。

### 验收

diff 中没有无关格式化或兼容 shim；测试能在回退实现后失败；说明 sibling 为何不受影响。

## 结业项目：一条消息的可执行讲解

选择 Telegram 的一条普通文本、一个 command 或一个 callback，制作完整材料：

```text
1. 原生输入 fixture（去除 token/个人数据）
2. transport ack
3. durable record 与 lane
4. portable facts
5. route/session
6. prompt/context
7. Agent 外层/内层 loop
8. tool（若有）
9. reply payload
10. native send + receipt
11. terminal outcome
12. crash/retry 窗口
13. 对应测试
```

交付形式可以是 Markdown + Mermaid + 聚焦测试输出。禁止包含真实 token、私聊内容、个人 id 或完整模型 transcript。

结业标准：一个不熟悉 Telegram 实现的维护者能用你的材料定位每个 owner，并复现至少一个测试。
