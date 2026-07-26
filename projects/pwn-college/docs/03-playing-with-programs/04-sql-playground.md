# 04 · SQL 练习场：从关系查询到安全参数化

> 对应官方模块：[SQL Playground](https://pwn.college/fundamentals/sql-playground/)

## 学习目标

- 理解表、行、列、主键以及查询结果的关系模型。
- 掌握 <code>SELECT</code>、<code>FROM</code>、<code>WHERE</code>、排序和限制。
- 使用表达式、字符串函数和模式匹配变换结果。
- 用参数化查询分离 SQL 结构与数据，并理解事务和索引的作用。

## SQL 描述“要什么”，数据库决定“怎么取”

关系表可以看作具有固定列定义的一组行。以下查询表示：从 <code>notes</code> 表中选择 owner 为 alice 且优先级至少为 2 的行，只返回指定列，并按优先级降序排列。

~~~sql
SELECT id, body, priority
FROM notes
WHERE owner = 'alice' AND priority >= 2
ORDER BY priority DESC, id ASC;
~~~

SQL 是声明式语言。查询写出了目标集合，数据库的查询规划器可选择全表扫描、索引查找或其他执行方案。没有 <code>ORDER BY</code> 时，结果顺序通常没有保证，即使某次运行“碰巧按插入顺序”。

## 完整本地示例：SQLite 内存数据库

Python 标准库自带 SQLite 接口。下面程序只创建内存数据库，进程结束后数据消失，不连接任何外部服务。保存为 <code>sql_demo.py</code>：

~~~python
#!/usr/bin/env python3
import sqlite3


def main():
    connection = sqlite3.connect(":memory:")
    connection.execute("PRAGMA foreign_keys = ON")

    with connection:
        connection.execute(
            """
            CREATE TABLE notes (
                id       INTEGER PRIMARY KEY,
                owner    TEXT NOT NULL,
                body     TEXT NOT NULL,
                priority INTEGER NOT NULL CHECK (priority BETWEEN 1 AND 3)
            )
            """
        )
        connection.executemany(
            "INSERT INTO notes(id, owner, body, priority) VALUES (?, ?, ?, ?)",
            [
                (1, "alice", "backup checklist", 3),
                (2, "bob", "grocery list", 1),
                (3, "alice", "rotate local key", 2),
                (4, "chen", "draft outline", 2),
            ],
        )

    owner = "alice"
    minimum = 2
    limit = 10
    rows = connection.execute(
        """
        SELECT id, body, priority
        FROM notes
        WHERE owner = ? AND priority >= ?
        ORDER BY priority DESC, id ASC
        LIMIT ?
        """,
        (owner, minimum, limit),
    )

    print("selected:")
    for row_id, body, priority in rows:
        print(f"{row_id} | {body} | {priority}")

    print("prefixes:")
    for owner_name, prefix in connection.execute(
        "SELECT owner, substr(body, 1, 6) FROM notes ORDER BY id"
    ):
        print(f"{owner_name} | {prefix}")

    tables = connection.execute(
        """
        SELECT name
        FROM sqlite_schema
        WHERE type = ?
        ORDER BY name
        """,
        ("table",),
    )
    print("tables=" + ",".join(name for (name,) in tables))
    connection.close()


if __name__ == "__main__":
    main()
~~~

运行：

~~~bash
python3 sql_demo.py
~~~

预期输出：

~~~text
selected:
1 | backup checklist | 3
3 | rotate local key | 2
prefixes:
alice | backup
bob | grocer
alice | rotate
chen | draft
tables=notes
~~~

注意最后一个 <code>draft </code> 的第六个字符是空格。输出若被编辑器裁掉行尾空格，可把 Python 打印改为 <code>print(repr(prefix))</code> 观察准确内容。

## SELECT 可以计算，而不只复制列

选择列表中的每项都是表达式：

~~~sql
SELECT owner,
       priority * 10 AS score,
       length(body) AS body_length,
       substr(body, 1, 6) AS prefix
FROM notes;
~~~

<code>AS</code> 为结果列命名。SQLite 的 <code>substr</code> 起始位置 1 表示第一个字符；其他数据库的函数名、索引规则和字符串语义可能不同，所以迁移时应查对应数据库文档。

有些表达式不需要读取表：

~~~sql
SELECT 2 + 3 AS total, lower('LOCAL') AS normalized;
~~~

结果是一行 <code>5, local</code>。这有助于单独理解表达式，但生产应用仍应限制可执行的 SQL 来源。

## WHERE：三值逻辑与运算符优先级

<code>WHERE</code> 只保留条件结果为真的行。SQL 中还有 <code>NULL</code>，表示未知或缺失；与 NULL 做普通等值比较通常得到 unknown，而不是 true：

~~~sql
-- 正确检查 NULL
WHERE optional_column IS NULL

-- 不是等价写法
WHERE optional_column = NULL
~~~

<code>AND</code> 的优先级通常高于 <code>OR</code>。为表达意图，复杂条件应主动加括号：

~~~sql
WHERE (owner = ? OR owner = ?) AND priority >= ?
~~~

若没有括号，<code>owner = ? OR owner = ? AND priority >= ?</code> 会先计算后半段 AND，可能让第一个 owner 的低优先级行也通过。

## LIKE、通配符与精确匹配

SQLite 中 <code>LIKE</code> 常用 <code>%</code> 匹配任意长度字符串，用 <code>_</code> 匹配单个字符：

~~~sql
SELECT id, body
FROM notes
WHERE body LIKE 'backup%';
~~~

如果模式来自用户，<code>%</code> 和 <code>_</code> 是数据还是通配符必须由产品语义决定。参数化能防止它变成 SQL 结构，却不会自动把 LIKE 通配符变成普通字符；需要字面匹配时还要按数据库规则转义模式。

## 参数化：把结构和数据分开

下面是应避免的拼接模式，即使调用者“通常只传用户名”也不安全：

~~~python
# 反例：数据被直接放进 SQL 语法。
sql = "SELECT id, body FROM notes WHERE owner = '" + owner + "'"
connection.execute(sql)
~~~

引号和其他 SQL 语法字符会让数据改变语句结构。正确做法是让驱动发送固定 SQL 模板和独立参数：

~~~python
connection.execute(
    "SELECT id, body FROM notes WHERE owner = ?",
    (owner,),
)
~~~

参数不是手工“加反斜杠”后的字符串。驱动按数据库协议和目标类型绑定值，因而数据不会被重新解释为列名、运算符或子查询。

占位符通常只能替代值，不能替代表名、列名或 <code>ASC</code>/<code>DESC</code> 等语法。若用户可以选择排序列，应把有限选择映射到代码中的白名单 SQL 片段：

~~~python
allowed_sort = {"priority": "priority", "owner": "owner"}
sort_sql = allowed_sort.get(user_choice, "id")
sql = f"SELECT id, owner FROM notes ORDER BY {sort_sql}"
~~~

这里插入 SQL 的是开发者定义的固定片段，不是原始用户文本；查询值仍应参数化。

## 排序、限制与稳定分页

<code>LIMIT</code> 限制返回行数，但必须配合明确排序才有稳定含义。若多个行的 priority 相同，只写 <code>ORDER BY priority DESC</code> 仍可能在这些行之间产生不稳定顺序；追加唯一主键 <code>id ASC</code> 可作为确定的决胜条件。

很大的偏移分页可能越来越慢，而且并发插入会造成重复或遗漏。实际系统常使用上一页最后一个排序键继续查询的“游标式分页”。无论哪种方式，客户端请求的 limit 都应有服务器端上限。

## 模式元数据

SQLite 将表、索引、视图和触发器的模式信息暴露在 <code>sqlite_schema</code> 中；旧名称 <code>sqlite_master</code> 仍常见。示例只查询表名：

~~~sql
SELECT name
FROM sqlite_schema
WHERE type = 'table'
ORDER BY name;
~~~

元数据可帮助理解数据库结构，但是否允许某个应用用户读取模式信息，应由真实系统的权限策略决定。不同数据库产品使用不同系统目录和授权模型。

## 事务保证一组变化的边界

转账、库存扣减或多表更新不能只保证每条语句单独成功；相关语句应位于事务中，要么整体提交，要么失败回滚。Python sqlite3 的 <code>with connection:</code> 在正常离开时提交，异常时回滚。

事务并不自动解决所有并发逻辑。应用仍需选择合适隔离级别、约束和更新条件。数据库约束如 <code>NOT NULL</code>、<code>UNIQUE</code>、<code>CHECK</code> 和外键能在所有写入路径上守住基本不变量，比只在某个界面验证更可靠。

## 索引的取舍

索引按列值维护额外数据结构，可减少特定查询扫描的行数，但会占空间并增加写入成本。应根据真实查询模式建立，例如经常按 owner 和 priority 过滤时可评估组合索引：

~~~sql
CREATE INDEX notes_owner_priority
ON notes(owner, priority DESC);
~~~

使用 <code>EXPLAIN QUERY PLAN</code> 查看 SQLite 选择的方案，再用现实数据量测量。索引不是越多越好，列顺序也会影响哪些过滤和排序能受益。

## 常见误区

- **没有 ORDER BY 却依赖当前行顺序。** 物理布局和执行计划都可能改变。
- **用 <code>= NULL</code> 检查空值。** 应使用 <code>IS NULL</code>。
- **把转义字符串当成参数化查询。** 应使用驱动的绑定接口。
- **认为参数占位符能替代表名或排序关键字。** 结构性选择应映射到白名单片段。
- **忽略 AND/OR 优先级。** 用括号直接表达业务逻辑。
- **只在应用代码校验数据。** 关键不变量还应由数据库约束保护。
- **把索引当免费加速。** 它增加存储与写入成本，需要用查询计划验证。

## 纸面练习

使用示例数据，查询：

~~~sql
SELECT id
FROM notes
WHERE owner = 'alice' OR owner = 'bob' AND priority >= 2
ORDER BY id;
~~~

会返回哪些 id？若本意是“owner 为 alice 或 bob，并且 priority 至少为 2”，应如何改写？再说明为什么把两个 owner 和最低优先级作为参数绑定不会改变 AND/OR 结构。

### 答案

AND 先计算，所以条件等价于 <code>owner='alice' OR (owner='bob' AND priority&gt;=2)</code>。两条 alice 记录 id 1、3 都通过；bob 的 id 2 优先级为 1，不通过，因此结果为 1、3。预期逻辑应写成 <code>WHERE (owner = ? OR owner = ?) AND priority &gt;= ?</code>，参数为 alice、bob、2。绑定参数只填入值位置，数据库不会把值内容重新解析为运算符或括号，因此语句结构保持固定。

## 小结

SQL 的力量来自集合表达与数据库约束。写出明确过滤、稳定排序和事务边界；把所有外部值参数化；对结构性选择使用白名单，才能让查询既清晰又安全。

---

[← 上一篇：程序误用与最小权限](./03-program-misuse.md) · [本节索引](./README.md) · [下一模块：Intro to Cybersecurity →](../04-intro-to-cybersecurity/README.md)
