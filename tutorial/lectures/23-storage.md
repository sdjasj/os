# 第 23 讲：存储设备的抽象——从介质状态到逻辑块数组

> 原始讲义：[sources/notes/lect23.md](../../sources/notes/lect23.md)  
> 前一讲：[输入/输出设备原理](22-io-devices.md) · 后一讲：[文件系统 API（1）](24-filesystem-api-1.md)  
> 本讲关键词：持久化、电磁存储、磁带、磁鼓、硬盘、寻道、旋转延迟、软盘、光盘、NAND Flash、program/erase、写放大、FTL、L2P、wear leveling、logical block、ZNS、`bio`、blk-mq

## 0. 本讲定位：设备驱动已经会“翻译”，存储设备究竟承诺什么

上一讲建立了 canonical device model：设备在总线上暴露寄存器，驱动把 `read/write/ioctl/mmap` 等文件操作翻译成设备命令，DMA 在设备与内存间搬运数据。这个模型能描述键盘、摄像头、打印机和 GPU，却还没有回答计算机系统最古老的愿望：**断电、退出乃至隔很久以后，数据还能回来吗？**

本讲正式进入持久化。我们不会把磁带、硬盘、光盘和 SSD 当成一串历史名词，而会对每种介质反复问三层问题：

```text
物理介质约束
  什么状态能稳定保存？怎样定位、读取、改变？什么会磨损？
        ↓
设备状态机
  主机能发哪些命令？最小读写单位、并行度、延迟和失败是什么？
        ↓
软件抽象
  怎样隐藏几何与坏块？调度、缓存、映射、GC 如何影响性能和可靠性？
```

最终，各种完全不同的介质都被压进一个统一接口：**可按逻辑块地址随机读写的 block array**。这个抽象极其成功，却不是免费午餐：HDD 的寻道、NAND 的 erase/GC、控制器缓存和写放大都被藏在一次普通 `write_block` 后面。

下一讲会在这个块数组上继续构造文件系统。块号对机器友好，却不能让人管理数百万条数据；文件、目录、链接、mount 和权限将成为下一层抽象。

## 1. 学习目标与问题地图

学完本讲，你应该能够：

- 从“稳定、可区分、可寻址、可读写”的物理条件推导持久 bit；
- 比较磁带、磁鼓、HDD、软盘、光盘和 NAND 的容量、延迟、可靠性与适用 workload；
- 用 `T_queue + T_seek + T_rotation + T_transfer` 分析 HDD 请求，并纠正 7200 RPM 的常见计算误区；
- 解释顺序与随机 I/O 的差别为何来自定位，而不只是“接口名字不同”；
- 说明 elevator、read-ahead、request merging、AHCI/NCQ 分别把重排放在哪一层；
- 从软盘与压制光盘说明“介质可移动/易复制”怎样改变软件发行；
- 解释 CD 的 pit/land、EFM 与压盘，并区分复制吞吐和主机写带宽；
- 从 floating-gate/cell threshold voltage 解释 SLC、MLC、TLC、QLC；
- 说清 NAND 的 page program 与 block erase 不对称，以及 P/E endurance 的来源；
- 用 out-of-place update 推导 L2P、invalid page、garbage collection、over-provisioning、wear leveling 与写放大；
- 区分裸 NAND 与优盘/SD/SSD 这个完整控制器系统，并识别“设备可撒谎”的边界；
- 解释逻辑/物理块大小、LBA、queue depth、discard 与 zoned storage；
- 用只读 `lsblk`/sysfs 检查本机块设备属性，同时知道这些值可能来自虚拟化或固件报告；
- 用 `/tmp` 镜像安全观察“块数组”，不碰真实磁盘数据；
- 沿 Linux `bio → blk-mq request → driver/hardware queue → completion` 解释块 I/O；
- 说明 `struct block_device_operations` 与数据路径的 `request_queue` 为什么不是同一层；
- 判断何时 block abstraction 隐藏得恰到好处，何时会产生放大或需要 ZNS。

问题地图：

| 问题 | 最小答案 | 可观察证据 |
| --- | --- | --- |
| 磁带容量很高，为什么不能替代内存？ | 定位是串行机械过程，随机访问延迟极高 | 顺序/随机访问模型 |
| 7200 RPM 是否意味着 8.3 ms 平均旋转延迟？ | 8.3 ms 是一整圈，随机位置平均约半圈，即 4.17 ms | 公式计算 |
| SSD 无机械部件，为什么随机写仍不免费？ | page 可 program，但复用前要整 block erase；GC 要搬 live page | FTL 模拟实验 |
| 写同一个 `a.txt` 1000 次会烧坏同一 cell 吗？ | 文件系统和 FTL 做 out-of-place update/remapping，不固定写同一物理 cell | L2P 变化 |
| `lsblk ROTA=0` 能证明设备是 NAND 吗？ | 不能；这是内核看到/设备报告的队列属性，虚拟设备也可为 0 | sysfs/虚拟化对照 |
| 512 B logical sector 等于 NAND page 吗？ | 通常不等；LBA 是主机接口，控制器再映射到更大物理 page/block | `LOG-SEC/PHY-SEC` 与 NAND 层次 |
| 一次 `write()` 就对应一个 `bio` 和一条 NVMe command 吗？ | 不保证；页缓存、文件系统、合并、拆分和队列会改变边界 | block tracepoints |
| 为什么应用看不到 `bio`？ | 它是内核块层接口；应用看到文件/fd，文件系统与块层负责转换 | Linux I/O 路径 |

## 2. Review & Comments (1)：Agent Harness 与“不熟领域的质量保证”

讲义先展示一则 DeepSeek Agent Harness 研发岗位。这里的 Harness 不是模型参数本身，而是模型之外让 Agent 真正完成工程工作的整套系统：上下文收集、工具调用、文件编辑、命令执行、权限边界、反馈循环、测试、日志和用户体验。

岗位要求中特别值得课程关注的是：能在 AI 辅助下，对没有直接经验的语言、技术或框架做出**有质量保证**的编程工作。它不是“让模型生成一段看起来像代码的文本”，而是：

```text
定义目标与安全边界
  → 找到权威文档/源码中的真实接口
  → 让 Agent 建立局部模型并修改
  → 编译、测试、trace、负例验证
  → 保留可审计证据并处理失败
```

这正好预告本讲最后的 Linux `bio` Demo。一个从没写过 block driver 的人，可以让 Coding Agent 帮助搜索 `struct bio`、blk-mq 和示例驱动；但若直接在宿主机加载未经审计的内核模块，“能编译”远不等于“有质量保证”。正确 Harness 必须把实验放进可恢复 VM，限制目标设备，提供超时与日志，并用只读 workload 验证。

讲义把这种人称为“AI 原生时代的超级个体”，语气带玩笑，方法论却与操作系统课程一致：知识不再只靠肌肉记忆，判断力表现为能否提出不变量、选择观测点，并阻止工具越过权限与数据安全边界。本章所有实验因此默认只读或只写 `/tmp` 新建文件。

## 3. Review & Comments (2)：从 canonical device 到持久字节序列

### 3.1 回顾输入/输出设备

上一讲把设备统一为总线上的寄存器和状态机：

```text
应用 read/write/ioctl
  → VFS/file operations
  → device driver
  → MMIO/port I/O/command queue/doorbell
  → device state transition
  → interrupt/completion
```

LED、打印机、GPU 的内部完全不同，但都能经驱动成为操作系统对象。存储设备也遵循这个模型：主机提交 READ/WRITE/FLUSH/DISCARD 等命令，设备 DMA 数据并报告完成。

区别在于，存储命令还承诺**跨掉电保留状态**。这个承诺涉及介质、控制器缓存、命令完成语义和电源故障，不是“调用 `write()` 返回”五个字就能自动保证；后续文件系统讲会继续讨论 `fsync` 和崩溃一致性。

### 3.2 我们终于进入“持久化”

讲义把存储设备先抽象成字节序列。这个表述是目标接口，不是物理事实：磁带按带长定位，HDD 按磁道/扇区定位，NAND 按 die/plane/block/page 操作；软件最后才把它们包装为线性地址。

课程主线由此进入：

```text
I/O mechanism
  → storage media and block devices       ← 本讲
  → files/directories/mount               ← 第 24–25 讲
  → on-disk filesystem implementation     ← 第 26 讲
  → database durability and transactions  ← 第 27 讲
```

## 4. 正式进入“持久化”部分：人类一直想让状态留下来

Persistence 在日常英语里还有“面对困难仍坚持”的意思。对数据而言，困难来自自然界：热扰动、材料老化、摩擦、辐射、电荷泄漏、机械碰撞和人类误操作都会让状态改变。

罗塞塔石碑说明一种极端方案：把信息刻成宏观几何形状。它不需要电源、格式直观、跨越千年，但密度低、写入慢、更新更慢。计算机存储需要同时满足：

1. **至少两个可区分状态**：0/1 的读出分布要有足够噪声裕量；
2. **状态在无电源时稳定**：retention 足够长；
3. **可寻址**：能找到第 `i` 个信息单元；
4. **可写或至少可制造**：能把目标状态放进去；
5. **可读**：感测过程尽量不破坏状态，并能纠错；
6. **可规模化**：密度、成本、带宽和故障率随容量仍可接受。

后面的介质演化，可以看作在这六个指标间移动，而不是沿一条“新的一定全面优于旧的”直线。

## 5. 数据的持久化（正 v.s. 反）：磁化方向是一种可改写状态

### 5.1 “持久化”可能没有想象的那么困难

