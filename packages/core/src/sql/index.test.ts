import { describe, expect, it } from 'vitest';
import {
  SqlError,
  isMongoSpecial,
  mongoDate,
  mongoNow,
  mongoObjectId,
  mongoRegex,
  splitSqlStatements,
  translateSql,
  translateSqlStatement,
  type SqlTranslationResult,
  type TranslateOptions,
} from './index';
import { translateSql as fromCoreIndex } from '../index';

/** Translates text that holds one statement and returns its mongosh text. Fails the test otherwise. */
function run(sql: string, options?: TranslateOptions): string {
  const results = translateSql(sql, options);
  expect(results).toHaveLength(1);
  const [result] = results;
  if (!result || !result.ok) {
    throw new Error(`expected a translation but got ${JSON.stringify(result)}`);
  }
  return result.translation.mongosh;
}

/** Translates text that holds one failing statement and returns the message and the span text. */
function fail(sql: string, options?: TranslateOptions): { message: string; at: string } {
  const results = translateSql(sql, options);
  expect(results).toHaveLength(1);
  const [result] = results;
  if (!result || result.ok) {
    throw new Error(`expected an error but got ${JSON.stringify(result)}`);
  }
  return {
    message: result.error.message,
    at: sql.slice(result.error.span.start, result.error.span.end),
  };
}

function pipeline(collection: string, stages: readonly string[]): string {
  return `db.${collection}.aggregate([\n${stages.map((stage) => `  ${stage}`).join(',\n')}\n])`;
}

describe('translateSql spec examples', () => {
  it('translates a filtered, sorted and limited find', () => {
    const sql = `SELECT TOP 20 name, address.city, total FROM orders
WHERE status = 'shipped' AND total >= 100 AND customer.email LIKE '%@gmail.com' ORDER BY total DESC;`;
    expect(run(sql)).toBe(
      "db.orders.find({ status: 'shipped', total: { $gte: 100 }, 'customer.email': /@gmail\\.com$/i }, { _id: 0, name: 1, 'address.city': 1, total: 1 }).sort({ total: -1 }).limit(20)",
    );
  });

  it('translates a grouped query with HAVING and a sort on an alias', () => {
    const sql = `SELECT customer.id AS customer, COUNT(*) AS orders, SUM(total) AS revenue FROM orders
WHERE createdAt >= CAST('2026-01-01' AS DATE) GROUP BY customer.id HAVING SUM(total) > 1000 ORDER BY revenue DESC;`;
    expect(run(sql)).toBe(`db.orders.aggregate([
  { $match: { createdAt: { $gte: ISODate('2026-01-01T00:00:00.000Z') } } },
  { $group: { _id: '$customer.id', orders: { $sum: 1 }, revenue: { $sum: '$total' } } },
  { $match: { revenue: { $gt: 1000 } } },
  { $project: { _id: 0, customer: '$_id', orders: 1, revenue: 1 } },
  { $sort: { revenue: -1 } }
])`);
  });

  it('translates an inner join with a match on the base collection', () => {
    const sql =
      'SELECT o.orderId, o.total, c.name, c.email FROM orders o INNER JOIN customers c ON o.customerId = c._id WHERE o.total > 500;';
    expect(run(sql)).toBe(`db.orders.aggregate([
  { $match: { total: { $gt: 500 } } },
  { $lookup: { from: 'customers', localField: 'customerId', foreignField: '_id', as: 'c' } },
  { $unwind: '$c' },
  { $project: { _id: 0, orderId: 1, total: 1, name: '$c.name', email: '$c.email' } }
])`);
  });

  it('translates an update with a date cast and GETDATE()', () => {
    const sql =
      "UPDATE orders SET status = 'archived', archivedAt = GETDATE() WHERE createdAt < CAST('2025-01-01' AS DATE);";
    expect(run(sql)).toBe(
      "db.orders.updateMany({ createdAt: { $lt: ISODate('2025-01-01T00:00:00.000Z') } }, { $set: { status: 'archived', archivedAt: new Date() } })",
    );
  });
});

describe('translateSql find shape', () => {
  it.each<[string, string]>([
    ['SELECT * FROM orders', 'db.orders.find({})'],
    ['select * from dbo.orders', 'db.orders.find({})'],
    ['SELECT * FROM [orders]', 'db.orders.find({})'],
    ['SELECT * FROM "orders"', 'db.orders.find({})'],
    ['SELECT * FROM [my orders]', "db.getCollection('my orders').find({})"],
    ['SELECT * FROM stats', "db.getCollection('stats').find({})"],
    ['SELECT * FROM _private', "db.getCollection('_private').find({})"],
    ['SELECT name FROM orders', 'db.orders.find({}, { _id: 0, name: 1 })'],
    ['SELECT _id, name FROM orders', 'db.orders.find({}, { _id: 1, name: 1 })'],
    ['SELECT name, email FROM orders o', 'db.orders.find({}, { _id: 0, name: 1, email: 1 })'],
    ['SELECT o.name FROM orders o', 'db.orders.find({}, { _id: 0, name: 1 })'],
    ['SELECT orders.name FROM orders', 'db.orders.find({}, { _id: 0, name: 1 })'],
    ['SELECT address.city FROM orders', "db.orders.find({}, { _id: 0, 'address.city': 1 })"],
    ['SELECT [name], "email" FROM orders', 'db.orders.find({}, { _id: 0, name: 1, email: 1 })'],
    ['SELECT [select] FROM orders', 'db.orders.find({}, { _id: 0, select: 1 })'],
    ['SELECT x.name FROM orders o', "db.orders.find({}, { _id: 0, 'x.name': 1 })"],
    ['SELECT TOP 5 * FROM orders', 'db.orders.find({}).limit(5)'],
    ['SELECT TOP (5) * FROM orders', 'db.orders.find({}).limit(5)'],
    ['SELECT * FROM orders ORDER BY name', 'db.orders.find({}).sort({ name: 1 })'],
    [
      'SELECT * FROM orders ORDER BY name ASC, total DESC',
      'db.orders.find({}).sort({ name: 1, total: -1 })',
    ],
    [
      'SELECT * FROM orders ORDER BY address.city DESC',
      "db.orders.find({}).sort({ 'address.city': -1 })",
    ],
    [
      'SELECT * FROM orders ORDER BY name OFFSET 10 ROWS',
      'db.orders.find({}).sort({ name: 1 }).skip(10)',
    ],
    [
      'SELECT * FROM orders ORDER BY name OFFSET 10 ROWS FETCH NEXT 5 ROWS ONLY',
      'db.orders.find({}).sort({ name: 1 }).skip(10).limit(5)',
    ],
    [
      'SELECT * FROM orders ORDER BY name OFFSET 0 ROWS FETCH FIRST 5 ROWS ONLY',
      'db.orders.find({}).sort({ name: 1 }).skip(0).limit(5)',
    ],
    [
      'SELECT TOP 5 name FROM orders WHERE total > 1 ORDER BY name',
      'db.orders.find({ total: { $gt: 1 } }, { _id: 0, name: 1 }).sort({ name: 1 }).limit(5)',
    ],
    ['SELECT * FROM orders -- a comment\nWHERE total > 1', 'db.orders.find({ total: { $gt: 1 } })'],
    ['SELECT * /* block */ FROM orders', 'db.orders.find({})'],
    ['  SELECT *\r\nFROM orders\r\n', 'db.orders.find({})'],
  ])('%s', (sql, mongosh) => {
    expect(run(sql)).toBe(mongosh);
  });
});

