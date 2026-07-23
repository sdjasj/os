# 01. 安装、启动与第一个程序

## 1. 先选择正确的安装组合

Ray 使用可选依赖控制安装体积。不要一开始无条件安装所有组件，根据目标选择 extras：

```bash
# 只使用 Ray Core
python -m pip install -U ray

# Core + Dashboard、集群 CLI、Jobs 等常用能力
python -m pip install -U "ray[default]"

# 分别安装领域库
python -m pip install -U "ray[data]"
python -m pip install -U "ray[train]"
python -m pip install -U "ray[tune]"
python -m pip install -U "ray[serve]"
python -m pip install -U "ray[rllib]"
```

`ray[all]` 适合临时探索，不适合盲目放进生产镜像；它会引入更多依赖、构建时间和安全维护面。深度学习框架、数据库驱动、云存储 SDK 等通常仍需按场景单独安装。

本仓库的 extras 定义位于 [`../python/setup.py`](../python/setup.py)。

## 2. 使用独立虚拟环境

在仓库外部作为用户安装稳定版时：

```bash
mkdir ray-demo
cd ray-demo
python -m venv .venv
source .venv/bin/activate
python -m pip install -U pip
python -m pip install "ray[default]"
```

Windows PowerShell 的激活命令是：

```powershell
.venv\Scripts\Activate.ps1
```

验证安装：

```bash
python -c "import ray; print(ray.__version__)"
ray --version
```

不要在同一集群中混用不同 Ray 版本。Driver、Head、Worker 的 Ray/Python 版本应保持一致，否则可能出现连接、序列化或协议不兼容。

## 3. 源码仓库与 PyPI 安装的区别

当前目录是 Ray 源码仓库，不等于已经安装了一个可运行的 Ray 包。你可以：

- **学习和普通使用**：在干净虚拟环境安装 PyPI 稳定版；
- **开发 Ray 本身**：按仓库的开发构建文档编译并安装本地源码。

构建 Ray Core 涉及 C++、Bazel 和平台依赖，不能用简单的 `pip install -e .` 代替完整流程。源码开发参考：

- [`../doc/source/ray-contribute/development.md`](../doc/source/ray-contribute/development.md)
- [`../doc/source/ray-contribute/getting-involved.md`](../doc/source/ray-contribute/getting-involved.md)

本教程讲的是 Ray 的使用方式，示例可在安装了匹配 Ray 版本的虚拟环境中运行，不要求从源码构建。

## 4. 第一个完整程序

运行 [`examples/core_tasks.py`](examples/core_tasks.py)：

```bash
python ray_usage_guide/examples/core_tasks.py
```

核心代码如下：

```python
import time
import ray

ray.init()

@ray.remote
def slow_square(value: int) -> int:
    time.sleep(0.5)
    return value * value

refs = [slow_square.remote(value) for value in range(8)]
print(ray.get(refs))
ray.shutdown()
```

需要观察四件事：

1. `@ray.remote` 返回的不是普通函数，而是可提交的远程函数对象。
2. `.remote()` 提交调用并立即返回 `ObjectRef`。
3. 循环先提交全部任务，因此任务可以并行，而不是每次提交后马上等待。
4. `ray.get(refs)` 是结果同步边界。

一个常见反例：

```python
# 每次循环都阻塞，基本退化为串行。
results = [ray.get(slow_square.remote(i)) for i in range(8)]
```

正确思路是“先提交，后收集”：

```python
refs = [slow_square.remote(i) for i in range(8)]
results = ray.get(refs)
```

## 5. `ray.init()` 的四种常见连接方式

### 5.1 自动启动本机实例

```python
ray.init()
```

适合学习、单机脚本和测试。Ray 在本机启动运行时，Driver 结束后通常一起停止。

### 5.2 连接已经启动的集群

先在终端启动 Head：

```bash
ray start --head
```

脚本连接：

```python
ray.init(address="auto")
```

结束本机集群：

```bash
ray stop
```

显式启动适合连续运行多个脚本和持续查看 Dashboard。

### 5.3 连接指定地址

```python
ray.init(address="ray://cluster-host:10001")
```

这是 Ray Client 形式。它适合交互式开发，但长时生产批作业通常优先使用 Ray Jobs，因为 Client 与调用端网络连接的生命周期耦合更紧。

### 5.4 由 Ray Job 自动连接

提交到集群的入口脚本中仍可写：

```python
ray.init()
```

Ray 会连接当前 Job 所在的集群。不要在 Job 脚本里硬编码本机 IP。

## 6. 查看当前运行环境

```python
import ray

context = ray.init()
print(context.address_info)
print(ray.cluster_resources())
print(ray.available_resources())
```

- `cluster_resources()` 是集群总逻辑资源；
- `available_resources()` 是当前可调度的近似可用资源，值会随任务变化；
- 两者不是操作系统监控数据，不能代替 `top`、Prometheus 或 GPU 监控。

命令行常用检查：

```bash
ray status
ray list nodes
ray list actors
ray list tasks
```

Dashboard 默认地址为 `http://127.0.0.1:8265`。如果没有安装 `ray[default]`，Dashboard 和部分 CLI 依赖可能不可用。

## 7. 本地多进程并不等于多机

`ray.init()` 会在本机启动多个 Worker 进程，因此已经能验证：

- 函数/类是否可序列化；
- 多进程是否安全；
- 任务依赖是否正确；
- 资源声明和并行度是否合理。

但多机还会引入：

- 节点间网络和对象传输；
- 本地路径在其他节点不存在；
- Worker 环境不一致；
- 节点失败和抢占；
- 持久存储与凭证分发。

所以不要假设“本机可运行”就等于“集群可运行”。最常见的迁移问题是代码只存在 Driver 本地、数据写入节点本地盘、或依赖未安装到 Worker。

## 8. Jupyter 中使用

在 Notebook 中建议：

```python
import ray

if ray.is_initialized():
    ray.shutdown()

ray.init()
```

反复执行定义 Actor/Task 的单元格可能保留旧状态或产生重复定义。调试时明确执行 `ray.shutdown()` 并重新初始化，能减少“代码已改但 Worker 仍像在跑旧版本”的困惑。

不要在 Notebook 中一次 `ray.get()` 数万个大对象；优先迭代处理或写入持久存储。

## 9. 第一次运行的排错顺序

1. 确认当前 Shell 已激活预期虚拟环境。
2. 比较 `which python`、`python -m pip --version` 和 `ray --version`。
3. 用 `ray stop` 清理上一次残留的本地实例，再重试。
4. 确认端口未占用，尤其是 Dashboard 的 8265。
5. 用最小 Task 排除业务依赖问题。
6. 查看 Driver 输出和 `/tmp/ray/session_latest/logs`。
7. 多机时检查所有节点 Ray/Python 版本、网络和依赖。

## 10. 本章完成标准

你应能解释并亲自验证：

- `ray.init()` 启动或连接什么；
- `.remote()` 为什么不会直接返回结果；
- 为什么“先提交、后 `ray.get`”才能并行；
- 本机自动实例、显式集群、Ray Client 和 Ray Jobs 的区别；
- 为什么要用虚拟环境和一致版本。

下一章深入 Task，并用 `ray.wait` 构建有背压的并行程序。
