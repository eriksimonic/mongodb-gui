# T-SQL to mongosh translation

## What it is

The editor's SQL mode translates each T-SQL statement into one mongosh statement and runs that statement. The generated mongosh is shown to the user, so the user can read exactly what the database receives. The translation runs in one direction only: T-SQL goes in, mongosh comes out, and nothing converts mongosh back. The code is in `packages/core/src/sql`. `translateSql` in `index.ts` returns one result per statement, each with either the mongosh text or an error and the span to underline. The editor integration is not part of this module yet.

## Supported statements

Statements end at a `;` or at a `GO` on a line of its own. A statement that fails does not stop the others. Comments are ignored. Keywords are case-insensitive, and names keep the case they are written with. String literals use single quotes, with `''` for a quote inside. The `N` prefix is accepted.

```sql
SELECT [DISTINCT] [TOP n | TOP (n)] column_list
FROM [dbo.]table [AS] [alias]
[{INNER | LEFT [OUTER]} JOIN [dbo.]table [AS] [alias] ON column = column] ...
[WHERE condition]
[GROUP BY expression [, ...]]
[HAVING condition]
[ORDER BY expression [ASC | DESC] [, ...]]
[OFFSET n ROWS [FETCH {NEXT | FIRST} n ROWS ONLY]]

UPDATE [dbo.]table SET column = expression [, ...] [WHERE condition]
DELETE [FROM] [dbo.]table [WHERE condition]
INSERT [INTO] [dbo.]table (column [, ...]) VALUES (value [, ...]) [, (value [, ...])] ...
TRUNCATE TABLE [dbo.]table
```

A SELECT needs a FROM clause. `JOIN` alone means `INNER JOIN`. The `ON` clause must be one `=` between a column of the joined table and a column of a table that the query already uses. The column list takes `*`, `alias.*`, a column, or an expression. Each item can have an alias written as `AS name`, as a bare name, or as `name = expression`.

## How names map

- Tables are collections. `FROM orders` reads `db.orders`. A name that mongosh cannot read as a property, such as one that starts with `_` or contains `-`, and a name that matches a `Database` member such as `getCollection`, becomes `db.getCollection('name')`.
- Columns are fields. `total` reads the `total` field.
- A dotted name is a path into nested documents. `address.city` reads `city` inside `address`.
- A first part that matches the table alias, or the table name when the table has no alias, is dropped. `FROM orders AS o` makes `o.total` the field `total`. Any other first part stays in the path, so `a.b` reads the nested path `a.b`.
- In a join, the alias of the joined table selects its columns. `c.name` reads the `name` field of the joined document.
- Brackets and double quotes wrap a name that has spaces or is a reserved word. `[Order Id]` reads the field `Order Id`. Reserved words such as `ORDER` and `TABLE` need brackets. A name part cannot start with `$` or contain a dot, even inside brackets.
- The `dbo.` prefix is dropped, so `dbo.orders` reads `orders`. Any other schema or database prefix is refused. Temporary tables, such as `#work`, are refused.
- An explicit alias gives an output its name. Otherwise a column keeps its last part, a function call gets its lowercase name followed by its first column when that is a column (`COUNT(city)` gives `count_city`, and `COUNT(*)` gives `count`), and any other expression gets `expr_` and its position in the select list. Explicit aliases claim their names first. A repeated name gets `2`, `3` and so on appended.
- A `find` leaves out `_id` unless the column list names it. An aggregate also drops `_id`, except when the list has `*`.

## How a SELECT becomes find or aggregate

A SELECT becomes a `find` when it has no join, GROUP BY, HAVING or DISTINCT, when each column is `*`, the base table's `alias.*`, or a column with no alias, and when each ORDER BY item is a column. Any other SELECT becomes an `aggregate` pipeline.