describe('translateSql WHERE filters', () => {
  it.each<[string, string]>([
    ["SELECT * FROM orders WHERE status = 'shipped'", "db.orders.find({ status: 'shipped' })"],
    ["SELECT * FROM orders WHERE 'shipped' = status", "db.orders.find({ status: 'shipped' })"],
    ['SELECT * FROM orders WHERE total <> 5', 'db.orders.find({ total: { $ne: 5 } })'],
    ['SELECT * FROM orders WHERE total != 5', 'db.orders.find({ total: { $ne: 5 } })'],
    ['SELECT * FROM orders WHERE total < 5', 'db.orders.find({ total: { $lt: 5 } })'],
    ['SELECT * FROM orders WHERE total <= 5', 'db.orders.find({ total: { $lte: 5 } })'],
    ['SELECT * FROM orders WHERE total > 5', 'db.orders.find({ total: { $gt: 5 } })'],
    ['SELECT * FROM orders WHERE total >= 5', 'db.orders.find({ total: { $gte: 5 } })'],
    ['SELECT * FROM orders WHERE 5 < total', 'db.orders.find({ total: { $gt: 5 } })'],
    ['SELECT * FROM orders WHERE total > -1', 'db.orders.find({ total: { $gt: -1 } })'],
    ['SELECT * FROM orders WHERE total = 1.5', 'db.orders.find({ total: 1.5 })'],
    ['SELECT * FROM orders WHERE total = .5', 'db.orders.find({ total: 0.5 })'],
    ['SELECT * FROM orders WHERE total = 1e3', 'db.orders.find({ total: 1000 })'],
    ['SELECT * FROM orders WHERE active = TRUE', 'db.orders.find({ active: true })'],
    ['SELECT * FROM orders WHERE active = false', 'db.orders.find({ active: false })'],
    ["SELECT * FROM orders WHERE note = N'it''s'", "db.orders.find({ note: 'it\\'s' })"],
    ["SELECT * FROM orders WHERE note = 'a\\b'", "db.orders.find({ note: 'a\\\\b' })"],
    ['SELECT * FROM orders WHERE status IS NULL', 'db.orders.find({ status: null })'],
    ['SELECT * FROM orders WHERE status IS NOT NULL', 'db.orders.find({ status: { $ne: null } })'],
    [
      "SELECT * FROM orders WHERE status IN ('a', 'b')",
      "db.orders.find({ status: { $in: ['a', 'b'] } })",
    ],
    [
      "SELECT * FROM orders WHERE status NOT IN ('a', 'b')",
      "db.orders.find({ status: { $nin: ['a', 'b'] } })",
    ],
    [
      'SELECT * FROM orders WHERE total IN (1, 2, 3)',
      'db.orders.find({ total: { $in: [1, 2, 3] } })',
    ],
    [
      'SELECT * FROM orders WHERE total BETWEEN 1 AND 10',
      'db.orders.find({ total: { $gte: 1, $lte: 10 } })',
    ],
    [
      'SELECT * FROM orders WHERE total NOT BETWEEN 1 AND 10',
      'db.orders.find({ total: { $not: { $gte: 1, $lte: 10 } } })',
    ],
    [
      "SELECT * FROM orders WHERE status = 'a' AND total > 1",
      "db.orders.find({ status: 'a', total: { $gt: 1 } })",
    ],
    [
      "SELECT * FROM orders WHERE status = 'a' OR total > 1",
      "db.orders.find({ $or: [{ status: 'a' }, { total: { $gt: 1 } }] })",
    ],
    [
      "SELECT * FROM orders WHERE (status = 'a' OR status = 'b') AND total > 1",
      "db.orders.find({ $or: [{ status: 'a' }, { status: 'b' }], total: { $gt: 1 } })",
    ],
    [
      'SELECT * FROM orders WHERE total > 1 AND total < 10',
      'db.orders.find({ $and: [{ total: { $gt: 1 } }, { total: { $lt: 10 } }] })',
    ],
    ["SELECT * FROM orders WHERE NOT status = 'a'", "db.orders.find({ $nor: [{ status: 'a' }] })"],
    ['SELECT * FROM orders WHERE NOT total > 1', 'db.orders.find({ total: { $not: { $gt: 1 } } })'],
    [
      "SELECT * FROM orders WHERE NOT (status = 'a' OR total > 1)",
      "db.orders.find({ $nor: [{ $or: [{ status: 'a' }, { total: { $gt: 1 } }] }] })",
    ],
    [
      "SELECT * FROM orders WHERE total > 1 AND status = 'a' AND name = 'b'",
      "db.orders.find({ total: { $gt: 1 }, status: 'a', name: 'b' })",
    ],
    [
      'SELECT * FROM orders WHERE total > qty',
      "db.orders.find({ $expr: { $gt: ['$total', '$qty'] } })",
    ],
    [
      'SELECT * FROM orders WHERE total * 2 > 10',
      "db.orders.find({ $expr: { $gt: [{ $multiply: ['$total', 2] }, 10] } })",
    ],
    [
      'SELECT * FROM orders WHERE YEAR(createdAt) = 2026',
      "db.orders.find({ $expr: { $eq: [{ $year: '$createdAt' }, 2026] } })",
    ],
    [
      'SELECT * FROM orders WHERE ISNULL(total, 0) > 1',
      "db.orders.find({ $expr: { $gt: [{ $ifNull: ['$total', 0] }, 1] } })",
    ],
    [
      "SELECT * FROM orders WHERE createdAt > CAST('2026-01-01' AS DATE)",
      "db.orders.find({ createdAt: { $gt: ISODate('2026-01-01T00:00:00.000Z') } })",
    ],
    [
      "SELECT * FROM orders WHERE createdAt > CAST('2026-01-01T10:00:00Z' AS DATETIME)",
      "db.orders.find({ createdAt: { $gt: ISODate('2026-01-01T10:00:00.000Z') } })",
    ],
    [
      "SELECT * FROM orders WHERE createdAt >= CAST('2026-03-01T12:00:00' AS DATETIME)",
      "db.orders.find({ createdAt: { $gte: ISODate('2026-03-01T12:00:00.000Z') } })",
    ],
    [
      "SELECT * FROM orders WHERE createdAt >= CONVERT(DATETIME2, '2026-03-01 12:00', 120)",
      "db.orders.find({ createdAt: { $gte: ISODate('2026-03-01T12:00:00.000Z') } })",
    ],
    [
      "SELECT * FROM orders WHERE createdAt >= CAST('2026-03-01 12:00:00+02:00' AS DATETIMEOFFSET)",
      "db.orders.find({ createdAt: { $gte: ISODate('2026-03-01T10:00:00.000Z') } })",
    ],
    [
      "SELECT * FROM orders WHERE createdAt = CAST('2024-02-29' AS DATE)",
      "db.orders.find({ createdAt: ISODate('2024-02-29T00:00:00.000Z') })",
    ],
    [
      "SELECT * FROM orders WHERE createdAt > CONVERT(DATETIME, '2026-01-01', 120)",
      "db.orders.find({ createdAt: { $gt: ISODate('2026-01-01T00:00:00.000Z') } })",
    ],
    [
      "SELECT * FROM orders WHERE _id = CAST('507f1f77bcf86cd799439011' AS OBJECTID)",
      "db.orders.find({ _id: ObjectId('507f1f77bcf86cd799439011') })",
    ],
    [
      'SELECT * FROM orders WHERE createdAt < GETDATE()',
      'db.orders.find({ createdAt: { $lt: new Date() } })',
    ],
    [
      'SELECT * FROM orders WHERE createdAt < CURRENT_TIMESTAMP',
      'db.orders.find({ createdAt: { $lt: new Date() } })',
    ],
  ])('%s', (sql, mongosh) => {
    expect(run(sql)).toBe(mongosh);
  });
});

describe('translateSql LIKE', () => {
  it.each<[string, string]>([
    ["SELECT * FROM orders WHERE name LIKE 'A%'", 'db.orders.find({ name: /^A/i })'],
    ["SELECT * FROM orders WHERE name LIKE '%son'", 'db.orders.find({ name: /son$/i })'],
    ["SELECT * FROM orders WHERE name LIKE '%an%'", 'db.orders.find({ name: /an/i })'],
    ["SELECT * FROM orders WHERE name LIKE 'J_n'", 'db.orders.find({ name: /^J.n$/i })'],
    ["SELECT * FROM orders WHERE name LIKE '[JT]ohn'", 'db.orders.find({ name: /^[JT]ohn$/i })'],
    ["SELECT * FROM orders WHERE name LIKE '[^a-c]%'", 'db.orders.find({ name: /^[^a-c]/i })'],
    ["SELECT * FROM orders WHERE name LIKE 'a.b'", 'db.orders.find({ name: /^a\\.b$/i })'],
    ["SELECT * FROM orders WHERE name LIKE 'a/b'", 'db.orders.find({ name: /^a\\/b$/i })'],
    [
      "SELECT * FROM orders WHERE name LIKE '100\\%' ESCAPE '\\'",
      'db.orders.find({ name: /^100%$/i })',
    ],
    ["SELECT * FROM orders WHERE name NOT LIKE 'A%'", 'db.orders.find({ name: { $not: /^A/i } })'],
    ["SELECT * FROM orders WHERE path LIKE 'C:\\%'", 'db.orders.find({ path: /^C:\\\\/i })'],
    ["SELECT * FROM orders WHERE path LIKE '%\\'", 'db.orders.find({ path: /\\\\$/i })'],
    ["SELECT * FROM orders WHERE path LIKE '%a\\b%'", 'db.orders.find({ path: /a\\\\b/i })'],
  ])('%s', (sql, mongosh) => {
    expect(run(sql)).toBe(mongosh);
  });
});

