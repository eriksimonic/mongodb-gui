/**
 * End-to-end cases that check the SQL semantics a SQL Server user expects from the translator:
 * NULL handling, operator precedence, LIKE edge cases, string and number plus, division, BETWEEN,
 * IN, CASE, ORDER BY on aliases and group keys, TOP, OFFSET, DISTINCT, COUNT, HAVING, deep dotted
 * paths and `_id`. Each case asserts the mongosh text that returns the rows SQL Server would, under
 * the rules of the design contract. Where the contract is silent, the comment on the case says
 * which output was chosen and why.
 */
import { describe, expect, it } from 'vitest';
import { translateSql, type TranslateOptions } from './index';

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

/** A schema hint table keyed by `collection.path`. */
function hints(table: Record<string, 'date' | 'objectId' | 'number' | 'string' | 'bool'>) {
  return {
    fieldType: (collection: string, path: string) => table[`${collection}.${path}`],
  } satisfies TranslateOptions;
}

const OID = '507f1f77bcf86cd799439011';

describe('NULL handling', () => {
  it.each([
    // A document without the field is a SQL NULL, and { x: null } matches missing fields too.
    ['SELECT * FROM orders WHERE status IS NULL', 'db.orders.find({ status: null })'],
    ['SELECT * FROM orders WHERE status IS NOT NULL', 'db.orders.find({ status: { $ne: null } })'],
    // NOT of a plain equality document is $nor per the contract.
    [
      'SELECT * FROM orders WHERE NOT status IS NULL',
      'db.orders.find({ $nor: [{ status: null }] })',
    ],
    // The contract maps `column = literal` to a plain equality and NULL is a literal. SQL Server
    // would return no rows for `= NULL` since the comparison is unknown; the plain null match is
    // what a user who writes `= NULL` almost always means.
    ['SELECT * FROM orders WHERE status = NULL', 'db.orders.find({ status: null })'],
    [
      'SELECT * FROM orders WHERE ISNULL(total, 0) > 5',
      "db.orders.find({ $expr: { $gt: [{ $ifNull: ['$total', 0] }, 5] } })",
    ],
    [
      'UPDATE orders SET note = NULL WHERE _id = 5',
      'db.orders.updateMany({ _id: 5 }, { $set: { note: null } })',
    ],
    ['DELETE FROM orders WHERE note IS NULL', 'db.orders.deleteMany({ note: null })'],
  ])('%s', (sql, expected) => {
    expect(run(sql)).toBe(expected);
  });

  it('ISNULL in the select list is $ifNull', () => {
    expect(run("SELECT ISNULL(note, '') AS note FROM orders")).toBe(
      pipeline('orders', ["{ $project: { _id: 0, note: { $ifNull: ['$note', ''] } } }"]),
    );
  });

  it('COALESCE with three arguments nests $ifNull', () => {
    expect(run('SELECT COALESCE(a, b, 0) AS v FROM orders')).toBe(
      pipeline('orders', [
        "{ $project: { _id: 0, v: { $ifNull: ['$a', { $ifNull: ['$b', 0] }] } } }",
      ]),
    );
  });

  it('NULLIF returns null when both sides are equal', () => {
    expect(run("SELECT NULLIF(status, '') AS s FROM orders")).toBe(
      pipeline('orders', [
        "{ $project: { _id: 0, s: { $cond: [{ $eq: ['$status', ''] }, null, '$status'] } } }",
      ]),
    );
  });

  it('IS NULL inside CASE uses $ifNull so a missing field counts as null', () => {
    expect(run("SELECT CASE WHEN note IS NULL THEN 'none' ELSE note END AS n FROM orders")).toBe(
      pipeline('orders', [
        "{ $project: { _id: 0, n: { $switch: { branches: [{ case: { $eq: [{ $ifNull: ['$note', null] }, null] }, then: 'none' }], default: '$note' } } } }",
      ]),
    );
  });

  it('COUNT(column) skips null and missing values', () => {
    expect(run('SELECT COUNT(note) AS n FROM orders')).toBe(
      pipeline('orders', [
        "{ $group: { _id: null, n: { $sum: { $cond: [{ $gt: ['$note', null] }, 1, 0] } } } }",
        '{ $project: { _id: 0, n: 1 } }',
      ]),
    );
  });

  it('adding NULL yields null, as in SQL', () => {
    expect(run('SELECT total + NULL AS t FROM orders')).toBe(
      pipeline('orders', ["{ $project: { _id: 0, t: { $add: ['$total', null] } } }"]),
    );
  });
});

describe('operator precedence', () => {
  it.each([
    // AND binds tighter than OR.
    [
      'SELECT * FROM orders WHERE a = 1 OR b = 2 AND c = 3',
      'db.orders.find({ $or: [{ a: 1 }, { b: 2, c: 3 }] })',
    ],
    [
      'SELECT * FROM orders WHERE (a = 1 OR b = 2) AND c = 3',
      'db.orders.find({ $or: [{ a: 1 }, { b: 2 }], c: 3 })',
    ],
    [
      'SELECT * FROM orders WHERE a = 1 AND b = 2 OR c = 3 AND d = 4',
      'db.orders.find({ $or: [{ a: 1, b: 2 }, { c: 3, d: 4 }] })',
    ],
    // NOT binds tighter than AND and OR.
    [
      'SELECT * FROM orders WHERE NOT a = 1 AND b = 2',
      'db.orders.find({ $nor: [{ a: 1 }], b: 2 })',
    ],
    [
      'SELECT * FROM orders WHERE NOT (a = 1 AND b = 2)',
      'db.orders.find({ $nor: [{ a: 1, b: 2 }] })',
    ],
    [
      'SELECT * FROM orders WHERE NOT a > 1 OR b = 2',
      'db.orders.find({ $or: [{ a: { $not: { $gt: 1 } } }, { b: 2 }] })',
    ],
    [
      'SELECT * FROM orders WHERE NOT NOT a = 1',
      'db.orders.find({ $nor: [{ $nor: [{ a: 1 }] }] })',
    ],
    // Comparison binds looser than arithmetic.
    [
      'SELECT * FROM orders WHERE total + 1 > 5',
      "db.orders.find({ $expr: { $gt: [{ $add: ['$total', 1] }, 5] } })",
    ],
    // A literal on the left flips the operator.
    ['SELECT * FROM orders WHERE 5 < total', 'db.orders.find({ total: { $gt: 5 } })'],
    ["SELECT * FROM orders WHERE 'a' = status", "db.orders.find({ status: 'a' })"],
    // Unary minus folds into the literal.
    ['SELECT * FROM orders WHERE total = -(5)', 'db.orders.find({ total: -5 })'],
    ['SELECT * FROM orders WHERE total > -5', 'db.orders.find({ total: { $gt: -5 } })'],
    // Two conditions on one field cannot share a key, so the contract wraps them in $and.
    [
      'SELECT * FROM orders WHERE total > 10 AND total < 100',
      'db.orders.find({ $and: [{ total: { $gt: 10 } }, { total: { $lt: 100 } }] })',
    ],
    // BETWEEN consumes its own AND before the conjunction.
    [
      "SELECT * FROM orders WHERE total BETWEEN 1 AND 10 AND status = 'a'",
      "db.orders.find({ total: { $gte: 1, $lte: 10 }, status: 'a' })",
    ],
    [
      "SELECT * FROM orders WHERE status = 'a' AND NOT total > 5 OR x = 1",
      "db.orders.find({ $or: [{ status: 'a', total: { $not: { $gt: 5 } } }, { x: 1 }] })",
    ],
  ])('%s', (sql, expected) => {
    expect(run(sql)).toBe(expected);
  });

  it.each([
    [
      'SELECT total + tax * 2 AS t FROM orders',
      "{ $project: { _id: 0, t: { $add: ['$total', { $multiply: ['$tax', 2] }] } } }",
    ],
    [
      'SELECT (total + tax) * 2 AS t FROM orders',
      "{ $project: { _id: 0, t: { $multiply: [{ $add: ['$total', '$tax'] }, 2] } } }",
    ],
    // Subtraction and division are left associative.
    [
      'SELECT total - 3 - 2 AS t FROM orders',
      "{ $project: { _id: 0, t: { $subtract: [{ $subtract: ['$total', 3] }, 2] } } }",
    ],
    [
      'SELECT 100 / total / 2 AS t FROM orders',
      "{ $project: { _id: 0, t: { $divide: [{ $divide: [100, '$total'] }, 2] } } }",
    ],
    // Unary minus binds tighter than multiplication.
    [
      'SELECT -total * 2 AS t FROM orders',
      "{ $project: { _id: 0, t: { $multiply: [{ $multiply: [-1, '$total'] }, 2] } } }",
    ],
    [
      'SELECT -(total + 1) AS t FROM orders',
      "{ $project: { _id: 0, t: { $multiply: [-1, { $add: ['$total', 1] }] } } }",
    ],
    [
      'SELECT total % 7 * 2 AS t FROM orders',
      "{ $project: { _id: 0, t: { $multiply: [{ $mod: ['$total', 7] }, 2] } } }",
    ],
  ])('%s', (sql, stage) => {
    expect(run(sql)).toBe(pipeline('orders', [stage]));
  });
});

describe('LIKE edge cases', () => {
  it.each([
    ["SELECT * FROM orders WHERE name LIKE 'a%b'", 'db.orders.find({ name: /^a.*b$/i })'],
    ["SELECT * FROM orders WHERE name LIKE '%a%b%'", 'db.orders.find({ name: /a.*b/i })'],
    ["SELECT * FROM orders WHERE name LIKE 'a_c'", 'db.orders.find({ name: /^a.c$/i })'],
    // A bracketed underscore or percent is literal in SQL Server and in the regex class.
    ["SELECT * FROM orders WHERE name LIKE 'a[_]c'", 'db.orders.find({ name: /^a[_]c$/i })'],
    ["SELECT * FROM orders WHERE name LIKE '50[%]'", 'db.orders.find({ name: /^50[%]$/i })'],
    [
      "SELECT * FROM orders WHERE name LIKE '[0-9][0-9]%'",
      'db.orders.find({ name: /^[0-9][0-9]/i })',
    ],
    ["SELECT * FROM orders WHERE name LIKE '[^0-9]%'", 'db.orders.find({ name: /^[^0-9]/i })'],
    // ESCAPE makes the next character literal.
    [
      "SELECT * FROM orders WHERE name LIKE '100!%' ESCAPE '!'",
      'db.orders.find({ name: /^100%$/i })',
    ],
    [
      "SELECT * FROM orders WHERE name LIKE 'a!_c' ESCAPE '!'",
      'db.orders.find({ name: /^a_c$/i })',
    ],
    ["SELECT * FROM orders WHERE name LIKE '!%' ESCAPE '!'", 'db.orders.find({ name: /^%$/i })'],
    ["SELECT * FROM orders WHERE name LIKE '%!%' ESCAPE '!'", 'db.orders.find({ name: /%$/i })'],
    // Regex metacharacters in the pattern are escaped.
    [
      "SELECT * FROM orders WHERE name LIKE '(x)+$'",
      'db.orders.find({ name: /^\\(x\\)\\+\\$$/i })',
    ],
    ["SELECT * FROM orders WHERE name LIKE '%.com'", 'db.orders.find({ name: /\\.com$/i })'],
    ["SELECT * FROM orders WHERE name LIKE 'a\\b'", 'db.orders.find({ name: /^a\\\\b$/i })'],
    // An unmatched bracket is a literal bracket.
    ["SELECT * FROM orders WHERE name LIKE 'a[b'", 'db.orders.find({ name: /^a\\[b$/i })'],
    // '%' alone matches every string, '' only the empty string.
    ["SELECT * FROM orders WHERE name LIKE '%'", 'db.orders.find({ name: /.*/i })'],
    ["SELECT * FROM orders WHERE name LIKE ''", 'db.orders.find({ name: /^$/i })'],
    ["SELECT * FROM orders WHERE name LIKE 'it''s%'", "db.orders.find({ name: /^it's/i })"],
    ["SELECT * FROM orders WHERE name NOT LIKE '%x%'", 'db.orders.find({ name: { $not: /x/i } })'],
    [
      "SELECT * FROM orders WHERE name LIKE 'a%' OR name LIKE 'b%'",
      'db.orders.find({ $or: [{ name: /^a/i }, { name: /^b/i }] })',
    ],
    // LIKE on a computed value falls back to $regexMatch.
    [
      "SELECT * FROM orders WHERE UPPER(name) LIKE 'A%'",
      "db.orders.find({ $expr: { $regexMatch: { input: { $toUpper: '$name' }, regex: /^A/i } } })",
    ],
    // Case insensitive, as SQL Server's default collation is.
    ["SELECT * FROM orders WHERE name LIKE 'ABC'", 'db.orders.find({ name: /^ABC$/i })'],
  ])('%s', (sql, expected) => {
    expect(run(sql)).toBe(expected);
  });
});

