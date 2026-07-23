# 04. 目标解析与 PR Diff Scope

安全扫描首先要回答两个问题：目标究竟是什么，以及允许重点分析哪一部分。Strix 把这个边界建立在模型运行之前。

## 1. 标准目标类型

[`infer_target_type()`](../../strix/interface/utils.py) 返回二元组：

```python
(target_type, details)
```

支持四类：

| 类型 | 典型输入 | details 中的主字段 |
| --- | --- | --- |
| `repository` | `git@...`、`git://...`、`.git` URL | `target_repo` |
| `local_code` | 已存在的本地目录 | `target_path` |
| `web_application` | HTTP(S)、域名 | `target_url` |
| `ip_address` | IPv4/IPv6 | `target_ip` |

解析有明确优先级。以 HTTP URL 为例：

1. URL 中带用户名/密码时按 repository 处理。
2. path 以 `.git` 结尾时按 repository。
3. 有 query/fragment 时按 web application，避免为明显页面 URL做 Git 探测。
4. 有至少两段 path 时请求 `info/refs?service=git-upload-pack` 探测远程 Git。
5. 否则按 web application。

远程 Git 探测返回 Git advertisement MIME，或 401（私有仓库存在）时视为仓库。网络错误时退化为非仓库，不阻断 parser。

## 2. 为什么必须先标准化

后续代码不用反复猜字符串：

- `build_root_task()` 按类型生成提示词中的目标区块。
- `build_scope_context()` 用类型选择经过验证的 value 字段。
- `collect_local_sources()` 只收集 local/repository 的宿主路径。
- `ReportState` 只对单 repository 推导 SARIF VCS provenance。
- UI 可以用 `original` 友好展示。

标准化让安全边界成为结构化数据，而不是散落在提示词中的自然语言。

## 3. 多目标与 workspace 子目录

用户可以同时提供源码和已部署 URL：

```bash
strix -t ./app -t https://staging.example.com
```

`assign_workspace_subdirs()` 给每个本地/仓库目标分配清洗后的唯一目录名。即使两个目标基础名相同，也会通过后缀避免覆盖。

容器路径最终是：

```text
/workspace/<workspace_subdir>
```

`build_root_task()` 不把宿主绝对路径当作 Agent 工作路径，而明确告诉 Agent 容器内路径。

## 4. `--target`、`--target-list` 与 `--mount`

`read_target_list_file()`：

- 要求 UTF-8；
- 忽略空行；
- 忽略去除前导空白后以 `#` 开始的整行注释；
- 空文件报错。

`--target` 与多个 target list 合并后统一解析。

`--mount` 只接受本地目录，并生成带 `details.mount = True` 的 `local_code` 目标。之后 `dedupe_local_targets()` 以解析后的真实路径去重；同一路径同时以复制目标和 mount 目标出现时，应只保留一致的标准表示。

## 5. 复制与挂载的选择

普通本地目标由 SDK `LocalDir` 逐文件复制到容器。优点是：

- 容器看到的是隔离快照；
- 不直接暴露宿主目录；
- Agent 可以在容器副本上工作。

缺点是大型 monorepo 很慢。因此 CLI 计算本地树大小，超过 `STRIX_MAX_LOCAL_COPY_MB`（默认 1024 MB）时拒绝继续，提示显式使用：

```bash
strix --mount ./huge-monorepo
```

mount 在 Docker 创建时以只读 bind mount 加入。它更快，但扫描过程中宿主文件变化会反映到容器视图，快照稳定性较弱。

## 6. localhost 改写

用户在宿主执行：

```bash
strix -t http://localhost:8000
```

Agent 实际运行在容器中，容器里的 `localhost` 指容器本身。`rewrite_localhost_targets()` 将可改写目标换成：

```text
host.docker.internal
```

Docker client 同时添加 `host.docker.internal: host-gateway`，两边配合才让容器访问宿主服务。只做字符串替换而不配置 Docker DNS 映射是不够的。

## 7. Diff Scope 的目的

PR 安全审查不应无差别扫描整个大型仓库，也不应只看 diff 文本而缺少上下文。Strix 的约束是：

