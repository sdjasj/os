# 07. CyberGym-E2E：四阶段验证怎样映射为 RL 环境

CyberGym-E2E 的上游 README 定义了两种模式和四个验证阶段。本文只使用它的通用执行契约，不导入
任务数据、漏洞细节、PoC 或补丁。所有实验都必须在你拥有或明确获准使用的隔离任务上进行。

## 两种任务模式

### End-to-end

Agent 初始只获得受控源码 workspace，需要生成两个 artifact：

```text
/output/poc.bin
/output/fix.patch
```

最终运行 stage1–4。

### Patch-only

环境额外提供受控的 crash 信息与 PoC，Agent 只需生成 patch，最终主要运行 stage3–4。它更容易，
适合作为 curriculum 的第一阶段。

## 四阶段语义

`scripts/validate.py::validate_task` 返回 `stage1` 到 `stage4`，每个含 status、output 和 description。
`scripts/run_agent.py::run_final_validation` 会为每个 stage 启动 fresh container，避免前一阶段编译器、
sanitizer 或源码状态污染下一阶段。

| 阶段 | 条件 | 通过含义 |
| --- | --- | --- |
| stage1 | Agent PoC，无 patch | PoC 确实触发失败，而非无效输入 |
| stage2 | Agent PoC + Agent patch | patch 修复了该 PoC |
| stage3 | Agent patch + 项目测试 | patch 没破坏受测功能 |
| stage4 | ground-truth PoC + Agent patch | patch 覆盖基准所指向的真实缺陷 |

依赖关系是严格的：stage1 不通过则 stage2 跳过；stage2 不通过则 e2e 的 stage3 跳过；stage3 不通过
则 stage4 跳过。`error`、`failed` 与 `skipped` 含义不同，reward adapter 不应混成一个布尔值。

## 为什么 final validation 必须和交互环境分离

Agent 在 workspace 中会读写文件、编译、运行命令，甚至可能无意改变测试或构建状态。如果直接在同一
容器评分，轨迹可能通过污染环境而获得虚假 reward。最终评分应：

1. 从 session 导出限定 artifact；
2. 检查 artifact 文件名、大小和格式；
3. 每个 stage 从原始任务快照启动 fresh container；
4. 只把 artifact 注入验证容器；
5. 使用上游 validator 的通用阶段逻辑；
6. 返回结构化 status，不回传隐藏内容给训练模型。

这相当于 RL 环境的 `step` 可以在可变 workspace 中执行，但 `reward` 必须由可信、可重置的 judge
计算。

## 哪些状态对 Agent 可见

| 信息 | e2e | patch-only | reward/judge only |
| --- | :---: | :---: | :---: |
| 受控源码 | ✓ | ✓ | ✓ |
| build/test 命令摘要 | ✓ | ✓ | ✓ |
| crash 信息 |  | ✓ | ✓ |
| Agent artifact | ✓ | ✓ | ✓ |
| ground-truth PoC |  |  | ✓ |
| ground-truth patch |  |  | 不应作为评分输入泄露 |
| stage4 原始隐藏输出 |  |  | 只保留安全摘要 |

bridge 必须在权限层实现这个可见性矩阵，而不是依赖 prompt 要求模型“不要看”。

## 把 benchmark 变成训练环境的差距

CyberGym 上游的 `run_agent.py` 负责启动一个完整外部 Agent CLI；verl 则希望自己控制每轮模型 token
和 tool call。不能简单在 verl reward 中再次调用 `run_agent.py`，否则真正生成轨迹的是另一个 Agent，
SGLang policy 没有 credit assignment。

正确拆分是：

```text
CyberGym 保留：任务装配、隔离 workspace、artifact contract、四阶段 validator
verl 接管：模型生成、工具调用轨迹、采样、reward 收集、GRPO 更新
bridge 新增：把两边的接口安全地连接起来
```

## Bridge 最小职责

bridge 不是另一个 Agent。它只提供确定性环境 API：

- 根据授权 task ID 幂等创建 workspace；
- 在 workspace 内执行受限 list/read/search/write/run；
- 导出指定 artifact；
- 调用 fresh-container final validation；
- 清理 session 与孤儿资源；
- 返回脱敏、限长的结构化结果。

它可以复用 CyberGym 的 `start_container`、`setup_workspace`、`exec_run`、`cleanup_container` 和
`run_final_validation` 思路，但需要经过服务层封装、输入校验和并发限制。不要直接把这些函数暴露给
不受信客户端。

## 任务 allowlist

bridge 启动时读取服务端 allowlist：

```json
{
  "demo-project/authorized-task": {
    "mode": ["patch-only", "e2e"],
    "image": "approved-image@sha256:...",
    "dataset_root": "opaque-server-side-reference"
  }
}
```

训练数据只携带 key。bridge 拒绝路径穿越、任意镜像名、任意宿主目录和 allowlist 外任务。镜像应按
digest 固定，任务快照应不可变，才能重现实验。

## 训练/验证拆分

不要随机按 trajectory 划分，因为同一任务的不同 rollout 会泄漏。至少按 task ID 划分；若多个任务
来自同一上游缺陷族，还应按项目或来源分组，减少近重复泄漏。

验证报告应包含：

- pass@1 与 pass@k；
- stage1–4 通过率；
- patch-only 与 e2e 分开统计；
- 平均工具调用与 wall time；
- infra error 排除前后的分母；
- 对未见项目/未见任务族的泛化结果。

## 安全与研究有效性检查

- 只在自有或明确授权任务上训练；
- 默认禁用 workspace 网络；
- 禁止挂载宿主敏感目录和 Docker socket；
- 隐藏 ground-truth artifact；
- 限制输出文件名、大小和数量；
- 日志不保存二进制或敏感源码全文；
- 对 judge 与 tool 使用不同身份和权限；
- 所有验证容器可销毁且有 TTL。

## 本章自测

1. 为什么不能把 CyberGym `run_agent.py` 整体放进 reward 函数？
2. stage3 通过是否足以证明修复了目标缺陷？
3. 为什么同一 task 的不同 rollout 不能跨 train/val？
4. final validation 使用 fresh container 主要防什么？

[上一章](./06-reward-loop.md) · [下一章：bridge 与 workspace 工具](./08-cybergym-bridge-tool.md)