A `find` has this form: `db.orders.find(filter, projection).sort(...).skip(n).limit(n)`. The WHERE clause becomes the filter. The column list becomes the projection, and a `*` list has no projection. ORDER BY, OFFSET and the row limit become `.sort`, `.skip` and `.limit`. The limit comes from FETCH when it is present and from TOP otherwise.

An `aggregate` runs its stages in this order:

1. A `$match` with the WHERE conditions that use only fields of the base table.
2. A `$lookup` and an `$unwind` for each join, in the order written. An INNER JOIN unwinds without keeping unmatched rows, and a LEFT JOIN unwinds with `preserveNullAndEmptyArrays`.
3. A `$match` with the WHERE conditions that use joined fields.
4. For grouping, a `$group`, then a `$match` for HAVING, then an `$addFields` that replaces a COUNT(DISTINCT) set with its size when ORDER BY sorts on it. For DISTINCT, a `$group` on the selected expressions. Otherwise no stage.
5. A `$sort`, when it goes before the projection.
6. A `$project`, or an `$addFields` for a `*` list with joins.
7. A `$sort`, when it goes after the projection.
8. A `$skip` for OFFSET.
9. A `$limit` for FETCH or TOP.

The `$sort` goes after `$project` when each ORDER BY item names an output. It goes before `$project` when each item is a field that the projection would drop. Any other mix is refused.

## Operators and expressions

Comparisons between one column and one constant become field conditions in a `find` filter. A constant is a literal, a negated number, GETDATE() or a related function, or a CAST of one of those. When a condition does not fit that shape, such as a comparison between two columns or an arithmetic expression, the filter wraps it in `$expr`. An aggregate uses the aggregation operators directly.

| SQL                                  | In a find filter                            | In an aggregate expression                  |
| ------------------------------------ | ------------------------------------------- | ------------------------------------------- |
| `a = 5`                              | `{ a: 5 }`                                  | `$eq`                                       |
| `a <> 5`, `a != 5`                   | `{ a: { $ne: 5 } }`                         | `$ne`                                       |
| `a < 5`, `a <= 5`, `a > 5`, `a >= 5` | `{ a: { $lt: 5 } }` and so on               | `$lt`, `$lte`, `$gt`, `$gte`                |
| `x AND y`                            | Merged fields, or `$and` when a key repeats | `$and`                                      |
| `x OR y`                             | `$or`                                       | `$or`                                       |
| `NOT x`                              | `$not` around a field operator, else `$nor` | `$not`                                      |
| `a IN (1, 2)`                        | `{ a: { $in: [1, 2] } }`                    | `$in`                                       |
| `a NOT IN (1, 2)`                    | `{ a: { $nin: [1, 2] } }`                   | `$not` around `$in`                         |
| `a BETWEEN 1 AND 5`                  | `{ a: { $gte: 1, $lte: 5 } }`               | `$and` of `$gte` and `$lte`                 |
| `a IS NULL`                          | `{ a: null }`                               | `$eq` of `$ifNull` with null                |
| `a IS NOT NULL`                      | `{ a: { $ne: null } }`                      | `$ne` of `$ifNull` with null                |
| `a LIKE 'x%'`                        | A regular expression literal                | `$regexMatch`                               |
| `a + b` on numbers                   | `$expr`                                     | `$add`                                      |
| `a + b` when either side is a string | `$expr`                                     | `$concat`                                   |
| `a - b`, `a * b`, `a / b`, `a % b`   | `$expr`                                     | `$subtract`, `$multiply`, `$divide`, `$mod` |
| `-a`                                 | `$expr`                                     | `$multiply` by -1, or a negative literal    |
| `CASE WHEN c THEN t ELSE e END`      | `$expr`                                     | `$switch` with `default` for ELSE           |
| `CASE x WHEN v THEN t ... END`       | `$expr`                                     | `$switch` with `$eq` in each branch         |
| `NULL`, `TRUE`, `FALSE`              | `null`, `true`, `false`                     | `null`, `true`, `false`                     |

