# 03：CLI、配置与运行时快照

配置看起来只是“读一个 JSON 文件”，但在 OpenClaw 中它同时跨越文件、环境变量、插件 schema、运行时默认值、写回并发和 Gateway 生命周期。本章把这些阶段分开。

## 1. 先区分五种配置形态

```text
文件原文 raw text
  -> JSON5 parsed object
  -> include/env/legacy 解析后的 source config
  -> schema + plugin 校验后的 validated config
  -> 默认值、overlay、注册表参与后的 runtime config
```

另有 `ConfigFileSnapshot` 记录一次读取的证据，包括 path、是否存在、raw、parsed、sourceConfig、runtimeConfig、hash、issues、warnings 等。

为什么要保留这些形态？因为它们服务不同任务：

- 展示和诊断需要知道用户实际写了什么；
- runtime 只应消费当前规范形态；
- 写回时不能把运行时默认值全部展开到用户文件；
- 并发写要知道 base snapshot 是否仍然有效；
- doctor 迁移要面对原始旧形态，而不是给 runtime 加永久兼容分支。

## 2. 同步加载入口与 pinned snapshot

[`src/config/io.runtime.ts`](../../../src/config/io.runtime.ts#L88-L107) 的公共入口很短：

```ts
export function loadConfig(options?): OpenClawConfig {
  const loadFresh = () => createConfigIO(/* options */).loadConfig();
  return options?.pin === false ? loadFresh() : loadPinnedRuntimeConfig(loadFresh);
}
```

默认 `pin` 的含义是：同一运行时生命周期复用稳定的配置快照，而不是每个热路径调用都重新读文件、扫描插件、应用环境替换。

这是一个重要的系统不变量：配置/manifest/插件 metadata 通常是进程稳定事实；改变它们应由明确 reload、install、doctor 或 restart owner 管理。请求路径中的“顺手重读”会造成：

- 同一请求的不同阶段看到不同配置；
- 重复文件 I/O 和 schema 扫描；
- 缓存与认证策略不同步；
- 测试出现时序依赖。

只有确实需要新鲜读取的控制面操作，才使用相应 snapshot API 或 `pin: false`，并承担一致性责任。

## 3. `loadConfigFromContext` 的完整管线

主实现位于 [`src/config/io.load.ts`](../../../src/config/io.load.ts#L34-L212)。按职责可拆成八段。

### 3.1 建立环境基线

```ts
maybeLoadDotEnvForConfig(deps.env);
envBeforeRead = snapshotEnv(deps.env);
```

配置解析可能向环境投影变量。先做快照，失败时才能只恢复本次读取造成的变化。

### 3.2 文件不存在

若配置文件不存在，加载器可按策略补 shell 环境，然后返回当前规范的空配置投影。这里仍调用 roster migration/materialization，而不是给 caller 一个特殊 `undefined` 世界。

### 3.3 解析原文、include 和环境替换

```ts
const raw = deps.fs.readFileSync(configPath, "utf-8");
const parsed = deps.json5.parse(raw);
const readResolution = resolveConfigForRead(
  resolveConfigIncludesForRead(parsed, configPath, deps),
  deps.env,
  deps.lowerPrecedenceEnv,
);
```

顺序很重要：先得到 JSON5 对象，解析 includes，再基于明确优先级处理环境。环境缺失会生成 warning，使依赖该值的功能不可用，而不是把 `${NAME}` 当成真实 secret 使用。

### 3.4 旧形态迁移与误拼提示

```ts
const rosterMigration = migratePersistedImplicitMainRoster(readResolution.resolvedConfigRaw);
warnOnConfigMiskeys(validationConfigRaw, deps.logger);
```

迁移发生在原始/源配置边界。核心 runtime 不应到处写“如果新 key 没有就再看旧 key”。正式升级修复应归 doctor/migration owner，迁移后 runtime 只处理当前形态。

### 3.5 跨字段与插件校验

加载器先检查重复 Agent 目录，再准备 plugin metadata snapshot，最后调用：

```ts
validateConfigObjectWithPlugins(validationConfigRaw, {
  env: deps.env,
  pluginValidation: context.options.pluginValidation,
  loadPluginMetadataSnapshot: pluginMetadata.load,
  sourceRaw: snapshotParsed,
});
```

这说明插件配置不是核心 schema 中硬编码所有插件 id；控制面通过 manifest metadata 参与验证。

### 3.6 无效配置也形成 snapshot

验证失败时，加载器先记录 `valid: false`、issues、warnings 和 hash，再抛 `INVALID_CONFIG`。因此诊断工具能解释失败输入，而不只收到一条丢失上下文的异常。

### 3.7 materialize runtime config

校验成功后，`materializeConfigForLoad` 加入运行时默认、overlay 和投影，随后同时保存 source 与 runtime 两种视图。

### 3.8 失败时恢复环境

catch 分支调用 `restoreEnvChangesIfUnchanged`。名字中的 `IfUnchanged` 很关键：若其他 owner 已经修改某变量，恢复逻辑不能粗暴覆盖它。

## 4. Schema 不只检查字段类型

[`src/config/zod-schema.ts`](../../../src/config/zod-schema.ts#L17-L96) 使用 `z.strictObject`，未知根字段不会被静默接受。`superRefine` 再检查跨字段关系，例如 binding 引用的 Agent 必须存在：

```ts
if (typeof agentId === "string" && !effectiveAgentIds.has(normalizeAgentId(agentId))) {
  ctx.addIssue({
    path: ["bindings", idx, "agentId"],
    message: `Unknown agent id "${agentId}" ...`,
  });
}
```

这类错误不能只靠字段 schema 发现，因为单独看 `agentId`，任何字符串都合法；只有结合 `agents.entries` 才知道引用是否有效。

源码注释还解释了为什么先 normalize id：路由会把类似 `Team Ops` 规范化为 `team-ops`，配置验证必须匹配同一语义，否则会拒绝运行时实际可路由的配置。

## 5. raw validation 与 runtime materialization

[`src/config/validation-core.ts`](../../../src/config/validation-core.ts#L259-L346) 有两个容易混淆的入口：

- `validateConfigObjectRaw`：验证但不应用 runtime defaults，适合写回；
- `validateConfigObject`：先处理规范迁移，再 materialize runtime config。

raw validator 在 Zod 之后还检查：

- secret reference policy；
- bundled channel config；
- 重复 Agent 目录；
- avatar；
- Gateway Tailscale bind/auth 组合；
- model policy allow list。

因此“Zod safeParse 成功”不等于完整配置有效。验证是由多个 owner 共同形成的决策面。

## 6. 读取 API 按意图区分

[`src/config/io.runtime.ts`](../../../src/config/io.runtime.ts#L109-L238) 暴露多组入口：

| API                                           | 用途                                          |
| --------------------------------------------- | --------------------------------------------- |
| `loadConfig` / `getRuntimeConfig`             | runtime 读取，默认 pinned                     |
| `readBestEffortConfig`                        | 诊断式尽力读取                                |
| `readConfigFileSnapshot`                      | 获取完整文件读取证据                          |
| `readConfigFileSnapshotWithPluginMetadata`    | 写入/控制面需要统一配置与插件 metadata        |
| `readConfigFileSnapshotForRuntimeTransaction` | 基于当前 active source config 的 runtime 事务 |
| `readConfigFileSnapshotForWrite`              | 准备安全写回和冲突检测                        |

选择 API 时先写出意图。不要为了“拿到 config”随便挑一个名称最短的函数。

## 7. 写配置为什么不是 `writeFile`

[`writeConfigFile`](../../../src/config/io.runtime.ts#L241-L285) 先检查写权限和 owner，然后处理 source/runtime 差异：

```ts
const runtimePatch = createMergePatch(runtimeConfigSnapshot, cfg);
nextCfg = coerceConfig(applyMergePatch(runtimeConfigSourceSnapshot, runtimePatch));
```

假设 runtime 默认给某字段值 `x`，用户文件根本没写它。若把完整 runtime object 序列化，会把大量默认值固化进配置，未来默认调整也无法生效。这里计算“调用者相对 runtime 改了什么”，再把 patch 应用到 source snapshot。

随后它读取 base snapshot、运行 preflight，并借助 hash/owner 检测写入期间的竞争。控制面配置写是事务式流程：

```text
读 base snapshot
  -> 计算 candidate
  -> schema/plugin/runtime preflight
  -> 确认文件未被并发改写
  -> 原子写
  -> 激活/通知 owner
```

## 8. CLI config 命令只是控制面入口

`openclaw config ...` 并不拥有所有配置语义。CLI 负责解析用户意图和展示结果，schema/ConfigIO/doctor/runtime owner 才拥有验证、迁移和激活规则。

追踪具体命令时使用：

```bash
rg -n "config (get|set|unset)|register.*Config|configHandlers" src/cli src/gateway
rg -n "writeConfigFile|readConfigFileSnapshotForWrite" src --glob '*.ts'
```

同一个配置操作可能经 CLI 本地执行，也可能通过 Gateway RPC 执行。比较二者是否最终进入同一 owner，而不是只看 UI/CLI 表层。

## 9. 配置兼容性的原则

阅读或设计配置改动时，使用以下判断表：

| 情况                        | 正确位置                     |
| --------------------------- | ---------------------------- |
| 当前规范配置的默认值        | schema/materialization owner |
| 已发布旧 key 升级           | doctor/migration             |
| 插件私有旧配置              | 插件 doctor contract         |
| runtime 每次读取旧 key 兜底 | 通常不应存在                 |
| 拼写错误或未知 key          | strict validation / 诊断     |
| 新环境变量                  | 先证明现有行为/配置无法表达  |

“为了兼容先都支持”会让每条热路径永久承担历史。兼容必须对应明确的已发布契约和迁移/移除计划。

## 10. 本章练习

### 练习 A：追踪一个字段

选择 `gateway.auth.mode`，从 config type/schema 开始，找到 help/metadata、加载后的使用者、写入入口和测试。

验收：画出 source value、runtime value 和消费位置，注明默认值由谁提供。

### 练习 B：解释 snapshot

阅读 `ConfigFileSnapshot` 定义及创建 helper，回答 raw、parsed、sourceConfig、runtimeConfig、hash 各自在失败诊断和安全写回中的作用。

验收：构造“读取后用户手工编辑文件、随后旧 UI 保存”的场景，说明系统为什么需要冲突检测。

### 练习 C：判断迁移归属

假设插件 `example` 把 `channels.example.oldToken` 改为 `accounts.default.token`。设计迁移位置和 runtime 形态。

验收：runtime 只有当前 key；迁移有唯一 owner；说明何时执行和如何验证。

## 11. 下一步

配置 bootstrap 完成后，Gateway 会把这些稳定事实变成长驻服务、认证策略、方法注册表和事件源。下一章进入协议与连接生命周期。
