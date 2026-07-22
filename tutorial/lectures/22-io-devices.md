# 第 22 讲：输入/输出设备原理

> 原始讲义：[sources/notes/lect22.md](../../sources/notes/lect22.md)  
> 前一讲：[一个 Token 的旅程](21-token-journey.md)  
> 后一讲：[存储设备的抽象](23-storage.md)  
> 配套示例：[device_file.c](../../examples/device_file.c)  
> 本讲关键词：canonical device、状态机、GPIO、UART、PS/2、ATA、PostScript、UVC、PIO、MMIO、中断、DMA、GPU/NPU、PCIe、CXL、driver、`/dev`、`read/write/ioctl/mmap`

> **阅读约定**：正文严格沿 PPT 一级标题的原顺序推进；“扩展”段落用于补足现代 Linux 与当前总线标准，不要求把某个内核版本的结构体字段或某代协议数字背下来。硬件寄存器、GPIO、PCI 配置空间和 DMA 都可能损坏设备、数据乃至人身安全；本章的可复现实验只做普通用户权限下的只读观察或访问无害的伪设备。

## 0. 本讲定位：打开上一讲的两个黑箱

上一讲追踪一个 token 时，网络包似乎自动从 socket 进入网卡，CUDA kernel 也似乎在 API 调用后自动运行。
本讲把这两个黑箱打开：

```text
应用程序
  │ open/read/write/ioctl/mmap/poll
  ▼
操作系统对象 ── 设备驱动 ── 控制器寄存器/命令队列
                              │
                   PIO/MMIO、interrupt、DMA
                              │
                              ▼
                      总线与物理设备
```

真正统一键盘、磁盘、摄像头、GPU 和虚拟机的，不是它们传输的数据长得一样，而是它们都能被描述为：

1. 一组可观察的状态；
2. 一组能触发状态迁移的命令；
3. 一条或多条搬运数据的通路；
4. 一种通知完成、错误和热拔插的办法；
5. 一个由操作系统执行的共享、隔离和生命周期策略。

因此本讲的主线不是“背设备端口号”，而是把设备还原为状态机，再看操作系统如何把千差万别的状态机包装成对象。

## 1. 学习目标与问题地图

学完本讲，你应该能够：

- 用 `status / command / data` 三类寄存器描述 canonical device 的状态机；
- 区分 x86 port I/O 与 MMIO，并说明为什么普通 C 指针和 `volatile` 不足以正确访问设备；
- 区分轮询、中断和 DMA：谁搬数据、谁通知完成、CPU 花费在哪里；
- 从 GPIO、UART、PS/2、ATA PIO 代码中找出相同的“等待—下命令—传数据—完成”协议；
- 解释 PostScript、IPP 和 UVC 如何把复杂物理设备变成可交换的字节与命令；
- 说明 GPU/NPU 为什么既是 I/O 设备，又像一台拥有内存和处理器的计算机；
- 解释总线除转发地址外，还怎样完成枚举、资源分配、中断、DMA、供电和热插拔；
- 读懂 PCI BDF、vendor/device/class、BAR、driver binding 和 sysfs 的关系；
- 准确解释 “Everything is a File”，而不把它误解为“一切都是普通磁盘文件”；
- 区分 `read/write` 数据面与 `ioctl` 控制面，并知道 `mmap/poll` 为什么也常出现；
- 描述 `/dev/kvm` 的 fd 层级和 V4L2 摄像头的 streaming buffer 状态机；
- 在不需要 root、不改硬件状态的条件下，从 `/dev` 与 `/sys` 验证上述抽象。

本讲按 PPT 的三段结构展开：简单/有趣设备（§4–§12）→ 协处理器和总线（§13–§17）→ 程序看到的 OS 对象（§18–§26）。

## 2. Review & Comments

### 2.1 Virtualization & Concurrency 的落点

经典 UNIX 给应用一个建立在进程和系统调用之上的世界。
`spawn(T_worker)` 又打开并行、异步和异构计算：多个执行流会同时访问对象，访问便意味着共享，共享便要求同步。

文件描述符是这个世界里非常关键的一类句柄：

```text
进程中的小整数 fd
  → 进程 fd table 的表项
  → 内核 open file description / struct file
  → 一组具体操作及其私有状态
  → tty、pipe、socket、磁盘、GPU、KVM、摄像头……
```

它像“指向 OS 对象的指针”，但比裸指针多了权限、引用计数、共享 offset、阻塞语义和关闭时的生命周期处理。
我们早已直接使用 tty 和 disk，只是此前把它们当作现成服务；现在要向下追到驱动和控制器。

### 2.2 从 token 的数据中心路径接过来

上一讲的 NIC 收包路径可以先写成一个尚未展开的等式：

```text
socket 可读
  ≠ packet 凭空出现
  = NIC 收到信号
  + DMA 把 frame 放进内存 ring
  + device/driver 更新所有权
  + interrupt 或 polling 通知 CPU
  + 网络栈逐层解析并唤醒进程
```

GPU 路径也类似：用户态库提交 command buffer，驱动建立映射，DMA 搬运数据，设备执行，fence/interrupt 报告完成。
这两个例子会在本讲汇合成 canonical device model。

## 3. 今天的主角：输入输出设备

我们实际“看见”的计算机通常是屏幕、键盘、摄像头、扬声器、网口、USB 插槽和机箱灯，而 CPU、cache、页表和大部分内存活动都藏在内部。

![日常看到的 I/O 设备](../../sources/site_html/static/img/iodevices.jpg)

“输入/输出”是相对于计算系统而言：

- sensor 把温度、光、声音、按键和网络电信号变成数据；
- actuator 把数据变成像素、声音、纸面图形、马达动作或电平；
- storage 在时间维度上连接现在与未来；
- accelerator 接收程序和数据，返回计算结果；
- virtual device 甚至没有独立物理外壳，却仍实现同一控制合同。

同一个设备也常同时输入和输出：键盘接收 LED/重复速率命令，打印机回报缺纸，摄像头接收曝光设置，磁盘接收写入又返回读取数据。

## 4. I/O 设备：“计算” 和 “物理世界” 之间的桥梁

### 4.1 Canonical device：先看接口，不猜内部

从 CPU 一侧，一个最小设备可以抽象为几组约定好功能的线或寄存器：

| 寄存器类别 | CPU/驱动的动作 | 设备的动作 |
| --- | --- | --- |
| `status` | 读取 ready/busy/done/error | 在状态迁移时更新位 |
| `command` | 写入操作码，启动动作 | 校验命令并进入 busy |
| `data/argument` | 读写小数据或地址/长度 | 消费参数或产生结果 |

![Canonical device](../../sources/site_html/static/img/canonical-device.png)

Address Decoder 判断一次 CPU 访问应落到 RAM 还是某个设备寄存器。
在不同平台上，驱动可能使用独立 port space 的 `in/out` 指令，也可能把寄存器映射进物理地址空间，用 load/store 形式的 MMIO 访问。

一个同步读取协议可写成：

```c
/* 教学伪代码，不是可直接访问真实硬件的程序。 */
while (!(read_status() & READY))
  ;
write_argument(buffer_address);
write_command(READ);
while (read_status() & BUSY)
  ;
if (read_status() & ERROR)
  handle_error();
else
  consume_data();
```

这里已经有完整状态机：

```text
IDLE/READY --command--> BUSY --success--> DONE/READY
                         └----error-----> ERROR
```

协议必须回答比“哪个地址”更多的问题：命令前参数是否写全、busy 时能否再提交、完成位由谁清除、设备 reset 后旧命令怎样处理、拔出时正在等待的线程收到什么错误。

### 4.2 PIO、MMIO、中断和 DMA 各管一件事

这四个词不在同一维度：

| 机制 | 解决的问题 | 数据由谁搬 | CPU 是否持续等待 |
| --- | --- | --- | --- |
| port I/O（PIO 的一种接口含义） | CPU 如何访问独立 I/O 地址空间 | CPU 指令 | 取决于协议 |
| MMIO | CPU 如何用地址空间访问寄存器 | CPU 指令 | 取决于协议 |
| programmed I/O（PIO 的另一常见含义） | 小数据怎样逐字经过 data register | CPU | 通常轮询或频繁介入 |
| interrupt | 设备怎样异步通知事件/完成 | 不负责搬 payload | CPU 可先做别的事 |
| DMA | 大块数据怎样在设备与内存间移动 | 设备/控制器 | CPU 只设置和收尾 |