最小思路是找到一个有滞回的物理系统：施加强作用可以把它推到状态 A/B，移走外力后它仍停在那里；较弱感测又能区分二者。磁性画板就是直观模型：磁性颗粒重新排列，图案无需持续供电。

但“有两个状态”还不够。计算机必须用电路自动寻址与读写；状态分布还要经受温度、邻近单元干扰和制造差异。真实设备于是加入放大器、servo、编码和 ECC，把模拟噪声恢复成数字 bit。

### 5.2 电磁感应：物理和数字世界的桥梁

早期磁记录的最小读写模型是：

- **写**：线圈电流产生局部磁场，改变介质磁畴的磁化方向；
- **读**：介质相对磁头运动时，磁通变化可在线圈中感应电压；现代设备也广泛使用磁阻式读头；
- **定位**：让介质移动，把目标区域带到磁头下；
- **编码**：不直接把“朝左=0、朝右=1”逐位裸放，而用便于时钟恢复和纠错的磁化变化序列。

因此“电磁感应是桥梁”不是说数字世界突然变成纯 0/1；介质、磁头和放大器都产生连续信号，控制器在阈值、时钟与 ECC 后才交付离散数据。

## 6. 电磁感应：物理和数字世界的桥梁——磁带（1928）

### 6.1 1D 存储设备：把 bits 卷起来

把铁磁涂层均匀附着在长带上，只需卷轴转动便能让不同位置经过读写头。从逻辑上，它是一条很长的一维 bit 序列；卷起来只改变体积，不改变寻址拓扑。

```text
BOT → [block 0][block 1][block 2] ... [block N] → EOT
                         ↑
                   当前磁头位置
```

读写局部连续数据时，介质稳定运动，吞吐可很高；要从 block 2 去 block N，必须快进很长距离。硬件可有多条并行 track、servo 和索引，仍改变不了“远处数据要沿带长经过”的根约束。

### 6.2 磁带：密度可以高得离谱

磁带记录层结构简单、面积巨大，制造不需要为每个 bit 配独立晶体管和寻址线。讲义用约 300 Gb/in²、单卷约 30 TB 的量级展示：磁性颗粒与磁头工艺同样能达到很高面密度。

这些数字随磁带代际、原始/压缩容量和厂商格式变化，不能当成永恒规格。真正稳定的推导是：**容量成本主要来自介质面积，而随机定位能力没有随面积同比增长。**

### 6.3 磁带：作为存储设备的分析

| 维度 | 结论 | 物理原因 |
| --- | --- | --- |
| 价格 | 每 bit 很低 | 记录层简单，可卷入大量面积 |
| 容量 | 很高 | 长带、多 track、高面密度 |
| 可靠性 | 正确封装和迁移策略下适合长期保存 | 离线介质无持续机械运转，但仍会老化、受环境影响 |
| 顺序吞吐 | 流式后可较高 | 定位完成后连续经过磁头 |
| 首字节/随机延迟 | 极差 | load、seek、绕带都要机械移动 |

因此磁带没有“死亡”，而是退出低延迟主存储，留在冷数据归档、备份和大规模顺序迁移。音频/录像带也利用同一 workload：播放天然按时间顺序前进，不需频繁随机跳转。

归档系统还必须管理介质库、机器人装载、校验、定期迁移和多副本。单卷介质便宜不等于检索系统没有成本。

## 7. 磁鼓（Magnetic Drum, 1932）：用更多磁头换随机延迟

讲义把磁鼓称为 1D → 1.5D（`1D × n`）：在旋转圆柱表面放多条 track，典型设计可为每条 track 配固定磁头。目标地址只需等待圆柱转到相应角度，不必沿一整条带快进。

```text
磁带：选择位置 ≈ 沿一条长线移动
磁鼓：选择 track（电子/固定头）+ 等待 rotation
```

最坏定位等待不超过一圈，平均约半圈，随机访问大幅改善。代价是表面积不能像带子一样卷入更多长度，磁头和机械结构增多；容量/成本不再占绝对优势。

这个转折第一次显式展示本讲核心交易：**增加并行寻址硬件，减少物理定位距离。** HDD、SSD channel/die/plane 仍会重复它。

## 8. 疯狂内卷：磁盘（Hard Disk, 1956）

### 8.1 1.5D → 2.5D（`2D × n`）

HDD 把圆形盘片上的许多同心磁道叠成二维面，再堆叠多个盘面。执行器让一组磁头沿半径移动，主轴让目标扇区转到磁头下：

```text
LBA
  → drive firmware 映射/调度
  → 选择 platter surface / track / sector
  → actuator seek 到半径
  → 等待 spindle rotation
  → 读写并做 ECC
```

“在二维平面上放许多磁带”是很好的几何直觉；真实主机早已主要看到 LBA，坏扇区重映射、zone bit recording 和内部几何由固件隐藏。

### 8.2 磁盘：克服各种工程挑战 / 磁盘：克服各种工程挑战 (cont’d)

讲义两页显微图片没有文字，却承担关键论证：HDD 的便宜容量来自一整套极限工程共同成立，而不是“把磁带剪成圆片”即可。

- 盘片高速旋转且振动极小；
- 读写头依靠 air bearing 在盘面上方极近距离飞行，不能接触记录层；
- actuator 和 servo 信息要在高密磁道间精确定位；
- perpendicular recording 等技术缩小磁畴并维持热稳定；
- 前置放大、信号处理与 ECC 从极弱、带噪模拟信号恢复 bit；
- firmware 做坏扇区 remap、cache、命令重排和健康统计；
- 过滤、密封与材料工艺降低尘埃、磨损和腐蚀。

容量越高，磁道越密、磁头 margin 越小，机械碰撞和材料退化越危险。所谓“可靠性高”是控制器、纠错、制造筛选和系统冗余共同交付的统计性质，不是盘片永不损坏。

### 8.3 磁盘：作为存储设备的分析

| 维度 | HDD 表现 | 决定因素 |
| --- | --- | --- |
| 单位容量价格 | 低 | 多盘面、高面密度、成熟制造 |
| 单盘容量 | 高 | 2D track × surfaces |
| 顺序吞吐 | 较高 | 定位后连续扇区流过磁头 |
| 随机延迟/IOPS | 较弱 | 每次可能 seek + rotational wait |
| 静止数据保持 | 较好但非永久 | 磁性介质、ECC、环境与老化 |
| 机械可靠性 | 有限 | spindle、head、actuator 都可能故障 |

HDD 长期是主力数据存储，因为它在容量、成本、可重写性和随机访问间取得平衡。发生逻辑损坏或部分机械故障时，有时能做专业恢复；这不是备份策略，开盘与反复通电还可能恶化损伤。

### 8.4 磁盘：性能调优——先写对延迟公式

一次请求的简化服务时间是：

```text
Trequest = Tqueue + Tseek + Trotation + Ttransfer + Tcontroller
```

- `Tseek`：磁头移动并稳定到目标 track；依移动距离而变，通常数 ms；
- `Trotation`：等待目标 sector 转到磁头下；
- `Ttransfer`：目标字节经过磁头的时间；连续大请求能摊薄前两项；
- `Tqueue/controller`：排队、固件、总线与错误恢复。

对 7200 RPM：

```text
7200 revolution/min ÷ 60 = 120 revolution/s
一整圈 = 1/120 s ≈ 8.33 ms
随机角度平均等半圈 ≈ 4.17 ms
```

讲义把 8.3 ms 与“寻道”并列，复习时要校准：8.3 ms 是 rotation period，不是磁头 seek；寻道另需若干 ms。二者叠加后，QD=1 随机小 I/O 的 IOPS 往往只有百量级，而顺序吞吐可高很多。

### 8.5 通过缓存/调度缓解：谁知道几何，谁来重排

可利用的策略包括：

- **read-ahead/write-back cache**：把相邻或重复请求吸收成大顺序传输；
- **merge**：把连续 LBA 的小请求合成一个；
- **elevator/SCAN-like scheduling**：按磁头方向服务请求，减少来回 seek；
- **AHCI NCQ**：主机同时下发多个命令，drive firmware 依据内部几何与状态重排；
- **filesystem allocation**：让相关文件 block 尽量相邻，从源头减少随机性。

“电梯算法成为历史尘埃”应理解为：OS 不再独占全部几何信息，现代 SATA/NVMe、多队列和设备固件改变了调度位置；不是 Linux 从此完全没有 I/O scheduler。本机 `/sys/block/DEV/queue/scheduler` 仍可能显示 `none`、`mq-deadline`、BFQ 或 Kyber，选择取决于设备和 workload。

对 HDD，重排可减少 seek，却可能让远处请求饥饿，因此 deadline/fairness 仍重要。对 NVMe，物理定位机制不同，传统 cylinder elevator 意义下降，但合并、优先级、延迟隔离和队列映射依然存在。

## 9. 软盘（Floppy Disk, 1971）：让介质离开驱动器

### 9.1 把读写头和盘片分开——实现数据移动

HDD 把磁头、盘片和精密机构封装为整体；软盘把昂贵读写/旋转机构留在 drive，把便宜磁性盘片放进可移动封装。8 英寸（1971）、5.25 英寸（1975）、3.5 英寸（1981）逐步缩小；3.5 英寸有硬塑料外壳和金属滑门，名字仍沿用“floppy”。

这个设计牺牲密度与环境控制，换来一种今天很自然、当年革命性的能力：数据和软件可以像书一样被带走、邮寄、复制和销售，不要求两台计算机联网。

