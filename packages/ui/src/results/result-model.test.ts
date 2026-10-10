import { describe, expect, it } from 'vitest';
import {
  BSON_TYPE_LABELS,
  bsonTypeOf,
  cellView,
  collectionOfFind,
  discoverColumns,
  editTextOf,
  editTypeOf,
  flattenDocument,
  isoDateText,
  numberOf,
  parseCursorBatch,
  parseEjson,
  summariseResult,
  valueAtPath,
  valueFromEdit,
  wrapperKey,
  EDIT_TYPES,
  type JsonObject,
} from './result-model';

const OID = { $oid: '65f0c0ffee0000000000abcd' };
const DATE = { $date: '2026-03-01T10:00:00.000Z' };

describe('bsonTypeOf', () => {
  it.each([
    [null, 'Null'],
    ['text', 'String'],
    [true, 'Boolean'],
    [1.5, 'Number'],
    [[1], 'Array'],
    [{ a: 1 }, 'Object'],
    [OID, 'ObjectId'],
    [DATE, 'Date'],
    [{ $numberInt: '3' }, 'Int32'],
    [{ $numberLong: '3' }, 'Int64'],
    [{ $numberDouble: '3.5' }, 'Double'],
    [{ $numberDecimal: '3.50' }, 'Decimal128'],
    [{ $binary: { base64: 'AA==', subType: '00' } }, 'Binary'],
    [{ $timestamp: { t: 1, i: 2 } }, 'Timestamp'],
    [{ $regularExpression: { pattern: 'a', options: 'i' } }, 'Regex'],
    [{ $minKey: 1 }, 'MinKey'],
    [{ $maxKey: 1 }, 'MaxKey'],
    [{ $code: 'x' }, 'Code'],
    [{ $undefined: true }, 'Undefined'],
  ])('reads %j as %s', (value, expected) => {
    expect(bsonTypeOf(value)).toBe(expected);
  });

  it('treats an object with a wrapper key and another key as a plain object', () => {
    expect(bsonTypeOf({ $oid: 'x', extra: 1 })).toBe('Object');
    expect(wrapperKey({ $oid: 'x', extra: 1 })).toBeUndefined();
  });

  it('labels every type with a badge', () => {
    expect(BSON_TYPE_LABELS.Int32).toBe('int');
    expect(BSON_TYPE_LABELS.Int64).toBe('long');
    expect(BSON_TYPE_LABELS.Decimal128).toBe('decimal');
  });
});

describe('numberOf and parseEjson', () => {
  it('reads every numeric wrapper and plain numbers', () => {
    expect(numberOf({ $numberInt: '7' })).toBe(7);
    expect(numberOf({ $numberLong: '-9' })).toBe(-9);
    expect(numberOf({ $numberDouble: '2.5' })).toBe(2.5);
    expect(numberOf(4)).toBe(4);
    expect(numberOf({ $numberDouble: 'NaN' })).toBeUndefined();
    expect(numberOf('7')).toBeUndefined();
  });

  it('returns undefined for text that is not JSON', () => {
    expect(parseEjson('{nope')).toBeUndefined();
    expect(parseEjson('{"a":1}')).toEqual({ a: 1 });
  });
});

describe('isoDateText and valueAtPath', () => {
  it('reads a date from a string or from milliseconds', () => {
    expect(isoDateText(DATE)).toBe('2026-03-01T10:00:00.000Z');
    expect(isoDateText({ $date: { $numberLong: '0' } })).toBe('1970-01-01T00:00:00.000Z');
    expect(isoDateText({ $date: { $numberLong: 'x' } })).toBeUndefined();
    expect(isoDateText('2026')).toBeUndefined();
  });

  it('follows a dotted path and stops at missing keys', () => {
    const document = { a: { b: { c: 1 } } };
    expect(valueAtPath(document, 'a.b.c')).toBe(1);
    expect(valueAtPath(document, 'a.x')).toBeUndefined();
    expect(valueAtPath(document, 'a.b.c.d')).toBeUndefined();
  });
});

