import { describe, expect, it } from 'vitest';
import { valueTypeOf } from './value-types';

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
});