A value in a list that is not a constant also moves the condition into `$expr`. An IN list drops its NULL values. `NOT IN` with a NULL in the list is refused, because SQL Server matches no row in that case.

## Functions

| SQL                                                               | MongoDB form                                                                |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `ISNULL(a, b)`                                                    | `$ifNull: [a, b]`                                                           |
| `COALESCE(a, b, ...)`                                             | `$ifNull` with the arguments                                                |
| `NULLIF(a, b)`                                                    | `$cond` that gives null when `$eq` of a and b holds, else a                 |
| `IIF(c, t, f)`                                                    | `$cond: [c, t, f]`                                                          |
| `GETDATE()`, `GETUTCDATE()`, `SYSDATETIME()`, `CURRENT_TIMESTAMP` | `new Date()` in a filter or write, `$$NOW` in an aggregate                  |
| `UPPER(s)`, `LOWER(s)`                                            | `$toUpper`, `$toLower`                                                      |
| `LEN(s)`                                                          | `$strLenCP`                                                                 |
| `LTRIM(s)`, `RTRIM(s)`, `TRIM(s)`                                 | `$ltrim`, `$rtrim`, `$trim` with `input`                                    |
| `SUBSTRING(s, start, length)`                                     | `$substrCP` with `start` minus 1                                            |
| `CONCAT(a, b, ...)`                                               | `$concat`                                                                   |
| `REPLACE(s, find, replacement)`                                   | `$replaceAll`                                                               |
| `ABS(x)`                                                          | `$abs`                                                                      |
| `ROUND(x)`, `ROUND(x, n)`                                         | `$round`, with n defaulting to 0                                            |
| `FLOOR(x)`, `CEILING(x)`                                          | `$floor`, `$ceil`                                                           |
| `YEAR(d)`, `MONTH(d)`, `DAY(d)`                                   | `$year`, `$month`, `$dayOfMonth`                                            |
| `DATEDIFF(unit, start, end)`                                      | `$dateDiff` with `startDate`, `endDate` and `unit`                          |
| `DATEADD(unit, n, d)`                                             | `$dateAdd` with `startDate`, `unit` and `amount`                            |
| `CAST(x AS type)`, `CONVERT(type, x [, style])`                   | A conversion operator, or the folded value when x is a constant (see below) |
| `COUNT(*)`                                                        | `$sum: 1`                                                                   |
| `COUNT(col)`                                                      | `$sum` of 1 for each document where col is not null                         |
| `COUNT(DISTINCT col)`                                             | `$addToSet`, then `$size` of the set                                        |
| `SUM(x)`, `AVG(x)`, `MIN(x)`, `MAX(x)`                            | `$sum`, `$avg`, `$min`, `$max`                                              |

The aggregate functions are allowed only in a grouped query, which is a query with GROUP BY or with an aggregate in the list, HAVING or ORDER BY. `SUM`, `AVG`, `MIN` and `MAX` with DISTINCT are refused. A string literal in a date position, such as the second argument of DATEDIFF, is read as a date.

The unit of DATEDIFF and DATEADD is a bare word or a string. The accepted units are `year` (`yy`, `yyyy`), `quarter` (`qq`, `q`), `month` (`mm`, `m`), `week` (`wk`, `ww`), `day` (`dd`, `d`), `hour` (`hh`), `minute` (`mi`, `n`), `second` (`ss`, `s`) and `millisecond` (`ms`).

CAST and CONVERT accept these types. Length arguments such as `VARCHAR(20)`, `DECIMAL(10, 2)` and `NVARCHAR(MAX)` are read and ignored. The style argument of CONVERT is read and ignored.