describe('translateSql computed columns and functions', () => {
  it.each<[string, string[]]>([
    ['SELECT name AS n FROM orders', ["{ $project: { _id: 0, n: '$name' } }"]],
    ['SELECT name n FROM orders', ["{ $project: { _id: 0, n: '$name' } }"]],
    ['SELECT n = name FROM orders', ["{ $project: { _id: 0, n: '$name' } }"]],
    [
      'SELECT total * 1.22 AS gross FROM orders',
      ["{ $project: { _id: 0, gross: { $multiply: ['$total', 1.22] } } }"],
    ],
    [
      'SELECT name, total * 1.22 AS gross FROM orders',
      ["{ $project: { _id: 0, name: 1, gross: { $multiply: ['$total', 1.22] } } }"],
    ],
    [
      'SELECT UPPER(name) AS up FROM orders',
      ["{ $project: { _id: 0, up: { $toUpper: '$name' } } }"],
    ],
    [
      'SELECT UPPER(name) FROM orders',
      ["{ $project: { _id: 0, upper_name: { $toUpper: '$name' } } }"],
    ],
    ['SELECT total + 1 FROM orders', ["{ $project: { _id: 0, expr_1: { $add: ['$total', 1] } } }"]],
    [
      'SELECT LOWER(name) AS l, LEN(name) AS n, LTRIM(name) AS lt, RTRIM(name) AS rt, TRIM(name) AS t FROM orders',
      [
        "{ $project: { _id: 0, l: { $toLower: '$name' }, n: { $strLenCP: '$name' }, lt: { $ltrim: { input: '$name' } }, rt: { $rtrim: { input: '$name' } }, t: { $trim: { input: '$name' } } } }",
      ],
    ],
    [
      'SELECT SUBSTRING(name, 1, 3) AS s FROM orders',
      ["{ $project: { _id: 0, s: { $substrCP: ['$name', 0, 3] } } }"],
    ],
    [
      'SELECT SUBSTRING(name, pos, 3) AS s FROM orders',
      ["{ $project: { _id: 0, s: { $substrCP: ['$name', { $subtract: ['$pos', 1] }, 3] } } }"],
    ],
    [
      "SELECT CONCAT(first, ' ', last) AS fullName FROM orders",
      ["{ $project: { _id: 0, fullName: { $concat: ['$first', ' ', '$last'] } } }"],
    ],
    [
      "SELECT first + ' ' + last AS fullName FROM orders",
      ["{ $project: { _id: 0, fullName: { $concat: ['$first', ' ', '$last'] } } }"],
    ],
    [
      "SELECT REPLACE(name, 'a', 'b') AS r FROM orders",
      [
        "{ $project: { _id: 0, r: { $replaceAll: { input: '$name', find: 'a', replacement: 'b' } } } }",
      ],
    ],
    [
      'SELECT ABS(total) AS a, ROUND(total, 2) AS r, FLOOR(total) AS f, CEILING(total) AS c FROM orders',
      [
        "{ $project: { _id: 0, a: { $abs: '$total' }, r: { $round: ['$total', 2] }, f: { $floor: '$total' }, c: { $ceil: '$total' } } }",
      ],
    ],
    [
      'SELECT ROUND(total) AS r FROM orders',
      ["{ $project: { _id: 0, r: { $round: ['$total', 0] } } }"],
    ],
    [
      'SELECT YEAR(createdAt) AS y, MONTH(createdAt) AS m, DAY(createdAt) AS d FROM orders',
      [
        "{ $project: { _id: 0, y: { $year: '$createdAt' }, m: { $month: '$createdAt' }, d: { $dayOfMonth: '$createdAt' } } }",
      ],
    ],
    [
      'SELECT DATEDIFF(day, createdAt, shippedAt) AS days FROM orders',
      [
        "{ $project: { _id: 0, days: { $dateDiff: { startDate: '$createdAt', endDate: '$shippedAt', unit: 'day' } } } }",
      ],
    ],
    [
      'SELECT DATEADD(month, 1, createdAt) AS next FROM orders',
      [
        "{ $project: { _id: 0, next: { $dateAdd: { startDate: '$createdAt', unit: 'month', amount: 1 } } } }",
      ],
    ],
    [
      'SELECT COALESCE(a, b, 0) AS v FROM orders',
      ["{ $project: { _id: 0, v: { $ifNull: ['$a', { $ifNull: ['$b', 0] }] } } }"],
    ],
    [
      'SELECT NULLIF(a, 0) AS v FROM orders',
      ["{ $project: { _id: 0, v: { $cond: [{ $eq: ['$a', 0] }, null, '$a'] } } }"],
    ],
    [
      "SELECT IIF(total > 10, 'big', 'small') AS size FROM orders",
      ["{ $project: { _id: 0, size: { $cond: [{ $gt: ['$total', 10] }, 'big', 'small'] } } }"],
    ],
    [
      "SELECT CASE WHEN total > 10 THEN 'big' ELSE 'small' END AS size FROM orders",
      [
        "{ $project: { _id: 0, size: { $switch: { branches: [{ case: { $gt: ['$total', 10] }, then: 'big' }], default: 'small' } } } }",
      ],
    ],
    [
      "SELECT CASE WHEN total > 10 THEN 'big' END AS size FROM orders",
      [
        "{ $project: { _id: 0, size: { $switch: { branches: [{ case: { $gt: ['$total', 10] }, then: 'big' }], default: null } } } }",
      ],
    ],
    [
      "SELECT CASE status WHEN 'a' THEN 1 WHEN 'b' THEN 2 ELSE 0 END AS code FROM orders",
      [
        "{ $project: { _id: 0, code: { $switch: { branches: [{ case: { $eq: ['$status', 'a'] }, then: 1 }, { case: { $eq: ['$status', 'b'] }, then: 2 }], default: 0 } } } }",
      ],
    ],
    [
      'SELECT CAST(total AS INT) AS t FROM orders',
      ["{ $project: { _id: 0, t: { $toInt: '$total' } } }"],
    ],
    [
      'SELECT 1 AS one, name FROM orders',
      ['{ $project: { _id: 0, one: { $literal: 1 }, name: 1 } }'],
    ],
    [
      'SELECT 0 AS zero, TRUE AS flag, FALSE AS off, NULL AS nothing FROM orders',
      [
        '{ $project: { _id: 0, zero: { $literal: 0 }, flag: { $literal: true }, off: { $literal: false }, nothing: null } }',
      ],
    ],
    [
      "SELECT CAST('42' AS INT) AS a, -3 AS b FROM orders",
      ['{ $project: { _id: 0, a: { $literal: 42 }, b: { $literal: -3 } } }'],
    ],
    ['SELECT *, 1 AS one FROM orders', ['{ $addFields: { one: { $literal: 1 } } }']],
    [
      'SELECT 1 AS one, COUNT(*) AS n FROM orders',
      [
        '{ $group: { _id: null, n: { $sum: 1 } } }',
        '{ $project: { _id: 0, one: { $literal: 1 }, n: 1 } }',
      ],
    ],
    [
      'SELECT total * 2 AS total, total FROM orders',
      ["{ $project: { _id: 0, total: { $multiply: ['$total', 2] }, total2: '$total' } }"],
    ],
    [
      "SELECT DATEDIFF(day, '2026-01-01', b) AS d FROM orders",
      [
        "{ $project: { _id: 0, d: { $dateDiff: { startDate: ISODate('2026-01-01T00:00:00.000Z'), endDate: '$b', unit: 'day' } } } }",
      ],
    ],
    [
      "SELECT DATEADD(month, 1, '2026-01-31 10:00') AS d, YEAR('2026-05-06') AS y FROM orders",
      [
        "{ $project: { _id: 0, d: { $dateAdd: { startDate: ISODate('2026-01-31T10:00:00.000Z'), unit: 'month', amount: 1 } }, y: { $year: ISODate('2026-05-06T00:00:00.000Z') } } }",
      ],
    ],
    [
      'SELECT CAST(total AS BIGINT) AS t, CAST(total AS FLOAT) AS f, CAST(total AS DECIMAL(10, 2)) AS d FROM orders',
      [
        "{ $project: { _id: 0, t: { $toLong: '$total' }, f: { $toDouble: '$total' }, d: { $toDecimal: '$total' } } }",
      ],
    ],
    [
      'SELECT CAST(flag AS BIT) AS b, CAST(total AS NVARCHAR(50)) AS s FROM orders',
      ["{ $project: { _id: 0, b: { $toBool: '$flag' }, s: { $toString: '$total' } } }"],
    ],
    [
      'SELECT CAST(text AS DATE) AS d, CAST(hex AS OBJECTID) AS o FROM orders',
      ["{ $project: { _id: 0, d: { $toDate: '$text' }, o: { $toObjectId: '$hex' } } }"],
    ],
    [
      'SELECT CONVERT(INT, total) AS t FROM orders',
      ["{ $project: { _id: 0, t: { $toInt: '$total' } } }"],
    ],
    [
      'SELECT -total AS neg FROM orders',
      ["{ $project: { _id: 0, neg: { $multiply: [-1, '$total'] } } }"],
    ],
    [
      'SELECT total % 2 AS m, total / 2 AS d, total - 1 AS s FROM orders',
      [
        "{ $project: { _id: 0, m: { $mod: ['$total', 2] }, d: { $divide: ['$total', 2] }, s: { $subtract: ['$total', 1] } } }",
      ],
    ],
    ['SELECT GETDATE() AS now FROM orders', ["{ $project: { _id: 0, now: '$$NOW' } }"]],
    [
      'SELECT name AS n FROM orders ORDER BY n',
      ["{ $project: { _id: 0, n: '$name' } }", '{ $sort: { n: 1 } }'],
    ],
    [
      'SELECT name AS n FROM orders WHERE total > 1 ORDER BY total DESC',
      [
        '{ $match: { total: { $gt: 1 } } }',
        '{ $sort: { total: -1 } }',
        "{ $project: { _id: 0, n: '$name' } }",
      ],
    ],
    [
      'SELECT total * 2 AS d FROM orders ORDER BY d DESC',
      ["{ $project: { _id: 0, d: { $multiply: ['$total', 2] } } }", '{ $sort: { d: -1 } }'],
    ],
    [
      'SELECT name AS n FROM orders ORDER BY n OFFSET 10 ROWS FETCH NEXT 5 ROWS ONLY',
      [
        "{ $project: { _id: 0, n: '$name' } }",
        '{ $sort: { n: 1 } }',
        '{ $skip: 10 }',
        '{ $limit: 5 }',
      ],
    ],
    [
      'SELECT *, total * 2 AS d FROM orders',
      ["{ $addFields: { d: { $multiply: ['$total', 2] } } }"],
    ],
  ])('%s', (sql, stages) => {
    expect(run(sql)).toBe(pipeline('orders', stages));
  });
});