describe('string versus number plus', () => {
  it.each([
    [
      "SELECT 'Mr ' + name AS greeting FROM orders",
      "{ $project: { _id: 0, greeting: { $concat: ['Mr ', '$name'] } } }",
    ],
    [
      "SELECT first + ' ' + last AS fullName FROM orders",
      "{ $project: { _id: 0, fullName: { $concat: ['$first', ' ', '$last'] } } }",
    ],
    ['SELECT total + 1 AS t FROM orders', "{ $project: { _id: 0, t: { $add: ['$total', 1] } } }"],
    // Without hints two columns add as numbers.
    [
      'SELECT total + tax AS t FROM orders',
      "{ $project: { _id: 0, t: { $add: ['$total', '$tax'] } } }",
    ],
    [
      "SELECT CONCAT(first, ' ', last) AS fullName FROM orders",
      "{ $project: { _id: 0, fullName: { $concat: ['$first', ' ', '$last'] } } }",
    ],
    // A string cast or a string function on one side makes the plus a concatenation.
    [
      "SELECT CAST(total AS NVARCHAR(20)) + ' EUR' AS t FROM orders",
      "{ $project: { _id: 0, t: { $concat: [{ $toString: '$total' }, ' EUR'] } } }",
    ],
    [
      'SELECT UPPER(first) + last AS t FROM orders',
      "{ $project: { _id: 0, t: { $concat: [{ $toUpper: '$first' }, '$last'] } } }",
    ],
  ])('%s', (sql, stage) => {
    expect(run(sql)).toBe(pipeline('orders', [stage]));
  });

  it('two string columns concatenate when the schema says they are strings', () => {
    const options = hints({ 'orders.first': 'string', 'orders.last': 'string' });
    expect(run('SELECT first + last AS fullName FROM orders', options)).toBe(
      pipeline('orders', ["{ $project: { _id: 0, fullName: { $concat: ['$first', '$last'] } } }"]),
    );
  });

  it('two number columns add when the schema says they are numbers', () => {
    const options = hints({ 'orders.qty': 'number', 'orders.price': 'number' });
    expect(run('SELECT qty + price AS t FROM orders', options)).toBe(
      pipeline('orders', ["{ $project: { _id: 0, t: { $add: ['$qty', '$price'] } } }"]),
    );
  });
});

describe('division and modulo', () => {
  it.each([
    // The contract maps / to $divide. SQL Server's integer truncation for int operands is not
    // reproduced; a user who wants it writes FLOOR.
    [
      'SELECT total / 2 AS half FROM orders',
      "{ $project: { _id: 0, half: { $divide: ['$total', 2] } } }",
    ],
    ['SELECT total % 3 AS r FROM orders', "{ $project: { _id: 0, r: { $mod: ['$total', 3] } } }"],
    [
      'SELECT FLOOR(total / 2) AS half FROM orders',
      "{ $project: { _id: 0, half: { $floor: { $divide: ['$total', 2] } } } }",
    ],
  ])('%s', (sql, stage) => {
    expect(run(sql)).toBe(pipeline('orders', [stage]));
  });

  it('a division in WHERE becomes $expr', () => {
    expect(run('SELECT * FROM orders WHERE total / 2 > 10')).toBe(
      "db.orders.find({ $expr: { $gt: [{ $divide: ['$total', 2] }, 10] } })",
    );
  });

  it('divides two aggregates in the output', () => {
    expect(run('SELECT status, SUM(total) / COUNT(*) AS avg FROM orders GROUP BY status')).toBe(
      pipeline('orders', [
        "{ $group: { _id: '$status', sum_total: { $sum: '$total' }, count: { $sum: 1 } } }",
        "{ $project: { _id: 0, status: '$_id', avg: { $divide: ['$sum_total', '$count'] } } }",
      ]),
    );
  });
});

describe('BETWEEN', () => {
  it.each([
    [
      'SELECT * FROM orders WHERE total BETWEEN 1 AND 10',
      'db.orders.find({ total: { $gte: 1, $lte: 10 } })',
    ],
    // SQL Server returns no rows when the low bound is above the high bound, and so does this
    // filter. The bounds are not swapped.
    [
      'SELECT * FROM orders WHERE total BETWEEN 10 AND 1',
      'db.orders.find({ total: { $gte: 10, $lte: 1 } })',
    ],
    [
      'SELECT * FROM orders WHERE total BETWEEN 5 AND 5',
      'db.orders.find({ total: { $gte: 5, $lte: 5 } })',
    ],
    [
      'SELECT * FROM orders WHERE total BETWEEN -5 AND 5',
      'db.orders.find({ total: { $gte: -5, $lte: 5 } })',
    ],
    [
      "SELECT * FROM orders WHERE name BETWEEN 'a' AND 'm'",
      "db.orders.find({ name: { $gte: 'a', $lte: 'm' } })",
    ],
    [
      'SELECT * FROM orders WHERE total NOT BETWEEN 1 AND 10',
      'db.orders.find({ total: { $not: { $gte: 1, $lte: 10 } } })',
    ],
    // Column bounds need an aggregation expression.
    [
      'SELECT * FROM orders WHERE total BETWEEN low AND high',
      "db.orders.find({ $expr: { $and: [{ $gte: ['$total', '$low'] }, { $lte: ['$total', '$high'] }] } })",
    ],
  ])('%s', (sql, expected) => {
    expect(run(sql)).toBe(expected);
  });

  it('coerces both bounds to dates from the schema hint', () => {
    const options = hints({ 'orders.createdAt': 'date' });
    expect(
      run("SELECT * FROM orders WHERE createdAt BETWEEN '2026-01-01' AND '2026-02-01'", options),
    ).toBe(
      "db.orders.find({ createdAt: { $gte: ISODate('2026-01-01T00:00:00.000Z'), $lte: ISODate('2026-02-01T00:00:00.000Z') } })",
    );
  });
});

describe('IN', () => {
  it.each([
    [
      "SELECT * FROM orders WHERE status IN ('a', 'b')",
      "db.orders.find({ status: { $in: ['a', 'b'] } })",
    ],
    ["SELECT * FROM orders WHERE status IN ('a')", "db.orders.find({ status: { $in: ['a'] } })"],
    // Without a hint a quoted number stays a string.
    [
      "SELECT * FROM orders WHERE code IN (1, 2, '3')",
      "db.orders.find({ code: { $in: [1, 2, '3'] } })",
    ],
    // SQL Server never matches the NULL entry, while `$in` with null would also return rows where
    // the field is null or missing, so the NULL is dropped from the list.
    [
      "SELECT * FROM orders WHERE status IN ('a', NULL)",
      "db.orders.find({ status: { $in: ['a'] } })",
    ],
    [
      "SELECT * FROM orders WHERE status NOT IN ('a', 'b')",
      "db.orders.find({ status: { $nin: ['a', 'b'] } })",
    ],
    [
      'SELECT * FROM orders WHERE total IN (-1, 0.5, 1e3)',
      'db.orders.find({ total: { $in: [-1, 0.5, 1000] } })',
    ],
    [
      'SELECT * FROM orders WHERE total IN (tax, 5)',
      "db.orders.find({ $expr: { $in: ['$total', ['$tax', 5]] } })",
    ],
    [
      "SELECT * FROM orders WHERE NOT status IN ('a')",
      "db.orders.find({ status: { $not: { $in: ['a'] } } })",
    ],
    [
      "SELECT * FROM orders WHERE createdAt IN (CAST('2026-01-01' AS DATE))",
      "db.orders.find({ createdAt: { $in: [ISODate('2026-01-01T00:00:00.000Z')] } })",
    ],
    [
      'SELECT * FROM orders WHERE active IN (TRUE, FALSE)',
      'db.orders.find({ active: { $in: [true, false] } })',
    ],
  ])('%s', (sql, expected) => {
    expect(run(sql)).toBe(expected);
  });

  it('coerces quoted numbers in the list when the field is a number', () => {
    const options = hints({ 'orders.code': 'number' });
    expect(run("SELECT * FROM orders WHERE code IN (1, 2, '3')", options)).toBe(
      'db.orders.find({ code: { $in: [1, 2, 3] } })',
    );
  });

  it('coerces only the 24 hex entries when the field is an ObjectId', () => {
    const options = hints({ 'orders._id': 'objectId' });
    expect(run(`SELECT * FROM orders WHERE _id IN ('${OID}', 'abc')`, options)).toBe(
      `db.orders.find({ _id: { $in: [ObjectId('${OID}'), 'abc'] } })`,
    );
  });

  it('coerces 1 and 0 to booleans when the field is a bool', () => {
    const options = hints({ 'orders.active': 'bool' });
    expect(run('SELECT * FROM orders WHERE active IN (1, 0)', options)).toBe(
      'db.orders.find({ active: { $in: [true, false] } })',
    );
  });
});

describe('CASE', () => {
  it.each([
    // No ELSE means NULL.
    [
      "SELECT CASE WHEN total > 10 THEN 'big' END AS size FROM orders",
      "{ $project: { _id: 0, size: { $switch: { branches: [{ case: { $gt: ['$total', 10] }, then: 'big' }], default: null } } } }",
    ],
    [
      "SELECT CASE status WHEN 'a' THEN 1 END AS code FROM orders",
      "{ $project: { _id: 0, code: { $switch: { branches: [{ case: { $eq: ['$status', 'a'] }, then: 1 }], default: null } } } }",
    ],
    [
      "SELECT CASE WHEN total > 10 THEN NULL ELSE 'small' END AS size FROM orders",
      "{ $project: { _id: 0, size: { $switch: { branches: [{ case: { $gt: ['$total', 10] }, then: null }], default: 'small' } } } }",
    ],
    [
      "SELECT CASE WHEN total > 100 THEN 'big' ELSE CASE WHEN total > 10 THEN 'mid' ELSE 'small' END END AS size FROM orders",
      "{ $project: { _id: 0, size: { $switch: { branches: [{ case: { $gt: ['$total', 100] }, then: 'big' }], default: { $switch: { branches: [{ case: { $gt: ['$total', 10] }, then: 'mid' }], default: 'small' } } } } } }",
    ],
    [
      "SELECT CASE WHEN status = 'a' AND total > 1 THEN 1 WHEN status = 'b' THEN 2 ELSE 0 END AS code FROM orders",
      "{ $project: { _id: 0, code: { $switch: { branches: [{ case: { $and: [{ $eq: ['$status', 'a'] }, { $gt: ['$total', 1] }] }, then: 1 }, { case: { $eq: ['$status', 'b'] }, then: 2 }], default: 0 } } } }",
    ],
  ])('%s', (sql, stage) => {
    expect(run(sql)).toBe(pipeline('orders', [stage]));
  });

  it('a CASE inside SUM is the conditional count idiom', () => {
    expect(
      run(
        "SELECT region, SUM(CASE WHEN status = 'paid' THEN total ELSE 0 END) AS paid FROM orders GROUP BY region",
      ),
    ).toBe(
      pipeline('orders', [
        "{ $group: { _id: '$region', paid: { $sum: { $switch: { branches: [{ case: { $eq: ['$status', 'paid'] }, then: '$total' }], default: 0 } } } } }",
        "{ $project: { _id: 0, region: '$_id', paid: 1 } }",
      ]),
    );
  });

  it('a CASE in WHERE becomes $expr', () => {
    expect(run('SELECT * FROM orders WHERE CASE WHEN total > 10 THEN 1 ELSE 0 END = 1')).toBe(
      "db.orders.find({ $expr: { $eq: [{ $switch: { branches: [{ case: { $gt: ['$total', 10] }, then: 1 }], default: 0 } }, 1] } })",
    );
  });

  it('a CASE in ORDER BY is refused by the contract', () => {
    expect(fail('SELECT name FROM orders ORDER BY CASE WHEN total > 10 THEN 1 ELSE 0 END')).toEqual(
      {
        message: 'ORDER BY must name a column, a select alias or an aggregate',
        at: 'CASE WHEN total > 10 THEN 1 ELSE 0 END',
      },
    );
  });
});