| SQL type                                                           | Operator      |
| ------------------------------------------------------------------ | ------------- |
| `INT`, `INTEGER`, `SMALLINT`, `TINYINT`                            | `$toInt`      |
| `BIGINT`                                                           | `$toLong`     |
| `FLOAT`, `REAL`                                                    | `$toDouble`   |
| `DECIMAL`, `NUMERIC`, `MONEY`, `SMALLMONEY`                        | `$toDecimal`  |
| `BIT`                                                              | `$toBool`     |
| `DATE`, `DATETIME`, `DATETIME2`, `SMALLDATETIME`, `DATETIMEOFFSET` | `$toDate`     |
| `VARCHAR`, `NVARCHAR`, `CHAR`, `NCHAR`, `TEXT`, `NTEXT`            | `$toString`   |
| `OBJECTID` (an extension for MongoDB ids)                          | `$toObjectId` |

A cast of a constant is folded at translation time, so `CAST('2026-01-02' AS DATE)` becomes `ISODate('2026-01-02T00:00:00.000Z')`. A cast to an integer type truncates a decimal. A constant cast to DATE drops the time of day. A number cast to DATETIME counts days from 1900-01-01, as SQL Server does. A number cast to DATE is refused.

## LIKE

The pattern must be a string literal. The translator turns it into an anchored regular expression with the `i` flag, so matching ignores case, as the SQL Server default collation does.

- `%` matches any run of characters, and `_` matches one character.
- `[abc]`, `[a-c]`, `[^abc]` and `[]]` are character classes. A bracket with no closing bracket matches a literal `[`.
- `ESCAPE 'c'` names the escape character. The character after it matches literally. `ESCAPE` takes a one-character string.
- A `%` at the start or the end drops its anchor. `'a%'` becomes `/^a/i`, and `'%z%'` becomes `/z/i`. A pattern of only `%` becomes `/.*/i`.
- `NOT LIKE` wraps the regular expression in `$not`.

In a find filter the expression is a regular expression literal on the field. In an aggregate it is `$regexMatch`.

## Writes

UPDATE uses `updateMany`. When every SET value is a constant, the update is a `$set` document. When any value uses a field or an expression, the update is an aggregation pipeline with one `$set` stage, so the value can read the current field. In the pipeline, a constant is written as its value.

```mongosh
db.orders.updateMany({ active: true }, [{ $set: { total: { $multiply: ['$total', 1.1] } } }])
```

A column with a dotted name updates the nested field. Assigning the same column twice, or assigning a column and one of its parents or children, is refused.

DELETE and TRUNCATE TABLE use `deleteMany`. TRUNCATE TABLE is `deleteMany({})`.

INSERT uses one `insertMany` call for all the VALUES rows. The column list is required. Each value must be a constant, which means a literal, a negated number, GETDATE() or a related function, or a cast of one of those. A dotted column name builds a nested document. Each row must have as many values as there are columns.

An UPDATE or DELETE without WHERE, and TRUNCATE TABLE, set the `unsafe` flag on the translation. The SQL mode uses that flag to ask the user to confirm before it runs the statement.

## Type hints from the sampled schema

The translator accepts a `fieldType` lookup that gives the type of a field from the sampled documents: `date`, `objectId`, `number`, `string` or `bool`. The lookup tells the translator how to read a literal that is compared with a field, or assigned to one, in a WHERE clause, an UPDATE or an INSERT.

- A `date` field reads a string literal as a date. The accepted forms are `2026-01-02`, `2026-01-02 10:30`, `2026-01-02T10:30:00.123` with an optional `Z` or offset such as `+01:00`, and the US form `1/2/2026`. A text with no offset is read as UTC. The calendar fields must exist, so February 30 is refused. Any other text is refused with `'<text>' is not a valid date`.
- An `objectId` field reads a 24-digit hexadecimal string as an ObjectId. Other strings stay strings.
- A `number` field reads numeric text as a number, so `total = '5'` compares with 5.
- A `bool` field reads `'true'`, `'false'`, `1` and `0` as booleans.
- A `string` field reads a number as its text.

A CAST or CONVERT to DATE, DATETIME or OBJECTID applies the same rules to the literal on the other side of a comparison. A CAST to DATE also drops the time of day from that literal.