### 9.2 曾经，软件是通过“软盘”发行的！

操作系统、编译器、游戏和驱动曾装在一张或多张软盘中发行。容量限制塑造软件：几十 KiB 的 BASIC 已能表达复杂逻辑，安装器会跨盘提示“Insert Disk 2”，压缩和 overlay 技术用于让程序挤进有限介质。

软盘最终留下的文化化石是保存按钮 `💾`。图标寿命远超物理设备，说明应用抽象会冻结历史：今天点击它通常触发文件系统、云同步或数据库事务，用户不需要知道软盘磁道。

### 9.3 软盘：作为存储设备的分析

| 维度 | 软盘表现 | 原因 |
| --- | --- | --- |
| 介质成本 | 很低 | 驱动器与介质分离，盘片/外壳简单 |
| 容量 | 低 | 介质暴露程度高、磁道密度与机械精度有限 |
| 可靠性 | 低 | 灰尘、弯折、磁场、磁头接触与介质老化 |
| 顺序/随机性能 | 都低 | 低转速、寻道与窄总线 |
| 核心用途 | 可移动软件/数据发行 | 当时网络和其他可移动介质更昂贵 |

软盘没有在性能上战胜 HDD；它改变的是**系统边界**：数据介质可被拔出并进入另一台机器。之后的光盘、优盘和 SD 卡延续了这一需求。

## 10. 数据的持久化（坑 v.s. 平）：几何形状天然可读

### 10.1 坑：天然容易“阅读”的数据存储

石碑的坑/平不会因断电消失。读取可依靠光照、机械接触或成像，介质本身不需要复杂电路；若只要求 write once/read many，制造时一次改变几何状态即可。

它的限制也直接来自物理：挖坑需要能量和时间，填回原样更难；高密度后，读头定位、衍射、材料缺陷和灰尘都会干扰。光盘用现代精密制造把这个古老思想缩小到微观尺度。

### 10.2 现代工业：我们可以挖出更精细的坑

光学存储把激光聚焦到旋转盘片的一条螺旋 track。反射光的变化经过光电传感器、时钟恢复、调制解码和 ECC，最后才成为 sector。

“pit=0、land=1”是教学简图。真实 CD 更接近利用 pit/land **transition** 引起的光学干涉/反射变化编码通道 bit；连续相同通道状态还要满足时钟和长度约束。这正是 EFM 存在的原因。

## 11. Compact Disk（CD, 1980）：读优化的工业介质

### 11.1 在反射平面上制造 pit/land

音频 CD 的经典参数是 44.1 kHz、16-bit、双声道。未计额外编码/ECC时，原始音频率为：

```text
44,100 sample/s × 16 bit/sample × 2 channel
  = 1,411,200 bit/s
```

74 分钟约对应数百 MiB 原始 PCM，常被概括为约 700 MB 级介质。数据 CD 还需 sector framing 和纠错，用户容量与音频字节换算不能简单完全等同。

Eight-to-Fourteen Modulation（EFM）把 8-bit symbol 映射为满足游程限制的 14 channel bits，再配合 merging bits；目的包括保持足够 transition 供时钟恢复，并避免过短/过长 pit。**介质编码不是文件内容本身**：控制器完成调制和纠错后，主机才看到逻辑 sector。

### 11.2 光盘最有趣的特性：容易复制

量产只需先制作 master/stamper，再把 pit/land 形状压进透明聚碳酸酯，镀反射层并封装。每张盘不必像刻录机那样逐 bit 等激光写完，因此复制音乐、电影和软件的边际成本极低。

讲义用“数秒压出 100 GB Blu-ray、等效数万 MB/s”制造反差。这个数字表达**制造复制吞吐**，不能当作用户用光驱写文件的带宽：工厂是并行复制整个物理图案，主机写入则受激光、旋转、介质与协议速度限制。

易复制同时改变版权与发行：内容可以大规模廉价合法分发，也可以被逐 bit 复制。DRM、区域码等上层机制试图重新建立访问控制，但无法改变读出数据终究成为 bit 的事实。

### 11.3 光盘：作为存储设备的分析

| 维度 | 压制只读光盘 | CD-R/CD-RW |
| --- | --- | --- |
| 制造/介质成本 | 大批量极低 | 单盘可写，成本略高 |
| 容量 | 当年高、今天相对有限 | 同代量级 |
| 顺序读 | 一般，适合流式内容 | 类似但受介质/光驱影响 |
| 随机读 | 低 | 同样受 seek/rotation 影响 |
| 写 | 工厂压制，不是用户改写 | CD-R 改变 dye；CD-RW 用可逆相变材料，粒度/次数有限 |
| 可靠性 | 无机械接触、离线方便 | 划伤、反射层/染料老化、热与光照仍会损坏 |

“划伤的是没有数据的一面”需要精确理解：激光从透明基材一侧读取，轻微底面划痕有时可抛光；CD 数据/反射层靠近 label 一侧，label 面深划伤反而可能直接破坏它。光盘不是天然永久，只是在合适封装下便于只读分发。

它的主要应用是数字内容和软件发行，后来被互联网的即时性、无需物流和可更新性取代。介质物理优势并不会自动战胜更强的系统级分发方式。

## 12. 挖坑：还有别的用处吗？Project Silica 回归 Rosetta Stone

Project Silica 把超快激光写入玻璃内部，光学系统读取多层微结构，目标是长寿命冷归档。它回到石碑思想：写入代价可以很高、介质可近似 immutable，只要保存极久且读取可靠。

讲义抽象为：

```text
random read + append-only write = 可以构造任意持久数据结构
```

“任意”不是指能原地修改旧 bit，而是可追加新版 record、索引、tombstone 和 checkpoint；读取时选最新有效版本。log-structured filesystem、数据库 WAL 和 FTL 都使用同一技巧。代价是旧版本回收、索引与空间管理。

