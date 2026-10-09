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
import { summarizeDocuments } from './schema-sampler';

const ID = new ObjectId('64b7f0c2a1b2c3d4e5f60718');

function field(documents: unknown[], path: string) {
  const found = summarizeDocuments(documents).fields.find((item) => item.path === path);
  if (found === undefined) {
    throw new Error(`no field ${path}`);
  }
  return found;
}

describe('summarizeDocuments with BSON values', () => {
  it('names BSON wrapper values by their wrapper type', () => {
    const types = summarizeDocuments([
      {
        id: ID,
        int: new Int32(3),
        long: new Long('9007199254740993'),
        double: new Double(1),
        decimal: Decimal128.fromString('1.50'),
        binary: new Binary(Buffer.from('ab')),
        regex: new BSONRegExp('^a', 'i'),
        ts: new Timestamp({ t: 1, i: 1 }),
        min: new MinKey(),
        max: new MaxKey(),
      },
    ]).fields.map((item) => [item.path, item.types[0]]);
    expect(types).toEqual([
      ['binary', 'Binary'],
      ['decimal', 'Decimal128'],
      ['double', 'Double'],
      ['id', 'ObjectId'],
      ['int', 'Int32'],
      ['long', 'Long'],
      ['max', 'MaxKey'],
      ['min', 'MinKey'],
      ['regex', 'Regex'],
      ['ts', 'Timestamp'],
    ]);
  });

  it('names plain JavaScript values', () => {
    const summary = summarizeDocuments([
      { s: 'a', b: true, i: 7, f: 7.5, big: 10n, n: null, d: new Date(0), r: /x/, a: [], o: {} },
    ]);
    const types = Object.fromEntries(summary.fields.map((item) => [item.path, item.types[0]]));
    expect(types).toEqual({
      a: 'Array',
      b: 'Boolean',
      big: 'Long',
      d: 'Date',
      f: 'Double',
      i: 'Int32',
      n: 'Null',
      o: 'Object',
      r: 'Regex',
      s: 'String',
    });
  });

  it('reports _id as ObjectId at full presence with a canonical example', () => {
    const summary = summarizeDocuments([{ _id: ID }, { _id: new ObjectId() }]);
    expect(summary.sampled).toBe(2);
    const id = field([{ _id: ID }, { _id: new ObjectId() }], '_id');
    expect(id).toMatchObject({ types: ['ObjectId'], presence: 1, isIdLike: true });
    expect(id.examples?.[0]).toBe(`{"$oid":"${ID.toHexString()}"}`);
  });

  it('walks nested objects into dot paths', () => {
    const summary = summarizeDocuments([
      { _id: ID, customer: { name: 'Ada', address: { city: 'Ljubljana' } } },
    ]);
    expect(summary.fields.map((item) => item.path)).toEqual([
      '_id',
      'customer',
      'customer.address',
      'customer.address.city',
      'customer.name',
    ]);
  });

  it('computes presence as the fraction of documents containing the path', () => {
    const documents = [{ note: 'x' }, {}, {}, { note: null }];
    expect(field(documents, 'note')).toMatchObject({
      types: ['Null', 'String'],
      presence: 0.5,
    });
  });

  it('collects every type seen at one path with counts', () => {
    const documents = [{ v: 1 }, { v: 'one' }, { v: new Date(0) }, { v: new Int32(2) }];
    expect(field(documents, 'v')).toMatchObject({
      types: ['Date', 'Int32', 'String'],
      typeCounts: { Date: 1, Int32: 2, String: 1 },
      presence: 1,
    });
  });

  it('gives numeric ranges across int, long, double and decimal values', () => {
    const documents = [
      { amount: new Int32(12) },
      { amount: new Long('-40') },
      { amount: new Double(2.5) },
      { amount: Decimal128.fromString('99.5') },
      { amount: 'n/a' },
    ];
    expect(field(documents, 'amount')).toMatchObject({
      numeric: { min: -40, max: 99.5 },
      stringLengths: { min: 3, max: 3 },
    });
  });

  it('gives date bounds as ISO strings in UTC', () => {
    const documents = [
      { at: new Date('2024-03-01T10:00:00Z') },
      { at: new Date('2023-12-31T23:30:00Z') },
      { at: new Date('2025-01-15T00:00:00Z') },
    ];
    expect(field(documents, 'at').dateRange).toEqual({
      min: '2023-12-31T23:30:00.000Z',
      max: '2025-01-15T00:00:00.000Z',
    });
  });

  it('reports array element types under path[] and array lengths on the array', () => {
    const documents = [{ tags: ['a', 'b'] }, { tags: [1, 'x'] }, { tags: [] }];
    const tags = field(documents, 'tags');
    expect(tags).toMatchObject({ types: ['Array'], arrayLengths: { min: 0, max: 2, avg: 1.33 } });
    expect(field(documents, 'tags[]')).toMatchObject({
      types: ['Int32', 'String'],
      typeCounts: { Int32: 1, String: 3 },
    });
  });

  it('walks documents inside arrays with the array path as prefix', () => {
    const documents = [
      { items: [{ sku: 'A1' }, { sku: 'B2', qty: new Int32(2) }] },
      { items: [{ sku: 'C3', tags: ['x'] }] },
    ];
    const paths = summarizeDocuments(documents).fields.map((item) => item.path);
    expect(paths).toEqual([
      'items',
      'items[]',
      'items[].qty',
      'items[].sku',
      'items[].tags',
      'items[].tags[]',
    ]);
    expect(field(documents, 'items[].sku')).toMatchObject({
      presence: 1,
      typeCounts: { String: 3 },
    });
    expect(field(documents, 'items[].qty').presence).toBeCloseTo(1 / 2);
  });

  it('gives a distinct ratio and an id flag for a mostly unique field', () => {
    const documents = Array.from({ length: 20 }, (_, index) => ({
      orderNo: `O-${index}`,
      status: index % 2 === 0 ? 'paid' : 'open',
    }));
    expect(field(documents, 'orderNo')).toMatchObject({ uniqueRatio: 1, isIdLike: false });
    expect(field(documents, 'status').uniqueRatio).toBeCloseTo(0.1);
  });

  it('returns no fields and zero sampled for an empty collection', () => {
    expect(summarizeDocuments([])).toEqual({ fields: [], sampled: 0 });
  });
});
