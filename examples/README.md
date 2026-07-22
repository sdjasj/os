# 配套示例

所有示例面向 Linux，单个文件尽量只突出一个机制。构建：

```bash
make -C examples -j
```

| 示例 | 观察目标 |
|---|---|
| `state_machine` | 指令、程序计数器、时间片和调度的最小模型 |
| `fork_exec` | `fork → exec → wait` 的进程生命周期 |
| `mmap_cow` | 私有映射的 COW 与共享映射 |
| `pipeline` | `pipe + dup2 + exec` 如何组成 Shell 管道 |
| `mini_malloc` | 空闲块、切分、复用和碎片 |
| `clock_user` + `libfakeclock.so` | `LD_PRELOAD` 动态符号插桩 |
| `race_counter` | 数据竞争、原子变量与互斥锁 |
| `mutex_transfer` | 锁顺序和跨对象不变量 |
| `bounded_buffer` | 条件变量与生产者—消费者 |
| `semaphore_dag` | 用信号量表达计算图依赖 |
| `parallel_sum` | 分片、线程局部结果和 false sharing |
| `epoll_timer` | 单线程事件循环复用多个事件源 |
| `device_file` | 设备文件、`read`、`fstat` 与 `ioctl` |
| `atomic_replace` | `fsync + rename + fsync(dir)` 的持久替换 |
| `wal_kv` | 可校验、可重放、容忍尾部撕裂的 WAL |
| `constant_time_compare` | 早停比较造成的计时侧信道 |
| `namespace_info` | 进程所处 namespace 和 cgroup |

基础冒烟测试（会先构建全部示例，并运行无需额外参数的示例）：

```bash
make -C examples smoke
```

动态链接示例需单独对比运行：

```bash
./examples/clock_user
LD_PRELOAD="$PWD/examples/libfakeclock.so" ./examples/clock_user
```
