import { describe, expect, it } from 'vitest';
import { collectionAccess, emitStatement, emitValue } from './emit';
import { mongoDate, mongoNow, mongoObjectId, mongoRegex, type MongoStatement } from './mongo-model';

function statement(overrides: Partial<MongoStatement>): MongoStatement {
  return {
    collection: 'orders',
    method: 'find',
    args: [{}],
    chain: [],
    kind: 'read',
    unsafe: false,
    ...overrides,
  };
}

describe('emitValue scalars', () => {
  it('emits null', () => {
    expect(emitValue(null)).toBe('null');
  });

  it('emits booleans', () => {
    expect(emitValue(true)).toBe('true');
    expect(emitValue(false)).toBe('false');
  });

  it('emits integers and decimals', () => {
    expect(emitValue(1)).toBe('1');
    expect(emitValue(0)).toBe('0');
    expect(emitValue(1.5)).toBe('1.5');
    expect(emitValue(100)).toBe('100');
  });

  it('emits negative numbers', () => {
    expect(emitValue(-3)).toBe('-3');
    expect(emitValue(-0.25)).toBe('-0.25');
  });

  it('emits large and small numbers the way String does', () => {
    expect(emitValue(1e21)).toBe('1e+21');
    expect(emitValue(1e-7)).toBe('1e-7');
    expect(emitValue(123456789012)).toBe('123456789012');
  });

  it('emits strings in single quotes', () => {
    expect(emitValue('shipped')).toBe("'shipped'");
    expect(emitValue('')).toBe("''");
  });

  it('leaves double quotes in strings unescaped', () => {
    expect(emitValue('a "quoted" word')).toBe('\'a "quoted" word\'');
  });

  it('escapes the single quote', () => {
    expect(emitValue("it's")).toBe("'it\\'s'");
  });

  it('escapes the backslash', () => {
    expect(emitValue('C:\\temp')).toBe("'C:\\\\temp'");
  });

  it('escapes newline, carriage return and tab', () => {
    expect(emitValue('a\nb')).toBe("'a\\nb'");
    expect(emitValue('a\rb')).toBe("'a\\rb'");
    expect(emitValue('a\tb')).toBe("'a\\tb'");
  });

  it('escapes other control characters as \\uXXXX', () => {
    expect(emitValue('\u0000')).toBe("'\\u0000'");
    expect(emitValue('\u0001x')).toBe("'\\u0001x'");
    expect(emitValue('bell\u0007')).toBe("'bell\\u0007'");
    expect(emitValue('\u001f')).toBe("'\\u001f'");
  });

  it('keeps unicode text as it is', () => {
    expect(emitValue('naročila')).toBe("'naročila'");
    expect(emitValue('日本')).toBe("'日本'");
  });
});

describe('emitValue specials', () => {
  it('emits a date as ISODate', () => {
    expect(emitValue(mongoDate('2026-01-01T00:00:00.000Z'))).toBe(
      "ISODate('2026-01-01T00:00:00.000Z')",
    );
  });

  it('emits now as new Date()', () => {
    expect(emitValue(mongoNow())).toBe('new Date()');
  });

  it('emits an ObjectId', () => {
    expect(emitValue(mongoObjectId('507f1f77bcf86cd799439011'))).toBe(
      "ObjectId('507f1f77bcf86cd799439011')",
    );
  });

  it('emits a regex literal with its options', () => {
    expect(emitValue(mongoRegex('@gmail\\.com$', 'i'))).toBe('/@gmail\\.com$/i');
    expect(emitValue(mongoRegex('^abc', ''))).toBe('/^abc/');
  });

  it('escapes a slash in a regex pattern', () => {
    expect(emitValue(mongoRegex('a/b', 'i'))).toBe('/a\\/b/i');
    expect(emitValue(mongoRegex('/', ''))).toBe('/\\//');
  });

  it('does not escape a slash that is already escaped', () => {
    expect(emitValue(mongoRegex('a\\/b', ''))).toBe('/a\\/b/');
  });

  it('escapes a newline in a regex pattern', () => {
    expect(emitValue(mongoRegex('a\nb', 'i'))).toBe('/a\\nb/i');
    expect(emitValue(mongoRegex('a\rb', ''))).toBe('/a\\rb/');
  });

  it('keeps regex escapes and classes as they are', () => {
    expect(emitValue(mongoRegex('^x\\.y.*[a-z][^0-9]\\\\$', 'i'))).toBe(
      '/^x\\.y.*[a-z][^0-9]\\\\$/i',
    );
  });

  it('emits an empty pattern as an empty group so the literal is not a comment', () => {
    expect(emitValue(mongoRegex('', 'i'))).toBe('/(?:)/i');
  });

  it('escapes quotes inside the text of a special', () => {
    expect(emitValue(mongoObjectId("x'y"))).toBe("ObjectId('x\\'y')");
  });
});