describe('flattenDocument', () => {
  it('opens nested plain objects into dotted paths', () => {
    const entries = flattenDocument({
      _id: OID,
      customer: { name: 'Ada', address: { city: 'Ljubljana' } },
      tags: ['a', 'b'],
      meta: {},
    });
    expect(entries.map((entry) => [entry.path, entry.type])).toEqual([
      ['_id', 'ObjectId'],
      ['customer.name', 'String'],
      ['customer.address.city', 'String'],
      ['tags', 'Array'],
      ['meta', 'Object'],
    ]);
  });

  it('keeps wrapped BSON values as leaves', () => {
    const [entry] = flattenDocument({ at: DATE });
    expect(entry).toEqual({ path: 'at', value: DATE, type: 'Date' });
  });
});

describe('discoverColumns', () => {
  it('unions the paths in first-seen order and puts _id first', () => {
    const documents: JsonObject[] = [
      { status: 'paid', _id: OID },
      { total: { $numberInt: '3' }, status: 'open' },
      { note: 'x', total: { $numberDouble: '1.5' } },
    ];
    const columns = discoverColumns(documents);
    expect(columns.map((column) => column.path)).toEqual(['_id', 'status', 'total', 'note']);
    expect(columns.find((column) => column.path === 'total')?.types).toEqual(['Int32', 'Double']);
  });

  it('returns no columns for no documents', () => {
    expect(discoverColumns([])).toEqual([]);
  });

  it('does not repeat a type already seen at a path', () => {
    const columns = discoverColumns([{ a: 1 }, { a: 2 }]);
    expect(columns[0]?.types).toEqual(['Number']);
  });
});

describe('cellView', () => {
  it('shortens an ObjectId and keeps the full value as the title', () => {
    expect(cellView(OID)).toEqual({
      text: '65f0c0ff…',
      type: 'ObjectId',
      align: 'left',
      title: '65f0c0ffee0000000000abcd',
    });
  });

  it('writes dates as ISO text', () => {
    expect(cellView(DATE).text).toBe('2026-03-01T10:00:00.000Z');
  });

  it('right-aligns numbers', () => {
    expect(cellView({ $numberInt: '42' })).toMatchObject({ text: '42', align: 'right' });
    expect(cellView({ $numberLong: '9007199254740993' })).toMatchObject({ align: 'right' });
    expect(cellView({ $numberDecimal: '12.50' })).toMatchObject({ text: '12.50', align: 'right' });
  });

  it('shows booleans and null', () => {
    expect(cellView(false).text).toBe('false');
    expect(cellView(null).text).toBe('null');
  });

  it('cuts a long string and keeps it whole in the title', () => {
    const long = 'x'.repeat(200);
    const view = cellView(long);
    expect(view.text.length).toBe(120);
    expect(view.title).toBe(long);
  });

  it('summarises an object and an array with a count and a tooltip', () => {
    expect(cellView({ a: 1, b: 2, c: 3 })).toMatchObject({ text: '{…} 3 fields' });
    expect(cellView({ a: 1 })).toMatchObject({ text: '{…} 1 field' });
    expect(cellView([1, 2, 3]).text).toBe('[…] 3 items');
    expect(cellView([1]).text).toBe('[…] 1 item');
    expect(cellView({ a: 1 }).title).toContain('"a"');
  });

  it('describes the less common BSON types', () => {
    expect(cellView({ $binary: { base64: 'AAAA', subType: '04' } }).text).toBe(
      'Binary(04, 3 bytes)',
    );
    expect(cellView({ $timestamp: { t: 5, i: 1 } }).text).toBe('Timestamp(5, 1)');
    expect(cellView({ $regularExpression: { pattern: 'ab', options: 'i' } }).text).toBe('/ab/i');
    expect(cellView({ $minKey: 1 }).text).toBe('MinKey');
    expect(cellView({ $maxKey: 1 }).text).toBe('MaxKey');
    expect(cellView({ $code: 'x' }).text).toBe('x');
    expect(cellView({ $undefined: true }).text).toBe('undefined');
  });
});