describe('translateSql aggregates, GROUP BY, HAVING and DISTINCT', () => {
  it.each<[string, string[]]>([
    [
      'SELECT COUNT(*) FROM orders',
      ['{ $group: { _id: null, count: { $sum: 1 } } }', '{ $project: { _id: 0, count: 1 } }'],
    ],
    [
      'SELECT COUNT(*) AS n FROM orders',
      ['{ $group: { _id: null, n: { $sum: 1 } } }', '{ $project: { _id: 0, n: 1 } }'],
    ],
    [
      "SELECT COUNT(*) AS n FROM orders WHERE status = 'a'",
      [
        "{ $match: { status: 'a' } }",
        '{ $group: { _id: null, n: { $sum: 1 } } }',
        '{ $project: { _id: 0, n: 1 } }',
      ],
    ],
    [
      'SELECT SUM(total) FROM orders',
      [
        "{ $group: { _id: null, sum_total: { $sum: '$total' } } }",
        '{ $project: { _id: 0, sum_total: 1 } }',
      ],
    ],
    [
      'SELECT AVG(total) AS a, MIN(total) AS lo, MAX(total) AS hi FROM orders',
      [
        "{ $group: { _id: null, a: { $avg: '$total' }, lo: { $min: '$total' }, hi: { $max: '$total' } } }",
        '{ $project: { _id: 0, a: 1, lo: 1, hi: 1 } }',
      ],
    ],
    [
      'SELECT COUNT(email) AS n FROM orders',
      [
        "{ $group: { _id: null, n: { $sum: { $cond: [{ $gt: ['$email', null] }, 1, 0] } } } }",
        '{ $project: { _id: 0, n: 1 } }',
      ],
    ],
    [
      'SELECT COUNT(DISTINCT city) AS n FROM orders',
      [
        "{ $group: { _id: null, n: { $addToSet: '$city' } } }",
        "{ $project: { _id: 0, n: { $size: { $filter: { input: '$n', cond: { $ne: ['$$this', null] } } } } } }",
      ],
    ],
    [
      'SELECT SUM(total) / COUNT(*) AS avg FROM orders',
      [
        "{ $group: { _id: null, sum_total: { $sum: '$total' }, count: { $sum: 1 } } }",
        "{ $project: { _id: 0, avg: { $divide: ['$sum_total', '$count'] } } }",
      ],
    ],
    [
      'SELECT status, COUNT(*) AS n FROM orders GROUP BY status',
      [
        "{ $group: { _id: '$status', n: { $sum: 1 } } }",
        "{ $project: { _id: 0, status: '$_id', n: 1 } }",
      ],
    ],
    [
      'SELECT status FROM orders GROUP BY status',
      ["{ $group: { _id: '$status' } }", "{ $project: { _id: 0, status: '$_id' } }"],
    ],
    [
      'SELECT status, SUM(total) FROM orders GROUP BY status',
      [
        "{ $group: { _id: '$status', sum_total: { $sum: '$total' } } }",
        "{ $project: { _id: 0, status: '$_id', sum_total: 1 } }",
      ],
    ],
    [
      'SELECT status, region, COUNT(*) AS n FROM orders GROUP BY status, region',
      [
        "{ $group: { _id: { status: '$status', region: '$region' }, n: { $sum: 1 } } }",
        "{ $project: { _id: 0, status: '$_id.status', region: '$_id.region', n: 1 } }",
      ],
    ],
    [
      'SELECT address.city, COUNT(*) AS n FROM orders GROUP BY address.city',
      [
        "{ $group: { _id: '$address.city', n: { $sum: 1 } } }",
        "{ $project: { _id: 0, city: '$_id', n: 1 } }",
      ],
    ],
    [
      'SELECT address.city AS city, COUNT(*) AS n FROM orders GROUP BY address.city ORDER BY n DESC',
      [
        "{ $group: { _id: '$address.city', n: { $sum: 1 } } }",
        "{ $project: { _id: 0, city: '$_id', n: 1 } }",
        '{ $sort: { n: -1 } }',
      ],
    ],
    [
      'SELECT status, COUNT(*) AS n FROM orders GROUP BY status ORDER BY status',
      [
        "{ $group: { _id: '$status', n: { $sum: 1 } } }",
        "{ $project: { _id: 0, status: '$_id', n: 1 } }",
        '{ $sort: { status: 1 } }',
      ],
    ],
    [
      'SELECT status, COUNT(*) AS n FROM orders GROUP BY status ORDER BY COUNT(*) DESC',
      [
        "{ $group: { _id: '$status', n: { $sum: 1 } } }",
        "{ $project: { _id: 0, status: '$_id', n: 1 } }",
        '{ $sort: { n: -1 } }',
      ],
    ],
    [
      'SELECT status, COUNT(*) AS n FROM orders GROUP BY status HAVING COUNT(*) > 5',
      [
        "{ $group: { _id: '$status', n: { $sum: 1 } } }",
        '{ $match: { n: { $gt: 5 } } }',
        "{ $project: { _id: 0, status: '$_id', n: 1 } }",
      ],
    ],
    [
      'SELECT status FROM orders GROUP BY status HAVING SUM(total) > 100',
      [
        "{ $group: { _id: '$status', having_1: { $sum: '$total' } } }",
        '{ $match: { having_1: { $gt: 100 } } }',
        "{ $project: { _id: 0, status: '$_id' } }",
      ],
    ],
    [
      'SELECT status FROM orders GROUP BY status HAVING SUM(total) > 100 AND COUNT(*) > 2',
      [
        "{ $group: { _id: '$status', having_1: { $sum: '$total' }, having_2: { $sum: 1 } } }",
        '{ $match: { having_1: { $gt: 100 }, having_2: { $gt: 2 } } }',
        "{ $project: { _id: 0, status: '$_id' } }",
      ],
    ],
    [
      'SELECT status, SUM(total) AS s FROM orders GROUP BY status HAVING SUM(total) / COUNT(*) > 5',
      [
        "{ $group: { _id: '$status', s: { $sum: '$total' }, having_1: { $sum: 1 } } }",
        "{ $match: { $expr: { $gt: [{ $divide: ['$s', '$having_1'] }, 5] } } }",
        "{ $project: { _id: 0, status: '$_id', s: 1 } }",
      ],
    ],
    [
      'SELECT YEAR(createdAt) AS y, COUNT(*) AS n FROM orders GROUP BY YEAR(createdAt)',
      [
        "{ $group: { _id: { $year: '$createdAt' }, n: { $sum: 1 } } }",
        "{ $project: { _id: 0, y: '$_id', n: 1 } }",
      ],
    ],
    [
      'SELECT status, COUNT(*) AS n FROM orders WHERE total > 1 GROUP BY status HAVING COUNT(*) > 1 ORDER BY n DESC OFFSET 5 ROWS FETCH NEXT 10 ROWS ONLY',
      [
        '{ $match: { total: { $gt: 1 } } }',
        "{ $group: { _id: '$status', n: { $sum: 1 } } }",
        '{ $match: { n: { $gt: 1 } } }',
        "{ $project: { _id: 0, status: '$_id', n: 1 } }",
        '{ $sort: { n: -1 } }',
        '{ $skip: 5 }',
        '{ $limit: 10 }',
      ],
    ],
    [
      'SELECT TOP 10 status, COUNT(*) AS n FROM orders GROUP BY status ORDER BY n DESC',
      [
        "{ $group: { _id: '$status', n: { $sum: 1 } } }",
        "{ $project: { _id: 0, status: '$_id', n: 1 } }",
        '{ $sort: { n: -1 } }',
        '{ $limit: 10 }',
      ],
    ],
    [
      'SELECT status, SUM(total) * 2 AS doubled FROM orders GROUP BY status',
      [
        "{ $group: { _id: '$status', sum_total: { $sum: '$total' } } }",
        "{ $project: { _id: 0, status: '$_id', doubled: { $multiply: ['$sum_total', 2] } } }",
      ],
    ],
    [
      'SELECT DISTINCT status FROM orders',
      [
        "{ $group: { _id: { status: '$status' } } }",
        "{ $project: { _id: 0, status: '$_id.status' } }",
      ],
    ],
    [
      'SELECT DISTINCT status, region FROM orders',
      [
        "{ $group: { _id: { status: '$status', region: '$region' } } }",
        "{ $project: { _id: 0, status: '$_id.status', region: '$_id.region' } }",
      ],
    ],
    [
      'SELECT DISTINCT address.city FROM orders WHERE total > 1',
      [
        '{ $match: { total: { $gt: 1 } } }',
        "{ $group: { _id: { city: '$address.city' } } }",
        "{ $project: { _id: 0, city: '$_id.city' } }",
      ],
    ],
    [
      'SELECT DISTINCT status AS s FROM orders ORDER BY s',
      [
        "{ $group: { _id: { s: '$status' } } }",
        "{ $project: { _id: 0, s: '$_id.s' } }",
        '{ $sort: { s: 1 } }',
      ],
    ],
  ])('%s', (sql, stages) => {
    expect(run(sql)).toBe(pipeline('orders', stages));
  });
});