作为扩展资料，[Microsoft Research 的 Project Silica 项目页](https://www.microsoft.com/en-us/research/project/project-silica/)和其 [SOSP 2023 系统论文](https://www.microsoft.com/en-us/research/uploads/prod/2023/09/ProjectSilica-SOSP23.pdf)讨论了玻璃介质之外的完整归档系统：library、机器人、编码和检索同样重要。讲义链接的 Nature 工作属于持续演进的介质研究；实验性寿命/容量数字不应直接当成已量产产品保证。

这一节把光盘历史送回本讲主线：介质只给出 write/read primitive，真正可用的“磁盘”仍需要索引、调度、纠错和空间回收软件。

## 13. 数据的持久化（充电 v.s. 放电）：Solid State Drive（1991）

### 13.1 磁和坑都不太完美

磁性设备需要精密运动，随机访问难逃 ms 级机械时间；压制光盘容易读和复制，却不擅长反复改写。如果能直接在集成电路里保存状态，就可能同时得到：

- 无运动部件的低延迟；
- 电子寻址与多 channel/die/plane 并行；
- 半导体制造带来的高密度和小体积；
- 断电后电荷仍能保持的非易失性。

Flash Memory 的名字来自可以一次“闪速”擦除一片单元。它不是 DRAM 加一块电池，而是一种 program/read/erase 规则非常不同的晶体管阵列。

### 13.2 “完美”=电子密度与电路速度？

一个 floating-gate/charge-trap cell 通过是否储存电荷改变晶体管的 threshold voltage。读取施加特定电压，感测 channel 是否导通；program/erase 则借较高电场让电子进入或离开储存层。

最小 SLC 只需区分两个阈值区间，即 1 bit/cell。若控制和感测更多电压窗口，同一 cell 可编码更多 bit：

| 常用名称 | bits/cell | 需要区分的状态数 | 一般趋势 |
| --- | ---: | ---: | --- |
| SLC | 1 | 2 | margin 大、快、耐久、贵 |
| MLC（狭义） | 2 | 4 | 密度提高、margin 下降 |
| TLC | 3 | 8 | 更高密度，更依赖 ECC/校准 |
| QLC | 4 | 16 | 容量成本低，program/耐久压力更大 |

“MLC”广义也可指所有 multi-level cell，产品命名需看上下文。每多一 bit，阈值窗口数翻倍，噪声、retention、program disturb 和读出重试更难控制；容量不是白来的。

## 14. 1-Bit Flash Memory：floating gate 的充电与放电

### 14.1 NAND 为什么叫 NAND

多个 cell 串联成 string，共享 bit line/word line 选择电路，版图密度很高；NOR Flash 则更适合随机读取/代码执行。SSD、优盘与 SD 卡的容量介质主要是 NAND。

从主机到物理 cell 通常经历层级：

```text
controller
  → channel
    → package
      → die
        → plane
          → block
            → page
              → cells
```

不同代产品规格差异很大，讲义用约 16 KiB page 说明量级。稳定的抽象是：

- read/program 的基本单位是 page 或其受限子单位；
- erase 的基本单位是包含许多 pages 的整个 block；
- 多个 channel/die/plane 可并行；
- 同一 page 不能像 RAM 字节那样无限任意覆盖。

### 14.2 program/erase 不对称

在简化 bit 模型中，erase 把整个 block 恢复到统一状态，program 再让选定 cell 的阈值朝一个方向改变。已 program page 若要回到任意新内容，通常不能原地逐 byte 改写；必须：

```text
读出 block 中仍有效的数据
  → 把有效 page 与新数据写到其他已擦除 page
  → 擦除原 block
  → 原 block 才能重新使用
```

这条规则将直接推导出 FTL、垃圾回收和写放大。SSD 的“random write”接口是控制器模拟出来的，不是 NAND 原生支持任意 LBA in-place overwrite。

## 15. 闪存：作为存储设备的分析

### 15.1 存储、性能与扩展性

| 维度 | 闪存优势 | 必须补充的边界 |
| --- | --- | --- |
| 成本/容量 | 大规模集成、3D 堆叠、多 bit/cell | 高密度会缩小电压 margin、降低 endurance |
| 随机读 | 无机械 seek/rotation，延迟低 | 仍有 address translation、queue 与 read retry |
| 顺序/随机带宽 | 多 channel/die 天然并行 | 要有足够 queue depth、请求粒度和 controller 并行度 |
| 抗震 | 无磁头/主轴，不怕一般机械震动 | controller、焊点、供电与封装仍会失败 |
| 保持/寿命 | 断电保持，ECC 可纠错 | P/E wear、retention、disturb、温度与掉电一致性 |

讲义强调“容量越大，速度越快”：同一代同类设计中，更大容量常意味着更多 NAND die/channel 可交错，因此 controller 有更多并行资源。但这不是单调定律；低端大容量设备可能 channel 少、NAND 更慢，SLC cache 耗尽后性能也会骤降。

Jim Gray 在 2006 年用一句话描述层级迁移：

> Tape is Dead, Disk is Tape, Flash is Disk, RAM Locality is King.

它不是预言磁带物理消失，而是说每层介质接过上一层的 workload：HDD 越来越像冷层，Flash 成为主力随机存储，而 DRAM locality 继续支配性能。

### 15.2 开启“优盘”时代（1999）

把 NAND、controller、USB interface 和固件封装在小外壳里，就得到可热插拔的优盘。它继承软盘的“介质可移动”，却没有裸露盘片和机械 drive，容量、速度与可靠性大幅提高。

优盘不是“USB 线上直接连一堆 cell”。主机发 USB Mass Storage/SCSI 风格的逻辑块命令，controller 完成 NAND 时序、映射、ECC 和坏块管理。这个隐藏的计算机系统既创造了简单接口，也成为性能、数据一致性与造假的边界。

## 16. Flash Memory 有一个致命的缺陷：擦除会磨损

### 16.1 放电做不到永远恢复到同一状态

高电场反复 program/erase 会在绝缘层中积累损伤和 trapped charge，使 threshold 分布漂移、漏电增加，最终无法可靠区分状态。工程上用 P/E cycle endurance、retention 和不可纠正错误率描述，而不是等到 cell 突然从“好”变“坏”。

讲义用“数千/数万次后像一直充电”建立直觉，并给出 QLC 大约千次量级。具体保证取决于 NAND 代际、温度、program 算法、ECC 和产品分级；应查产品的 TBW/DWPD 或 datasheet，不能把 1000 当作所有 QLC 的精确常数。

controller 会监测 bit error、用 ECC/LDPC 恢复、做 read retry，并将坏 block 退出使用。但纠错只能延后失效，不能让氧化层恢复全新。

### 16.2 为什么反复写 `a.txt` 不会固定烧同一 cell

讲义的担忧：

```python
from pathlib import Path

for i in range(1000):
    Path("a.txt").write_text(str(i))
```

若“文件 offset → 固定 NAND cell”，同一位置确实会快速耗尽。但真实路径至少有：

```text
Python/libc write
  → page cache / filesystem allocation and metadata
  → logical block writes
  → FTL remaps each updated logical page to a fresh physical page
  → old page invalidated; later GC/erase
```

因此 1000 次文件更新不会等价为对同一 cell 做 1000 次 P/E。它仍可能产生**更多**物理写：文件系统 journal、metadata、copy-on-write、FTL GC 都会放大 host 数据。安全结论不是“随便写不会磨损”，而是磨损由整个 mapping/回收系统分散和管理。

### 16.3 写放大从哪里来

定义 device-level write amplification：

```text
WAF = NAND 实际 program 的字节数 / host 请求写入的字节数
```

理想是 1；GC 搬迁 live page、metadata/checkpoint、wear leveling 和纠错维护会让它大于 1。文件系统在上层还可能先产生 filesystem-level amplification，二者可以叠加。

小随机更新最难：它们在很多 erase block 中留下少量 invalid page。要回收任一 block，controller 必须复制其中大部分 live page，再 erase；设备越满，可选择的空块越少，GC 成本和尾延迟常越高。USENIX 的 [Flashield 论文](https://www.usenix.org/conference/nsdi19/presentation/eisenman)给出了 out-of-place update、L2P 和 GC 导致 device-level write amplification 的完整实测背景；这是扩展阅读，不是本讲必须记忆的数值。

## 17. 软件定义磁盘：SSD 里藏着一台计算机

### 17.1 FTL 的最小状态

Flash Translation Layer 在 host 的 LBA 与 NAND physical page number 之间维护映射：

```text
L2P[logical_page] = (channel, die, plane, block, page)
```

逻辑覆盖写的典型次序是：

1. 选择一个已擦除 free page；
2. program 新数据并校验；
3. 原子地/可恢复地更新 L2P；
4. 旧 physical page 标成 invalid；
5. 后台或前台 GC 回收 invalid space。

这像虚拟内存 page table：逻辑地址稳定，物理位置可移动。区别是 FTL mapping 自身也必须跨掉电保存；controller 常在 RAM 缓存热点映射，同时把 journal/checkpoint 写回 NAND。掉电发生在 program 与 mapping commit 之间时，recovery protocol 决定旧/新版本哪一个可见。

### 17.2 Wear Leveling 不只是轮流写

- **dynamic wear leveling**：新写尽量分配到擦除次数较少的 free block；
- **static wear leveling**：偶尔搬走长期不变的冷数据，释放低磨损 block 给热写入；
- **bad-block management**：出厂坏块和运行中新坏块不再分配；
- **over-provisioning**：物理容量大于导出的逻辑容量，为 GC、坏块替换和并行保留空间；
- **TRIM/discard**：文件系统告诉 device 某些 LBA 不再有用，FTL 可把对应 page 当 invalid；discard 不保证读回零，除非设备协议另有承诺。

“随机读 + append-only 写可以实现任意数据结构”再次出现：L2P 是索引，out-of-place pages 是 log，GC 是 compaction。代价仍是额外空间、恢复协议和写放大。

### 17.3 Cache/store buffer 带来的持久性边界

SSD controller 常有 SRAM/DRAM cache 和待提交命令。host 看到 command complete 时，数据究竟已到 NAND、仍在易失 cache，还是由电容保护，取决于设备、write-cache 设置和命令 flags。

文件系统用 flush/FUA 等协议建立顺序与持久点；设备若撒谎或掉电保护有缺陷，上层再正确也无法兑现。`fsync()` 的完整语义将在文件系统/数据库章节展开，本讲只保留一个原则：

> “已写入 block abstraction”与“物理介质在任意掉电后必然保存”之间，需要明确协议，不应靠猜。

## 18. Flash Translation Layer（FTL）：从映射推导 GC

### 18.1 Page mapping、block mapping 与内存成本

若每个 4 KiB logical page 都有 4/8-byte mapping，TB 级设备的 L2P 会占用可观 RAM；全 page mapping 灵活且随机写好，但 controller 成本高。block mapping 表小，却限制 out-of-place placement；实际 FTL 会用 page/block/hybrid mapping、压缩和按需缓存等设计。

选择不仅影响平均吞吐，还影响：

- mapping lookup latency；
- crash recovery 扫描范围；
- GC victim 选择质量；
- hot/cold data separation；
- RAM 断电保护与 firmware 复杂度。

### 18.2 Garbage Collection 状态机

```text
free pages 低于阈值
  → 选 victim erase block（invalid 多、搬运少、兼顾 wear）
  → 读取其中 live pages
  → program 到其他 free pages，并更新 L2P
  → erase victim
  → victim 成为新的 free block
```

前台写恰好遇到 GC 会出现 latency spike；后台 GC 可利用空闲时间，却可能与前台竞争 channel。victim 只按“invalid 最多”选，可能造成磨损不均；只按 wear 选，又可能复制大量 live data。FTL 是策略空间，不是一张固定算法表。

### 18.3 实验一：用 16 个 page 看见 L2P、GC 与写放大

依赖：Python 3；只在内存中模拟，不读写任何设备。模型有 4 个 erase block、每块 4 page，其中始终保留一个空 block 给 GC 搬迁。它省略 ECC、channel 并行和掉电恢复，只验证核心不变量。

```bash
python3 - <<'PY'
PAGES_PER_BLOCK = 4
BLOCKS = 4
pages = [[None] * PAGES_PER_BLOCK for _ in range(BLOCKS)]
reserve = BLOCKS - 1
l2p = {}
erases = [0] * BLOCKS
host_writes = nand_programs = 0

def free_slot():
    for block in range(BLOCKS):
        if block == reserve:
            continue
        for page, record in enumerate(pages[block]):
            if record is None:
                return block, page
    return None

def garbage_collect():
    global reserve, nand_programs
    victims = []
    for block in range(BLOCKS):
        if block == reserve:
            continue
        invalid = sum(
            record is not None and not record[2]
            for record in pages[block]
        )
        if invalid:
            victims.append((invalid, block))
    if not victims:
        raise RuntimeError("no reclaimable block")

    _, victim = max(victims)
    destination = reserve
    live = [r for r in pages[victim] if r is not None and r[2]]
    for out_page, record in enumerate(live):
        copy = [record[0], record[1], True]
        pages[destination][out_page] = copy
        l2p[copy[0]] = (destination, out_page)
        nand_programs += 1

    pages[victim] = [None] * PAGES_PER_BLOCK  # erase 整块
    erases[victim] += 1
    reserve = victim
    print(f"GC victim={victim} copied={len(live)} "
          f"new_reserve={reserve}")

def write(lpn, generation):
    global host_writes, nand_programs
    slot = free_slot()
    if slot is None:
        garbage_collect()
        slot = free_slot()

    old = l2p.get(lpn)       # GC 可能搬过旧 page，所以现在再读取
    block, page = slot
    pages[block][page] = [lpn, generation, True]
    l2p[lpn] = (block, page)
    host_writes += 1
    nand_programs += 1
    if old is not None:
        old_block, old_page = old
        pages[old_block][old_page][2] = False

workload = [
    0, 1, 2, 3, 4, 5, 6, 7,
    0, 4, 1, 5, 2, 6, 3, 7,
    0, 1, 4, 5, 2, 3, 6, 7,
]
for generation, lpn in enumerate(workload):
    write(lpn, generation)

print("host_writes=", host_writes)
print("nand_programs=", nand_programs)
print("write_amplification=", round(nand_programs / host_writes, 3))
print("erase_counts=", erases)
print("L2P=", dict(sorted(l2p.items())))
PY
```

本机典型输出：

```text
GC victim=1 copied=2 new_reserve=1
GC victim=0 copied=1 new_reserve=0
GC victim=3 copied=2 new_reserve=3
GC victim=2 copied=1 new_reserve=2
GC victim=1 copied=2 new_reserve=1
host_writes= 24
nand_programs= 32
write_amplification= 1.333
erase_counts= [1, 2, 1, 1]
```

24 次 host write 之外又 program 8 个 page，因为 GC 必须搬 live data。`reserve` 不能参与普通分配，正是 over-provisioning 保证 GC 有目标空间的最小证明；若把所有物理 page 都承诺给 host，盘满时可能连搬迁第一张 live page 的空间都没有。

这个 toy FTL 的 erase count 已不完全均匀，说明“能回收”不等于 wear leveling 良好。修改 workload、victim policy 和 reserve 比例，比较 WAF、最大 erase count 与可用容量，就是一个安全的策略实验。

## 19. Flash Disk 与 NAND Flash：相同介质，不同系统

### 19.1 优盘、SD 卡、SSD 都使用 NAND，但不等价

主机通常看到逻辑块设备，里面可能包含：

```text
host interface (USB/SATA/NVMe/SD protocol)
controller CPU + firmware/RTOS
SRAM/DRAM mapping cache
ECC/LDPC engine
DMA, queues, store buffer
FTL: mapping, GC, wear leveling, bad-block management
NAND channels/packages/dies
power-loss protection（部分产品）
```

高端 SSD 用更多 channel、RAM、强控制器和更完善掉电保护提高并行、寿命和一致性；廉价优盘/卡可能 controller 弱、NAND 分级低、缓存小，持续写和随机写差异巨大。外壳容量相同不代表内部系统相同。

讲义说 SD/TF 标准未把具体 FTL 算法固定下来；产品为了向 host 提供逻辑 block overwrite，实际 controller 仍要完成某种 translation/management。标准化的是外部协议，内部策略属于厂商实现。

### 19.2 设备可以伪造容量和成功状态

canonical device model 的另一面是：host 只能相信寄存器/命令回复。恶意或劣质 controller 可以报告 1 TB 容量，实际只连接很少 NAND；超出真实容量后地址回绕，旧数据被静默覆盖。它也可能过早报告 flush/write complete。

验证工具如 F3/H2testw 会写满整个声明容量再读回校验。**这是破坏性测试，只能用于确认没有需要保留数据、允许完整覆盖的新介质；本章不把它当作可直接运行命令。** 对已有优盘，先做镜像/备份并确认设备节点仍不足以把测试变安全，最稳妥是不要原盘执行。

“不要买过度便宜的优盘”不是品牌判断，而是系统判断：controller firmware、NAND 来源和持久语义不可从塑料外壳得知。重要数据需要端到端校验、多副本和恢复演练。

## 20. 操作系统视角的存储设备：统一逻辑块抽象

### 20.1 Random Access 的代价是寻址

不同介质寻找地址的方式不同：

- 磁带沿长度移动；
- HDD seek track 并等待角度；
- 光盘调整光头半径并旋转；
- NAND 译码 channel → die → plane → block → page；
- Project Silica 还要在玻璃层和 library 中定位。

如果为每个 bit 配完全独立选通信号，寻址电路和能耗会压倒存储单元。设备因此把相邻 bit 绑成块，一次并行感测/传输。

### 20.2 减少寻址代价：按块访问

操作系统看到的最小模型：

```c
struct block {
  unsigned char bytes[BLOCK_SIZE];
};

struct block disk[NUM_BLOCKS];
```

接口按 logical block address（LBA）读写。传统逻辑 sector 常为 512 B，现代设备也可能导出 4 KiB；这与 HDD 的真实 ECC sector、NAND page、erase block 或 filesystem block 不必相同。

block amortize address/command cost，也让 DMA、ECC、cache 和队列有统一粒度。代价是修改一个 byte 可能触发：

```text
read filesystem block
  → modify one byte
  → write filesystem block/journal
  → device maps logical sectors to NAND page
  → GC eventually copies erase-block live pages
```

这就是 read/modify/write amplification 横跨多层的来源。

### 20.3 Block devices 的最小契约与边界

一个块设备表现为固定大小、可随机寻址的 block array，支持读、写、flush，可能还有 discard、write zeroes、zone append。Linux 用 `/dev/sdX`、`/dev/nvmeXnY`、`/dev/loopN` 暴露设备节点。

不要从数组比喻外推不存在的保证：

- request 可能乱序完成；
- power failure atomicity 的粒度要看设备明确规格；
- write cache 可能让“完成”不等于已落非易失介质；
- discard 是“这些内容不再需要”的提示，不必返回零；
- bad-block remap/FTL 使同一 LBA 的 physical location 变化；
- raw block node 绕过文件系统保护，写错一个 offset 就能毁掉分区。

普通应用通常不直接 `mmap`/写 raw device，而通过文件系统/page cache 使用。某些 block device/配置可支持映射或 direct I/O；这不把底层介质变成 byte-addressable RAM，页缺失和写回仍按块转换。真正 CPU load/store 可寻址的持久内存还涉及 DAX 等不同路径。

### 20.4 Block abstraction 的代价与 ZNS

普通 SSD 假装每个 LBA 可随时覆盖，FTL 在内部把它转成 append + GC。需要极致可预测性能或降低写放大的系统，可以让 host 看见更多介质约束。

NVMe Zoned Namespaces 把 namespace 划为 zones；顺序写 zone 维护 write pointer，host 按 zone 规则写/append，并显式 reset 回收。它用软件复杂度换更少 device over-provisioning/GC 与更可控延迟。[NVM Express 官方 ZNS Command Set](https://nvmexpress.org/specification/nvme-zoned-namespaces-zns-command-set-specification/)是扩展阅读。

ZNS 不是“没有 FTL”，也不是普通程序把任意 sector 当 append log 就会自动变快。文件系统/数据库要管理 zone 生命周期、容量、并发和回收；暴露约束只把决策上移。

## 21. 实验二：只读盘点本机 block abstraction

依赖：Linux、util-linux 的 `lsblk`、可读 sysfs；不需要 root，不写设备。

```bash
lsblk -o NAME,TYPE,SIZE,ROTA,RO,LOG-SEC,PHY-SEC,\
MIN-IO,OPT-IO,SCHED,MODEL,MOUNTPOINTS
```

选择输出中的一个**整盘名**（以下只是示例，必须替换为你机器确实存在的名字），只读 queue attributes：

```bash
dev=nvme0n1
test -d "/sys/class/block/$dev/queue" || exit 1

for key in rotational logical_block_size physical_block_size \
           minimum_io_size optimal_io_size nr_requests scheduler; do
  file="/sys/class/block/$dev/queue/$key"
  if test -r "$file"; then
    printf '%s=' "$key"
    cat "$file"
  fi
done
```

预期观察：

- `ROTA=1` 通常表示旋转介质，`0` 表示 non-rotational；loop、device-mapper 和虚拟盘也常为 0；
- `LOG-SEC` 是 host 寻址单位，`PHY-SEC` 是设备报告的物理 I/O 粒度之一，不等于 NAND erase block；
- `MIN-IO/OPT-IO` 是对齐/性能提示，0 可能表示未报告；
- `SCHED` 中方括号包围当前 scheduler；NVMe 常为 `none`，SATA/SCSI 也可能是 `mq-deadline`；
- partition 会继承/转发父盘属性，stacked device 可能隐藏部分值。

Linux 官方 [queue sysfs 文档](https://docs.kernel.org/5.15/block/queue-sysfs.html)解释这些文件，也标出哪些可写。**本实验只读；不要向 `scheduler`、discard 或其他 sysfs 控制文件写值。**

硬件差异是实验结果的一部分：USB bridge 可能不传真实型号/rotational；云 VM 的“磁盘”可能是网络卷；RAID controller 可把多块盘伪装成一个。sysfs 描述的是 OS 所见 contract，不是拆机照片。

## 22. 实验三：用 `/tmp` 文件安全模拟 block array

依赖：Linux/POSIX shell、`mktemp`、`truncate`、`dd`、`od`。只创建一个 8 MiB 临时稀疏文件，并只向它的第 7 个 4 KiB block 写标记；绝不使用 `/dev/sdX`。

```bash
image=$(mktemp /tmp/lect23-block.XXXXXX) || exit 1
trap 'rm -f -- "$image"' EXIT HUP INT TERM

truncate -s 8M "$image" || exit 1
printf 'logical-block-7\n' |
  dd of="$image" bs=4096 seek=7 conv=notrunc status=none || exit 1

stat -c 'logical-size=%s bytes allocated=%b*512 bytes' "$image"
dd if="$image" bs=4096 skip=7 count=1 status=none |
  od -An -tx1 -N32

rm -f -- "$image"
trap - EXIT HUP INT TERM
```

典型输出开头是 ASCII 标记的 hex：

```text
6c 6f 67 69 63 61 6c 2d 62 6c 6f 63 6b 2d 37 0a
00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00
```

`seek=7, bs=4096` 把写 offset 定为 `7 × 4096`；`skip=7` 用同一 LBA 读回。文件 logical size 是 8 MiB，但 `stat` 的 allocated blocks 很少，因为未写区域是 sparse hole，读取时由文件系统返回零。这又多一层地址翻译：file offset → filesystem extent → block device LBA。

这个实验只证明 block addressing，不证明设备 4 KiB 原子写、掉电持久或真实随机性能。regular file、page cache 和 filesystem 都在路径中。

### 22.1 可选：只读 loop device（需要 root/CAP_SYS_ADMIN）

loop driver 能把 backing file 的读写翻译为 block request。只在自己的机器/VM 中执行；共享环境没有权限就跳过。下面强制 `--read-only`，且没有 `mkfs`/mount：

```bash
image=$(mktemp /tmp/lect23-loop.XXXXXX) || exit 1
loop=
cleanup_loop() {
  if [[ "$loop" =~ ^/dev/loop[0-9]+$ ]]; then
    sudo losetup --detach "$loop" >/dev/null 2>&1 || true
  fi
  rm -f -- "$image"
}
trap cleanup_loop EXIT HUP INT TERM
truncate -s 32M "$image" || exit 1

loop=$(sudo losetup --find --show --read-only "$image") || exit 1
[[ "$loop" =~ ^/dev/loop[0-9]+$ ]] || {
  echo "unexpected loop path: $loop" >&2
  exit 1
}

lsblk -o NAME,TYPE,SIZE,RO,LOG-SEC,PHY-SEC "$loop"
sudo blockdev --getsize64 "$loop"

sudo losetup --detach "$loop"
loop=
rm -f -- "$image"
trap - EXIT HUP INT TERM
unset -f cleanup_loop
```

预期出现一个 32 MiB、只读的 `/dev/loopN`。如果任一步失败，先用 `losetup --list` 确认是否仍绑定，再只 detach 刚才记录且通过 `/dev/loop[0-9]*` 校验的设备。不要复用已经挂载/属于其他人的 loop device。可对照 [`loop(4)`](https://man7.org/linux/man-pages/man4/loop.4.html) 与 [`losetup(8)`](https://man7.org/linux/man-pages/man8/losetup.8.html)。

### 22.2 可选：`fio` 只读比较（只允许临时文件）

若安装了真正的 Flexible I/O Tester（先运行 `fio --version`；某些同名程序不是它），可在 `/tmp` 新文件上比较 QD=1 的 4 KiB 顺序/随机读。命令用 `--readonly`，但仍请逐字确认 `--filename` 是新建临时文件，绝不能改成真实 device：

```bash
bench=$(mktemp /tmp/lect23-fio.XXXXXX) || exit 1
trap 'rm -f -- "$bench"' EXIT HUP INT TERM
dd if=/dev/zero of="$bench" bs=1M count=256 conv=fsync status=progress || exit 1

fio --readonly --name=seq4k --filename="$bench" --rw=read \
    --bs=4k --size=256M --ioengine=sync --iodepth=1 \
    --direct=1 --time_based=1 --runtime=5 --group_reporting

fio --readonly --name=rand4k --filename="$bench" --rw=randread \
    --bs=4k --size=256M --ioengine=sync --iodepth=1 \
    --direct=1 --time_based=1 --runtime=5 --group_reporting

rm -f -- "$bench"
trap - EXIT HUP INT TERM
```

比较 IOPS、bandwidth 和 completion latency，而不只看一个数。HDD 通常显示随机读受 seek/rotation 强烈限制；SSD 差距小很多，但 random mapping、read-ahead 和 block size 仍影响结果。容器、网络盘、RAID、加密层和 controller cache 会改变观测；`/tmp` 若是 tmpfs 或不支持 direct I/O，`--direct=1` 会失败，此时不要假装测到了硬盘。

## 23. Linux Bio：文件系统与驱动之间的内部接口

### 23.1 应用看不见的 I/O 路径

buffered file write 的简化路径是：

```text
application write(fd, buf, n)
  → VFS / filesystem
  → page cache becomes dirty
  → filesystem maps file offset to device blocks
  → build/submit bio(s)
  → blk-mq merge/split/schedule into request(s)
  → driver queues command to hardware queue / DMA
  → interrupt or polled completion
  → request/bio end I/O; wake waiter / clear writeback
```

实际还有 journal、device mapper、encryption、RAID、cgroup throttling 等可堆叠层。一次应用 `write()` 可能只改 page cache，没有立即 bio；一次 writeback 可合并多个脏页；一个 bio 也可能被拆分到多个下层 device。

### 23.2 `struct bio` 表达什么

`bio`（block I/O）大致携带：

- 目标 block device；
- 起始 sector/LBA；
- READ/WRITE/FLUSH/DISCARD 等 operation 与 flags；
- 一组指向内存 page 片段的 bio vectors；
- 完成回调与状态。

它描述“这些内存片段与这些 device sectors 间的一次操作”，适合 scatter/gather。`request` 是块层进一步 merge/schedule 后交给 driver 的命令单位；二者不是同义词。

Linux 官方 [blk-mq 文档](https://docs.kernel.org/block/blk-mq.html)描述 per-CPU software staging queue、hardware dispatch queue 与 tag-based completion。多个 CPU 不必争一把全局 request lock；driver 把 request 发到设备支持的 hardware queue，完成时用 tag 找回它。

### 23.3 `block_device_operations`、`request_queue` 与 driver

讲义说为设备实现 `struct block_device_operations` 和 `struct request_queue`，剩余 read/write/mmap 可交给 block/filesystem 层。要精确分工：

- `block_device_operations` 主要提供 open/release/ioctl、介质变化等设备生命周期/控制操作；
- data path 由 gendisk、request queue、blk-mq operations（如 queue request）接收 request；
- driver 配 DMA mapping/descriptor，敲 doorbell，处理中断/轮询并 complete request；
- VFS/file system 在更上层把文件 offset 与 page 转成 block I/O。

驱动不能把“已放进硬件 queue”当成“已持久化”。它还要正确处理错误、timeout、reset、partial completion、flush/FUA 和 teardown；卸载时若仍有 in-flight request，释放内存就会产生 use-after-free。

### 23.4 请求与完成顺序

多队列、NCQ/NVMe 允许并发和乱序完成。Linux blk-mq 文档明确提醒 block layer/protocol 不自动保证 completion order；需要顺序的 filesystem 要用 barrier/flush/FUA 等协议建立。

因此下面推理是错误的：

```text
submit data write
submit metadata write
第二个 request 后提交
⇒ 掉电后 metadata 一定不早于 data 持久化    （错误）
```

提交顺序、完成顺序与非易失介质顺序是三件事。后续 crash consistency 会把这一区分变成 WAL、journal 和 `fsync` 规则。

## 24. 打开 Linux Block I/O：课堂 Demo 与安全观察

### 24.1 Demo 想证明什么

课堂让 Coding Agent 在陌生的大型 Linux 源码中打开 block I/O，并特意记录模型与成本。重点不是炫耀“几毛钱写出驱动”，而是验证 Harness 方法：

1. 从权威源码和现有简单 block driver 找最小 data path；
2. 让 Agent 解释 gendisk、queue、request、bio 与 completion 的对象关系；
3. 在 VM 中构建与加载，避免宿主 kernel/data 风险；
4. 用已知 pattern 的只读/临时块 workload 验证 offset、长度和完成；
5. 注入越界、并发、卸载和错误路径，检查是否 hang/UAF；
6. 用 tracepoint 对上每个 request，而不是只看模块打印“success”。

一个内核模块有能力崩溃系统或破坏所有块设备。**不要在保存用户数据的宿主机加载课堂生成的 block driver。** 推荐 disposable VM，快照可恢复，测试设备只用 RAM-backed/null/独立临时镜像。

### 24.2 实验四：只列举/读取 block tracepoint（安全、只读）

首先无特权检查 tracefs 是否暴露：

```bash
if test -d /sys/kernel/tracing/events/block; then
  find /sys/kernel/tracing/events/block -mindepth 1 -maxdepth 1 \
       -type d -printf '%f\n' | sort
else
  echo 'tracefs/block events unavailable in this environment'
fi
```

有 root 且系统允许 tracing 时，只读 event format：

```bash
sudo sed -n '1,160p' \
  /sys/kernel/tracing/events/block/block_rq_issue/format
sudo sed -n '1,160p' \
  /sys/kernel/tracing/events/block/block_rq_complete/format
```

预期看到 event fields，例如 device、sector、bytes、operation flags；具体字段随 kernel 版本变化，应先读 format，再写 bpftrace/trace-cmd 程序，不要照抄旧字段名。

若已安装 `trace-cmd`，可在自己的临时文件上发起**只读** direct I/O：

```bash
image=$(mktemp /tmp/lect23-trace.XXXXXX) || exit 1
trace_dir=$(mktemp -d /tmp/lect23-trace-output.XXXXXX) || {
  rm -f -- "$image"
  exit 1
}
trace="$trace_dir/trace.dat"
cleanup_trace() {
  rm -f -- "$image" "$trace"
  rmdir -- "$trace_dir" 2>/dev/null || true
}
trap cleanup_trace EXIT HUP INT TERM
dd if=/dev/zero of="$image" bs=1M count=64 conv=fsync status=none || exit 1

sudo trace-cmd record -o "$trace" \
  -e block:block_rq_issue -e block:block_rq_complete -- \
  dd if="$image" of=/dev/null bs=4096 iflag=direct status=none
sudo trace-cmd report -i "$trace" | sed -n '1,120p'

rm -f -- "$image" "$trace"
rmdir -- "$trace_dir"
trap - EXIT HUP INT TERM
unset -f cleanup_trace
```

权限/硬件差异：容器常禁止 tracefs/`ptrace`/BPF；`/tmp` 若是 tmpfs 或 overlay 不支持 direct I/O，可能没有 block event；后台 I/O 还会混入 trace。即使成功，也只观察 request issue/complete，不能由 sector 序列直接推断 NAND physical page 或 FTL GC。

本实验绝不读取 raw `/dev/sdX`，更不向其写入。若无法确认 `image` 是 `/tmp` 新文件，就停止，而不是为了“看到事件”扩大权限或改目标。

## 25. 统一推导：介质约束怎样层层变成抽象

| 介质 | 稳定状态 | 原生定位/更新限制 | 设备/软件补偿 | 适合 workload |
| --- | --- | --- | --- | --- |
| 磁带 | 磁化变化 | 1D 串行定位 | block/file mark、robot library、索引 | 冷归档、顺序流 |
| 磁鼓 | 圆柱磁道 | 等 rotation | 多固定头/track 选择 | 早期较快随机访问 |
| HDD | 盘面磁畴 | seek + rotation | cache、scheduler、NCQ、ECC/remap | 低成本大容量 |
| 软盘 | 可移动磁盘 | 低密度、暴露介质 | drive 与介质分离、格式/ECC | 历史软件发行 |
| 压制光盘 | pit/land 光学结构 | WORM、旋转定位 | EFM、ECC、工厂 stamper | 廉价内容复制 |
| NAND | cell threshold | page program、block erase、有限 P/E | FTL、GC、wear leveling、ECC | 低延迟主存储 |
| 玻璃归档 | 激光写入微结构 | 高写成本、近 immutable | append log、索引、robot library | 超长期冷数据 |

所有介质最终可被包装成 block array，因为这个窄腰让现有 filesystem、page cache、数据库和应用无需理解物理细节。它成功的代价是 information hiding：上层不知道最佳 placement、erase boundary 与真实持久点；FTL 又不知道文件哪些 block 已失效，直到 TRIM 才得到提示。

系统优化因此经常是“适度打破抽象”：read-ahead 传递顺序性，discard 传递失效信息，FUA/flush 传递持久顺序，ZNS 暴露 append constraint，SMART/NVMe log page 暴露健康状态。暴露越多，优化空间越大，软件复杂性和兼容成本也越高。

## 26. 概念辨析与常见误区

### 26.1 介质、设备、块层、文件系统不是同一层

| 层次 | 实例 | 负责什么 | 不保证什么 |
| --- | --- | --- | --- |
| 物理介质 | magnetic grain、pit、NAND cell | 保存可感测状态 | 不直接提供 POSIX 文件 |
| controller/firmware | HDD firmware、SSD FTL | 命令、ECC、映射、GC、队列 | 不理解应用事务意图 |
| 总线协议 | USB/SATA/NVMe | 提交/完成、DMA、feature commands | 不决定目录结构 |
| Linux block layer/driver | `bio`、request、blk-mq | 合并/拆分/派发/completion | 不给用户命名文件 |
| filesystem/page cache | inode、extent、journal、writeback | 文件/目录、缓存、一致性 | 不能修复撒谎/损坏设备的一切 |
| application/database | record、WAL、transaction | 业务不变量与恢复 | 不能把普通 write 自动当 durability proof |

### 26.2 高频误区

- **“持久化等于永远不坏。”** 所有介质都有 retention、磨损、环境和控制器故障；持久系统靠校验、冗余、迁移和恢复。
- **“磁带顺序速度低，所以一无是处。”** 定位慢不等于流式带宽低；冷归档看容量成本、能耗与顺序 workload。
- **“7200 RPM 的平均旋转延迟是 8.3 ms。”** 8.3 ms 是一整圈；均匀随机角度平均半圈约 4.17 ms，另加 seek。
- **“elevator 在 SSD 时代完全消失。”** 几何 seek 权重下降，但 blk-mq scheduler、合并、deadline/fairness 仍存在。
- **“光盘 pit 就是裸 0、land 就是裸 1。”** 通道编码利用 transition、EFM、framing 和 ECC；host sector 已经过解码。
- **“工厂三秒压盘等于光驱 33 GB/s 写入。”** 一个是模具并行复制，另一个是设备逐轨写入，接口不同。
- **“SSD 没机械部件，所以可靠性无限。”** NAND wear、retention、controller firmware、供电与焊点仍会失败。
- **“SLC/MLC/TLC/QLC 只改变容量。”** 更多电压状态也改变 margin、latency、ECC 和 endurance。
- **“NAND 可以按 byte 覆盖。”** 原生更新受 page program/block erase 约束，随机 overwrite 由 FTL 模拟。
- **“写文件 1000 次必定擦同一 cell 1000 次。”** 文件系统与 FTL 都会 remap；实际 physical writes 还可能因 journal/GC 放大。
- **“wear leveling 会消灭磨损。”** 它只尽量均匀分布有限 P/E budget，还会搬数据并产生额外写。
- **“TRIM 就是安全清零。”** discard 是无用提示；数据返回值和物理清除时机依设备语义，不应当 secure erase。
- **“优盘、SD 和企业 SSD 只差接口/外壳。”** controller、并行度、NAND、缓存、ECC 与掉电保护可完全不同。
- **“设备报告 1 TB 就一定有 1 TB NAND。”** controller 可撒谎；端到端写读校验才验证容量，但会破坏原数据。
- **“`ROTA=0` 证明拆开就是 Flash。”** loop、网络卷、RAM/虚拟盘也为 non-rotational；它是 OS 所见属性。
- **“logical sector 就是 NAND page。”** 512/4096 B LBA 与 page/block 是不同抽象层，FTL 负责映射。
- **“block device 真像 RAM 数组，单次元素写原子。”** 排序、缓存、tear/atomicity 与掉电语义必须查协议。
- **“一次 `write()` 对应一次 `bio`。”** page cache、filesystem 和 block layer 会延迟、合并、拆分或重发。
- **“`bio` 就是硬件 request。”** bio 描述 block I/O segments；blk-mq 可合并/转换成 request，再由 driver 下发。
- **“request complete 就必定掉电不丢。”** cache 与协议决定 persistence；需要正确 flush/FUA 路径。
- **“能编译的 block driver 就能在宿主机测试。”** 内核 bug 可崩溃或毁盘；必须用 disposable VM/专用临时设备。

## 27. Takeaways：block array 是成功的谎言，也是系统的窄腰

本讲的历史不是介质博物馆，而是一条反复出现的推导：

1. 人类先找到能稳定区分的物理状态：磁化、坑/平、cell 电荷；
2. 寻址成本塑造几何：磁带一维、磁鼓多 track、HDD 盘面、NAND die/plane/block/page；
3. 机械介质的随机性能受 seek/rotation 支配，缓存、调度和 NCQ 只能重排/摊薄，不能消灭物理运动；
4. 可移动软盘和易压制光盘改变软件发行，说明存储价值还取决于系统物流；
5. NAND 用电子速度与并行战胜机械延迟，却带来 page program、block erase 和有限 P/E 的根缺陷；
6. FTL 用 L2P/out-of-place update 把 NAND 伪装成磁盘，用 GC、over-provisioning、wear leveling、ECC 管理代价；
7. 优盘、SD 和 SSD 因而都是“软件定义磁盘”，controller 质量决定性能、寿命和持久承诺；
8. OS 再把一切统一为逻辑 block array，`bio`/blk-mq/driver 把 filesystem I/O 交给硬件；
9. block abstraction 隐藏物理复杂性，也制造写放大与信息鸿沟；discard、flush、ZNS 等接口选择性地重新暴露约束；
10. 从介质到应用，每层都必须区分“命令返回”“I/O complete”“数据已持久化”。

讲义最后追问：若更快的 non-volatile memory 出现又退场，系统会否彻底改变？答案取决于它是否改变寻址粒度、持久语义、价格和 endurance。只提高一个 benchmark 带宽，不足以自动消灭文件系统、缓存或数据库；真正重塑系统的是新的可靠状态机 contract。

一句话总结：**存储设备向上承诺一个简单的随机块数组，向下却用机械、光学、半导体和一整台 controller 计算机兑现；理解性能与可靠性，必须沿抽象向下找到被隐藏的物理约束。**

## 28. 思考题与延伸实验

1. 磁带的随机定位很慢，为什么大规模归档仍可能比 HDD/SSD 便宜可靠？把能耗、介质离线、机器人和恢复时间纳入模型。
2. 7200 RPM HDD 平均 rotation 是 4.17 ms。若平均 seek 8 ms、transfer/controller 0.5 ms，QD=1 随机读理论 IOPS 上界约多少？为什么真实值还会不同？
3. 两个相邻 4 KiB 请求合并成 8 KiB，对 HDD 与 NVMe 分别节省了什么？哪些场景反而增加尾延迟？
4. 为什么固定磁头磁鼓能消灭 seek，却仍不能得到 DRAM 级 random latency？
5. 压制 CD 的复制为什么可极快，而 CD-R 用户写入不能采用同样路径？制造接口和运行时接口有何不同？
6. append-only 介质怎样实现“删除”和“覆盖”？设计 record、tombstone、index 和 compaction 的最小格式。
7. SLC 到 QLC 每 cell 状态数怎样变化？相邻 threshold window 变窄后，read retry、ECC 和 retention 会怎样受影响？
8. 在实验一 FTL 中增加 reserve blocks，比较 usable capacity、WAF 和 GC 次数；为什么结果依 workload？
9. toy FTL 若在 program 新 page 后、更新 L2P 前掉电，会出现什么？怎样用 journal/version/checkpoint 恢复旧或新值？
10. static wear leveling 为什么要主动搬几乎不更新的冷数据？它怎样与写放大目标冲突？
11. 文件系统删除 100 GB 文件但不发 discard，FTL 为什么仍认为 pages live？发送 discard 后为什么不能把读回零当作安全擦除证明？
12. 假容量优盘为什么在写入前半段看似完全正常？设计破坏性容量测试前必须满足哪些数据安全条件？
13. 对本机 `lsblk` 输出，画出 partition、device mapper、loop 和 physical/virtual disk 的树；哪些 queue 参数可可信下推？
14. 稀疏文件实验中 logical size 8 MiB，为什么只分配一个 4 KiB 左右 extent？hole 读零由哪一层实现？
15. `fio` 的 sequential 1 MiB/QD32 与 random 4 KiB/QD1 同时改变了哪些变量？怎样做一次只改变 access pattern 的公平实验？
16. buffered write、`O_DIRECT` 与 `mmap` dirty page 各在何时生成 bio？如何用 tracepoint 而不是猜测验证？
17. 一个 bio 跨越 device 最大 segment/sector 限制时，块层应怎样 split？相邻 bios 又为何可能 merge？
18. 多队列设备中 data request 后提交 metadata request，为什么完成顺序不足以证明掉电顺序？需要哪些 flush/FUA contract？
19. ZNS 把 GC/placement 责任上移后，filesystem 得到了什么信息，又新增哪些恢复与回收工作？
20. 如果出现 byte-addressable、低延迟、无限 endurance 的持久内存，目录、命名、权限、事务和备份是否仍需要？哪些层会留下？

扩展阅读按主线选择即可：OSTEP 第 37 章 Hard Disk Drives 与第 44 章 Flash-based SSDs；Linux [blk-mq](https://docs.kernel.org/block/blk-mq.html)和 [queue sysfs](https://docs.kernel.org/5.15/block/queue-sysfs.html)文档；NVM Express [ZNS specification](https://nvmexpress.org/specification/nvme-zoned-namespaces-zns-command-set-specification/)；以及讲义给出的 SSD Guide/Coding for SSDs。外部资料用于补真实系统细节，PPT 的介质→FTL→block/bio 主线仍是本章骨架。

## 29. 下一讲衔接：块号不能成为人类的信息世界

本讲最终得到：

```text
read_block(id) → BLOCK_SIZE bytes
write_block(id, data)
flush/discard/...（按设备协议）
```

设备里的 controller 已经处理磁头、坏块、NAND mapping 和 GC，操作系统似乎只剩读写数组。但让所有进程直接打开 `/dev/nvme0n1` 并自行选择 block id，会立即互相覆盖；用户也无法靠“第 918273 个块”管理照片、源码与运行库。

下一讲《文件系统 API（1）》会把 block array 再虚拟化为：

- 有长度、可 `read/write/lseek/ftruncate` 的文件；
- 利用信息局部性组织的目录树；
- 把不同设备目录树接入统一 namespace 的 mount；
- hard link 与 symbolic link；
- 面向人类的路径、权限和管理接口。

物理介质约束没有消失：文件布局影响 HDD seek，journal/COW 影响 SSD 写放大，`fsync` 要穿过 page cache、bio、controller cache 到介质。文件系统正是“友好名字与底层块状态机”之间的新翻译层。

## 30. PPT 内容覆盖表

下表第一列按 `lect23.md` 的非重复一级标题顺序逐字保留；重复出现的课程标题“存储设备的抽象”在同一行映射两处正文，其余不同标题分别列出。

| 原讲义一级标题（按出现顺序） | 本章对应位置 | 覆盖要点 |
| --- | --- | --- |
| 存储设备的抽象 | §0–§1、§20 | 课程总题；介质到逻辑 block array 的统一抽象 |
| Review & Comments (1) | §2 | DeepSeek Agent Harness JD、陌生领域质量保证、内核实验安全 Harness |
| Review & Comments (2) | §3 | canonical device、file operations/driver 翻译、进入持久化 |
| 正式进入 “持久化” 部分 | §4 | persistence 双关、Rosetta Stone、稳定/可寻址/可读写状态条件 |
| “持久化” 可能没有想象的那么困难 | §5.1 | 可反复改写的磁状态、滞回、噪声/ECC 边界 |
| 电磁感应：物理和数字世界的桥梁 | §5.2、§6 | 磁畴写入、感应/磁阻读出；1D 磁带 |
| 磁带：密度可以高得离谱！ | §6.2 | 简单记录层、高面密度/大容量及代际数字边界 |
| 磁带：作为存储设备的分析 | §6.3 | 低价、高容量、可靠封装；顺序吞吐与随机定位；归档/音视频 |
| 磁鼓 (Magnetic Drum, 1932) | §7 | 1D→1.5D、固定多磁头、延迟至多一圈 |
| 疯狂内卷：磁盘 (Hard Disk, 1956) | §8.1 | 1.5D→2.5D、盘面/磁道/扇区、LBA 到几何 |
| 磁盘：克服各种工程挑战 | §8.2 | flying head、servo 与 head crash 等精密机械约束 |
| 磁盘：克服各种工程挑战 (cont’d) | §8.2 | 垂直记录、信号/ECC、坏扇区 remap 与机械可靠性 |
| 磁盘：作为存储设备的分析 | §8.3 | 价格/容量/可靠性、顺序与随机性能、主力存储/恢复边界 |
| 磁盘：性能调优 | §8.4–§8.5 | seek/rotation/transfer 公式、7200 RPM 校准、cache/elevator/AHCI/NCQ |
| 软盘 (Floppy Disk, 1971) | §9.1 | drive/介质分离、8/5.25/3.5 英寸、可移动数据 |
| 曾经，软件是通过“软盘”发行的！ | §9.2 | OS/软件跨盘发行、容量塑造软件、保存图标遗产 |
| 软盘：作为存储设备的分析 | §9.3 | 低价/低容量/低可靠、低性能、历史应用 |
| 坑：天然容易 “阅读” 的数据存储 | §10.1 | Rosetta Stone、几何状态、WORM 的读写权衡 |
| 现代工业：我们可以挖出更精细的坑！ | §10.2 | 激光、螺旋 track、反射变化、transition/ECC |
| Compact Disk (CD, 1980) | §11.1 | 44.1 kHz/16-bit/stereo/74 分钟、pit/land、EFM |
| 光盘最有趣的特性：容易复制！ | §11.2 | master/stamper、塑料压制/反射层、复制吞吐与设备写带宽辨析 |
| 光盘：作为存储设备的分析 | §11.3 | 价格/容量/可靠性、顺序/随机读、CD-R/RW、数字发行 |
| 挖坑：还有别的用处吗？ | §12 | Project Silica、玻璃冷归档、random read + append-only write |
| Solid State Drive (1991) | §13 | 磁/光限制、Flash、电子密度、SLC/MLC/TLC/QLC |
| 1-Bit Flash Memory | §14 | floating-gate/charge-trap、NAND 层次、page program/block erase |
| 闪存：作为存储设备的分析 | §15.1 | 价格/容量/可靠性、低延迟/并行扩展、容量与速度的条件、Jim Gray |
| 开启 “优盘” 时代 (1999) | §15.2 | USB 可移动存储、controller/协议而非裸 cell |
| Flash Memory 有一个致命的缺陷 | §16 | erase saturation/P/E wear、QLC 量级、`a.txt` 反例、写放大 |
| 软件定义磁盘 | §17 | controller 计算机、L2P/out-of-place update、wear leveling、cache/掉电 |
| Flash Translation Layer (FTL) | §18、实验一 | mapping 粒度、GC 状态机、reserve/over-provisioning、WAF 实测 |
| Flash Disk 与 NAND Flash | §19 | 优盘/SD/SSD 内部复杂度差异、CPU/RAM/cache/firmware、假容量 |
| Linux Bio | §23 | bio vectors、request/blk-mq、block_device_operations/request_queue、completion 顺序 |
| `[打开 Linux Block I/O](/OS/demos/persistence/bio)` | §24 | Coding Agent 进入内核方法、VM 安全边界、block tracepoint 只读实验 |
| Takeaways | §25、§27 | 电/介质演化、NAND 缺陷与工业 FTL、block 窄腰、新 NVM 追问 |
| 阅读材料 | §28 | OSTEP 37/44、SSD/内核/ZNS 扩展材料与阅读方法 |