describe('ORDER BY on an alias or a group key', () => {
  it('sorts by the alias after the projection', () => {
    expect(run('SELECT name AS n FROM orders ORDER BY n')).toBe(
      pipeline('orders', ["{ $project: { _id: 0, n: '$name' } }", '{ $sort: { n: 1 } }']),
    );
  });

  it('sorts by a column outside the select list before the projection drops it', () => {
    expect(run('SELECT name AS n FROM orders ORDER BY total')).toBe(
      pipeline('orders', ['{ $sort: { total: 1 } }', "{ $project: { _id: 0, n: '$name' } }"]),
    );
  });

  it('sorts by an alias and a hidden column together, by their paths before the projection', () => {
    // The contract does not say how a mixed ORDER BY is placed. Sorting by the underlying paths
    // before the projection gives the rows SQL Server gives.
    expect(run('SELECT name AS n FROM orders ORDER BY n, total DESC')).toBe(
      pipeline('orders', [
        '{ $sort: { name: 1, total: -1 } }',
        "{ $project: { _id: 0, n: '$name' } }",
      ]),
    );
  });

  it('sorts by a group key through its output name', () => {
    expect(
      run('SELECT status, COUNT(*) AS n FROM orders GROUP BY status ORDER BY status DESC'),
    ).toBe(
      pipeline('orders', [
        "{ $group: { _id: '$status', n: { $sum: 1 } } }",
        "{ $project: { _id: 0, status: '$_id', n: 1 } }",
        '{ $sort: { status: -1 } }',
      ]),
    );
  });

  it('sorts by two group keys in ORDER BY order', () => {
    expect(
      run(
        'SELECT status, region, COUNT(*) AS n FROM orders GROUP BY status, region ORDER BY region, status DESC',
      ),
    ).toBe(
      pipeline('orders', [
        "{ $group: { _id: { status: '$status', region: '$region' }, n: { $sum: 1 } } }",
        "{ $project: { _id: 0, status: '$_id.status', region: '$_id.region', n: 1 } }",
        '{ $sort: { region: 1, status: -1 } }',
      ]),
    );
  });

  it('sorts by the aliased group key when ORDER BY names the column', () => {
    expect(
      run('SELECT status AS s, COUNT(*) AS n FROM orders GROUP BY status ORDER BY status'),
    ).toBe(
      pipeline('orders', [
        "{ $group: { _id: '$status', n: { $sum: 1 } } }",
        "{ $project: { _id: 0, s: '$_id', n: 1 } }",
        '{ $sort: { s: 1 } }',
      ]),
    );
  });

  it('sorts by an aggregate that the select list aliases', () => {
    expect(
      run('SELECT status, COUNT(*) AS n FROM orders GROUP BY status ORDER BY COUNT(*) DESC'),
    ).toBe(
      pipeline('orders', [
        "{ $group: { _id: '$status', n: { $sum: 1 } } }",
        "{ $project: { _id: 0, status: '$_id', n: 1 } }",
        '{ $sort: { n: -1 } }',
      ]),
    );
  });

  it('sorts by a hidden aggregate before the projection', () => {
    expect(run('SELECT status FROM orders GROUP BY status ORDER BY COUNT(*) DESC')).toBe(
      pipeline('orders', [
        "{ $group: { _id: '$status', count: { $sum: 1 } } }",
        '{ $sort: { count: -1 } }',
        "{ $project: { _id: 0, status: '$_id' } }",
      ]),
    );
  });

  it('sorts by a grouped expression through its alias', () => {
    expect(
      run(
        'SELECT YEAR(createdAt) AS y, COUNT(*) AS n FROM orders GROUP BY YEAR(createdAt) ORDER BY YEAR(createdAt)',
      ),
    ).toBe(
      pipeline('orders', [
        "{ $group: { _id: { $year: '$createdAt' }, n: { $sum: 1 } } }",
        "{ $project: { _id: 0, y: '$_id', n: 1 } }",
        '{ $sort: { y: 1 } }',
      ]),
    );
  });

  it('sorts by a dotted group key through its last part', () => {
    expect(
      run(
        'SELECT address.city, COUNT(*) AS n FROM orders GROUP BY address.city ORDER BY address.city',
      ),
    ).toBe(
      pipeline('orders', [
        "{ $group: { _id: '$address.city', n: { $sum: 1 } } }",
        "{ $project: { _id: 0, city: '$_id', n: 1 } }",
        '{ $sort: { city: 1 } }',
      ]),
    );
  });

  it('sorts by a joined column that is projected under its own name', () => {
    expect(
      run(
        'SELECT o.total, c.name FROM orders o JOIN customers c ON o.customerId = c._id ORDER BY c.name',
      ),
    ).toBe(
      pipeline('orders', [
        "{ $lookup: { from: 'customers', localField: 'customerId', foreignField: '_id', as: 'c' } }",
        "{ $unwind: '$c' }",
        "{ $project: { _id: 0, total: 1, name: '$c.name' } }",
        '{ $sort: { name: 1 } }',
      ]),
    );
  });

  it('refuses an ordinal ORDER BY', () => {
    expect(fail('SELECT name FROM orders ORDER BY 1')).toEqual({
      message: 'ORDER BY must name a column, a select alias or an aggregate',
      at: '1',
    });
  });

  it('refuses an arithmetic ORDER BY', () => {
    expect(fail('SELECT name FROM orders ORDER BY total * 2')).toEqual({
      message: 'ORDER BY must name a column, a select alias or an aggregate',
      at: 'total * 2',
    });
  });
});

describe('TOP', () => {
  it.each([
    // Sort first, then limit, or TOP picks the wrong rows.
    [
      'SELECT TOP 5 * FROM orders ORDER BY total DESC',
      'db.orders.find({}).sort({ total: -1 }).limit(5)',
    ],
    [
      'SELECT TOP (5) * FROM orders ORDER BY total DESC',
      'db.orders.find({}).sort({ total: -1 }).limit(5)',
    ],
    ['SELECT TOP 5 * FROM orders', 'db.orders.find({}).limit(5)'],
    [
      "SELECT TOP 1 name FROM orders WHERE status = 'a' ORDER BY createdAt DESC",
      "db.orders.find({ status: 'a' }, { _id: 0, name: 1 }).sort({ createdAt: -1 }).limit(1)",
    ],
  ])('%s', (sql, expected) => {
    expect(run(sql)).toBe(expected);
  });

  it('limits a grouped query after its sort', () => {
    expect(
      run('SELECT TOP 3 status, SUM(total) AS s FROM orders GROUP BY status ORDER BY s DESC'),
    ).toBe(
      pipeline('orders', [
        "{ $group: { _id: '$status', s: { $sum: '$total' } } }",
        "{ $project: { _id: 0, status: '$_id', s: 1 } }",
        '{ $sort: { s: -1 } }',
        '{ $limit: 3 }',
      ]),
    );
  });

  it('TOP 0 does not become limit(0), which mongosh reads as no limit', () => {
    // SQL Server returns zero rows for TOP 0. The contract is silent, so either an error or a
    // statement that returns nothing is acceptable; `.limit(0)` returns every row.
    const [result] = translateSql('SELECT TOP 0 * FROM orders');
    if (result?.ok) {
      expect(result.translation.mongosh).not.toContain('limit(0)');
    } else {
      expect(result?.ok).toBe(false);
    }
  });

  it('refuses TOP together with OFFSET and FETCH, as SQL Server does', () => {
    expect(
      fail('SELECT TOP 5 name FROM orders ORDER BY name OFFSET 2 ROWS FETCH NEXT 3 ROWS ONLY')
        .message,
    ).toBe('TOP cannot be combined with OFFSET and FETCH');
  });
});

describe('OFFSET and FETCH', () => {
  it.each([
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
  ])('%s', (sql, expected) => {
    expect(run(sql)).toBe(expected);
  });

  it('skips without a limit in a pipeline', () => {
    expect(run('SELECT name AS n FROM orders ORDER BY n OFFSET 3 ROWS')).toBe(
      pipeline('orders', [
        "{ $project: { _id: 0, n: '$name' } }",
        '{ $sort: { n: 1 } }',
        '{ $skip: 3 }',
      ]),
    );
  });

  it('skips before it limits in a grouped pipeline', () => {
    expect(
      run(
        'SELECT status, COUNT(*) AS n FROM orders GROUP BY status ORDER BY n OFFSET 2 ROWS FETCH NEXT 3 ROWS ONLY',
      ),
    ).toBe(
      pipeline('orders', [
        "{ $group: { _id: '$status', n: { $sum: 1 } } }",
        "{ $project: { _id: 0, status: '$_id', n: 1 } }",
        '{ $sort: { n: 1 } }',
        '{ $skip: 2 }',
        '{ $limit: 3 }',
      ]),
    );
  });
});

describe('DISTINCT with ORDER BY', () => {
  it('sorts the distinct values', () => {
    expect(run('SELECT DISTINCT status FROM orders ORDER BY status')).toBe(
      pipeline('orders', [
        "{ $group: { _id: { status: '$status' } } }",
        "{ $project: { _id: 0, status: '$_id.status' } }",
        '{ $sort: { status: 1 } }',
      ]),
    );
  });

  it('refuses an ORDER BY column outside the select list, as SQL Server does', () => {
    expect(fail('SELECT DISTINCT status FROM orders ORDER BY total')).toEqual({
      message: 'ORDER BY with DISTINCT must name a select column',
      at: 'total',
    });
  });

  it('limits after sorting the distinct values', () => {
    expect(run('SELECT DISTINCT TOP 5 status FROM orders ORDER BY status')).toBe(
      pipeline('orders', [
        "{ $group: { _id: { status: '$status' } } }",
        "{ $project: { _id: 0, status: '$_id.status' } }",
        '{ $sort: { status: 1 } }',
        '{ $limit: 5 }',
      ]),
    );
  });

  it('sorts by the alias when ORDER BY names the underlying column', () => {
    expect(run('SELECT DISTINCT status AS s FROM orders ORDER BY status')).toBe(
      pipeline('orders', [
        "{ $group: { _id: { s: '$status' } } }",
        "{ $project: { _id: 0, s: '$_id.s' } }",
        '{ $sort: { s: 1 } }',
      ]),
    );
  });

  it('sorts two distinct columns by the second', () => {
    expect(run('SELECT DISTINCT status, region FROM orders ORDER BY region DESC')).toBe(
      pipeline('orders', [
        "{ $group: { _id: { status: '$status', region: '$region' } } }",
        "{ $project: { _id: 0, status: '$_id.status', region: '$_id.region' } }",
        '{ $sort: { region: -1 } }',
      ]),
    );
  });

  it('filters before it groups', () => {
    expect(run('SELECT DISTINCT status FROM orders WHERE total > 1 ORDER BY status')).toBe(
      pipeline('orders', [
        '{ $match: { total: { $gt: 1 } } }',
        "{ $group: { _id: { status: '$status' } } }",
        "{ $project: { _id: 0, status: '$_id.status' } }",
        '{ $sort: { status: 1 } }',
      ]),
    );
  });
});

describe('COUNT(column) versus COUNT(*)', () => {
  it('COUNT(*) counts every row', () => {
    expect(run('SELECT COUNT(*) FROM orders')).toBe(
      pipeline('orders', [
        '{ $group: { _id: null, count: { $sum: 1 } } }',
        '{ $project: { _id: 0, count: 1 } }',
      ]),
    );
  });

  it('keeps both counts apart in one query', () => {
    expect(run('SELECT COUNT(*) AS total_rows, COUNT(email) AS with_email FROM orders')).toBe(
      pipeline('orders', [
        "{ $group: { _id: null, total_rows: { $sum: 1 }, with_email: { $sum: { $cond: [{ $gt: ['$email', null] }, 1, 0] } } } }",
        '{ $project: { _id: 0, total_rows: 1, with_email: 1 } }',
      ]),
    );
  });

  it('COUNT(DISTINCT column) collects a set and sizes it', () => {
    expect(run('SELECT COUNT(DISTINCT email) AS n FROM orders')).toBe(
      pipeline('orders', [
        "{ $group: { _id: null, n: { $addToSet: '$email' } } }",
        "{ $project: { _id: 0, n: { $size: { $filter: { input: '$n', cond: { $ne: ['$$this', null] } } } } } }",
      ]),
    );
  });

  it('COUNT of a joined column after LEFT JOIN counts only matched rows', () => {
    // A customer without orders has no `o` after the preserving unwind, so `$o._id` is missing and
    // the $gt test gives 0, which is what SQL Server returns for COUNT(o._id).
    expect(
      run(
        'SELECT c.name, COUNT(o._id) AS n FROM customers c LEFT JOIN orders o ON o.customerId = c._id GROUP BY c.name',
      ),
    ).toBe(
      pipeline('customers', [
        "{ $lookup: { from: 'orders', localField: '_id', foreignField: 'customerId', as: 'o' } }",
        "{ $unwind: { path: '$o', preserveNullAndEmptyArrays: true } }",
        "{ $group: { _id: '$name', n: { $sum: { $cond: [{ $gt: ['$o._id', null] }, 1, 0] } } } }",
        "{ $project: { _id: 0, name: '$_id', n: 1 } }",
      ]),
    );
  });

  it('names an unaliased COUNT of a deep path with underscores', () => {
    expect(run('SELECT COUNT(customer.address.city) FROM orders')).toBe(
      pipeline('orders', [
        "{ $group: { _id: null, count_customer_address_city: { $sum: { $cond: [{ $gt: ['$customer.address.city', null] }, 1, 0] } } } }",
        '{ $project: { _id: 0, count_customer_address_city: 1 } }',
      ]),
    );
  });
});

describe('HAVING', () => {
  it('filters on a COUNT that the select list does not show', () => {
    expect(run('SELECT status FROM orders GROUP BY status HAVING COUNT(*) > 5')).toBe(
      pipeline('orders', [
        "{ $group: { _id: '$status', having_1: { $sum: 1 } } }",
        '{ $match: { having_1: { $gt: 5 } } }',
        "{ $project: { _id: 0, status: '$_id' } }",
      ]),
    );
  });

  it('filters on a hidden AVG', () => {
    expect(run('SELECT status FROM orders GROUP BY status HAVING AVG(total) >= 50')).toBe(
      pipeline('orders', [
        "{ $group: { _id: '$status', having_1: { $avg: '$total' } } }",
        '{ $match: { having_1: { $gte: 50 } } }',
        "{ $project: { _id: 0, status: '$_id' } }",
      ]),
    );
  });

  it('numbers two hidden aggregates in order', () => {
    expect(
      run('SELECT status FROM orders GROUP BY status HAVING MIN(total) > 1 AND MAX(total) < 100'),
    ).toBe(
      pipeline('orders', [
        "{ $group: { _id: '$status', having_1: { $min: '$total' }, having_2: { $max: '$total' } } }",
        '{ $match: { having_1: { $gt: 1 }, having_2: { $lt: 100 } } }',
        "{ $project: { _id: 0, status: '$_id' } }",
      ]),
    );
  });

  it('reuses the aliased accumulator when HAVING repeats the aggregate', () => {
    expect(
      run('SELECT status, COUNT(*) AS n FROM orders GROUP BY status HAVING COUNT(*) > 5'),
    ).toBe(
      pipeline('orders', [
        "{ $group: { _id: '$status', n: { $sum: 1 } } }",
        '{ $match: { n: { $gt: 5 } } }',
        "{ $project: { _id: 0, status: '$_id', n: 1 } }",
      ]),
    );
  });

  it('filters on the group key through _id', () => {
    expect(
      run("SELECT status, COUNT(*) AS n FROM orders GROUP BY status HAVING status <> 'x'"),
    ).toBe(
      pipeline('orders', [
        "{ $group: { _id: '$status', n: { $sum: 1 } } }",
        "{ $match: { _id: { $ne: 'x' } } }",
        "{ $project: { _id: 0, status: '$_id', n: 1 } }",
      ]),
    );
  });

  it('sizes a hidden COUNT(DISTINCT) through $expr', () => {
    expect(run('SELECT status FROM orders GROUP BY status HAVING COUNT(DISTINCT city) > 1')).toBe(
      pipeline('orders', [
        "{ $group: { _id: '$status', having_1: { $addToSet: '$city' } } }",
        "{ $match: { $expr: { $gt: [{ $size: { $filter: { input: '$having_1', cond: { $ne: ['$$this', null] } } } }, 1] } } }",
        "{ $project: { _id: 0, status: '$_id' } }",
      ]),
    );
  });

  it('keeps a HAVING aggregate and an ORDER BY aggregate as separate hidden accumulators', () => {
    expect(
      run('SELECT status FROM orders GROUP BY status HAVING COUNT(*) > 1 ORDER BY SUM(total) DESC'),
    ).toBe(
      pipeline('orders', [
        "{ $group: { _id: '$status', having_1: { $sum: 1 }, sum_total: { $sum: '$total' } } }",
        '{ $match: { having_1: { $gt: 1 } } }',
        '{ $sort: { sum_total: -1 } }',
        "{ $project: { _id: 0, status: '$_id' } }",
      ]),
    );
  });

  it('works without GROUP BY when the select list is all aggregates', () => {
    expect(run('SELECT COUNT(*) AS n FROM orders HAVING COUNT(*) > 0')).toBe(
      pipeline('orders', [
        '{ $group: { _id: null, n: { $sum: 1 } } }',
        '{ $match: { n: { $gt: 0 } } }',
        '{ $project: { _id: 0, n: 1 } }',
      ]),
    );
  });

  it('refuses a select alias in HAVING, as SQL Server does', () => {
    expect(fail('SELECT status, COUNT(*) AS n FROM orders GROUP BY status HAVING n > 1')).toEqual({
      message: 'column n must appear in GROUP BY or inside an aggregate function',
      at: 'n',
    });
  });

  it('refuses a column outside GROUP BY in HAVING', () => {
    expect(fail('SELECT status FROM orders GROUP BY status HAVING total > 1')).toEqual({
      message: 'column total must appear in GROUP BY or inside an aggregate function',
      at: 'total',
    });
  });
});

