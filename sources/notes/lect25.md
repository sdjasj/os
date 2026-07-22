# 文件系统 API (2)

# Review & Comments

## 文件系统 API

  - 目录树管理 (mount, umount)
  - 增删改查
      - 目录树：mkdir, rmdir, getdents
      - 链接：link, symlink
      - 元数据：mode, xattr, ACL
  - 都是 “**简单的一小步操作**”

## 是时候设计真正的 “文件系统” API 了

  - 回到一个根本问题：文件系统作为一个 Abstract Data Type 还可以支持怎样的操作？
      - 数据结构中的例子：持久化数据结构的 “时间回溯”、子集的整体操作……

## 1\. 监控

# “监控” 的需求

## 在文件系统改变以后通知我

  - 最好告诉我什么什么文件变了
  - Web server: 如果代码改了需要重新加载
      - Flask, next.js, … 的 debug mode 都支持这个功能

## 用 CRUD 实现：获取一个 last modified 列表

    diff <(stat -c '%n %y' **) <(sleep 2; date > a.txt; stat -c '%n %y' **)

  - 但如果目录里有几百万个文件……
      - “数据结构” 是支持 O(d) 的各类修改操作的 (包括 notify)

# 实现文件系统监控

## inotify (7)

    int inotify_init(void);  // 返回 fd
    int inotify_add_watch(int fd, const char *pathname, uint32_t mask);

## Python watchdog

    observer = Observer()  # PollingObserver()
    observer.schedule(event_handler, ".", recursive=True)
    observer.start()

  - 如果只有 CRUD API，就需要遍历 + 对比时间戳
      - 也可以让 AI 对比使用 PollingObserver 和 Observer 时候的 strace

# [watchdog](/OS/demos/persistence/watchdog)

