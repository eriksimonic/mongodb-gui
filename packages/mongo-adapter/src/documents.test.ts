import { describe, expect, it } from 'vitest';
import {
  definedEntry,
  hasKey,
  readArray,
  readBoolean,
  readDate,
  readNumber,
  readRecord,
  readString,
  readStringArray,
} from './documents';

describe('document readers', () => {
  const source: unknown = {
    name: 'orders',
    count: 50,
    big: BigInt(7),
    nan: Number.NaN,
    capped: false,
    since: new Date('2026-01-01T00:00:00Z'),
    options: { viewOn: 'orders' },
    hosts: ['a:27017', 3],
  };

  it('reads values of the expected type', () => {
    expect(readString(source, 'name')).toBe('orders');
    expect(readNumber(source, 'count')).toBe(50);
    expect(readNumber(source, 'big')).toBe(7);
    expect(readBoolean(source, 'capped')).toBe(false);
    expect(readDate(source, 'since')).toEqual(new Date('2026-01-01T00:00:00Z'));
    expect(readRecord(source, 'options')).toEqual({ viewOn: 'orders' });
    expect(readArray(source, 'hosts')).toEqual(['a:27017', 3]);
    expect(readStringArray(source, 'hosts')).toEqual(['a:27017']);
  });

  it('returns undefined or an empty array for missing or wrongly typed values', () => {
    expect(readString(source, 'count')).toBeUndefined();
    expect(readNumber(source, 'nan')).toBeUndefined();
    expect(readNumber(source, 'missing')).toBeUndefined();
    expect(readBoolean(source, 'name')).toBeUndefined();
    expect(readDate(source, 'name')).toBeUndefined();
    expect(readRecord(source, 'hosts')).toBeUndefined();
    expect(readArray(source, 'missing')).toEqual([]);
  });

  it('reads nothing from a value that is not an object', () => {
    expect(readString(undefined, 'name')).toBeUndefined();
    expect(readRecord(['x'], 'name')).toBeUndefined();
    expect(hasKey(null, 'name')).toBe(false);
  });

  it('reports whether a key holds a value', () => {
    expect(hasKey(source, 'name')).toBe(true);
    expect(hasKey(source, 'missing')).toBe(false);
  });

  it('builds an entry only when the value is defined', () => {
    expect(definedEntry('size', 3)).toEqual({ size: 3 });
    expect(Object.keys(definedEntry('size', undefined))).toEqual([]);
  });
});