## Not supported

The translator refuses the following constructs. Each message is reported at the span of the construct. Angle brackets stand for the names in the statement.

Statements and clauses:

- `Only SELECT, UPDATE, DELETE, INSERT and TRUNCATE statements are supported`
- `WITH (common table expressions) is not supported`
- `DECLARE is not supported`
- `parameters are not supported`
- `UNION is not supported`, `EXCEPT is not supported` and `INTERSECT is not supported`
- `subqueries are not supported`
- `EXISTS is not supported`
- `window functions (OVER) are not supported`
- `SELECT ... INTO is not supported`
- `TOP ... PERCENT is not supported`
- `WITH TIES is not supported`
- `TOP cannot be combined with OFFSET and FETCH`, raised when a TOP and a FETCH appear in the same statement
- `<TOP or FETCH> 0 returns no rows and cannot be translated`
- `HAVING needs GROUP BY or an aggregate function`
- `DISTINCT cannot be combined with GROUP BY or aggregate functions`
- `SELECT DISTINCT * is not supported`
- `ORDER BY with DISTINCT must name a select column`
- `ORDER BY must name a column, a select alias or an aggregate`
- `ORDER BY cannot combine a select alias with a column that is not in the select list`
- `SELECT * cannot be combined with GROUP BY or aggregate functions`
- `unknown table alias <alias>`

Tables and joins:

- `temporary tables are not supported`
- `table prefix '<prefix>' is not supported, only dbo. is accepted`
- `table hints such as WITH (NOLOCK) are not supported`
- `comma joins are not supported, use JOIN ... ON`
- `RIGHT JOIN is not supported` and `FULL JOIN is not supported`
- `CROSS JOIN is not supported` and `CROSS APPLY is not supported`
- `OUTER APPLY is not supported`
- `JOIN ... ON must compare one column of each table with =`
- `<alias> is a table alias, not a column`
- `column name <part> may not start with $`
- `column name part <part> may not contain a dot`
- `column name is empty`

Grouping and aggregates:

- `GROUP BY ROLLUP is not supported`, `GROUP BY CUBE is not supported` and `GROUP BY GROUPING SETS is not supported`
- `column <name> must appear in GROUP BY or inside an aggregate function`
- `aggregate functions need GROUP BY`
- `aggregate functions cannot be nested`
- `aggregate functions cannot be used in GROUP BY`
- `<SUM, AVG, MIN or MAX>(DISTINCT) is not supported`
- `<COUNT, SUM, AVG, MIN or MAX> takes 1 argument`

Functions, types and literals:

- `function <name> is not supported`
- `<name> takes <n> argument` or `<name> takes <n> arguments`, `<name> takes at least <n> arguments`, and `<name> takes <n> or <m> arguments`
- `<DATEDIFF or DATEADD> unit must be year, quarter, month, week, day, hour, minute, second or millisecond`
- `type '<name>' is not supported`
- `LIKE pattern must be a string literal`
- `expected a one character string after ESCAPE but found '<text>'`
- `IN needs at least one value`
- `NOT IN with NULL matches no row in SQL Server, remove the NULL from the list`
- `the floating point value is out of range`
- `'<text>' is not a valid date` and `not a valid date`
- `not a valid number`
- `not a valid bit`
- `not a valid ObjectId: expected 24 hex characters`
- `a number cannot be cast to DATE, cast it to DATETIME`

Writes:

- `INSERT ... SELECT is not supported`
- `INSERT needs a column list before VALUES`
- `INSERT column <name> is listed twice` and `INSERT column <name> overlaps another column`
- `INSERT row has <n> values for <m> columns`
- `INSERT values must be literals`
- `UPDATE with TOP is not supported` and `UPDATE ... FROM is not supported`
- `UPDATE column <name> is assigned twice` and `UPDATE column <name> overlaps another column`
- `DELETE with TOP is not supported` and `DELETE with JOIN is not supported`