describe('translateSql joins', () => {
  const lookup =
    "{ $lookup: { from: 'customers', localField: 'customerId', foreignField: '_id', as: 'c' } }";
  const unwind = "{ $unwind: '$c' }";
  const leftUnwind = "{ $unwind: { path: '$c', preserveNullAndEmptyArrays: true } }";

  it.each<[string, string[]]>([
    [
      'SELECT o.name, c.name FROM orders o JOIN customers c ON o.customerId = c._id',
      [lookup, unwind, "{ $project: { _id: 0, name: 1, name2: '$c.name' } }"],
    ],
    [
      'SELECT c.name, o.name FROM orders o JOIN customers c ON o.customerId = c._id',
      [lookup, unwind, "{ $project: { _id: 0, name: '$c.name', name2: '$name' } }"],
    ],
    [
      'SELECT c.name AS total, o.total FROM orders o JOIN customers c ON o.customerId = c._id',
      [lookup, unwind, "{ $project: { _id: 0, total: '$c.name', total2: '$total' } }"],
    ],
    [
      'SELECT c.name, o.name, r.name FROM orders o JOIN customers c ON o.customerId = c._id JOIN regions r ON c.regionId = r._id',
      [
        lookup,
        unwind,
        "{ $lookup: { from: 'regions', localField: 'c.regionId', foreignField: '_id', as: 'r' } }",
        "{ $unwind: '$r' }",
        "{ $project: { _id: 0, name: '$c.name', name2: '$name', name3: '$r.name' } }",
      ],
    ],
    [
      'SELECT o.name, c.name AS customer FROM orders o LEFT JOIN customers c ON o.customerId = c._id',
      [lookup, leftUnwind, "{ $project: { _id: 0, name: 1, customer: '$c.name' } }"],
    ],
    [
      'SELECT o.name FROM orders o LEFT OUTER JOIN customers c ON c._id = o.customerId',
      [lookup, leftUnwind, '{ $project: { _id: 0, name: 1 } }'],
    ],
    [
      'SELECT o.name FROM orders o INNER JOIN customers c ON o.customerId = c._id WHERE c.active = TRUE',
      [lookup, unwind, "{ $match: { 'c.active': true } }", '{ $project: { _id: 0, name: 1 } }'],
    ],
    [
      'SELECT o.name FROM orders o INNER JOIN customers c ON o.customerId = c._id WHERE o.total > 1 AND c.active = TRUE',
      [
        '{ $match: { total: { $gt: 1 } } }',
        lookup,
        unwind,
        "{ $match: { 'c.active': true } }",
        '{ $project: { _id: 0, name: 1 } }',
      ],
    ],
    [
      'SELECT o.name FROM orders o INNER JOIN customers c ON o.customerId = c._id WHERE o.total > 1 OR c.active = TRUE',
      [
        lookup,
        unwind,
        "{ $match: { $or: [{ total: { $gt: 1 } }, { 'c.active': true }] } }",
        '{ $project: { _id: 0, name: 1 } }',
      ],
    ],
    [
      'SELECT o.name, c.name, r.name FROM orders o JOIN customers c ON o.customerId = c._id JOIN regions r ON c.regionId = r._id',
      [
        lookup,
        unwind,
        "{ $lookup: { from: 'regions', localField: 'c.regionId', foreignField: '_id', as: 'r' } }",
        "{ $unwind: '$r' }",
        "{ $project: { _id: 0, name: 1, name2: '$c.name', name3: '$r.name' } }",
      ],
    ],
    [
      'SELECT o.*, c.name FROM orders o JOIN customers c ON o.customerId = c._id',
      [lookup, unwind, "{ $addFields: { name: '$c.name' } }"],
    ],
    [
      'SELECT *, c.name FROM orders o JOIN customers c ON o.customerId = c._id',
      [lookup, unwind, "{ $addFields: { name: '$c.name' } }"],
    ],
    [
      'SELECT c.* FROM orders o JOIN customers c ON o.customerId = c._id',
      [lookup, unwind, '{ $project: { _id: 0, c: 1 } }'],
    ],
    [
      'SELECT c.address.city FROM orders o JOIN customers c ON o.customerId = c._id',
      [lookup, unwind, "{ $project: { _id: 0, 'address.city': '$c.address.city' } }"],
    ],
    [
      'SELECT c.name, COUNT(*) AS n FROM orders o JOIN customers c ON o.customerId = c._id GROUP BY c.name',
      [
        lookup,
        unwind,
        "{ $group: { _id: '$c.name', n: { $sum: 1 } } }",
        "{ $project: { _id: 0, name: '$_id', n: 1 } }",
      ],
    ],
    [
      'SELECT o.name FROM orders o JOIN customers c ON o.customerId = c._id ORDER BY c.name',
      [lookup, unwind, "{ $sort: { 'c.name': 1 } }", '{ $project: { _id: 0, name: 1 } }'],
    ],
    [
      'SELECT TOP 5 o.name FROM orders o JOIN customers c ON o.customerId = c._id WHERE o.total > 1 ORDER BY o.total DESC',
      [
        '{ $match: { total: { $gt: 1 } } }',
        lookup,
        unwind,
        '{ $sort: { total: -1 } }',
        '{ $project: { _id: 0, name: 1 } }',
        '{ $limit: 5 }',
      ],
    ],
    [
      'SELECT name FROM orders JOIN customers ON orders.customerId = customers._id',
      [
        "{ $lookup: { from: 'customers', localField: 'customerId', foreignField: '_id', as: 'customers' } }",
        "{ $unwind: '$customers' }",
        '{ $project: { _id: 0, name: 1 } }',
      ],
    ],
  ])('%s', (sql, stages) => {
    expect(run(sql)).toBe(pipeline('orders', stages));
  });
});

describe('translateSql writes', () => {
  it.each<[string, string]>([
    ["UPDATE orders SET status = 'done'", "db.orders.updateMany({}, { $set: { status: 'done' } })"],
    [
      "UPDATE orders SET status = 'done' WHERE _id = 1",
      "db.orders.updateMany({ _id: 1 }, { $set: { status: 'done' } })",
    ],
    [
      'UPDATE orders SET status = NULL WHERE _id = 1',
      'db.orders.updateMany({ _id: 1 }, { $set: { status: null } })',
    ],
    [
      "UPDATE orders SET total = total * 2 WHERE status = 'a'",
      "db.orders.updateMany({ status: 'a' }, [{ $set: { total: { $multiply: ['$total', 2] } } }])",
    ],
    [
      "UPDATE orders SET address.city = 'Rome' WHERE _id = 1",
      "db.orders.updateMany({ _id: 1 }, { $set: { 'address.city': 'Rome' } })",
    ],
    [
      "UPDATE orders SET createdAt = CAST('2026-02-03' AS DATETIME), n = 5, active = TRUE WHERE _id = 1",
      "db.orders.updateMany({ _id: 1 }, { $set: { createdAt: ISODate('2026-02-03T00:00:00.000Z'), n: 5, active: true } })",
    ],
    [
      'UPDATE orders SET name = UPPER(name) WHERE _id = 1',
      "db.orders.updateMany({ _id: 1 }, [{ $set: { name: { $toUpper: '$name' } } }])",
    ],
    [
      'UPDATE orders SET updatedAt = GETDATE(), count = count + 1 WHERE _id = 1',
      "db.orders.updateMany({ _id: 1 }, [{ $set: { updatedAt: new Date(), count: { $add: ['$count', 1] } } }])",
    ],
    [
      "UPDATE [orders] SET [status] = 'x' WHERE [status] = 'y'",
      "db.orders.updateMany({ status: 'y' }, { $set: { status: 'x' } })",
    ],
    [
      'UPDATE dbo.orders SET a = 1 WHERE b IN (1, 2)',
      'db.orders.updateMany({ b: { $in: [1, 2] } }, { $set: { a: 1 } })',
    ],
    ['DELETE FROM orders', 'db.orders.deleteMany({})'],
    ['DELETE orders', 'db.orders.deleteMany({})'],
    ["DELETE FROM orders WHERE status = 'x'", "db.orders.deleteMany({ status: 'x' })"],
    [
      'DELETE FROM orders WHERE total < 1 OR status IS NULL',
      'db.orders.deleteMany({ $or: [{ total: { $lt: 1 } }, { status: null }] })',
    ],
    ['TRUNCATE TABLE orders', 'db.orders.deleteMany({})'],
    [
      "INSERT INTO orders (name, total) VALUES ('a', 1)",
      "db.orders.insertMany([{ name: 'a', total: 1 }])",
    ],
    [
      "INSERT orders (name, total) VALUES ('a', 1), ('b', 2)",
      "db.orders.insertMany([{ name: 'a', total: 1 }, { name: 'b', total: 2 }])",
    ],
    [
      "INSERT INTO orders (address.city, address.zip, name) VALUES ('Rome', '00100', 'x')",
      "db.orders.insertMany([{ address: { city: 'Rome', zip: '00100' }, name: 'x' }])",
    ],
    [
      "INSERT INTO orders (createdAt, _id, active, note) VALUES (GETDATE(), CAST('507f1f77bcf86cd799439011' AS OBJECTID), TRUE, NULL)",
      "db.orders.insertMany([{ createdAt: new Date(), _id: ObjectId('507f1f77bcf86cd799439011'), active: true, note: null }])",
    ],
    [
      "INSERT INTO orders (createdAt) VALUES (CAST('2026-01-01' AS DATE))",
      "db.orders.insertMany([{ createdAt: ISODate('2026-01-01T00:00:00.000Z') }])",
    ],
    ["INSERT INTO orders ([name]) VALUES (N'it''s')", "db.orders.insertMany([{ name: 'it\\'s' }])"],
  ])('%s', (sql, mongosh) => {
    expect(run(sql)).toBe(mongosh);
  });

  it('marks UPDATE, DELETE and TRUNCATE without WHERE as unsafe writes', () => {
    for (const sql of ['UPDATE orders SET a = 1', 'DELETE FROM orders', 'TRUNCATE TABLE orders']) {
      const result = translateSqlStatement(sql);
      expect(result.ok && result.translation.statement.kind).toBe('write');
      expect(result.ok && result.translation.statement.unsafe).toBe(true);
    }
  });

  it.each<[string, string]>([
    [
      'UPDATE orders SET d = CAST(0 AS DATETIME) WHERE id = 1',
      "db.orders.updateMany({ id: 1 }, { $set: { d: ISODate('1900-01-01T00:00:00.000Z') } })",
    ],
    [
      'UPDATE orders SET d = CAST(45000.5 AS DATETIME) WHERE id = 1',
      "db.orders.updateMany({ id: 1 }, { $set: { d: ISODate('2023-03-17T12:00:00.000Z') } })",
    ],
    [
      "UPDATE orders SET d = CAST('2026-03-01 12:00' AS DATETIME) WHERE id = 1",
      "db.orders.updateMany({ id: 1 }, { $set: { d: ISODate('2026-03-01T12:00:00.000Z') } })",
    ],
    [
      "INSERT INTO orders (d) VALUES (CAST('2026-03-01T12:00:00' AS DATETIME))",
      "db.orders.insertMany([{ d: ISODate('2026-03-01T12:00:00.000Z') }])",
    ],
    [
      'INSERT INTO orders (a.b, a.c, ab) VALUES (1, 2, 3)',
      'db.orders.insertMany([{ a: { b: 1, c: 2 }, ab: 3 }])',
    ],
  ])('%s', (sql, mongosh) => {
    expect(run(sql)).toBe(mongosh);
  });

  it('marks filtered writes as safe and reads as reads', () => {
    const update = translateSqlStatement('UPDATE orders SET a = 1 WHERE b = 2');
    expect(update.ok && update.translation.statement.unsafe).toBe(false);
    const insert = translateSqlStatement('INSERT INTO orders (a) VALUES (1)');
    expect(insert.ok && insert.translation.statement.kind).toBe('write');
    expect(insert.ok && insert.translation.statement.unsafe).toBe(false);
    const select = translateSqlStatement('SELECT * FROM orders');
    expect(select.ok && select.translation.statement.kind).toBe('read');
  });
});

