import {
  ARRAY_ELEMENT_FIELD,
  CONDITION_OPERATORS,
  type FieldInfo,
  type QueryCondition,
  type QueryItem,
} from '@mongo-gui/core';
import { describe, expect, it } from 'vitest';
import {
  conditionFor,
  elemMatchScope,
  newCondition,
  operatorsFor,
  mongoshText,
  regexValueOf,
  valueTypeOfValue,
  valueTypeFor,
} from './condition-model';

const fields: FieldInfo[] = [
  { path: 'name', types: ['String'] },
  { path: 'price', types: ['Double'] },
  { path: 'tags', types: ['Array', 'String'] },
  { path: 'items', types: ['Array'] },
  { path: 'items.sku', types: ['String'] },
  { path: 'items.qty', types: ['Int32'] },
  { path: 'items.tags', types: ['Array', 'String'] },
];

const eqPrice: QueryCondition = {
  kind: 'condition',
  enabled: true,
  field: 'price',
  operator: 'eq',
  value: 5,
};

describe('operatorsFor', () => {
  it('uses the operators of the field types', () => {
    expect(operatorsFor(fields, 'name', false, [])).toEqual(
      expect.arrayContaining(['eq', 'regex', 'gt']),
    );
    expect(operatorsFor(fields, 'tags', false, [])).toEqual(
      expect.arrayContaining(['size', 'all', 'elemMatch']),
    );
  });

  it('offers every operator for a field that is not in the list', () => {
    expect(operatorsFor(fields, 'typed.name', false, [])).toEqual(CONDITION_OPERATORS);
  });

  it('drops elemMatch and the taken operators in a scalar group', () => {
    const scope = [{ path: ARRAY_ELEMENT_FIELD, types: ['String'] }];
    const allowed = operatorsFor(scope, ARRAY_ELEMENT_FIELD, true, ['eq', 'regex']);
    expect(allowed).not.toContain('eq');
    expect(allowed).not.toContain('regex');
    expect(allowed).not.toContain('elemMatch');
    expect(allowed).toContain('ne');
  });
});

describe('elemMatchScope', () => {
  it('gives an array of scalars one element field with the element types', () => {
    expect(elemMatchScope(fields, 'tags', [])).toEqual({
      scalarElement: true,
      fields: [{ path: ARRAY_ELEMENT_FIELD, types: ['String'] }],
    });
  });

  it('gives an array of objects the child fields with relative names', () => {
    expect(elemMatchScope(fields, 'items', [])).toEqual({
      scalarElement: false,
      fields: [
        { path: 'sku', types: ['String'] },
        { path: 'qty', types: ['Int32'] },
        { path: 'tags', types: ['Array', 'String'] },
      ],
    });
  });

  it('keeps a group with an element condition scalar, whatever the sample says', () => {
    const element: QueryItem = {
      kind: 'condition',
      enabled: true,
      field: ARRAY_ELEMENT_FIELD,
      operator: 'eq',
      value: 'a',
    };
    expect(elemMatchScope(fields, 'items', [element]).scalarElement).toBe(true);
  });

  it('does not make an array scalar when its element type is unknown', () => {
    expect(elemMatchScope(fields, 'unknown', []).scalarElement).toBe(false);
  });
});

