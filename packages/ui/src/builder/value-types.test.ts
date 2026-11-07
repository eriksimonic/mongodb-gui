import { describe, expect, it } from 'vitest';
import { defaultValueOf, valueTypeOf, VALUE_TYPES } from './value-types';

describe('valueTypeOf', () => {
  it.each([
    ['String', 'String'],
    ['Int32', 'Number'],
    ['Long', 'Number'],
    ['Double', 'Number'],
    ['Decimal128', 'Number'],
    ['Boolean', 'Boolean'],
    ['Null', 'Null'],
    ['Date', 'Date'],
    ['ObjectId', 'ObjectId'],
    ['Regex', 'Regex'],
    ['Array', 'List'],
  ])('maps the BSON type %s to the value type %s', (bson, valueType) => {
    expect(valueTypeOf([bson])).toBe(valueType);
  });

  it('falls back to String for a type with no value type and for no type', () => {
    expect(valueTypeOf(['Object'])).toBe('String');
    expect(valueTypeOf([])).toBe('String');
  });

  it('takes the first name that has a value type, in the order given', () => {
    expect(valueTypeOf(['Binary', 'Date'])).toBe('Date');
    expect(valueTypeOf(['Array', 'String'])).toBe('List');
    expect(valueTypeOf(['String', 'Array'])).toBe('String');
  });

  it('gives a nullable field the type of its value, not Null', () => {
    expect(valueTypeOf(['Null', 'String'])).toBe('String');
    expect(valueTypeOf(['String', 'Null'])).toBe('String');
    expect(valueTypeOf(['Null', 'Array'])).toBe('List');
  });

  it('gives Null only when the field has no other typed name', () => {
    expect(valueTypeOf(['Null'])).toBe('Null');
    expect(valueTypeOf(['Null', 'Object'])).toBe('Null');
  });
});

describe('defaultValueOf', () => {
  it('gives a value of the type for every value type', () => {
    expect(VALUE_TYPES.map((type) => defaultValueOf(type))).toEqual([
      '',
      0,
      false,
      null,
      { $date: expect.any(String) },
      { $oid: '000000000000000000000000' },
      { $regularExpression: { pattern: '(?:)', options: '' } },
      [],
    ]);
  });
});