Syntax and input:

- `the statement is empty`
- `unexpected '<text>' after the statement`
- `expected <what> but found '<text>'` and `expected <what> but the statement ended`, for any other syntax error. `SELECT 1 AS x` gives `expected FROM but the statement ended`.
- `keyword <WORD> cannot be used as a name, write [<word>]`
- `unterminated string`, `unterminated block comment`, `unterminated bracketed identifier` and `unterminated quoted identifier`
- `unexpected character '<character>'`
- `an identifier cannot be empty`

## Differences from SQL Server

- `= NULL` matches the documents where the field is null or missing, which is the `IS NULL` form. `<> NULL` is `IS NOT NULL`. SQL Server matches no row for either comparison. `IS NULL` also matches missing fields.
- `<>`, `!=` and `NOT` match documents where the field is null or missing. SQL Server leaves out rows where the column is NULL.
- `/` on two integers returns a fraction, because `$divide` does not truncate. `5 / 2` gives 2.5, and SQL Server gives 2.
- COUNT(*) over no rows returns no row. SQL Server returns one row with 0. The other aggregates with no GROUP BY behave the same way.
- Text equality, `IN`, GROUP BY and DISTINCT compare text exactly, so `'a'` and `'A'` differ. LIKE ignores case. The SQL Server default collation ignores case in all of these.
- ORDER BY on text uses MongoDB's default binary comparison, so `'B'` sorts before `'a'`. The SQL Server default collation sorts `'a'` before `'B'`.
- CONCAT returns null when an argument is null. SQL Server's CONCAT treats a NULL argument as an empty string.
- GETDATE() and its related functions return the current instant as a Date. SQL Server returns the server's local time.

## Examples

### Filtered find with sort and TOP

```sql
SELECT TOP 5 name, total FROM dbo.orders WHERE status = 'open' AND total > 100 ORDER BY total DESC;
```

```mongosh
db.orders.find({ status: 'open', total: { $gt: 100 } }, { _id: 0, name: 1, total: 1 }).sort({ total: -1 }).limit(5)
```

### Join

```sql
SELECT o.order_no, c.name FROM orders AS o LEFT JOIN customers AS c ON c.id = o.customer_id ORDER BY o.order_no;
```

```mongosh
db.orders.aggregate([
  { $lookup: { from: 'customers', localField: 'customer_id', foreignField: 'id', as: 'c' } },
  { $unwind: { path: '$c', preserveNullAndEmptyArrays: true } },
  { $project: { _id: 0, order_no: 1, name: '$c.name' } },
  { $sort: { order_no: 1 } }
])
```

### Group with HAVING

```sql
SELECT customer_id, COUNT(*) AS orders, SUM(total) AS revenue FROM orders GROUP BY customer_id HAVING COUNT(*) > 2 ORDER BY revenue DESC;
```

```mongosh
db.orders.aggregate([
  { $group: { _id: '$customer_id', orders: { $sum: 1 }, revenue: { $sum: '$total' } } },
  { $match: { orders: { $gt: 2 } } },
  { $project: { _id: 0, customer_id: '$_id', orders: 1, revenue: 1 } },
  { $sort: { revenue: -1 } }
])
```

### CASE projection

```sql
SELECT name, CASE WHEN total >= 1000 THEN 'large' WHEN total >= 100 THEN 'medium' ELSE 'small' END AS size FROM orders;
```

```mongosh
db.orders.aggregate([
  { $project: { _id: 0, name: 1, size: { $switch: { branches: [{ case: { $gte: ['$total', 1000] }, then: 'large' }, { case: { $gte: ['$total', 100] }, then: 'medium' }], default: 'small' } } } }
])
```

### UPDATE

```sql
UPDATE orders SET status = 'closed', closed_at = GETDATE() WHERE status = 'open';
```

```mongosh
db.orders.updateMany({ status: 'open' }, { $set: { status: 'closed', closed_at: new Date() } })
```