describe('translateSql type hints', () => {
  const fieldType: TranslateOptions['fieldType'] = (collection, path) => {
    if (collection === 'orders' && path === 'createdAt') return 'date';
    if (collection === 'orders' && path === 'customerId') return 'objectId';
    if (collection === 'orders' && path === 'qty') return 'number';
    if (collection === 'orders' && path === 'active') return 'bool';
    if (collection === 'orders' && path === 'code') return 'string';
    if (collection === 'customers' && path === 'since') return 'date';
    return undefined;
  };

  it.each<[string, string]>([
    [
      "SELECT * FROM orders WHERE createdAt > '2026-01-01'",
      "db.orders.find({ createdAt: { $gt: ISODate('2026-01-01T00:00:00.000Z') } })",
    ],
    [
      "SELECT * FROM orders WHERE createdAt BETWEEN '2026-01-01' AND '2026-02-01'",
      "db.orders.find({ createdAt: { $gte: ISODate('2026-01-01T00:00:00.000Z'), $lte: ISODate('2026-02-01T00:00:00.000Z') } })",
    ],
    [
      "SELECT * FROM orders WHERE customerId = '507f1f77bcf86cd799439011'",
      "db.orders.find({ customerId: ObjectId('507f1f77bcf86cd799439011') })",
    ],
    [
      "SELECT * FROM orders WHERE customerId IN ('507f1f77bcf86cd799439011', '507f1f77bcf86cd799439012')",
      "db.orders.find({ customerId: { $in: [ObjectId('507f1f77bcf86cd799439011'), ObjectId('507f1f77bcf86cd799439012')] } })",
    ],
    ["SELECT * FROM orders WHERE qty = '5'", 'db.orders.find({ qty: 5 })'],
    ["SELECT * FROM orders WHERE active = 'true'", 'db.orders.find({ active: true })'],
    ['SELECT * FROM orders WHERE active = 0', 'db.orders.find({ active: false })'],
    ["SELECT * FROM orders WHERE code = '5'", "db.orders.find({ code: '5' })"],
    ["SELECT * FROM orders WHERE other = '5'", "db.orders.find({ other: '5' })"],
    [
      "UPDATE orders SET createdAt = '2026-03-04' WHERE qty = '1'",
      "db.orders.updateMany({ qty: 1 }, { $set: { createdAt: ISODate('2026-03-04T00:00:00.000Z') } })",
    ],
    [
      "INSERT INTO orders (createdAt, qty) VALUES ('2026-03-04', '7')",
      "db.orders.insertMany([{ createdAt: ISODate('2026-03-04T00:00:00.000Z'), qty: 7 }])",
    ],
    [
      "SELECT code + 'x' AS c FROM orders",
      pipeline('orders', ["{ $project: { _id: 0, c: { $concat: ['$code', 'x'] } } }"]),
    ],
    [
      "SELECT o.name FROM orders o JOIN customers c ON o.customerId = c._id WHERE c.since > '2020-01-01'",
      pipeline('orders', [
        "{ $lookup: { from: 'customers', localField: 'customerId', foreignField: '_id', as: 'c' } }",
        "{ $unwind: '$c' }",
        "{ $match: { 'c.since': { $gt: ISODate('2020-01-01T00:00:00.000Z') } } }",
        '{ $project: { _id: 0, name: 1 } }',
      ]),
    ],
  ])('%s', (sql, mongosh) => {
    expect(run(sql, { fieldType })).toBe(mongosh);
  });

  it('reports an unparseable date literal against a date field', () => {
    expect(fail("SELECT * FROM orders WHERE createdAt > 'soon'", { fieldType })).toEqual({
      message: "'soon' is not a valid date",
      at: "'soon'",
    });
  });

  it('leaves strings alone without hints', () => {
    expect(run("SELECT * FROM orders WHERE createdAt > '2026-01-01'")).toBe(
      "db.orders.find({ createdAt: { $gt: '2026-01-01' } })",
    );
  });
});