describe('dotted paths three deep', () => {
  it.each([
    [
      'SELECT customer.address.city FROM orders',
      "db.orders.find({}, { _id: 0, 'customer.address.city': 1 })",
    ],
    [
      "SELECT * FROM orders WHERE customer.address.city = 'Oslo'",
      "db.orders.find({ 'customer.address.city': 'Oslo' })",
    ],
    // The alias is dropped and the rest is the path.
    [
      "SELECT o.customer.address.city FROM orders o WHERE o.customer.address.city = 'Oslo'",
      "db.orders.find({ 'customer.address.city': 'Oslo' }, { _id: 0, 'customer.address.city': 1 })",
    ],
    [
      'SELECT [customer].[address].[city] FROM [orders]',
      "db.orders.find({}, { _id: 0, 'customer.address.city': 1 })",
    ],
    [
      'SELECT name FROM orders ORDER BY customer.address.city DESC',
      "db.orders.find({}, { _id: 0, name: 1 }).sort({ 'customer.address.city': -1 })",
    ],
    [
      "UPDATE orders SET customer.address.city = 'Oslo' WHERE _id = 1",
      "db.orders.updateMany({ _id: 1 }, { $set: { 'customer.address.city': 'Oslo' } })",
    ],
  ])('%s', (sql, expected) => {
    expect(run(sql)).toBe(expected);
  });

  it('groups by a deep path and names the key by its last part', () => {
    expect(
      run('SELECT customer.address.city, COUNT(*) AS n FROM orders GROUP BY customer.address.city'),
    ).toBe(
      pipeline('orders', [
        "{ $group: { _id: '$customer.address.city', n: { $sum: 1 } } }",
        "{ $project: { _id: 0, city: '$_id', n: 1 } }",
      ]),
    );
  });

  it('keeps the join alias in front of a deep joined path', () => {
    expect(
      run('SELECT c.address.geo.lat FROM orders o JOIN customers c ON o.customerId = c._id'),
    ).toBe(
      pipeline('orders', [
        "{ $lookup: { from: 'customers', localField: 'customerId', foreignField: '_id', as: 'c' } }",
        "{ $unwind: '$c' }",
        "{ $project: { _id: 0, 'address.geo.lat': '$c.address.geo.lat' } }",
      ]),
    );
  });

  it('applies the schema hint to a deep path', () => {
    const options = hints({ 'orders.customer.address.since': 'date' });
    expect(run("SELECT * FROM orders WHERE customer.address.since > '2026-01-01'", options)).toBe(
      "db.orders.find({ 'customer.address.since': { $gt: ISODate('2026-01-01T00:00:00.000Z') } })",
    );
  });
});

describe('_id in and out of the select list', () => {
  it.each([
    // Listing _id keeps it; leaving it out drops it, as SQL returns only the listed columns.
    ['SELECT _id, name FROM orders', 'db.orders.find({}, { _id: 1, name: 1 })'],
    ['SELECT name FROM orders', 'db.orders.find({}, { _id: 0, name: 1 })'],
    ['SELECT _id FROM orders', 'db.orders.find({}, { _id: 1 })'],
    ['SELECT name, _id FROM orders', 'db.orders.find({}, { name: 1, _id: 1 })'],
    [
      'SELECT _id FROM orders ORDER BY _id DESC',
      'db.orders.find({}, { _id: 1 }).sort({ _id: -1 })',
    ],
    [
      `SELECT * FROM orders WHERE _id = CAST('${OID}' AS OBJECTID)`,
      `db.orders.find({ _id: ObjectId('${OID}') })`,
    ],
  ])('%s', (sql, expected) => {
    expect(run(sql)).toBe(expected);
  });

  it('coerces a hex string compared with _id when the schema says ObjectId', () => {
    const options = hints({ 'orders._id': 'objectId' });
    expect(run(`SELECT name FROM orders WHERE _id = '${OID}'`, options)).toBe(
      `db.orders.find({ _id: ObjectId('${OID}') }, { _id: 0, name: 1 })`,
    );
  });

  it('renames _id through an alias and drops the original', () => {
    expect(run('SELECT _id AS id FROM orders')).toBe(
      pipeline('orders', ["{ $project: { _id: 0, id: '$_id' } }"]),
    );
  });

  it('groups by _id and keeps it in the output', () => {
    expect(run('SELECT _id, COUNT(*) AS n FROM orders GROUP BY _id')).toBe(
      pipeline('orders', [
        "{ $group: { _id: '$_id', n: { $sum: 1 } } }",
        "{ $project: { _id: '$_id', n: 1 } }",
      ]),
    );
  });

  it('keeps the base _id next to a joined column', () => {
    expect(run('SELECT o._id, c.name FROM orders o JOIN customers c ON o.customerId = c._id')).toBe(
      pipeline('orders', [
        "{ $lookup: { from: 'customers', localField: 'customerId', foreignField: '_id', as: 'c' } }",
        "{ $unwind: '$c' }",
        "{ $project: { _id: 1, name: '$c.name' } }",
      ]),
    );
  });

  it('projects a joined _id in place of the base _id', () => {
    expect(run('SELECT c._id FROM orders o JOIN customers c ON o.customerId = c._id')).toBe(
      pipeline('orders', [
        "{ $lookup: { from: 'customers', localField: 'customerId', foreignField: '_id', as: 'c' } }",
        "{ $unwind: '$c' }",
        "{ $project: { _id: '$c._id' } }",
      ]),
    );
  });
});

describe('literals and comparisons', () => {
  it.each([
    ["SELECT * FROM orders WHERE status = 'it''s'", "db.orders.find({ status: 'it\\'s' })"],
    ['SELECT * FROM orders WHERE total > 1e3', 'db.orders.find({ total: { $gt: 1000 } })'],
    ['SELECT * FROM orders WHERE total > .5', 'db.orders.find({ total: { $gt: 0.5 } })'],
    ['SELECT * FROM orders WHERE total <> 5', 'db.orders.find({ total: { $ne: 5 } })'],
    ['SELECT * FROM orders WHERE total != 5', 'db.orders.find({ total: { $ne: 5 } })'],
    ['SELECT * FROM orders WHERE active = TRUE', 'db.orders.find({ active: true })'],
    ["SELECT * FROM orders WHERE name = N'Ünïcode'", "db.orders.find({ name: 'Ünïcode' })"],
    // A comparison between two constants has no field to filter on.
    ['SELECT * FROM orders WHERE 1 = 1', 'db.orders.find({ $expr: { $eq: [1, 1] } })'],
  ])('%s', (sql, expected) => {
    expect(run(sql)).toBe(expected);
  });

  it('coerces 1 to true for a bool field', () => {
    expect(run('SELECT * FROM orders WHERE active = 1', hints({ 'orders.active': 'bool' }))).toBe(
      'db.orders.find({ active: true })',
    );
  });

  it('coerces a quoted number for a number field', () => {
    expect(
      run("SELECT * FROM orders WHERE total > '100'", hints({ 'orders.total': 'number' })),
    ).toBe('db.orders.find({ total: { $gt: 100 } })');
  });

  it('reads a DATETIME literal without an offset as UTC, like SQL Server stores it', () => {
    // The contract says the string is parsed with `new Date(text)`. For a date-time without an
    // offset that call reads local time, so the output would change with the machine's time zone.
    // A SQL Server datetime has no zone; the stable choice is to read it as UTC.
    expect(
      run("SELECT * FROM orders WHERE createdAt >= CAST('2026-03-01T12:00:00' AS DATETIME)"),
    ).toBe("db.orders.find({ createdAt: { $gte: ISODate('2026-03-01T12:00:00.000Z') } })");
  });
});

// Round 2. The cases below go deeper into the same lenses. Each one is a query a SQL Server user
// writes in practice, paired with the mongosh text that returns the same rows.

describe('round 2: NULL handling', () => {
  it.each([
    [
      'SELECT * FROM orders WHERE total IS NULL OR total = 0',
      'db.orders.find({ $or: [{ total: null }, { total: 0 }] })',
    ],
    [
      'SELECT * FROM orders WHERE NOT (a = 1 AND b IS NULL)',
      'db.orders.find({ $nor: [{ a: 1, b: null }] })',
    ],
    // A double negation keeps the operator object, so $not wraps $ne.
    [
      'SELECT * FROM orders WHERE NOT status IS NOT NULL',
      'db.orders.find({ status: { $not: { $ne: null } } })',
    ],
    [
      "SELECT * FROM orders WHERE ISNULL(status, '') = ''",
      "db.orders.find({ $expr: { $eq: [{ $ifNull: ['$status', ''] }, ''] } })",
    ],
    // IS NULL on a computed value goes through $ifNull so a missing result counts as null.
    [
      'SELECT * FROM orders WHERE NULLIF(a, b) IS NULL',
      "db.orders.find({ $expr: { $eq: [{ $ifNull: [{ $cond: [{ $eq: ['$a', '$b'] }, null, '$a'] }, null] }, null] } })",
    ],
    [
      'SELECT * FROM orders WHERE UPPER(name) IS NOT NULL',
      "db.orders.find({ $expr: { $ne: [{ $ifNull: [{ $toUpper: '$name' }, null] }, null] } })",
    ],
    [
      "INSERT INTO orders (name, note) VALUES ('x', NULL)",
      "db.orders.insertMany([{ name: 'x', note: null }])",
    ],
    ['UPDATE orders SET note = NULL', 'db.orders.updateMany({}, { $set: { note: null } })'],
  ])('%s', (sql, expected) => {
    expect(run(sql)).toBe(expected);
  });

  it('SUM over a CASE without ELSE skips the rows that fall through, since $sum ignores null', () => {
    expect(
      run(
        "SELECT region, SUM(CASE WHEN status = 'paid' THEN total END) AS paid FROM orders GROUP BY region",
      ),
    ).toBe(
      pipeline('orders', [
        "{ $group: { _id: '$region', paid: { $sum: { $switch: { branches: [{ case: { $eq: ['$status', 'paid'] }, then: '$total' }], default: null } } } } }",
        "{ $project: { _id: 0, region: '$_id', paid: 1 } }",
      ]),
    );
  });

  it('COUNT over a CASE without ELSE counts only the matching rows', () => {
    expect(
      run(
        "SELECT region, COUNT(CASE WHEN status = 'paid' THEN 1 END) AS paid FROM orders GROUP BY region",
      ),
    ).toBe(
      pipeline('orders', [
        "{ $group: { _id: '$region', paid: { $sum: { $cond: [{ $gt: [{ $switch: { branches: [{ case: { $eq: ['$status', 'paid'] }, then: 1 }], default: null } }, null] }, 1, 0] } } } }",
        "{ $project: { _id: 0, region: '$_id', paid: 1 } }",
      ]),
    );
  });

  it('COALESCE with four arguments nests $ifNull', () => {
    expect(run('SELECT COALESCE(a, b, c, 0) AS v FROM orders')).toBe(
      pipeline('orders', [
        "{ $project: { _id: 0, v: { $ifNull: ['$a', { $ifNull: ['$b', { $ifNull: ['$c', 0] }] }] } } }",
      ]),
    );
  });

  it('ISNULL fills a LEFT JOIN column that has no match', () => {
    expect(
      run(
        "SELECT o.total, ISNULL(c.name, 'unknown') AS customer FROM orders o LEFT JOIN customers c ON o.customerId = c._id",
      ),
    ).toBe(
      pipeline('orders', [
        "{ $lookup: { from: 'customers', localField: 'customerId', foreignField: '_id', as: 'c' } }",
        "{ $unwind: { path: '$c', preserveNullAndEmptyArrays: true } }",
        "{ $project: { _id: 0, total: 1, customer: { $ifNull: ['$c.name', 'unknown'] } } }",
      ]),
    );
  });

  it('the anti join idiom, LEFT JOIN with WHERE joined IS NULL, matches the missing lookup', () => {
    // After the preserving $unwind a row without a match has no `c`, and `{ 'c._id': null }`
    // matches a missing path, so the rows are the ones SQL Server returns.
    expect(
      run(
        'SELECT o._id FROM orders o LEFT JOIN customers c ON o.customerId = c._id WHERE c._id IS NULL',
      ),
    ).toBe(
      pipeline('orders', [
        "{ $lookup: { from: 'customers', localField: 'customerId', foreignField: '_id', as: 'c' } }",
        "{ $unwind: { path: '$c', preserveNullAndEmptyArrays: true } }",
        "{ $match: { 'c._id': null } }",
        '{ $project: { _id: 1 } }',
      ]),
    );
  });
});

