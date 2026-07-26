# 11 · 文件权限

> 对应官方模块：[Perceiving Permissions](https://pwn.college/linux-luminarium/permissions/)

## 学习目标

- 解释所有者、组、其他用户三组 `rwx` 位。
- 区分普通文件与目录上读、写、执行位的语义。
- 理解 `chmod`、八进制模式和 `umask` 的基本关系。

## 权限判定的三个类别

传统 Unix 模式先根据进程有效身份选择一个类别：若 UID 等于文件所有者，使用 owner 位；否则若进程属于文件组，使用 group 位；否则使用 other 位。不是把三类权限相加。ACL、能力、只读挂载和安全模块还可能增加额外约束。

对普通文件：`r` 允许读内容，`w` 允许修改内容，`x` 允许作为程序执行。对目录：`r` 允许列出名字，`w` 允许增删目录项，`x` 允许穿越并访问其中已知名字。删除文件主要取决于父目录权限，而不是文件自身的写位。

## 安全示例：观察模式变化

```bash
perm_dir=$(mktemp -d)
printf 'private note\n' > "$perm_dir/note.txt"
chmod 640 "$perm_dir/note.txt"
stat -c '%a %A %n' "$perm_dir/note.txt"
rm -r -- "$perm_dir"
```

预期输出形态：

```text
640 -rw-r----- /tmp/tmp.xxxx/note.txt
```

八进制每位由 `r=4`、`w=2`、`x=1` 相加：`6` 是 owner 读写，`4` 是 group 只读，`0` 是 other 无权限。`chmod` 改变已有对象；`umask` 则在创建时从程序请求的权限中屏蔽位。

例如程序请求创建模式 `666`，若 `umask` 为 `022`，常见结果是 `644`：

```text
0666 & ~0022 = 0644
```

普通文件通常不会因 `umask` 自动获得执行位，因为创建程序本来就没有请求它。

## 符号模式与数字模式

数字模式适合一次设定完整结果；符号模式适合表达增量：

~~~bash
mode_dir=$(mktemp -d)
printf 'demo\n' > "$mode_dir/item"
chmod u=rw,g=r,o= "$mode_dir/item"
chmod g+w "$mode_dir/item"
stat -c '%a %A %n' "$mode_dir/item"
rm -r -- "$mode_dir"
~~~

预期最终模式为 <code>660 -rw-rw----</code>。符号语法中：

- <code>u/g/o/a</code> 选择 owner、group、other、all；
- <code>+</code> 添加、<code>-</code> 删除、<code>=</code> 精确替换；
- <code>r/w/x</code> 表示相应权限。

在安全自动化中，<code>=</code> 常比连续加减更容易证明最终状态。chmod 不改变所有者；<code>chown</code> 改 UID/GID，<code>chgrp</code> 只改组。普通用户能否改变所有者/组受系统策略限制，不应默认命令会成功。

## 路径权限是逐级检查

读取 <code>/a/b/file</code> 不只看 file：

~~~text
/      需要可穿越
/a     需要可穿越
/a/b   需要可穿越
file   需要读取
~~~

列出 <code>/a/b</code> 的名字需要目录读权限；访问已知名字需要执行（穿越）权限。可以用 <code>namei -l path</code>（若系统提供）逐分量观察模式与所有者。

父目录可写意味着目录项可被替换。即便 file 为 0444，能写父目录的人也可能删除它并创建同名新对象；依赖路径的高权限程序必须考虑这一点。

## setuid 与 setgid

普通可执行文件设置 setuid 位后，内核执行时可让进程 effective UID 变为文件所有者；setgid 类似地影响组身份。显示形式中，owner/group 的执行位位置可能出现 <code>s</code>：

~~~text
-rwsr-xr-x  owner root  ...
~~~

这是一条非常强的信任边界：

- 程序必须把 argv、环境、文件描述符、信号和工作目录视为不可信；
- 权限检查要基于真实调用者和目标对象；
- 使用固定可信 PATH，避免 shell；
- 尽早永久降权；
- 开启编译加固并做专门审计；
- 不把可写脚本或插件置于高权限加载路径；
- 挂载选项 nosuid 可在特定文件系统忽略这些位。

Linux 通常不按普通方式对解释器脚本兑现 setuid，原因之一是脚本打开与解释器执行间的竞态。不要尝试用 setuid shell 脚本实现提权服务；应设计窄小、可审计的代理接口。

## 目录上的 setgid 与 sticky bit

目录的特殊位含义不同：

- setgid 目录：新建对象通常继承目录组，便于团队共享；
- sticky 目录：即使目录对多人可写，删除/重命名还受对象所有者、目录所有者等限制；<code>/tmp</code> 常见。

可在自有目录安全观察 setgid：

~~~bash
shared=$(mktemp -d)
chmod 2770 "$shared"
mkdir "$shared/child"
stat -c '%a %A %G %n' "$shared" "$shared/child"
rm -r -- "$shared"
~~~

父目录会显示 setgid 位；子目录通常继承组，并可能继承 setgid。实际组名依当前用户。

sticky bit 不是“只有所有者能读”，也不防止创建同名竞争或读取宽权限文件；它只改变多人可写目录中的删除/重命名规则。

## ACL 与其他权限层

POSIX ACL 可为特定用户/组增加条目，<code>ls -l</code> 的模式后常用 <code>+</code> 提示存在扩展 ACL。<code>getfacl</code> 可查看，ACL mask 会限制命名用户/组条目的有效权限。

最终访问还可能受：

- 只读挂载、nosuid、noexec；
- Linux capabilities；
- SELinux、AppArmor 等 LSM；
- NFS/root-squash 与远端服务器；
- 容器 user namespace 映射；
- 文件加密和应用级授权。

“chmod 显示允许”只是 DAC 层的一部分；“chmod 显示拒绝”也不代表持有更强 capability 的进程一定被拒绝。

## 安全视角

目录可写意味着用户可能替换其中的名字，即使目标文件本身不可写。安全程序不应在他人可写目录中按可预测名字创建敏感文件；应使用原子创建、合理模式和可信目录。权限过宽与“先创建、后收紧”之间还可能存在短暂暴露窗口。

## 常见误区

- **认为数字 `7` 是十进制权限。** 它是 `4+2+1` 的位组合。
- **认为文件不可写就不能删除。** 删除由父目录的写与执行权限控制。
- **给目录读权限就一定能访问文件。** 没有执行位不能穿越目录。
- **习惯使用 `chmod 777`。** 这会同时授予所有人读、写、执行，通常远超需要。

## 纸面练习

目录模式为 `711`，其中某文件名已知。其他用户能否列出目录全部名字？若文件自身允许读取，他们能否沿已知名字访问它？

### 答案

other 只有执行位，没有读位，因此不能列出目录内容；但执行位允许穿越。如果文件名已知且路径上其他目录也允许穿越，最终文件权限又允许读取，则可以访问该文件。

## 小结

权限必须结合对象类型和路径逐级分析。对目录来说，读是列名、写是改目录项、执行是穿越；这与普通文件的 `rwx` 语义不同。

---

[← 上一篇：用户与身份](./10-untangling-users.md) · [本节索引](./README.md) · [下一篇：命令串联 →](./12-chaining-commands.md)