- changed files 是主要范围；
- 其他文件可用于理解 import、定义和调用；
- 只报告与变更有关的发现；
- 新文件读全文，修改文件聚焦变更区；
- 删除文件仅作上下文。

这段策略由 `build_diff_scope_instruction()` 生成人类可读说明，同时 `RepoDiffScope.to_metadata()` 保留结构化文件列表和计数。

## 8. 三种 scope mode

### `full`

明确关闭 diff scope，直接返回：

```json
{"active": false, "mode": "full"}
```

### `diff`

强制启用。没有本地 Git 仓库、浅克隆、无法解析 base ref 或 merge-base 时直接报错。

### `auto`

只有满足这些基本条件才考虑启用：

1. 存在本地源码；
2. 非交互模式；
3. 位于已识别的 CI 环境；
4. 是 PR 环境，或当前分支不同于默认分支。

`auto` 对单个仓库解析失败会跳过并在 metadata 中记录原因；如果没有任何可用 repo，会退化为 full，而不是中止 CI。`diff` 则采用 fail-fast，体现“用户明确要求”的语义。

## 9. Base ref 解析顺序

`_resolve_base_ref()` 大致按以下顺序：

1. 显式 `--diff-base`。
2. GitHub `GITHUB_BASE_REF` 对应的远端 ref。
3. GitHub event payload 的 base SHA。
4. `refs/remotes/origin/HEAD`。
5. `origin/main`。
6. `origin/master`。
7. 都不存在则报错。

然后计算：

```bash
git merge-base <base-ref> HEAD
git diff --name-status -z --find-renames --find-copies <merge-base>...HEAD
```

使用 merge-base 而不是直接比较两个 tip，可以聚焦当前分支从共同祖先开始引入的改动。`-z` 使用 NUL 分隔，能正确处理带空格或特殊字符的文件名。

## 10. Diff 状态如何分类

`_parse_name_status_z()` 把 Git 输出变成 `DiffEntry`：

```python
@dataclass
class DiffEntry:
    status: str
    path: str
    old_path: str | None = None
    similarity: int | None = None
```

`_classify_diff_entries()` 处理：

- `A`：added + analyzable。
- `M`：modified + analyzable。
- `D`：deleted，不放入 analyzable。
- `R`：记录 old/new；新路径 analyzable；非 100% 相似也视为 modified。
- `C` 或未知：保守视为 modified + analyzable。

为避免把超大列表塞进提示词，每个区块最多展示 120 个文件，但完整 metadata 仍保留在 `run.json`。

## 11. Scope 如何进入 Agent

有两个通道：

1. `instruction_block` 拼入 `args.instruction`，变成 root task 的 special instructions。
2. `metadata` 写入 `scan_config["diff_scope"]`，`build_root_task()` 再生成结构化 scope constraints 摘要。

此外 `build_scope_context()` 把原始授权目标写进系统提示词，并声明普通 user instruction 不能扩大范围。这样“重点范围”和“授权范围”是两个层次：diff scope 缩小分析重点，不能增加新目标。

## 12. 本章实验

### 目标解析测试

```bash
uv run pytest tests/test_inputs.py tests/test_cli_target_list.py -q
```

### 自建临时 Git 仓库理解 merge-base

```bash
tmp_dir=$(mktemp -d)
git -C "$tmp_dir" init -b main
git -C "$tmp_dir" config user.email learner@example.com
git -C "$tmp_dir" config user.name Learner
touch "$tmp_dir/a.py"
git -C "$tmp_dir" add a.py
git -C "$tmp_dir" commit -m init
git -C "$tmp_dir" switch -c feature
printf 'print(1)\n' > "$tmp_dir/a.py"
git -C "$tmp_dir" add a.py
git -C "$tmp_dir" commit -m change
git -C "$tmp_dir" merge-base main HEAD
git -C "$tmp_dir" diff --name-status main...HEAD
```

实验结束后删除这个明确的临时目录即可。

## 13. 自测题

1. 为什么 URL 带 query 时直接视为 web application？
2. 为什么 `--mount` 必须由用户显式选择？
3. `auto` 和 `diff` 遇到浅克隆时为什么行为不同？
4. diff scope 与 authorized target scope 有什么区别？
5. 为什么 Git 文件列表使用 NUL 分隔而不是按行解析？