describe('round 2: operator precedence', () => {
  it.each([
    [
      'SELECT * FROM orders WHERE a = 1 OR NOT b = 2 AND c = 3',
      'db.orders.find({ $or: [{ a: 1 }, { $nor: [{ b: 2 }], c: 3 }] })',
    ],
    [
      'SELECT * FROM orders WHERE a = 1 AND (b = 2 OR c = 3)',
      'db.orders.find({ a: 1, $or: [{ b: 2 }, { c: 3 }] })',
    ],
    // Two $or conjuncts cannot share one key, so they go under $and.
    [
      'SELECT * FROM orders WHERE (a = 1 OR b = 2) AND (c = 3 OR d = 4)',
      'db.orders.find({ $and: [{ $or: [{ a: 1 }, { b: 2 }] }, { $or: [{ c: 3 }, { d: 4 }] }] })',
    ],
    // NOT in front of BETWEEN or LIKE is the same as NOT BETWEEN and NOT LIKE.
    [
      'SELECT * FROM orders WHERE NOT total BETWEEN 1 AND 10',
      'db.orders.find({ total: { $not: { $gte: 1, $lte: 10 } } })',
    ],
    ["SELECT * FROM orders WHERE NOT name LIKE 'a%'", 'db.orders.find({ name: { $not: /^a/i } })'],
    [
      "SELECT * FROM orders WHERE name LIKE '%a%' AND name LIKE '%b%'",
      'db.orders.find({ $and: [{ name: /a/i }, { name: /b/i }] })',
    ],
    [
      'SELECT * FROM orders WHERE -total > 5',
      "db.orders.find({ $expr: { $gt: [{ $multiply: [-1, '$total'] }, 5] } })",
    ],
    [
      'SELECT * FROM orders WHERE a + b = c',
      "db.orders.find({ $expr: { $eq: [{ $add: ['$a', '$b'] }, '$c'] } })",
    ],
    // The contract folds only literals and casts, so a constant expression stays an $expr.
    [
      'SELECT * FROM orders WHERE total = 1 + 2',
      "db.orders.find({ $expr: { $eq: ['$total', { $add: [1, 2] }] } })",
    ],
    // Two $expr conjuncts collide on their key and go under $and.
    [
      'SELECT * FROM orders WHERE total / 2 > 1 AND total % 2 = 0',
      "db.orders.find({ $and: [{ $expr: { $gt: [{ $divide: ['$total', 2] }, 1] } }, { $expr: { $eq: [{ $mod: ['$total', 2] }, 0] } }] })",
    ],
    [
      "SELECT * FROM orders WHERE total % 2 = 1 AND status = 'a'",
      "db.orders.find({ $expr: { $eq: [{ $mod: ['$total', 2] }, 1] }, status: 'a' })",
    ],
  ])('%s', (sql, expected) => {
    expect(run(sql)).toBe(expected);
  });

  it.each([
    [
      'SELECT 2 * total + 1 AS v FROM orders',
      "{ $project: { _id: 0, v: { $add: [{ $multiply: [2, '$total'] }, 1] } } }",
    ],
    [
      'SELECT 10 - 2 * 3 AS v FROM orders',
      '{ $project: { _id: 0, v: { $subtract: [10, { $multiply: [2, 3] }] } } }',
    ],
    [
      'SELECT total - -1 AS v FROM orders',
      "{ $project: { _id: 0, v: { $subtract: ['$total', -1] } } }",
    ],
    [
      'SELECT total + tax + 1 AS v FROM orders',
      "{ $project: { _id: 0, v: { $add: [{ $add: ['$total', '$tax'] }, 1] } } }",
    ],
  ])('%s', (sql, stage) => {
    expect(run(sql)).toBe(pipeline('orders', [stage]));
  });

  it('refuses a chained comparison, which T-SQL does not have', () => {
    const [result] = translateSql('SELECT * FROM orders WHERE a = b = c');
    expect(result?.ok).toBe(false);
  });
});

describe('round 2: LIKE edge cases', () => {
  it.each([
    ["SELECT * FROM orders WHERE name LIKE 'a%b%c'", 'db.orders.find({ name: /^a.*b.*c$/i })'],
    // At least one character: the leading underscore keeps its anchor.
    ["SELECT * FROM orders WHERE name LIKE '_%'", 'db.orders.find({ name: /^./i })'],
    ["SELECT * FROM orders WHERE name LIKE '%_'", 'db.orders.find({ name: /.$/i })'],
    ["SELECT * FROM orders WHERE name LIKE '__'", 'db.orders.find({ name: /^..$/i })'],
    ["SELECT * FROM orders WHERE name LIKE '[a-c]_'", 'db.orders.find({ name: /^[a-c].$/i })'],
    // A bracketed percent in the middle is a literal percent sign.
    ["SELECT * FROM orders WHERE name LIKE '%[%]%'", 'db.orders.find({ name: /[%]/i })'],
    // A backslash as the ESCAPE character, the usual choice for Windows paths.
    [
      "SELECT * FROM orders WHERE path LIKE 'C:\\%' ESCAPE '\\'",
      'db.orders.find({ path: /^C:%$/i })',
    ],
    ["SELECT * FROM orders WHERE name LIKE '100%'", 'db.orders.find({ name: /^100/i })'],
    ["SELECT * FROM orders WHERE name LIKE '%%'", 'db.orders.find({ name: /.*/i })'],
    // A slash inside the regex literal is escaped by the emitter.
    ["SELECT * FROM orders WHERE name LIKE '%/%'", 'db.orders.find({ name: /\\//i })'],
    ["SELECT * FROM orders WHERE name LIKE '^a'", 'db.orders.find({ name: /^\\^a$/i })'],
    ["SELECT * FROM orders WHERE name LIKE 'a|b'", 'db.orders.find({ name: /^a\\|b$/i })'],
    ["SELECT * FROM orders WHERE name LIKE 'a{2}'", 'db.orders.find({ name: /^a\\{2\\}$/i })'],
    ["SELECT * FROM orders WHERE name LIKE N'%x%'", 'db.orders.find({ name: /x/i })'],
    ["SELECT * FROM orders WHERE name LIKE '[.]'", 'db.orders.find({ name: /^[.]$/i })'],
    ["SELECT * FROM orders WHERE name LIKE '%x%' ESCAPE 'x'", 'db.orders.find({ name: /%$/i })'],
    [
      "SELECT * FROM orders WHERE customer.address.city LIKE 'O%'",
      "db.orders.find({ 'customer.address.city': /^O/i })",
    ],
  ])('%s', (sql, expected) => {
    expect(run(sql)).toBe(expected);
  });

  it('refuses a pattern built from an expression, as the contract requires a literal', () => {
    expect(fail("SELECT * FROM orders WHERE name LIKE 'a' + '%'")).toEqual({
      message: 'LIKE pattern must be a string literal',
      at: "'a' + '%'",
    });
  });

  it('LIKE on a joined column waits for the $lookup', () => {
    expect(
      run(
        "SELECT o.total FROM orders o JOIN customers c ON o.customerId = c._id WHERE c.email LIKE '%@x.com'",
      ),
    ).toBe(
      pipeline('orders', [
        "{ $lookup: { from: 'customers', localField: 'customerId', foreignField: '_id', as: 'c' } }",
        "{ $unwind: '$c' }",
        "{ $match: { 'c.email': /@x\\.com$/i } }",
        '{ $project: { _id: 0, total: 1 } }',
      ]),
    );
  });
});

describe('round 2: string versus number plus', () => {
  it.each([
    [
      "SELECT first + ' ' + last + '!' AS v FROM orders",
      "{ $project: { _id: 0, v: { $concat: ['$first', ' ', '$last', '!'] } } }",
    ],
    // Parentheses do not change the flattened concatenation.
    [
      "SELECT (first + ' ') + last AS v FROM orders",
      "{ $project: { _id: 0, v: { $concat: ['$first', ' ', '$last'] } } }",
    ],
    // The contract says a string literal on either side makes the plus a concatenation, even
    // though SQL Server would convert '5' to a number when total is numeric.
    [
      "SELECT total + '5' AS v FROM orders",
      "{ $project: { _id: 0, v: { $concat: ['$total', '5'] } } }",
    ],
  ])('%s', (sql, stage) => {
    expect(run(sql)).toBe(pipeline('orders', [stage]));
  });

  it.each([
    [
      "SELECT * FROM orders WHERE name + 'x' = 'ax'",
      "db.orders.find({ $expr: { $eq: [{ $concat: ['$name', 'x'] }, 'ax'] } })",
    ],
    [
      "UPDATE orders SET name = name + '!' WHERE _id = 1",
      "db.orders.updateMany({ _id: 1 }, [{ $set: { name: { $concat: ['$name', '!'] } } }])",
    ],
    [
      'UPDATE orders SET total = total + 1 WHERE _id = 1',
      "db.orders.updateMany({ _id: 1 }, [{ $set: { total: { $add: ['$total', 1] } } }])",
    ],
    [
      'UPDATE orders SET total = -1 WHERE _id = 1',
      'db.orders.updateMany({ _id: 1 }, { $set: { total: -1 } })',
    ],
  ])('%s', (sql, expected) => {
    expect(run(sql)).toBe(expected);
  });
});

describe('round 2: division and modulo', () => {
  it.each([
    [
      'SELECT ROUND(total / 3, 2) AS v FROM orders',
      "{ $project: { _id: 0, v: { $round: [{ $divide: ['$total', 3] }, 2] } } }",
    ],
    [
      'SELECT CAST(total AS INT) / 2 AS v FROM orders',
      "{ $project: { _id: 0, v: { $divide: [{ $toInt: '$total' }, 2] } } }",
    ],
  ])('%s', (sql, stage) => {
    expect(run(sql)).toBe(pipeline('orders', [stage]));
  });

  it('a modulo test in WHERE becomes $expr', () => {
    expect(run('SELECT * FROM orders WHERE total % 2 = 0')).toBe(
      "db.orders.find({ $expr: { $eq: [{ $mod: ['$total', 2] }, 0] } })",
    );
  });

  it('divides an arithmetic expression over two aggregates', () => {
    expect(run('SELECT status, AVG(total) * 100 / SUM(qty) AS v FROM orders GROUP BY status')).toBe(
      pipeline('orders', [
        "{ $group: { _id: '$status', avg_total: { $avg: '$total' }, sum_qty: { $sum: '$qty' } } }",
        "{ $project: { _id: 0, status: '$_id', v: { $divide: [{ $multiply: ['$avg_total', 100] }, '$sum_qty'] } } }",
      ]),
    );
  });
});

describe('round 2: BETWEEN', () => {
  it.each([
    [
      "SELECT * FROM orders WHERE createdAt BETWEEN CAST('2026-01-01' AS DATE) AND CAST('2026-12-31' AS DATE)",
      "db.orders.find({ createdAt: { $gte: ISODate('2026-01-01T00:00:00.000Z'), $lte: ISODate('2026-12-31T00:00:00.000Z') } })",
    ],
    [
      'SELECT * FROM orders WHERE total BETWEEN 1 AND 10 OR total > 100',
      'db.orders.find({ $or: [{ total: { $gte: 1, $lte: 10 } }, { total: { $gt: 100 } }] })',
    ],
    [
      'SELECT * FROM orders WHERE total BETWEEN 1 AND 10 AND tax BETWEEN 0 AND 1',
      'db.orders.find({ total: { $gte: 1, $lte: 10 }, tax: { $gte: 0, $lte: 1 } })',
    ],
    [
      'SELECT * FROM orders WHERE DAY(createdAt) BETWEEN 1 AND 7',
      "db.orders.find({ $expr: { $and: [{ $gte: [{ $dayOfMonth: '$createdAt' }, 1] }, { $lte: [{ $dayOfMonth: '$createdAt' }, 7] }] } })",
    ],
  ])('%s', (sql, expected) => {
    expect(run(sql)).toBe(expected);
  });

  it('BETWEEN on a hidden aggregate in HAVING is a range on the accumulator', () => {
    expect(run('SELECT status FROM orders GROUP BY status HAVING COUNT(*) BETWEEN 2 AND 5')).toBe(
      pipeline('orders', [
        "{ $group: { _id: '$status', having_1: { $sum: 1 } } }",
        '{ $match: { having_1: { $gte: 2, $lte: 5 } } }',
        "{ $project: { _id: 0, status: '$_id' } }",
      ]),
    );
  });

  it('BETWEEN on the group key in HAVING is a range on _id', () => {
    expect(run("SELECT status FROM orders GROUP BY status HAVING status BETWEEN 'a' AND 'm'")).toBe(
      pipeline('orders', [
        "{ $group: { _id: '$status' } }",
        "{ $match: { _id: { $gte: 'a', $lte: 'm' } } }",
        "{ $project: { _id: 0, status: '$_id' } }",
      ]),
    );
  });

  it('BETWEEN on a joined column waits for the $lookup', () => {
    expect(
      run(
        'SELECT o.total FROM orders o JOIN customers c ON o.customerId = c._id WHERE c.age BETWEEN 18 AND 30',
      ),
    ).toBe(
      pipeline('orders', [
        "{ $lookup: { from: 'customers', localField: 'customerId', foreignField: '_id', as: 'c' } }",
        "{ $unwind: '$c' }",
        "{ $match: { 'c.age': { $gte: 18, $lte: 30 } } }",
        '{ $project: { _id: 0, total: 1 } }',
      ]),
    );
  });

  it('coerces quoted bounds to numbers from the schema hint', () => {
    expect(
      run(
        "SELECT * FROM orders WHERE total BETWEEN '1' AND '10'",
        hints({ 'orders.total': 'number' }),
      ),
    ).toBe('db.orders.find({ total: { $gte: 1, $lte: 10 } })');
  });
});

