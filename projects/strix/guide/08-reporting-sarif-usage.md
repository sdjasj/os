# 08. 漏洞报告、去重、SARIF 与成本

本章从 Agent 调用 `create_vulnerability_report` 开始，跟踪数据如何验证、去重、编号、落盘并进入 CI；最后解释 token/cost 预算如何影响整个 Agent 图。

## 1. `ReportState` 的责任

[`ReportState`](../../strix/report/state.py) 明确只保存 Strix 产品产物：

- `vulnerability_reports`
- 最终四段扫描结果
- `run_record`
- LLM usage ledger
- UI callback 和 telemetry 去重标志

它不保存模型对话；对话属于 SDK Session。这个边界让报告格式演化时不必改 Agent 数据库，也让恢复对话不依赖 Viewer。

CLI/TUI 创建 `ReportState` 后用 `set_global_report_state()` 设置模块级全局引用。报告工具在 SDK context 里没有直接传 `ReportState`，因此通过全局引用访问当前扫描。

全局状态简化了工具接口，但也意味着同一 Python 进程当前设计主要面向一个活跃产品扫描；如果未来要同进程并发多个完全独立扫描，需要改成 context-local 或显式注入。

## 2. 创建漏洞报告的入口校验

[`create_vulnerability_report`](../../strix/tools/reporting/tool.py) 要求完整字段：

```text
title, description, impact, target,
technical_analysis, poc_description, poc_script_code,
remediation_steps, evidence, assumptions,
fix_effort, cvss_breakdown
```

可选字段包括 endpoint/method、CVE/CWE、代码位置和 fix PR body。

强制 PoC、evidence 和 assumptions 的目的是阻止 Agent 把未经验证的猜测计为漏洞。依赖已知 CVE 如果无法动态 PoC，应走 `create_dependency_report`，它有专门的 package/ecosystem/version/advisory 语义。

## 3. CVSS 计算，而不是相信模型给总分

工具接收 8 个 CVSS 3.1 base metrics：

```text
AV, AC, PR, UI, S, C, I, A
```

`_calculate_cvss()` 拼出向量，再用 `cvss.CVSS3` 计算 score 和 severity。模型选择指标，项目代码计算总分，避免“指标与分数互相矛盾”。计算异常时当前实现退化为 7.5/high 并记录日志，因此测试/调试时应检查异常而不是把 fallback 当准确结果。

CVE 和 CWE 也会提取并规范成 `CVE-NNNN-NNNN`、`CWE-NNN` 形式。

## 4. 代码位置的安全约束

代码位置用于 Markdown 与 SARIF，必须是 repo-relative 路径。报告工具和 SARIF 构建器都会拒绝：

- 绝对路径；
- 含 `..` 的 traversal；
- Windows drive/首段含冒号；
- 无有效 start line。

原因不只是格式：SARIF 可能上传到外部 code scanning，绝不能泄露 `/workspace` 或宿主绝对路径，也不能让结果指向仓库外文件。

## 5. 自动去重

创建报告前，工具取现有漏洞并调用 [`check_duplicate()`](../../strix/report/dedupe.py)。去重有两条路径。

### 依赖 CVE：确定性 identity

identity 是：

```text
(CVE, ecosystem, package_name)
```

同 CVE + 同包/生态是重复；同 CVE 不同包不是；同包不同 CVE也不是。对旧格式报告还会在文本中匹配包名。

### 动态漏洞：LLM judge

去重提示词比较 root cause、component/endpoint/file、攻击向量，以及是否由同一 patch 修复。相同漏洞类型不自动代表重复；不同 endpoint/参数/认证条件通常不是重复。

为了控制上下文，只保留相关字段，超长字符串截断到 8000 字符。模型响应必须解析成：

```json
{
  "is_duplicate": false,
  "duplicate_id": "",
  "confidence": 0.9,
  "reason": "..."
}
```

潜在重复会返回 `success: false` 和 existing ID，提示 Agent 不要重报。

## 6. 编号与内存状态

`ReportState.add_vulnerability_report()` 按当前列表长度生成：

```python
report_id = f"vuln-{len(self.vulnerability_reports) + 1:04d}"
```

然后规范字符串、附加 timestamp/finding class/agent identity，append 到列表，触发实时 UI callback，立即 `save_run_data()`。

恢复时 `hydrate_from_run_dir()` 会先读 `vulnerabilities.json` 并恢复 `_saved_vuln_ids`。若 JSON 损坏，它选择明确报错，而不是当成空列表继续，因为继续会重新分配 `vuln-0001` 并覆盖旧 Markdown，造成数据丢失。

## 7. 每次保存会写哪些产物

`_save_artifacts()` 的顺序：

1. 如有最终结果，写 `penetration_test_report.md`。
2. 如有漏洞，写新单项 Markdown、完整 CSV、完整 JSON。
3. 始终尝试写 `findings.sarif`，即使漏洞列表为空。
4. 写 `run.json`。

SARIF 失败被单独捕获，不能破坏 Markdown/CSV/JSON/run record 主路径。

即使 clean run 也写空 SARIF 很重要：CI 的 code scanning 才能把上次存在、这次消失的结果识别为已修复，而不是误以为本次根本没上传。

## 8. 原子写与 Markdown 注入防护

`write_run_record()`、漏洞 JSON/CSV/单项 MD 使用 `_atomic_write_text()`：同目录创建临时文件，写完后 `replace()`。同文件系统 rename 是原子的，崩溃时不会把旧完整文件替换成半截新文件。

PoC 与代码 snippet 可能含反引号 fence，甚至内容来自被测目标。`_safe_fence()` 找出内容中最长 backtick run，使用更长的 opening/closing fence：