describe('parseCursorBatch and summariseResult', () => {
  it('reads a cursor batch', () => {
    const batch = parseCursorBatch(
      JSON.stringify({ cursorHasMore: true, documents: [{ a: 1 }, 'bad'] }),
    );
    expect(batch).toEqual({ documents: [{ a: 1 }], hasMore: true });
  });

  it('rejects text that is not a batch', () => {
    expect(parseCursorBatch('[1]')).toBeUndefined();
    expect(parseCursorBatch('{"documents":1}')).toBeUndefined();
  });

  it('summarises inserts', () => {
    expect(summariseResult('InsertOneResult', '{"acknowledged":true}')).toBe('Inserted 1');
    const many = JSON.stringify({ insertedIds: { '0': OID, '1': OID, '2': OID } });
    expect(summariseResult('InsertManyResult', many)).toBe('Inserted 3');
  });

  it('summarises updates with the match and modify counts', () => {
    const printable = JSON.stringify({
      matchedCount: { $numberInt: '10' },
      modifiedCount: { $numberInt: '10' },
      upsertedCount: { $numberInt: '0' },
    });
    expect(summariseResult('UpdateResult', printable)).toBe('Matched 10, modified 10');
    const upserted = JSON.stringify({ matchedCount: 0, modifiedCount: 0, upsertedCount: 1 });
    expect(summariseResult('UpdateResult', upserted)).toBe('Matched 0, modified 0, upserted 1');
  });

  it('summarises deletes and bulk writes', () => {
    expect(summariseResult('DeleteResult', '{"deletedCount":{"$numberInt":"2"}}')).toBe(
      'Deleted 2',
    );
    const bulk = JSON.stringify({ insertedCount: 1, matchedCount: 0, deletedCount: 2 });
    expect(summariseResult('BulkWriteResult', bulk)).toBe('Inserted 1, deleted 2');
    expect(summariseResult('BulkWriteResult', '{}')).toBe('No changes');
  });

  it('has no summary for other types', () => {
    expect(summariseResult('string', '"x"')).toBeUndefined();
    expect(summariseResult('UpdateResult', 'not json')).toBeUndefined();
  });
});

describe('collectionOfFind', () => {
  it.each([
    'db.orders.find({ status: "paid" }).sort({ total: -1 })',
    'db.orders.find()',
    'db.orders.find({}, { _id: 0 }).limit(50).skip(10)',
    '  db.orders.find({ note: "a) b" }) ',
    "db.orders.find({ note: 'it''s (ok' }).batchSize(20)",
    'db.orders.findOne({ _id: 1 })',
    'db.getCollection("orders").find()',
    "db.getCollection('orders').findOne()",
    'db["orders"].find({})',
  ])('reads the collection of %s', (statement) => {
    expect(collectionOfFind(statement)).toBe('orders');
  });

  it.each([
    'db.orders.aggregate([])',
    'db.orders.countDocuments({})',
    'db.orders.find({}).map(x => x)',
    'db.orders.find({}) + 1',
    'db.orders.find({ a: 1 }',
    'db.orders.findOne().sort({ a: 1 })',
    'db["orders"].aggregate([])',
    'print(db.orders.find())',
    'db.orders.find(); db.users.find()',
    'db.orders.find().sort({a: 1}).count()',
    'db.orders.find({}).sort({a: 1}) extra',
  ])('refuses %s', (statement) => {
    expect(collectionOfFind(statement)).toBeUndefined();
  });
});