describe('round 2: IN with mixed types', () => {
  it.each([
    [
      `SELECT * FROM orders WHERE ref IN (CAST('${OID}' AS OBJECTID), 'x')`,
      `db.orders.find({ ref: { $in: [ObjectId('${OID}'), 'x'] } })`,
    ],
    [
      'SELECT * FROM orders WHERE createdAt IN (GETDATE())',
      'db.orders.find({ createdAt: { $in: [new Date()] } })',
    ],
    ['SELECT * FROM orders WHERE total IN (-1, +2)', 'db.orders.find({ total: { $in: [-1, 2] } })'],
    ['SELECT * FROM orders WHERE _id IN (1, 2, 3)', 'db.orders.find({ _id: { $in: [1, 2, 3] } })'],
    [
      "SELECT * FROM orders WHERE status IN ('a', 'b') OR total > 5",
      "db.orders.find({ $or: [{ status: { $in: ['a', 'b'] } }, { total: { $gt: 5 } }] })",
    ],
  ])('%s', (sql, expected) => {
    expect(run(sql)).toBe(expected);
  });

  it('coerces every entry to a date from the schema hint', () => {
    expect(
      run(
        "SELECT * FROM orders WHERE createdAt IN ('2026-01-01', '2026-01-02')",
        hints({ 'orders.createdAt': 'date' }),
      ),
    ).toBe(
      "db.orders.find({ createdAt: { $in: [ISODate('2026-01-01T00:00:00.000Z'), ISODate('2026-01-02T00:00:00.000Z')] } })",
    );
  });

  it("coerces 'true' and 'false' to booleans from the schema hint", () => {
    expect(
      run(
        "SELECT * FROM orders WHERE active IN ('true', 'false')",
        hints({ 'orders.active': 'bool' }),
      ),
    ).toBe('db.orders.find({ active: { $in: [true, false] } })');
  });

  it('refuses an empty list', () => {
    expect(fail('SELECT * FROM orders WHERE status IN ()')).toEqual({
      message: 'IN needs at least one value',
      at: '()',
    });
  });

  it('IN on a hidden aggregate in HAVING', () => {
    expect(run('SELECT status FROM orders GROUP BY status HAVING COUNT(*) IN (1, 2)')).toBe(
      pipeline('orders', [
        "{ $group: { _id: '$status', having_1: { $sum: 1 } } }",
        '{ $match: { having_1: { $in: [1, 2] } } }',
        "{ $project: { _id: 0, status: '$_id' } }",
      ]),
    );
  });

  it('IN on a joined column waits for the $lookup', () => {
    expect(
      run(
        "SELECT o.total FROM orders o JOIN customers c ON o.customerId = c._id WHERE c.tier IN ('gold', 'silver')",
      ),
    ).toBe(
      pipeline('orders', [
        "{ $lookup: { from: 'customers', localField: 'customerId', foreignField: '_id', as: 'c' } }",
        "{ $unwind: '$c' }",
        "{ $match: { 'c.tier': { $in: ['gold', 'silver'] } } }",
        '{ $project: { _id: 0, total: 1 } }',
      ]),
    );
  });
});

describe('round 2: CASE', () => {
  it.each([
    [
      "SELECT CASE status WHEN 'a' THEN 1 WHEN 'b' THEN 2 END AS code FROM orders",
      "{ $project: { _id: 0, code: { $switch: { branches: [{ case: { $eq: ['$status', 'a'] }, then: 1 }, { case: { $eq: ['$status', 'b'] }, then: 2 }], default: null } } } }",
    ],
    [
      'SELECT CASE WHEN total > 1 THEN TRUE ELSE FALSE END AS big FROM orders',
      "{ $project: { _id: 0, big: { $switch: { branches: [{ case: { $gt: ['$total', 1] }, then: true }], default: false } } } }",
    ],
    [
      'SELECT IIF(total > 10, 1, 0) AS v FROM orders',
      "{ $project: { _id: 0, v: { $cond: [{ $gt: ['$total', 10] }, 1, 0] } } }",
    ],
  ])('%s', (sql, stage) => {
    expect(run(sql)).toBe(pipeline('orders', [stage]));
  });

  it('a CASE without ELSE in WHERE compares against null for the rows that fall through', () => {
    expect(run('SELECT * FROM orders WHERE CASE WHEN total > 10 THEN 1 END = 1')).toBe(
      "db.orders.find({ $expr: { $eq: [{ $switch: { branches: [{ case: { $gt: ['$total', 10] }, then: 1 }], default: null } }, 1] } })",
    );
  });

  it('groups by a CASE expression that the select list aliases', () => {
    expect(
      run(
        "SELECT CASE WHEN total > 100 THEN 'big' ELSE 'small' END AS bucket, COUNT(*) AS n FROM orders GROUP BY CASE WHEN total > 100 THEN 'big' ELSE 'small' END",
      ),
    ).toBe(
      pipeline('orders', [
        "{ $group: { _id: { $switch: { branches: [{ case: { $gt: ['$total', 100] }, then: 'big' }], default: 'small' } }, n: { $sum: 1 } } }",
        "{ $project: { _id: 0, bucket: '$_id', n: 1 } }",
      ]),
    );
  });

  it('sorts by the alias of a CASE column', () => {
    expect(
      run(
        "SELECT CASE WHEN total > 100 THEN 'big' ELSE 'small' END AS bucket FROM orders ORDER BY bucket",
      ),
    ).toBe(
      pipeline('orders', [
        "{ $project: { _id: 0, bucket: { $switch: { branches: [{ case: { $gt: ['$total', 100] }, then: 'big' }], default: 'small' } } } }",
        '{ $sort: { bucket: 1 } }',
      ]),
    );
  });

  it('a CASE inside a HAVING aggregate', () => {
    expect(
      run(
        "SELECT status FROM orders GROUP BY status HAVING SUM(CASE WHEN status = 'paid' THEN 1 ELSE 0 END) > 2",
      ),
    ).toBe(
      pipeline('orders', [
        "{ $group: { _id: '$status', having_1: { $sum: { $switch: { branches: [{ case: { $eq: ['$status', 'paid'] }, then: 1 }], default: 0 } } } } }",
        '{ $match: { having_1: { $gt: 2 } } }',
        "{ $project: { _id: 0, status: '$_id' } }",
      ]),
    );
  });
});

describe('round 2: ORDER BY on an alias or a group key', () => {
  it('sorts by the alias of an arithmetic column', () => {
    expect(run('SELECT total * 1.22 AS gross FROM orders ORDER BY gross DESC')).toBe(
      pipeline('orders', [
        "{ $project: { _id: 0, gross: { $multiply: ['$total', 1.22] } } }",
        '{ $sort: { gross: -1 } }',
      ]),
    );
  });

  it('sorts by the same expression written out again', () => {
    expect(run('SELECT total * 1.22 AS gross FROM orders ORDER BY total * 1.22')).toBe(
      pipeline('orders', [
        "{ $project: { _id: 0, gross: { $multiply: ['$total', 1.22] } } }",
        '{ $sort: { gross: 1 } }',
      ]),
    );
  });

  it('limits after sorting by the alias', () => {
    expect(run('SELECT TOP 3 total * 1.22 AS gross FROM orders ORDER BY gross DESC')).toBe(
      pipeline('orders', [
        "{ $project: { _id: 0, gross: { $multiply: ['$total', 1.22] } } }",
        '{ $sort: { gross: -1 } }',
        '{ $limit: 3 }',
      ]),
    );
  });

  it('an alias that shadows a column wins in ORDER BY, as in SQL Server', () => {
    expect(run('SELECT total AS name FROM orders ORDER BY name')).toBe(
      pipeline('orders', ["{ $project: { _id: 0, name: '$total' } }", '{ $sort: { name: 1 } }']),
    );
  });

  it('refuses an ORDER BY column that is not grouped, as SQL Server does', () => {
    expect(fail('SELECT status, COUNT(*) AS n FROM orders GROUP BY status ORDER BY total')).toEqual(
      {
        message: 'column total must appear in GROUP BY or inside an aggregate function',
        at: 'total',
      },
    );
  });

  it('sorts by two aliased group keys', () => {
    expect(
      run(
        'SELECT status AS s, region AS r, COUNT(*) AS n FROM orders GROUP BY status, region ORDER BY r, s',
      ),
    ).toBe(
      pipeline('orders', [
        "{ $group: { _id: { s: '$status', r: '$region' }, n: { $sum: 1 } } }",
        "{ $project: { _id: 0, s: '$_id.s', r: '$_id.r', n: 1 } }",
        '{ $sort: { r: 1, s: 1 } }',
      ]),
    );
  });

  it('sorts by an aggregate through the alias the select list gave it', () => {
    expect(
      run('SELECT status, SUM(total) AS s FROM orders GROUP BY status ORDER BY SUM(total) DESC'),
    ).toBe(
      pipeline('orders', [
        "{ $group: { _id: '$status', s: { $sum: '$total' } } }",
        "{ $project: { _id: 0, status: '$_id', s: 1 } }",
        '{ $sort: { s: -1 } }',
      ]),
    );
  });

  it('sorts by an aggregate and a key together', () => {
    expect(
      run('SELECT status, COUNT(*) n FROM orders GROUP BY status ORDER BY COUNT(*) DESC, status'),
    ).toBe(
      pipeline('orders', [
        "{ $group: { _id: '$status', n: { $sum: 1 } } }",
        "{ $project: { _id: 0, status: '$_id', n: 1 } }",
        '{ $sort: { n: -1, status: 1 } }',
      ]),
    );
  });

  it('sorts by implicit aliases of grouped date parts', () => {
    expect(
      run(
        'SELECT YEAR(createdAt) y, MONTH(createdAt) m, COUNT(*) n FROM orders GROUP BY YEAR(createdAt), MONTH(createdAt) ORDER BY y, m',
      ),
    ).toBe(
      pipeline('orders', [
        "{ $group: { _id: { y: { $year: '$createdAt' }, m: { $month: '$createdAt' } }, n: { $sum: 1 } } }",
        "{ $project: { _id: 0, y: '$_id.y', m: '$_id.m', n: 1 } }",
        '{ $sort: { y: 1, m: 1 } }',
      ]),
    );
  });

  it('sorts by a joined column that is not projected when the base star keeps it', () => {
    expect(
      run(
        'SELECT o.*, c.name FROM orders o JOIN customers c ON o.customerId = c._id ORDER BY c.tier',
      ),
    ).toBe(
      pipeline('orders', [
        "{ $lookup: { from: 'customers', localField: 'customerId', foreignField: '_id', as: 'c' } }",
        "{ $unwind: '$c' }",
        "{ $addFields: { name: '$c.name' } }",
        "{ $sort: { 'c.tier': 1 } }",
      ]),
    );
  });

  it('sorts by a joined column through the alias it was projected under', () => {
    expect(
      run(
        'SELECT c.name AS customer FROM orders o JOIN customers c ON o.customerId = c._id ORDER BY c.name',
      ),
    ).toBe(
      pipeline('orders', [
        "{ $lookup: { from: 'customers', localField: 'customerId', foreignField: '_id', as: 'c' } }",
        "{ $unwind: '$c' }",
        "{ $project: { _id: 0, customer: '$c.name' } }",
        '{ $sort: { customer: 1 } }',
      ]),
    );
  });

  it('refuses an expression alias next to a hidden column rather than sort wrongly', () => {
    // SQL Server sorts this. The contract is silent, and a sort that needs both the computed
    // output and a column the projection drops has no single place in the pipeline, so the
    // translator refuses with a message that says what to change.
    expect(fail('SELECT total * 2 AS d FROM orders ORDER BY d, name')).toEqual({
      message:
        'ORDER BY cannot combine a select alias with a column that is not in the select list',
      at: 'name',
    });
  });
});

describe('round 2: TOP with ORDER BY', () => {
  it('keeps the full stage order with WHERE, GROUP BY, HAVING, ORDER BY and TOP', () => {
    expect(
      run(
        'SELECT TOP 2 status, COUNT(*) AS n FROM orders WHERE total > 0 GROUP BY status HAVING COUNT(*) > 1 ORDER BY n DESC',
      ),
    ).toBe(
      pipeline('orders', [
        '{ $match: { total: { $gt: 0 } } }',
        "{ $group: { _id: '$status', n: { $sum: 1 } } }",
        '{ $match: { n: { $gt: 1 } } }',
        "{ $project: { _id: 0, status: '$_id', n: 1 } }",
        '{ $sort: { n: -1 } }',
        '{ $limit: 2 }',
      ]),
    );
  });

  it('DISTINCT TOP without ORDER BY limits the distinct values', () => {
    expect(run('SELECT DISTINCT TOP 3 status FROM orders')).toBe(
      pipeline('orders', [
        "{ $group: { _id: { status: '$status' } } }",
        "{ $project: { _id: 0, status: '$_id.status' } }",
        '{ $limit: 3 }',
      ]),
    );
  });

  it('TOP after a join sorts before it limits', () => {
    expect(
      run(
        'SELECT TOP 5 o.total, c.name FROM orders o JOIN customers c ON o.customerId = c._id ORDER BY o.total DESC',
      ),
    ).toBe(
      pipeline('orders', [
        "{ $lookup: { from: 'customers', localField: 'customerId', foreignField: '_id', as: 'c' } }",
        "{ $unwind: '$c' }",
        "{ $project: { _id: 0, total: 1, name: '$c.name' } }",
        '{ $sort: { total: -1 } }',
        '{ $limit: 5 }',
      ]),
    );
  });

  it('TOP with a hidden sort column sorts before the projection and limits after it', () => {
    expect(run('SELECT TOP 5 name AS n FROM orders ORDER BY total DESC')).toBe(
      pipeline('orders', [
        '{ $sort: { total: -1 } }',
        "{ $project: { _id: 0, n: '$name' } }",
        '{ $limit: 5 }',
      ]),
    );
  });

  it('refuses WITH TIES', () => {
    expect(fail('SELECT TOP 5 WITH TIES * FROM orders ORDER BY total').message).toBe(
      'WITH TIES is not supported',
    );
  });

  it('refuses PERCENT', () => {
    expect(fail('SELECT TOP 10 PERCENT * FROM orders').message).toBe(
      'TOP ... PERCENT is not supported',
    );
  });
});

