import { describe, expect, it } from 'vitest';
import { parseFilterText, parseStatementAt, parseValueText } from './parse';
import { filterFromEjson } from './parse-filter';

const OBJECT_ID_HEX = '64b7f0c2a1b2c3d4e5f60718';

function reasonOf(text: string, offset = 0): string | undefined {
  const result = parseStatementAt(text, offset);
  return result !== null && 'unsupported' in result ? result.unsupported : undefined;
}

const openStatus = {
  kind: 'group',
  operator: 'and',
  items: [{ kind: 'condition', enabled: true, field: 'status', operator: 'eq', value: 'open' }],
};

const emptyFilter = { kind: 'group', operator: 'and', items: [] };

describe('parseStatementAt, find', () => {
  it('reads a find with projection, sort, skip and limit', () => {
    const text =
      'db.orders.find({ status: "open" }, { name: 1, _id: 0 }).sort({ total: -1 }).skip(2).limit(10)';
    expect(parseStatementAt(text, 5)).toEqual({
      range: { start: 0, end: text.length },
      statement: {
        kind: 'find',
        collection: 'orders',
        filter: openStatus,
        projection: [
          { kind: 'field', enabled: true, field: 'name', include: true },
          { kind: 'field', enabled: true, field: '_id', include: false },
        ],
        sort: [{ enabled: true, field: 'total', direction: -1 }],
        skip: 2,
        limit: 10,
      },
    });
  });

  it('reads the chain calls in any order', () => {
    const result = parseStatementAt('db.orders.find().limit(5).skip(1)', 0);
    expect(result).toMatchObject({ statement: { skip: 1, limit: 5, filter: emptyFilter } });
  });

  it('reads a chain that the emitter wraps over lines', () => {
    const text = 'db.orders.find()\n  .limit(5);';
    expect(parseStatementAt(text, 0)).toEqual({
      range: { start: 0, end: text.length },
      statement: {
        kind: 'find',
        collection: 'orders',
        filter: emptyFilter,
        projection: [],
        sort: [],
        skip: null,
        limit: 5,
      },
    });
  });

  it('reads db.getCollection with single and double quotes', () => {
    for (const text of [
      "db.getCollection('order-items').find()",
      'db.getCollection("order-items").find()',
    ]) {
      expect(parseStatementAt(text, 0)).toMatchObject({
        statement: { kind: 'find', collection: 'order-items' },
      });
    }
  });
});

describe('parseStatementAt, aggregate', () => {
  it('reads a pipeline into one stage per object', () => {
    const text = 'db.orders.aggregate([{ $match: { status: "open" } }, { $limit: 5 }])';
    expect(parseStatementAt(text, 0)).toEqual({
      range: { start: 0, end: text.length },
      statement: {
        kind: 'aggregate',
        collection: 'orders',
        stages: [
          { stage: '$match', filter: openStatus, enabled: true },
          { stage: '$limit', count: 5, enabled: true },
        ],
      },
    });
  });

  it('reads an empty pipeline', () => {
    expect(parseStatementAt('db.getCollection("a-b").aggregate([])', 0)).toMatchObject({
      statement: { kind: 'aggregate', collection: 'a-b', stages: [] },
    });
  });
});

