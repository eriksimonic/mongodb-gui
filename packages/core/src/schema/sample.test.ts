import { describe, expect, it } from 'vitest';
import { canonicalTypeName, summarizeCanonicalSample, truncate } from './sample';
import { SchemaFieldSchema, SCHEMA_EXAMPLE_MAX_CHARS } from './types';

const oid = (hex: string) => ({ $oid: hex });
const date = (iso: string) => ({ $date: iso });

function field(fields: ReturnType<typeof summarizeCanonicalSample>['fields'], path: string) {
  const found = fields.find((item) => item.path === path);
  if (found === undefined) {
    throw new Error(`no field ${path}`);
  }
  return found;
}

describe('canonicalTypeName', () => {
  it('names canonical wrapper values by their BSON type', () => {
    expect(canonicalTypeName(oid('64b7f0c2a1b2c3d4e5f60718'))).toBe('ObjectId');
    expect(canonicalTypeName({ $numberInt: '3' })).toBe('Int32');
    expect(canonicalTypeName({ $numberLong: '9007199254740993' })).toBe('Long');
    expect(canonicalTypeName({ $numberDouble: '1.5' })).toBe('Double');
    expect(canonicalTypeName({ $numberDecimal: '1.50' })).toBe('Decimal128');
    expect(canonicalTypeName({ $binary: { base64: 'YWI=', subType: '00' } })).toBe('Binary');
    expect(canonicalTypeName({ $regularExpression: { pattern: '^a', options: 'i' } })).toBe(
      'Regex',
    );
    expect(canonicalTypeName({ $timestamp: { t: 1, i: 1 } })).toBe('Timestamp');
    expect(canonicalTypeName({ $minKey: 1 })).toBe('MinKey');
    expect(canonicalTypeName({ $maxKey: 1 })).toBe('MaxKey');
    expect(canonicalTypeName(date('2024-01-01T00:00:00Z'))).toBe('Date');
  });

  it('names plain JSON values', () => {
    expect(canonicalTypeName('a')).toBe('String');
    expect(canonicalTypeName(true)).toBe('Boolean');
    expect(canonicalTypeName(7)).toBe('Int32');
    expect(canonicalTypeName(7.5)).toBe('Double');
    expect(canonicalTypeName(2 ** 40)).toBe('Double');
    expect(canonicalTypeName(null)).toBe('Null');
    expect(canonicalTypeName([])).toBe('Array');
    expect(canonicalTypeName({})).toBe('Object');
  });
});

