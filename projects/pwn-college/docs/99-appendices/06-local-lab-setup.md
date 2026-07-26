# 06 · 本地安全实验环境

## 目标与威胁模型

实验环境的目标不是让危险操作“神奇地安全”，而是限制误操作影响并让状态可恢复。开始前写明：谁授权、允许测试哪些程序、可使用哪些输入、网络范围是什么、数据如何清理。没有授权的真实服务不因放进虚拟机就变成合法目标。

本篇假设只运行教程自建的 C/Python toy 程序，使用普通用户权限，不处理真实秘密，不连接公网目标。

## 隔离层次怎么选

| 场景 | 合适环境 | 边界与局限 |
| --- | --- | --- |
| Shell 文本与自建小程序 | 专用临时目录 + 普通用户 | 与宿主共享全部系统资源，适合低风险示例 |
| 依赖复杂、可能产生大量文件 | rootless 容器 | 与宿主共享内核；挂载与网络配置仍需谨慎 |
| 内核、驱动或不可信二进制 | 独立虚拟机 | 有独立客体内核，可做快照；仍要限制网络和共享目录 |
| 真实组织资产测试 | 专门授权环境 | 还需范围、监控、备份、变更与事件响应流程 |

容器不是虚拟机。不要使用 `--privileged`、宿主根目录挂载、Docker socket 挂载或不明设备透传来追求方便；这些配置会显著削弱隔离。

## 第一步：只读确认工具与平台

```bash
printf 'machine=%s\n' "$(uname -m)"
for tool in bash gcc gdb python3; do
    if command -v "$tool" >/dev/null 2>&1; then
        printf '%-8s %s\n' "$tool" "$(command -v "$tool")"
    else
        printf '%-8s missing\n' "$tool"
    fi
done
```

典型输出形态：

```text
machine=x86_64
bash     /usr/bin/bash
gcc      /usr/bin/gcc
gdb      /usr/bin/gdb
python3  /usr/bin/python3
```

缺少工具时按操作系统官方包管理文档安装。不要从陌生网盘复制预编译调试器，也不要为了安装方便执行来源不明的 `curl ... | sh`。

记录版本以便复现：

```bash
bash --version | sed -n '1p'
gcc --version | sed -n '1p'
gdb --version | sed -n '1p'
python3 --version
```

## 第二步：创建有标记的私有工作区

```bash
umask 077
lab_root=$(mktemp -d)
touch "$lab_root/.tutorial-lab-marker"
mkdir "$lab_root/src" "$lab_root/bin" "$lab_root/logs" "$lab_root/public"
printf 'lab=%s\n' "$lab_root"
stat -c 'mode=%A owner=%U path=%n' "$lab_root"
```

预期输出形态：

```text
lab=/tmp/tmp.xxxx
mode=drwx------ owner=alice path=/tmp/tmp.xxxx
```

`umask 077` 让随后创建的对象默认不向组和其他用户开放；标记文件用于清理前确认目标确实由本流程创建。临时目录仍不是秘密保险箱，敏感数据不应进入教程环境。

## 第三步：隔离 Python 依赖

```bash
python3 -m venv "$lab_root/venv"
. "$lab_root/venv/bin/activate"
python -m pip install --upgrade pip
python -m pip install pwntools
python -c 'import sys, pwnlib; print(sys.executable); print(pwnlib.__version__)'
```

预期输出形态：

```text
/tmp/tmp.xxxx/venv/bin/python
4.15.0
```

版本可能更新。安装会访问配置的 Python 包索引；受控环境应使用组织批准的镜像、哈希或锁文件。虚拟环境隔离 Python 包，不隔离系统调用、文件系统或网络。

## 第四步：编译自建 toy 程序

保存以下内容为 `$lab_root/src/sanity.c`：

```c
#include <stdio.h>

int main(void) {
    int values[] = {2, 3, 5};
    int sum = values[0] + values[1] + values[2];
    printf("sum=%d\n", sum);
    return sum == 10 ? 0 : 1;
}
```

