import { describe, expect, it } from 'vitest';
import {
  asArray,
  asBoolean,
  asRecord,
  asString,
  definedFields,
  fieldNames,
  isRawRecord,
  readNumber,
  readStringMap,
} from './raw-values';

describe('isRawRecord and asRecord', () => {
  it('accepts plain objects only', () => {
    expect(isRawRecord({ a: 1 })).toBe(true);
    expect(isRawRecord([])).toBe(false);
    expect(isRawRecord(null)).toBe(false);
    expect(isRawRecord('x')).toBe(false);
    expect(asRecord({ a: 1 })).toEqual({ a: 1 });
    expect(asRecord([1])).toBeUndefined();
  });
});

describe('asArray, asString and asBoolean', () => {
  it('narrow to their own type or to undefined', () => {
    expect(asArray([1])).toEqual([1]);
    expect(asArray({})).toBeUndefined();
    expect(asString('a')).toBe('a');
    expect(asString(1)).toBeUndefined();
    expect(asBoolean(false)).toBe(false);
    expect(asBoolean('false')).toBeUndefined();
  });
});

describe('readNumber', () => {
  it.each([
    [5, 5],
    [0, 0],
    [-1.5, -1.5],
    [{ $numberInt: '5' }, 5],
    [{ $numberLong: '9007199254740991' }, 9007199254740991],
    [{ $numberDouble: '2.5' }, 2.5],
    [{ $numberDecimal: '3.25' }, 3.25],
  ])('reads %j as %j', (input, expected) => {
    expect(readNumber(input)).toBe(expected);
  });

  it.each([
    ['text'],
    [null],
    [undefined],
    [Number.NaN],
    [Number.POSITIVE_INFINITY],
    [{ $numberDouble: 'NaN' }],
    [{ $numberInt: 'x' }],
    [{ $numberInt: 5 }],
    [{ $numberInt: '1', extra: 2 }],
    [{ $date: '2026-01-01' }],
    [[5]],
  ])('does not read %j', (input) => {
    expect(readNumber(input)).toBeUndefined();
  });
});

describe('readStringMap', () => {
  it('keeps string arrays and turns other items into strings', () => {
    expect(readStringMap({ a: ['[1, 2]'], b: [1, 'x'] })).toEqual({ a: ['[1, 2]'], b: ['1', 'x'] });
  });

  it('gives an empty array for a field whose value is not an array', () => {
    expect(readStringMap({ a: 'nope' })).toEqual({ a: [] });
  });

  it('returns undefined for a value that is not an object', () => {
    expect(readStringMap(['a'])).toBeUndefined();
    expect(readStringMap(null)).toBeUndefined();
  });
});

describe('fieldNames', () => {
  it('lists the keys of an object in order, and nothing for other values', () => {
    expect(fieldNames({ b: 1, a: -1 })).toEqual(['b', 'a']);
    expect(fieldNames('x')).toEqual([]);
  });
});

describe('definedFields', () => {
  it('drops fields whose value is undefined and keeps the others', () => {
    const fields: { a: number | undefined; b: string | undefined; c: boolean } = {
      a: 1,
      b: undefined,
      c: false,
    };
    const result = definedFields(fields);
    expect(result).toEqual({ a: 1, c: false });
    expect(Object.keys(result)).toEqual(['a', 'c']);
  });
});