describe('valueFromEdit', () => {
  it('converts each type to canonical EJSON', () => {
    expect(valueFromEdit('string', 'hi')).toEqual({ ok: true, value: 'hi' });
    expect(valueFromEdit('null', 'ignored')).toEqual({ ok: true, value: null });
    expect(valueFromEdit('boolean', 'TRUE')).toEqual({ ok: true, value: true });
    expect(valueFromEdit('int', ' 42 ')).toEqual({ ok: true, value: { $numberInt: '42' } });
    expect(valueFromEdit('long', '9007199254740')).toEqual({
      ok: true,
      value: { $numberLong: '9007199254740' },
    });
    expect(valueFromEdit('double', '2.5')).toEqual({ ok: true, value: { $numberDouble: '2.5' } });
    expect(valueFromEdit('decimal', '12.50')).toEqual({
      ok: true,
      value: { $numberDecimal: '12.50' },
    });
    expect(valueFromEdit('date', '2026-03-01T10:00:00Z')).toEqual({
      ok: true,
      value: { $date: '2026-03-01T10:00:00.000Z' },
    });
    expect(valueFromEdit('objectId', '65F0C0FFEE0000000000ABCD')).toEqual({
      ok: true,
      value: { $oid: '65f0c0ffee0000000000abcd' },
    });
  });

  it('refuses text that does not fit the type', () => {
    expect(valueFromEdit('int', '1.5').ok).toBe(false);
    expect(valueFromEdit('int', '2147483648').ok).toBe(false);
    expect(valueFromEdit('long', '1e3').ok).toBe(false);
    expect(valueFromEdit('double', 'Infinity').ok).toBe(false);
    expect(valueFromEdit('double', '  ').ok).toBe(false);
    expect(valueFromEdit('decimal', 'abc').ok).toBe(false);
    expect(valueFromEdit('boolean', 'yes').ok).toBe(false);
    expect(valueFromEdit('date', 'not a date').ok).toBe(false);
    expect(valueFromEdit('objectId', 'abc').ok).toBe(false);
  });

  it('reports a message for a refused value', () => {
    const result = valueFromEdit('int', 'x');
    expect(result.ok ? '' : result.message).toMatch(/whole number/);
  });

  it('covers every edit type in the picker', () => {
    expect(EDIT_TYPES).toHaveLength(9);
  });
});

describe('editTypeOf and editTextOf', () => {
  it('maps each leaf to its picker type and edit text', () => {
    expect(editTypeOf({ $numberInt: '3' })).toBe('int');
    expect(editTextOf({ $numberInt: '3' })).toBe('3');
    expect(editTypeOf(OID)).toBe('objectId');
    expect(editTextOf(OID)).toBe('65f0c0ffee0000000000abcd');
    expect(editTypeOf(DATE)).toBe('date');
    expect(editTextOf(DATE)).toBe('2026-03-01T10:00:00.000Z');
    expect(editTypeOf(null)).toBe('null');
    expect(editTextOf(null)).toBe('');
    expect(editTypeOf(true)).toBe('boolean');
    expect(editTextOf(false)).toBe('false');
    expect(editTypeOf('x')).toBe('string');
    expect(editTextOf('x')).toBe('x');
  });

  it('offers no edit type for an array or a binary value', () => {
    expect(editTypeOf([1])).toBeUndefined();
    expect(editTypeOf({ $binary: { base64: '', subType: '00' } })).toBeUndefined();
  });
});

describe('binary, timestamp and long values', () => {
  it('shows a subtype 4 binary as a UUID', () => {
    const value = { $binary: { base64: 'EjRWeBI0VngSNFZ4EjRWeA==', subType: '04' } };
    expect(cellView(value).text).toBe('UUID(12345678-1234-5678-1234-567812345678)');
  });

  it('shows the decoded byte length for other subtypes', () => {
    const value = { $binary: { base64: 'AQID', subType: '00' } };
    expect(cellView(value).text).toBe('Binary(00, 3 bytes)');
    const padded = { $binary: { base64: 'AQI=', subType: '80' } };
    expect(cellView(padded).text).toBe('Binary(80, 2 bytes)');
  });

  it('reads wrapped timestamp parts', () => {
    const value = { $timestamp: { t: { $numberInt: '5' }, i: { $numberInt: '2' } } };
    expect(cellView(value).text).toBe('Timestamp(5, 2)');
  });

  it('keeps every digit of a long edit and checks the int64 range exactly', () => {
    expect(valueFromEdit('long', '9223372036854775807')).toEqual({
      ok: true,
      value: { $numberLong: '9223372036854775807' },
    });
    expect(valueFromEdit('long', '-9223372036854775808').ok).toBe(true);
    expect(valueFromEdit('long', '9223372036854775808').ok).toBe(false);
    expect(valueFromEdit('long', '-9223372036854775809').ok).toBe(false);
  });
});
