# 05. Agent Loop、工具与 token mask：把环境交互变成可训练轨迹

`ToolAgentLoop` 是一个异步状态机。它在“生成 assistant token”和“执行工具”之间切换，直到没有工具
调用、超过轮次上限或耗尽 response budget。

## 状态机源码结构

核心状态有四个：

```text
PENDING -> GENERATING -> PROCESSING_TOOLS -> GENERATING -> ... -> TERMINATED
```

- `PENDING`：应用 chat template，得到初始 `prompt_ids`；
- `GENERATING`：调用 `server_manager.generate`，追加模型 token，解析 tool call；
- `PROCESSING_TOOLS`：并发调用工具，把 observation 编码进上下文；
- `TERMINATED`：组装 `AgentLoopOutput`。

`AgentData` 保存每条轨迹的 `request_id`、messages、token IDs、mask、工具参数和 `extra_fields`。

## 两种工具接口

### FunctionTool

`@function_tool` 适合无状态函数。同步函数在线程中执行，没有 create/release 生命周期，也不会注入
每条样本的 `tools_kwargs`。计算器、静态查询和纯转换适合此接口。

### BaseTool

CyberGym workspace 需要 task metadata、session 和外部资源，应使用 `BaseTool`。它的 `execute` 能拿到
`agent_data`，因此可读取：

```python
request_id = agent_data.request_id
tool_args = agent_data.tools_kwargs["cybergym_workspace"]
runtime_state = agent_data.extra_fields
```

当前 `ToolAgentLoop._call_tool` 会在每次调用周围执行 `create`/`release`。因此不要假设同一个
`instance_id` 自动跨多轮保存容器。本文采用更稳妥的做法：bridge 根据
`task_id + request_id` 幂等创建远端 session；工具的 `release` 不销毁它，最终 reward 在 `finally`
中验证并清理 session。

## 为什么不是直接暴露 Docker socket

给 rollout worker 挂 Docker socket 会把训练进程与宿主控制面耦合，并扩大权限。教程引入 bridge：

```text
AgentLoop worker --受限 HTTP contract--> bridge --allowlist--> isolated container
```

bridge 只接受授权 task ID，给每个 rollout 唯一 workspace，限制操作范围、网络、CPU、内存、磁盘和
超时，并把最终验证放到 fresh container。模型永远看不到宿主路径或 Docker API。

## 一个合适的工具 schema

单工具、枚举操作比十几个 shell 工具更容易控制 token 与权限：

```yaml
type: function
function:
  name: cybergym_workspace
  description: 在分配的隔离源码工作区中读取、搜索、修改和运行受限命令
  parameters:
    type: object
    properties:
      operation:
        type: string
        enum: [list, read, search, write, run, status]
      path:
        type: string
      query:
        type: string
      content:
        type: string
      command:
        type: string
    required: [operation]
```

真正的安全校验必须在 bridge 执行，JSON Schema 只帮助模型生成参数，不是权限边界。

## mask 怎样构造

每次 SGLang 生成的 token 追加：

```python
agent_data.prompt_ids += output.token_ids
agent_data.response_mask += [1] * len(output.token_ids)
```

工具响应编码后追加：

```python
agent_data.prompt_ids += observation_ids
agent_data.response_mask += [0] * len(observation_ids)
```

最终 `response_ids` 是初始 prompt 之后的整段 token 流。`response_mask` 同长，确保 observation 会被
后续生成看到，却不会进入 actor loss。

## tool reward 不等于最终 reward

工具返回三元组：

```python
ToolResponse(text=summary), tool_reward, metrics
```

`ToolAgentLoop` 当前会把 `tool_reward` 收集到 `extra_fields["tool_rewards"]`。标准 GRPO 主路径不会
自动把这个 list 累加成 `rm_scores`。所以本教程把真正的四阶段 score 放在异步 custom reward 中，
tool reward 仅用于观测或未来自定义算法。不要返回了 `1.0` 就误以为 actor 已经学习。

## 用 extra_fields 连接工具与 reward

工具第一次调用 bridge 后，将不敏感的运行时引用写入：

```python
agent_data.extra_fields.update({
    "cybergym_session_id": session_id,
    "cybergym_task_id": task_id,
    "workspace_calls": previous_calls + 1,
})
```

AgentLoop 输出后，`AgentLoopWorker._compute_score` 把它包装成 `tool_extra_fields`。默认 reward manager
再合并到 `extra_info`。于是 custom reward 可以获得 session ID，而无需从模型文本中解析。

session ID 只应是不可猜测的短期引用；bridge 仍必须验证调用方与 task 归属。

## 长输出与截断

编译日志或大文件会迅速耗尽 context。三层限制缺一不可：

1. bridge 返回首尾摘要、exit code 和 artifact 元数据；
2. 工具自身不返回原始二进制；
3. `max_tool_response_length` 做最后 token 级截断。

对 source read 提供 `offset/limit` 会比一次返回整个文件更好。为了保持本章 schema 简洁，示例省略，
生产实现应加上并设硬上限。

## 终止与失败语义

设置：

```text
max_assistant_turns=16
max_user_turns=16
max_parallel_calls=1
```

并不保证模型一定生成 artifact。reward adapter 必须把下列情况转成结构化 0 分或小惩罚，而不是抛出
导致整个 step 失败：

- 从未调用工具；
- session 创建失败；
- 缺少 `poc.bin` 或 `fix.patch`；
- 工具 JSON 无效；
- response budget 用尽；
- bridge 超时。

基础设施级错误与模型级失败要分开记录。前者不应被模型“学习”为负 reward，必要时应丢弃样本或重试。

## tokenization sanity check

多轮 chat template 可能删除历史 reasoning 或改变空白，使逐轮 token 拼接与整段重渲染不一致。
默认 `tokenization_sanity_check_mode=strict` 用于暴露差异。先修模板或选择正确 parser；只有人工确认差异
不影响动作 token 后，才考虑 `ignore_strippable`，不要直接关闭。

## 本章练习

使用 mock bridge 生成两轮轨迹，打印但不保存原文：

- 模型 token 数；
- observation token 数；
- `response_mask.sum()`；
- `workspace_calls`；
- `cybergym_session_id` 是否进入 reward extra info。

断言 `response_mask.sum()` 等于模型生成 token 数，而不是整个 response 的 attention length。

[上一章](./04-sglang-rollout.md) · [下一章：Reward Loop](./06-reward-loop.md)
