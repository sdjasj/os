# 文件系统 API (1)

# Review & Comments

## 存储 (block) 设备的抽象

  - `read_block(id)`
  - `write_block(id, data)`
      - 剩下的复杂性就不用你操心了
      - 设备上专门有一台计算机来处理这些请求 (FTL, …)

## 让进程直接访问设备文件？

  - `open("/dev/mmcblk0p1", O_RDWR);` 然后 lseek
  - 那不就全乱套了吗！
  - 我们需要一个**抽象层**：文件系统
      - 这次课：人类使用的文件系统 API
      - 下次课：程序 (AI Agent) 使用的文件系统 API

## 1\. 从块设备到文件系统

# Abstract Data Type (数据结构)

## 地址空间上的数据结构抽象

  - 物理内存 random access `char[]` → 虚拟内存和 mmap → malloc(), free() → list, set, map, …
  - 既然可以在 RAM 上实现 AbstractDataType，没道理不能在磁盘上实现
      - 无非就是 block v.s. word 访问的区别

## 存储设备应该抽象成什么？

  - 内存 → 虚拟内存；磁盘 → 虚拟磁盘 (字节序列 `vector<char>`)
      - 转了一圈，又回到 virtualization 了
      - 文件 (file): 文字、符号固定于纸张等载体上的信息记录
      - 支持 read, write, lseek, ftruncate, … 的 hello.c, a.out, …
  - 新需求：怎么**管理**系统中众多的文件？
      - 对人类来说，pid 已经是一个很糟糕的抽象了
      - 如果再来一个 fid 就全乱套了

# 设备的抽象：目录树

## 管理文件的方法：建一个图书馆！

  - 背后的原理：信息的局部性
  - 系统中的文件可以组织成**层次索引**结构

![](../site_html/static/img/nju-lib.jpg)

