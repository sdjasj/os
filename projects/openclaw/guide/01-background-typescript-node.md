# 01：TypeScript、Node.js 与协议背景

本章只补阅读 OpenClaw 源码真正需要的背景。重点不是语言语法大全，而是这些概念怎样影响架构判断。

## 1. ESM：文件路径和模块加载都是运行时问题

仓库的 `package.json` 使用：

```json
{
  "type": "module"
}
```

这意味着 `.js` 默认按 ECMAScript Module 解释。TypeScript 源码中常见：

```ts
import { fileURLToPath } from "node:url";
import { normalizeEnv } from "./infra/env.js";

const currentFile = fileURLToPath(import.meta.url);
```

注意源码文件是 `.ts`，相对 import 却写 `.js`。这是 Node ESM 与编译产物的契约：编译后真正存在的是 `.js`。`tsconfig.json` 的 `module` 与 `moduleResolution` 都使用 `NodeNext`，让 TypeScript 按 Node 的 ESM 规则解析。

阅读时要区分：

- **静态 import**：模块初始化时装载，适合基础依赖；
- **动态 `import()`**：执行到该分支才装载，适合 CLI 快路径、插件和较重运行时；
- **类型 import**：`import type` 只参与编译检查，不制造运行时依赖。

例如 [`src/entry.ts`](../../../src/entry.ts#L203-L217) 直到确实需要完整 CLI 时才加载 `./cli/run-main.js`：

```ts
const { runCli } = await gatewayEntryStartupTrace.measure(
  "run-main-import",
  () => import("./cli/run-main.js"),
);
await runCli(argv);
```

这不是语法炫技，而是启动性能和副作用控制：`--help`、`--version` 等短路径不必初始化整个运行时。

## 2. Monorepo：路径同时表达所有权

[`pnpm-workspace.yaml`](../../../pnpm-workspace.yaml) 定义了根包、`ui`、`packages/*`、`extensions/*` 和示例工作区。理解它们的依赖方向比记住包名更重要：

```text
核心 src/**
  -> 通用 package / 明确的内部模块

插件 extensions/<id>/**
  -> openclaw/plugin-sdk/*
  -> 插件自己的依赖

公共 package
  -> 尽量独立、可复用的契约或实现
```

OpenClaw 的架构规则把目录当作所有权边界：插件生产代码不能深度 import 核心 `src/**`，核心也不应把某个插件 id 或频道策略硬编码进去。看到一个相对 import 时，要问：

1. 依赖方向是否从具体实现指向稳定抽象？
2. 这个依赖应属于根包还是插件本地包？
3. 是否已有 Plugin SDK barrel 可以表达需要的能力？

## 3. 静态类型和运行时验证不是一回事

TypeScript 只能检查参与编译的代码。下列输入在运行时到来，不能相信类型标注：

- `openclaw.json` / JSON5 配置；
- WebSocket 帧；
- 插件 manifest；
- 环境变量；
- 频道 webhook；
- 模型产生的工具参数。

所以仓库同时使用静态类型和 runtime schema。Gateway 顶层帧在 [`packages/gateway-protocol/src/schema/frames.ts`](../../../packages/gateway-protocol/src/schema/frames.ts#L155-L197) 中用 TypeBox 定义：

```ts
export const RequestFrameSchema = closedObject({
  type: Type.Literal("req"),
  id: NonEmptyString,
  method: NonEmptyString,
  params: Type.Optional(Type.Unknown()),
});

export const GatewayFrameSchema = Type.Union(
  [RequestFrameSchema, ResponseFrameSchema, EventFrameSchema],
  { discriminator: "type" },
);

export type GatewayFrame = Static<typeof GatewayFrameSchema>;
```

这里让一个定义承担两件事：

- runtime validator 能拒绝非法帧；
- `Static<...>` 推导 TypeScript 类型，减少 schema 和类型漂移。

`type` 是判别字段。拿到 `GatewayFrame` 后，判断 `frame.type === "req"`，TypeScript 就能把其余字段缩窄到请求帧。

配置层常用 Zod，协议层常用 TypeBox。不要简单地把它们理解成重复工具：不同边界可能需要不同的代码生成、JSON Schema、错误报告或 SDK 输出能力。

## 4. 判别联合：用状态形状代替异常猜测

[`packages/normalization-core/src/result.ts`](../../../packages/normalization-core/src/result.ts) 定义了最小 `Result`：

```ts
export type Result<TValue, TError> = { ok: true; value: TValue } | { ok: false; error: TError };
```

消费者必须先检查 `ok`：

```ts
const parsed = parseInput(raw);
if (!parsed.ok) {
  return report(parsed.error);
}
useValue(parsed.value);
```

它适合“预期会失败的二元操作”，例如解析或验证。相比抛异常，它让失败成为函数签名的一部分；相比 `{ value?, error? }`，它不允许“两个都没有”或“两个都有”的含糊状态。

但不是所有结果都应压成 `Result`。一个业务过程若有 `completed`、`timed_out`、`cancelled`、`failed` 等语义丰富的终态，具名判别联合更清楚。读代码时先看状态空间，再判断抽象是否匹配。

## 5. `async`、事件循环与取消

Node 在单线程 JavaScript 执行栈上协调大量异步 I/O。`await` 会暂停当前 async 函数，但不会冻结整个进程：WebSocket 事件、计时器、其他会话和网络响应仍可继续。

这带来三个常见误区。

### 误区一：`await` 自动保证串行

只有同一调用链上的 `await` 才保证顺序。两个独立事件同时调用同一个 async 函数，仍可能并发修改共享状态。OpenClaw 因此使用 session lane、global lane、队列和数据库事务表达串行边界。

### 误区二：超时会自动停止底层工作

`Promise.race([work, timeout])` 只决定谁先返回，未必取消 `work`。真正取消通常需要 `AbortSignal`、底层库的取消 API，以及终态合并规则。

### 误区三：事务回调可以随便 `await`

OpenClaw 的 SQLite 写事务要求同步提交段。异步规划、文件访问、插件 hook 和网络 I/O 必须在 `BEGIN` 前完成；事务内重新读取权威行、验证并写入。模块 10 会看到运行时如何拒绝返回 Promise 的事务回调。

## 6. 事件、请求和流

Gateway 协议有三种顶层帧：

```text
req(id, method, params)  ----->
                         <----- res(id, ok, payload/error)
                         <----- event(name, payload, seq?)
```

- request/response 用相同 `id` 配对，适合一次 RPC；
- event 不对应单一请求，适合 agent stream、presence、状态更新；
- `seq` 和 `stateVersion` 帮助客户端理解顺序和状态版本。

Agent 输出也不是“一次返回字符串”。模型 token、assistant 文本、工具开始/结束、生命周期和最终结果可能沿不同事件流出现。读异步代码时，要明确：

- 谁创建订阅；
- 谁消费事件；
- 谁拥有完成条件；
- 超时和取消如何与正常完成合并；
- 订阅何时释放。

## 7. 依赖注入与 prepared facts

大型系统常见两种写法：

```ts
// 隐式发现：函数内部重新扫描配置、插件和环境
async function send(message: Message) {
  const channel = await discoverChannel(message.channelId);
  // ...
}

// 显式准备：上游解析一次，下游复用已验证事实
async function send(prepared: PreparedDelivery) {
  await prepared.channel.deliver(prepared.target, prepared.payload);
}
```

OpenClaw 的热路径倾向第二种。provider id、model ref、channel id、target、capability、attachment class 等事实应尽早解析并携带下去，避免请求期间重复扫描 manifest、配置或文件系统。

测试也因此更容易：把 runtime helper 或 adapter 作为参数注入，就能用 fake 验证编排，而不必启动整个系统。

## 8. SQLite 与 Kysely 的最小背景

SQLite 是嵌入式关系数据库：数据库通常就是一个文件，但它仍提供表、索引、事务、约束和恢复机制。它比 JSON sidecar 更适合并发状态、原子更新和可迁移 schema。

Kysely 是类型化查询构建器。OpenClaw 的运行时访问原则是：

- 一般读写通过 Kysely helper；
- DDL、迁移、底层 bootstrap 等有限场景可以使用原始 SQL；
- 写事务保持同步、短小；
- 全局状态与每 Agent 状态分库所有权明确。

先记住 ACID 中最相关的两个字母：

- **A，Atomicity**：事务内的一组写入要么全部成功，要么全部回滚；
- **I，Isolation**：并发操作不应观察到彼此的半成品。

## 9. 编译、运行和发布产物

源码中的 `.ts` 不是最终 npm 用户直接执行的形态。通常要区分：

```text
源码 checkout：src/**, extensions/**, packages/**
构建产物：dist/**
包入口/exports：package.json
启动 wrapper：openclaw.mjs
```

一个改动若涉及动态 import、public export、插件 SDK 或打包边界，单元测试通过还不够，往往需要 build 或 surface check。反过来，纯文档或局部纯函数没有必要一上来跑完整构建。

## 10. 本章练习

### 练习 A：判别联合

打开 `packages/gateway-protocol/src/schema/frames.ts`，为三种 frame 写伪代码处理器。要求每个分支只能访问该类型合法的字段，并有穷尽检查。

验收：新增第四种 frame 时，编译器能提醒你的处理器未覆盖。

### 练习 B：动态 import

在 `src/entry.ts` 和 `src/cli/run-main.ts` 中各找三个动态 import，记录它们推迟加载的理由：启动速度、可选依赖、平台差异、插件发现，还是循环依赖隔离。

验收：每个理由都有 caller 路径或测试支持，不能只凭文件名猜。

### 练习 C：边界分类

把以下输入分为“编译期可信”和“必须 runtime 验证”：函数内部局部对象、WebSocket JSON、环境变量、配置文件、已由 validator 返回的对象、Telegram update。

验收：能解释“验证发生过一次后，为什么下游不应重复猜测”。

## 11. 继续阅读

下一章从真实启动器开始，把 ESM、动态加载、运行时约束和命令路由串成一条执行链。
