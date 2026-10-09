import { describe, expect, it } from 'vitest';
import { coerce, CoercionError, inferType, parseIsoDate } from './infer';

describe('inferType', () => {
  it.each([
    [['1', '-42', '0'], 'int'],
    [['2147483647', '-2147483648'], 'int'],
    [['2147483648'], 'long'],
    [['1', '9007199254740993000'], 'long'],
    [['1.5', '2', '-0.25'], 'double'],
    [['1e3', '2'], 'double'],
    [['true', 'FALSE', 'True'], 'boolean'],
    [['2026-01-02', '2026-01-02T10:00:00Z', '2026-01-02 10:00:00.123+02:00'], 'date'],
    [['64b000000000000000000001'], 'objectId'],
    [['{"a":1}', '[1,2]'], 'json'],
    [['hello', 'world'], 'string'],
  ])('infers the type of %j as %s', (values, expected) => {
    expect(inferType(values)).toBe(expected);
  });

  it('ignores nulls', () => {
    expect(inferType([null, '1', null, '2'])).toBe('int');
  });

  it('falls back to string when there is no non-null value', () => {
    expect(inferType([])).toBe('string');
    expect(inferType([null, null])).toBe('string');
  });

  it('gives string for a mix of unrelated types', () => {
    expect(inferType(['1', 'abc'])).toBe('string');
    expect(inferType(['true', '1'])).toBe('string');
    expect(inferType(['2026-01-01', 'x'])).toBe('string');
  });

  it('treats numbers mixed with decimals as double, and integers beyond int32 as long', () => {
    expect(inferType(['1', '2.5'])).toBe('double');
    expect(inferType(['1', '3000000000'])).toBe('long');
  });

  it('keeps leading-zero codes as strings', () => {
    expect(inferType(['01234', '00001'])).toBe('string');
    expect(inferType(['0.5', '00.5'])).toBe('string');
  });

  it('does not infer a double for integers beyond 2^53', () => {
    expect(inferType(['9007199254740993'])).toBe('long');
    expect(inferType(['9007199254740993', '0.5'])).toBe('string');
  });

  it('refuses an integer beyond int64', () => {
    expect(inferType(['99999999999999999999'])).toBe('string');
  });

  it('gives objectId for 24 hexadecimal characters, even when they are all digits', () => {
    expect(inferType(['123456789012345678901234'])).toBe('objectId');
  });

  it('does not treat a non-parsing JSON-looking value as json', () => {
    expect(inferType(['{not json}'])).toBe('string');
  });

  it('does not infer a date for an impossible calendar day', () => {
    expect(inferType(['2026-02-30'])).toBe('string');
  });
});

describe('coerce', () => {
  it('returns null for a null cell and for the null type', () => {
    expect(coerce(null, 'int')).toEqual({ t: 'null' });
    expect(coerce('anything', 'null')).toEqual({ t: 'null' });
  });

  it('keeps strings as they are', () => {
    expect(coerce(' padded ', 'string')).toEqual({ t: 'string', v: ' padded ' });
  });

  it('coerces int values within the int32 range', () => {
    expect(coerce('-7', 'int')).toEqual({ t: 'int', v: -7 });
    expect(coerce('-0', 'int')).toEqual({ t: 'int', v: 0 });
    expect(() => coerce('2147483648', 'int')).toThrow(CoercionError);
    expect(() => coerce('1.5', 'int')).toThrow(CoercionError);
    expect(() => coerce('01', 'int')).toThrow(CoercionError);
  });

  it('coerces long values as normalised text', () => {
    expect(coerce('-9223372036854775808', 'long')).toEqual({
      t: 'long',
      v: '-9223372036854775808',
    });
    expect(coerce('-0', 'long')).toEqual({ t: 'long', v: '0' });
    expect(() => coerce('9223372036854775808', 'long')).toThrow(CoercionError);
  });

  it('coerces doubles and refuses values a double cannot hold', () => {
    expect(coerce('2.5', 'double')).toEqual({ t: 'double', v: 2.5 });
    expect(coerce('3', 'double')).toEqual({ t: 'double', v: 3 });
    expect(() => coerce('9007199254740993', 'double')).toThrow(CoercionError);
    expect(() => coerce('1e400', 'double')).toThrow(CoercionError);
    expect(() => coerce('NaN', 'double')).toThrow(CoercionError);
  });

  it('coerces decimals as text and refuses non-numbers', () => {
    expect(coerce('1.50', 'decimal')).toEqual({ t: 'decimal', v: '1.50' });
    expect(() => coerce('1,50', 'decimal')).toThrow(CoercionError);
  });

  it('coerces booleans case-insensitively and refuses other words', () => {
    expect(coerce('TRUE', 'boolean')).toEqual({ t: 'boolean', v: true });
    expect(coerce('false', 'boolean')).toEqual({ t: 'boolean', v: false });
    expect(() => coerce('yes', 'boolean')).toThrow(CoercionError);
    expect(() => coerce('1', 'boolean')).toThrow(CoercionError);
  });

  it('coerces ISO dates to epoch milliseconds', () => {
    expect(coerce('2026-01-01T00:00:00Z', 'date')).toEqual({
      t: 'date',
      v: Date.UTC(2026, 0, 1),
    });
    expect(coerce('2026-01-01', 'date')).toEqual({ t: 'date', v: Date.UTC(2026, 0, 1) });
    expect(coerce('2026-01-01T02:30:00+02:30', 'date')).toEqual({
      t: 'date',
      v: Date.UTC(2026, 0, 1),
    });
  });

  it('reads a date-time without an offset as UTC', () => {
    expect(parseIsoDate('2026-06-15T12:00:00')).toBe(Date.UTC(2026, 5, 15, 12));
    expect(parseIsoDate('2026-06-15 12:00')).toBe(Date.UTC(2026, 5, 15, 12));
  });

  it('refuses dates that are malformed, impossible, or finer than a millisecond', () => {
    expect(() => coerce('2026-13-01', 'date')).toThrow(CoercionError);
    expect(() => coerce('2026-02-29', 'date')).toThrow(CoercionError);
    expect(() => coerce('2026-01-01T10:00:00.123456Z', 'date')).toThrow(CoercionError);
    expect(() => coerce('01/02/2026', 'date')).toThrow(CoercionError);
    expect(() => coerce('2026-01-01T24:00:00Z', 'date')).toThrow(CoercionError);
  });

  it('accepts leap days', () => {
    expect(parseIsoDate('2028-02-29')).toBe(Date.UTC(2028, 1, 29));
  });

  it('coerces 24-character hex ObjectIds and refuses others', () => {
    expect(coerce('64B000000000000000000001', 'objectId')).toEqual({
      t: 'objectId',
      v: '64B000000000000000000001',
    });
    expect(() => coerce('64b0000000', 'objectId')).toThrow(CoercionError);
  });

  it('coerces JSON objects and arrays and refuses other text', () => {
    expect(coerce('{"a":[1]}', 'json')).toEqual({ t: 'json', v: '{"a":[1]}' });
    expect(() => coerce('{"a":', 'json')).toThrow(CoercionError);
    expect(() => coerce('plain', 'json')).toThrow(CoercionError);
  });

  it('quotes the offending value in the error message and shortens long values', () => {
    expect(() => coerce('abc', 'int')).toThrow('"abc" is not a 32-bit integer');
    expect(() => coerce('x'.repeat(100), 'int')).toThrow(/^"x{60}\.\.\." is not/);
  });
});