```python
longest = max(...)
return "`" * max(3, longest + 1)
```

这样内容中的 ``` 无法提前闭合代码块并把后续恶意 Markdown 变成图片或标题。对应测试在 [`tests/test_report_writer.py`](../../tests/test_report_writer.py)。

## 9. 单项 Markdown、CSV 与 JSON 各自用途

- `vulnerabilities/vuln-NNNN.md`：人类阅读，包含描述、证据、影响、PoC、代码位置、修复和假设。
- `vulnerabilities.csv`：轻量索引，按 critical -> high -> medium -> low -> info 排序。
- `vulnerabilities.json`：完整机器可读源，也是恢复报告状态的依据。

`saved_vuln_ids` 只防止重复改写旧单项 MD；CSV/JSON 每次从完整列表重建，确保索引一致。

## 10. 最终报告与完成状态

根 Agent 调用 `finish_scan`，必须提供：

```text
executive_summary
methodology
technical_analysis
recommendations
```

工具先拒绝仍有 active children 的完成请求，再在线程中调用 `_do_finish()`。`ReportState.update_scan_final_fields()`：

1. 构造 `scan_results`。
2. 生成四个一级标题的 Markdown。
3. 写入 `run_record["scan_results"]`。
4. `save_run_data(mark_complete=True)` 设置 end_time/status completed。
5. 发送结束 telemetry。

只有这个路径会得到规范的 `completed` 产品状态。中断/异常 cleanup 会记录 stopped/failed/interrupted，并保留 resume 入口。

## 11. SARIF 转换

[`build_sarif_report()`](../../strix/report/sarif.py) 生成 SARIF 2.1.0：

- 每个稳定 rule ID 对应一个 rule descriptor。
- 每个漏洞对应 result。
- severity 映射为 SARIF level，并保留 `security-severity`。
- CWE 优先作为 rule ID，其次 CVE、finding ID、title slug。
- 安全 code location 变成 physical location。
- endpoint 变成 logical location。
- 没有安全位置时锚定 `SECURITY.md`，并标记 `synthetic_location=true`。
- `fix_before`/`fix_after` 可转换成 SARIF fixes。

SARIF 不包含 `poc_script_code`。它只保留 PoC 描述和 `script_available=true`，避免向外部代码扫描平台上传可武器化 payload；完整脚本只留在本地漏洞产物。

## 12. 指纹与跨运行稳定性

SARIF 结果包含基于确定性字段的 partial fingerprint，避免使用容易被模型换一种说法的 title/message。项目还提供文件无关的 vulnerability class hash，帮助文件重命名后关联同类结果。

这反映一个重要原则：机器去重键应来自稳定技术身份，不应来自自由文本。

## 13. Repository provenance

只有恰好一个 repository 目标时，`ReportState` 尝试推导：

```text
repositoryUri, repositoryFullName,
commitSha, branch, ref
```

Git 命令超时/失败会降级为缺字段，不阻断报告。多个 repo 时 provenance 语义不唯一，所以整个 run 省略，而不是错误地把所有结果归到第一个仓库。

SARIF 使用这些数据填充 `versionControlProvenance` 和 `automationDetails.id=strix/<owner>/<repo>`。

## 14. Usage ledger

[`LLMUsageLedger`](../../strix/report/usage.py) 聚合 SDK `Usage`：

- 总 requests/input/output/total tokens；
- 按 Agent 的 usage；
- metadata 中的 agent name/model；
- 总 cost 与按 token 比例分摊的 agent cost。

成本来源有两种：

1. LiteLLM routed provider 通过 success callback 报 observed cost。
2. 其他路径根据 token usage 和 LiteLLM 价格表估算。

这样尽量避免同一次调用既 observed 又 estimated 而双重计费。

## 15. 扫描预算如何停止所有 Agent

[`ReportUsageHooks.on_llm_end()`](../../strix/core/hooks.py) 在每次模型响应结束后：

1. 从 context 解析 agent ID/name。
2. 把 response usage 记入 ReportState。
3. 读取累计 cost。
4. 达到 `--max-budget-usd` 时抛 `BudgetExceededError`。

`_run_cycle()` 捕获后：

- 当前 Agent -> stopped；
- `coordinator.trigger_budget_stop()` 设置 scan-wide flag；
- 唤醒所有 waiting Agent；
- 向上抛，让根 Runner 取消后代并干净结束。

必须唤醒等待者，否则根 Agent 可能永远停在 `wait_for_message`，预算已到却无法退出。

## 16. 本章实验

```bash
uv run pytest \
  tests/test_report_writer.py \
  tests/test_reporting_fields.py \
  tests/test_sarif.py \
  tests/test_sarif_stride.py \
  tests/test_cost_tracking.py -q
```

纯函数渲染实验：

```bash
uv run python - <<'PY'
from strix.report.writer import render_vulnerability_md

report = {
    "id": "vuln-0001",
    "title": "Demo",
    "severity": "low",
    "timestamp": "2026-07-22 00:00:00 UTC",
    "description": "Only a rendering exercise.",
    "poc_script_code": "print('``` inside payload')",
}
print(render_vulnerability_md(report))
PY
```

## 17. 自测题

1. 为什么漏洞 JSON 损坏时不能当空列表继续恢复？
2. 为什么 CVSS 总分由代码计算，而不是作为模型自由字段？
3. 为什么 clean run 也必须写空 SARIF？
4. SARIF 为什么省略 PoC script，但本地 Markdown 保留？
5. 预算异常怎样唤醒正在等待消息的 Agent？