describe('emitValue arrays', () => {
  it('emits an empty array', () => {
    expect(emitValue([])).toBe('[]');
  });

  it('emits elements joined by a comma and a space', () => {
    expect(emitValue([1, 'a', null, true])).toBe("[1, 'a', null, true]");
  });

  it('emits nested arrays', () => {
    expect(emitValue([[1, 2], [], [[3]]])).toBe('[[1, 2], [], [[3]]]');
  });

  it('emits specials inside arrays', () => {
    expect(emitValue(['$x', mongoRegex('a', 'i'), mongoNow()])).toBe("['$x', /a/i, new Date()]");
  });
});

describe('emitValue objects', () => {
  it('emits an empty object', () => {
    expect(emitValue({})).toBe('{}');
  });

  it('emits a single key', () => {
    expect(emitValue({ status: 'shipped' })).toBe("{ status: 'shipped' }");
  });

  it('keeps keys in insertion order', () => {
    expect(emitValue({ b: 1, a: 2, c: 3 })).toBe('{ b: 1, a: 2, c: 3 }');
  });

  it('leaves identifier keys bare', () => {
    expect(emitValue({ _id: 0, $lookup: 1, $$NOW: 2, camelCase: 3, a1: 4 })).toBe(
      '{ _id: 0, $lookup: 1, $$NOW: 2, camelCase: 3, a1: 4 }',
    );
  });

  it('quotes a dotted key', () => {
    expect(emitValue({ 'b.c': 1 })).toBe("{ 'b.c': 1 }");
    expect(emitValue({ 'customer.email': 1, name: 1 })).toBe("{ 'customer.email': 1, name: 1 }");
  });

  it('quotes a key with a space, a dash or a leading digit', () => {
    expect(emitValue({ 'first name': 1 })).toBe("{ 'first name': 1 }");
    expect(emitValue({ 'a-b': 1 })).toBe("{ 'a-b': 1 }");
    expect(emitValue({ '1st': 1 })).toBe("{ '1st': 1 }");
  });

  it('quotes an empty key and a unicode key', () => {
    expect(emitValue({ '': 1 })).toBe("{ '': 1 }");
    expect(emitValue({ naročilo: 1 })).toBe("{ 'naročilo': 1 }");
  });

  it('escapes a quoted key like a string', () => {
    expect(emitValue({ "it's": 1 })).toBe("{ 'it\\'s': 1 }");
    expect(emitValue({ 'a\nb': 1 })).toBe("{ 'a\\nb': 1 }");
    expect(emitValue({ 'a\\b': 1 })).toBe("{ 'a\\\\b': 1 }");
  });

  it('emits nested objects', () => {
    expect(emitValue({ total: { $gte: 100 } })).toBe('{ total: { $gte: 100 } }');
    expect(emitValue({ a: { b: { c: {} } } })).toBe('{ a: { b: { c: {} } } }');
  });

  it('emits arrays of objects and objects with arrays', () => {
    expect(emitValue({ $and: [{ a: 1 }, { b: 2 }] })).toBe('{ $and: [{ a: 1 }, { b: 2 }] }');
    expect(emitValue([{ $match: {} }, { $limit: 5 }])).toBe('[{ $match: {} }, { $limit: 5 }]');
  });

  it('emits specials as object values', () => {
    expect(
      emitValue({
        createdAt: { $gte: mongoDate('2026-01-01T00:00:00.000Z') },
        _id: mongoObjectId('507f1f77bcf86cd799439011'),
        email: mongoRegex('@gmail\\.com$', 'i'),
        at: mongoNow(),
      }),
    ).toBe(
      "{ createdAt: { $gte: ISODate('2026-01-01T00:00:00.000Z') }, _id: ObjectId('507f1f77bcf86cd799439011'), email: /@gmail\\.com$/i, at: new Date() }",
    );
  });

  it('emits a mixed deep value on one line', () => {
    const text = emitValue({
      $group: { _id: { k1: '$a', k2: '$b.c' }, n: { $sum: 1 }, items: { $addToSet: '$x' } },
    });
    expect(text).toBe(
      "{ $group: { _id: { k1: '$a', k2: '$b.c' }, n: { $sum: 1 }, items: { $addToSet: '$x' } } }",
    );
    expect(text).not.toContain('\n');
  });
});

