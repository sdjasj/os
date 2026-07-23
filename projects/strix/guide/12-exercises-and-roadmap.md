# 12. 循序渐进的练习与源码阅读清单

这一章把前面知识转成可验收的实践。所有安全测试实验只针对本地 fixture、自己拥有的应用或明确授权环境。

## 阶段 1：能定位（半天）

### 练习 1：命令入口追踪

不运行扫描，仅凭源码写出 `strix -n -t .` 从入口到 `run_strix_scan()` 的函数链。

验收：至少包含下列节点且顺序正确：

```text
pyproject script -> main -> parse_arguments
-> target normalization -> run_cli -> ReportState
-> run_strix_scan
```

### 练习 2：目录归类

给下面文件各写一句“它拥有的状态/责任”：

```text
core/runner.py
core/agents.py
core/sessions.py
runtime/session_manager.py
report/state.py
interface/tui/live_view.py
viewer/server.py
```

验收：不能把 `TuiLiveView` 说成 Agent 状态真相源，不能把 `ReportState` 说成模型会话存储。

### 练习 3：运行目录手工解剖

如果已有 `strix_runs/`，选择一个不含敏感目标信息的本地 run；否则根据测试 fixture 手工创建最小 `run.json` 和 `.state/agents.json`。解释每个文件的生产者和消费者。

## 阶段 2：能运行纯逻辑（半天）

### 练习 4：目标矩阵

为这些输入预测 `infer_target_type()`：

```text
127.0.0.1
::1
.
https://example.com/path?q=1
git@github.com:owner/repo.git
example.com
```

再运行函数验证。注意明确 repository URL 之外的 HTTP 输入可能触发 Git 探测，不要对未授权/不必要的真实域名做批量实验。

### 练习 5：配置优先级

用 `tmp_path` 写配置测试：JSON 为 `from-file`，环境为 `from-env`，断言环境获胜；再添加通过另一个 API key alias 覆盖的场景。

验收：测试结束不改真实 `~/.strix/cli-config.json`，并重置 loader cache。

### 练习 6：报告 fence

构造包含三反引号、Markdown 图片和标题的 `poc_script_code`，调用 `render_vulnerability_md()`，证明它仍在更长 fence 中。

## 阶段 3：能解释核心执行（1 天）

### 练习 7：画两张状态图

分别画：

1. non-interactive Agent 从 running 到 completed/crashed 的路径。
2. interactive Agent 从 running 到 waiting，再被消息唤醒的路径。

验收：标出 lifecycle tool、普通最终文本、`pending_counts`、wake Event 和 stream cancel。

### 练习 8：Coordinator 并发测试

补一个测试：Agent 正在等待时连续收到两条消息，验证 wait 返回且 consume 的 count 正确。不要真实 sleep，使用 task、`sleep(0)` 和 timeout。

思考：`pending_counts` 统计的是“消息条数”，Session items 尾部截取能否在其他类型 item 同时写入时永远精确？记录你的结论和可能改进，不要求直接改实现。

### 练习 9：恢复清单

写一张表说明恢复下列内容需要哪个文件：

| 内容 | agents.json | agents.db | run.json | vulnerabilities.json |
| --- | --- | --- | --- | --- |
| 根/子拓扑 |  |  |  |  |
| 模型历史 |  |  |  |  |
| 原始目标/模式 |  |  |  |  |
| 漏洞编号连续性 |  |  |  |  |

验收答案：依次是 agents.json、agents.db、run.json、vulnerabilities.json。

## 阶段 4：能解释沙箱（1 天）

### 练习 10：源码进入容器的两条路径

用图比较 LocalDir copy 与 read-only bind mount，从 `targets_info` 一直画到 Docker create/session.start。

验收：标出 symlink staging 只属于 copy 路径，mount 在 Docker create 时应用。

### 练习 11：Symlink fixture

在 `tmp_path` 创建：

- 普通文件；
- 指向树内文件的 link；
- 指向树外文件的 link；
- cycle。

调用 `stage_symlink_safe_dir()`，断言树内内容保留、树外和 cycle 不进入 staged tree。

### 练习 12：Caido 双 URL

不用启动容器，阅读代码并解释：为什么登录 token 用 container URL，而 Python client 用 host URL？如果使用自定义 Docker network，不发布 host port，host URL 如何变化？

## 阶段 5：能理解产物与 Viewer（1 天）

### 练习 13：从工具参数到 SARIF

选择一个测试 finding，追踪字段：

```text
create_vulnerability_report
-> _do_create
-> ReportState.add_vulnerability_report
-> write_vulnerabilities
-> build_sarif_report
```

至少跟踪 title、severity、cwe、code_locations、poc_script_code。说明最后一个字段为什么不会出现在 SARIF。

### 练习 14：最小 Viewer run

参考 `tests/test_viewer.py::_make_run` 在临时目录创建 run，调用 `serve(open_browser=False)`，请求：