describe('parseStatementAt, several statements', () => {
  const text = 'db.a.find();\ndb.b.aggregate([])';

  it('picks the statement that holds the offset', () => {
    expect(parseStatementAt(text, 0)).toMatchObject({
      range: { start: 0, end: 12 },
      statement: { kind: 'find', collection: 'a' },
    });
    expect(parseStatementAt(text, 20)).toMatchObject({
      range: { start: 13, end: text.length },
      statement: { kind: 'aggregate', collection: 'b' },
    });
  });

  it('includes the trailing semicolon in the range', () => {
    expect(parseStatementAt('db.a.find();', 0)?.range).toEqual({ start: 0, end: 12 });
  });

  it('counts the offset right after the semicolon as part of the statement', () => {
    expect(parseStatementAt(text, 12)).toMatchObject({ statement: { collection: 'a' } });
  });

  it('returns null for an offset in the blank gap between statements', () => {
    const gap = 'db.a.find();\n\ndb.b.find()';
    expect(parseStatementAt(gap, 13)).toBeNull();
  });

  it('returns null for an offset in a comment between statements', () => {
    const withComment = 'db.a.find(); // note\ndb.b.find()';
    expect(parseStatementAt(withComment, withComment.indexOf('note'))).toBeNull();
  });

  it('reads the statement after a comment line', () => {
    const commented = '// note\ndb.orders.find()';
    expect(parseStatementAt(commented, 10)).toEqual({
      range: { start: 8, end: commented.length },
      statement: expect.objectContaining({ kind: 'find', collection: 'orders' }),
    });
  });

  it('reads the find when a mongosh-only line comes first', () => {
    const mixed = 'use shop\ndb.orders.find()';
    expect(parseStatementAt(mixed, mixed.indexOf('db.'))).toMatchObject({
      statement: { kind: 'find', collection: 'orders' },
    });
    expect(reasonOf(mixed, 0)).toBe('not a find or aggregate call');
  });

  it('keeps the statements before a syntax error', () => {
    const broken = 'db.a.find();\ndb.b.find({';
    expect(parseStatementAt(broken, 0)).toMatchObject({ statement: { collection: 'a' } });
    expect(parseStatementAt(broken, 20)).toEqual({
      range: { start: 13, end: broken.length },
      unsupported: expect.stringMatching(/^syntax error/),
    });
  });
});

describe('parseStatementAt, offsets and empty texts', () => {
  it('returns null for an empty text', () => {
    expect(parseStatementAt('', 0)).toBeNull();
  });

  it('returns null for a text with only whitespace', () => {
    expect(parseStatementAt('  \n\t ', 2)).toBeNull();
  });

  it('returns null for an offset past the statement', () => {
    expect(parseStatementAt('db.a.find()  ', 12)).toBeNull();
  });

  it('reads the statement when the offset is at its end', () => {
    expect(parseStatementAt('db.a.find()', 11)).toMatchObject({ statement: { collection: 'a' } });
  });
});

describe('parseStatementAt, unsupported', () => {
  it('refuses a comment inside the statement', () => {
    const text = 'db.orders.find({ /* note */ status: "open" })';
    expect(parseStatementAt(text, 0)).toEqual({
      range: { start: 0, end: text.length },
      unsupported: 'comment in the statement',
    });
  });

  it('refuses an identifier inside the statement', () => {
    expect(reasonOf('db.orders.find({ status: open })')).toBe('identifier');
  });

  it('refuses a bad sort direction', () => {
    expect(reasonOf('db.orders.find().sort({ total: 2 })')).toBe('sort direction is not 1 or -1');
  });

  it('refuses a null stage', () => {
    expect(reasonOf('db.orders.aggregate([null])')).toBe('needs an object literal');
  });

  it('refuses a stage object with two keys', () => {
    expect(reasonOf('db.orders.aggregate([{ $match: {}, $limit: 1 }])')).toBe(
      'a stage has no known form',
    );
  });

  it('refuses a chain call that is not sort, skip or limit', () => {
    expect(reasonOf('db.orders.find().count()')).toBe('method count is not allowed here');
    expect(reasonOf('db.orders.find().toArray()')).toBe('method toArray is not allowed here');
  });

  it('refuses a repeated chain call', () => {
    expect(reasonOf('db.orders.find().limit(1).limit(2)')).toBe('limit is set twice');
  });

  it('refuses a chain call after aggregate', () => {
    expect(reasonOf('db.orders.aggregate([]).limit(1)')).toBe('only find takes a chain');
  });

  it('refuses a third argument to find', () => {
    expect(reasonOf('db.orders.find({}, {}, {})')).toBe('find takes a filter and a projection');
  });

  it('refuses an options argument to aggregate', () => {
    expect(reasonOf('db.orders.aggregate([], { allowDiskUse: true })')).toBe(
      'aggregate takes one array of stages',
    );
  });

  it('refuses a receiver other than db', () => {
    expect(reasonOf('foo.find()')).toBe('not db.<name> or db.getCollection(name)');
  });

  it('refuses a getCollection name that is not a string literal', () => {
    expect(reasonOf('db.getCollection(name).find()')).toBe(
      'not db.<name> or db.getCollection(name)',
    );
  });

  it('refuses a filter that is a value call and not an object literal', () => {
    expect(reasonOf(`db.orders.find(ObjectId("${OBJECT_ID_HEX}"))`)).toBe(
      'needs an object literal',
    );
  });

  it('refuses a statement that is not a call', () => {
    expect(reasonOf('let x = 1')).toBe('not a find or aggregate call');
  });

  it('refuses a syntax error inside the statement', () => {
    expect(reasonOf('db.orders.find({')).toMatch(/^syntax error/);
  });
});

