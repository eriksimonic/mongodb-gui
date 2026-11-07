import { describe, expect, it } from 'vitest';
import { operatorsForTypes } from './operators';

describe('operatorsForTypes', () => {
  it('gives a string field the ordered comparisons and regex', () => {
    expect(operatorsForTypes(['String'])).toEqual([
      'eq',
      'ne',
      'gt',
      'gte',
      'lt',
      'lte',
      'in',
      'nin',
      'exists',
      'type',
      'regex',
    ]);
  });

  it('gives every numeric type the ordered comparisons and no regex or array operators', () => {
    for (const type of ['Int32', 'Long', 'Double', 'Decimal128']) {
      const operators = operatorsForTypes([type]);
      expect(operators).toContain('gt');
      expect(operators).toContain('lte');
      expect(operators).not.toContain('regex');
      expect(operators).not.toContain('size');
    }
  });

  it('gives a date field the ordered comparisons and no regex', () => {
    const operators = operatorsForTypes(['Date']);
    expect(operators).toContain('gte');
    expect(operators).toContain('lt');
    expect(operators).not.toContain('regex');
  });

  it('gives a boolean field only the common operators', () => {
    expect(operatorsForTypes(['Boolean'])).toEqual(['eq', 'ne', 'in', 'nin', 'exists', 'type']);
  });

  it('adds size, all and elemMatch to an array field', () => {
    expect(operatorsForTypes(['Array'])).toEqual([
      'eq',
      'ne',
      'in',
      'nin',
      'exists',
      'type',
      'size',
      'all',
      'elemMatch',
    ]);
  });

  it('merges the operators of every type of a mixed field', () => {
    const operators = operatorsForTypes(['Array', 'String']);
    expect(operators).toContain('regex');
    expect(operators).toContain('size');
    expect(operators).toContain('gt');
  });

  it('gives an unknown type or no type only the common operators', () => {
    expect(operatorsForTypes(['Object'])).toEqual(['eq', 'ne', 'in', 'nin', 'exists', 'type']);
    expect(operatorsForTypes(['Other'])).toEqual(['eq', 'ne', 'in', 'nin', 'exists', 'type']);
    expect(operatorsForTypes([])).toEqual(['eq', 'ne', 'in', 'nin', 'exists', 'type']);
  });
});