describe('emitStatement find', () => {
  it('emits find with an empty filter', () => {
    expect(emitStatement(statement({}))).toBe('db.orders.find({})');
  });

  it('emits find with a filter and a projection', () => {
    expect(
      emitStatement(
        statement({
          args: [
            { status: 'shipped', total: { $gte: 100 } },
            { _id: 0, name: 1, 'address.city': 1 },
          ],
        }),
      ),
    ).toBe(
      "db.orders.find({ status: 'shipped', total: { $gte: 100 } }, { _id: 0, name: 1, 'address.city': 1 })",
    );
  });

  it('chains sort, skip and limit in the given order', () => {
    expect(
      emitStatement(
        statement({
          chain: [
            { method: 'sort', args: [{ total: -1, name: 1 }] },
            { method: 'skip', args: [10] },
            { method: 'limit', args: [5] },
          ],
        }),
      ),
    ).toBe('db.orders.find({}).sort({ total: -1, name: 1 }).skip(10).limit(5)');
  });

  it('chains a single limit', () => {
    expect(emitStatement(statement({ chain: [{ method: 'limit', args: [20] }] }))).toBe(
      'db.orders.find({}).limit(20)',
    );
  });

  it('emits the spec example for a find with a regex', () => {
    expect(
      emitStatement(
        statement({
          args: [
            {
              status: 'shipped',
              total: { $gte: 100 },
              'customer.email': mongoRegex('@gmail\\.com$', 'i'),
            },
            { _id: 0, name: 1, 'address.city': 1, total: 1 },
          ],
          chain: [
            { method: 'sort', args: [{ total: -1 }] },
            { method: 'limit', args: [20] },
          ],
        }),
      ),
    ).toBe(
      "db.orders.find({ status: 'shipped', total: { $gte: 100 }, 'customer.email': /@gmail\\.com$/i }, { _id: 0, name: 1, 'address.city': 1, total: 1 }).sort({ total: -1 }).limit(20)",
    );
  });

  it('uses getCollection for a name that db does not reach', () => {
    expect(emitStatement(statement({ collection: 'order.lines' }))).toBe(
      "db.getCollection('order.lines').find({})",
    );
    expect(emitStatement(statement({ collection: 'stats' }))).toBe(
      "db.getCollection('stats').find({})",
    );
  });
});

