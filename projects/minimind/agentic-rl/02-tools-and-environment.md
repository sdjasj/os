# 02. 工具协议与执行环境

## 1. 工具的三份定义必须一致

当前实现中，一个工具横跨三处：

```text
工具 schema（模型看见什么）
    TOOLS / 每条数据的 tools

执行函数（环境实际做什么）
    MOCK_RESULTS[name]

奖励校验（什么调用算合法）
    CHECK_ARGS[name]
```

只改一处会导致隐蔽错误。例如 schema 新增参数 `unit`，但 `CHECK_ARGS` 不校验，模型可能通过缺参调用仍得合法分；执行器换名但数据没换，则所有调用都返回失败。

## 2. Schema 示例

`trainer/train_agent.py:40-47` 使用 OpenAI 风格 function schema：

```python
{
  'type': 'function',
  'function': {
    'name': 'calculate_math',
    'description': '计算数学表达式',
    'parameters': {
      'type': 'object',
      'properties': {
        'expression': {'type': 'string'}
      },
      'required': ['expression']
    }
  }
}
```

Schema 是给模型的自然语言+结构提示，项目没有用通用 JSON Schema 库在运行时完整验证。真正合法性由手写 `CHECK_ARGS` 决定。

## 3. 工具调用文本协议

模型应生成：

```text
<tool_call>
{"name":"calculate_math","arguments":{"expression":"12*7"}}
</tool_call>
```

`parse_tool_calls`：

```python
for body in re.findall(r'<tool_call>(.*?)</tool_call>',
                       text, re.DOTALL):
    try:
        calls.append(json.loads(body.strip()))
    except:
        pass
```

它允许一次输出多个 `<tool_call>`，但有几个边界：

- 标签不闭合时完全解析不到；
- JSON 非法时静默丢弃；
- 不校验根节点是否 dict；
- 正则不是通用 XML parser；
- 错误原因不进入 reward 诊断。

训练调试时建议把解析失败分为：标签错误、JSON 错误、字段错误、未知工具、参数错误，而不是统一成“没有调用”。

## 4. `arguments` 的双格式兼容

模型或数据可能给对象，也可能给 JSON 字符串：

```python
raw = call.get('arguments', {})
if isinstance(raw, str):
    try:
        raw = json.loads(raw)
    except:
        raw = {}
```

这兼容：

```json
{"arguments":{"expression":"12*7"}}
```

和：

```json
{"arguments":"{\"expression\":\"12*7\"}"}
```

但训练数据最好统一格式，否则模型会学习两套序列模式，降低有限容量的利用率。

## 5. 模拟执行器

`MOCK_RESULTS` 为六个工具提供确定性/查表式环境。例如：

```python
'unit_converter': lambda args: {
    'result': round(
        float(args.get('value', 0)) *
        UNIT_DATA.get(f"{from_unit}_{to_unit}", 1), 4
    )
}
```

工具结果统一转 JSON 文本并限制 2048 字符：

```python
result_str = (
    json.dumps(result, ensure_ascii=False)
    if result else '{"error": "tool not found"}'
)[:2048]
```

长度限制防止异常结果撑爆上下文，但按字符截断可能制造非法 JSON。更稳妥的做法是限制结构中各字段，或返回结构化的 `truncated=true` 摘要。

## 6. 超时机制

`execute_tool` 使用：

```python
signal.signal(signal.SIGALRM, handler)
signal.alarm(1)
result = fn(args)
```

限制与注意事项：

- `SIGALRM` 主要适用于 Unix；
- signal handler 通常只能在主线程设置；
- 它不能替代进程级资源隔离；
- 当前 `except:` 吞掉所有异常，外层只能看到 `None`；
- DDP 每个进程都会执行各自工具，带外部副作用时会重复调用。

## 7. 数学 `eval` 不是生产沙箱

虽然代码移除了 `__builtins__` 并限定 `math`，但不要把教学用 `eval` 当作不可信输入的安全边界。生产工具应使用 AST 白名单解析器或隔离进程，并限制：

- 可用运算符和函数；
- 表达式长度/深度；
- 大整数、幂和递归资源消耗；
- CPU 时间与内存；
- 文件、网络和系统调用。

## 8. 参数校验与 reward

`CHECK_ARGS` 只做存在性检查：

```python
'unit_converter': lambda a:
    a.get('value') is not None and
    a.get('from_unit') and a.get('to_unit')
```

它没有严格检查类型、枚举或数值范围。模型传 `value='abc'` 可能通过合法性 reward，但执行失败。这说明“schema 合法”“执行成功”“结果正确”应当是三个独立奖励/指标。

## 9. 如何增加一个安全工具

以整数加法为例：

```python
ADD_SCHEMA = {
  'type': 'function',
  'function': {
    'name': 'add_integers',
    'description': '计算两个整数之和',
    'parameters': {
      'type': 'object',
      'properties': {
        'a': {'type': 'integer', 'minimum': -1000000,
              'maximum': 1000000},
        'b': {'type': 'integer', 'minimum': -1000000,
              'maximum': 1000000}
      },
      'required': ['a', 'b'],
      'additionalProperties': False
    }
  }
}

def check_add(a):
    return (type(a.get('a')) is int and type(a.get('b')) is int
            and -10**6 <= a['a'] <= 10**6
            and -10**6 <= a['b'] <= 10**6)

def execute_add(a):
    return {'result': a['a'] + a['b'], 'ok': True}
```

然后同步修改数据 schema、执行映射和校验映射，并新增端到端测试。

## 10. 工具结果应该怎样表示

推荐始终返回显式状态：

```json
{"ok":true,"result":84,"error":null}
```

失败：

```json
{"ok":false,"result":null,"error":{"code":"INVALID_ARGUMENT","message":"expression is required"}}
```

这样模型可以学习失败恢复，reward 也能区分解析失败、执行失败与答案错误。

## 11. 环境确定性

当前天气、时间、汇率使用静态表，适合 RL：相同动作得到相同 observation，reward 方差较低。接入真实 API 后应处理：

- 时间变化与不可复现；
- 限流、超时、网络错误；
- API 结果版本；
- 训练集答案随时间过期；
- 外部调用成本；
- 多 rank 重复副作用。

一种常见方案是先记录环境响应形成可重放 fixture，再用真实环境做独立在线评测。

## 12. 小实验

```bash
conda activate deepspeed
python - <<'PY'
from trainer.train_agent import parse_tool_calls, execute_tool, CHECK_ARGS

text = '<tool_call>{"name":"calculate_math","arguments":{"expression":"12*7"}}</tool_call>'
calls = parse_tool_calls(text)
assert len(calls) == 1
call = calls[0]
assert CHECK_ARGS[call['name']](call['arguments'])
result = execute_tool(call['name'], call['arguments'])
assert result == {'result': '84'}
print(calls)
print(result)
PY
```

## 13. 本章检查题

1. 为什么 schema 合法不代表工具能成功执行？
2. 当前解析失败为什么可能被 reward 当作“无工具直接回答”？
3. 多卡训练调用有副作用的支付工具会发生什么？应把执行放在哪里？
4. 如何让工具错误成为模型可观察、可恢复的状态，而不是 `None`？