```text
/api/run
/api/transcript
/assets/不存在的资源
```

验收：正确 shutdown/server_close；不使用固定端口；不访问真实 relay。

### 练习 15：Capability threat model

写出四个攻击者场景：

1. 只知道 host/port。
2. 拿到裸 base URL。
3. 拿到 tokened URL。
4. 拿到 email auth 文件但 Viewer session 已重启。

说明各自能访问当前 run、历史 run、steering、报告发送中的哪些能力。以测试和 server 代码为证，不凭直觉。

## 阶段 6：第一次贡献式改动（1～2 天）

### 练习 16：新增外部技能

写一个不含攻击性自动化、重点在误报排除的安全 header 技能：

- frontmatter；
- objective；
- workflow；
- validation；
- reporting；
- limitations。

注册外部目录并补发现/加载/覆盖测试。

### 练习 17：新增只读工具

实现第 11 章的 `current_agent_identity` 或类似只读工具，完成：

- 类型化签名和 docstring；
- 缺 context 的稳定行为；
- factory `extra_tools` 测试；
- root/child 都能获得工具；
- lifecycle tool 仍是最后一个。

### 练习 18：增加 Viewer fallback fixture

在 transcript fixture 中加入未知工具调用和失败结果，确认前端 fallback renderer/后端投影不会崩溃。如果修改前端，运行 build 并检查 static 变化。

## 阶段 7：高级设计题（持续）

### 设计题 A：消除 ReportState 全局单例

提出一个支持同进程多扫描的设计。至少比较：

- 放入 `RunContextWrapper.context`；
- `ContextVar`；
- scan ID 到 state 的 registry。

考虑 LiteLLM 全局 cost callback 如何找到正确扫描。

### 设计题 B：增量 Viewer transcript

当前每 500ms 重读 DB 并重建投影。设计 `since_event_id` 或 `since_message_id` 协议，考虑：

- live WAL 读取；
- Agent 状态更新不一定伴随 message；
- run 切换；
- finished settle；
- Viewer 独立进程启动后的全量 bootstrap。

### 设计题 C：Backend capability protocol

当前 backend 类型大量使用 `Any`。设计 Python `Protocol`，把 session/client 所需最小行为类型化，同时兼容 SDK 具体实现。

### 设计题 D：报告写入并发

多个子 Agent 可能几乎同时创建报告。分析当前全局列表、编号和多文件写入的线程/协程安全性。提出锁或单写者队列设计，并说明对 callback、dedupe 和恢复的影响。

## 推荐的二次阅读顺序

第一次按主链路读完后，第二次按不变量读：

### 授权与隔离不变量

```text
build_scope_context
_merge_root_prompt_context
_compose_root_instructions_override
resolve_run_dir / _resolve_asset
stage_symlink_safe_dir
```

### 完成与恢复不变量

```text
_finish_tool_use_behavior
_run_noninteractive_until_lifecycle
finish_scan / agent_finish
AgentCoordinator.snapshot/restore
ReportState.hydrate_from_run_dir
```

### 不泄漏不变量

```text
trace_include_sensitive_data=False
turn_off_message_logging
report tool output rules
SARIF PoC omission
Viewer encrypted PDF password flow
```

### 幂等与原子性不变量

```text
_atomic_write_text
SARIF temp replace
Coordinator temp snapshot
session rewrite rollback
session_manager.cleanup
```

## 一份可执行的四周路线

### 第 1 周：读懂

- 完成 00～04 章。
- 跑 config、input、local source 测试。
- 交付自己的主调用图和 scan_config 字段表。

### 第 2 周：核心

- 完成 05～07 章。
- 跑 Agent/Session/runtime 测试。
- 交付多 Agent 状态图、恢复文件表、沙箱数据路径图。

### 第 3 周：产物与界面

- 完成 08～10 章。
- 跑 report/SARIF/Viewer 测试与前端 build。
- 交付一个从漏洞工具到 Viewer 的字段追踪。

### 第 4 周：扩展

- 完成 11 章。
- 新增一个外部技能和一个只读工具原型。
- 为二者补测试并通过全量质量检查。

## 最终验收问题

如果能不看教程回答以下问题，就已经掌握项目主干：

1. `run_strix_scan()` 为什么是 composition root？
2. 一个子 Agent 从创建到给父 Agent 报告经历哪些函数？
3. 为什么一条外部消息既写 SQLite Session，又更新 pending count 和 Event？
4. 本地源码、宿主 web app 和容器 Caido 三者怎样连通？
5. 漏洞数据为什么同时有 JSON、CSV、Markdown 与 SARIF？
6. Viewer 为什么能独立查看 live run，却不能独立 steering？
7. 哪些状态可以恢复，哪些状态会随进程/容器结束而消失？
8. 新增一个工具需要检查哪些安全和生命周期边界？