所以“用了中断”不等于“用了 DMA”，也不等于“没有 MMIO”。
现代 NIC 常用 MMIO 写 doorbell、DMA 读写 descriptor/buffer、MSI-X 通知完成；高负载时驱动又可能暂时关闭中断并轮询 ring。

### 4.3 为什么不能直接写 `volatile uint32_t *reg`

`volatile` 主要约束编译器不要删除或合并某些访问，却不自动处理：

- CPU、互连和设备要求的内存顺序；
- posted write 尚未真正到达设备；
- 设备寄存器端序和访问宽度；
- 某些架构访问 I/O 的特殊指令；
- 生命周期、资源申领和热拔插。

Linux 驱动应先 `ioremap()`，再用 `readl()/writel()` 等 accessor；不要把 `__iomem` 当普通 RAM 指针，也不要对它直接 `memcpy`。
[Linux bus-independent device access 文档](https://docs.kernel.org/driver-api/device-io.html)还特别说明：PCI write 可能 posted，某些需要确认落地的路径必须读回同一设备来 flush。

## 5. 实现核弹发射：只需要 “一根线” I/O 设备

GPIO（General Purpose Input/Output）是极简例子：读取 input line 得到逻辑电平，写 output line 改变电平。
课件用 Raspberry Pi 灯说明“一个 MMIO bit 就能影响物理世界”，并以 logic 1 = 3.3V 建立直觉。

![GPIO 控制 LED](../../sources/site_html/static/img/gpio-led.jpg)

但 3.3V 不是 GPIO 的普遍真理，而是具体板卡的电气规格；还需确认：

- 引脚是否耐受该电压，是否 5V tolerant；
- output current 上限，LED 是否串联限流电阻；
- active-high 还是 active-low；
- 上拉/下拉、open-drain、复用功能和上电默认状态；
- 进程 crash、内核 panic 或断电时 actuator 的 fail-safe 状态。

“发射只需一根线”恰好说明安全不能只放在软件按钮上。
真实高风险 actuator 需要硬件联锁、双通道确认、权限分离、审计和安全失效状态；一根线只是最后的物理动作接口。

## 6. [GPIO LED](/OS/demos/persistence/gpio-led)

[课堂 GPIO LED 演示](https://jyywiki.cn/OS/demos/persistence/gpio-led)展示程序确实可以让真实引脚改变电平。
它同时强调：能直接操纵寄存器，不代表应用应该这样做。

现代 Linux 更推荐 GPIO character-device API：chip 表现为 `/dev/gpiochipN`，应用 request 若干 line 后得到另一个 fd，再读写 line value 或 edge event。
这让内核能记录 consumer、拒绝重复占用并统一 active-low 等语义；详见 [GPIO character device userspace API v2](https://docs.kernel.org/userspace-api/gpio/chardev.html)。

在陌生板卡上只做发现，不写输出：

```bash
ls -l /dev/gpiochip* 2>/dev/null || printf 'no GPIO chip exposed\n'
command -v gpiodetect >/dev/null && gpiodetect
command -v gpioinfo >/dev/null && gpioinfo | sed -n '1,40p'
```

不要照抄网上的 GPIO 编号，更不要用 `/dev/mem` 绕过驱动。
一个编号可能正连着电源使能、风扇、复位、存储写保护或其他需要稳定状态的硬件。

## 7. 串口 (UART)

UART（Universal Asynchronous Receiver/Transmitter）把并行字节编码为一根发送线上的异步帧，再从接收线还原。
双方没有共享 clock line，必须预先约定 baud rate、data bits、parity 和 stop bits。

常见 `8N1` 帧含 1 个 start bit、8 个 data bit、无 parity、1 个 stop bit。
因此 9600 baud 的理想有效载荷上限不是 9600 byte/s，而约为：

```text
9600 bit/s ÷ 10 bit/byte = 960 byte/s
```

PPT 中 PC 的 COM1 基址是 `0x3f8`：

```c
#define COM1 0x3f8

static void uart_tx(unsigned char byte) {
  outb(COM1, byte);                 // 写 data register
}

static int uart_rx(void) {
  return (inb(COM1 + 5) & 0x1)     // 查询 line status
           ? inb(COM1) : -1;
}
```

初始化还会写 divisor、line control 和 FIFO 等寄存器。
上述代码省略了 busy/empty 检查、并发、错误位和超时，只用于识别寄存器协议；`inb/outb` 是特权操作，普通应用不能直接执行。

Linux 通常把物理串口暴露为 `/dev/ttyS0`。
这不是简单把 `write(fd, "x", 1)` 翻译成一次 `outb`：tty 层还可能处理 line discipline、canonical mode、echo、信号字符、流控和缓冲；`termios` 配置最终经 ioctl 到达 tty/driver。
FIFO 和发送/接收中断让 CPU 不必逐 bit 等待。

## 8. 键盘控制器

IBM PC/AT 的 8042/PS/2 键盘接口只需 Data、Clock、VCC、GND 加两根预留线。
主机通过 port `0x60` 交换数据，通过 `0x64` 读 status/写 command。

![PS/2 接口](../../sources/site_html/static/img/ps2-ports.jpg)

PPT 的两个命令说明键盘不是单向 input：

- `0xED` 控制 Num Lock/Caps Lock/Scroll Lock LED；
- `0xF3` 设置 typematic repeat rate 与 delay。

一次按键路径可还原为：

```text
机械触点变化
  → 键盘微控制器产生 scan code
  → 控制器 data register 非空
  → interrupt
  → 内核读取 scan code、维护按下/释放状态
  → input subsystem 产生 key event
  → tty/图形系统/应用消费
```

现代 USB 键盘走 HID class 而不是 8042 数据线，但状态机思路不变：描述能力、提交 transfer、收到 completion、解释 event。
此外，键盘数据极敏感；访问 input event 节点通常受权限限制，以免普通进程成为 keylogger。

## 9. 磁盘控制器

PPT 用 legacy ATA/IDE 展示一段完整的 programmed I/O read。
primary channel 常用 `0x1f0–0x1f7`，secondary channel 常用 `0x170–0x177`：

```c
/* 教学摘录：特权环境中的 legacy ATA PIO，不可在普通应用运行。 */
void readsect(void *dst, int sect) {
  waitdisk();
  out_byte(0x1f2, 1);                    // sector count
  out_byte(0x1f3, sect);
  out_byte(0x1f4, sect >> 8);
  out_byte(0x1f5, sect >> 16);
  out_byte(0x1f6, (sect >> 24) | 0xe0);  // drive + high LBA bits
  out_byte(0x1f7, 0x20);                 // READ SECTORS
  waitdisk();
  for (int i = 0; i < SECTSIZE / 4; i++)
    ((uint32_t *)dst)[i] = in_long(0x1f0);
}
```

逐句看，它仍是 canonical protocol：

1. 等待设备 ready；
2. 写 count 和 sector address 参数；
3. 写 command `0x20`；
4. 等待设备准备好 data；
5. CPU 从 data port 搬走一个 sector。

注释沿用了 CHS 时代的 `sector/cylinder` 名称，但这里拼接的其实是 LBA 位。
真实驱动还要处理 status/error、timeout、reset、锁、请求队列和设备消失。
PIO 的根本成本是每个 word 都要经过 CPU；现代 SATA/NVMe 数据面主要依赖 DMA 和队列。

这一接口只承诺“按编号读写块”，还没有回答缓存、调度、掉电、持久化和文件组织。
这些问题正是下一讲“存储抽象”的起点。

## 10. 打印机

课件借 [CalComp 565 软件参考手册](https://jyywiki.cn/OS/manuals/CalComp-Software-Reference.pdf)提醒：任何能 input/output 的东西都可成为 canonical device。

![CalComp 565](../../sources/site_html/static/img/calcomp-565.jpg)

打印机接收的不是“纸”，而是描述文本、图形、纸张、份数和装订等意图的字节；设备再把它转成电机、激光、喷头和纸路动作。
它也产生状态：idle、processing、paused、out-of-paper、jammed、door-open、completed、failed。

直接让多个进程同时向打印机写字节会把 job 交错。
spooler 因而承担排队、权限、格式转换、重试和状态管理：

```text
application → print job → spool queue → backend/protocol → printer
```

这已经出现一个重要设计模式：驱动不必等同于最终应用抽象。
应用提交“job”，spooler 再使用设备或网络协议。

## 11. PostScript 和打印机

PostScript 是 Adobe 在 1980 年代发展出的页面描述编程语言。
它维护 graphics state，构造 path、stroke/fill，放置 text/image，最后 `showpage`：

```postscript
%!PS
/Helvetica findfont 24 scalefont setfont
72 720 moveto
(Hello, device state machine!) show
showpage
```

LaTeX 等排版系统像 compiler，把更高层文档转换成打印设备能解释的页面语言。
PCL 则常用 escape sequence 控制分辨率、raster mode 和数据传送；PPT 示例的结构是：

```text
<ESC>*t300R   选择 300 DPI
<ESC>*r1A     开始 raster graphics
<ESC>*b100W   指定一行 raster 数据宽度
<binary>      发送像素数据
<ESC>*rB      结束 raster graphics
```

PPT 将 PDF 称为 PostScript 的“改进版”，适合作为历史直觉，但机制上要更精确：PostScript 是可执行的 stack-based language；PDF 是面向随机访问与交换的 declarative object/document format，并不是把任意 PostScript 程序原样装进去。

IPP 又处在不同层。
它定义 Printer、Job、Document、attributes 和 submit/query/cancel 等操作，是分布式打印控制协议，而不是页面绘制语言；见 [RFC 8011](https://www.rfc-editor.org/info/rfc8011/)。

```text
文档内容：PostScript / PDF / raster / PCL ...
作业控制：IPP（或历史上的 LPD/lp/lpr）
机械执行：printer controller + marking engine
```

边界同样重要：PostScript 是程序，复杂 interpreter 可能有漏洞或消耗大量资源；不要用高权限、无限资源的解释器处理来源不明的文件。

## 12. [PostScript](/OS/demos/persistence/postscript)

[课堂 PostScript 演示](https://jyywiki.cn/OS/demos/persistence/postscript)把“打印机 = 页面语言解释器”的说法变成可观察结果。
若本机安装 Ghostscript，可在 `/tmp` 做一个不接触真实打印机的小实验：

```bash
printf '%s\n' \
  '%!PS' \
  '/Helvetica findfont 24 scalefont setfont' \
  '72 720 moveto' \
  '(Hello, PostScript!) show' \
  'showpage' > /tmp/hello.ps

if command -v gs >/dev/null; then
  gs -q -dSAFER -dBATCH -dNOPAUSE -sDEVICE=png16m \
    -r72 -sOutputFile=/tmp/hello.png /tmp/hello.ps
  file /tmp/hello.png
else
  printf 'Ghostscript is not installed; inspect /tmp/hello.ps as text\n'
fi
```

预期得到一张包含文字的 PNG。
`-dSAFER` 是必要的防线之一，但不能替代及时更新 interpreter、限制 CPU/内存/文件访问和隔离不可信输入。
不要为了验证语言而把作业发到共享打印队列；`lp/lpr` 可能真的耗纸、墨粉并泄露内容。

## 13. 摄像头 (WebCam)

“免驱摄像头”不是没有 driver，而是实现了 UVC（USB Video Class）共同规范，系统已有 class driver。
接入后的典型协议是：

```text
USB enumerate descriptors
  → 识别 Video Class / interfaces / endpoints
  → 查询 format、resolution、frame interval
  → 协商 MJPEG/H.264/uncompressed 等模式
  → 分配并排队 buffers
  → 启动 isochronous/bulk transfers
  → 逐帧交还应用，再把 buffer 排回队列
```

UVC 的价值是把厂商差异压在规范之后；[USB-IF UVC 1.5 文档集](https://www.usb.org/document-library/video-class-v15-document-set)列出了 uncompressed、MJPEG、H.264 等 payload 规范。

即使传的是压缩 frame，它仍是带 framing/metadata 的 byte stream。
同一协议于是催生行车记录仪、显微镜、内窥镜、扫描仪和眼球鼠标等设备。

![Webcam 衍生设备](../../sources/site_html/static/img/webcam-scanner.jpg)

带宽必须算：1920×1080、RGB24、30 fps 的未压缩 payload 约为：

```text
1920 × 1080 × 3 × 30 ≈ 186.6 MB/s
```

压缩、USB 传输开销、多个 endpoint 和主机控制器调度都会影响可行模式。
摄像头还是隐私边界：设备节点权限、应用 sandbox、使用指示与数据保存策略都不能由“标准协议”自动解决。

## 14. 打破 I/O 设备与内存之间的边界

### 14.1 从 programmed I/O 到 DMA

如果 CPU 逐字执行 ATA `in_long()`，CPU 同时承担控制和搬运。
DMA（Direct Memory Access）让专用控制器在设备与内存间执行类似 hard-wired `memcpy` 的任务，CPU 只做 setup 和 completion。

PPT 用 i8237 的概念线程表示早期 DMA：轮询 channel，依据 mode 在 I/O 端口和 memory address 间移动 byte/word，并按 priority 选择 channel。
现代设备更常自己成为 bus master，读取内存中的 descriptor ring：

```text
CPU/driver:
  allocate buffers
  map buffers for DMA
  fill descriptors {dma_addr, len, flags}
  publish producer index
  MMIO write doorbell

device:
  fetch descriptors
  DMA payload
  write completion/status
  raise interrupt or wait for host poll

CPU/driver:
  observe completion
  unmap/recycle buffer
  wake waiting software
```

DMA 不是“设备随便访问任意虚拟地址”。
驱动拿到的 CPU virtual address、CPU physical address 与 device DMA address 可能三者不同；IOMMU 还能把 device-visible IOVA 翻译到被授权的 RAM page。
[Linux DMA mapping guide](https://docs.kernel.org/core-api/dma-api-howto.html)要求驱动使用 DMA API，并在正确生命周期 map/unmap。

### 14.2 三类容易漏掉的正确性条件

**所有权。** CPU 填 descriptor 时设备不能同时消费；设备写 buffer 时 CPU 不能把半帧当完成帧。ring index、ownership bit 与 memory barrier 建立移交点。

**一致性。** 有的平台 cache 不与 DMA 自动 coherent，需显式 sync；即使 coherent，descriptor 内容与 doorbell 的顺序也不能靠运气。

**隔离。** 出错或恶意设备若能 DMA 任意 RAM，可越过进程页表读密钥或改内核。IOMMU、最小映射、及时 unmap 和可信驱动缩小范围，但不能消除固件与总线攻击面。

### 14.3 Interrupt 是通知，不是 payload

中断的价值是 CPU 不必一直问“好了吗”。
handler 通常只确认来源、ack/mask、记录 completion 并安排后续工作，避免在中断上下文做漫长解析。

负载升高时，每个 packet 一个中断会造成 interrupt storm；NIC 常用 interrupt coalescing，Linux 网络收包还会切换为有预算的 polling。
因此 polling 与 interrupt 不是永恒二选一，而是 latency、throughput 与 CPU/power 的动态权衡。

## 15. 异构加速器：GPU 和 NPU

GPU 看起来像完整计算机：有 instruction/kernel、scheduler、local/shared/global memory、cache 和大量执行单元。
但 host 仍需建立它的工作：

```text
cudaMalloc/allocator   → 获得 device-visible storage
cudaMemcpy/DMA         → 搬 input、weight 或 command metadata
kernel launch          → 提交 grid/block/thread 计算
event/fence/interrupt  → 观察完成
copy/map result        → host 或下游 device 消费
```

`cudaMalloc`、`cudaMemcpy` 等接口的具体同步语义应查 [NVIDIA CUDA Runtime API](https://docs.nvidia.com/cuda/cuda-runtime-api/index.html)；不能仅凭函数名断言某次 copy 一定同步或一定走某条物理链路。

NPU 采用同样骨架，却把可执行工作收窄为 tensor graph/operator，换取能效和部署约束。
PPT 的 Qualcomm SNPE 例子通过 input/output map 调用 `execute()`，高层是一行，底层仍要完成 model load、buffer mapping、command submission、device scheduling 和 completion。

“设备上自带电脑”带来新问题：

- firmware 与用户态 runtime/driver 的版本合同；
- 多进程 context、地址空间和抢占；
- hang 检测与 reset 后未完成 job 的语义；
- command parser 能否抵御恶意输入；
- 显存/共享 buffer 是否跨进程泄露。

设备越聪明，canonical interface 越像“向另一台计算机发消息”，但状态机并未消失。

## 16. 连接万千设备：总线

早期大型机由 IBM、DEC 等厂商定义封闭扩展；微型机则让车库里的开发者把卡插进标准 slot。
IBM PC/AT 的 ISA 与 Apple II 50-pin connector 都体现同一目标：让新设备接入既有系统。

最小总线负责 address/data/control 转发：设备 decode 属于自己的 address，未命中的访问继续或被忽略。
但可扩展生态还需要更多服务：

- topology 与 enumeration：有哪些 device/function；
- identity 与 capability：谁生产、属于哪类、支持什么；
- resource allocation：I/O range、MMIO range、interrupt vector；
- arbitration/routing：多个发起者如何共享链路；
- DMA 与 coherency contract；
- power management、reset、error reporting、hotplug；
- driver matching 与用户态 hotplug event。

因此“总线是一个 I/O 设备”是很好的 CPU 视角：CPU 向 host bridge/root complex 发事务，后者在层级拓扑中路由。
但从系统视角看，总线也是命名、发现、资源和故障域。

Windows 98 USB PnP 演示之所以经典，恰好因为 plug-and-play 不是一根线插上就结束；enumeration、driver binding、resource 和 lifecycle 中任一环都可能失败。

## 17. PCIe 和 CXL

### 17.1 PCIe：从共享并行线到 packet-switched link

PCI Express 不是 ISA 那样所有卡共用的一排并行 address/data 线，而是 root complex、switch、endpoint 组成的 point-to-point packet fabric。
一条 link 由若干 lane 组成，常见 x1/x4/x8/x16。

软件从 configuration space 读 vendor ID、device ID、class code 和 capability；BAR 描述设备需要的 I/O/MMIO window；系统分配资源后，driver 才能 map registers、设置 DMA mask、分配 interrupt vector 并 enable bus mastering。

现代高速设备——GPU、FPGA、NIC、NVMe、USB host controller——常直接挂在 PCIe 上。
Message-Signaled Interrupt（MSI）本质是设备向特殊 address 发一次 write，而不是拉一根独占中断线；Linux 的 [MSI 文档](https://docs.kernel.org/PCI/msi-howto.html)明确给出这个定义。

课件写“PCIe 6.0 x16 达到 128 GB/s”。这里要标清方向：PCI-SIG 给出的最大 **双向合计** 是 256 GB/s，因此可把课件数字理解为每方向约 128 GB/s；参见 [PCIe 6.0 发布说明](https://pcisig.com/blog/pcie%C2%AE-60-specification-released-members-double-bandwidth-next-generation-applications)。协议开销、transaction size、拓扑和实现还会让应用有效带宽更低。

标准 slot 可供电不意味着所有卡都只需 slot power。课件的 75 W 说明为何高功率 GPU 还要独立 6/8-pin 或更新供电连接；供电、散热和 signal integrity 都是接口合同的一部分。

### 17.2 CXL：在 PCIe 物理基础上扩展 coherency 与 memory semantics

CXL 定义三类协议语义：

- `CXL.io`：发现、配置、管理等 I/O 语义；
- `CXL.cache`：device 对 host memory 的 coherent cache 访问；
- `CXL.mem`：host 对 device-attached memory 的 load/store 访问。

CXL 3.0 增强 switching/fabric、memory pooling 和 sharing，可把 GPU、NPU、memory expander 乃至另一计算域中的 memory 纳入可组合系统；见 [CXL 3.0 white paper](https://computeexpresslink.org/wp-content/uploads/2023/12/CXL_3.0_white-paper_FINAL-1.pdf)和[公开规范](https://computeexpresslink.org/wp-content/uploads/2024/02/CXL-3.0-Specification.pdf)。

“共享内存”不等于任意 C pointer 自动跨机正确工作。
软件仍要理解 topology、coherency domain、NUMA latency、capacity provisioning、failure containment、security 与 hot-remove。
Disaggregated Datacenter 改写 memory hierarchy，却没有取消 locality 和故障模型。

### 17.3 设备发现与驱动绑定

Linux 中一条典型路径是：

```text
firmware/host bridge 枚举 PCI function
  → kernel PCI core 建立 struct device、读取 ID/BAR/capability
  → bus match(device, driver IDs)
  → 匹配后调用 driver probe()
  → driver 申领资源、初始化 queue/interrupt/DMA
  → sysfs 反映 topology、attributes、driver symlink
  → kernel uevent；udev 按规则建立名字/权限/symlink
  → application open 对应 /dev node 或通过 subsystem API 使用
```

Linux driver model 在匹配后调用 `probe()`，移除时走 `remove()` 与引用计数；详见[官方 driver binding 文档](https://docs.kernel.org/driver-api/driver-model/binding.html)。
`/dev` 节点不是 driver 本身，只是一个名字与 major/minor，`open()` 时 VFS 才找到注册的操作。

## 18. 实验 1：只读发现一块 PCI 设备

目标是把 `lspci` 的人类可读结果与 sysfs 的对象/driver 关系对齐。
只读命令不需要 root：

```bash
lspci -nnk | sed -n '1,40p'

dev=$(find /sys/bus/pci/devices -mindepth 1 -maxdepth 1 \
        -type l -printf '%f\n' | sort | head -n 1)
if test -n "$dev"; then
  printf 'BDF: %s\n' "$dev"
  for attr in vendor device class irq; do
    printf '%-7s ' "$attr"
    sed -n '1p' "/sys/bus/pci/devices/$dev/$attr"
  done
  printf 'driver  '
  readlink "/sys/bus/pci/devices/$dev/driver" 2>/dev/null \
    || printf '(unbound)\n'
  printf 'module  '
  readlink "/sys/bus/pci/devices/$dev/driver/module" 2>/dev/null \
    || printf '(built-in, absent, or unbound)\n'
else
  printf 'no PCI function is exposed in this environment\n'
fi
```

预期观察：

- `00:14.0` 一类字符串是 domain 省略时的 `bus:device.function`（BDF）；
- `vendor`/`device` 是匹配硬件的 ID，`class` 描述功能类别；
- `driver` symlink 指向当前绑定 driver；没有链接不等于设备不存在；
- `module` 缺失也可能因为 driver built-in，而不一定是“没驱动”；
- 容器或 VM 只会看到 host 选择暴露的虚拟/直通拓扑。

本仓库环境的一次实测看到了 AMD root complex、IOMMU、PCI bridges 与 SMBus controller；第一项 host bridge 没有 `driver` 链接，这正说明“枚举到”与“绑定一个可见 module”不是同一件事。

安全边界：只读 `vendor/device/class/irq` 即可。
不要向 `config`、`enable`、`remove`、`resource*`、`driver/unbind` 写数据，也不要运行写模式 `setpci`；这些操作可能立即让磁盘、网卡或显示设备离线。
[PCI sysfs 文档](https://docs.kernel.org/PCI/sysfs-pci.html)明确区分了只读与可写属性。

## 19. 应用程序如何访问设备？

让每个应用直接访问 bus/register 会同时破坏四条边界：

1. **共享**：两个进程写同一 command/data register，事务会交错；
2. **保护**：应用可 DMA 或读取不属于它的内存；
3. **抽象**：换一个 controller，所有应用都要重写；
4. **恢复**：timeout、reset、hot-unplug 时无人统一收束状态。

于是 OS 将设备虚拟化：driver 独占硬件机制，向上暴露更稳定的对象。
这与 CPU/内存虚拟化同源——进程看见 virtual CPU 和 virtual address space，而不是随意操纵其他进程或物理页。

一条设备访问会跨越多个合同：

| 层 | 看见什么 | 负责什么 |
| --- | --- | --- |
| application/library | stream、frame、job、tensor、VM | 业务语义与错误策略 |
| syscall/VFS/subsystem | fd、buffer、request | 权限、阻塞、复用、对象生命周期 |
| driver | queue、register、interrupt、DMA mapping | 翻译、同步、恢复、硬件差异 |
| bus/IOMMU | transaction、address、interrupt message | 路由、隔离、排序 |
| controller/device | state machine、firmware、physical action | 真正执行与回报状态 |

“driver 只是寄存器翻译器”是起点，不是终点。
它还必须和 scheduler、power management、hotplug、security、memory management 协作。

## 20. Everything is a File

### 20.1 “File” 指统一操作接口，不是统一数据语义

Linux VFS 用 `struct file_operations` 描述一个 open object 支持哪些操作：

```c
/* 概念性节选；字段会随内核版本演化，不是稳定模块 ABI。 */
struct file_operations {
  struct module *owner;
  loff_t  (*llseek)(struct file *, loff_t, int);
  ssize_t (*read)(struct file *, char __user *, size_t, loff_t *);
  ssize_t (*write)(struct file *, const char __user *, size_t, loff_t *);
  __poll_t (*poll)(struct file *, struct poll_table_struct *);
  long    (*unlocked_ioctl)(struct file *, unsigned int, unsigned long);
  int     (*mmap)(struct file *, struct vm_area_struct *);
  int     (*release)(struct inode *, struct file *);
  /* ... */
};
```

VFS 用 fd 找到 open `struct file`，再调用对应 method；[Linux VFS 文档](https://docs.kernel.org/filesystems/vfs.html)给出了这条 dispatch 路径。
同名 syscall 因对象不同而具有不同语义：

| 对象 | `read` | `write` | 其他常用操作 |
| --- | --- | --- | --- |
| regular file | 从 offset 取 byte | 在 offset 放 byte | `lseek`, `mmap`, `fsync` |
| tty/UART | 取 line discipline 后的字符 | 排队发送/显示字符 | termios `ioctl`, `poll` |
| `/dev/zero` | 生成零 | 通常丢弃 | `mmap` zero pages |
| camera | 取 frame 或 metadata | 依设备类型 | V4L2 `ioctl`, `mmap`, `poll` |
| GPU render node | 读 event | 很少作为主要 submit API | DRM `ioctl`, `mmap`, fence |
| KVM object | 并非主要数据通路 | 并非主要数据通路 | KVM `ioctl`, `mmap` |

所以口号更准确的版本是：**许多 OS 对象可用 fd 表示，并复用一组系统调用；每类对象仍定义自己的合同。**
socket、epoll、匿名 pipe 和由 ioctl 返回的 VM/vCPU fd 甚至不需要先有普通 pathname。

### 20.2 `/dev`：名字、类型和 major/minor

character/block special node 的 inode 保存类型与 device number。
major 通常选择 driver/subsystem，minor 区分实例；真正设备状态不“存放”在 `/dev/video0` 这个目录项里。
devtmpfs/udev 可根据 kernel 事件创建设备节点、权限和稳定 symlink。

课件写 `/dev/ptx`，这里应作勘误：Linux 的 pseudoterminal master multiplexer 是 **`/dev/ptmx`**，slave 节点通常位于 `/dev/pts/N`。
`/dev/null`、`/dev/zero` 和 `/dev/full` 则由相同 major 下不同 minor 区分。

拥有 node 名字不等于有访问权，也不等于硬件在线。
DAC mode、ACL、group、container device policy、LSM 以及 driver 自身检查都会影响 `open/ioctl/mmap`。

## 21. 实验 2：三个设备文件，三种 `write/read` 性格

这个实验只访问 Linux 的无害 character devices，不需要 root：

```bash
ls -l /dev/null /dev/zero /dev/full
stat -c '%n  kind=%F  major=%t minor=%T  mode=%A' \
  /dev/null /dev/zero /dev/full

head -c 16 /dev/zero | od -An -tx1
printf 'discarded bytes\n' > /dev/null

if printf x | dd of=/dev/full bs=1 count=1 status=none; then
  printf 'unexpected success\n'
else
  printf '/dev/full rejected the write as expected\n'
fi

for number in 1:3 1:5 1:7; do
  printf '%s -> ' "$number"
  readlink -f "/sys/dev/char/$number/subsystem"
done
```

典型观察：

```text
/dev/null  major=1 minor=3
/dev/zero  major=1 minor=5
/dev/full  major=1 minor=7
00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00
dd: error writing '/dev/full': No space left on device
/dev/full rejected the write as expected
```

三者都是 character special file，也走 `open/read/write/close`，行为却完全不同：null 丢弃，zero 合成零，full 用 `ENOSPC` 模拟写满。
这证明统一的是调用形状，不是语义。

`stat -c %t/%T` 以十六进制打印 major/minor；`ls -l` 常以十进制显示，比较时不要误判。
`/sys/dev/char/1:5` 把 device number 接回 kernel device tree。

边界：不要把类似命令替换成真实 block device（如 `/dev/nvme0n1` 或 `/dev/sda`）；向它们写一个 byte 就可能破坏分区或文件系统。

## 22. [一个设备驱动程序](/OS/demos/persistence/launcher)

[课堂 launcher driver 演示](https://jyywiki.cn/OS/demos/persistence/launcher)展示如何实现 `struct file_operations`，把 syscall 翻译成模拟设备能理解的动作。
最小 character driver 的形状类似：

```c
static const struct file_operations launcher_fops = {
  .owner          = THIS_MODULE,
  .open           = launcher_open,
  .read           = launcher_read,
  .write          = launcher_write,
  .unlocked_ioctl = launcher_ioctl,
  .release        = launcher_release,
};
```

每个 callback 都要回答：

- user pointer 与 length 如何验证，partial I/O 怎样返回；
- blocking/nonblocking 时没有数据怎么办；
- 多个 fd 共享哪部分 state，每次 open 独有哪部分 state；
- concurrent read/write/ioctl 怎样同步；
- signal、timeout、device removal 和 close 如何取消工作；
- 哪些操作要求 capability 或 device ownership；
- kernel/user ABI 中结构体的大小、对齐和版本怎样兼容。

内核模块 API 没有跨版本稳定 ABI，不能从一个版本复制 `file_operations` 初始化器并期待永久编译。
教学驱动应在 disposable VM 中实验；一个有 use-after-free、越界 copy 或错误 DMA address 的 driver 可以让整个内核崩溃或泄露数据。

## 23. ioctl

### 23.1 为什么 `read/write` 不够

stream 很适合“取/放数据”，但设备还有不自然地表示为 byte stream 的配置：

- 打印机：查询 jam/ink、clean、staple、paper tray；
- 键盘/tty：LED、baud、repeat、line discipline；
- 磁盘：SMART、cache policy、discard、identify；
- 摄像头：枚举 format、设曝光/帧率、申请 buffer；
- GPU/KVM：创建 context/VM、映射 memory、提交 command。

`ioctl(fd, request, arg)` 因而成为 device-specific control channel。
[ioctl(2)](https://man7.org/linux/man-pages/man2/ioctl.2.html)的关键点是：fd 必须已打开，而 request、argument、return value 与 semantics 由对应 driver/UAPI 定义；它不是 POSIX 的统一可移植设备配置语言。

Linux 常用 `_IO/_IOR/_IOW/_IOWR` 构造 request number，编码 namespace、序号、方向与 argument size。
这些 bit 只帮助 dispatch/检查，不会自动序列化复杂 pointer graph，也不会自动建立版本兼容。

### 23.2 数据面与控制面不是绝对二分

一种实用划分是：

```text
read/write      顺序或消息式 payload
ioctl           capability/query/config/lifecycle
mmap            共享大 buffer、queue、doorbell page
poll/epoll      等待 readiness/completion/event
close           释放引用并触发取消/回收
```

但设备可以把 command stream 放进 `write`，也可通过 ioctl 提交大数组。
真正标准来自具体 subsystem UAPI，而不是 syscall 名字。

错误检查不能只看返回值是否为 0：多数 ioctl 成功返回 0，少数用非负返回值传结果；失败统一为 `-1` 并设置 `errno`。
`ENOTTY` 常表示对象不支持该 request，不是“终端坏了”。

## 24. 实验 3：`/dev/zero`、PTY 与一个 terminal ioctl

仓库的 [device_file.c](../../examples/device_file.c)同时演示：

1. `open/read/fstat/close` 访问 `/dev/zero`；
2. 对 stdout 调用 `TIOCGWINSZ`，读取 terminal rows/columns。

编译并分别在 pipe-like runner 与伪终端中运行：

```bash
cc -D_GNU_SOURCE -std=c17 -Wall -Wextra -Wpedantic -O2 \
  examples/device_file.c -o /tmp/device_file

/tmp/device_file
script -qec 'stty rows 24 cols 80; /tmp/device_file' /dev/null
```

本环境实测输出为：

```text
/dev/zero: fd=3 mode=020666 bytes-sum=0
stdout is not a terminal; TIOCGWINSZ is unavailable here
/dev/zero: fd=3 mode=020666 bytes-sum=0
terminal ioctl: rows=24 cols=80
```

同一个程序第一次 stdout 不是 tty，`TIOCGWINSZ` 不适用；`script` 分配 PTY 后，同一 fd number 对应的对象类别改变，ioctl 成功。
这也解释 libc 常如何判断 stdout 是否连接 terminal，再选择 line/full buffering；是用户态库用类似 `isatty` 的探测做策略，不是 kernel 替 `printf` 自动决定。

若平台允许 ptrace，还可观察 syscall：

```bash
strace -e trace=openat,read,newfstatat,ioctl,close /tmp/device_file
```

在本仓库容器中该命令返回 `PTRACE_TRACEME: Operation not permitted`；这是 sandbox/seccomp 权限边界，不是程序没有发 syscall。
不要为绕过教学容器策略而加特权运行。

严格 `-std=c17` 可能报告 `O_CLOEXEC` 未声明，所以命令显式启用 `_GNU_SOURCE`；也可选合适的 POSIX feature-test macro。
示例为保持短小，假定 `/dev/zero` 一次返回完整 32 bytes；通用设备程序还应循环处理 short read/`EINTR`，并检查 `close()` 在需要报告写回错误的对象上的结果。

## 25. ioctl (cont’d)

### 25.1 “隐藏的规格”并没有被一个 syscall 消灭

统一入口之后仍有大量 device-specific state：

| 子系统 | 代表性控制 | 隐藏复杂性 |
| --- | --- | --- |
| tty | `TCGETS/TCSETS`, `TIOCGWINSZ` | line discipline、session、signals、flow control |
| V4L2 | `VIDIOC_QUERYCAP/S_FMT/REQBUFS/...` | format negotiation、buffer queue、stream state |
| DRM | GEM/context/submit/fence ioctls | memory residency、scheduler、sync、reset |
| KVM | create VM/vCPU、set memory、run | guest state、VM exits、architecture |
| block | identify、discard、health | cache、firmware、persistence/error model |

复杂性无法凭口号降低，只能被分层、类型化、验证和封装。
libdrm、libv4l2、libc termios 等库把 raw ioctl 变成更稳定、易测试的接口；procfs/sysfs 则把适合文本或属性的数据表现为 pseudo-files。

### 25.2 ioctl ABI 为什么难维护

request argument 穿过 user/kernel boundary，必须考虑：

- pointer 是用户虚拟地址，必须安全 copy；
- 32/64-bit process 的 pointer width 与 struct padding 不同；
- 新字段怎样由 size/version 向后兼容；
- reserved bits 必须清零，未知 flag 应如何报错；
- variable-length array 怎样避免 overflow/TOCTOU；
- 一个 ioctl 是否可能阻塞，signal 后状态处于哪里。

良好的 UAPI 会用固定宽度整数、显式 size/version、reserved zero、上限检查和清晰 errno。
但用户仍应通过 subsystem 文档/库，而不是猜 request number。

## 26. [KVM Device](/OS/demos/persistence/kvm)

KVM 把硬件虚拟化包装成一组 fd 和 ioctl。
入口不是“把程序写进 `/dev/kvm`”，而是对象层级：

```text
open("/dev/kvm")
  → system fd
      ioctl(KVM_GET_API_VERSION)
      ioctl(KVM_CREATE_VM) ───────────────→ VM fd
                                           ├─ set guest memory region
                                           └─ ioctl(KVM_CREATE_VCPU) → vCPU fd
                                                                        ├─ mmap kvm_run
                                                                        └─ ioctl(KVM_RUN)
                                                                             ↓
                                                                    run until VM exit
```

ioctl 返回新 fd 是“fd 即能力句柄”的漂亮例子：拿到哪个 fd，决定能对哪个 VM/vCPU 执行哪些操作。
[KVM 官方 API](https://docs.kernel.org/virt/kvm/api.html)规定 `KVM_GET_API_VERSION` 应返回 12，并描述 `KVM_RUN` 与 `kvm_run` shared area。

[课堂 KVM Device 演示](https://jyywiki.cn/OS/demos/persistence/kvm)让一段 guest code 运行到 VM Exit。
exit 不是普通 process syscall：硬件先退出 guest mode，KVM 判断由 kernel 处理还是返回 userspace VMM；I/O port、MMIO、halt、shutdown 等 exit reason 可能需要 VMM 模拟。

做无副作用的环境探测：

```bash
if test -e /dev/kvm; then
  stat -c '%n kind=%F mode=%A owner=%U group=%G' /dev/kvm
  test -r /dev/kvm && printf 'read permission: yes\n' \
                    || printf 'read permission: no\n'
  test -w /dev/kvm && printf 'write permission: yes\n' \
                    || printf 'write permission: no\n'
else
  printf '/dev/kvm is absent: KVM is not exposed here\n'
fi
```

本仓库环境当前没有 `/dev/kvm`。
CPU flag 出现 `vmx`/`svm` 只是硬件线索，不能证明 firmware、host kernel、module、nested virtualization 和 container device policy 已共同提供 KVM。
不要擅自 `modprobe`、改 group 或把 `/dev/kvm` 暴露进容器；这些是管理员决定的安全面。

## 27. 终于，理解了 “操作系统的对象”

### 27.1 GPU：fd、mmap、ioctl 和 fence 的组合

GPU 有自己的 memory 与 command processor。
Linux DRM（Direct Rendering Manager）提供 kernel 侧资源管理，libdrm 封装 ioctl，Mesa 等用户态实现 OpenGL/Vulkan 并生成 hardware-specific commands。

一种简化路径是：

```text
open /dev/dri/renderD*
  → ioctl 创建 buffer/context
  → mmap 或导入共享 buffer
  → userspace 填 command/data
  → ioctl submit（内部可写 MMIO doorbell）
  → scheduler/device 执行与 DMA
  → fence/event 表示完成
```

DRM render node 去除了 modeset/global privileged ioctls，让 filesystem permission 控制 rendering access；见 [DRM userspace interface](https://docs.kernel.org/gpu/drm-uapi.html)。
但“可打开 render node”仍意味着能给复杂 GPU command parser 输入，driver 必须隔离 context、验证地址并处理 reset。

### 27.2 对象不是硬件的一比一影子

一个物理 GPU 可产生多个 context/buffer/fence fd；一个 KVM system fd 可创建多个 VM fd；一个 GPIO chip ioctl 可返回 line-request fd。
反过来，一个应用级“摄像头”也可能对应 USB function、media controller、V4L2 node 和多个 stream。

因此 OS object 的价值是按权限和生命周期切出 **可管理的使用实例**，而不是给每块硬件恰好一个全局文件。

## 28. [WebCam](/OS/demos/persistence/webcam)

Linux 的 UVC driver 把 USB Video Class function 接入 V4L2，应用通常打开 `/dev/videoX`。
memory-mapped streaming 的核心状态机是：

```text
VIDIOC_QUERYCAP
  → ENUM_FMT / ENUM_FRAMESIZES / ENUM_FRAMEINTERVALS
  → VIDIOC_S_FMT
  → VIDIOC_REQBUFS
  → 对每个 buffer: VIDIOC_QUERYBUF + mmap
  → 对每个 buffer: VIDIOC_QBUF         [交给 driver/device]
  → VIDIOC_STREAMON
  → poll + VIDIOC_DQBUF                 [应用拥有完成帧]
  → 处理 frame
  → VIDIOC_QBUF                         [归还]
  → ...
  → VIDIOC_STREAMOFF + munmap + close
```

这里 mmap 不是“设备无限制访问应用所有内存”，而是把特定 streaming buffers 映入进程；queue/dequeue 明确所有权。
[V4L2 streaming mmap 文档](https://docs.kernel.org/userspace-api/media/v4l/mmap.html)说明 `REQBUFS/QUERYBUF/mmap` 的关系，内核还提供[完整 capture 示例](https://docs.kernel.org/userspace-api/media/v4l/capture.c.html)。

[课堂 WebCam 演示](https://jyywiki.cn/OS/demos/persistence/webcam)把 UVC → V4L2 → `/dev/videoX` 的链完整串起。

### 28.1 条件式实验：只查询，不保存摄像头画面

```bash
nodes=$(find /dev -maxdepth 1 -type c -name 'video*' -print 2>/dev/null)
if test -z "$nodes"; then
  printf 'no V4L2 video node is exposed\n'
else
  printf '%s\n' "$nodes"
  stat -c '%n mode=%A owner=%U group=%G' $nodes
  if command -v v4l2-ctl >/dev/null; then
    v4l2-ctl --device=/dev/video0 --all
    v4l2-ctl --device=/dev/video0 --list-formats-ext
  else
    printf 'install v4l-utils to use v4l2-ctl; no capture attempted\n'
  fi
fi
```

本仓库环境当前没有 `/dev/video0`，所以预期走“未暴露”分支；这不是 UVC 理论失败，而是硬件/host 没有把节点交给容器。
有节点时，`EPERM/EACCES` 通常是 mode/ACL/group/sandbox，`EBUSY` 可能是另一个进程占用或模式冲突，`EINVAL` 常是 request/format 不被支持。

查询 capability 通常不会保存图像，但某些驱动在 open/configure 时可能让设备活动。
真正执行 `--stream-mmap --stream-count ...` 前应征得被拍摄者同意、确认指示灯与保存位置；不要在共享日志或仓库留下 frame。

## 29. 一张统一图：寄存器以下多样，OS 对象以上可组合

把本讲所有例子放回同一模型：

| 设备 | command/config | payload path | completion/event | 用户对象 |
| --- | --- | --- | --- | --- |
| GPIO | direction/value/bias | 1 bit line | edge event/poll | `/dev/gpiochipN`、request fd |
| UART | baud/frame/FIFO | data register/FIFO | status/interrupt | tty fd |
| PS/2 keyboard | LED/repeat command | scan code | interrupt | input/tty event |
| ATA PIO disk | LBA/count/read | CPU 读 data port | status polling | block device/file |
| printer | job/options | PDL/raster stream | job state/error | spool job/backend |
| UVC camera | format/fps/stream | USB transfer + buffers | dequeue/event | V4L2 fd |
| NIC/NVMe | queue config/doorbell | DMA descriptor/payload | MSI-X/poll | socket/block fd |
| GPU/NPU | context/graph/submit | DMA/shared buffers | fence/interrupt | DRM/runtime objects |
| KVM | VM/vCPU config | guest memory mapping | VM exit | system/VM/vCPU fd |

共同生命周期是：

```text
discover → bind/initialize → open/acquire → configure
         → submit/transfer ↔ wait/complete
         → error/reset/hot-unplug → release
```

理解任意陌生设备时，可以依次问：

1. 状态放在哪里，哪些位由 host 写、哪些由 device 写？
2. command 何时正式生效，能否并发提交？
3. payload 由 CPU 还是 DMA 搬，buffer ownership 何时切换？
4. completion 用 polling、interrupt、event fd 还是 fence？
5. timeout 后操作取消了、仍在执行，还是结果未知？
6. reset/hot-unplug 如何让等待者醒来并返回错误？
7. OS 用哪个对象、权限和 UAPI 把它交给应用？

## 30. 概念辨析与常见误区

| 误区 | 辨析 |
| --- | --- |
| I/O 设备只是在计算机外面的外设 | SoC controller、GPU、IOMMU、virtual device 都可实现 I/O 合同；边界取决于观察层。 |
| MMIO 就是普通内存 | device register 有副作用、端序/宽度/顺序和 posted write；应使用架构/内核 accessor。 |
| `volatile` 能解决 MMIO 并发与顺序 | 它主要约束 compiler，不能替代 bus semantics、memory barriers 和 driver synchronization。 |
| PIO 只表示 x86 `in/out` | 语境中还常指 programmed I/O，即 CPU 逐字搬 payload；阅读时要说明是哪一种。 |
| interrupt 会把数据搬进内存 | interrupt 通知事件；数据可能由 CPU PIO、DMA 或其他路径搬运。 |
| DMA 完全不耗 CPU | CPU 仍要分配/map buffer、填 descriptor、doorbell、处理 completion 和回收。 |
| DMA address 就是进程 pointer/物理地址 | IOMMU 可让 device address 与 CPU virtual/physical address 都不同。 |
| “免驱”表示没有驱动 | UVC/HID 等设备依赖系统内已有 class driver。 |
| 总线只是一捆线 | 现代 interconnect 还含枚举、路由、资源、中断、power、error/hotplug 等合同。 |
| PCIe 6.0 x16 是任意应用都能得到 128 GB/s | 约 128 GB/s 是每方向理论口径；协议、拓扑、设备和 workload 决定有效带宽。 |
| CXL 共享内存让远端内存和本地 DRAM 等价 | latency、NUMA、coherency scope、failure 与 software placement 仍不同。 |
| `/dev/video0` 里面存着摄像头画面 | node 是 dispatch 名字；frame 来自 driver/device 的实时 buffer queue。 |
| 创建设备 node 就等于安装驱动 | major/minor 只有在 kernel 注册对应操作且设备存在、权限允许时才可用。 |
| Everything is a File 表示一切都是普通文件 | 它表示复用 fd 和操作接口；offset、阻塞、错误、ioctl/mmap 语义由对象定义。 |
| `read()` 一定返回请求的全部 byte | stream/device 可 short read、被 signal 打断或 nonblocking 返回 `EAGAIN`。 |
| `ioctl` 是一个统一跨设备协议 | 只有 syscall 入口统一；request/argument/semantics 是 subsystem/device-specific UAPI。 |
| libc 的 stdout buffering 是 kernel 自动设置 | libc 通常探测 fd 是否为 tty后在用户态选策略。 |
| `/dev/kvm` 可读就能无条件跑任意 VM | 还需 API/capability、memory setup、vCPU、权限与硬件/host 支持。 |
| mmap camera/GPU buffer 意味着零成本 | 少一次 copy 不等于没有 page pin、cache sync、DMA、queue 和 synchronization 成本。 |

## 31. Takeaways

I/O 设备五花八门，越来越多设备甚至自带处理器、memory 和 firmware。
它们仍可从状态机出发理解：register/queue 表示状态与命令，PIO/MMIO 负责控制访问，DMA 负责大块搬运，中断/轮询负责完成通知，总线负责连接与发现。

操作系统把硬件差异收进 driver，再把使用实例包装为 fd 指向的对象。
`read/write` 提供常见数据路径，`ioctl` 暴露必要配置，`mmap` 共享大 buffer，`poll` 等待事件；`/dev`、sysfs 和 subsystem library 将对象接给用户态。

一句话压缩本讲：

```text
物理设备的多样性
  → canonical state machine
  → register/queue + interrupt/DMA
  → bus discovery + driver
  → fd + read/write/ioctl/mmap/poll
  → 可共享、可保护、可组合的 OS object
```

## 32. 思考题与下一讲衔接

1. 一个设备有 `READY/BUSY/DONE/ERROR` 四个状态位；画出 command、timeout、reset 和 hot-unplug 的状态迁移。
2. 为什么“MMIO register 用 `volatile` 指针”在 x86 上偶尔看似工作，却仍不是 portable driver？
3. UART 115200 baud、8N1 的理想 payload 上限是多少？FIFO 与 interrupt 分别减少什么开销？
4. ATA PIO `readsect` 中哪一步选择操作、哪一步给参数、哪一步搬 payload？若设备永远 busy 会怎样？
5. printer 同时被两进程写入时，为什么只有 mutex 还不足以形成好用的打印抽象？
6. 解释 UVC“免驱”与 V4L2 driver 同时为真。
7. NIC 用 DMA 收到 packet 后，为什么 device 写 completion、CPU 读 buffer 和回收 descriptor 之间需要 ownership/barrier？
8. MSI 是“写特殊地址”，它和普通 DMA write 有何相同与不同？
9. `lspci` 看见 device 但没有 driver symlink，可能有哪些原因？
10. `/dev/null`、`/dev/zero`、`/dev/full` 为什么支持相同 syscall 却有不同错误与数据？
11. KVM 为什么让 `KVM_CREATE_VM` 返回新 fd，而不只给 system fd 增加一个整数 VM ID？
12. V4L2 dequeue 后应用忘记 requeue buffer，stream 最终为什么会停住？
13. 比较 interrupt-per-frame、interrupt coalescing 和 polling 的 latency/throughput/CPU trade-off。
14. CXL memory 扩展了容量后，page allocator 与 scheduler 还需要知道哪些 topology 信息？
15. 设备 driver 将磁盘包装成可读写 block 后，为什么应用仍不能直接把“持久文件”问题视为已解决？

最后一题引向下一讲。
本讲停在“controller 能按 block number 搬一段 byte”；下一讲要研究介质为什么有不同 latency/error/persistence 特性，OS 又如何用 block layer、cache、调度与更高层存储抽象，把 raw device 变成可靠可用的数据空间。

## 33. 扩展资料（区别于 PPT 主线）

以下资料用于核查现代实现和协议边界，不是额外幻灯片背诵清单：

- [OSTEP 第 36 章：I/O Devices](https://pages.cs.wisc.edu/~remzi/OSTEP/file-devices.pdf)：canonical device、polling/interrupt、DMA、PIO/MMIO 与 driver；
- [Linux bus-independent device access](https://docs.kernel.org/driver-api/device-io.html)：`ioremap/readl/writel`、port I/O 与 posted write；
- [Linux DMA mapping guide](https://docs.kernel.org/core-api/dma-api-howto.html)：CPU virtual/physical 与 DMA address、IOMMU mapping 生命周期；
- [Linux PCI 文档](https://docs.kernel.org/PCI/index.html)、[PCI sysfs](https://docs.kernel.org/PCI/sysfs-pci.html)与 [driver binding](https://docs.kernel.org/driver-api/driver-model/binding.html)；
- [Linux VFS](https://docs.kernel.org/filesystems/vfs.html)与[官方 device-number registry](https://docs.kernel.org/admin-guide/devices.html)；
- [GPIO character-device API](https://docs.kernel.org/userspace-api/gpio/chardev.html)；
- [USB-IF UVC 1.5 文档集](https://www.usb.org/document-library/video-class-v15-document-set)与 [Linux V4L2 API](https://docs.kernel.org/userspace-api/media/v4l/v4l2.html)；
- [KVM API](https://docs.kernel.org/virt/kvm/api.html)与 [DRM userspace API](https://docs.kernel.org/gpu/drm-uapi.html)；
- [PCI-SIG PCIe 6.0 说明](https://pcisig.com/blog/pcie%C2%AE-60-specification-released-members-double-bandwidth-next-generation-applications)与 [CXL 3.0 规范](https://computeexpresslink.org/wp-content/uploads/2024/02/CXL-3.0-Specification.pdf)；
- [Adobe PostScript Language Reference, 3rd ed.](https://www.adobe.com/jp/print/postscript/pdfs/PLRM.pdf)与 [IPP/1.1 RFC 8011](https://www.rfc-editor.org/info/rfc8011/)；
- [CUDA Runtime API](https://docs.nvidia.com/cuda/cuda-runtime-api/index.html)。

## 34. PPT 内容覆盖表

| PPT 非重复一级标题（按原顺序逐字保留） | 本章对应位置 |
| --- | --- |
| `输入/输出设备原理` | 全章，标题与 §0–§1 |
| `Review & Comments` | §2 |
| `今天的主角：输入输出设备` | §3 |
| `I/O 设备：“计算” 和 “物理世界” 之间的桥梁` | §4 |
| `实现核弹发射：只需要 “一根线” I/O 设备` | §5 |
| `[GPIO LED](/OS/demos/persistence/gpio-led)` | §6 |
| `串口 (UART)` | §7 |
| `键盘控制器` | §8 |
| `磁盘控制器` | §9 |
| `打印机` | §10 |
| `PostScript 和打印机` | §11 |
| `[PostScript](/OS/demos/persistence/postscript)` | §12 |
| `摄像头 (WebCam)` | §13 |
| `打破 I/O 设备与内存之间的边界` | §14 |
| `异构加速器：GPU 和 NPU` | §15 |
| `连接万千设备：总线` | §16 |
| `PCIe 和 CXL` | §17；实验 1（§18） |
| `应用程序如何访问设备？` | §19 |
| `Everything is a File` | §20；实验 2（§21） |
| `[一个设备驱动程序](/OS/demos/persistence/launcher)` | §22 |
| `ioctl` | §23；实验 3（§24） |
| `ioctl (cont’d)` | §25 |
| `[KVM Device](/OS/demos/persistence/kvm)` | §26 |
| `终于，理解了 “操作系统的对象”` | §27 |
| `[WebCam](/OS/demos/persistence/webcam)` | §28 |
| `Takeaways` | §31 |
| `阅读材料` | §33（含 OSTEP 第 36 章） |

### 34.1 PPT 二级要点与课堂案例复核

| 原讲义要点/案例（按出现顺序） | 本章对应位置 |
| --- | --- |
| Virtualization & Concurrency；进程/系统调用；`spawn(T_worker)`；fd 是指向 OS object 的“指针”；tty、disk | §2 |
| 可见的计算机与不可见的 CPU/memory | §3 |
| interface/controller、几组线/寄存器、handshake、Address Decoder、in/out/MMIO、中断、canonical-device 图 | §4 |
| GPIO、MMIO 电平、logic 1 = 3.3V、Raspberry Pi LED | §5–§6 |
| COM1、UART、`/dev/ttyS0`、`0x3f8`、`outb/inb` 与 status | §7 |
| IBM PC/AT 8042 PS/2；六根线；port `0x60/0x64`；`0xED/0xF3` | §8 |
| ATA/IDE 40-pin data + 4-pin power；primary/secondary ports；PIO `readsect` | §9 |
| CalComp；字节流描述文字/图形并打印 | §10 |
| PostScript DSL、compiler/LaTeX、graphics state、PCL、IPP、lp/lpr、PCL escape/raster 示例 | §11–§12 |
| UVC；枚举、协商格式/分辨率/帧率、开始传输、MJPEG/H.264；衍生设备 | §13、§28 |
| DMA 是专门 `memcpy` 的协处理器；hard-wired program；i8237 channel/priority 概念 | §14 |
| GPU kernel、`cudaMalloc/cudaMemcpy`、DMA、canonical control；Qualcomm SNPE input/output map | §15 |
| IBM/DEC、微型机、ISA、Apple II 50-pin；总线注册/转发；Windows 98 USB PnP | §16 |
| PCIe lanes、ARM SoC high-speed bus、PCIe 6.0 x16、800 Gbps NIC、DMA/MSI、75 W、FPGA/GPU/NIC/NVMe/USB bridge、`lspci` | §17–§18 |
| CXL.io/cache/memory、CXL 3.0 memory sharing、GPU/NPU/remote memory、disaggregated datacenter | §17.2 |
| 应用不应直接访问 bus/register；访问→共享→同步→bug；CPU/memory 也可虚拟化 | §19 |
| `struct file_operations`、syscall 翻译、可添加 mmap、`/dev/ptx` 勘误为 `/dev/ptmx`、`/dev/null` | §20–§22 |
| printer/keyboard/disk 配置；ioctl 定义及 driver-specific semantics | §23 |
| hidden specifications、procfs、terminal libc buffering、network/GPU、KVM | §24–§26 |
| `/dev/kvm` 运行到 VM Exit | §26 |
| GPU memory coprocessor、mmap、ioctl/doorbell、DRM、libdrm、Mesa | §27 |
| UVC → V4L2 → `/dev/videoX`；query/set/request buffers；mmap/user pointer；逐帧 dequeue/requeue | §28 |
| 设备日益“自带电脑”；OS 抽象为可读写、可控制、实现 `file_operations` 的对象 | §29–§31 |