describe('conditionFor', () => {
  it('keeps the value when the operator changes to one of the same type', () => {
    const next = conditionFor(eqPrice, 'price', 'ne', fields, true);
    expect(next).toEqual({ ...eqPrice, operator: 'ne', value: 5 });
  });

  it('starts with the default value of the operator when the type changes', () => {
    expect(conditionFor(eqPrice, 'price', 'in', fields, false)).toEqual({
      ...eqPrice,
      operator: 'in',
      value: [],
    });
    expect(conditionFor(eqPrice, 'price', 'exists', fields, false)).toEqual({
      ...eqPrice,
      operator: 'exists',
      value: true,
    });
  });

  it('starts an elemMatch on a scalar array with one element condition', () => {
    const tags: QueryCondition = { ...eqPrice, field: 'tags', operator: 'eq', value: 'x' };
    expect(conditionFor(tags, 'tags', 'elemMatch', fields, false)).toEqual({
      kind: 'condition',
      enabled: true,
      field: 'tags',
      operator: 'elemMatch',
      group: {
        kind: 'group',
        operator: 'and',
        items: [
          {
            kind: 'condition',
            enabled: true,
            field: ARRAY_ELEMENT_FIELD,
            operator: 'eq',
            value: '',
          },
        ],
      },
    });
  });

  it('starts an elemMatch on an array of objects with an empty group', () => {
    const items: QueryCondition = { ...eqPrice, field: 'items', operator: 'eq', value: '' };
    expect(conditionFor(items, 'items', 'elemMatch', fields, false)).toMatchObject({
      operator: 'elemMatch',
      group: { kind: 'group', operator: 'and', items: [] },
    });
  });

  it('keeps the group of an elemMatch when the field changes', () => {
    const group = { kind: 'group' as const, operator: 'and' as const, items: [] };
    const match: QueryCondition = {
      kind: 'condition',
      enabled: true,
      field: 'items',
      operator: 'elemMatch',
      group,
    };
    expect(conditionFor(match, 'items.tags', 'elemMatch', fields, false)).toMatchObject({
      field: 'items.tags',
      group,
    });
  });
});

describe('newCondition', () => {
  it('has no field outside a scalar group', () => {
    expect(newCondition(fields, false, [])).toEqual({
      kind: 'condition',
      enabled: true,
      field: '',
      operator: 'eq',
      value: '',
    });
  });

  it('uses the first operator a scalar group still allows', () => {
    const scope = [{ path: ARRAY_ELEMENT_FIELD, types: ['String'] }];
    expect(newCondition(scope, true, ['eq'])).toMatchObject({
      field: ARRAY_ELEMENT_FIELD,
      operator: 'ne',
    });
  });

  it('returns nothing when a scalar group has no operator left', () => {
    const scope = [{ path: ARRAY_ELEMENT_FIELD, types: ['String'] }];
    expect(newCondition(scope, true, [...CONDITION_OPERATORS])).toBeUndefined();
  });
});

describe('valueTypeFor', () => {
  it('gives the list, boolean, regex and number operators their own value type', () => {
    expect(valueTypeFor('nin', ['String'])).toBe('List');
    expect(valueTypeFor('exists', ['String'])).toBe('Boolean');
    expect(valueTypeFor('regex', ['String'])).toBe('Regex');
    expect(valueTypeFor('size', ['Array'])).toBe('Number');
    expect(valueTypeFor('gt', ['Date'])).toBe('Date');
  });
});

describe('valueTypeOfValue', () => {
  it.each([
    [5, 'Number'],
    [true, 'Boolean'],
    [null, 'Null'],
    ['abc', 'String'],
    [[1, 2], 'List'],
    [{ $oid: '64b7f1e2c3d4a5b6c7d8e9f0' }, 'ObjectId'],
    [{ $date: '2026-01-01T00:00:00.000Z' }, 'Date'],
    [{ $regularExpression: { pattern: 'ab', options: '' } }, 'Regex'],
    [{ $numberDecimal: '1.50' }, 'String'],
    [{ a: 1 }, 'String'],
  ])('shows %j as %s', (value, type) => {
    expect(valueTypeOfValue(value)).toBe(type);
  });
});

describe('regexValueOf and mongoshText', () => {
  it('reads a $regularExpression value and rejects any other value', () => {
    expect(regexValueOf({ $regularExpression: { pattern: 'ab', options: 'i' } })).toEqual({
      pattern: 'ab',
      options: 'i',
    });
    expect(regexValueOf('ab')).toBeUndefined();
  });

  it('writes a new regex with a pattern that is not empty', () => {
    const next = conditionFor(eqPrice, 'name', 'regex', fields, false);
    expect(next).toMatchObject({ operator: 'regex', pattern: '(?:)', options: '' });
    expect(mongoshText({ $regularExpression: { pattern: 'ab', options: 'i' } })).toBe('/ab/i');
  });
});