describe('translateSql errors', () => {
  it.each<[string, string, string]>([
    [
      'SELEC * FROM orders',
      'Only SELECT, UPDATE, DELETE, INSERT and TRUNCATE statements are supported',
      'SELEC',
    ],
    [
      'CREATE TABLE x (a INT)',
      'Only SELECT, UPDATE, DELETE, INSERT and TRUNCATE statements are supported',
      'CREATE',
    ],
    [
      'SELECT * FROM sales.orders',
      "table prefix 'sales' is not supported, only dbo. is accepted",
      'sales.orders',
    ],
    ["SELECT * FROM orders WHERE name = 'abc", 'unterminated string', "'"],
    ['SELECT * FROM orders /* open', 'unterminated block comment', '/*'],
    ['SELECT * FROM [orders', 'unterminated bracketed identifier', '['],
    ['SELECT * FROM orders WHERE', 'expected an expression but the statement ended', 'WHERE'],
    ['SELECT * FROM orders WHERE a = 1 extra', "unexpected 'extra' after the statement", 'extra'],
    [
      'SELECT * FROM orders WHERE a = 1 ORDER BY name OFFSET 1 ROWS FETCH NEXT 5 ROWS',
      'expected ONLY but the statement ended',
      'ROWS',
    ],
    ['SELECT TOP 10 PERCENT * FROM orders', 'TOP ... PERCENT is not supported', 'PERCENT'],
    ['SELECT TOP 5 WITH TIES * FROM orders ORDER BY x', 'WITH TIES is not supported', 'WITH TIES'],
    [
      'SELECT * FROM orders o RIGHT JOIN customers c ON o.a = c.b',
      'RIGHT JOIN is not supported',
      'RIGHT JOIN',
    ],
    [
      'SELECT * FROM orders o FULL OUTER JOIN customers c ON o.a = c.b',
      'FULL JOIN is not supported',
      'FULL OUTER JOIN',
    ],
    ['SELECT * FROM orders CROSS JOIN customers', 'CROSS JOIN is not supported', 'CROSS JOIN'],
    ['SELECT * FROM orders, customers', 'comma joins are not supported, use JOIN ... ON', ','],
    ['SELECT * FROM orders UNION SELECT * FROM archive', 'UNION is not supported', 'UNION'],
    [
      'WITH t AS (SELECT 1 AS a) SELECT * FROM t',
      'WITH (common table expressions) is not supported',
      'WITH',
    ],
    [
      'SELECT * FROM orders WHERE id IN (SELECT id FROM x)',
      'subqueries are not supported',
      '(SELECT id FROM x)',
    ],
    [
      'UPDATE orders SET a = 1 WHERE b = (SELECT MAX(b) FROM orders)',
      'subqueries are not supported',
      '(SELECT MAX(b) FROM orders)',
    ],
    ['SELECT * FROM orders WHERE EXISTS (SELECT 1 FROM x)', 'EXISTS is not supported', 'EXISTS'],
    ['SELECT * FROM orders WHERE id = @id', 'parameters are not supported', '@id'],
    ['DECLARE @x INT', 'DECLARE is not supported', 'DECLARE'],
    [
      'SELECT ROW_NUMBER() OVER (ORDER BY x) AS rn FROM orders',
      'window functions (OVER) are not supported',
      'OVER',
    ],
    [
      'SELECT * FROM orders WITH (NOLOCK)',
      'table hints such as WITH (NOLOCK) are not supported',
      'WITH (NOLOCK)',
    ],
    ['DELETE TOP (5) FROM orders', 'DELETE with TOP is not supported', 'TOP'],
    [
      'DELETE FROM orders o JOIN customers c ON o.a = c.b',
      'DELETE with JOIN is not supported',
      'JOIN',
    ],
    ['UPDATE orders SET a = 1 FROM orders o', 'UPDATE ... FROM is not supported', 'FROM'],
    ['INSERT INTO orders VALUES (1)', 'INSERT needs a column list before VALUES', 'VALUES'],
    ['INSERT INTO orders SELECT * FROM archive', 'INSERT ... SELECT is not supported', 'SELECT'],
    ['SELECT * INTO archive FROM orders', 'SELECT ... INTO is not supported', 'INTO'],
    ['SELECT * FROM orders GROUP BY ROLLUP (a)', 'GROUP BY ROLLUP is not supported', 'ROLLUP'],
    ['SELECT CAST(x AS XML) FROM orders', "type 'XML' is not supported", 'XML'],
    ['SELECT from FROM orders', 'keyword FROM cannot be used as a name, write [from]', 'from'],
    ['SELECT * FROM orders WHERE x IN ()', 'IN needs at least one value', '()'],
    [
      'SELECT name FROM orders GROUP BY status',
      'column name must appear in GROUP BY or inside an aggregate function',
      'name',
    ],
    [
      'SELECT SUM(total) FROM orders WHERE SUM(total) > 1',
      'aggregate functions need GROUP BY',
      'SUM(total)',
    ],
    ['SELECT name FROM orders WHERE COUNT(*) > 1', 'aggregate functions need GROUP BY', 'COUNT(*)'],
    ['SELECT FOO(x) FROM orders', 'function FOO is not supported', 'FOO(x)'],
    ['SELECT UPPER(a, b) FROM orders', 'UPPER takes 1 argument', 'UPPER(a, b)'],
    [
      "SELECT * FROM orders WHERE createdAt > CAST('nope' AS DATE)",
      "'nope' is not a valid date",
      "CAST('nope' AS DATE)",
    ],
    [
      "SELECT * FROM orders WHERE _id = CAST('zz' AS OBJECTID)",
      'not a valid ObjectId: expected 24 hex characters',
      "CAST('zz' AS OBJECTID)",
    ],
    [
      'SELECT * FROM orders WHERE name LIKE other',
      'LIKE pattern must be a string literal',
      'other',
    ],
    [
      'SELECT o.name FROM orders o JOIN customers c ON o.a = c.b AND o.c = 1',
      'JOIN ... ON must compare one column of each table with =',
      'o.a = c.b AND o.c = 1',
    ],
    [
      'SELECT o.name FROM orders o JOIN customers c ON o.a = 1',
      'JOIN ... ON must compare one column of each table with =',
      'o.a = 1',
    ],
    ['INSERT INTO orders (a, b) VALUES (1)', 'INSERT row has 1 values for 2 columns', '1'],
    ['INSERT INTO orders (a) VALUES (b + 1)', 'INSERT values must be literals', 'b + 1'],
    [
      'SELECT * FROM orders ORDER BY total * 2',
      'ORDER BY must name a column, a select alias or an aggregate',
      'total * 2',
    ],
    ['SELECT DISTINCT * FROM orders', 'SELECT DISTINCT * is not supported', '*'],
    ['SELECT * FROM orders WHERE [$bad] = 1', 'column name $bad may not start with $', '[$bad]'],
    ['SELECT * FROM orders WHERE [a.b] = 1', 'column name part a.b may not contain a dot', '[a.b]'],
    ['SELECT o FROM orders o', 'o is a table alias, not a column', 'o'],
    [
      'SELECT name FROM orders HAVING total > 1',
      'HAVING needs GROUP BY or an aggregate function',
      'total > 1',
    ],
    [
      'SELECT SUM(DISTINCT total) FROM orders',
      'SUM(DISTINCT) is not supported',
      'SUM(DISTINCT total)',
    ],
    ['SELECT COUNT(SUM(total)) FROM orders', 'aggregate functions cannot be nested', 'SUM(total)'],
    [
      'SELECT DATEDIFF(fortnight, a, b) AS d FROM orders',
      'DATEDIFF unit must be year, quarter, month, week, day, hour, minute, second or millisecond',
      'fortnight',
    ],
    [
      'SELECT TOP 5 * FROM orders ORDER BY a OFFSET 1 ROWS FETCH NEXT 2 ROWS ONLY',
      'TOP cannot be combined with OFFSET and FETCH',
      'SELECT TOP 5 * FROM orders ORDER BY a OFFSET 1 ROWS FETCH NEXT 2 ROWS ONLY',
    ],
    ['SELECT TOP 0 * FROM orders', 'TOP 0 returns no rows and cannot be translated', '0'],
    [
      'SELECT * FROM orders ORDER BY a OFFSET 0 ROWS FETCH NEXT 0 ROWS ONLY',
      'FETCH 0 returns no rows and cannot be translated',
      '0',
    ],
    ['SELECT [] FROM orders', 'an identifier cannot be empty', '[]'],
    ['SELECT a FROM orders WHERE "" = 1', 'an identifier cannot be empty', '""'],
    [
      "SELECT * FROM orders WHERE d = CAST('2026-02-30' AS DATE)",
      "'2026-02-30' is not a valid date",
      "CAST('2026-02-30' AS DATE)",
    ],
    [
      "SELECT * FROM orders WHERE d = CAST('2026-01-02 25:00' AS DATETIME)",
      "'2026-01-02 25:00' is not a valid date",
      "CAST('2026-01-02 25:00' AS DATETIME)",
    ],
    [
      "UPDATE orders SET a = CAST('4.7' AS INT) WHERE id = 1",
      'not a valid number',
      "CAST('4.7' AS INT)",
    ],
    [
      "UPDATE orders SET a = CAST('1e3' AS BIGINT) WHERE id = 1",
      'not a valid number',
      "CAST('1e3' AS BIGINT)",
    ],
    [
      'UPDATE orders SET d = CAST(0 AS DATE) WHERE id = 1',
      'a number cannot be cast to DATE, cast it to DATETIME',
      'CAST(0 AS DATE)',
    ],
    ["SELECT DATEDIFF(day, 'soon', b) AS d FROM orders", "'soon' is not a valid date", "'soon'"],
    [
      "INSERT INTO orders (address.city, address) VALUES ('y', 'x')",
      'INSERT column address overlaps another column',
      'address',
    ],
    ['INSERT INTO orders (a, a) VALUES (1, 2)', 'INSERT column a is listed twice', 'a'],
    ['INSERT INTO orders (orders.a, [a]) VALUES (1, 2)', 'INSERT column a is listed twice', '[a]'],
  ])('%s', (sql, message, at) => {
    expect(fail(sql)).toEqual({ message, at });
  });

  it('spans an error inside a multi-line statement against the full text', () => {
    const text = 'SELECT *\nFROM orders\nWHERE total > @limit';
    const [result] = translateSql(text);
    expect(result?.ok).toBe(false);
    if (!result || result.ok) throw new Error('expected an error');
    expect(result.span).toEqual({ start: 0, end: text.length });
    expect(text.slice(result.error.span.start, result.error.span.end)).toBe('@limit');
  });
});

describe('translateSql statement splitting', () => {
  it('returns nothing for empty text', () => {
    expect(translateSql('')).toEqual([]);
    expect(translateSql('   \n\t ')).toEqual([]);
  });

  it('returns nothing for comments only', () => {
    expect(translateSql('-- nothing here\n/* or here */')).toEqual([]);
  });

  it('returns nothing for empty statements', () => {
    expect(translateSql(';;\nGO\n;')).toEqual([]);
  });

  it('translates statements separated by semicolons in order', () => {
    const text = 'SELECT * FROM orders; SELECT name FROM customers;';
    const results = translateSql(text);
    expect(results.map((result) => result.ok && result.translation.mongosh)).toEqual([
      'db.orders.find({})',
      'db.customers.find({}, { _id: 0, name: 1 })',
    ]);
    expect(results.map((result) => result.ok && result.translation.sql)).toEqual([
      'SELECT * FROM orders',
      'SELECT name FROM customers',
    ]);
  });

  it('records the span of each statement in the full text', () => {
    const text = '  SELECT * FROM orders;\n\nSELECT name FROM customers  ';
    const spans = translateSql(text).map((result) => result.ok && result.translation.span);
    expect(spans).toEqual([
      { start: 2, end: 22 },
      { start: 25, end: 51 },
    ]);
    expect(text.slice(25, 51)).toBe('SELECT name FROM customers');
  });

  it('splits at GO on its own line', () => {
    const text = 'SELECT * FROM orders\nGO\nSELECT name FROM customers\nGO\n';
    const results = translateSql(text);
    expect(results.map((result) => result.ok && result.translation.mongosh)).toEqual([
      'db.orders.find({})',
      'db.customers.find({}, { _id: 0, name: 1 })',
    ]);
  });

  it('splits at GO with Windows line endings', () => {
    const text = 'SELECT * FROM orders\r\nGO\r\nSELECT name FROM customers\r\n';
    const results = translateSql(text);
    expect(results.map((result) => result.ok && result.translation.sql)).toEqual([
      'SELECT * FROM orders',
      'SELECT name FROM customers',
    ]);
  });

  it('keeps a GO that is not alone on its line as a name', () => {
    const text = 'SELECT go FROM orders';
    expect(run(text)).toBe('db.orders.find({}, { _id: 0, go: 1 })');
  });

  it('keeps translating after a statement that fails', () => {
    const text = 'SELECT * FROM orders; SELEC; SELECT name FROM customers';
    const results = translateSql(text);
    expect(results).toHaveLength(3);
    expect(results[0]?.ok).toBe(true);
    expect(results[1]?.ok).toBe(false);
    expect(results[2]?.ok).toBe(true);
    const failed = results[1];
    if (!failed || failed.ok) throw new Error('expected the second statement to fail');
    expect(failed.span).toEqual({ start: 22, end: 27 });
    expect(failed.error.span).toEqual({ start: 22, end: 27 });
    expect(failed.error.message).toBe(
      'Only SELECT, UPDATE, DELETE, INSERT and TRUNCATE statements are supported',
    );
  });

  it('keeps translating after a translation failure', () => {
    const text = 'SELECT name FROM orders GROUP BY status;\nDELETE FROM orders WHERE a = 1';
    const results = translateSql(text);
    expect(results[0]?.ok).toBe(false);
    expect(results[1]?.ok && results[1].translation.mongosh).toBe('db.orders.deleteMany({ a: 1 })');
  });

  it('points the error span of a later statement into the full text', () => {
    const text = 'SELECT * FROM orders;\nSELECT * FROM orders WHERE x = @p';
    const [, second] = translateSql(text);
    if (!second || second.ok) throw new Error('expected the second statement to fail');
    expect(text.slice(second.error.span.start, second.error.span.end)).toBe('@p');
    expect(text.slice(second.span.start, second.span.end)).toBe(
      'SELECT * FROM orders WHERE x = @p',
    );
  });

  it('ignores a trailing comment after the last statement', () => {
    const text = 'SELECT * FROM orders; -- done';
    const results = translateSql(text);
    expect(results).toHaveLength(1);
    expect(results[0]?.ok && results[0].translation.sql).toBe('SELECT * FROM orders');
  });

  it('exposes the statement tree next to the mongosh text', () => {
    const [result] = translateSql("SELECT name FROM orders WHERE a = 'b'");
    if (!result || !result.ok) throw new Error('expected a translation');
    expect(result.translation.statement).toEqual({
      collection: 'orders',
      method: 'find',
      args: [{ a: 'b' }, { _id: 0, name: 1 }],
      chain: [],
      kind: 'read',
      unsafe: false,
    });
  });
});