describe('summarizeCanonicalSample', () => {
  it('returns no fields and zero sampled for an empty sample', () => {
    expect(summarizeCanonicalSample([])).toEqual({ fields: [], sampled: 0 });
  });

  it('reports presence, types and type counts for mixed types', () => {
    const { fields, sampled } = summarizeCanonicalSample([
      { _id: oid('64b7f0c2a1b2c3d4e5f60718'), v: 1 },
      { _id: oid('64b7f0c2a1b2c3d4e5f60719'), v: 'one' },
      { _id: oid('64b7f0c2a1b2c3d4e5f6071a'), v: { $numberLong: '5' } },
      { _id: oid('64b7f0c2a1b2c3d4e5f6071b') },
    ]);
    expect(sampled).toBe(4);
    const v = field(fields, 'v');
    expect(v.types).toEqual(['Int32', 'Long', 'String']);
    expect(v.typeCounts).toEqual({ Int32: 1, Long: 1, String: 1 });
    expect(v.presence).toBe(0.75);
    expect(v.numeric).toEqual({ min: 1, max: 5 });
    expect(v.stringLengths).toEqual({ min: 3, max: 3 });
  });

  it('keeps null apart from missing fields', () => {
    const { fields } = summarizeCanonicalSample([{ note: 'x' }, { note: null }, {}, {}]);
    const note = field(fields, 'note');
    expect(note.types).toEqual(['Null', 'String']);
    expect(note.presence).toBe(0.5);
  });

  it('walks nested objects into dot paths', () => {
    const { fields } = summarizeCanonicalSample([
      { customer: { name: 'Ada', address: { city: 'Ljubljana' } } },
    ]);
    expect(fields.map((item) => item.path)).toEqual([
      'customer',
      'customer.address',
      'customer.address.city',
      'customer.name',
    ]);
  });

  it('reports array element types under path[] and array lengths on the array', () => {
    const { fields } = summarizeCanonicalSample([
      { tags: ['a', 'b'] },
      { tags: [{ $numberInt: '1' }, 'x'] },
      { tags: [] },
    ]);
    const tags = field(fields, 'tags');
    expect(tags.types).toEqual(['Array']);
    expect(tags.arrayLengths).toEqual({ min: 0, max: 2, avg: 1.33 });
    const elements = field(fields, 'tags[]');
    expect(elements.types).toEqual(['Int32', 'String']);
    expect(elements.typeCounts).toEqual({ Int32: 1, String: 3 });
    expect(elements.presence).toBeCloseTo(2 / 3);
  });

  it('walks documents inside arrays with the array path as prefix', () => {
    const { fields } = summarizeCanonicalSample([
      { items: [{ sku: 'A1' }, { sku: 'B2', qty: { $numberInt: '2' } }] },
      { items: [] },
    ]);
    const paths = fields.map((item) => item.path);
    expect(paths).toEqual(['items', 'items[]', 'items[].qty', 'items[].sku']);
    expect(field(fields, 'items[].sku').typeCounts).toEqual({ String: 2 });
    expect(field(fields, 'items[].sku').presence).toBe(0.5);
    expect(field(fields, 'items').arrayLengths).toEqual({ min: 0, max: 2, avg: 1 });
  });

  it('gives numeric ranges for int, long, double and decimal values', () => {
    const { fields } = summarizeCanonicalSample([
      { n: { $numberInt: '-4' } },
      { n: { $numberDouble: '2.5' } },
      { n: { $numberLong: '100' } },
      { n: { $numberDecimal: '7.25' } },
      { n: 'not a number' },
    ]);
    expect(field(fields, 'n').numeric).toEqual({ min: -4, max: 100 });
  });

  it('gives date bounds as ISO strings in UTC', () => {
    const { fields } = summarizeCanonicalSample([
      { at: date('2024-03-01T10:00:00Z') },
      { at: { $date: { $numberLong: String(Date.parse('2023-12-31T23:30:00Z')) } } },
      { at: date('2025-01-15T00:00:00.000Z') },
    ]);
    expect(field(fields, 'at').dateRange).toEqual({
      min: '2023-12-31T23:30:00.000Z',
      max: '2025-01-15T00:00:00.000Z',
    });
  });

  it('keeps up to five distinct examples in canonical EJSON', () => {
    const { fields } = summarizeCanonicalSample([
      { status: 'paid' },
      { status: 'paid' },
      { status: 'open' },
      { status: 'late' },
      { status: 'void' },
      { status: 'draft' },
      { status: 'lost' },
    ]);
    expect(field(fields, 'status').examples).toEqual([
      '"paid"',
      '"open"',
      '"late"',
      '"void"',
      '"draft"',
    ]);
  });

  it('truncates long examples to the example length', () => {
    const long = 'x'.repeat(200);
    const { fields } = summarizeCanonicalSample([{ body: long }]);
    const [example] = field(fields, 'body').examples ?? [];
    expect(example?.length).toBe(SCHEMA_EXAMPLE_MAX_CHARS);
    expect(example?.endsWith('…')).toBe(true);
    expect(truncate('short')).toBe('short');
  });

  it('computes the distinct ratio over scalar values', () => {
    const { fields } = summarizeCanonicalSample([
      { code: 'a' },
      { code: 'a' },
      { code: 'b' },
      { code: 'c' },
    ]);
    expect(field(fields, 'code').uniqueRatio).toBe(0.75);
  });

  it('caps distinct tracking at 1000 values', () => {
    const documents = Array.from({ length: 1200 }, (_, index) => ({ n: index }));
    const { fields } = summarizeCanonicalSample(documents);
    expect(field(fields, 'n').uniqueRatio).toBeCloseTo(1000 / 1200);
  });

  it('marks id-like fields with nearly distinct values', () => {
    const { fields } = summarizeCanonicalSample([
      { _id: oid('64b7f0c2a1b2c3d4e5f60718'), customerId: 'C1', status: 'paid' },
      { _id: oid('64b7f0c2a1b2c3d4e5f60719'), customerId: 'C2', status: 'paid' },
      { _id: oid('64b7f0c2a1b2c3d4e5f6071a'), customerId: 'C1', status: 'paid' },
    ]);
    expect(field(fields, '_id').isIdLike).toBe(true);
    expect(field(fields, 'customerId').isIdLike).toBe(false);
    expect(field(fields, 'status').isIdLike).toBe(false);
  });

  it('produces fields that pass the field schema', () => {
    const { fields } = summarizeCanonicalSample([
      { _id: oid('64b7f0c2a1b2c3d4e5f60718'), tags: ['a'], at: date('2024-01-01T00:00:00Z') },
    ]);
    for (const item of fields) {
      expect(SchemaFieldSchema.safeParse(item).success).toBe(true);
    }
  });
});