编译、检查、运行：

```bash
gcc -Wall -Wextra -O0 -g -fno-omit-frame-pointer \
  -o "$lab_root/bin/sanity" "$lab_root/src/sanity.c"
file -- "$lab_root/bin/sanity"
"$lab_root/bin/sanity"
printf 'exit=%d\n' "$?"
```

预期输出形态：

```text
/tmp/tmp.xxxx/bin/sanity: ELF 64-bit LSB ... with debug_info, not stripped
sum=10
exit=0
```

`-O0 -g` 适合源码级调试；它不是生产构建建议。可另建 AddressSanitizer 版本观察自有程序的内存错误：

```bash
gcc -Wall -Wextra -O1 -g -fsanitize=address,undefined \
  -o "$lab_root/bin/sanity-asan" "$lab_root/src/sanity.c"
```

Sanitizer 会改变内存布局和时序，报告也可能包含路径；不要把它当成证明“没有漏洞”的工具。

## 第五步：网络默认关闭，需要时只用回环

为演示本机 HTTP，可启动只绑定 IPv4 回环的 toy 服务：

```bash
printf 'local only\n' > "$lab_root/public/index.txt"
python3 -m http.server 18080 \
  --bind 127.0.0.1 \
  --directory "$lab_root/public" \
  >"$lab_root/logs/http.log" 2>&1 &
server_pid=$!

curl --fail --silent http://127.0.0.1:18080/index.txt
kill "$server_pid"
wait "$server_pid" 2>/dev/null || true
```

预期输出：

```text
local only
```

端口被占用时服务会退出，应检查日志和 PID，而不是改成 `0.0.0.0`。`127.0.0.1` 限制在本机 IPv4 回环；容器有自己的网络命名空间时，“本机”指容器自身，端口发布规则仍需单独审查。

## VM 与容器检查表

- VM 创建无秘密的基线快照，关闭剪贴板、拖放和非必要共享目录。
- 默认无外网或仅允许安装依赖所需的受控出口。
- rootless 容器使用只读根文件系统与独立临时卷，不传入宿主凭据。
- 限制 CPU、内存、进程数和磁盘，避免失控程序拖垮宿主。
- 不复用生产 SSH 密钥、云凭据、浏览器配置或真实数据集。
- 恢复快照后重新检查补丁与依赖版本，快照不是永远安全的时间胶囊。

## 可恢复清理

先停止由本实验启动的子进程，退出虚拟环境，再验证标记和目标：

```bash
deactivate 2>/dev/null || true

if test -n "${lab_root:-}" \
   && test -d "$lab_root" \
   && test -f "$lab_root/.tutorial-lab-marker"; then
    printf 'removing lab=%s\n' "$lab_root"
    rm -r -- "$lab_root"
else
    printf 'refusing cleanup: lab marker missing\n' >&2
fi
```

清理前仍应确认打印路径。标记只防止部分变量错误，不抵御工作区被恶意篡改；高风险样本应直接回滚隔离 VM，而不是依赖宿主脚本删除。

## 常见误区

- 普通用户、容器、VM 是层层减小影响面的工具，不等于获得目标授权。
- NAT 不代表无网络；客体仍可能主动访问公网。
- `127.0.0.1` 与 `0.0.0.0` 不同，后者通常在所有接口监听。
- 挂载宿主源码为可写会让客体修改真实文件。
- 快照恢复不了已外发的数据，也不会撤销对外部服务造成的影响。
- 调试日志、core dump 和 shell history 可能保存输入与内存中的敏感数据。

## 相关参考

- [Python `venv` 官方文档](https://docs.python.org/3/library/venv.html)
- [GDB 参考](./04-gdb-reference.md)
- [pwntools 参考](./05-pwntools-reference.md)

---

[← 上一篇：pwntools 参考](./05-pwntools-reference.md) · [附录索引](./README.md) · [下一篇：术语表 →](./07-glossary.md)