describe('round 2: OFFSET without FETCH', () => {
  it.each([
    [
      "SELECT name FROM orders WHERE status = 'a' ORDER BY name OFFSET 5 ROWS",
      "db.orders.find({ status: 'a' }, { _id: 0, name: 1 }).sort({ name: 1 }).skip(5)",
    ],
    // SQL Server requires ORDER BY before OFFSET. The contract is silent, and a skip without a
    // sort is still a valid query, so the lenient translation is accepted.
    ['SELECT * FROM orders OFFSET 5 ROWS', 'db.orders.find({}).skip(5)'],
    [
      'SELECT * FROM orders ORDER BY name OFFSET 5 ROW FETCH NEXT 1 ROW ONLY',
      'db.orders.find({}).sort({ name: 1 }).skip(5).limit(1)',
    ],
  ])('%s', (sql, expected) => {
    expect(run(sql)).toBe(expected);
  });

  it('skips the sorted distinct values', () => {
    expect(run('SELECT DISTINCT status FROM orders ORDER BY status OFFSET 1 ROWS')).toBe(
      pipeline('orders', [
        "{ $group: { _id: { status: '$status' } } }",
        "{ $project: { _id: 0, status: '$_id.status' } }",
        '{ $sort: { status: 1 } }',
        '{ $skip: 1 }',
      ]),
    );
  });

  it('skips after the join sort', () => {
    expect(
      run(
        'SELECT o.total, c.name FROM orders o JOIN customers c ON o.customerId = c._id ORDER BY o.total OFFSET 10 ROWS',
      ),
    ).toBe(
      pipeline('orders', [
        "{ $lookup: { from: 'customers', localField: 'customerId', foreignField: '_id', as: 'c' } }",
        "{ $unwind: '$c' }",
        "{ $project: { _id: 0, total: 1, name: '$c.name' } }",
        '{ $sort: { total: 1 } }',
        '{ $skip: 10 }',
      ]),
    );
  });

  it('refuses FETCH 0, which would read as no limit', () => {
    expect(
      fail('SELECT * FROM orders ORDER BY name OFFSET 0 ROWS FETCH FIRST 0 ROWS ONLY'),
    ).toEqual({ message: 'FETCH 0 returns no rows and cannot be translated', at: '0' });
  });
});

describe('round 2: DISTINCT with ORDER BY', () => {
  it('sorts distinct expression values by their alias', () => {
    expect(run('SELECT DISTINCT UPPER(name) AS n FROM orders ORDER BY n DESC')).toBe(
      pipeline('orders', [
        "{ $group: { _id: { n: { $toUpper: '$name' } } } }",
        "{ $project: { _id: 0, n: '$_id.n' } }",
        '{ $sort: { n: -1 } }',
      ]),
    );
  });

  it('sorts distinct expression values by the expression written out again', () => {
    expect(run('SELECT DISTINCT UPPER(name) AS n FROM orders ORDER BY UPPER(name)')).toBe(
      pipeline('orders', [
        "{ $group: { _id: { n: { $toUpper: '$name' } } } }",
        "{ $project: { _id: 0, n: '$_id.n' } }",
        '{ $sort: { n: 1 } }',
      ]),
    );
  });

  it('distinct joined values sort by their output name', () => {
    expect(
      run(
        'SELECT DISTINCT c.name FROM orders o JOIN customers c ON o.customerId = c._id ORDER BY c.name',
      ),
    ).toBe(
      pipeline('orders', [
        "{ $lookup: { from: 'customers', localField: 'customerId', foreignField: '_id', as: 'c' } }",
        "{ $unwind: '$c' }",
        "{ $group: { _id: { name: '$c.name' } } }",
        "{ $project: { _id: 0, name: '$_id.name' } }",
        '{ $sort: { name: 1 } }',
      ]),
    );
  });

  it('refuses DISTINCT next to an aggregate', () => {
    expect(fail('SELECT DISTINCT status, COUNT(*) FROM orders GROUP BY status').message).toBe(
      'DISTINCT cannot be combined with GROUP BY or aggregate functions',
    );
  });

  it('names an unaliased distinct expression like an unaliased aggregate', () => {
    expect(run('SELECT DISTINCT YEAR(createdAt) FROM orders')).toBe(
      pipeline('orders', [
        "{ $group: { _id: { year_createdat: { $year: '$createdAt' } } } }",
        "{ $project: { _id: 0, year_createdat: '$_id.year_createdat' } }",
      ]),
    );
  });

  it('DISTINCT _id keeps the id as the output', () => {
    expect(run('SELECT DISTINCT _id FROM orders')).toBe(
      pipeline('orders', [
        "{ $group: { _id: { _id: '$_id' } } }",
        "{ $project: { _id: '$_id._id' } }",
      ]),
    );
  });

  it('DISTINCT on a deep path names the output by the last part', () => {
    expect(run('SELECT DISTINCT customer.address.city FROM orders')).toBe(
      pipeline('orders', [
        "{ $group: { _id: { city: '$customer.address.city' } } }",
        "{ $project: { _id: 0, city: '$_id.city' } }",
      ]),
    );
  });
});

describe('round 2: COUNT(column) versus COUNT(*)', () => {
  it('COUNT(*) after a LIKE filter', () => {
    expect(run("SELECT COUNT(*) AS n FROM orders WHERE name LIKE 'a%'")).toBe(
      pipeline('orders', [
        '{ $match: { name: /^a/i } }',
        '{ $group: { _id: null, n: { $sum: 1 } } }',
        '{ $project: { _id: 0, n: 1 } }',
      ]),
    );
  });

  it('COUNT(1) counts every row, like COUNT(*)', () => {
    // The contract is silent on a literal argument and the translator applies the COUNT(column)
    // rule. A literal is never null, so the null test is always 1 and the rows agree with
    // SQL Server; a plain `$sum: 1` would read better.
    expect(run('SELECT COUNT(1) AS n FROM orders')).toBe(
      pipeline('orders', [
        '{ $group: { _id: null, n: { $sum: { $cond: [{ $gt: [1, null] }, 1, 0] } } } }',
        '{ $project: { _id: 0, n: 1 } }',
      ]),
    );
  });

  it('sorts by a COUNT(DISTINCT) alias after the $size projection', () => {
    expect(
      run('SELECT status, COUNT(DISTINCT city) AS n FROM orders GROUP BY status ORDER BY n DESC'),
    ).toBe(
      pipeline('orders', [
        "{ $group: { _id: '$status', n: { $addToSet: '$city' } } }",
        "{ $project: { _id: 0, status: '$_id', n: { $size: { $filter: { input: '$n', cond: { $ne: ['$$this', null] } } } } } }",
        '{ $sort: { n: -1 } }',
      ]),
    );
  });

  it('two aliases of the same COUNT(*) share one accumulator', () => {
    expect(run('SELECT COUNT(*) AS a, COUNT(*) AS b FROM orders')).toBe(
      pipeline('orders', [
        '{ $group: { _id: null, a: { $sum: 1 } } }',
        "{ $project: { _id: 0, a: 1, b: '$a' } }",
      ]),
    );
  });

  it('two unaliased COUNT(*) columns get numbered names', () => {
    expect(run('SELECT COUNT(*), COUNT(*) FROM orders')).toBe(
      pipeline('orders', [
        '{ $group: { _id: null, count: { $sum: 1 } } }',
        "{ $project: { _id: 0, count: 1, count2: '$count' } }",
      ]),
    );
  });

  it('COUNT(*) and COUNT(joined) differ after a LEFT JOIN, as in SQL Server', () => {
    expect(
      run(
        'SELECT c.name, COUNT(*) AS rows, COUNT(o._id) AS orders FROM customers c LEFT JOIN orders o ON o.customerId = c._id GROUP BY c.name',
      ),
    ).toBe(
      pipeline('customers', [
        "{ $lookup: { from: 'orders', localField: '_id', foreignField: 'customerId', as: 'o' } }",
        "{ $unwind: { path: '$o', preserveNullAndEmptyArrays: true } }",
        "{ $group: { _id: '$name', rows: { $sum: 1 }, orders: { $sum: { $cond: [{ $gt: ['$o._id', null] }, 1, 0] } } } }",
        "{ $project: { _id: 0, name: '$_id', rows: 1, orders: 1 } }",
      ]),
    );
  });

  it('an expression over COUNT(*) projects from the hidden accumulator', () => {
    expect(run('SELECT COUNT(*) + 1 AS n FROM orders')).toBe(
      pipeline('orders', [
        '{ $group: { _id: null, count: { $sum: 1 } } }',
        "{ $project: { _id: 0, n: { $add: ['$count', 1] } } }",
      ]),
    );
  });

  it('COUNT(_id) is named with the underscore kept', () => {
    expect(run('SELECT COUNT(_id) FROM orders')).toBe(
      pipeline('orders', [
        "{ $group: { _id: null, count__id: { $sum: { $cond: [{ $gt: ['$_id', null] }, 1, 0] } } } }",
        '{ $project: { _id: 0, count__id: 1 } }',
      ]),
    );
  });

  it('refuses a plain column next to COUNT(*) without GROUP BY', () => {
    expect(fail('SELECT name, COUNT(*) FROM orders')).toEqual({
      message: 'column name must appear in GROUP BY or inside an aggregate function',
      at: 'name',
    });
  });

  it('refuses an aggregate in WHERE', () => {
    expect(fail('SELECT * FROM orders WHERE COUNT(*) > 1')).toEqual({
      message: 'aggregate functions need GROUP BY',
      at: 'COUNT(*)',
    });
  });

  it('a group key that the select list omits still groups the rows', () => {
    expect(run('SELECT status, COUNT(*) FROM orders GROUP BY status, region')).toBe(
      pipeline('orders', [
        "{ $group: { _id: { status: '$status', region: '$region' }, count: { $sum: 1 } } }",
        "{ $project: { _id: 0, status: '$_id.status', count: 1 } }",
      ]),
    );
  });

  it('an expression over a group key reads it back from _id', () => {
    expect(run('SELECT UPPER(status) FROM orders GROUP BY status')).toBe(
      pipeline('orders', [
        "{ $group: { _id: '$status' } }",
        "{ $project: { _id: 0, upper_status: { $toUpper: '$_id' } } }",
      ]),
    );
  });
});

describe('round 2: HAVING on an aggregate not in the select list', () => {
  it('OR of two hidden aggregates', () => {
    expect(
      run('SELECT status FROM orders GROUP BY status HAVING COUNT(*) > 5 OR SUM(total) > 100'),
    ).toBe(
      pipeline('orders', [
        "{ $group: { _id: '$status', having_1: { $sum: 1 }, having_2: { $sum: '$total' } } }",
        '{ $match: { $or: [{ having_1: { $gt: 5 } }, { having_2: { $gt: 100 } }] } }',
        "{ $project: { _id: 0, status: '$_id' } }",
      ]),
    );
  });

  it('an expression over hidden aggregates uses $expr', () => {
    expect(run('SELECT status FROM orders GROUP BY status HAVING SUM(total) / COUNT(*) > 5')).toBe(
      pipeline('orders', [
        "{ $group: { _id: '$status', having_1: { $sum: '$total' }, having_2: { $sum: 1 } } }",
        "{ $match: { $expr: { $gt: [{ $divide: ['$having_1', '$having_2'] }, 5] } } }",
        "{ $project: { _id: 0, status: '$_id' } }",
      ]),
    );
  });

  it('ORDER BY reuses the hidden HAVING accumulator', () => {
    expect(
      run('SELECT status FROM orders GROUP BY status HAVING SUM(total) > 1 ORDER BY SUM(total)'),
    ).toBe(
      pipeline('orders', [
        "{ $group: { _id: '$status', having_1: { $sum: '$total' } } }",
        '{ $match: { having_1: { $gt: 1 } } }',
        '{ $sort: { having_1: 1 } }',
        "{ $project: { _id: 0, status: '$_id' } }",
      ]),
    );
  });

  it('HAVING reuses an unaliased select aggregate by its default name', () => {
    expect(run('SELECT status, SUM(total) FROM orders GROUP BY status HAVING SUM(total) > 1')).toBe(
      pipeline('orders', [
        "{ $group: { _id: '$status', sum_total: { $sum: '$total' } } }",
        '{ $match: { sum_total: { $gt: 1 } } }',
        "{ $project: { _id: 0, status: '$_id', sum_total: 1 } }",
      ]),
    );
  });

  it('NOT in HAVING negates the operator object', () => {
    expect(run('SELECT status FROM orders GROUP BY status HAVING NOT COUNT(*) > 5')).toBe(
      pipeline('orders', [
        "{ $group: { _id: '$status', having_1: { $sum: 1 } } }",
        '{ $match: { having_1: { $not: { $gt: 5 } } } }',
        "{ $project: { _id: 0, status: '$_id' } }",
      ]),
    );
  });

  it('IS NULL on a hidden aggregate', () => {
    expect(run('SELECT status FROM orders GROUP BY status HAVING MAX(x) IS NULL')).toBe(
      pipeline('orders', [
        "{ $group: { _id: '$status', having_1: { $max: '$x' } } }",
        '{ $match: { having_1: null } }',
        "{ $project: { _id: 0, status: '$_id' } }",
      ]),
    );
  });

  it('a hidden aggregate over an arithmetic expression', () => {
    expect(run('SELECT status FROM orders GROUP BY status HAVING SUM(qty * price) > 100')).toBe(
      pipeline('orders', [
        "{ $group: { _id: '$status', having_1: { $sum: { $multiply: ['$qty', '$price'] } } } }",
        '{ $match: { having_1: { $gt: 100 } } }',
        "{ $project: { _id: 0, status: '$_id' } }",
      ]),
    );
  });

  it('COUNT(*) in HAVING is not the COUNT(column) of the select list', () => {
    expect(
      run('SELECT status, COUNT(email) AS e FROM orders GROUP BY status HAVING COUNT(*) > 1'),
    ).toBe(
      pipeline('orders', [
        "{ $group: { _id: '$status', e: { $sum: { $cond: [{ $gt: ['$email', null] }, 1, 0] } }, having_1: { $sum: 1 } } }",
        '{ $match: { having_1: { $gt: 1 } } }',
        "{ $project: { _id: 0, status: '$_id', e: 1 } }",
      ]),
    );
  });

  it('a key test and a hidden aggregate merge into one $match', () => {
    expect(
      run("SELECT status FROM orders GROUP BY status HAVING status <> 'x' AND COUNT(*) > 1"),
    ).toBe(
      pipeline('orders', [
        "{ $group: { _id: '$status', having_1: { $sum: 1 } } }",
        "{ $match: { _id: { $ne: 'x' }, having_1: { $gt: 1 } } }",
        "{ $project: { _id: 0, status: '$_id' } }",
      ]),
    );
  });

  it('a key test on a multi-key group reads the key under _id', () => {
    expect(
      run(
        "SELECT status, region, COUNT(*) AS n FROM orders GROUP BY status, region HAVING region = 'eu'",
      ),
    ).toBe(
      pipeline('orders', [
        "{ $group: { _id: { status: '$status', region: '$region' }, n: { $sum: 1 } } }",
        "{ $match: { '_id.region': 'eu' } }",
        "{ $project: { _id: 0, status: '$_id.status', region: '$_id.region', n: 1 } }",
      ]),
    );
  });
});

