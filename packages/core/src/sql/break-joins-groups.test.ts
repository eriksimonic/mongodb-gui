/**
 * End-to-end cases for joins and grouping: chained joins, the placement of `$match` around
 * `$lookup`, grouping and aggregates over joined fields, output name collisions, DISTINCT over a
 * join and ORDER BY after a group. Each case asserts the mongosh text a SQL Server user would
 * expect under the design contract. Where the contract is silent the comment on the case says
 * what MongoDB needs to return the same rows as SQL Server.
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

function pipeline(stages: readonly string[], collection = 'orders'): string {
  return `db.${collection}.aggregate([\n${stages.map((stage) => `  ${stage}`).join(',\n')}\n])`;
}

const JOIN_C = 'JOIN customers c ON o.customerId = c._id';
const LEFT_C = 'LEFT JOIN customers c ON o.customerId = c._id';
const JOIN_R = 'JOIN regions r ON c.regionId = r._id';
const LEFT_R = 'LEFT JOIN regions r ON c.regionId = r._id';
const JOIN_K = 'JOIN countries k ON r.countryId = k._id';

const lookupC =
  "{ $lookup: { from: 'customers', localField: 'customerId', foreignField: '_id', as: 'c' } }";
const unwindC = "{ $unwind: '$c' }";
const leftC = "{ $unwind: { path: '$c', preserveNullAndEmptyArrays: true } }";
const lookupR =
  "{ $lookup: { from: 'regions', localField: 'c.regionId', foreignField: '_id', as: 'r' } }";
const unwindR = "{ $unwind: '$r' }";
const leftR = "{ $unwind: { path: '$r', preserveNullAndEmptyArrays: true } }";
const lookupK =
  "{ $lookup: { from: 'countries', localField: 'r.countryId', foreignField: '_id', as: 'k' } }";
const unwindK = "{ $unwind: '$k' }";
const JOIN_ERROR = 'JOIN ... ON must compare one column of each table with =';

describe('chained joins', () => {
  it('chains two inner joins where the second joins on the first alias', () => {
    const sql = `SELECT o.orderId, c.name AS customer, r.name AS region FROM orders o ${JOIN_C} ${JOIN_R}`;
    expect(run(sql)).toBe(
      pipeline([
        lookupC,
        unwindC,
        lookupR,
        unwindR,
        "{ $project: { _id: 0, orderId: 1, customer: '$c.name', region: '$r.name' } }",
      ]),
    );
  });

  it('chains three inner joins, each on the alias of the one before', () => {
    const sql = `SELECT o.orderId, k.code AS country FROM orders o ${JOIN_C} ${JOIN_R} ${JOIN_K}`;
    expect(run(sql)).toBe(
      pipeline([
        lookupC,
        unwindC,
        lookupR,
        unwindR,
        lookupK,
        unwindK,
        "{ $project: { _id: 0, orderId: 1, country: '$k.code' } }",
      ]),
    );
  });

  it('joins a second table on the base table (star schema)', () => {
    const sql = `SELECT o.orderId, c.name AS customer, p.title FROM orders o ${JOIN_C} JOIN products p ON o.productId = p._id`;
    expect(run(sql)).toBe(
      pipeline([
        lookupC,
        unwindC,
        "{ $lookup: { from: 'products', localField: 'productId', foreignField: '_id', as: 'p' } }",
        "{ $unwind: '$p' }",
        "{ $project: { _id: 0, orderId: 1, customer: '$c.name', title: '$p.title' } }",
      ]),
    );
  });

  it('accepts the joined table on the left of the ON for a chained join', () => {
    const sql = `SELECT o.orderId FROM orders o ${JOIN_C} JOIN regions r ON r._id = c.regionId`;
    expect(run(sql)).toBe(
      pipeline([lookupC, unwindC, lookupR, unwindR, '{ $project: { _id: 0, orderId: 1 } }']),
    );
  });

  it('keeps the LEFT unwind for the first join and a plain unwind for the INNER join after it', () => {
    const sql = `SELECT o.orderId, r.name AS region FROM orders o ${LEFT_C} INNER ${JOIN_R}`;
    expect(run(sql)).toBe(
      pipeline([
        lookupC,
        leftC,
        lookupR,
        unwindR,
        "{ $project: { _id: 0, orderId: 1, region: '$r.name' } }",
      ]),
    );
  });

  it('keeps a plain unwind for the INNER join and a LEFT unwind for the LEFT join after it', () => {
    const sql = `SELECT o.orderId, r.name AS region FROM orders o INNER ${JOIN_C} ${LEFT_R}`;
    expect(run(sql)).toBe(
      pipeline([
        lookupC,
        unwindC,
        lookupR,
        leftR,
        "{ $project: { _id: 0, orderId: 1, region: '$r.name' } }",
      ]),
    );
  });

  it('chains two LEFT OUTER joins', () => {
    const sql = `SELECT o.orderId, r.name AS region FROM orders o LEFT OUTER JOIN customers c ON o.customerId = c._id LEFT OUTER JOIN regions r ON c.regionId = r._id`;
    expect(run(sql)).toBe(
      pipeline([
        lookupC,
        leftC,
        lookupR,
        leftR,
        "{ $project: { _id: 0, orderId: 1, region: '$r.name' } }",
      ]),
    );
  });

  it('joins a collection to itself under two aliases', () => {
    const sql =
      'SELECT e.name, m.name AS manager FROM employees e LEFT JOIN employees m ON e.managerId = m._id';
    expect(run(sql)).toBe(
      pipeline(
        [
          "{ $lookup: { from: 'employees', localField: 'managerId', foreignField: '_id', as: 'm' } }",
          "{ $unwind: { path: '$m', preserveNullAndEmptyArrays: true } }",
          "{ $project: { _id: 0, name: 1, manager: '$m.name' } }",
        ],
        'employees',
      ),
    );
  });

  it('uses nested paths on both sides of the ON', () => {
    const sql = 'SELECT o.orderId FROM orders o JOIN customers c ON o.customer.id = c.ids.primary';
    expect(run(sql)).toBe(
      pipeline([
        "{ $lookup: { from: 'customers', localField: 'customer.id', foreignField: 'ids.primary', as: 'c' } }",
        unwindC,
        '{ $project: { _id: 0, orderId: 1 } }',
      ]),
    );
  });

  it('uses the table names as aliases when none are given, across two joins', () => {
    const sql =
      'SELECT orders.orderId, customers.name FROM orders JOIN customers ON orders.customerId = customers._id JOIN regions ON customers.regionId = regions._id';
    expect(run(sql)).toBe(
      pipeline([
        "{ $lookup: { from: 'customers', localField: 'customerId', foreignField: '_id', as: 'customers' } }",
        "{ $unwind: '$customers' }",
        "{ $lookup: { from: 'regions', localField: 'customers.regionId', foreignField: '_id', as: 'regions' } }",
        "{ $unwind: '$regions' }",
        "{ $project: { _id: 0, orderId: 1, name: '$customers.name' } }",
      ]),
    );
  });

  it('drops the dbo prefix from the base and the joined table', () => {
    const sql = 'SELECT o.orderId FROM dbo.orders o JOIN dbo.customers c ON o.customerId = c._id';
    expect(run(sql)).toBe(pipeline([lookupC, unwindC, '{ $project: { _id: 0, orderId: 1 } }']));
  });

  it('lets a join alias win over a nested field of the same name', () => {
    const sql =
      'SELECT customer.name FROM orders o JOIN customers customer ON o.customerId = customer._id';
    expect(run(sql)).toBe(
      pipeline([
        "{ $lookup: { from: 'customers', localField: 'customerId', foreignField: '_id', as: 'customer' } }",
        "{ $unwind: '$customer' }",
        "{ $project: { _id: 0, name: '$customer.name' } }",
      ]),
    );
  });

  it('treats a qualifier that is no alias as a nested path of the base collection', () => {
    const sql = `SELECT x.name FROM orders o ${JOIN_C}`;
    expect(run(sql)).toBe(pipeline([lookupC, unwindC, "{ $project: { _id: 0, 'x.name': 1 } }"]));
  });
});

describe('join errors', () => {
  it('refuses an ON that references a later join', () => {
    const sql =
      'SELECT o.orderId FROM orders o JOIN customers c ON c.regionId = r._id JOIN regions r ON o.regionId = r._id';
    expect(fail(sql)).toEqual({ message: JOIN_ERROR, at: 'c.regionId = r._id' });
  });

  it('refuses an ON with two conditions', () => {
    const sql =
      'SELECT o.orderId FROM orders o JOIN customers c ON o.customerId = c._id AND c.active = TRUE';
    expect(fail(sql)).toEqual({
      message: JOIN_ERROR,
      at: 'o.customerId = c._id AND c.active = TRUE',
    });
  });

  it('refuses an ON that compares with a literal', () => {
    const sql = 'SELECT o.orderId FROM orders o JOIN customers c ON c._id = 5';
    expect(fail(sql)).toEqual({ message: JOIN_ERROR, at: 'c._id = 5' });
  });

  it('refuses an ON that compares two base columns', () => {
    const sql = 'SELECT o.orderId FROM orders o JOIN customers c ON o.customerId = o._id';
    expect(fail(sql)).toEqual({ message: JOIN_ERROR, at: 'o.customerId = o._id' });
  });

  it('refuses an ON that compares two columns of the joined table', () => {
    const sql = 'SELECT o.orderId FROM orders o JOIN customers c ON c.a = c.b';
    expect(fail(sql)).toEqual({ message: JOIN_ERROR, at: 'c.a = c.b' });
  });

  it('refuses an ON with an operator other than =', () => {
    const sql = 'SELECT o.orderId FROM orders o JOIN customers c ON o.customerId <> c._id';
    expect(fail(sql)).toEqual({ message: JOIN_ERROR, at: 'o.customerId <> c._id' });
  });

  it('refuses a join alias used as a column', () => {
    const sql = `SELECT c FROM orders o ${JOIN_C}`;
    expect(fail(sql)).toEqual({ message: 'c is a table alias, not a column', at: 'c' });
  });

  it('refuses alias.* for an unknown alias', () => {
    const sql = `SELECT x.* FROM orders o ${JOIN_C}`;
    expect(fail(sql)).toEqual({ message: 'unknown table alias x', at: 'x.*' });
  });
});

describe('WHERE placement around $lookup', () => {
  it('puts conjuncts on the base collection before the lookup, merged into one $match', () => {
    const sql = `SELECT o.orderId FROM orders o ${JOIN_C} WHERE o.status = 'paid' AND o.total > 100`;
    expect(run(sql)).toBe(
      pipeline([
        "{ $match: { status: 'paid', total: { $gt: 100 } } }",
        lookupC,
        unwindC,
        '{ $project: { _id: 0, orderId: 1 } }',
      ]),
    );
  });

  it('puts a conjunct on the joined collection after the unwind', () => {
    const sql = `SELECT o.orderId FROM orders o ${JOIN_C} WHERE c.country = 'DE'`;
    expect(run(sql)).toBe(
      pipeline([
        lookupC,
        unwindC,
        "{ $match: { 'c.country': 'DE' } }",
        '{ $project: { _id: 0, orderId: 1 } }',
      ]),
    );
  });

  it('splits base and join conjuncts around the lookup', () => {
    const sql = `SELECT o.orderId FROM orders o ${JOIN_C} WHERE c.country = 'DE' AND o.total > 100`;
    expect(run(sql)).toBe(
      pipeline([
        '{ $match: { total: { $gt: 100 } } }',
        lookupC,
        unwindC,
        "{ $match: { 'c.country': 'DE' } }",
        '{ $project: { _id: 0, orderId: 1 } }',
      ]),
    );
  });

  it('keeps an OR that mixes base and join after the lookup', () => {
    const sql = `SELECT o.orderId FROM orders o ${JOIN_C} WHERE o.total > 100 OR c.vip = TRUE`;
    expect(run(sql)).toBe(
      pipeline([
        lookupC,
        unwindC,
        "{ $match: { $or: [{ total: { $gt: 100 } }, { 'c.vip': true }] } }",
        '{ $project: { _id: 0, orderId: 1 } }',
      ]),
    );
  });

  it('splits a base conjunct from a mixed OR conjunct', () => {
    const sql = `SELECT o.orderId FROM orders o ${JOIN_C} WHERE o.status = 'paid' AND (o.total > 100 OR c.vip = TRUE)`;
    expect(run(sql)).toBe(
      pipeline([
        "{ $match: { status: 'paid' } }",
        lookupC,
        unwindC,
        "{ $match: { $or: [{ total: { $gt: 100 } }, { 'c.vip': true }] } }",
        '{ $project: { _id: 0, orderId: 1 } }',
      ]),
    );
  });

  it('compares a base column with a joined column through $expr after the lookup', () => {
    const sql = `SELECT o.orderId FROM orders o ${JOIN_C} WHERE o.total > c.credit`;
    expect(run(sql)).toBe(
      pipeline([
        lookupC,
        unwindC,
        "{ $match: { $expr: { $gt: ['$total', '$c.credit'] } } }",
        '{ $project: { _id: 0, orderId: 1 } }',
      ]),
    );
  });

  it('compares a base column with an expression over a joined column', () => {
    const sql = `SELECT o.orderId FROM orders o ${JOIN_C} WHERE o.total > c.credit * 2`;
    expect(run(sql)).toBe(
      pipeline([
        lookupC,
        unwindC,
        "{ $match: { $expr: { $gt: ['$total', { $multiply: ['$c.credit', 2] }] } } }",
        '{ $project: { _id: 0, orderId: 1 } }',
      ]),
    );
  });

  it('translates the LEFT JOIN anti-join (WHERE joined id IS NULL)', () => {
    // A LEFT JOIN with no match leaves `c` missing after the preserving unwind, and `{ 'c._id':
    // null }` matches a missing field, so the rows are the ones SQL Server returns.
    const sql = `SELECT o.orderId FROM orders o ${LEFT_C} WHERE c._id IS NULL`;
    expect(run(sql)).toBe(
      pipeline([
        lookupC,
        leftC,
        "{ $match: { 'c._id': null } }",
        '{ $project: { _id: 0, orderId: 1 } }',
      ]),
    );
  });

  it('merges conjuncts on two different joins into one $match after the last lookup', () => {
    const sql = `SELECT o.orderId FROM orders o ${JOIN_C} ${JOIN_R} WHERE c.active = TRUE AND r.name = 'EU'`;
    expect(run(sql)).toBe(
      pipeline([
        lookupC,
        unwindC,
        lookupR,
        unwindR,
        "{ $match: { 'c.active': true, 'r.name': 'EU' } }",
        '{ $project: { _id: 0, orderId: 1 } }',
      ]),
    );
  });

  it('splits base, first-join and second-join conjuncts in a three table query', () => {
    const sql = `SELECT o.orderId FROM orders o ${JOIN_C} ${JOIN_R} WHERE r.name = 'EU' AND o.total >= 10 AND c.active = TRUE`;
    expect(run(sql)).toBe(
      pipeline([
        '{ $match: { total: { $gte: 10 } } }',
        lookupC,
        unwindC,
        lookupR,
        unwindR,
        "{ $match: { 'r.name': 'EU', 'c.active': true } }",
        '{ $project: { _id: 0, orderId: 1 } }',
      ]),
    );
  });

  it('keeps IN on the base before the lookup and LIKE on the join after it', () => {
    const sql = `SELECT o.orderId FROM orders o ${JOIN_C} WHERE o.status IN ('paid', 'shipped') AND c.email LIKE '%@example.com'`;
    expect(run(sql)).toBe(
      pipeline([
        "{ $match: { status: { $in: ['paid', 'shipped'] } } }",
        lookupC,
        unwindC,
        "{ $match: { 'c.email': /@example\\.com$/i } }",
        '{ $project: { _id: 0, orderId: 1 } }',
      ]),
    );
  });

  it('keeps BETWEEN on the base before the lookup and IS NOT NULL on the join after it', () => {
    const sql = `SELECT o.orderId FROM orders o ${JOIN_C} WHERE o.total BETWEEN 10 AND 20 AND c.vip IS NOT NULL`;
    expect(run(sql)).toBe(
      pipeline([
        '{ $match: { total: { $gte: 10, $lte: 20 } } }',
        lookupC,
        unwindC,
        "{ $match: { 'c.vip': { $ne: null } } }",
        '{ $project: { _id: 0, orderId: 1 } }',
      ]),
    );
  });

  it('applies the type hint of the joined collection to a literal compared with its column', () => {
    const options: TranslateOptions = {
      fieldType: (collection, path) => {
        if (collection === 'customers' && path === 'since') return 'date';
        if (collection === 'orders' && path === 'customerId') return 'objectId';
        return undefined;
      },
    };
    const sql = `SELECT o.orderId FROM orders o ${JOIN_C} WHERE c.since >= '2026-01-01' AND o.customerId = '0123456789abcdef01234567'`;
    expect(run(sql, options)).toBe(
      pipeline([
        "{ $match: { customerId: ObjectId('0123456789abcdef01234567') } }",
        lookupC,
        unwindC,
        "{ $match: { 'c.since': { $gte: ISODate('2026-01-01T00:00:00.000Z') } } }",
        '{ $project: { _id: 0, orderId: 1 } }',
      ]),
    );
  });
});

describe('select shapes over joins', () => {
  it('keeps _id when it is listed next to a joined column', () => {
    const sql = `SELECT o._id, c.name FROM orders o ${JOIN_C}`;
    expect(run(sql)).toBe(
      pipeline([lookupC, unwindC, "{ $project: { _id: 1, name: '$c.name' } }"]),
    );
  });

  it('keeps the whole join object next to a base column', () => {
    const sql = `SELECT o.orderId, c.* FROM orders o ${JOIN_C}`;
    expect(run(sql)).toBe(
      pipeline([lookupC, unwindC, '{ $project: { _id: 0, orderId: 1, c: 1 } }']),
    );
  });

  it('keeps two whole join objects', () => {
    const sql = `SELECT c.*, r.* FROM orders o ${JOIN_C} ${JOIN_R}`;
    expect(run(sql)).toBe(
      pipeline([lookupC, unwindC, lookupR, unwindR, '{ $project: { _id: 0, c: 1, r: 1 } }']),
    );
  });

  it('needs no projection for SELECT * over a join', () => {
    const sql = `SELECT * FROM orders o ${JOIN_C}`;
    expect(run(sql)).toBe(pipeline([lookupC, unwindC]));
  });

  it('needs no projection for base.* with join.*, since the join object is already embedded', () => {
    const sql = `SELECT o.*, c.* FROM orders o ${JOIN_C}`;
    expect(run(sql)).toBe(pipeline([lookupC, unwindC]));
  });

  it('computes a column from a base and a joined field', () => {
    const sql = `SELECT o.total * c.rate AS converted FROM orders o ${JOIN_C}`;
    expect(run(sql)).toBe(
      pipeline([
        lookupC,
        unwindC,
        "{ $project: { _id: 0, converted: { $multiply: ['$total', '$c.rate'] } } }",
      ]),
    );
  });

  it('renumbers a base column whose name a joined column already took', () => {
    // The second column is the base field `name` but its output name is taken, so it must be
    // written as a rename (`name2: '$name'`); `name2: 1` would project a field that does not exist.
    const sql = `SELECT c.name, o.name FROM orders o ${JOIN_C}`;
    expect(run(sql)).toBe(
      pipeline([lookupC, unwindC, "{ $project: { _id: 0, name: '$c.name', name2: '$name' } }"]),
    );
  });

  it('renumbers a base column between two joined columns of the same name', () => {
    const sql = `SELECT c.name, o.name, r.name FROM orders o ${JOIN_C} ${JOIN_R}`;
    expect(run(sql)).toBe(
      pipeline([
        lookupC,
        unwindC,
        lookupR,
        unwindR,
        "{ $project: { _id: 0, name: '$c.name', name2: '$name', name3: '$r.name' } }",
      ]),
    );
  });

  it('renumbers a base column whose name a select alias already took', () => {
    const sql = `SELECT c.name AS total, o.total FROM orders o ${JOIN_C}`;
    expect(run(sql)).toBe(
      pipeline([lookupC, unwindC, "{ $project: { _id: 0, total: '$c.name', total2: '$total' } }"]),
    );
  });

  it('sorts before the projection when an alias is mixed with a column that is not selected', () => {
    const sql = `SELECT o.orderId, c.name AS customer FROM orders o ${JOIN_C} ORDER BY customer, o.total DESC`;
    expect(run(sql)).toBe(
      pipeline([
        lookupC,
        unwindC,
        "{ $sort: { 'c.name': 1, total: -1 } }",
        "{ $project: { _id: 0, orderId: 1, customer: '$c.name' } }",
      ]),
    );
  });

  it('sorts by fields of two joins before the projection, then skips and limits', () => {
    const sql = `SELECT o.orderId FROM orders o ${JOIN_C} ${JOIN_R} ORDER BY r.name, c.name OFFSET 10 ROWS FETCH NEXT 5 ROWS ONLY`;
    expect(run(sql)).toBe(
      pipeline([
        lookupC,
        unwindC,
        lookupR,
        unwindR,
        "{ $sort: { 'r.name': 1, 'c.name': 1 } }",
        '{ $project: { _id: 0, orderId: 1 } }',
        '{ $skip: 10 }',
        '{ $limit: 5 }',
      ]),
    );
  });

  it('sorts SELECT * over a join by a joined field', () => {
    const sql = `SELECT * FROM orders o ${JOIN_C} ORDER BY c.name`;
    expect(run(sql)).toBe(pipeline([lookupC, unwindC, "{ $sort: { 'c.name': 1 } }"]));
  });

  it('sorts by a joined column that is selected under an alias, after the projection', () => {
    const sql = `SELECT c.name AS customer FROM orders o ${JOIN_C} ORDER BY c.name DESC`;
    expect(run(sql)).toBe(
      pipeline([
        lookupC,
        unwindC,
        "{ $project: { _id: 0, customer: '$c.name' } }",
        '{ $sort: { customer: -1 } }',
      ]),
    );
  });
});

describe('grouping over joins', () => {
  it('groups by a joined field and sums a base field', () => {
    const sql = `SELECT c.name, SUM(o.total) AS revenue FROM orders o ${JOIN_C} GROUP BY c.name`;
    expect(run(sql)).toBe(
      pipeline([
        lookupC,
        unwindC,
        "{ $group: { _id: '$c.name', revenue: { $sum: '$total' } } }",
        "{ $project: { _id: 0, name: '$_id', revenue: 1 } }",
      ]),
    );
  });

  it('names unaliased aggregates over joined fields with the alias path', () => {
    const sql = `SELECT o.status, SUM(c.credit), MIN(c.credit), MAX(c.credit), AVG(c.credit) FROM orders o ${JOIN_C} GROUP BY o.status`;
    expect(run(sql)).toBe(
      pipeline([
        lookupC,
        unwindC,
        "{ $group: { _id: '$status', sum_c_credit: { $sum: '$c.credit' }, min_c_credit: { $min: '$c.credit' }, max_c_credit: { $max: '$c.credit' }, avg_c_credit: { $avg: '$c.credit' } } }",
        "{ $project: { _id: 0, status: '$_id', sum_c_credit: 1, min_c_credit: 1, max_c_credit: 1, avg_c_credit: 1 } }",
      ]),
    );
  });

  it('counts only matched rows with COUNT(joined id) over a LEFT JOIN', () => {
    // A missing `c._id` is not greater than null, so unmatched orders add 0, as in SQL Server.
    const sql = `SELECT o.status, COUNT(c._id) FROM orders o ${LEFT_C} GROUP BY o.status`;
    expect(run(sql)).toBe(
      pipeline([
        lookupC,
        leftC,
        "{ $group: { _id: '$status', count_c__id: { $sum: { $cond: [{ $gt: ['$c._id', null] }, 1, 0] } } } }",
        "{ $project: { _id: 0, status: '$_id', count_c__id: 1 } }",
      ]),
    );
  });

  it('counts customers with and without orders through a LEFT JOIN from the customers side', () => {
    // The preserving unwind yields one document for a customer without orders, so COUNT(*) is 1
    // and COUNT(o._id) is 0 for them, which is what SQL Server returns.
    const sql =
      'SELECT c.name, COUNT(*) AS rows_, COUNT(o._id) AS orders FROM customers c LEFT JOIN orders o ON o.customerId = c._id GROUP BY c.name';
    expect(run(sql)).toBe(
      pipeline(
        [
          "{ $lookup: { from: 'orders', localField: '_id', foreignField: 'customerId', as: 'o' } }",
          "{ $unwind: { path: '$o', preserveNullAndEmptyArrays: true } }",
          "{ $group: { _id: '$name', rows_: { $sum: 1 }, orders: { $sum: { $cond: [{ $gt: ['$o._id', null] }, 1, 0] } } } }",
          "{ $project: { _id: 0, name: '$_id', rows_: 1, orders: 1 } }",
        ],
        'customers',
      ),
    );
  });

  it('groups by null when only aggregates over joined fields are selected', () => {
    const sql = `SELECT COUNT(*) AS n, SUM(c.credit) AS credit FROM orders o ${JOIN_C}`;
    expect(run(sql)).toBe(
      pipeline([
        lookupC,
        unwindC,
        "{ $group: { _id: null, n: { $sum: 1 }, credit: { $sum: '$c.credit' } } }",
        '{ $project: { _id: 0, n: 1, credit: 1 } }',
      ]),
    );
  });

  it('counts distinct joined ids per base key', () => {
    const sql = `SELECT o.status, COUNT(DISTINCT c._id) AS customers FROM orders o ${JOIN_C} GROUP BY o.status`;
    expect(run(sql)).toBe(
      pipeline([
        lookupC,
        unwindC,
        "{ $group: { _id: '$status', customers: { $addToSet: '$c._id' } } }",
        "{ $project: { _id: 0, status: '$_id', customers: { $size: { $filter: { input: '$customers', cond: { $ne: ['$$this', null] } } } } } }",
      ]),
    );
  });

  it('groups by a base key and a joined key, named by their select aliases', () => {
    const sql = `SELECT o.status AS s, c.country AS k, COUNT(*) AS n FROM orders o ${JOIN_C} GROUP BY o.status, c.country`;
    expect(run(sql)).toBe(
      pipeline([
        lookupC,
        unwindC,
        "{ $group: { _id: { s: '$status', k: '$c.country' }, n: { $sum: 1 } } }",
        "{ $project: { _id: 0, s: '$_id.s', k: '$_id.k', n: 1 } }",
      ]),
    );
  });

  it('renumbers two group keys with the same last part', () => {
    const sql = `SELECT c.name, o.name, COUNT(*) AS n FROM orders o ${JOIN_C} GROUP BY c.name, o.name`;
    expect(run(sql)).toBe(
      pipeline([
        lookupC,
        unwindC,
        "{ $group: { _id: { name: '$c.name', name2: '$name' }, n: { $sum: 1 } } }",
        "{ $project: { _id: 0, name: '$_id.name', name2: '$_id.name2', n: 1 } }",
      ]),
    );
  });

  it('renumbers a key whose default name a select alias already took', () => {
    const sql = `SELECT c.country AS status, o.status, COUNT(*) AS n FROM orders o ${JOIN_C} GROUP BY c.country, o.status`;
    expect(run(sql)).toBe(
      pipeline([
        lookupC,
        unwindC,
        "{ $group: { _id: { status: '$c.country', status2: '$status' }, n: { $sum: 1 } } }",
        "{ $project: { _id: 0, status: '$_id.status', status2: '$_id.status2', n: 1 } }",
      ]),
    );
  });

  it('renumbers an unaliased COUNT(*) when the key alias is count', () => {
    const sql = `SELECT c.name AS count, COUNT(*) FROM orders o ${JOIN_C} GROUP BY c.name`;
    expect(run(sql)).toBe(
      pipeline([
        lookupC,
        unwindC,
        "{ $group: { _id: '$c.name', count2: { $sum: 1 } } }",
        "{ $project: { _id: 0, count: '$_id', count2: 1 } }",
      ]),
    );
  });

  it('renumbers a key default name that collides with an aggregate alias', () => {
    // The alias the user typed keeps the name; the key's implicit name is the one renumbered.
    const sql = `SELECT c.name, COUNT(*) AS name FROM orders o ${JOIN_C} GROUP BY c.name`;
    expect(run(sql)).toBe(
      pipeline([
        lookupC,
        unwindC,
        "{ $group: { _id: '$c.name', name: { $sum: 1 } } }",
        "{ $project: { _id: 0, name2: '$_id', name: 1 } }",
      ]),
    );
  });

  it('computes a select column from a single group key', () => {
    const sql = `SELECT UPPER(c.name) AS customer, COUNT(*) AS n FROM orders o ${JOIN_C} GROUP BY c.name`;
    expect(run(sql)).toBe(
      pipeline([
        lookupC,
        unwindC,
        "{ $group: { _id: '$c.name', n: { $sum: 1 } } }",
        "{ $project: { _id: 0, customer: { $toUpper: '$_id' }, n: 1 } }",
      ]),
    );
  });

  it('computes a select column from two group keys', () => {
    const sql = `SELECT o.status + '-' + c.country AS bucket, COUNT(*) AS n FROM orders o ${JOIN_C} GROUP BY o.status, c.country`;
    expect(run(sql)).toBe(
      pipeline([
        lookupC,
        unwindC,
        "{ $group: { _id: { status: '$status', country: '$c.country' }, n: { $sum: 1 } } }",
        "{ $project: { _id: 0, bucket: { $concat: ['$_id.status', '-', '$_id.country'] }, n: 1 } }",
      ]),
    );
  });

  it('groups by an expression over a joined column', () => {
    const sql = `SELECT YEAR(c.since) AS y, COUNT(*) AS n FROM orders o ${JOIN_C} GROUP BY YEAR(c.since)`;
    expect(run(sql)).toBe(
      pipeline([
        lookupC,
        unwindC,
        "{ $group: { _id: { $year: '$c.since' }, n: { $sum: 1 } } }",
        "{ $project: { _id: 0, y: '$_id', n: 1 } }",
      ]),
    );
  });

  it('computes a select column from two aggregates next to a joined key', () => {
    const sql = `SELECT c.name, SUM(o.total) / COUNT(*) AS per_order FROM orders o ${JOIN_C} GROUP BY c.name`;
    expect(run(sql)).toBe(
      pipeline([
        lookupC,
        unwindC,
        "{ $group: { _id: '$c.name', sum_total: { $sum: '$total' }, count: { $sum: 1 } } }",
        "{ $project: { _id: 0, name: '$_id', per_order: { $divide: ['$sum_total', '$count'] } } }",
      ]),
    );
  });

  it('groups by a nested path of the joined collection', () => {
    const sql = `SELECT c.address.city, COUNT(*) AS n FROM orders o ${JOIN_C} GROUP BY c.address.city`;
    expect(run(sql)).toBe(
      pipeline([
        lookupC,
        unwindC,
        "{ $group: { _id: '$c.address.city', n: { $sum: 1 } } }",
        "{ $project: { _id: 0, city: '$_id', n: 1 } }",
      ]),
    );
  });

  it('groups by a joined field named through the table name', () => {
    const sql =
      'SELECT customers.name, COUNT(*) AS n FROM orders JOIN customers ON orders.customerId = customers._id GROUP BY customers.name';
    expect(run(sql)).toBe(
      pipeline([
        "{ $lookup: { from: 'customers', localField: 'customerId', foreignField: '_id', as: 'customers' } }",
        "{ $unwind: '$customers' }",
        "{ $group: { _id: '$customers.name', n: { $sum: 1 } } }",
        "{ $project: { _id: 0, name: '$_id', n: 1 } }",
      ]),
    );
  });

  it('filters on the join before grouping', () => {
    const sql = `SELECT c.name, COUNT(*) AS n FROM orders o ${JOIN_C} WHERE c.active = TRUE AND o.total > 0 GROUP BY c.name`;
    expect(run(sql)).toBe(
      pipeline([
        '{ $match: { total: { $gt: 0 } } }',
        lookupC,
        unwindC,
        "{ $match: { 'c.active': true } }",
        "{ $group: { _id: '$c.name', n: { $sum: 1 } } }",
        "{ $project: { _id: 0, name: '$_id', n: 1 } }",
      ]),
    );
  });

  it('filters HAVING on a selected aggregate alias', () => {
    const sql = `SELECT c.name, SUM(o.total) AS revenue FROM orders o ${JOIN_C} GROUP BY c.name HAVING SUM(o.total) > 1000`;
    expect(run(sql)).toBe(
      pipeline([
        lookupC,
        unwindC,
        "{ $group: { _id: '$c.name', revenue: { $sum: '$total' } } }",
        '{ $match: { revenue: { $gt: 1000 } } }',
        "{ $project: { _id: 0, name: '$_id', revenue: 1 } }",
      ]),
    );
  });

  it('adds a hidden accumulator for a HAVING aggregate over a joined field', () => {
    const sql = `SELECT c.name, COUNT(*) AS n FROM orders o ${JOIN_C} GROUP BY c.name HAVING MAX(c.credit) > 10`;
    expect(run(sql)).toBe(
      pipeline([
        lookupC,
        unwindC,
        "{ $group: { _id: '$c.name', n: { $sum: 1 }, having_1: { $max: '$c.credit' } } }",
        '{ $match: { having_1: { $gt: 10 } } }',
        "{ $project: { _id: 0, name: '$_id', n: 1 } }",
      ]),
    );
  });

  it('filters HAVING on a joined group key', () => {
    const sql = `SELECT o.status, c.country, COUNT(*) AS n FROM orders o ${JOIN_C} GROUP BY o.status, c.country HAVING c.country = 'DE'`;
    expect(run(sql)).toBe(
      pipeline([
        lookupC,
        unwindC,
        "{ $group: { _id: { status: '$status', country: '$c.country' }, n: { $sum: 1 } } }",
        "{ $match: { '_id.country': 'DE' } }",
        "{ $project: { _id: 0, status: '$_id.status', country: '$_id.country', n: 1 } }",
      ]),
    );
  });

  it('refuses a joined column that is neither a key nor aggregated', () => {
    const sql = `SELECT c.name, c.email, COUNT(*) AS n FROM orders o ${JOIN_C} GROUP BY c.name`;
    expect(fail(sql)).toEqual({
      message: 'column c.email must appear in GROUP BY or inside an aggregate function',
      at: 'c.email',
    });
  });

  it('refuses a base column that is not in a GROUP BY on the join', () => {
    const sql = `SELECT c.name, o.total FROM orders o ${JOIN_C} GROUP BY c.name`;
    expect(fail(sql)).toEqual({
      message: 'column o.total must appear in GROUP BY or inside an aggregate function',
      at: 'o.total',
    });
  });

  it('refuses the whole join object in a grouped select', () => {
    const sql = `SELECT c.*, COUNT(*) AS n FROM orders o ${JOIN_C} GROUP BY c.name`;
    expect(fail(sql)).toEqual({
      message: 'SELECT * cannot be combined with GROUP BY or aggregate functions',
      at: 'c.*',
    });
  });

  it('sorts by the joined key after the projection', () => {
    const sql = `SELECT c.name, COUNT(*) AS n FROM orders o ${JOIN_C} GROUP BY c.name ORDER BY c.name DESC`;
    expect(run(sql)).toBe(
      pipeline([
        lookupC,
        unwindC,
        "{ $group: { _id: '$c.name', n: { $sum: 1 } } }",
        "{ $project: { _id: 0, name: '$_id', n: 1 } }",
        '{ $sort: { name: -1 } }',
      ]),
    );
  });

  it('sorts by the alias of a joined key', () => {
    const sql = `SELECT c.name AS customer, COUNT(*) AS n FROM orders o ${JOIN_C} GROUP BY c.name ORDER BY customer`;
    expect(run(sql)).toBe(
      pipeline([
        lookupC,
        unwindC,
        "{ $group: { _id: '$c.name', n: { $sum: 1 } } }",
        "{ $project: { _id: 0, customer: '$_id', n: 1 } }",
        '{ $sort: { customer: 1 } }',
      ]),
    );
  });

  it('sorts by an unaliased aggregate that is in the select list', () => {
    const sql = `SELECT c.name, COUNT(*) FROM orders o ${JOIN_C} GROUP BY c.name ORDER BY COUNT(*) DESC`;
    expect(run(sql)).toBe(
      pipeline([
        lookupC,
        unwindC,
        "{ $group: { _id: '$c.name', count: { $sum: 1 } } }",
        "{ $project: { _id: 0, name: '$_id', count: 1 } }",
        '{ $sort: { count: -1 } }',
      ]),
    );
  });

  it('sorts by an aggregate that is not selected, before the projection drops it', () => {
    const sql = `SELECT c.name FROM orders o ${JOIN_C} GROUP BY c.name ORDER BY SUM(o.total) DESC`;
    expect(run(sql)).toBe(
      pipeline([
        lookupC,
        unwindC,
        "{ $group: { _id: '$c.name', sum_total: { $sum: '$total' } } }",
        '{ $sort: { sum_total: -1 } }',
        "{ $project: { _id: 0, name: '$_id' } }",
      ]),
    );
  });

  it('sorts by the key and a hidden aggregate before the projection', () => {
    const sql = `SELECT c.name FROM orders o ${JOIN_C} GROUP BY c.name ORDER BY c.name, SUM(o.total) DESC`;
    expect(run(sql)).toBe(
      pipeline([
        lookupC,
        unwindC,
        "{ $group: { _id: '$c.name', sum_total: { $sum: '$total' } } }",
        '{ $sort: { _id: 1, sum_total: -1 } }',
        "{ $project: { _id: 0, name: '$_id' } }",
      ]),
    );
  });

  it('sorts by two keys of a base and join group after the projection', () => {
    const sql = `SELECT o.status, c.country, COUNT(*) AS n FROM orders o ${JOIN_C} GROUP BY o.status, c.country ORDER BY c.country, o.status DESC`;
    expect(run(sql)).toBe(
      pipeline([
        lookupC,
        unwindC,
        "{ $group: { _id: { status: '$status', country: '$c.country' }, n: { $sum: 1 } } }",
        "{ $project: { _id: 0, status: '$_id.status', country: '$_id.country', n: 1 } }",
        '{ $sort: { country: 1, status: -1 } }',
      ]),
    );
  });

  it('refuses ORDER BY on a joined column that is not a key after a group', () => {
    const sql = `SELECT c.name, COUNT(*) AS n FROM orders o ${JOIN_C} GROUP BY c.name ORDER BY c.email`;
    expect(fail(sql)).toEqual({
      message: 'column c.email must appear in GROUP BY or inside an aggregate function',
      at: 'c.email',
    });
  });

  it('limits after the sort on an aggregate alias', () => {
    const sql = `SELECT TOP 3 c.name, SUM(o.total) AS revenue FROM orders o ${JOIN_C} GROUP BY c.name ORDER BY revenue DESC`;
    expect(run(sql)).toBe(
      pipeline([
        lookupC,
        unwindC,
        "{ $group: { _id: '$c.name', revenue: { $sum: '$total' } } }",
        "{ $project: { _id: 0, name: '$_id', revenue: 1 } }",
        '{ $sort: { revenue: -1 } }',
        '{ $limit: 3 }',
      ]),
    );
  });

  it('builds the full pipeline: match, lookup, match, group, having, project, sort, limit', () => {
    const sql = `SELECT TOP 10 c.name AS customer, COUNT(*) AS orders, SUM(o.total) AS revenue
FROM orders o ${JOIN_C}
WHERE o.status = 'paid' AND c.active = TRUE
GROUP BY c.name
HAVING COUNT(*) > 1
ORDER BY revenue DESC, customer`;
    expect(run(sql)).toBe(
      pipeline([
        "{ $match: { status: 'paid' } }",
        lookupC,
        unwindC,
        "{ $match: { 'c.active': true } }",
        "{ $group: { _id: '$c.name', orders: { $sum: 1 }, revenue: { $sum: '$total' } } }",
        '{ $match: { orders: { $gt: 1 } } }',
        "{ $project: { _id: 0, customer: '$_id', orders: 1, revenue: 1 } }",
        '{ $sort: { revenue: -1, customer: 1 } }',
        '{ $limit: 10 }',
      ]),
    );
  });

  it('groups by a joined key across a LEFT JOIN chain and sums the last join', () => {
    const sql = `SELECT r.name AS region, SUM(o.total) AS revenue FROM orders o ${LEFT_C} ${LEFT_R} GROUP BY r.name`;
    expect(run(sql)).toBe(
      pipeline([
        lookupC,
        leftC,
        lookupR,
        leftR,
        "{ $group: { _id: '$r.name', revenue: { $sum: '$total' } } }",
        "{ $project: { _id: 0, region: '$_id', revenue: 1 } }",
      ]),
    );
  });
});

describe('DISTINCT over joins', () => {
  it('groups by the selected joined column', () => {
    const sql = `SELECT DISTINCT c.name FROM orders o ${JOIN_C}`;
    expect(run(sql)).toBe(
      pipeline([
        lookupC,
        unwindC,
        "{ $group: { _id: { name: '$c.name' } } }",
        "{ $project: { _id: 0, name: '$_id.name' } }",
      ]),
    );
  });

  it('groups by a base and a joined column', () => {
    const sql = `SELECT DISTINCT o.status, c.country FROM orders o ${JOIN_C}`;
    expect(run(sql)).toBe(
      pipeline([
        lookupC,
        unwindC,
        "{ $group: { _id: { status: '$status', country: '$c.country' } } }",
        "{ $project: { _id: 0, status: '$_id.status', country: '$_id.country' } }",
      ]),
    );
  });

  it('renumbers a joined column whose name a base column already took', () => {
    const sql = `SELECT DISTINCT o.name, c.name FROM orders o ${JOIN_C}`;
    expect(run(sql)).toBe(
      pipeline([
        lookupC,
        unwindC,
        "{ $group: { _id: { name: '$name', name2: '$c.name' } } }",
        "{ $project: { _id: 0, name: '$_id.name', name2: '$_id.name2' } }",
      ]),
    );
  });

  it('filters on the join before the distinct group', () => {
    const sql = `SELECT DISTINCT c.country FROM orders o ${JOIN_C} WHERE o.total > 100 AND c.active = TRUE`;
    expect(run(sql)).toBe(
      pipeline([
        '{ $match: { total: { $gt: 100 } } }',
        lookupC,
        unwindC,
        "{ $match: { 'c.active': true } }",
        "{ $group: { _id: { country: '$c.country' } } }",
        "{ $project: { _id: 0, country: '$_id.country' } }",
      ]),
    );
  });

  it('sorts a distinct joined column after the projection', () => {
    const sql = `SELECT DISTINCT c.name FROM orders o ${JOIN_C} ORDER BY c.name DESC`;
    expect(run(sql)).toBe(
      pipeline([
        lookupC,
        unwindC,
        "{ $group: { _id: { name: '$c.name' } } }",
        "{ $project: { _id: 0, name: '$_id.name' } }",
        '{ $sort: { name: -1 } }',
      ]),
    );
  });

  it('limits a distinct joined column with TOP', () => {
    const sql = `SELECT DISTINCT TOP 3 c.name FROM orders o ${JOIN_C} ORDER BY c.name`;
    expect(run(sql)).toBe(
      pipeline([
        lookupC,
        unwindC,
        "{ $group: { _id: { name: '$c.name' } } }",
        "{ $project: { _id: 0, name: '$_id.name' } }",
        '{ $sort: { name: 1 } }',
        '{ $limit: 3 }',
      ]),
    );
  });

  it('groups by a computed column over the join', () => {
    const sql = `SELECT DISTINCT UPPER(c.name) AS n FROM orders o ${JOIN_C}`;
    expect(run(sql)).toBe(
      pipeline([
        lookupC,
        unwindC,
        "{ $group: { _id: { n: { $toUpper: '$c.name' } } } }",
        "{ $project: { _id: 0, n: '$_id.n' } }",
      ]),
    );
  });

  it('refuses ORDER BY on a column that DISTINCT does not select', () => {
    const sql = `SELECT DISTINCT c.name FROM orders o ${JOIN_C} ORDER BY o.total`;
    expect(fail(sql)).toEqual({
      message: 'ORDER BY with DISTINCT must name a select column',
      at: 'o.total',
    });
  });

  it('refuses DISTINCT over a whole join object', () => {
    const sql = `SELECT DISTINCT c.* FROM orders o ${JOIN_C}`;
    expect(fail(sql)).toEqual({ message: 'SELECT DISTINCT * is not supported', at: 'c.*' });
  });

  it('refuses DISTINCT with an aggregate over the join', () => {
    const sql = `SELECT DISTINCT c.name, COUNT(*) AS n FROM orders o ${JOIN_C}`;
    expect(fail(sql).message).toBe(
      'DISTINCT cannot be combined with GROUP BY or aggregate functions',
    );
  });
});

// Round 2. The cases below go past the common shapes: mixed join topologies, the exact placement
// of every WHERE conjunct, output name priority, HAVING and ORDER BY over hidden and distinct
// accumulators, and the errors SQL Server itself would raise.

const LEFT_K = 'LEFT JOIN countries k ON r.countryId = k._id';
const JOIN_P = 'JOIN products p ON o.productId = p._id';
const leftK = "{ $unwind: { path: '$k', preserveNullAndEmptyArrays: true } }";
const lookupP =
  "{ $lookup: { from: 'products', localField: 'productId', foreignField: '_id', as: 'p' } }";
const unwindP = "{ $unwind: '$p' }";

describe('round 2: join topologies', () => {
  it('chains a join on the first alias and then a join back on the base table', () => {
    const sql = `SELECT o.orderId, c.name AS customer, r.name AS region, p.sku FROM orders o ${JOIN_C} ${JOIN_R} ${JOIN_P}`;
    expect(run(sql)).toBe(
      pipeline([
        lookupC,
        unwindC,
        lookupR,
        unwindR,
        lookupP,
        unwindP,
        "{ $project: { _id: 0, orderId: 1, customer: '$c.name', region: '$r.name', sku: '$p.sku' } }",
      ]),
    );
  });

  it('alternates LEFT, INNER and LEFT and filters on the middle join after every lookup', () => {
    // The contract places the remaining conjuncts after the last join, so the filter on the
    // middle join lands after the third unwind even though it could run earlier.
    const sql = `SELECT o.orderId, k.code FROM orders o ${LEFT_C} ${JOIN_R} ${LEFT_K} WHERE r.name = 'EU'`;
    expect(run(sql)).toBe(
      pipeline([
        lookupC,
        leftC,
        lookupR,
        unwindR,
        lookupK,
        leftK,
        "{ $match: { 'r.name': 'EU' } }",
        "{ $project: { _id: 0, orderId: 1, code: '$k.code' } }",
      ]),
    );
  });

  it('accepts an ON wrapped in parentheses', () => {
    const sql = `SELECT o.orderId, c.name FROM orders o JOIN customers c ON (o.customerId = c._id)`;
    expect(run(sql)).toBe(
      pipeline([lookupC, unwindC, "{ $project: { _id: 0, orderId: 1, name: '$c.name' } }"]),
    );
  });

  it('accepts bracketed identifiers on both sides of the ON and in the select list', () => {
    const sql = `SELECT [o].[orderId], [c].[name] FROM [orders] o JOIN [customers] [c] ON [o].[customerId] = [c].[_id]`;
    expect(run(sql)).toBe(
      pipeline([lookupC, unwindC, "{ $project: { _id: 0, orderId: 1, name: '$c.name' } }"]),
    );
  });

  it('joins through the table names when neither side has an alias and groups by the joined table', () => {
    const sql = `SELECT customers.country, COUNT(*) AS n FROM orders JOIN customers ON orders.customerId = customers._id GROUP BY customers.country`;
    expect(run(sql)).toBe(
      pipeline([
        "{ $lookup: { from: 'customers', localField: 'customerId', foreignField: '_id', as: 'customers' } }",
        "{ $unwind: '$customers' }",
        "{ $group: { _id: '$customers.country', n: { $sum: 1 } } }",
        "{ $project: { _id: 0, country: '$_id', n: 1 } }",
      ]),
    );
  });

  it('walks a self-join hierarchy three levels deep', () => {
    const sql = `SELECT e.name, m.name AS manager, d.name AS director FROM employees e JOIN employees m ON e.managerId = m._id LEFT JOIN employees d ON m.managerId = d._id`;
    expect(run(sql)).toBe(
      pipeline(
        [
          "{ $lookup: { from: 'employees', localField: 'managerId', foreignField: '_id', as: 'm' } }",
          "{ $unwind: '$m' }",
          "{ $lookup: { from: 'employees', localField: 'm.managerId', foreignField: '_id', as: 'd' } }",
          "{ $unwind: { path: '$d', preserveNullAndEmptyArrays: true } }",
          "{ $project: { _id: 0, name: 1, manager: '$m.name', director: '$d.name' } }",
        ],
        'employees',
      ),
    );
  });

  it('refuses two joins under the same alias, as SQL Server does', () => {
    // SQL Server: "The objects 'customers' and 'regions' in the FROM clause have the same exposed
    // names". Any error is acceptable; a silent translation would bind both to one object.
    const sql = `SELECT o.orderId FROM orders o JOIN customers c ON o.customerId = c._id JOIN regions c ON o.regionId = c._id`;
    const results = translateSql(sql);
    expect(results).toHaveLength(1);
    expect(results[0]?.ok).toBe(false);
  });

  it('refuses a join alias that equals the base alias', () => {
    const sql = `SELECT o.orderId FROM orders o JOIN customers o ON o.customerId = o._id`;
    const results = translateSql(sql);
    expect(results).toHaveLength(1);
    expect(results[0]?.ok).toBe(false);
  });

  it('refuses an aggregate in the ON clause', () => {
    const sql = `SELECT o.orderId FROM orders o JOIN customers c ON o.customerId = MAX(c._id)`;
    expect(fail(sql)).toEqual({ message: JOIN_ERROR, at: 'o.customerId = MAX(c._id)' });
  });
});

describe('round 2: WHERE placement around $lookup', () => {
  it('keeps a NOT over a join condition after the lookup as $nor', () => {
    const sql = `SELECT o.orderId FROM orders o ${JOIN_C} WHERE NOT (c.tier = 'gold')`;
    expect(run(sql)).toBe(
      pipeline([
        lookupC,
        unwindC,
        "{ $match: { $nor: [{ 'c.tier': 'gold' }] } }",
        '{ $project: { _id: 0, orderId: 1 } }',
      ]),
    );
  });

  it('keeps a NOT over a mixed AND after the lookup as one $nor document', () => {
    const sql = `SELECT o.orderId FROM orders o ${JOIN_C} WHERE NOT (o.status = 'x' AND c.tier = 'gold')`;
    expect(run(sql)).toBe(
      pipeline([
        lookupC,
        unwindC,
        "{ $match: { $nor: [{ status: 'x', 'c.tier': 'gold' }] } }",
        '{ $project: { _id: 0, orderId: 1 } }',
      ]),
    );
  });

  it('keeps a base-only $expr conjunct before the lookup', () => {
    const sql = `SELECT o.orderId FROM orders o ${JOIN_C} WHERE o.qty * o.price > 100 AND c.tier = 'gold'`;
    expect(run(sql)).toBe(
      pipeline([
        "{ $match: { $expr: { $gt: [{ $multiply: ['$qty', '$price'] }, 100] } } }",
        lookupC,
        unwindC,
        "{ $match: { 'c.tier': 'gold' } }",
        '{ $project: { _id: 0, orderId: 1 } }',
      ]),
    );
  });

  it('keeps a base-only OR before the lookup and the join conjunct after it', () => {
    const sql = `SELECT o.orderId FROM orders o ${JOIN_C} WHERE (o.status = 'a' OR o.status = 'b') AND c.tier = 'gold'`;
    expect(run(sql)).toBe(
      pipeline([
        "{ $match: { $or: [{ status: 'a' }, { status: 'b' }] } }",
        lookupC,
        unwindC,
        "{ $match: { 'c.tier': 'gold' } }",
        '{ $project: { _id: 0, orderId: 1 } }',
      ]),
    );
  });

  it('wraps two base conjuncts on the same field in $and before the lookup', () => {
    const sql = `SELECT o.orderId FROM orders o ${JOIN_C} WHERE o.total > 10 AND o.total < 100`;
    expect(run(sql)).toBe(
      pipeline([
        '{ $match: { $and: [{ total: { $gt: 10 } }, { total: { $lt: 100 } }] } }',
        lookupC,
        unwindC,
        '{ $project: { _id: 0, orderId: 1 } }',
      ]),
    );
  });

  it('compares a joined date with GETDATE() as a plain filter after the lookup', () => {
    const sql = `SELECT o.orderId FROM orders o ${JOIN_C} WHERE c.since < GETDATE()`;
    expect(run(sql)).toBe(
      pipeline([
        lookupC,
        unwindC,
        "{ $match: { 'c.since': { $lt: new Date() } } }",
        '{ $project: { _id: 0, orderId: 1 } }',
      ]),
    );
  });

  it('splits LIKE on the base from NOT LIKE on the join', () => {
    const sql = `SELECT o.orderId FROM orders o ${JOIN_C} WHERE o.ref LIKE 'A%' AND c.email NOT LIKE '%@test.com'`;
    expect(run(sql)).toBe(
      pipeline([
        '{ $match: { ref: /^A/i } }',
        lookupC,
        unwindC,
        "{ $match: { 'c.email': { $not: /@test\\.com$/i } } }",
        '{ $project: { _id: 0, orderId: 1 } }',
      ]),
    );
  });

  it('places a conjunct on the first join after the whole chain of three joins', () => {
    const sql = `SELECT o.orderId FROM orders o ${JOIN_C} ${JOIN_R} ${JOIN_K} WHERE c.tier = 'gold'`;
    expect(run(sql)).toBe(
      pipeline([
        lookupC,
        unwindC,
        lookupR,
        unwindR,
        lookupK,
        unwindK,
        "{ $match: { 'c.tier': 'gold' } }",
        '{ $project: { _id: 0, orderId: 1 } }',
      ]),
    );
  });

  it('keeps an OR over two different joins after both lookups', () => {
    const sql = `SELECT o.orderId FROM orders o ${JOIN_C} ${JOIN_R} WHERE c.tier = 'gold' OR r.name = 'EU'`;
    expect(run(sql)).toBe(
      pipeline([
        lookupC,
        unwindC,
        lookupR,
        unwindR,
        "{ $match: { $or: [{ 'c.tier': 'gold' }, { 'r.name': 'EU' }] } }",
        '{ $project: { _id: 0, orderId: 1 } }',
      ]),
    );
  });

  it('compares a base column with a joined column inside IN through $expr after the lookup', () => {
    const sql = `SELECT o.orderId FROM orders o ${JOIN_C} WHERE o.country IN (c.country, 'SI')`;
    expect(run(sql)).toBe(
      pipeline([
        lookupC,
        unwindC,
        "{ $match: { $expr: { $in: ['$country', ['$c.country', 'SI']] } } }",
        '{ $project: { _id: 0, orderId: 1 } }',
      ]),
    );
  });

  it('coerces the base localField with an objectId hint before the lookup', () => {
    const options: TranslateOptions = {
      fieldType: (collection, path) =>
        collection === 'orders' && path === 'customerId' ? 'objectId' : undefined,
    };
    const sql = `SELECT c.name FROM orders o ${JOIN_C} WHERE o.customerId = '5f1d7f3e2c4b5a6d7e8f9a0b'`;
    expect(run(sql, options)).toBe(
      pipeline([
        "{ $match: { customerId: ObjectId('5f1d7f3e2c4b5a6d7e8f9a0b') } }",
        lookupC,
        unwindC,
        "{ $project: { _id: 0, name: '$c.name' } }",
      ]),
    );
  });

  it('applies a number hint of the joined collection to a quoted number', () => {
    const options: TranslateOptions = {
      fieldType: (collection, path) =>
        collection === 'customers' && path === 'age' ? 'number' : undefined,
    };
    const sql = `SELECT o.orderId FROM orders o ${JOIN_C} WHERE c.age > '30'`;
    expect(run(sql, options)).toBe(
      pipeline([
        lookupC,
        unwindC,
        "{ $match: { 'c.age': { $gt: 30 } } }",
        '{ $project: { _id: 0, orderId: 1 } }',
      ]),
    );
  });

  it('concatenates two joined string fields when the joined collection says they are strings', () => {
    const options: TranslateOptions = {
      fieldType: (collection, path) =>
        collection === 'customers' && (path === 'firstName' || path === 'lastName')
          ? 'string'
          : undefined,
    };
    const sql = `SELECT c.firstName + c.lastName AS fullName FROM orders o ${JOIN_C}`;
    expect(run(sql, options)).toBe(
      pipeline([
        lookupC,
        unwindC,
        "{ $project: { _id: 0, fullName: { $concat: ['$c.firstName', '$c.lastName'] } } }",
      ]),
    );
  });
});

describe('round 2: select shapes over joins', () => {
  it('adds an aliased joined column next to base.* with $addFields', () => {
    const sql = `SELECT o.*, c.name AS customer FROM orders o ${JOIN_C}`;
    expect(run(sql)).toBe(pipeline([lookupC, unwindC, "{ $addFields: { customer: '$c.name' } }"]));
  });

  it('sorts a whole join object select by a field inside it before the projection', () => {
    const sql = `SELECT c.* FROM orders o ${JOIN_C} ORDER BY c.name`;
    expect(run(sql)).toBe(
      pipeline([lookupC, unwindC, "{ $sort: { 'c.name': 1 } }", '{ $project: { _id: 0, c: 1 } }']),
    );
  });

  it('keeps the joined _id as the output _id when it is the only column', () => {
    const sql = `SELECT c._id FROM orders o ${JOIN_C}`;
    expect(run(sql)).toBe(pipeline([lookupC, unwindC, "{ $project: { _id: '$c._id' } }"]));
  });

  it('keeps the base _id and renames the joined _id', () => {
    const sql = `SELECT c._id AS customerId, o._id FROM orders o ${JOIN_C}`;
    expect(run(sql)).toBe(
      pipeline([lookupC, unwindC, "{ $project: { _id: 1, customerId: '$c._id' } }"]),
    );
  });

  it('gives an explicit alias priority over an earlier unaliased column of the same name', () => {
    // The contract is silent on which column keeps a contested name. SQL Server returns two
    // columns both called name; MongoDB can keep only one, so the name the user typed should win
    // and the implicit one should be renumbered.
    const sql = `SELECT o.name, c.name AS name FROM orders o ${JOIN_C}`;
    expect(run(sql)).toBe(
      pipeline([lookupC, unwindC, "{ $project: { _id: 0, name2: '$name', name: '$c.name' } }"]),
    );
  });

  it('computes a column from two different joins', () => {
    const sql = `SELECT o.orderId, r.rate * k.vat AS factor FROM orders o ${JOIN_C} ${JOIN_R} ${JOIN_K}`;
    expect(run(sql)).toBe(
      pipeline([
        lookupC,
        unwindC,
        lookupR,
        unwindR,
        lookupK,
        unwindK,
        "{ $project: { _id: 0, orderId: 1, factor: { $multiply: ['$r.rate', '$k.vat'] } } }",
      ]),
    );
  });

  it('evaluates a searched CASE over a joined field', () => {
    const sql = `SELECT o.orderId, CASE WHEN c.tier = 'gold' THEN 0.2 ELSE 0 END AS discount FROM orders o ${JOIN_C}`;
    expect(run(sql)).toBe(
      pipeline([
        lookupC,
        unwindC,
        "{ $project: { _id: 0, orderId: 1, discount: { $switch: { branches: [{ case: { $eq: ['$c.tier', 'gold'] }, then: 0.2 }], default: 0 } } } }",
      ]),
    );
  });

  it('fills a missing LEFT JOIN value with ISNULL', () => {
    const sql = `SELECT o.orderId, ISNULL(c.name, 'unknown') AS customer FROM orders o ${LEFT_C}`;
    expect(run(sql)).toBe(
      pipeline([
        lookupC,
        leftC,
        "{ $project: { _id: 0, orderId: 1, customer: { $ifNull: ['$c.name', 'unknown'] } } }",
      ]),
    );
  });

  it('sorts by an unselected base column and a selected joined column before the projection', () => {
    const sql = `SELECT c.name AS customer FROM orders o ${JOIN_C} ORDER BY o.total DESC, c.name`;
    expect(run(sql)).toBe(
      pipeline([
        lookupC,
        unwindC,
        "{ $sort: { total: -1, 'c.name': 1 } }",
        "{ $project: { _id: 0, customer: '$c.name' } }",
      ]),
    );
  });

  it('resolves ORDER BY by the output name before a base field of the same name', () => {
    // SQL Server binds an ORDER BY name to the select list first, so this sorts by the customer
    // name that the output calls name, not by the base field name.
    const sql = `SELECT c.name FROM orders o ${JOIN_C} ORDER BY name`;
    expect(run(sql)).toBe(
      pipeline([
        lookupC,
        unwindC,
        "{ $project: { _id: 0, name: '$c.name' } }",
        '{ $sort: { name: 1 } }',
      ]),
    );
  });
});

describe('round 2: grouping over joins', () => {
  it('groups by keys from two joins, filters, sums the base, and sorts with TOP', () => {
    const sql = `SELECT TOP 10 r.name AS region, c.tier, SUM(o.total) AS revenue FROM orders o ${JOIN_C} ${JOIN_R} WHERE o.status = 'paid' AND r.active = 1 GROUP BY r.name, c.tier HAVING SUM(o.total) > 100 ORDER BY revenue DESC`;
    expect(run(sql)).toBe(
      pipeline([
        "{ $match: { status: 'paid' } }",
        lookupC,
        unwindC,
        lookupR,
        unwindR,
        "{ $match: { 'r.active': 1 } }",
        "{ $group: { _id: { region: '$r.name', tier: '$c.tier' }, revenue: { $sum: '$total' } } }",
        '{ $match: { revenue: { $gt: 100 } } }',
        "{ $project: { _id: 0, region: '$_id.region', tier: '$_id.tier', revenue: 1 } }",
        '{ $sort: { revenue: -1 } }',
        '{ $limit: 10 }',
      ]),
    );
  });

  it('groups by the joined _id and name and keeps _id in the output', () => {
    const sql = `SELECT c._id, c.name, COUNT(*) AS n FROM orders o ${JOIN_C} GROUP BY c._id, c.name`;
    expect(run(sql)).toBe(
      pipeline([
        lookupC,
        unwindC,
        "{ $group: { _id: { _id: '$c._id', name: '$c.name' }, n: { $sum: 1 } } }",
        "{ $project: { _id: '$_id._id', name: '$_id.name', n: 1 } }",
      ]),
    );
  });

  it('concatenates a joined key with a cast COUNT(*) in one select column', () => {
    const sql = `SELECT c.name + ': ' + CAST(COUNT(*) AS NVARCHAR(10)) AS label FROM orders o ${JOIN_C} GROUP BY c.name`;
    expect(run(sql)).toBe(
      pipeline([
        lookupC,
        unwindC,
        "{ $group: { _id: '$c.name', count: { $sum: 1 } } }",
        "{ $project: { _id: 0, label: { $concat: ['$_id', ': ', { $toString: '$count' }] } } }",
      ]),
    );
  });

  it('sums a CASE over a joined field per base key', () => {
    const sql = `SELECT o.status, SUM(CASE WHEN c.tier = 'gold' THEN o.total ELSE 0 END) AS gold FROM orders o ${JOIN_C} GROUP BY o.status`;
    expect(run(sql)).toBe(
      pipeline([
        lookupC,
        unwindC,
        "{ $group: { _id: '$status', gold: { $sum: { $switch: { branches: [{ case: { $eq: ['$c.tier', 'gold'] }, then: '$total' }], default: 0 } } } } }",
        "{ $project: { _id: 0, status: '$_id', gold: 1 } }",
      ]),
    );
  });

  it('names an unaliased AVG over an expression by the function alone', () => {
    // The contract names unaliased aggregates after their column path; an expression has none,
    // so the bare function name is the only sensible default.
    const sql = `SELECT o.status, AVG(o.qty * c.price) FROM orders o ${JOIN_C} GROUP BY o.status`;
    expect(run(sql)).toBe(
      pipeline([
        lookupC,
        unwindC,
        "{ $group: { _id: '$status', avg: { $avg: { $multiply: ['$qty', '$c.price'] } } } }",
        "{ $project: { _id: 0, status: '$_id', avg: 1 } }",
      ]),
    );
  });

  it('names MIN and MAX over a nested joined path with underscores', () => {
    const sql = `SELECT o.status, MIN(c.address.zip), MAX(c.address.zip) FROM orders o ${JOIN_C} GROUP BY o.status`;
    expect(run(sql)).toBe(
      pipeline([
        lookupC,
        unwindC,
        "{ $group: { _id: '$status', min_c_address_zip: { $min: '$c.address.zip' }, max_c_address_zip: { $max: '$c.address.zip' } } }",
        "{ $project: { _id: 0, status: '$_id', min_c_address_zip: 1, max_c_address_zip: 1 } }",
      ]),
    );
  });

  it('filters HAVING on a COUNT(DISTINCT) through $expr and $size', () => {
    const sql = `SELECT o.status, COUNT(DISTINCT c.name) AS customers FROM orders o ${JOIN_C} GROUP BY o.status HAVING COUNT(DISTINCT c.name) > 1`;
    expect(run(sql)).toBe(
      pipeline([
        lookupC,
        unwindC,
        "{ $group: { _id: '$status', customers: { $addToSet: '$c.name' } } }",
        "{ $match: { $expr: { $gt: [{ $size: { $filter: { input: '$customers', cond: { $ne: ['$$this', null] } } } }, 1] } } }",
        "{ $project: { _id: 0, status: '$_id', customers: { $size: { $filter: { input: '$customers', cond: { $ne: ['$$this', null] } } } } } }",
      ]),
    );
  });

  it('refuses a select alias in HAVING, as SQL Server does', () => {
    const sql = `SELECT c.name, COUNT(*) AS n FROM orders o ${JOIN_C} GROUP BY c.name HAVING n > 1`;
    const result = fail(sql);
    expect(result.at).toBe('n');
    expect(result.message).toContain('n');
  });

  it('refuses a joined column in HAVING that is not a group key', () => {
    const sql = `SELECT o.status, COUNT(*) AS n FROM orders o ${JOIN_C} GROUP BY o.status HAVING c.tier = 'gold'`;
    expect(fail(sql)).toEqual({
      message: 'column c.tier must appear in GROUP BY or inside an aggregate function',
      at: 'c.tier',
    });
  });

  it('drops the unmatched LEFT JOIN bucket with HAVING key IS NOT NULL', () => {
    const sql = `SELECT c.tier, COUNT(*) AS n FROM orders o ${LEFT_C} GROUP BY c.tier HAVING c.tier IS NOT NULL`;
    expect(run(sql)).toBe(
      pipeline([
        lookupC,
        leftC,
        "{ $group: { _id: '$c.tier', n: { $sum: 1 } } }",
        '{ $match: { _id: { $ne: null } } }',
        "{ $project: { _id: 0, tier: '$_id', n: 1 } }",
      ]),
    );
  });

  it('counts the unmatched rows of a LEFT JOIN in one null bucket', () => {
    // SQL Server groups all NULL tiers into one row and MongoDB groups missing and null keys
    // into the _id null bucket, so a plain unwind with preserveNullAndEmptyArrays is enough.
    const sql = `SELECT c.tier, COUNT(*) AS n FROM orders o ${LEFT_C} GROUP BY c.tier`;
    expect(run(sql)).toBe(
      pipeline([
        lookupC,
        leftC,
        "{ $group: { _id: '$c.tier', n: { $sum: 1 } } }",
        "{ $project: { _id: 0, tier: '$_id', n: 1 } }",
      ]),
    );
  });

  it('sorts by a single joined key that is not selected before the projection', () => {
    const sql = `SELECT COUNT(*) AS n FROM orders o ${JOIN_C} GROUP BY c.name ORDER BY c.name`;
    expect(run(sql)).toBe(
      pipeline([
        lookupC,
        unwindC,
        "{ $group: { _id: '$c.name', n: { $sum: 1 } } }",
        '{ $sort: { _id: 1 } }',
        '{ $project: { _id: 0, n: 1 } }',
      ]),
    );
  });

  it('sorts by an unselected joined key and a selected aggregate before the projection', () => {
    const sql = `SELECT o.status, COUNT(*) AS n FROM orders o ${JOIN_C} GROUP BY c.name, o.status ORDER BY c.name, n DESC`;
    expect(run(sql)).toBe(
      pipeline([
        lookupC,
        unwindC,
        "{ $group: { _id: { name: '$c.name', status: '$status' }, n: { $sum: 1 } } }",
        "{ $sort: { '_id.name': 1, n: -1 } }",
        "{ $project: { _id: 0, status: '$_id.status', n: 1 } }",
      ]),
    );
  });

  it('sorts by an aggregate expression that the select list computes under an alias', () => {
    const sql = `SELECT c.name, SUM(o.total) / COUNT(*) AS avg FROM orders o ${JOIN_C} GROUP BY c.name ORDER BY SUM(o.total) / COUNT(*) DESC`;
    expect(run(sql)).toBe(
      pipeline([
        lookupC,
        unwindC,
        "{ $group: { _id: '$c.name', sum_total: { $sum: '$total' }, count: { $sum: 1 } } }",
        "{ $project: { _id: 0, name: '$_id', avg: { $divide: ['$sum_total', '$count'] } } }",
        '{ $sort: { avg: -1 } }',
      ]),
    );
  });

  it('sorts by an expression over the joined key that the select list computes under an alias', () => {
    const sql = `SELECT UPPER(c.name) AS customer, COUNT(*) AS n FROM orders o ${JOIN_C} GROUP BY c.name ORDER BY UPPER(c.name)`;
    expect(run(sql)).toBe(
      pipeline([
        lookupC,
        unwindC,
        "{ $group: { _id: '$c.name', n: { $sum: 1 } } }",
        "{ $project: { _id: 0, customer: { $toUpper: '$_id' }, n: 1 } }",
        '{ $sort: { customer: 1 } }',
      ]),
    );
  });

  it('refuses ORDER BY on an expression over the key that is not selected', () => {
    const sql = `SELECT c.name, COUNT(*) AS n FROM orders o ${JOIN_C} GROUP BY c.name ORDER BY UPPER(c.name)`;
    expect(fail(sql)).toEqual({
      message: 'ORDER BY must name a column, a select alias or an aggregate',
      at: 'UPPER(c.name)',
    });
  });

  it('sorts by a hidden COUNT(DISTINCT) over a joined field', () => {
    // The contract allows ORDER BY on any aggregate. A set cannot be sorted, so MongoDB needs
    // the size computed before the sort; the contract does not name the stage, and $addFields
    // on the accumulator itself is the smallest shape that works.
    const sql = `SELECT o.status FROM orders o ${JOIN_C} GROUP BY o.status ORDER BY COUNT(DISTINCT c.name) DESC`;
    expect(run(sql)).toBe(
      pipeline([
        lookupC,
        unwindC,
        "{ $group: { _id: '$status', count_c_name: { $addToSet: '$c.name' } } }",
        "{ $addFields: { count_c_name: { $size: { $filter: { input: '$count_c_name', cond: { $ne: ['$$this', null] } } } } } }",
        '{ $sort: { count_c_name: -1 } }',
        "{ $project: { _id: 0, status: '$_id' } }",
      ]),
    );
  });

  it('adds one to a grouped YEAR over the joined collection', () => {
    const sql = `SELECT YEAR(c.since) + 1 AS nextYear, COUNT(*) AS n FROM orders o ${JOIN_C} GROUP BY YEAR(c.since)`;
    expect(run(sql)).toBe(
      pipeline([
        lookupC,
        unwindC,
        "{ $group: { _id: { $year: '$c.since' }, n: { $sum: 1 } } }",
        "{ $project: { _id: 0, nextYear: { $add: ['$_id', 1] }, n: 1 } }",
      ]),
    );
  });

  it('reuses one accumulator for the same aggregate selected twice', () => {
    const sql = `SELECT c.name, SUM(o.total) AS revenue, SUM(o.total) AS again FROM orders o ${JOIN_C} GROUP BY c.name`;
    expect(run(sql)).toBe(
      pipeline([
        lookupC,
        unwindC,
        "{ $group: { _id: '$c.name', revenue: { $sum: '$total' } } }",
        "{ $project: { _id: 0, name: '$_id', revenue: 1, again: '$revenue' } }",
      ]),
    );
  });

  it('counts over a join with a filter on the join and no GROUP BY', () => {
    const sql = `SELECT COUNT(*) AS n, MAX(o.total) AS biggest FROM orders o ${JOIN_C} WHERE c.country = 'SI'`;
    expect(run(sql)).toBe(
      pipeline([
        lookupC,
        unwindC,
        "{ $match: { 'c.country': 'SI' } }",
        "{ $group: { _id: null, n: { $sum: 1 }, biggest: { $max: '$total' } } }",
        '{ $project: { _id: 0, n: 1, biggest: 1 } }',
      ]),
    );
  });

  it('gives a key alias priority over the default name of an earlier key', () => {
    // The contract names a key by its select alias when it has one; a default name must not
    // take the alias first just because its GROUP BY item comes earlier.
    const sql = `SELECT r.name AS name, c.name, COUNT(*) AS n FROM orders o ${JOIN_C} ${JOIN_R} GROUP BY c.name, r.name`;
    expect(run(sql)).toBe(
      pipeline([
        lookupC,
        unwindC,
        lookupR,
        unwindR,
        "{ $group: { _id: { name2: '$c.name', name: '$r.name' }, n: { $sum: 1 } } }",
        "{ $project: { _id: 0, name: '$_id.name', name2: '$_id.name2', n: 1 } }",
      ]),
    );
  });

  it('shares a hidden accumulator between HAVING and ORDER BY', () => {
    const sql = `SELECT c.name FROM orders o ${JOIN_C} GROUP BY c.name HAVING SUM(o.total) > 100 ORDER BY SUM(o.total) DESC`;
    expect(run(sql)).toBe(
      pipeline([
        lookupC,
        unwindC,
        "{ $group: { _id: '$c.name', having_1: { $sum: '$total' } } }",
        '{ $match: { having_1: { $gt: 100 } } }',
        '{ $sort: { having_1: -1 } }',
        "{ $project: { _id: 0, name: '$_id' } }",
      ]),
    );
  });

  it('skips and limits after a sort on a hidden aggregate', () => {
    const sql = `SELECT c.name FROM orders o ${JOIN_C} GROUP BY c.name ORDER BY COUNT(*) DESC OFFSET 5 ROWS FETCH NEXT 5 ROWS ONLY`;
    expect(run(sql)).toBe(
      pipeline([
        lookupC,
        unwindC,
        "{ $group: { _id: '$c.name', count: { $sum: 1 } } }",
        '{ $sort: { count: -1 } }',
        "{ $project: { _id: 0, name: '$_id' } }",
        '{ $skip: 5 }',
        '{ $limit: 5 }',
      ]),
    );
  });

  it('refuses GROUP BY on a join alias used as a column', () => {
    const sql = `SELECT COUNT(*) AS n FROM orders o ${JOIN_C} GROUP BY c`;
    expect(fail(sql)).toEqual({ message: 'c is a table alias, not a column', at: 'c' });
  });

  it('refuses SELECT * with GROUP BY over a join', () => {
    const sql = `SELECT *, COUNT(*) AS n FROM orders o ${JOIN_C} GROUP BY c.name`;
    expect(fail(sql).at).toBe('*');
  });
});

describe('round 2: DISTINCT over joins', () => {
  it('filters on the base before the lookup and groups two columns over a LEFT JOIN', () => {
    const sql = `SELECT DISTINCT o.status, c.tier FROM orders o ${LEFT_C} WHERE o.total > 0`;
    expect(run(sql)).toBe(
      pipeline([
        '{ $match: { total: { $gt: 0 } } }',
        lookupC,
        leftC,
        "{ $group: { _id: { status: '$status', tier: '$c.tier' } } }",
        "{ $project: { _id: 0, status: '$_id.status', tier: '$_id.tier' } }",
      ]),
    );
  });

  it('renumbers two joined columns with the same name inside the distinct key', () => {
    const sql = `SELECT DISTINCT c.name, r.name FROM orders o ${JOIN_C} ${JOIN_R}`;
    expect(run(sql)).toBe(
      pipeline([
        lookupC,
        unwindC,
        lookupR,
        unwindR,
        "{ $group: { _id: { name: '$c.name', name2: '$r.name' } } }",
        "{ $project: { _id: 0, name: '$_id.name', name2: '$_id.name2' } }",
      ]),
    );
  });

  it('pages a distinct joined column by its alias', () => {
    const sql = `SELECT DISTINCT c.name AS customer FROM orders o ${JOIN_C} ORDER BY customer DESC OFFSET 10 ROWS FETCH NEXT 10 ROWS ONLY`;
    expect(run(sql)).toBe(
      pipeline([
        lookupC,
        unwindC,
        "{ $group: { _id: { customer: '$c.name' } } }",
        "{ $project: { _id: 0, customer: '$_id.customer' } }",
        '{ $sort: { customer: -1 } }',
        '{ $skip: 10 }',
        '{ $limit: 10 }',
      ]),
    );
  });

  it('sorts a distinct computed column by repeating the expression', () => {
    const sql = `SELECT DISTINCT o.total * c.rate AS converted FROM orders o ${JOIN_C} ORDER BY o.total * c.rate`;
    expect(run(sql)).toBe(
      pipeline([
        lookupC,
        unwindC,
        "{ $group: { _id: { converted: { $multiply: ['$total', '$c.rate'] } } } }",
        "{ $project: { _id: 0, converted: '$_id.converted' } }",
        '{ $sort: { converted: 1 } }',
      ]),
    );
  });

  it('keeps the joined _id as the output _id of a distinct select', () => {
    const sql = `SELECT DISTINCT TOP 1 c._id FROM orders o ${JOIN_C}`;
    expect(run(sql)).toBe(
      pipeline([
        lookupC,
        unwindC,
        "{ $group: { _id: { _id: '$c._id' } } }",
        "{ $project: { _id: '$_id._id' } }",
        '{ $limit: 1 }',
      ]),
    );
  });
});

describe('round 2: several statements', () => {
  it('translates a join query and a grouped query separated by GO', () => {
    const text = `SELECT o.orderId, c.name FROM orders o ${JOIN_C}\nGO\nSELECT c.name, COUNT(*) AS n FROM orders o ${JOIN_C} GROUP BY c.name`;
    const results = translateSql(text);
    expect(results).toHaveLength(2);
    expect(
      results.map((result) => (result.ok ? result.translation.mongosh : result.error)),
    ).toEqual([
      pipeline([lookupC, unwindC, "{ $project: { _id: 0, orderId: 1, name: '$c.name' } }"]),
      pipeline([
        lookupC,
        unwindC,
        "{ $group: { _id: '$c.name', n: { $sum: 1 } } }",
        "{ $project: { _id: 0, name: '$_id', n: 1 } }",
      ]),
    ]);
  });
});