describe('translateSqlStatement', () => {
  it('translates one statement', () => {
    const result = translateSqlStatement('SELECT * FROM orders WHERE a = 1');
    expect(result.ok && result.translation.mongosh).toBe('db.orders.find({ a: 1 })');
  });

  it('accepts a trailing semicolon and surrounding whitespace', () => {
    const result = translateSqlStatement('\n  SELECT * FROM orders;\n');
    expect(result.ok && result.translation.sql).toBe('SELECT * FROM orders');
    expect(result.ok && result.translation.span).toEqual({ start: 3, end: 23 });
  });

  it('reports empty text as an empty statement', () => {
    expect(translateSqlStatement('')).toEqual({
      ok: false,
      span: { start: 0, end: 0 },
      error: { message: 'the statement is empty', span: { start: 0, end: 0 } },
    });
    const blank = translateSqlStatement('  -- nothing\n');
    expect(blank.ok).toBe(false);
    expect(!blank.ok && blank.error.message).toBe('the statement is empty');
  });

  it('refuses text with several statements and points at the second', () => {
    const text = 'SELECT * FROM orders; SELECT * FROM customers';
    const result = translateSqlStatement(text);
    if (result.ok) throw new Error('expected an error');
    expect(result.error.message).toBe('expected one statement but found several');
    expect(text.slice(result.error.span.start, result.error.span.end)).toBe(
      'SELECT * FROM customers',
    );
    expect(result.span).toEqual({ start: 0, end: text.length });
  });

  it('returns parse and translation errors instead of throwing', () => {
    const parse = translateSqlStatement('SELECT * FROM');
    expect(!parse.ok && parse.error.message).toBe('expected a table name but the statement ended');
    const translation = translateSqlStatement('SELECT FOO(1) FROM orders');
    expect(!translation.ok && translation.error.message).toBe('function FOO is not supported');
  });

  it('passes the options through', () => {
    const result = translateSqlStatement("SELECT * FROM orders WHERE d = '2026-05-06'", {
      fieldType: () => 'date',
    });
    expect(result.ok && result.translation.mongosh).toBe(
      "db.orders.find({ d: ISODate('2026-05-06T00:00:00.000Z') })",
    );
  });
});

describe('sql module exports', () => {
  it('re-exports the pieces the editor needs', () => {
    expect(typeof splitSqlStatements).toBe('function');
    expect(new SqlError('x', { start: 0, end: 1 })).toBeInstanceOf(Error);
    expect(isMongoSpecial(mongoDate('2026-01-01T00:00:00.000Z'))).toBe(true);
    expect(isMongoSpecial(mongoNow())).toBe(true);
    expect(isMongoSpecial(mongoObjectId('507f1f77bcf86cd799439011'))).toBe(true);
    expect(isMongoSpecial(mongoRegex('a', 'i'))).toBe(true);
    expect(isMongoSpecial({ a: 1 })).toBe(false);
  });

  it('is reachable from the core package index', () => {
    const results: SqlTranslationResult[] = fromCoreIndex('SELECT * FROM orders');
    expect(results[0]?.ok && results[0].translation.mongosh).toBe('db.orders.find({})');
  });
});

// Regressions from the adversarial rounds, with the reported SQL as written.

describe('regression: reported defects end to end', () => {
  const customers =
    "{ $lookup: { from: 'customers', localField: 'customerId', foreignField: '_id', as: 'c' } }";

  it('reads a string compared with a CAST to DATETIME as a date', () => {
    expect(run("SELECT * FROM orders WHERE CAST(createdAt AS DATETIME) >= '2026-01-01'")).toBe(
      "db.orders.find({ $expr: { $gte: [{ $toDate: '$createdAt' }, ISODate('2026-01-01T00:00:00.000Z')] } })",
    );
  });

  it('gives an explicit alias priority over an earlier unaliased column', () => {
    expect(
      run('SELECT o.name, c.name AS name FROM orders o JOIN customers c ON o.customerId = c._id'),
    ).toBe(
      pipeline('orders', [
        customers,
        "{ $unwind: '$c' }",
        "{ $project: { _id: 0, name2: '$name', name: '$c.name' } }",
      ]),
    );
  });

  it('gives a key alias priority over the default name of an earlier key', () => {
    expect(
      run(
        'SELECT r.name AS name, c.name, COUNT(*) AS n FROM orders o JOIN customers c ON o.customerId = c._id JOIN regions r ON c.regionId = r._id GROUP BY c.name, r.name',
      ),
    ).toBe(
      pipeline('orders', [
        customers,
        "{ $unwind: '$c' }",
        "{ $lookup: { from: 'regions', localField: 'c.regionId', foreignField: '_id', as: 'r' } }",
        "{ $unwind: '$r' }",
        "{ $group: { _id: { name2: '$c.name', name: '$r.name' }, n: { $sum: 1 } } }",
        "{ $project: { _id: 0, name: '$_id.name', name2: '$_id.name2', n: 1 } }",
      ]),
    );
  });

  it('sorts by a hidden COUNT(DISTINCT) through an $addFields', () => {
    expect(
      run(
        'SELECT o.status FROM orders o JOIN customers c ON o.customerId = c._id GROUP BY o.status ORDER BY COUNT(DISTINCT c.name) DESC',
      ),
    ).toBe(
      pipeline('orders', [
        customers,
        "{ $unwind: '$c' }",
        "{ $group: { _id: '$status', count_c_name: { $addToSet: '$c.name' } } }",
        "{ $addFields: { count_c_name: { $size: { $filter: { input: '$count_c_name', cond: { $ne: ['$$this', null] } } } } } }",
        '{ $sort: { count_c_name: -1 } }',
        "{ $project: { _id: 0, status: '$_id' } }",
      ]),
    );
  });

  it('ends the batch at GO followed by a line comment', () => {
    expect(run('SELECT t.a FROM t\nGO -- run it')).toBe('db.t.find({}, { _id: 0, a: 1 })');
  });

  it('escapes the closing bracket class', () => {
    expect(run("SELECT * FROM t WHERE s LIKE '[]]'")).toBe('db.t.find({ s: /^\\]$/i })');
  });

  it('refuses a number literal that overflows', () => {
    expect(fail('SELECT * FROM t WHERE a = 1e400')).toEqual({
      message: 'the floating point value is out of range',
      at: '1e400',
    });
    expect(fail("SELECT * FROM t WHERE a = CAST('1e400' AS FLOAT)")).toEqual({
      message: 'the floating point value is out of range',
      at: "CAST('1e400' AS FLOAT)",
    });
  });

  it('drops NULL from an IN list and refuses it in NOT IN', () => {
    expect(run('SELECT * FROM t WHERE x IN (1, NULL)')).toBe('db.t.find({ x: { $in: [1] } })');
    expect(fail('SELECT * FROM t WHERE x NOT IN (1, NULL)')).toEqual({
      message: 'NOT IN with NULL matches no row in SQL Server, remove the NULL from the list',
      at: 'NULL',
    });
  });

  it('casts an empty or blank string to the integer types as 0', () => {
    expect(run("INSERT INTO t (a, b) VALUES (CAST('' AS INT), CAST(' ' AS BIGINT))")).toBe(
      'db.t.insertMany([{ a: 0, b: 0 }])',
    );
  });

  it('reads a US date as midnight UTC', () => {
    expect(run("SELECT * FROM t WHERE d = CAST('1/2/2026' AS DATE)")).toBe(
      "db.t.find({ d: ISODate('2026-01-02T00:00:00.000Z') })",
    );
    expect(fail("SELECT * FROM t WHERE d = CAST('January 2, 2026' AS DATE)")).toEqual({
      message: "'January 2, 2026' is not a valid date",
      at: "CAST('January 2, 2026' AS DATE)",
    });
  });

  it('drops the time of day when casting to DATE', () => {
    expect(run("SELECT * FROM t WHERE d < CAST('2026-01-05 13:00' AS DATE)")).toBe(
      "db.t.find({ d: { $lt: ISODate('2026-01-05T00:00:00.000Z') } })",
    );
    expect(run("SELECT * FROM t WHERE d < CONVERT(DATETIME, '2026-01-05 13:00')")).toBe(
      "db.t.find({ d: { $lt: ISODate('2026-01-05T13:00:00.000Z') } })",
    );
  });

  it('turns a number literal into a string for a string field', () => {
    const options: TranslateOptions = {
      fieldType: (collection, path) =>
        collection === 't' && path === 'code' ? 'string' : undefined,
    };
    expect(run('SELECT * FROM t WHERE code = 42', options)).toBe("db.t.find({ code: '42' })");
  });

  it('refuses an UPDATE that assigns a column twice or sets overlapping paths', () => {
    expect(fail('UPDATE t SET a = 1, a = 2')).toEqual({
      message: 'UPDATE column a is assigned twice',
      at: 'a',
    });
    expect(fail('UPDATE t SET a.b = 1, a = 2')).toEqual({
      message: 'UPDATE column a overlaps another column',
      at: 'a',
    });
  });

  it('refuses SELECT INTO a temp table at INTO and a temp table in FROM', () => {
    expect(fail('SELECT a INTO #tmp FROM t')).toEqual({
      message: 'SELECT ... INTO is not supported',
      at: 'INTO',
    });
    expect(fail('SELECT * FROM #tmp')).toEqual({
      message: 'temporary tables are not supported',
      at: '#tmp',
    });
  });
});
