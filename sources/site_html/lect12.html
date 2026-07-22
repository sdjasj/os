<!DOCTYPE html><html><head><meta charSet="utf-8"/><meta name="viewport" content="width=device-width"/><title>Lecture Notes</title><link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css"/><link rel="stylesheet" href="//cdnjs.cloudflare.com/ajax/libs/highlight.js/11.6.0/styles/default.min.css"/><meta name="next-head-count" content="5"/><link rel="preload" href="/_next/static/css/f1360f1f2c658522.css" as="style"/><link rel="stylesheet" href="/_next/static/css/f1360f1f2c658522.css" data-n-g=""/><noscript data-n-css=""></noscript><script defer="" nomodule="" src="/_next/static/chunks/polyfills-c67a75d1b6f99dc8.js"></script><script src="/_next/static/chunks/webpack-91af2217067b1eba.js" defer=""></script><script src="/_next/static/chunks/framework-fdf20b67f7acabe0.js" defer=""></script><script src="/_next/static/chunks/main-3929bf55b0f13a18.js" defer=""></script><script src="/_next/static/chunks/pages/_app-00b06920b385caf1.js" defer=""></script><script src="/_next/static/chunks/552-69764e03c4955849.js" defer=""></script><script src="/_next/static/chunks/pages/%5B%5B...index%5D%5D-7ab9411a70c105bc.js" defer=""></script><script src="/_next/static/5oc85hUK-mNqby8Yf0bnI/_buildManifest.js" defer=""></script><script src="/_next/static/5oc85hUK-mNqby8Yf0bnI/_ssgManifest.js" defer=""></script></head><body><div id="__next"><div class="bg-slate-300/10"><div class="sticky top-0 z-40 w-full backdrop-blur flex-none border-b border-slate-900/10 bg-white/75 supports-backdrop-blur:bg-white/60"><div class="max-w-8xl mx-auto"><div class="py-4 border-b border-slate-900/10 lg:px-8 lg:border-0 dark:border-slate-300/10 mx-4 lg:mx-0"><div class="relative flex items-center"><a href="/">Yanyan&#x27;s wiki</a><form class="text-xs text-slate-500"> for <input type="text" name="token" class="font-mono text-xs w-16" maxLength="8"/></form><div class="relative hidden lg:flex items-center ml-4 pl-4 border-l"><nav class="text-sm leading-6 font-semibold text-slate-700 dark:text-slate-200"><ul class="flex space-x-8"><li><a class="hover:text-sky-500 dark:hover:text-sky-400" href="/OS/2026/">操作系统 (2026 春)</a></li></ul></nav></div></div></div></div></div><div class="container mx-auto max-w-5xl flex flex-col min-h-screen px-4"><div class="wiki-new bg-neutral-200/10"><div><h1> 构建应用生态 (Hacking Day)
 </h1>
