# 04 · 访问控制：把“谁能做什么”变成可验证策略

> 对应官方模块：[Access Control](https://pwn.college/intro-to-cybersecurity/access-control/)

## 学习目标

读完本章，你应当能够：

- 用主体、客体、动作、环境和决策描述一次访问；
- 区分认证、授权、审计与问责；
- 解释 POSIX 所有者、组、权限位和有效身份的判定顺序；
- 对比 DAC、MAC、RBAC、ABAC 与 capability 模型；
- 识别对象级越权、混淆代理、权限膨胀和 TOCTOU；
- 写出默认拒绝、可测试且能审计的策略函数。

## 1. 访问控制的最小模型

一次授权决策至少包含：

```text
主体 subject：谁发起操作，例如用户、进程或服务账户
客体 object：被访问的资源，例如文件、记录、socket 或密钥
动作 action：read、write、delete、execute、share 等
环境 context：时间、网络、设备状态、认证强度等
策略 policy：把上述输入映射为 allow 或 deny
```

可以写成函数：

```text
decision = policy(subject, object, action, context)
```

认证只提供主体身份的证据。授权仍需针对当前资源和动作重新计算。一个用户“已登录”不等于他能读取所有订单；一个进程“由管理员启动”也不等于它接收的每个路径都应以管理员权限打开。

## 2. 参考监视器应满足什么

理想的参考监视器（reference monitor）有三个属性：

1. **完全中介**：每次访问都经过检查，没有绕过路径；
2. **防篡改**：普通主体不能修改策略或决策机制；
3. **可验证**：足够小且结构清晰，能够审计和测试。

如果列表接口检查了权限，但下载接口直接按对象 ID 返回文件，就违反完全中介。若授权代码散落在每个控制器里，也更容易出现一个遗漏。工程上常把决策集中到策略层，再由所有入口调用。

## 3. POSIX DAC：所有者、组和其他人

传统 POSIX 文件权限属于自主访问控制（DAC）：对象所有者可以在一定范围内决定谁访问它。`0640` 可拆成：

```text
0  6  4  0
   rw- r-- ---
   owner group other
```

每组三位分别代表读 `4`、写 `2`、执行 `1`。内核选择一组适用权限，而不是把三组相加：

1. 有效 UID 等于文件所有者，使用 owner 位；
2. 否则若有效 GID 或附加组匹配文件组，使用 group 位；
3. 否则使用 other 位。

下面用纯 Python 玩具模型演示判定，不接触真实权限：

```python
# dac_model.py
from dataclasses import dataclass

READ, WRITE, EXECUTE = 4, 2, 1

@dataclass(frozen=True)
class Subject:
    uid: int
    groups: frozenset[int]

@dataclass(frozen=True)
class ToyFile:
    owner_uid: int
    group_gid: int
    mode: int

def permission_bits(subject: Subject, obj: ToyFile) -> int:
    if subject.uid == obj.owner_uid:
        return (obj.mode >> 6) & 0b111
    if obj.group_gid in subject.groups:
        return (obj.mode >> 3) & 0b111
    return obj.mode & 0b111

def allowed(subject: Subject, obj: ToyFile, requested: int) -> bool:
    return permission_bits(subject, obj) & requested == requested

document = ToyFile(owner_uid=1000, group_gid=2000, mode=0o640)
owner = Subject(uid=1000, groups=frozenset({1000}))
teammate = Subject(uid=1001, groups=frozenset({2000}))
visitor = Subject(uid=1002, groups=frozenset({1002}))

print("owner write:", allowed(owner, document, WRITE))
print("team read:  ", allowed(teammate, document, READ))
print("team write: ", allowed(teammate, document, WRITE))
print("other read: ", allowed(visitor, document, READ))
```

预期输出：

```text
owner write: True
team read:   True
team write:  False
other read:  False
```

一个常见误区是“用户也属于 other，所以可以取更宽松的一组”。实际判定会选择最先匹配的类别；若用户是所有者，就只使用 owner 位。

### 目录权限与文件权限不同

对目录而言：

- 读：列出目录项名称；
- 写：创建、删除或重命名目录项，通常还需要执行；
- 执行：穿越目录并解析其中名称。

删除文件主要修改父目录的目录项，因此即使文件本身只读，拥有父目录适当权限的主体也可能删除它。sticky bit 可限制共享目录中的删除行为。

## 4. 真实身份、有效身份与最小特权

进程可以有真实 UID、有效 UID 和保存的 UID。内核多数访问检查使用有效身份。某些可执行文件通过 setuid 在受控入口临时获得文件所有者身份，这使它成为高价值参考监视器。

安全的特权程序应：

- 在读取外部参数前明确可信输入范围；
- 尽快放弃不需要的特权；
- 使用绝对路径和受控环境；
- 避免把不可信字符串交给 shell；
- 检查被访问对象本身，而不是只检查文件名文本；
- 对失败采取默认拒绝并记录必要审计信息。

特权是进程状态，不是“某一行代码”的属性。只要特权仍有效，错误库调用、信号处理器和解析器都处在更高影响范围内。

## 5. ACL 与 capability：从两个方向看关系

访问控制表（ACL）附着在对象上，回答“谁能访问我”：

```text
document-7:
  Alice -> read, write
  Team-Blue -> read
```

capability 附着在主体持有的不可伪造引用上，回答“我持有什么权限”：

```text
Alice 持有：document-7 的 read/write capability
```

二者各有权衡：

- ACL 便于查看某对象的所有授权和集中撤销；
- capability 便于委托最小权限，但传播与撤销要精心设计；
- 一个随机下载 URL 只有在足够不可预测、权限范围有限且可撤销时，才近似 bearer capability；
- 持有 bearer token 的任何人通常都能使用它，所以日志、Referer 和剪贴板泄漏都很关键。

## 6. RBAC：权限授予角色

基于角色的访问控制（RBAC）把权限授予角色，再把用户分配到角色：

```text
用户 -> 角色 -> 权限
Lin  -> editor -> article:read, article:update
Mo   -> viewer -> article:read
```

优点是管理规模从“每用户每资源”降低为稳定角色。风险是角色爆炸和长期累积：为了处理一次例外不断添加新角色，最终无人能解释角色含义。

应区分业务角色与组织头衔。“财务部员工”不一定意味着能审批自己的报销。职责分离可要求创建者与审批者不是同一主体，敏感操作还可要求临时提升和双人批准。

## 7. ABAC：基于属性计算

基于属性的访问控制（ABAC）使用主体、资源和环境属性，例如：

```text
allow if
  subject.department == resource.department
  and subject.clearance >= resource.classification
  and context.device_managed
  and context.hour in business_hours
```

它表达力强，但策略冲突、属性来源与缓存失效会变复杂。每个属性都必须有可信来源：客户端自报的 `department=finance` 不是可信属性。

下面实现一个默认拒绝的玩具策略：

```python
# abac_policy.py
from dataclasses import dataclass

LEVEL = {"public": 0, "internal": 1, "confidential": 2}

@dataclass(frozen=True)
class User:
    name: str
    department: str
    clearance: str

@dataclass(frozen=True)
class Record:
    owner: str
    department: str
    classification: str

def may_read(user: User, record: Record, managed_device: bool) -> bool:
    if not managed_device:
        return False
    if user.name == record.owner:
        return LEVEL[user.clearance] >= LEVEL[record.classification]
    return (
        user.department == record.department
        and LEVEL[user.clearance] >= LEVEL[record.classification]
    )

ada = User("Ada", "research", "confidential")
lin = User("Lin", "support", "internal")
design = Record("Ada", "research", "confidential")

print(may_read(ada, design, managed_device=True))
print(may_read(lin, design, managed_device=True))
print(may_read(ada, design, managed_device=False))
```

预期输出：

```text
True
False
False
```

策略函数是纯函数，容易为属性组合写表驱动测试。真实系统还需验证 `LEVEL` 中不存在未知标签，避免解析失败时意外降级为最低级别。

## 8. MAC 与安全标签

强制访问控制（MAC）由系统策略决定，普通对象所有者不能随意绕过。保密性格模型常把主体许可和对象分类放入偏序关系。

一个简化标签可能由“等级 + 类别集合”组成：

```text
主体许可：(secret, {ALPHA, BLUE})
对象标签：(confidential, {ALPHA})
```

若主体等级不低于对象，且主体类别包含对象全部类别，则主体支配对象，可读取它。经典 Bell–LaPadula 保密模型常概括为“不向上读、不向下写”：

- 不向上读：低许可主体不能读高分类对象；
- 不向下写：高分类主体不能把信息写到低分类对象。

第二条防的是信息泄漏，不是普通文件权限意义上的“能不能编辑”。完整系统还要考虑可信降密流程、完整性模型和实际业务可用性。

```python
# label_model.py
RANK = {"public": 0, "confidential": 1, "secret": 2}

def dominates(left, right) -> bool:
    left_level, left_categories = left
    right_level, right_categories = right
    return (
        RANK[left_level] >= RANK[right_level]
        and left_categories.issuperset(right_categories)
    )

subject = ("secret", frozenset({"ALPHA", "BLUE"}))
high_object = ("confidential", frozenset({"ALPHA"}))
other_category = ("confidential", frozenset({"GREEN"}))

print("read high:", dominates(subject, high_object))
print("read green:", dominates(subject, other_category))
print("write public:", dominates(("public", frozenset()), subject))
```

预期输出：

```text
read high: True
read green: False
write public: False
```

最后一行用“目标对象是否支配主体”表达不向下写；公共对象不支配 secret 主体，因此拒绝。

## 9. 混淆代理：有权限的程序替别人做了不该做的事

混淆代理（confused deputy）发生在一个拥有自身权限的服务，被低权限调用者诱导去访问调用者本无权访问的资源。

例如导出服务有权读取所有报告。若接口接收任意文件路径，只验证调用者能使用“导出功能”，却不验证调用者能读目标报告，服务就把自己的广泛权限借给了调用者。

修复思路：

1. 不接收任意路径，接收对象 ID；
2. 在服务端查询对象与所有者；
3. 针对调用者、对象和 `export` 动作授权；
4. 用窄范围 capability 或下游委托传播调用者权限；
5. 服务账户本身也只获得完成工作所需的最小权限。

## 10. TOCTOU：检查的对象必须就是使用的对象

代码如果先按路径检查所有者，再稍后按同一路径打开文件，中间可能被重命名或替换。检查结果属于“当时那个对象”，使用动作却可能命中“后来另一个对象”。

通用原则是：

- 尽量先安全打开对象，再基于稳定句柄检查和使用；
- 使用原子内核 API，而不是“检查—睡眠—操作”序列；
- 对临时文件使用安全创建标志和私有目录；
- 数据库中把授权检查与状态改变放在合适事务内，并处理并发冲突。

增加第二次字符串检查只能缩小时间窗，不能消除竞争模型。

## 11. 审计不是把所有内容写日志

高质量授权日志应回答：

- 哪个已认证主体；
- 对哪个稳定资源标识；
- 请求何种动作；
- 哪条策略允许或拒绝；
- 决策时间和请求关联 ID。

不要记录密码、完整会话 token、私钥或不必要的敏感正文。日志本身也需要访问控制、完整性保护、留存期限和告警规则。只记录成功而不记录拒绝，会失去发现探测和配置错误的机会；记录所有原始请求又可能制造新的敏感数据仓库。

## 12. 安全与防御设计检查表

1. 默认结果是否为 deny？
2. 每条入口是否都经过同一策略层？
3. 决策使用的是服务端可信身份与对象属性吗？
4. 是否检查具体对象，而不只是功能级角色？
5. 缓存的授权在角色撤销后多久失效？
6. 后台任务是否保存并重验原始调用者上下文？
7. 管理员和服务账户能否进一步拆分权限？
8. 临时提升是否有时限、理由和审批？
9. 失败与异常是否保持拒绝，而非“出错就放行”？
10. 是否有测试覆盖跨租户、已删除用户和并发状态改变？

## 13. 常见误区

- **“认证成功等于授权成功。”** 身份只是授权输入之一。
- **“隐藏按钮就不能调用接口。”** 请求者可以直接构造 HTTP 请求，服务端必须检查。
- **“管理员角色解决所有例外。”** 过宽角色扩大错误和凭据泄漏的影响范围。
- **“文件的读位能阻止删除。”** 删除主要由父目录权限决定。
- **“用户同时匹配 owner 与 other，可以取更宽权限。”** POSIX 会选择特定类别，不合并三组。
- **“检查路径后再打开就安全。”** 对象可能在两步之间变化。
- **“授权缓存越久性能越好。”** 撤销与角色变更会在缓存期内失效，需要明确风险窗口。
- **“审计日志越详细越好。”** 过度记录会泄露新的秘密。

## 14. 纸面练习与答案

### 练习一：对象级授权

接口 `/documents/{id}` 只检查用户拥有 `reader` 角色。两名 reader 是否应能互相读取私有文档？缺少什么检查？

#### 答案

不应默认允许。功能级角色只说明可以使用读取功能，还需检查目标文档的所有者、租户或显式共享关系，即主体对具体客体执行 read 的对象级授权。

### 练习二：POSIX 类别

文件模式为 `0040`，用户恰好是文件所有者，同时也属于文件组。该用户是否因 group 的读位而能读取？

#### 答案

传统 POSIX 判定先匹配所有者并只使用 owner 位。owner 位为 `000`，因此不会再回退使用 group 位，读取被拒绝。

### 练习三：MAC 标签

主体标签为 `(confidential, {A})`，对象标签为 `(confidential, {A, B})`。主体能否读取？

#### 答案

不能。等级相同，但主体类别集合不包含对象要求的 B，因此主体不支配对象。

### 练习四：后台导出

用户发起导出时有权限，任务排队两小时后用户权限被撤销。后台任务是否应继续？

#### 答案

取决于明确业务策略，但不能无意间继续。高敏感系统通常在执行时重新验证当前权限，或使用带范围和短时效的已批准 capability。无论选择哪种，都应记录策略并测试撤销语义。

### 练习五：失败策略

授权服务超时，业务服务为了“可用性”默认放行读取。问题在哪里？

#### 答案

这把基础设施故障变成了权限绕过。敏感访问应失败关闭（fail closed），同时通过冗余、缓存已知安全决策和降级到只读公共内容等方式改善可用性，而不是无条件允许。

## 小结

访问控制不是一个 `is_admin` 布尔值，而是贯穿身份、资源、动作、环境和生命周期的决策系统。可靠设计要求完全中介、默认拒绝、可信属性、最小权限、稳定对象引用和可审计决策；模型越复杂，越需要把策略写成可独立测试的明确函数。

---

[← 上一篇：密码学](./03-cryptography.md) · [本节索引](./README.md) · [下一篇：逆向工程 →](./05-reverse-engineering.md)