文件系统提供 “监控” 的 API (`inotify` / `FSEvents` 等)，使应用程序无需轮询即可响应文件变化。Python [watchdog](https://github.com/gorakhargosh/watchdog) 库可以递归监听目录。

# 实现文件系统监控 (cont’d)

## “任何监控” 都是可以实现的

  - strace, ltrace, inotify, …
  - 本质上是从 “操作系统内核执行” 提取信息
      - 理想情况：插入一个 programmable 的 probe
      - 恭喜你，你发明了 eBPF (Extended Berkeley Packet Filter)
  - 例子：bio-trace.bt

## eBPF VM: 轻量级 in-kernel “只读” 虚拟机

  - RISC like, r0-r10 11 个寄存器
      - 在 probe 入口执行，r1 指向 context 结构体
      - `BPF_CALL <helper>`:`bpf_get_current_pid_tgid()`, `bpf_map_lookup_elem()`, …, side-effect 严格可控
  - 严格的验证器，只允许 bounded execution (当然是[有 bug](https://blog.igns.top/posts/ebpf-promises/) 的 😂)

# [打开 Linux Block I/O](/OS/demos/persistence/bio)

让我们借助 Coding Agent，“在没有直接经验的领域（如语言、技术、框架等）进行一些编程工作” 吧！虽然我作为《操作系统》的教师，知道 Linux 内核内部的机制，但我决定在对话时假装自己对系统内的这些机制一无所知。模型：deepseek-v4-pro (high)，成本：¥ 0.72。

# 一些反思

## 问一问 AI

    diff <(stat -c '%n %y' **) <(sleep 2; date > a.txt; stat -c '%n %y' **)

  - “允许使用任意 Linux 机制，有没有高效的实现方法？”
      - 所有的模型都知道：我们不用知道 inotify 和 eBPF

## 机制与策略的彻底分离

  - Specification is all you need\!
      - 你要的是 “一个 `diff <() <()` 的等价高效实现”
      - [The time is here for just-in-time systems: challenges and opportunities](https://arxiv.org/abs/2605.24096): LLM-based coding agents now make a different approach tractable: Just-in-Time Systems, in which the entire system is synthesized from scratch, specialized to the environment, workload, and required system properties.

## 2\. 快照

# 在文件系统上实现快照

## Random read + append-only write = 持久化数据结构

  - Git: 这个题我懂，我就是一个**持久化数据结构**
  - 持久化数据结构的好处：
      - git reflog 包含所有的历史 trees, commits, etc.
      - 除了 `git reset --hard` 清除的工作区，只要不 git gc 都可以恢复！

## Git 的三大类对象 (直接存储在 `.git/objects/`)

  - blob: `blob [length] \0[content]`
  - tree: `[mode] [filename]\0[hash]\n...`
  - commit: `tree [hash]\nparent [hash]...`
      - 它们是**压缩存储**的
      - 让 AI 帮我们做一个 `ls .git/objects/*/* | xargs ./git-cat`

# Git: 数据结构操作

## 分支和提交

  - `refs/heads/[branch]` 是指向 commit object 的指针
  - `git checkout -b new` → 新建一个 new 的文件 (指针)
  - `git commit` → 创建 tree/commit object → 更新 `refs/heads/[branch]`

## HEAD “指针的指针”

  - .git/HEAD 文本文件 `ref: refs/heads/main`
  - 我们可以 “依葫芦画瓢” 创建一个 TAIL (commit object hash)
      - git diff HEAD TAIL
  - git checkout 就是改 HEAD (可以 HEAD detach)

## Stash: refs/stash 下的 detached commit

  - Stash commit 有两个 parent: HEAD 和 next stash
  - 让 AI 阅读 `.git/**/*`，绘制 object 和 refs 数据结构图

# 处理分叉的 Commits

## Common Ancestor 上的分叉

  - Local: CA → A → B
  - Remote: CA → C → D
      - Merge: 增加一个 E 节点，合并 B & D
      - Rebase: CA → C → D → A’ → B’
      - 如果本地没有 A 和 B，可以 fast-forward: CA → C → D

## Rebase: A’ 和 B’ 是怎么来的？

    git reset --hard D
    git cherry-pick A  # git diff CA A | git apply
    git cherry-pick B  # git diff A B | git apply

  - “变基” 是很危险的操作 😂
      - 自动 cherry-pick 冲突，基本就得放弃 (退回到 merge)
      - 即便成功，也可能隐藏逻辑冲突的炸弹，一定要回头 review 代码

# 历史总在重演

## Git 是为单线程设计的

  - 还记得 UNIX: 进程 → 线程 (魔鬼的盒子) 吗？
  - Git: 一个工作区，一个 HEAD，线性的 commit/stash/branch
      - 但我有 “多线程并发” 的需求
          - 多次被要求紧急切换到优先级更高的 feature 分支上修 bug (git stash 地狱 😭)

## Worktree (Since 2015, Git 2.5)

  - Persistent data structure 管理的是**快照**！

    git worktree add ../experiment  # 在另一个目录切换到 experiment 分支
    cat ../experiment/.git  # 又是一个 “指针”

  - 这个 feature 在 Agent Swarm (test-time scaling) 时代是刚需
      - Sub-agents，在干净的 branch 上提交，主 agent 负责 merge

# 文件系统级的快照

## 干脆用 persistent data structure 实现文件系统吧？

  - 你能想到的事情，一定会有人试图实现的
      - btrfs: `ioctl(fd, BTRFS_IOC_SNAP_CREATE, ...);`

![](../site_html/static/img/btrfs-cow.png)

## 3\. 覆盖

# 目录的“拼凑”

## 一个神奇的 idea: 你看到的目录，可以是 “拼凑” 出来的

  - 把 upper/ 和 lower/ 拼起来，形成一个 “假” (虚拟化的) 目录
      - 所有的写入都会写到 upper/
      - 重名的，优先看到 upper/ 的版本

## Killer Application (1): 光盘打包

  - 刻盘工具 `burn /path-to-dir/ /dev/cdrw0`
  - 现在你要为每一个写入不同的 CD-Key
      - 16 个 cdrw drives，同一个 lower，但 verify-key.exe 是不同的

## Killer Application (2): 试升级

  - 害怕 sudo apt dist-upgrade 吗？
  - 系统 “试运行” (overlayroot)，直接 rsync 就可以 commit 了

# OverlayFS (“UnionFS”, 联合挂载)

    mount -t overlay overlay \
        -o lowerdir=L1:L2:...,upperdir=U,workdir=W \
        path_to_merged

## 一些有趣的行为

  - workdir 是文件系统内部使用的临时空间 (用于实现原子性)
  - 只允许一个 upper，但可以有多个 lower
  - 在 merged 里删除 lower 的文件，会在 upper 里创建一个 “whiteout” 文件
      - 终于可以是实现 “网吧管理” 了 (再也不用担心用户破坏电脑了)
          - 考试机的 /home 是个 overlay，“系统一键还原” 也搞定了

# [OverlayFS](/OS/demos/persistence/overlay)

一种联合文件系统，允许将多个目录 “层叠” 在一起，形成单一的虚拟目录。OverlayFS 是容器 (如 docker) 的重要底层机制。它也可以用于实现文件系统的快照、原子的系统更新等。

# Docker 的多层 Overlay

    FROM ubuntu:22.04
    ENV DEBIAN_FRONTEND=noninteractive
    ...
    RUN apt-get update
    RUN apt-get install -y ... && apt-get upgrade -y

  - 每一次 RUN 都会创建一个 layer
      - 从文件系统角度，RUN 工作在 upper 上
      - 这个 upper 会 “增加” 到下一次 RUN 的 lower stack 顶部
  - 如果发现还想增加一个包？
      - 不应该修改 RUN 的参数，而是应该增加一个 RUN

## 4\. 终极的虚拟化

# 文件系统 = 数据结构

## 我们早就学过数据结构了！

  - 凭什么不能直接写一个 fs.c 实现文件系统？
      - **你能想到的，就一定能做到**
      - Filesystem in User Space (FUSE): 内核把 lookup, read, write, … 转发到 FUSE driver

## 只要实现 [struct fuse\_operations](https://libfuse.github.io/doxygen/structfuse__operations.html) 就行

  - 甚至有 `int (*setxattr)(const char *, const char *, const char *, size_t, int)`
  - 从此文件系统不再是 CRUD
      - 你可以不受任何约束地实现 “任意数据结构”
      - 例子：/proc 里的真正 “隐藏” 目录

# FUSE Hacks

## 把任何远端变成文件系统

  - sshfs: 远程目录变成本地目录
  - aitfs: 远程 git 仓库变成本地目录
  - dbfs: 由数据库作为存储的 “安全” 文件系统
      - 借助 FUSE 可以直接在不一致的文件系统上实现强一致性

## 甚至还可以把任何数据改造成文件系统接口

  - [ffs](https://mgree.github.io/ffs/): 把任何 “数据库” (json, …) 变成文件系统
      - 一瞬间 UNIX 世界里的一切命令行工具都可以使用了

## 甚至可以实现 “非常规” 的文件系统操作

  - 实现 `.学习资料114514` 的真正隐藏：getdents64 无法看到，但可以 cd 进入
  - ggfs: Galgame 也可以做成文件系统！
      - “Everything is a file 的终极实现”

# [Symlink Game](/OS/demos/persistence/ggmaker)

我们可以使用符号链接创建 “近乎任意” 的目录结构，包括任意的图结构 (状态机)，操作系统也能正确解析。操作系统的机制 (系统调用、文件系统……) 给了我们无限的创作空间。

# Takeaways

如果我们摆脱 “块设备” 的固有印象，把文件系统看作是数据结构，就可以不受约束地设计出有趣的操作系统机制：监控 (inotify)、快照 (git/btrfs)、覆盖 (OverlayFS)，甚至是彻底的定制化文件系统 API。
