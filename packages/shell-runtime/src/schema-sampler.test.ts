import {
  Binary,
  BSONRegExp,
  Decimal128,
  Double,
  Int32,
  Long,
  MaxKey,
  MinKey,
  ObjectId,
  Timestamp,
} from 'bson';
import { describe, expect, it } from 'vitest';
import { bsonTypeName, summarizeDocuments } from './schema-sampler';

const ID = new ObjectId('64b7f0c2a1b2c3d4e5f60718');

describe('bsonTypeName', () => {
  it('names BSON wrapper values by their wrapper type', () => {
    expect(bsonTypeName(ID)).toBe('ObjectId');
    expect(bsonTypeName(new Int32(3))).toBe('Int32');
    expect(bsonTypeName(new Long('9007199254740993'))).toBe('Long');
    expect(bsonTypeName(new Double(1))).toBe('Double');
    expect(bsonTypeName(Decimal128.fromString('1.50'))).toBe('Decimal128');
    expect(bsonTypeName(new Binary(Buffer.from('ab')))).toBe('Binary');
    expect(bsonTypeName(new BSONRegExp('^a', 'i'))).toBe('Regex');
    expect(bsonTypeName(new Timestamp({ t: 1, i: 1 }))).toBe('Timestamp');
    expect(bsonTypeName(new MinKey())).toBe('MinKey');
    expect(bsonTypeName(new MaxKey())).toBe('MaxKey');
  });

  it('names plain JavaScript values', () => {
    expect(bsonTypeName('a')).toBe('String');
    expect(bsonTypeName(true)).toBe('Boolean');
    expect(bsonTypeName(7)).toBe('Int32');
    expect(bsonTypeName(7.5)).toBe('Double');
    expect(bsonTypeName(2 ** 40)).toBe('Double');
    expect(bsonTypeName(10n)).toBe('Long');
    expect(bsonTypeName(null)).toBe('Null');
    expect(bsonTypeName(undefined)).toBe('undefined');
    expect(bsonTypeName(new Date(0))).toBe('Date');
    expect(bsonTypeName(/x/)).toBe('Regex');
    expect(bsonTypeName([])).toBe('Array');
    expect(bsonTypeName({})).toBe('Object');
  });
});

describe('summarizeDocuments', () => {
  it('reports _id as ObjectId at full presence', () => {
    const summary = summarizeDocuments([{ _id: ID }, { _id: new ObjectId() }]);
    expect(summary.sampled).toBe(2);
    expect(summary.fields).toContainEqual({ path: '_id', types: ['ObjectId'], presence: 1 });
  });

  it('walks nested objects into dot paths', () => {
    const summary = summarizeDocuments([
      { _id: ID, customer: { name: 'Ada', address: { city: 'Ljubljana' } } },
    ]);
    const paths = summary.fields.map((field) => field.path);
    expect(paths).toEqual([
      '_id',
      'customer',
      'customer.address',
      'customer.address.city',
      'customer.name',
    ]);
    expect(summary.fields.find((field) => field.path === 'customer.address.city')).toEqual({
      path: 'customer.address.city',
      types: ['String'],
      presence: 1,
    });
  });

  it('records array fields as path with Array and element types under path[]', () => {
    const summary = summarizeDocuments([{ tags: ['a', 'b'] }, { tags: [1, 'x'] }]);
    expect(summary.fields.find((field) => field.path === 'tags')).toEqual({
      path: 'tags',
      types: ['Array'],
      presence: 1,
    });
    expect(summary.fields.find((field) => field.path === 'tags[]')).toEqual({
      path: 'tags[]',
      types: ['Int32', 'String'],
      presence: 1,
    });
  });

  it('walks objects inside arrays with the array path as prefix', () => {
    const summary = summarizeDocuments([{ items: [{ sku: 'A1' }, { sku: 'B2', qty: 2 }] }]);
    const paths = summary.fields.map((field) => field.path);
    expect(paths).toContain('items[].sku');
    expect(paths).toContain('items[].qty');
  });

  it('computes presence as the fraction of documents containing the path', () => {
    const summary = summarizeDocuments([
      { _id: ID, note: 'x' },
      { _id: ID },
      { _id: ID },
      { _id: ID, note: null },
    ]);
    expect(summary.fields.find((field) => field.path === 'note')).toEqual({
      path: 'note',
      types: ['Null', 'String'],
      presence: 0.5,
    });
  });

  it('collects every type seen at one path', () => {
    const summary = summarizeDocuments([{ v: 1 }, { v: 'one' }, { v: new Date(0) }]);
    expect(summary.fields.find((field) => field.path === 'v')).toEqual({
      path: 'v',
      types: ['Date', 'Int32', 'String'],
      presence: 1,
    });
  });

  it('returns no fields and zero sampled for an empty collection', () => {
    expect(summarizeDocuments([])).toEqual({ fields: [], sampled: 0 });
  });
});