describe('round 2: nested dotted paths three deep', () => {
  it.each([
    [
      'SELECT [o].[customer].[address].[city] FROM orders AS o',
      "db.orders.find({}, { _id: 0, 'customer.address.city': 1 })",
    ],
    [
      'SELECT a.b.c.d FROM orders WHERE a.b.c.d = 1',
      "db.orders.find({ 'a.b.c.d': 1 }, { _id: 0, 'a.b.c.d': 1 })",
    ],
    [
      'SELECT * FROM orders WHERE customer.address.city IS NULL',
      "db.orders.find({ 'customer.address.city': null })",
    ],
    [
      'SELECT customer.address.city FROM orders ORDER BY customer.address.city',
      "db.orders.find({}, { _id: 0, 'customer.address.city': 1 }).sort({ 'customer.address.city': 1 })",
    ],
    [
      "INSERT INTO orders (customer.address.city, customer.address.zip, name) VALUES ('Oslo', '0150', 'x')",
      "db.orders.insertMany([{ customer: { address: { city: 'Oslo', zip: '0150' } }, name: 'x' }])",
    ],
    [
      'UPDATE orders SET customer.address.city = UPPER(customer.address.city)',
      "db.orders.updateMany({}, [{ $set: { 'customer.address.city': { $toUpper: '$customer.address.city' } } }])",
    ],
  ])('%s', (sql, expected) => {
    expect(run(sql)).toBe(expected);
  });

  it('aliases a deep joined path', () => {
    expect(
      run('SELECT c.address.geo.lat AS lat FROM orders o JOIN customers c ON o.customerId = c._id'),
    ).toBe(
      pipeline('orders', [
        "{ $lookup: { from: 'customers', localField: 'customerId', foreignField: '_id', as: 'c' } }",
        "{ $unwind: '$c' }",
        "{ $project: { _id: 0, lat: '$c.address.geo.lat' } }",
      ]),
    );
  });

  it('names an unaliased MAX of a deep path with underscores', () => {
    expect(run('SELECT MAX(customer.address.zip) FROM orders')).toBe(
      pipeline('orders', [
        "{ $group: { _id: null, max_customer_address_zip: { $max: '$customer.address.zip' } } }",
        '{ $project: { _id: 0, max_customer_address_zip: 1 } }',
      ]),
    );
  });

  it('a deep path as the join key is the localField', () => {
    expect(run('SELECT c.name FROM orders o JOIN customers c ON o.customer.ref.id = c._id')).toBe(
      pipeline('orders', [
        "{ $lookup: { from: 'customers', localField: 'customer.ref.id', foreignField: '_id', as: 'c' } }",
        "{ $unwind: '$c' }",
        "{ $project: { _id: 0, name: '$c.name' } }",
      ]),
    );
  });

  it('applies the joined table hint to a deep joined path', () => {
    const options = hints({ 'customers.address.since': 'date' });
    expect(
      run(
        "SELECT o.total FROM orders o JOIN customers c ON o.customerId = c._id WHERE c.address.since > '2026-01-01'",
        options,
      ),
    ).toBe(
      pipeline('orders', [
        "{ $lookup: { from: 'customers', localField: 'customerId', foreignField: '_id', as: 'c' } }",
        "{ $unwind: '$c' }",
        "{ $match: { 'c.address.since': { $gt: ISODate('2026-01-01T00:00:00.000Z') } } }",
        '{ $project: { _id: 0, total: 1 } }',
      ]),
    );
  });
});

describe('round 2: _id in and out of the select list', () => {
  it.each([
    [
      'SELECT _id, name FROM orders WHERE _id > 5 ORDER BY _id',
      'db.orders.find({ _id: { $gt: 5 } }, { _id: 1, name: 1 }).sort({ _id: 1 })',
    ],
    [
      'SELECT TOP 1 _id FROM orders ORDER BY _id DESC',
      'db.orders.find({}, { _id: 1 }).sort({ _id: -1 }).limit(1)',
    ],
    [
      "INSERT INTO orders (_id, name) VALUES (1, 'x')",
      "db.orders.insertMany([{ _id: 1, name: 'x' }])",
    ],
    ['DELETE FROM orders WHERE _id = 1', 'db.orders.deleteMany({ _id: 1 })'],
  ])('%s', (sql, expected) => {
    expect(run(sql)).toBe(expected);
  });

  it('keeps _id when it is listed after an alias', () => {
    expect(run('SELECT name AS n, _id FROM orders')).toBe(
      pipeline('orders', ["{ $project: { _id: 1, n: '$name' } }"]),
    );
  });

  it('drops _id when only its alias is listed next to a plain column', () => {
    expect(run('SELECT name, _id AS id FROM orders')).toBe(
      pipeline('orders', ["{ $project: { _id: 0, name: 1, id: '$_id' } }"]),
    );
  });

  it('aliases both ids of a join', () => {
    expect(
      run(
        'SELECT o._id AS id, c._id AS customerId FROM orders o JOIN customers c ON o.customerId = c._id',
      ),
    ).toBe(
      pipeline('orders', [
        "{ $lookup: { from: 'customers', localField: 'customerId', foreignField: '_id', as: 'c' } }",
        "{ $unwind: '$c' }",
        "{ $project: { _id: 0, id: '$_id', customerId: '$c._id' } }",
      ]),
    );
  });

  it('GROUP BY _id without an aggregate', () => {
    expect(run('SELECT _id FROM orders GROUP BY _id')).toBe(
      pipeline('orders', ["{ $group: { _id: '$_id' } }", "{ $project: { _id: '$_id' } }"]),
    );
  });

  it('coerces an inserted _id from the schema hint', () => {
    expect(
      run(
        `INSERT INTO orders (_id, name) VALUES ('${OID}', 'x')`,
        hints({ 'orders._id': 'objectId' }),
      ),
    ).toBe(`db.orders.insertMany([{ _id: ObjectId('${OID}'), name: 'x' }])`);
  });

  it('refuses _id in the select list when the group key is another column', () => {
    expect(fail('SELECT _id, COUNT(*) FROM orders GROUP BY status')).toEqual({
      message: 'column _id must appear in GROUP BY or inside an aggregate function',
      at: '_id',
    });
  });

  it('filters a joined _id after the $lookup', () => {
    expect(
      run(
        `SELECT c.name FROM orders o JOIN customers c ON o.customerId = c._id WHERE c._id = CAST('${OID}' AS OBJECTID)`,
      ),
    ).toBe(
      pipeline('orders', [
        "{ $lookup: { from: 'customers', localField: 'customerId', foreignField: '_id', as: 'c' } }",
        "{ $unwind: '$c' }",
        `{ $match: { 'c._id': ObjectId('${OID}') } }`,
        "{ $project: { _id: 0, name: '$c.name' } }",
      ]),
    );
  });
});

describe('round 2: dates in WHERE', () => {
  it.each([
    [
      'SELECT * FROM orders WHERE createdAt > GETDATE()',
      'db.orders.find({ createdAt: { $gt: new Date() } })',
    ],
    [
      'SELECT * FROM orders WHERE createdAt > DATEADD(day, -7, GETDATE())',
      "db.orders.find({ $expr: { $gt: ['$createdAt', { $dateAdd: { startDate: '$$NOW', unit: 'day', amount: -7 } }] } })",
    ],
    [
      'SELECT * FROM orders WHERE YEAR(createdAt) = 2026',
      "db.orders.find({ $expr: { $eq: [{ $year: '$createdAt' }, 2026] } })",
    ],
    // Without a hint the contract keeps the string, so this compares text in MongoDB.
    [
      "SELECT * FROM orders WHERE createdAt >= '2026-01-01'",
      "db.orders.find({ createdAt: { $gte: '2026-01-01' } })",
    ],
  ])('%s', (sql, expected) => {
    expect(run(sql)).toBe(expected);
  });

  it('a string compared with a column cast to DATETIME is read as a date', () => {
    // SQL Server converts the string to a datetime because the other side is one. The contract is
    // silent on a CAST as the other operand; a string next to $toDate never matches in MongoDB,
    // so the literal must become an ISODate for the rows to agree.
    expect(run("SELECT * FROM orders WHERE CAST(createdAt AS DATETIME) >= '2026-01-01'")).toBe(
      "db.orders.find({ $expr: { $gte: [{ $toDate: '$createdAt' }, ISODate('2026-01-01T00:00:00.000Z')] } })",
    );
  });
});

describe('round 2: literals in output and filter positions', () => {
  it.each([
    // A string that starts with $ would read as a field path in a pipeline, so it is wrapped.
    ["SELECT '$foo' AS v FROM orders", "{ $project: { _id: 0, v: { $literal: '$foo' } } }"],
    // A bare number or boolean in $project would mean inclusion, so it is wrapped too.
    ['SELECT 1 AS one FROM orders', '{ $project: { _id: 0, one: { $literal: 1 } } }'],
    ['SELECT TRUE AS t FROM orders', '{ $project: { _id: 0, t: { $literal: true } } }'],
    ["SELECT 'a' AS s FROM orders", "{ $project: { _id: 0, s: 'a' } }"],
    ['SELECT GETDATE() AS now FROM orders', "{ $project: { _id: 0, now: '$$NOW' } }"],
    [
      'SELECT DATEDIFF(day, createdAt, GETDATE()) AS age FROM orders',
      "{ $project: { _id: 0, age: { $dateDiff: { startDate: '$createdAt', endDate: '$$NOW', unit: 'day' } } } }",
    ],
  ])('%s', (sql, stage) => {
    expect(run(sql)).toBe(pipeline('orders', [stage]));
  });

  it.each([
    // In a query document a string is never a path, so no wrapping is needed.
    ["SELECT * FROM orders WHERE name = '$x'", "db.orders.find({ name: '$x' })"],
    [
      "SELECT * FROM orders WHERE name + '' = '$x'",
      "db.orders.find({ $expr: { $eq: [{ $concat: ['$name', ''] }, { $literal: '$x' }] } })",
    ],
    [
      'SELECT * FROM orders WHERE DATEDIFF(day, createdAt, GETDATE()) > 30',
      "db.orders.find({ $expr: { $gt: [{ $dateDiff: { startDate: '$createdAt', endDate: '$$NOW', unit: 'day' } }, 30] } })",
    ],
    [
      "SELECT * FROM orders WHERE createdAt >= CONVERT(DATETIME, '2026-01-01 10:30', 120)",
      "db.orders.find({ createdAt: { $gte: ISODate('2026-01-01T10:30:00.000Z') } })",
    ],
    [
      "SELECT * FROM orders WHERE status = 'a' OR status = 'b' OR status = 'c'",
      "db.orders.find({ $or: [{ status: 'a' }, { status: 'b' }, { status: 'c' }] })",
    ],
    [
      'SELECT * FROM orders WHERE NOT (a = 1) AND NOT (b = 2)',
      'db.orders.find({ $and: [{ $nor: [{ a: 1 }] }, { $nor: [{ b: 2 }] }] })',
    ],
    // An escaped bracket is a literal bracket, not the start of a class.
    [
      "SELECT * FROM orders WHERE name LIKE 'a![b' ESCAPE '!'",
      'db.orders.find({ name: /^a\\[b$/i })',
    ],
  ])('%s', (sql, expected) => {
    expect(run(sql)).toBe(expected);
  });

  it('refuses a select alias in GROUP BY, as SQL Server does', () => {
    expect(fail('SELECT status s FROM orders GROUP BY s')).toEqual({
      message: 'column status must appear in GROUP BY or inside an aggregate function',
      at: 'status',
    });
  });
});