describe('emitStatement aggregate', () => {
  it('puts each stage on its own line', () => {
    expect(
      emitStatement(
        statement({
          method: 'aggregate',
          args: [
            [
              { $match: { status: 'shipped' } },
              { $group: { _id: '$customer.id', revenue: { $sum: '$total' } } },
            ],
          ],
        }),
      ),
    ).toBe(
      [
        'db.orders.aggregate([',
        "  { $match: { status: 'shipped' } },",
        "  { $group: { _id: '$customer.id', revenue: { $sum: '$total' } } }",
        '])',
      ].join('\n'),
    );
  });

  it('emits a single stage on its own line', () => {
    expect(emitStatement(statement({ method: 'aggregate', args: [[{ $limit: 5 }]] }))).toBe(
      'db.orders.aggregate([\n  { $limit: 5 }\n])',
    );
  });

  it('emits an empty pipeline inline', () => {
    expect(emitStatement(statement({ method: 'aggregate', args: [[]] }))).toBe(
      'db.orders.aggregate([])',
    );
  });

  it('emits the join example from the spec', () => {
    expect(
      emitStatement(
        statement({
          method: 'aggregate',
          args: [
            [
              { $match: { total: { $gt: 500 } } },
              {
                $lookup: {
                  from: 'customers',
                  localField: 'customerId',
                  foreignField: '_id',
                  as: 'c',
                },
              },
              { $unwind: '$c' },
              { $project: { _id: 0, orderId: 1, total: 1, name: '$c.name', email: '$c.email' } },
            ],
          ],
        }),
      ),
    ).toBe(
      [
        'db.orders.aggregate([',
        '  { $match: { total: { $gt: 500 } } },',
        "  { $lookup: { from: 'customers', localField: 'customerId', foreignField: '_id', as: 'c' } },",
        "  { $unwind: '$c' },",
        "  { $project: { _id: 0, orderId: 1, total: 1, name: '$c.name', email: '$c.email' } }",
        '])',
      ].join('\n'),
    );
  });

  it('emits the grouped example from the spec', () => {
    expect(
      emitStatement(
        statement({
          method: 'aggregate',
          args: [
            [
              { $match: { createdAt: { $gte: mongoDate('2026-01-01T00:00:00.000Z') } } },
              {
                $group: { _id: '$customer.id', orders: { $sum: 1 }, revenue: { $sum: '$total' } },
              },
              { $match: { revenue: { $gt: 1000 } } },
              { $project: { _id: 0, customer: '$_id', orders: 1, revenue: 1 } },
              { $sort: { revenue: -1 } },
            ],
          ],
        }),
      ),
    ).toBe(
      [
        'db.orders.aggregate([',
        "  { $match: { createdAt: { $gte: ISODate('2026-01-01T00:00:00.000Z') } } },",
        "  { $group: { _id: '$customer.id', orders: { $sum: 1 }, revenue: { $sum: '$total' } } },",
        '  { $match: { revenue: { $gt: 1000 } } },',
        "  { $project: { _id: 0, customer: '$_id', orders: 1, revenue: 1 } },",
        '  { $sort: { revenue: -1 } }',
        '])',
      ].join('\n'),
    );
  });

  it('keeps the inline layout when aggregate has more than one argument', () => {
    expect(
      emitStatement(
        statement({ method: 'aggregate', args: [[{ $limit: 5 }], { allowDiskUse: true }] }),
      ),
    ).toBe('db.orders.aggregate([{ $limit: 5 }], { allowDiskUse: true })');
  });

  it('uses getCollection in an aggregate', () => {
    expect(
      emitStatement(
        statement({ collection: '_events', method: 'aggregate', args: [[{ $limit: 1 }]] }),
      ),
    ).toBe("db.getCollection('_events').aggregate([\n  { $limit: 1 }\n])");
  });
});

describe('emitStatement writes', () => {
  it('emits updateMany with a $set document', () => {
    expect(
      emitStatement(
        statement({
          method: 'updateMany',
          kind: 'write',
          args: [
            { createdAt: { $lt: mongoDate('2025-01-01T00:00:00.000Z') } },
            { $set: { status: 'archived', archivedAt: mongoNow() } },
          ],
        }),
      ),
    ).toBe(
      "db.orders.updateMany({ createdAt: { $lt: ISODate('2025-01-01T00:00:00.000Z') } }, { $set: { status: 'archived', archivedAt: new Date() } })",
    );
  });

  it('emits a pipeline update inline', () => {
    expect(
      emitStatement(
        statement({
          method: 'updateMany',
          kind: 'write',
          args: [{}, [{ $set: { gross: { $multiply: ['$total', 1.22] } } }]],
        }),
      ),
    ).toBe("db.orders.updateMany({}, [{ $set: { gross: { $multiply: ['$total', 1.22] } } }])");
  });

  it('emits deleteMany', () => {
    expect(
      emitStatement(
        statement({ method: 'deleteMany', kind: 'write', args: [{ status: 'cancelled' }] }),
      ),
    ).toBe("db.orders.deleteMany({ status: 'cancelled' })");
    expect(
      emitStatement(statement({ method: 'deleteMany', kind: 'write', unsafe: true, args: [{}] })),
    ).toBe('db.orders.deleteMany({})');
  });

  it('emits insertMany with one row per object', () => {
    expect(
      emitStatement(
        statement({
          method: 'insertMany',
          kind: 'write',
          args: [
            [
              { name: 'a', total: 1 },
              { name: 'b', total: 2, address: { city: 'Ljubljana' } },
            ],
          ],
        }),
      ),
    ).toBe(
      "db.orders.insertMany([{ name: 'a', total: 1 }, { name: 'b', total: 2, address: { city: 'Ljubljana' } }])",
    );
  });

  it('ignores the unsafe and kind flags in the text', () => {
    expect(
      emitStatement(
        statement({
          method: 'updateMany',
          kind: 'write',
          unsafe: true,
          args: [{}, { $set: { a: 1 } }],
        }),
      ),
    ).toBe('db.orders.updateMany({}, { $set: { a: 1 } })');
  });
});

describe('collectionAccess re-export', () => {
  it('is the shared helper', () => {
    expect(collectionAccess('orders')).toBe('db.orders');
    expect(collectionAccess('my orders')).toBe("db.getCollection('my orders')");
  });
});