<div class="slideshow" name="review_and_comments"><div>
<h1 id="review-comments">Review &amp; Comments</h1>
<h2 id="_1">链接和加载</h2>
<ul>
<li>本质讲的是 execve 的行为<ul>
<li>继承文件描述符、singal hander 等</li>
<li>加载 ELF 文件 (数据结构) 和 INTERP 的所有 PT_LOAD, PT_GNU_STACK, PT_TLS …</li>
<li>设置进程的初始状态 (栈上的 argc, argv, envp, auxv、寄存器)</li>
<li>加上库函数的行为 (musl; ld-linux.so; …) 你就理解了操作系统的一切</li>
<li>Shebang (#!)</li>
</ul>
</li>
<li>惊喜：这么复杂的东西，其实也 “不过如此”</li>
</ul>
<h2 id="_2">回到应用视角的操作系统</h2>
<ul>
<li>这个学期到现在一直在讲 “系统调用的行为”</li>
<li>课程的目标：<strong>阅读手册、指导 AI 写代码来理解任何系统调用</strong>，并且弄清楚<strong>为什么要这样设计</strong>
</li>
</ul>
</div></div>

<h2> 1. 见证历史
 </h2>
<div class="slideshow" name="evolution_of_unix"><div>
<h1 id="_1">这些系统调用是怎么来的？</h1>
<h2 id="dennis-m-ritchie-evolution-of-the-unix-time-sharing-system">Dennis M. Ritchie: <a href="https://read.seas.harvard.edu/~kohler/class/aosref/ritchie84evolution.pdf">Evolution of the UNIX Time Sharing System</a>
</h2>
<ul>
<li>最早的版本甚至没有 fork()<ul>
<li>Shell 关闭所有打开的文件，然后为 0, 1 fd 打开终端文件</li>
<li>从终端读取命令行</li>
<li>打开文件，把加载器代码复制到内存并执行 (相当于 exec)</li>
<li>exit 会重新加载 shell<ul>
<li>Takeaway message: 不要害怕 “不好”，大胆去做，并且持续改进</li>
</ul>
</li>
</ul>
</li>
</ul>
<h2 id="andrew-s-tanenbaum-minix">Andrew S. Tanenbaum: <a href="http://minix3.org">Minix</a>
</h2>
<ul>
<li>Minix1 (1987): UNIXv7 兼容，也是 Linus 实现 Linux 的起点</li>
<li>Minix2 (1997): POSIX 兼容，随书送代码</li>
<li>Minix3 (2006): POSIX/NetBSD 兼容，全功能，一度是世界上应用最广的操作系统 (Intel ME)</li>
</ul>
</div></div>

<div class="slideshow" name="my_dream_start"><div>
<h1 id="_1">我 “梦开始的地方”</h1>
<p><img alt="" src="static/img/minix2-book.jpg"></p>
</div></div>

<div class="slideshow" name="minix3"><div>
<h1 id="minix3">Minix3</h1>
<p><img alt="" src="static/img/minix3-desktop.png"></p>
</div></div>

<div class="code-card" path="virtualization/minix"><div><div>
<h1 id="minix"><a href="/OS/demos/virtualization/minix">Minix</a></h1>
<p>Minix 是 UNIX 之后的经典教学操作系统，Andrew Tanenbaum 也因此成就了一代计算机系统研究者。代码来自 <a href="https://github.com/davidgiven/minix2">Minix 1 and 2, Quick and Dirty editions</a>。</p>
</div></div>
</div>
<div class="slideshow" name="birthday_of_linux"><div>
<h1 id="linux-1991-8-25">Linux 的诞生 (1991 年 8 月 25 日)</h1>
<blockquote>
<p>Hello, everybody out there using minix – I’m doing a (free) operating system (just a hobby, won’t be big and professional like gnu) for 386(486) AT clones. This has been brewing since April, and is starting to get ready.</p>
<p>—— Linus Torvalds (时年 21 岁)</p>
</blockquote>
<h2 id="oslab">类似于 “我写了个加强版的 OSLab，现在与大家分享”</h2>
<ul>
<li>发布在 comp.os.minix（“百度贴吧”），依赖 Minix 的工具链；运行 GNU gcc, bash, …</li>
<li>
<strong>机缘巧合：合适的人、合适的时间</strong>: Frank Rosenblatt 的 <a href="https://homepages.math.uic.edu/~lreyzin/papers/rosenblatt58.pdf">Perceptron paper</a>
</li>
</ul>
<p><img alt="" src="static/img/perceptrons.png"></p>
</div></div>

<div class="slideshow" name="famous_scenes"><div>
<h1 id="_1">诞生了不少名场面</h1>
<h2 id="the-single-worst-company-weve-ever-dealt-with-2012">“The single worst company we’ve ever dealt with…” (2012)</h2>
<ul>
<li>Alex Krizhevsky, Ilya Sutskever, Geoffrey Hinton 还在搞 AlexNet<ul>
<li>AlphaGo (2015), GPT-3 (2020), …</li>
<li>我还在读 PhD，抱怨 CUDA 编程模型很反人类</li>
</ul>
</li>
<li>天道好轮回：能想象 NVDA 是现在市值最高的公司？</li>
</ul>
<p><img alt="" src="static/img/linus-nv.jpg"></p>
</div></div>

<div class="slideshow" name="just_for_fun"><div>
<h1 id="just-for-fun">“Just for fun”</h1>
<h2 id="the-story-of-an-accidental-revolutionary">The story of an accidental revolutionary</h2>
<blockquote>
<p>Revolutionaries aren’t born. Revolutions can’t be planned. Revolutions can’t be managed. Revolutions happen....</p>
<p>—— David Diamond (本书作者)</p>
</blockquote>
<h2 id="202512">
<a href="http://www.moe.gov.cn/jyb_xwfb/gzdt_gzdt/moe_1485/202512/t20251203_1422209.html">全国高校科技创新工作会议暨基础学科和交叉学科突破计划启动部署会召开</a> (2025.12)</h2>
<ul>
<li>……要提高政治站位，勇担国家使命，精心谋划一批重大战略任务、重大政策举措和重大工程项目，聚焦战略领域、关键要素，构建有效评价指标，努力形成一批标志性成果，加快把高校的资源优势转化为竞争优势……<ul>
<li>
<a href="https://mp.weixin.qq.com/s/P8Wgpy9wscMB4ddDiz9RNg">我的博导也是干摩托车发动机的，他为什么没干出来</a>：因为我在 “人-机-物融合时代实现操作系统的弯道 (换道) 超车” 🤔</li>
</ul>
</li>
</ul>
</div></div>

<div class="slideshow" name="linux_is_obsolete"><div>
<h1 id="_1">质疑、回应与时代的车轮</h1>
<h2 id="composminix-linux">在 comp.os.minix 上关于 Linux 的讨论越来越多了</h2>
<ul>
<li>Andrew Tanenbaum 做出了 “官方回应”，觉得 “太落后”</li>
<li>Linus 完全不服气：<a href="https://www.oreilly.com/openbook/opensources/book/appa.html">全文</a>
</li>
<li>已经得了图灵奖的 Ken Thompson 还在回百度贴吧</li>
</ul>
<h2 id="_2">时代成就的英雄</h2>
<ul>
<li>Linux 2.0 引入多处理器 (Big Kernel Lock, 内核不能并行)，2.4 内核才并行</li>
<li>2002 年才引入 Read-Copy-Update (RCU) 无锁同步</li>
<li>2003 年 Linux 2.6 发布，随云计算开始起飞</li>
</ul>
<p><img alt="" src="static/img/kernel-loc.png"></p>
</div></div>

<div class="slideshow" name="back_to_origin"><div>
<h1 id="_1">同样的故事还在反复发生</h1>
<h2 id="_2">一切伟大都 “从零开始”</h2>
<ul>
<li>Fire in the Valley (个人电脑)</li>
<li>
<a href="https://read.seas.harvard.edu/~kohler/class/aosref/ritchie84evolution.pdf">Evolution of the UNIX Time Sharing System</a><ul>
<li><a href="https://jyywiki.cn/OS/2026/ritchie84evolution.md">只能买到豆包的我是怎么阅读这个文档的</a></li>
</ul>
</li>
</ul>
<h2 id="ai-0-01">AI 时代，<strong>从 0 到 0.1 变得前所未有地容易</strong>
</h2>
<ul>
<li>CrazyOS: 可以和 hardware 做 co-design</li>
<li>Claude Mythous: finding bugs is easy</li>
<li>
<a href="https://github.com/JuliusBrussee/caveman">caveman</a>: why use many token when few do trick</li>
</ul>
<p><img alt="" src="https://api.star-history.com/svg?repos=JuliusBrussee/caveman&amp;type=Date"></p>
</div></div>

<h2> 2. 创造世界
 </h2>
<div class="slideshow" name="review_init_process_state"><div>
<h1 id="_1">回顾：关于 “初始状态”</h1>
<h2 id="_2">进程的初始状态</h2>
<ul>
<li>execve(path, argv, envp)<ul>
<li>SP 指向 [argc, argv, 0, envp, 0, auxv]</li>
<li>path 和 interp 被加载到内存，PC 是 interp 的 ELF entry</li>
</ul>
</li>
</ul>
<h2 id="_3">计算机系统的初始状态</h2>
<ul>
<li>CPU Reset (手册指定的行为)<ul>
<li>运行 Firmware 代码加载操作系统</li>
<li>终究，操作系统会执行一个 execve，启动<strong>第一个进程</strong>，变成 “服务提供者”</li>
</ul>
</li>
</ul>
<h2 id="_4">操作系统的第一个进程？</h2>
<ul>
<li>这个 “长出” 了你看到操作系统世界全部的进程，它到底在哪里，它做了什么？</li>
</ul>
</div></div>

<div class="slideshow" name="initramfs"><div>
<h1 id="initramfs">initramfs</h1>
<h2 id="linux">问出一个问题：我们能控制 Linux 加载的第一个进程吗？</h2>
<ul>
<li>计算机系统公理：<strong>合理的事情就一定能做到</strong>
</li>
<li>制作我们的 initramfs<ul>
<li>可以只有一个 init 文件<ul>
<li>Linux 会按照一个硬编码的 /sbin/init, /etc/init, … 逐个尝试 execve</li>
</ul>
</li>
<li>(系统启动后，Linux 还会增加 /dev 和 /dev/console)<ul>
<li>需要给 stdin/stdout/stderr 一个 “地方”</li>
</ul>
</li>
</ul>
</li>
</ul>
<h2 id="initramfs_1">再问题一个问题：我们能解开当前系统的 initramfs 吗？</h2>
<ul>
<li>当然可以！看看里面有什么吧！</li>
</ul>
</div></div>

<div class="code-card" path="virtualization/linux-minimal"><div><div>
<h1 id="linux"><a href="/OS/demos/virtualization/linux-minimal">最小 Linux</a></h1>
<p>我们完全可以构建一个 “只有一个文件” 的 Linux 系统——Linux 系统会首先加载一个 “init RAM Disk” 或 “init RAM FS”，在作系统最小初始化完成后，将控制权移交给 “第一个进程”。借助互联网或人工智能，你能够找到正确的文档，例如 <a href="https://www.kernel.org/doc/html/latest/admin-guide/kernel-parameters.html">The kernel’s command-line parameters</a> 描述了所有能传递给 Linux Kernel 的命令行选项。</p>
</div></div>
</div>
<div class="code-card" path="virtualization/linux"><div><div>
<h1 id="linux"><a href="/OS/demos/virtualization/linux">Linux</a></h1>
<p>我们可以在 initramfs 中放置任意的数据——包括应用程序、内核模块 (驱动)、数据、脚本……操作系统世界已经开始运转；但直到执行 pivot_root，才真正开始 今天 Linux 应用世界 (systemd) 的启动。</p>
</div></div>
</div>
<div class="slideshow" name="busybox"><div>
<h1 id="linux">点亮 Linux 世界</h1>
<h2 id="busybox-utilities">
<a href="https://git.busybox.net/busybox/tree/busybox?h=1_01">Busybox</a> utilities</h2>
<p>[ [[ acpid adjtimex ar arch arp arping ash awk basename bc blkdiscard blockdev
brctl bunzip2 busybox bzcat bzip2 cal cat chgrp chmod chown chpasswd chroot
chvt clear cmp cp cpio crond crontab cttyhack cut date dc dd deallocvt depmod
devmem df diff dirname dmesg dnsdomainname dos2unix dpkg dpkg-deb du dumpkmap
dumpleases echo ed egrep env expand expr factor fallocate false fatattr fdisk
fgrep find fold free freeramdisk fsfreeze fstrim ftpget ftpput getopt getty
grep groups gunzip gzip halt head hexdump hostid hostname httpd hwclock
i2cdetect i2cdump i2cget i2cset id ifconfig ifdown ifup init insmod ionice ip
ipcalc ipneigh kill killall klogd last less link linux32 linux64 linuxrc ln
loadfont loadkmap logger login logname logread losetup ls lsmod lsscsi lzcat
lzma lzop md5sum mdev microcom mkdir mkdosfs mke2fs mkfifo mknod mkpasswd
mkswap mktemp modinfo modprobe more mount mt mv nameif nc netstat nl nologin
nproc nsenter nslookup nuke od openvt partprobe passwd paste patch pidof ping
ping6 pivot_root poweroff printf ps pwd rdate readlink realpath reboot renice
reset resume rev rm rmdir rmmod route rpm rpm2cpio run-init run-parts sed seq
setkeycodes setpriv setsid sh sha1sum sha256sum sha512sum shred shuf sleep sort
ssl_client start-stop-daemon stat static-sh strings stty su sulogin svc svok
swapoff swapon switch_root sync sysctl syslogd tac tail tar taskset tc tee
telnet telnetd test tftp time timeout top touch tr traceroute traceroute6 true
truncate tty tunctl ubirename udhcpc udhcpd uevent umount uname uncompress
unexpand uniq unix2dos unlink unlzma unshare unxz unzip uptime usleep uudecode
uuencode vconfig vi w watch watchdog wc wget which who whoami xargs xxd xz
xzcat yes zcat</p>
</div></div>

<div class="slideshow" name="initramfs_not_visible"><div>
<h1 id="initramfs-linux">initramfs: 并不是我们 “看到” 的 Linux 世界</h1>
<h2 id="_1">启动的初级阶段</h2>
<ul>
<li>加载剩余必要的驱动程序，例如磁盘/网卡</li>
<li>挂载必要的文件系统<ul>
<li>Linux 内核有启动选项 (类似环境变量)<ul>
<li>/proc/cmdline (man 7 bootparam)</li>
</ul>
</li>
<li>读取 root filesystem 的 /etc/fstab</li>
</ul>
</li>
<li>将根文件系统和控制权移交给另一个程序，例如 systemd</li>
</ul>
<h2 id="_2">启动的第二级阶段</h2>
<ul>
<li>看一看系统里的 /sbin/init 是什么？</li>
<li>计算机系统没有魔法 (一切都有合适的解释)</li>
</ul>
</div></div>

<div class="slideshow" name="pivot_root"><div>
<h1 id="_1">构建 “真正” 应用世界的系统调用</h1>
<h2 id="switch_root">switch_root 命令背后的系统调用</h2>
<div class="codehilite"><pre><span></span><code><span class="kt">int</span><span class="w"> </span><span class="nf">pivot_root</span><span class="p">(</span><span class="k">const</span><span class="w"> </span><span class="kt">char</span><span class="w"> </span><span class="o">*</span><span class="n">new_root</span><span class="p">,</span><span class="w"> </span><span class="k">const</span><span class="w"> </span><span class="kt">char</span><span class="w"> </span><span class="o">*</span><span class="n">put_old</span><span class="p">);</span>
</code></pre></div>

<ul>
<li>Changes the root mount in the mount namespace of the calling process.<ul>
<li>我们也可以在 “最小 Linux 上” 复现这个行为</li>
<li>真实的 Linux: 驱动加载、NetworkManager、tty 字体变化……都是在 switch_root 之后 systemd 拉起的<ul>
<li>例子：<a href="https://zhuanlan.zhihu.com/p/619237809">NOILinux Lite</a>
</li>
</ul>
</li>
</ul>
</li>
<li>可以 umount 把 put_old 释放</li>
</ul>
</div></div>

<div class="slideshow" name="os_review"><div>
<h1 id="_1">故事的结尾：应用视角的操作系统</h1>
<h2 id="_2">操作系统会到达一个<strong>确定的初始状态</strong>
</h2>
<ul>
<li>initramfs + /dev/console + execve(init)</li>
</ul>
<h2 id="api">操作系统 = <strong>对象 + API</strong>
</h2>
<ul>
<li>所有的其他对象 (procfs, devfs, …) 都是系统调用创建和管理的<ul>
<li>进程管理: fork, execve, exit, waitpid, getpid, …</li>
<li>操作系统对象和访问: open, close, read, write, pipe, mount, mkfifo, mknod, stat, socket, …</li>
<li>地址空间管理: mmap, munmap, mprotect, msync, …</li>
<li>以及一些其他的机制: pivot_root, chmod, chown, …</li>
</ul>
</li>
</ul>
<h2 id="unix-minix-linux">Unix → Minix → Linux，到达成熟稳定的状态</h2>
<ul>
<li>精彩的故事在这个 API 抽象层上延续</li>
<li>在 Linux API 上，<strong>没有什么东西是不能做的</strong>
</li>
</ul>
</div></div>

<h2> 3. 应用生态
 </h2>
<div class="slideshow" name="app_ecosystem"><div>
<h1 id="_1">拥抱变化的时代</h1>
<h2 id="_2">是<strong>应用生态</strong>成就了操作系统的繁荣</h2>
<ul>
<li>厂商、个人开发者、……每天都在发布新的应用</li>
<li>操作系统需要有一套核心工具集来支撑它们<ul>
<li>基本的运行库、coreutils、安装工具、系统管理工具、……</li>
</ul>
</li>
</ul>
<h2 id="_3">前互联网时代</h2>
<ul>
<li>DOS/Windows 3.X/95: 软盘/光盘发行<ul>
<li>双击安装程序，输入 CD-Key (“破解” 简直太容易了)</li>
</ul>
</li>
<li>进入互联网时代：AppStore, apt, rpm, PyPI, npm, HuggingFace 🤗, ollama… </li>
</ul>
<p><img alt="" src="static/img/steam-meme.jpg"></p>
</div></div>

<div class="slideshow" name="debian_example"><div>
<h1 id="debian">例子：Debian</h1>
<h2 id="our-mission-creating-a-free-operating-system">Our Mission: Creating a Free Operating System</h2>
<blockquote>
<p>The Debian Project is an association of individuals, sharing a common goal: We want to create a free operating system, freely available for everyone. Now, when we use the word “free”, we’re not talking about money, instead, we are referring to software freedom.</p>
</blockquote>
<ul>
<li>CS 和其他任何学科都不同：开源开放</li>
<li>apt-get install firefox (1998)<ul>
<li>跨时代的 “Advanced Packaging Tool”</li>
</ul>
</li>
</ul>
</div></div>

<div class="slideshow" name="debian_package"><div>
<h1 id="debian">Debian 的包管理 (“软件供应链”)</h1>
<p><img alt="" src="static/img/package-cycle.svg"></p>
</div></div>

<div class="slideshow" name="deb_package"><div>
<h1 id="debian-deb">Debian 软件包 (deb)</h1>
<h2 id="_1">一个压缩包 (<a href="https://packages.debian.org/trixie/ffmpeg">例子</a>)</h2>
<ul>
<li>control.tar.xz<ul>
<li>“control” 文件: Package, Source, Version, Architecture, Maintainer, Depends, Suggests, Section, Priority, Description, …</li>
</ul>
</li>
<li>data.tar.xz<ul>
<li>实际的文件 (绝对路径)</li>
</ul>
</li>
<li>dpkg 可以安装 deb 包<ul>
<li>它也是操作系统上的一个普通应用程序 (使用系统调用完成 “安装” 功能)</li>
</ul>
</li>
</ul>
<h2 id="ai">让 AI 帮我们读一读吧</h2>
<ul>
<li>Preinstall &amp; Unpack → Configure → Triggers → Postinstall<ul>
<li>最近 axios (每周下载量超 3 亿次) 被投毒了：postinstall hook 能偷走你的一切</li>
</ul>
</li>
</ul>
</div></div>

<div class="slideshow" name="ecosystem_discussion"><div>
<h1 id="ai">AI 时代：应用生态的变化</h1>
<h2 id="_1">建设应用生态之路</h2>
<ul>
<li>生态的关键是<strong>开发者</strong>
</li>
<li>但 qualify 的开发者太少了<ul>
<li>大学四年都在写高血压代码？</li>
<li>
<strong>错误的设计 = 无法维护的泥潭</strong><ul>
<li>课程的使命是让大家 “见识” 各种设计</li>
</ul>
</li>
</ul>
</li>
</ul>
<h2 id="_2">应用生态：繁荣还是消亡？</h2>
<ul>
<li>OpenClaw 🦞 时代，“应用程序” 会退化为 “工具” 和 “服务” 吗？</li>
<li>GUI 会不复存在吗？<a href="https://a2ui.org/">A2UI</a>: A Protocol for Agent-Driven Interfaces; 豆包手机; Qwen 应用</li>
</ul>
</div></div>

<div class="note" name="takeaways"><div>
<h1 id="takeaways">Takeaways</h1>
<p>从 UNIX 发展到 Linux，操作系统经历了漫长的演进。Linux 的 “两面” 是内核和发行版生态，而 initramfs 提供了进程运行的初始状态。应用程序通过系统调用与内核交互，现代操作系统的应用生态依赖于包管理工具和开发者社区。</p>
</div></div>
</div></div></div><div class="bg-neutral-100 text-center text-neutral-600 dark:bg-neutral-600 dark:text-neutral-200 lg:text-left"><div class="bg-neutral-200 p-6 text-center dark:bg-neutral-700"><a rel="license" href="http://creativecommons.org/licenses/by-nc/4.0/">Creative Commons License: BY-NC 4.0</a><br/><a href="https://beian.miit.gov.cn/">苏 ICP 备 2020049101 号</a></div></div></div></div><script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"rawSource":"\u003ch1\u003e 构建应用生态 (Hacking Day)\n \u003c/h1\u003e\n\u003cdiv class=\"slideshow\" name=\"review_and_comments\"\u003e\u003cdiv\u003e\n\u003ch1 id=\"review-comments\"\u003eReview \u0026amp; Comments\u003c/h1\u003e\n\u003ch2 id=\"_1\"\u003e链接和加载\u003c/h2\u003e\n\u003cul\u003e\n\u003cli\u003e本质讲的是 execve 的行为\u003cul\u003e\n\u003cli\u003e继承文件描述符、singal hander 等\u003c/li\u003e\n\u003cli\u003e加载 ELF 文件 (数据结构) 和 INTERP 的所有 PT_LOAD, PT_GNU_STACK, PT_TLS …\u003c/li\u003e\n\u003cli\u003e设置进程的初始状态 (栈上的 argc, argv, envp, auxv、寄存器)\u003c/li\u003e\n\u003cli\u003e加上库函数的行为 (musl; ld-linux.so; …) 你就理解了操作系统的一切\u003c/li\u003e\n\u003cli\u003eShebang (#!)\u003c/li\u003e\n\u003c/ul\u003e\n\u003c/li\u003e\n\u003cli\u003e惊喜：这么复杂的东西，其实也 “不过如此”\u003c/li\u003e\n\u003c/ul\u003e\n\u003ch2 id=\"_2\"\u003e回到应用视角的操作系统\u003c/h2\u003e\n\u003cul\u003e\n\u003cli\u003e这个学期到现在一直在讲 “系统调用的行为”\u003c/li\u003e\n\u003cli\u003e课程的目标：\u003cstrong\u003e阅读手册、指导 AI 写代码来理解任何系统调用\u003c/strong\u003e，并且弄清楚\u003cstrong\u003e为什么要这样设计\u003c/strong\u003e\n\u003c/li\u003e\n\u003c/ul\u003e\n\u003c/div\u003e\u003c/div\u003e\n\n\u003ch2\u003e 1. 见证历史\n \u003c/h2\u003e\n\u003cdiv class=\"slideshow\" name=\"evolution_of_unix\"\u003e\u003cdiv\u003e\n\u003ch1 id=\"_1\"\u003e这些系统调用是怎么来的？\u003c/h1\u003e\n\u003ch2 id=\"dennis-m-ritchie-evolution-of-the-unix-time-sharing-system\"\u003eDennis M. Ritchie: \u003ca href=\"https://read.seas.harvard.edu/~kohler/class/aosref/ritchie84evolution.pdf\"\u003eEvolution of the UNIX Time Sharing System\u003c/a\u003e\n\u003c/h2\u003e\n\u003cul\u003e\n\u003cli\u003e最早的版本甚至没有 fork()\u003cul\u003e\n\u003cli\u003eShell 关闭所有打开的文件，然后为 0, 1 fd 打开终端文件\u003c/li\u003e\n\u003cli\u003e从终端读取命令行\u003c/li\u003e\n\u003cli\u003e打开文件，把加载器代码复制到内存并执行 (相当于 exec)\u003c/li\u003e\n\u003cli\u003eexit 会重新加载 shell\u003cul\u003e\n\u003cli\u003eTakeaway message: 不要害怕 “不好”，大胆去做，并且持续改进\u003c/li\u003e\n\u003c/ul\u003e\n\u003c/li\u003e\n\u003c/ul\u003e\n\u003c/li\u003e\n\u003c/ul\u003e\n\u003ch2 id=\"andrew-s-tanenbaum-minix\"\u003eAndrew S. Tanenbaum: \u003ca href=\"http://minix3.org\"\u003eMinix\u003c/a\u003e\n\u003c/h2\u003e\n\u003cul\u003e\n\u003cli\u003eMinix1 (1987): UNIXv7 兼容，也是 Linus 实现 Linux 的起点\u003c/li\u003e\n\u003cli\u003eMinix2 (1997): POSIX 兼容，随书送代码\u003c/li\u003e\n\u003cli\u003eMinix3 (2006): POSIX/NetBSD 兼容，全功能，一度是世界上应用最广的操作系统 (Intel ME)\u003c/li\u003e\n\u003c/ul\u003e\n\u003c/div\u003e\u003c/div\u003e\n\n\u003cdiv class=\"slideshow\" name=\"my_dream_start\"\u003e\u003cdiv\u003e\n\u003ch1 id=\"_1\"\u003e我 “梦开始的地方”\u003c/h1\u003e\n\u003cp\u003e\u003cimg alt=\"\" src=\"static/img/minix2-book.jpg\"\u003e\u003c/p\u003e\n\u003c/div\u003e\u003c/div\u003e\n\n\u003cdiv class=\"slideshow\" name=\"minix3\"\u003e\u003cdiv\u003e\n\u003ch1 id=\"minix3\"\u003eMinix3\u003c/h1\u003e\n\u003cp\u003e\u003cimg alt=\"\" src=\"static/img/minix3-desktop.png\"\u003e\u003c/p\u003e\n\u003c/div\u003e\u003c/div\u003e\n\n\u003cdiv class=\"code-card\" path=\"virtualization/minix\"\u003e\u003cdiv\u003e\u003cdiv\u003e\n\u003ch1 id=\"minix\"\u003e\u003ca href=\"/OS/demos/virtualization/minix\"\u003eMinix\u003c/a\u003e\u003c/h1\u003e\n\u003cp\u003eMinix 是 UNIX 之后的经典教学操作系统，Andrew Tanenbaum 也因此成就了一代计算机系统研究者。代码来自 \u003ca href=\"https://github.com/davidgiven/minix2\"\u003eMinix 1 and 2, Quick and Dirty editions\u003c/a\u003e。\u003c/p\u003e\n\u003c/div\u003e\u003c/div\u003e\n\u003c/div\u003e\n\u003cdiv class=\"slideshow\" name=\"birthday_of_linux\"\u003e\u003cdiv\u003e\n\u003ch1 id=\"linux-1991-8-25\"\u003eLinux 的诞生 (1991 年 8 月 25 日)\u003c/h1\u003e\n\u003cblockquote\u003e\n\u003cp\u003eHello, everybody out there using minix – I’m doing a (free) operating system (just a hobby, won’t be big and professional like gnu) for 386(486) AT clones. This has been brewing since April, and is starting to get ready.\u003c/p\u003e\n\u003cp\u003e—— Linus Torvalds (时年 21 岁)\u003c/p\u003e\n\u003c/blockquote\u003e\n\u003ch2 id=\"oslab\"\u003e类似于 “我写了个加强版的 OSLab，现在与大家分享”\u003c/h2\u003e\n\u003cul\u003e\n\u003cli\u003e发布在 comp.os.minix（“百度贴吧”），依赖 Minix 的工具链；运行 GNU gcc, bash, …\u003c/li\u003e\n\u003cli\u003e\n\u003cstrong\u003e机缘巧合：合适的人、合适的时间\u003c/strong\u003e: Frank Rosenblatt 的 \u003ca href=\"https://homepages.math.uic.edu/~lreyzin/papers/rosenblatt58.pdf\"\u003ePerceptron paper\u003c/a\u003e\n\u003c/li\u003e\n\u003c/ul\u003e\n\u003cp\u003e\u003cimg alt=\"\" src=\"static/img/perceptrons.png\"\u003e\u003c/p\u003e\n\u003c/div\u003e\u003c/div\u003e\n\n\u003cdiv class=\"slideshow\" name=\"famous_scenes\"\u003e\u003cdiv\u003e\n\u003ch1 id=\"_1\"\u003e诞生了不少名场面\u003c/h1\u003e\n\u003ch2 id=\"the-single-worst-company-weve-ever-dealt-with-2012\"\u003e“The single worst company we’ve ever dealt with…” (2012)\u003c/h2\u003e\n\u003cul\u003e\n\u003cli\u003eAlex Krizhevsky, Ilya Sutskever, Geoffrey Hinton 还在搞 AlexNet\u003cul\u003e\n\u003cli\u003eAlphaGo (2015), GPT-3 (2020), …\u003c/li\u003e\n\u003cli\u003e我还在读 PhD，抱怨 CUDA 编程模型很反人类\u003c/li\u003e\n\u003c/ul\u003e\n\u003c/li\u003e\n\u003cli\u003e天道好轮回：能想象 NVDA 是现在市值最高的公司？\u003c/li\u003e\n\u003c/ul\u003e\n\u003cp\u003e\u003cimg alt=\"\" src=\"static/img/linus-nv.jpg\"\u003e\u003c/p\u003e\n\u003c/div\u003e\u003c/div\u003e\n\n\u003cdiv class=\"slideshow\" name=\"just_for_fun\"\u003e\u003cdiv\u003e\n\u003ch1 id=\"just-for-fun\"\u003e“Just for fun”\u003c/h1\u003e\n\u003ch2 id=\"the-story-of-an-accidental-revolutionary\"\u003eThe story of an accidental revolutionary\u003c/h2\u003e\n\u003cblockquote\u003e\n\u003cp\u003eRevolutionaries aren’t born. Revolutions can’t be planned. Revolutions can’t be managed. Revolutions happen....\u003c/p\u003e\n\u003cp\u003e—— David Diamond (本书作者)\u003c/p\u003e\n\u003c/blockquote\u003e\n\u003ch2 id=\"202512\"\u003e\n\u003ca href=\"http://www.moe.gov.cn/jyb_xwfb/gzdt_gzdt/moe_1485/202512/t20251203_1422209.html\"\u003e全国高校科技创新工作会议暨基础学科和交叉学科突破计划启动部署会召开\u003c/a\u003e (2025.12)\u003c/h2\u003e\n\u003cul\u003e\n\u003cli\u003e……要提高政治站位，勇担国家使命，精心谋划一批重大战略任务、重大政策举措和重大工程项目，聚焦战略领域、关键要素，构建有效评价指标，努力形成一批标志性成果，加快把高校的资源优势转化为竞争优势……\u003cul\u003e\n\u003cli\u003e\n\u003ca href=\"https://mp.weixin.qq.com/s/P8Wgpy9wscMB4ddDiz9RNg\"\u003e我的博导也是干摩托车发动机的，他为什么没干出来\u003c/a\u003e：因为我在 “人-机-物融合时代实现操作系统的弯道 (换道) 超车” 🤔\u003c/li\u003e\n\u003c/ul\u003e\n\u003c/li\u003e\n\u003c/ul\u003e\n\u003c/div\u003e\u003c/div\u003e\n\n\u003cdiv class=\"slideshow\" name=\"linux_is_obsolete\"\u003e\u003cdiv\u003e\n\u003ch1 id=\"_1\"\u003e质疑、回应与时代的车轮\u003c/h1\u003e\n\u003ch2 id=\"composminix-linux\"\u003e在 comp.os.minix 上关于 Linux 的讨论越来越多了\u003c/h2\u003e\n\u003cul\u003e\n\u003cli\u003eAndrew Tanenbaum 做出了 “官方回应”，觉得 “太落后”\u003c/li\u003e\n\u003cli\u003eLinus 完全不服气：\u003ca href=\"https://www.oreilly.com/openbook/opensources/book/appa.html\"\u003e全文\u003c/a\u003e\n\u003c/li\u003e\n\u003cli\u003e已经得了图灵奖的 Ken Thompson 还在回百度贴吧\u003c/li\u003e\n\u003c/ul\u003e\n\u003ch2 id=\"_2\"\u003e时代成就的英雄\u003c/h2\u003e\n\u003cul\u003e\n\u003cli\u003eLinux 2.0 引入多处理器 (Big Kernel Lock, 内核不能并行)，2.4 内核才并行\u003c/li\u003e\n\u003cli\u003e2002 年才引入 Read-Copy-Update (RCU) 无锁同步\u003c/li\u003e\n\u003cli\u003e2003 年 Linux 2.6 发布，随云计算开始起飞\u003c/li\u003e\n\u003c/ul\u003e\n\u003cp\u003e\u003cimg alt=\"\" src=\"static/img/kernel-loc.png\"\u003e\u003c/p\u003e\n\u003c/div\u003e\u003c/div\u003e\n\n\u003cdiv class=\"slideshow\" name=\"back_to_origin\"\u003e\u003cdiv\u003e\n\u003ch1 id=\"_1\"\u003e同样的故事还在反复发生\u003c/h1\u003e\n\u003ch2 id=\"_2\"\u003e一切伟大都 “从零开始”\u003c/h2\u003e\n\u003cul\u003e\n\u003cli\u003eFire in the Valley (个人电脑)\u003c/li\u003e\n\u003cli\u003e\n\u003ca href=\"https://read.seas.harvard.edu/~kohler/class/aosref/ritchie84evolution.pdf\"\u003eEvolution of the UNIX Time Sharing System\u003c/a\u003e\u003cul\u003e\n\u003cli\u003e\u003ca href=\"https://jyywiki.cn/OS/2026/ritchie84evolution.md\"\u003e只能买到豆包的我是怎么阅读这个文档的\u003c/a\u003e\u003c/li\u003e\n\u003c/ul\u003e\n\u003c/li\u003e\n\u003c/ul\u003e\n\u003ch2 id=\"ai-0-01\"\u003eAI 时代，\u003cstrong\u003e从 0 到 0.1 变得前所未有地容易\u003c/strong\u003e\n\u003c/h2\u003e\n\u003cul\u003e\n\u003cli\u003eCrazyOS: 可以和 hardware 做 co-design\u003c/li\u003e\n\u003cli\u003eClaude Mythous: finding bugs is easy\u003c/li\u003e\n\u003cli\u003e\n\u003ca href=\"https://github.com/JuliusBrussee/caveman\"\u003ecaveman\u003c/a\u003e: why use many token when few do trick\u003c/li\u003e\n\u003c/ul\u003e\n\u003cp\u003e\u003cimg alt=\"\" src=\"https://api.star-history.com/svg?repos=JuliusBrussee/caveman\u0026amp;type=Date\"\u003e\u003c/p\u003e\n\u003c/div\u003e\u003c/div\u003e\n\n\u003ch2\u003e 2. 创造世界\n \u003c/h2\u003e\n\u003cdiv class=\"slideshow\" name=\"review_init_process_state\"\u003e\u003cdiv\u003e\n\u003ch1 id=\"_1\"\u003e回顾：关于 “初始状态”\u003c/h1\u003e\n\u003ch2 id=\"_2\"\u003e进程的初始状态\u003c/h2\u003e\n\u003cul\u003e\n\u003cli\u003eexecve(path, argv, envp)\u003cul\u003e\n\u003cli\u003eSP 指向 [argc, argv, 0, envp, 0, auxv]\u003c/li\u003e\n\u003cli\u003epath 和 interp 被加载到内存，PC 是 interp 的 ELF entry\u003c/li\u003e\n\u003c/ul\u003e\n\u003c/li\u003e\n\u003c/ul\u003e\n\u003ch2 id=\"_3\"\u003e计算机系统的初始状态\u003c/h2\u003e\n\u003cul\u003e\n\u003cli\u003eCPU Reset (手册指定的行为)\u003cul\u003e\n\u003cli\u003e运行 Firmware 代码加载操作系统\u003c/li\u003e\n\u003cli\u003e终究，操作系统会执行一个 execve，启动\u003cstrong\u003e第一个进程\u003c/strong\u003e，变成 “服务提供者”\u003c/li\u003e\n\u003c/ul\u003e\n\u003c/li\u003e\n\u003c/ul\u003e\n\u003ch2 id=\"_4\"\u003e操作系统的第一个进程？\u003c/h2\u003e\n\u003cul\u003e\n\u003cli\u003e这个 “长出” 了你看到操作系统世界全部的进程，它到底在哪里，它做了什么？\u003c/li\u003e\n\u003c/ul\u003e\n\u003c/div\u003e\u003c/div\u003e\n\n\u003cdiv class=\"slideshow\" name=\"initramfs\"\u003e\u003cdiv\u003e\n\u003ch1 id=\"initramfs\"\u003einitramfs\u003c/h1\u003e\n\u003ch2 id=\"linux\"\u003e问出一个问题：我们能控制 Linux 加载的第一个进程吗？\u003c/h2\u003e\n\u003cul\u003e\n\u003cli\u003e计算机系统公理：\u003cstrong\u003e合理的事情就一定能做到\u003c/strong\u003e\n\u003c/li\u003e\n\u003cli\u003e制作我们的 initramfs\u003cul\u003e\n\u003cli\u003e可以只有一个 init 文件\u003cul\u003e\n\u003cli\u003eLinux 会按照一个硬编码的 /sbin/init, /etc/init, … 逐个尝试 execve\u003c/li\u003e\n\u003c/ul\u003e\n\u003c/li\u003e\n\u003cli\u003e(系统启动后，Linux 还会增加 /dev 和 /dev/console)\u003cul\u003e\n\u003cli\u003e需要给 stdin/stdout/stderr 一个 “地方”\u003c/li\u003e\n\u003c/ul\u003e\n\u003c/li\u003e\n\u003c/ul\u003e\n\u003c/li\u003e\n\u003c/ul\u003e\n\u003ch2 id=\"initramfs_1\"\u003e再问题一个问题：我们能解开当前系统的 initramfs 吗？\u003c/h2\u003e\n\u003cul\u003e\n\u003cli\u003e当然可以！看看里面有什么吧！\u003c/li\u003e\n\u003c/ul\u003e\n\u003c/div\u003e\u003c/div\u003e\n\n\u003cdiv class=\"code-card\" path=\"virtualization/linux-minimal\"\u003e\u003cdiv\u003e\u003cdiv\u003e\n\u003ch1 id=\"linux\"\u003e\u003ca href=\"/OS/demos/virtualization/linux-minimal\"\u003e最小 Linux\u003c/a\u003e\u003c/h1\u003e\n\u003cp\u003e我们完全可以构建一个 “只有一个文件” 的 Linux 系统——Linux 系统会首先加载一个 “init RAM Disk” 或 “init RAM FS”，在作系统最小初始化完成后，将控制权移交给 “第一个进程”。借助互联网或人工智能，你能够找到正确的文档，例如 \u003ca href=\"https://www.kernel.org/doc/html/latest/admin-guide/kernel-parameters.html\"\u003eThe kernel’s command-line parameters\u003c/a\u003e 描述了所有能传递给 Linux Kernel 的命令行选项。\u003c/p\u003e\n\u003c/div\u003e\u003c/div\u003e\n\u003c/div\u003e\n\u003cdiv class=\"code-card\" path=\"virtualization/linux\"\u003e\u003cdiv\u003e\u003cdiv\u003e\n\u003ch1 id=\"linux\"\u003e\u003ca href=\"/OS/demos/virtualization/linux\"\u003eLinux\u003c/a\u003e\u003c/h1\u003e\n\u003cp\u003e我们可以在 initramfs 中放置任意的数据——包括应用程序、内核模块 (驱动)、数据、脚本……操作系统世界已经开始运转；但直到执行 pivot_root，才真正开始 今天 Linux 应用世界 (systemd) 的启动。\u003c/p\u003e\n\u003c/div\u003e\u003c/div\u003e\n\u003c/div\u003e\n\u003cdiv class=\"slideshow\" name=\"busybox\"\u003e\u003cdiv\u003e\n\u003ch1 id=\"linux\"\u003e点亮 Linux 世界\u003c/h1\u003e\n\u003ch2 id=\"busybox-utilities\"\u003e\n\u003ca href=\"https://git.busybox.net/busybox/tree/busybox?h=1_01\"\u003eBusybox\u003c/a\u003e utilities\u003c/h2\u003e\n\u003cp\u003e[ [[ acpid adjtimex ar arch arp arping ash awk basename bc blkdiscard blockdev\nbrctl bunzip2 busybox bzcat bzip2 cal cat chgrp chmod chown chpasswd chroot\nchvt clear cmp cp cpio crond crontab cttyhack cut date dc dd deallocvt depmod\ndevmem df diff dirname dmesg dnsdomainname dos2unix dpkg dpkg-deb du dumpkmap\ndumpleases echo ed egrep env expand expr factor fallocate false fatattr fdisk\nfgrep find fold free freeramdisk fsfreeze fstrim ftpget ftpput getopt getty\ngrep groups gunzip gzip halt head hexdump hostid hostname httpd hwclock\ni2cdetect i2cdump i2cget i2cset id ifconfig ifdown ifup init insmod ionice ip\nipcalc ipneigh kill killall klogd last less link linux32 linux64 linuxrc ln\nloadfont loadkmap logger login logname logread losetup ls lsmod lsscsi lzcat\nlzma lzop md5sum mdev microcom mkdir mkdosfs mke2fs mkfifo mknod mkpasswd\nmkswap mktemp modinfo modprobe more mount mt mv nameif nc netstat nl nologin\nnproc nsenter nslookup nuke od openvt partprobe passwd paste patch pidof ping\nping6 pivot_root poweroff printf ps pwd rdate readlink realpath reboot renice\nreset resume rev rm rmdir rmmod route rpm rpm2cpio run-init run-parts sed seq\nsetkeycodes setpriv setsid sh sha1sum sha256sum sha512sum shred shuf sleep sort\nssl_client start-stop-daemon stat static-sh strings stty su sulogin svc svok\nswapoff swapon switch_root sync sysctl syslogd tac tail tar taskset tc tee\ntelnet telnetd test tftp time timeout top touch tr traceroute traceroute6 true\ntruncate tty tunctl ubirename udhcpc udhcpd uevent umount uname uncompress\nunexpand uniq unix2dos unlink unlzma unshare unxz unzip uptime usleep uudecode\nuuencode vconfig vi w watch watchdog wc wget which who whoami xargs xxd xz\nxzcat yes zcat\u003c/p\u003e\n\u003c/div\u003e\u003c/div\u003e\n\n\u003cdiv class=\"slideshow\" name=\"initramfs_not_visible\"\u003e\u003cdiv\u003e\n\u003ch1 id=\"initramfs-linux\"\u003einitramfs: 并不是我们 “看到” 的 Linux 世界\u003c/h1\u003e\n\u003ch2 id=\"_1\"\u003e启动的初级阶段\u003c/h2\u003e\n\u003cul\u003e\n\u003cli\u003e加载剩余必要的驱动程序，例如磁盘/网卡\u003c/li\u003e\n\u003cli\u003e挂载必要的文件系统\u003cul\u003e\n\u003cli\u003eLinux 内核有启动选项 (类似环境变量)\u003cul\u003e\n\u003cli\u003e/proc/cmdline (man 7 bootparam)\u003c/li\u003e\n\u003c/ul\u003e\n\u003c/li\u003e\n\u003cli\u003e读取 root filesystem 的 /etc/fstab\u003c/li\u003e\n\u003c/ul\u003e\n\u003c/li\u003e\n\u003cli\u003e将根文件系统和控制权移交给另一个程序，例如 systemd\u003c/li\u003e\n\u003c/ul\u003e\n\u003ch2 id=\"_2\"\u003e启动的第二级阶段\u003c/h2\u003e\n\u003cul\u003e\n\u003cli\u003e看一看系统里的 /sbin/init 是什么？\u003c/li\u003e\n\u003cli\u003e计算机系统没有魔法 (一切都有合适的解释)\u003c/li\u003e\n\u003c/ul\u003e\n\u003c/div\u003e\u003c/div\u003e\n\n\u003cdiv class=\"slideshow\" name=\"pivot_root\"\u003e\u003cdiv\u003e\n\u003ch1 id=\"_1\"\u003e构建 “真正” 应用世界的系统调用\u003c/h1\u003e\n\u003ch2 id=\"switch_root\"\u003eswitch_root 命令背后的系统调用\u003c/h2\u003e\n\u003cdiv class=\"codehilite\"\u003e\u003cpre\u003e\u003cspan\u003e\u003c/span\u003e\u003ccode\u003e\u003cspan class=\"kt\"\u003eint\u003c/span\u003e\u003cspan class=\"w\"\u003e \u003c/span\u003e\u003cspan class=\"nf\"\u003epivot_root\u003c/span\u003e\u003cspan class=\"p\"\u003e(\u003c/span\u003e\u003cspan class=\"k\"\u003econst\u003c/span\u003e\u003cspan class=\"w\"\u003e \u003c/span\u003e\u003cspan class=\"kt\"\u003echar\u003c/span\u003e\u003cspan class=\"w\"\u003e \u003c/span\u003e\u003cspan class=\"o\"\u003e*\u003c/span\u003e\u003cspan class=\"n\"\u003enew_root\u003c/span\u003e\u003cspan class=\"p\"\u003e,\u003c/span\u003e\u003cspan class=\"w\"\u003e \u003c/span\u003e\u003cspan class=\"k\"\u003econst\u003c/span\u003e\u003cspan class=\"w\"\u003e \u003c/span\u003e\u003cspan class=\"kt\"\u003echar\u003c/span\u003e\u003cspan class=\"w\"\u003e \u003c/span\u003e\u003cspan class=\"o\"\u003e*\u003c/span\u003e\u003cspan class=\"n\"\u003eput_old\u003c/span\u003e\u003cspan class=\"p\"\u003e);\u003c/span\u003e\n\u003c/code\u003e\u003c/pre\u003e\u003c/div\u003e\n\n\u003cul\u003e\n\u003cli\u003eChanges the root mount in the mount namespace of the calling process.\u003cul\u003e\n\u003cli\u003e我们也可以在 “最小 Linux 上” 复现这个行为\u003c/li\u003e\n\u003cli\u003e真实的 Linux: 驱动加载、NetworkManager、tty 字体变化……都是在 switch_root 之后 systemd 拉起的\u003cul\u003e\n\u003cli\u003e例子：\u003ca href=\"https://zhuanlan.zhihu.com/p/619237809\"\u003eNOILinux Lite\u003c/a\u003e\n\u003c/li\u003e\n\u003c/ul\u003e\n\u003c/li\u003e\n\u003c/ul\u003e\n\u003c/li\u003e\n\u003cli\u003e可以 umount 把 put_old 释放\u003c/li\u003e\n\u003c/ul\u003e\n\u003c/div\u003e\u003c/div\u003e\n\n\u003cdiv class=\"slideshow\" name=\"os_review\"\u003e\u003cdiv\u003e\n\u003ch1 id=\"_1\"\u003e故事的结尾：应用视角的操作系统\u003c/h1\u003e\n\u003ch2 id=\"_2\"\u003e操作系统会到达一个\u003cstrong\u003e确定的初始状态\u003c/strong\u003e\n\u003c/h2\u003e\n\u003cul\u003e\n\u003cli\u003einitramfs + /dev/console + execve(init)\u003c/li\u003e\n\u003c/ul\u003e\n\u003ch2 id=\"api\"\u003e操作系统 = \u003cstrong\u003e对象 + API\u003c/strong\u003e\n\u003c/h2\u003e\n\u003cul\u003e\n\u003cli\u003e所有的其他对象 (procfs, devfs, …) 都是系统调用创建和管理的\u003cul\u003e\n\u003cli\u003e进程管理: fork, execve, exit, waitpid, getpid, …\u003c/li\u003e\n\u003cli\u003e操作系统对象和访问: open, close, read, write, pipe, mount, mkfifo, mknod, stat, socket, …\u003c/li\u003e\n\u003cli\u003e地址空间管理: mmap, munmap, mprotect, msync, …\u003c/li\u003e\n\u003cli\u003e以及一些其他的机制: pivot_root, chmod, chown, …\u003c/li\u003e\n\u003c/ul\u003e\n\u003c/li\u003e\n\u003c/ul\u003e\n\u003ch2 id=\"unix-minix-linux\"\u003eUnix → Minix → Linux，到达成熟稳定的状态\u003c/h2\u003e\n\u003cul\u003e\n\u003cli\u003e精彩的故事在这个 API 抽象层上延续\u003c/li\u003e\n\u003cli\u003e在 Linux API 上，\u003cstrong\u003e没有什么东西是不能做的\u003c/strong\u003e\n\u003c/li\u003e\n\u003c/ul\u003e\n\u003c/div\u003e\u003c/div\u003e\n\n\u003ch2\u003e 3. 应用生态\n \u003c/h2\u003e\n\u003cdiv class=\"slideshow\" name=\"app_ecosystem\"\u003e\u003cdiv\u003e\n\u003ch1 id=\"_1\"\u003e拥抱变化的时代\u003c/h1\u003e\n\u003ch2 id=\"_2\"\u003e是\u003cstrong\u003e应用生态\u003c/strong\u003e成就了操作系统的繁荣\u003c/h2\u003e\n\u003cul\u003e\n\u003cli\u003e厂商、个人开发者、……每天都在发布新的应用\u003c/li\u003e\n\u003cli\u003e操作系统需要有一套核心工具集来支撑它们\u003cul\u003e\n\u003cli\u003e基本的运行库、coreutils、安装工具、系统管理工具、……\u003c/li\u003e\n\u003c/ul\u003e\n\u003c/li\u003e\n\u003c/ul\u003e\n\u003ch2 id=\"_3\"\u003e前互联网时代\u003c/h2\u003e\n\u003cul\u003e\n\u003cli\u003eDOS/Windows 3.X/95: 软盘/光盘发行\u003cul\u003e\n\u003cli\u003e双击安装程序，输入 CD-Key (“破解” 简直太容易了)\u003c/li\u003e\n\u003c/ul\u003e\n\u003c/li\u003e\n\u003cli\u003e进入互联网时代：AppStore, apt, rpm, PyPI, npm, HuggingFace 🤗, ollama… \u003c/li\u003e\n\u003c/ul\u003e\n\u003cp\u003e\u003cimg alt=\"\" src=\"static/img/steam-meme.jpg\"\u003e\u003c/p\u003e\n\u003c/div\u003e\u003c/div\u003e\n\n\u003cdiv class=\"slideshow\" name=\"debian_example\"\u003e\u003cdiv\u003e\n\u003ch1 id=\"debian\"\u003e例子：Debian\u003c/h1\u003e\n\u003ch2 id=\"our-mission-creating-a-free-operating-system\"\u003eOur Mission: Creating a Free Operating System\u003c/h2\u003e\n\u003cblockquote\u003e\n\u003cp\u003eThe Debian Project is an association of individuals, sharing a common goal: We want to create a free operating system, freely available for everyone. Now, when we use the word “free”, we’re not talking about money, instead, we are referring to software freedom.\u003c/p\u003e\n\u003c/blockquote\u003e\n\u003cul\u003e\n\u003cli\u003eCS 和其他任何学科都不同：开源开放\u003c/li\u003e\n\u003cli\u003eapt-get install firefox (1998)\u003cul\u003e\n\u003cli\u003e跨时代的 “Advanced Packaging Tool”\u003c/li\u003e\n\u003c/ul\u003e\n\u003c/li\u003e\n\u003c/ul\u003e\n\u003c/div\u003e\u003c/div\u003e\n\n\u003cdiv class=\"slideshow\" name=\"debian_package\"\u003e\u003cdiv\u003e\n\u003ch1 id=\"debian\"\u003eDebian 的包管理 (“软件供应链”)\u003c/h1\u003e\n\u003cp\u003e\u003cimg alt=\"\" src=\"static/img/package-cycle.svg\"\u003e\u003c/p\u003e\n\u003c/div\u003e\u003c/div\u003e\n\n\u003cdiv class=\"slideshow\" name=\"deb_package\"\u003e\u003cdiv\u003e\n\u003ch1 id=\"debian-deb\"\u003eDebian 软件包 (deb)\u003c/h1\u003e\n\u003ch2 id=\"_1\"\u003e一个压缩包 (\u003ca href=\"https://packages.debian.org/trixie/ffmpeg\"\u003e例子\u003c/a\u003e)\u003c/h2\u003e\n\u003cul\u003e\n\u003cli\u003econtrol.tar.xz\u003cul\u003e\n\u003cli\u003e“control” 文件: Package, Source, Version, Architecture, Maintainer, Depends, Suggests, Section, Priority, Description, …\u003c/li\u003e\n\u003c/ul\u003e\n\u003c/li\u003e\n\u003cli\u003edata.tar.xz\u003cul\u003e\n\u003cli\u003e实际的文件 (绝对路径)\u003c/li\u003e\n\u003c/ul\u003e\n\u003c/li\u003e\n\u003cli\u003edpkg 可以安装 deb 包\u003cul\u003e\n\u003cli\u003e它也是操作系统上的一个普通应用程序 (使用系统调用完成 “安装” 功能)\u003c/li\u003e\n\u003c/ul\u003e\n\u003c/li\u003e\n\u003c/ul\u003e\n\u003ch2 id=\"ai\"\u003e让 AI 帮我们读一读吧\u003c/h2\u003e\n\u003cul\u003e\n\u003cli\u003ePreinstall \u0026amp; Unpack → Configure → Triggers → Postinstall\u003cul\u003e\n\u003cli\u003e最近 axios (每周下载量超 3 亿次) 被投毒了：postinstall hook 能偷走你的一切\u003c/li\u003e\n\u003c/ul\u003e\n\u003c/li\u003e\n\u003c/ul\u003e\n\u003c/div\u003e\u003c/div\u003e\n\n\u003cdiv class=\"slideshow\" name=\"ecosystem_discussion\"\u003e\u003cdiv\u003e\n\u003ch1 id=\"ai\"\u003eAI 时代：应用生态的变化\u003c/h1\u003e\n\u003ch2 id=\"_1\"\u003e建设应用生态之路\u003c/h2\u003e\n\u003cul\u003e\n\u003cli\u003e生态的关键是\u003cstrong\u003e开发者\u003c/strong\u003e\n\u003c/li\u003e\n\u003cli\u003e但 qualify 的开发者太少了\u003cul\u003e\n\u003cli\u003e大学四年都在写高血压代码？\u003c/li\u003e\n\u003cli\u003e\n\u003cstrong\u003e错误的设计 = 无法维护的泥潭\u003c/strong\u003e\u003cul\u003e\n\u003cli\u003e课程的使命是让大家 “见识” 各种设计\u003c/li\u003e\n\u003c/ul\u003e\n\u003c/li\u003e\n\u003c/ul\u003e\n\u003c/li\u003e\n\u003c/ul\u003e\n\u003ch2 id=\"_2\"\u003e应用生态：繁荣还是消亡？\u003c/h2\u003e\n\u003cul\u003e\n\u003cli\u003eOpenClaw 🦞 时代，“应用程序” 会退化为 “工具” 和 “服务” 吗？\u003c/li\u003e\n\u003cli\u003eGUI 会不复存在吗？\u003ca href=\"https://a2ui.org/\"\u003eA2UI\u003c/a\u003e: A Protocol for Agent-Driven Interfaces; 豆包手机; Qwen 应用\u003c/li\u003e\n\u003c/ul\u003e\n\u003c/div\u003e\u003c/div\u003e\n\n\u003cdiv class=\"note\" name=\"takeaways\"\u003e\u003cdiv\u003e\n\u003ch1 id=\"takeaways\"\u003eTakeaways\u003c/h1\u003e\n\u003cp\u003e从 UNIX 发展到 Linux，操作系统经历了漫长的演进。Linux 的 “两面” 是内核和发行版生态，而 initramfs 提供了进程运行的初始状态。应用程序通过系统调用与内核交互，现代操作系统的应用生态依赖于包管理工具和开发者社区。\u003c/p\u003e\n\u003c/div\u003e\u003c/div\u003e\n"},"__N_SSG":true},"page":"/[[...index]]","query":{"index":["OS","2026","lect12.md"]},"buildId":"5oc85hUK-mNqby8Yf0bnI","isFallback":false,"gsp":true,"scriptLoader":[]}</script></body></html>