describe('parseFilterText', () => {
  it('reads a bare filter object', () => {
    expect(parseFilterText('{ status: "open", total: { $gt: 10 } }')).toEqual({
      filter: filterFromEjson({ status: 'open', total: { $gt: 10 } }),
    });
    expect(parseFilterText('{ status: "open" }')).toEqual({
      filter: { kind: 'group', operator: 'and', items: [openStatus.items[0]] },
    });
  });

  it('reads an empty object as an empty filter', () => {
    expect(parseFilterText('{}')).toEqual({ filter: emptyFilter });
  });

  it('accepts a trailing semicolon', () => {
    expect(parseFilterText('{ status: "open" };')).toEqual({ filter: openStatus });
  });

  it('returns null for an empty text', () => {
    expect(parseFilterText('')).toBeNull();
    expect(parseFilterText('   ')).toBeNull();
  });

  it('refuses a syntax error', () => {
    expect(parseFilterText('{ status: ')).toEqual({
      unsupported: expect.stringMatching(/^syntax error/),
    });
  });

  it('refuses text after the object', () => {
    expect(parseFilterText('status: "open"')).toEqual({ unsupported: 'text after the filter' });
  });

  it('refuses a statement and a value call', () => {
    expect(parseFilterText('db.orders.find()')).toEqual({ unsupported: 'needs an object literal' });
    expect(parseFilterText(`ObjectId("${OBJECT_ID_HEX}")`)).toEqual({
      unsupported: 'needs an object literal',
    });
  });

  it('refuses a comment', () => {
    expect(parseFilterText('/* a */ {}')).toEqual({ unsupported: 'comment in the filter' });
    expect(parseFilterText('{} // a')).toEqual({ unsupported: expect.any(String) });
  });
});

describe('parseValueText', () => {
  it('reads an object', () => {
    expect(parseValueText('{ $slice: 5 }')).toEqual({ value: { $slice: 5 } });
  });

  it('reads an array', () => {
    expect(parseValueText('[1, 2]')).toEqual({ value: [1, 2] });
  });

  it('reads a regex with its flags', () => {
    expect(parseValueText('/a/i')).toEqual({
      value: { $regularExpression: { pattern: 'a', options: 'i' } },
    });
  });

  it('reads an ObjectId', () => {
    expect(parseValueText(`ObjectId("${OBJECT_ID_HEX}")`)).toEqual({
      value: { $oid: OBJECT_ID_HEX },
    });
  });

  it('refuses trailing text', () => {
    expect(parseValueText('5 garbage')).toEqual({ unsupported: 'text after the value' });
  });

  it('refuses a comment', () => {
    expect(parseValueText('{ /* n */ a: 1 }')).toEqual({ unsupported: 'comment in the value' });
  });

  it('refuses an identifier', () => {
    expect(parseValueText('abc')).toEqual({ unsupported: 'identifier' });
  });

  it('refuses an empty text', () => {
    expect(parseValueText('')).toEqual({ unsupported: 'empty text' });
    expect(parseValueText('  ')).toEqual({ unsupported: 'empty text' });
  });

  it('refuses a syntax error', () => {
    expect(parseValueText('[1,')).toEqual({ unsupported: expect.stringMatching(/^syntax error/) });
  });
});