# 树状分层索引：利用信息的局部性

    .
    └── 学习资料
        ├── .
        ├── ..
        ├── .学习资料(隐藏)
        ├── ……
        └── 操作系统

  - 隐藏 “.” 开头的文件不是操作系统的行为，只是为了**偷懒**
      - 这是一个非常强大的抽象，我已经把完整的 “database” 交给 AI 了

    while ((entry = readdir(dir)) != NULL) {  // busybox/coreutils/ls.c
          if (entry->d_name[0] == '.') {
          if (!(option_mask32 & (OPT_a|OPT_A))) continue;
            if (!(option_mask32 & OPT_a) && (!entry->d_name[1] || (entry->d_name[1] == '.' && !entry->d_name[2])) continue;
        }

# 设备 = 目录树

## 然而，系统中不止一个存储设备

  - **每个设备、每个 partition 都是一个目录树**
      - `/dev/nvme0n1p1` (Namespace 1, Partition 1), 优盘、网络 (WebDAV)
  - 操作系统设计者首先要面对 “文件系统” 对象的管理

## Windows

  - 所有操作系统对象的根 `\`, 例如 `\Device\HarddiskVolume1`, `\Driver\Ntfs`
      - `\\`: Universal Naming Convention 路径 (网络)
      - `\\server\share` → `\Device\LanmanRedirector\server\share`
      - 这个 `\` 不能 cd，但可以用 API 访问

    HANDLE hDevice = CreateFile(
        "\\\\.\\PhysicalDrive0", GENERIC_READ | GENERIC_WRITE,
        FILE_SHARE_READ | FILE_SHARE_WRITE, NULL, OPEN_EXISTING, 0, NULL);

  - 盘符 (历史遗留问题): `A:\`, `B:\`, `C:\`, …
      - 实际上是 `\??\C:\` (`\??` 是 per-user 的命名空间)
      - Windows 为用户隐藏了巨量的复杂性

# 从无到有的目录树

## 操作系统需要提供一个 API，把设备的目录树 “放” 到世界里

  - 最小 Linux 启动时，只有 initramfs 和 `/dev/console`
      - mount: 把**块设备**上的目录树 “放到” **目录**中
      - `mount -t iso9660 /dev/cdrom /mnt/cdrom`; UDF (DVD, Blue-Ray)
          - [util-linux](https://github.com/util-linux/util-linux) 会检测文件系统，最终会调用 mount 系统调用
          - ISO 9660 就是一种 “数据结构” (我带了，可以让 AI 读一下)

    struct iso9660_primary_descriptor {
        uint8_t  type;              /* ISO9660_VD_PRIMARY */
        char     standard_id[5];    /* 必须是 "CD001" */
        ...
        char     system_id[32];     /* 系统标识符 (如 "Win32", "LINUX") */
        char     volume_id[32];     /* 卷标识符 (光盘名称) */ ...

# [最小 Linux](/OS/demos/virtualization/linux-minimal)

我们完全可以构建一个 “只有一个文件” 的 Linux 系统——Linux 系统会首先加载一个 “init RAM Disk” 或 “init RAM FS”，在作系统最小初始化完成后，将控制权移交给 “第一个进程”。借助互联网或人工智能，你能够找到正确的文档，例如 [The kernel’s command-line parameters](https://www.kernel.org/doc/html/latest/admin-guide/kernel-parameters.html) 描述了所有能传递给 Linux Kernel 的命令行选项。

# Aside: 挂载一个文件

## mount 必须要求一个**块设备**

  - 那 [fs.img](https://box.nju.edu.cn/f/0764665b70a34599813c/?dl=1) 怎么办呢？
  - 答案：创建一个 loopback (回环) 设备
      - 设备驱动把设备的 read/write 翻译成文件的 read/write
      - [drivers/block/loop.c](https://elixir.bootlin.com/linux/latest/source/drivers/block/loop.c)
          - 实现了 loop\_mq\_ops (不是 file\_operations)

## 观察挂载文件的 strace

  - lsblk 查看系统中的 block devices (strace)
  - strace 观察挂载的流程
      - `ioctl(3, LOOP_CTL_GET_FREE)`
      - `ioctl(4, LOOP_SET_FD, 3)`

# Filesystem Hierarchy Standard

> [FHS](http://refspecs.linuxfoundation.org/FHS_3.0/fhs/index.html) enables software and user to predict the location of installed files and directories.

  - 例子：macOS 是 UNIX 的内核 (BSD), 但不遵循 Linux FHS

![](../site_html/static/img/fhs.jpg)

## 2\. 目录树 API

# 目录树 API

## “增删改查”

  - mkdir: 创建目录
  - rmdir: 删除目录
  - getdents: 读取目录

    int mkdirat(int dirfd, const char *pathname, mode_t mode);
    int unlinkat(int fd, const char *path, int flag);
    ssize_t getdents64(int fd, void *dirp, size_t count);

  - 看看 `bash -c 'echo /etc/**/*'` 的 strace
      - 更多的工具，例如 fzf 也是同样的实现
      - “Globbing”

# [globbing](/OS/demos/persistence/globbing)

在 pstree 中，我们实现了目录树的遍历——我们几乎总是需要对底层文件系统 API 的封装，例如十分方便的 [glob()](https://www.gnu.org/software/libc/manual/html_node/Calling-Glob.html)。Globbing 也是 Agent 的 “四大技能”，Read, Write, Grep, Glob; 加上 Bash 就可以完成几乎所有的运维工作了。

# 硬 (hard) 链接

## 需求：系统中可能有同一个运行库的多个版本

  - `libc-2.27.so`, `libc-2.26.so`, …
  - 还需要一个 “当前版本的 libc”
      - 程序需要链接 “`libc.so.6`“，能否避免文件的一份拷贝？

## (硬) 链接：允许一个文件被多个目录引用

  - 文件系统实现的特性 (ls -i 查看)
      - 不能链接目录、不能跨文件系统
      - 删除文件的系统调用称为 “unlink” (refcount–)
          - 现在用 “万能” 的 unlinkat，也可以删除空目录
  - 所以和 pid 一样，fid 也是存在的
      - (只是用于文件系统内部的实现)

# 软 (symbolic) 链接

## 软链接：在文件里存储一个 “跳转提示”

  - 软链接也是一个文件
      - 当引用这个文件时，去找另一个文件
      - 另一个文件的绝对/相对路径以文本形式存储在文件里
      - 可以跨文件系统、可以链接目录、……

## 几乎没有任何限制

  - 类似 “[快捷方式](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-shllink/)”
      - 快捷方式比你想象的复杂：文件重命名、移动、U 盘驱动器号改变……都能正确找到 (???)
      - 为解决一个问题带来了更多问题 😂
  - 甚至可以用来制作 Galgame
      - 今年已经改成 Agentic Design Harness 了

# [Symlink Game](/OS/demos/persistence/ggmaker)

我们可以使用符号链接创建 “近乎任意” 的目录结构，包括任意的图结构 (状态机)，操作系统也能正确解析。操作系统的机制 (系统调用、文件系统……) 给了我们无限的创作空间。

# 软连接：还可以用来 “伪造” 文件系统！

## [Nix](https://nixos.org/): 这个题我会

  - **把所有软件包的所有版本都集中存储**
  - `/nix/store/b6gvzjyb2pg0kjfwrjmg1vfhh54ad73z-firefox-33.1`
      - 然后用符号链接构建一个完全虚拟的环境
          - 完全的 deterministic: 由软件包的 hash 决定
  - 可以随时随地构建 “任意” 环境
      - `nix-shell -p python3 nodejs`

## 这是一个 persistent data structure 啊

  - 还记得吗？random read + append-only write = 任意数据结构
      - /nix/store 是 “只增不减” 的，符号链接就是 random read
      - 对比 apt: 所有的修改都是 in-place 的
  - 随时回滚 `nix-shell -p $(nix-env --list-generations | grep "3 days ago")`
  - 随地构建 `nix-env --switch-generation` 后直接测试

## 3\. 文件的元数据

# 为文件增加属性

## 软件 = 物理世界在信息世界的投影

  - 我们还希望 “byte array” 有自己的 “personality”
      - “隐藏” (1): `.学习资料` 实际存在、API 可以访问、命令行工具默认不显示
          - 我们实际想要的：只有我自己在用电脑就不要隐藏，其他时候都要隐藏
          - (但现在计算机不支持表达这样的 policy；**这就是革命的机会**)
      - “隐藏” (2): /proc/\[tid\] 实际存在，但 getdents 看不到 (让 AI “看” 吧)

## `ls -l`: 查看对象的属性

    $ ls -l example.txt
    -rw-r--r-- 1     alice staff 1024 Mar 10 12:34 example.txt
    mode       link  owner group size modified     name

  - Type: d (directory), l (link), p (pipe), c (char), b (block)
  - Mode: rwx (user, group, other)
      - 例子：0o755 = rwx (111) r-x (101) r-x (101)
  - Links: 引用计数 (硬链接，包括目录)

# 更多的元数据

## Extended Attributes (xattr)

    ssize_t fgetxattr(int fd, const char *name, void value[.size], size_t size);
    int fsetxattr(int fd, const char *name, const void value[.size], size_t size, int flags);

  - 每个文件可以维护一个任意的 key-value dictionary
  - 例子：macOS 的 com.apple.metadata 会保存每个互联网下载文件的 url

## “好用不火” 的操作系统特性

  - 文件系统的向量索引：[vectorfs](https://vectorvfs.readthedocs.io/en/latest/)
      - vfs search cat static/Photos/ | claude -p –summary
      - 这不比 iPhone 的 Photo Search 好用多了？
  - **致命的缺陷**：这是后加的特性
      - 不是所有的文件系统都支持
      - 兼容性奇差 (cp 需要 –preserve=xattr 才能保留 xattrs)

# Access Control List (访问控制列表)

## 比 user, group, other 更精细的访问控制

  - 格式
      - \[d:\]<span class="underline">:name:perms</span>
  - 用法
      - setfacl -m u:jyy:— file
      - getfacl file
  - (Access Control 专门用一次课讲)

## “在没有直接经验的领域（如语言、技术、框架等）进行有质量保证的编程工作”

  - 如果你希望实现一个 “飞书文档”，ACL 就是一个很好的选择
  - 你知道了 “fine-grained access control” 是可以的
      - 在需要的时候，你能启发 AI 想到这一点

### 3.1. Aside: 面对未知

# 如何应对海量的信息？

## The Scaling Law

  - Pre-training, SFT 和 test-time scaling (深度思考中)
  - “Kolmogorov complexity modulo experts” (Timothy Gowers)

![](../site_html/static/img/kcme.png)

# “目录树” 也是个妥协

## 图书馆的索引系统其实可以淘汰了

  - 一本书的**内容**就是它的索引
  - 摄像头可以确定任何一本书的位置
      - 路径 → 结构化查询 (wildcard & globbing) → 智能检索

![](../site_html/static/img/photo-search.jpg)

# Takeaways

目录 (链接) 和文件 (对象) 的简洁抽象赋予了我们管理对象的能力。操作系统的设计者也扩展了文件的元数据，使我们能给文件打上复杂的标签，从而使应用程序 (和操作系统) 提供更好的服务。

# 阅读材料

教科书 Operating Systems: Three Easy Pieces:

  - 第 37 章 - Files and Directories
  - 第 53 章 - Intro Security (不在考试范围)
  - 第 54 章 - Authentication (不在考试范围)
  - 第 55 章 - Access Control
