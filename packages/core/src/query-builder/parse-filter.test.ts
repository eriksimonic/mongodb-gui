import { describe, expect, it } from 'vitest';
import { ARRAY_ELEMENT_FIELD, type QueryItem } from './model';
import { filterFromEjson } from './parse-filter';

const OBJECT_ID_HEX = '65a1b2c3d4e5f60718293a4b';

function itemsOf(filter: Record<string, unknown>): readonly QueryItem[] {
  return filterFromEjson(filter).items;
}

function eq(field: string, value: unknown) {
  return { kind: 'condition', enabled: true, field, operator: 'eq', value };
}

function raw(field: string, operator: string, value: unknown) {
  return { kind: 'rawCondition', enabled: true, field, operator, value };
}

describe('filterFromEjson', () => {
  describe('plain values', () => {
    it('reads an empty filter as an empty AND group', () => {
      expect(filterFromEjson({})).toEqual({ kind: 'group', operator: 'and', items: [] });
    });

    it('reads each plain value as an eq condition', () => {
      expect(itemsOf({ a: 1, b: 'x', c: null, d: true, e: [1, 2] })).toEqual([
        eq('a', 1),
        eq('b', 'x'),
        eq('c', null),
        eq('d', true),
        eq('e', [1, 2]),
      ]);
    });

    it.each([
      ['$oid', { $oid: OBJECT_ID_HEX }],
      ['$date', { $date: { $numberLong: '1767225600000' } }],
      ['$numberInt', { $numberInt: '5' }],
      ['$numberLong', { $numberLong: '5' }],
      ['$numberDecimal', { $numberDecimal: '1.5' }],
      ['$regularExpression', { $regularExpression: { pattern: '^a', options: 'i' } }],
      ['$minKey', { $minKey: 1 }],
    ])('keeps the %s wrapper as an eq value', (_name, value) => {
      expect(itemsOf({ f: value })).toEqual([eq('f', value)]);
    });

    it('keeps a subdocument, an empty object and an array of operator objects as eq values', () => {
      expect(itemsOf({ s: { a: 1 }, e: {}, arr: [{ $gt: 2 }] })).toEqual([
        eq('s', { a: 1 }),
        eq('e', {}),
        eq('arr', [{ $gt: 2 }]),
      ]);
    });

    it('treats an object with a key that is not an operator as one eq value', () => {
      expect(itemsOf({ m: { $gt: 1, a: 2 } })).toEqual([eq('m', { $gt: 1, a: 2 })]);
    });
  });

  describe('operators', () => {
    it.each([
      ['$eq', 'eq', 7],
      ['$ne', 'ne', 7],
      ['$gt', 'gt', 1],
      ['$gte', 'gte', 1],
      ['$lt', 'lt', 1],
      ['$lte', 'lte', 1],
      ['$in', 'in', [1, 2]],
      ['$nin', 'nin', [1, 2]],
      ['$exists', 'exists', true],
      ['$type', 'type', 'string'],
      ['$size', 'size', 2],
      ['$all', 'all', ['a', 'b']],
    ])('reads %s as a %s condition', (mongo, operator, value) => {
      expect(itemsOf({ f: { [mongo]: value } })).toEqual([
        { kind: 'condition', enabled: true, field: 'f', operator, value },
      ]);
    });

    it('reads $regex with $options as a regex condition', () => {
      expect(itemsOf({ name: { $regex: '^a', $options: 'i' } })).toEqual([
        {
          kind: 'condition',
          enabled: true,
          field: 'name',
          operator: 'regex',
          pattern: '^a',
          options: 'i',
        },
      ]);
    });

    it('reads $regex without $options as a regex with empty options', () => {
      expect(itemsOf({ name: { $regex: '^a' } })).toEqual([
        {
          kind: 'condition',
          enabled: true,
          field: 'name',
          operator: 'regex',
          pattern: '^a',
          options: '',
        },
      ]);
    });

    it('reads $regex with a non-string pattern as raw items', () => {
      expect(itemsOf({ f: { $regex: 5, $options: 'i' } })).toEqual([
        raw('f', '$regex', 5),
        raw('f', '$options', 'i'),
      ]);
    });

    it('reads $options without $regex as a raw condition', () => {
      expect(itemsOf({ f: { $options: 'i' } })).toEqual([raw('f', '$options', 'i')]);
    });

    it('reads the operators of one field in key order', () => {
      expect(itemsOf({ f: { $gt: 1, $lt: 5, $ne: 3 } })).toEqual([
        { kind: 'condition', enabled: true, field: 'f', operator: 'gt', value: 1 },
        { kind: 'condition', enabled: true, field: 'f', operator: 'lt', value: 5 },
        { kind: 'condition', enabled: true, field: 'f', operator: 'ne', value: 3 },
      ]);
    });

    it.each([
      [{ f: { $not: { $gt: 1 } } }, [raw('f', '$not', { $gt: 1 })]],
      [{ f: { $mod: [4, 0] } }, [raw('f', '$mod', [4, 0])]],
      [
        {
          p: {
            $geoWithin: {
              $box: [
                [0, 0],
                [1, 1],
              ],
            },
          },
        },
        [
          raw('p', '$geoWithin', {
            $box: [
              [0, 0],
              [1, 1],
            ],
          }),
        ],
      ],
    ])('reads an unknown field operator as a raw condition: %j', (filter, expected) => {
      expect(itemsOf(filter)).toEqual(expected);
    });

    it('reads $elemMatch with a non-object value as a raw condition', () => {
      expect(itemsOf({ f: { $elemMatch: 5 } })).toEqual([raw('f', '$elemMatch', 5)]);
    });
  });

  describe('elemMatch', () => {
    it('reads operators on an array of scalars on the array element field', () => {
      expect(itemsOf({ arr: { $elemMatch: { $gt: 1, $lt: 5 } } })).toEqual([
        {
          kind: 'condition',
          enabled: true,
          field: 'arr',
          operator: 'elemMatch',
          group: {
            kind: 'group',
            operator: 'and',
            items: [
              {
                kind: 'condition',
                enabled: true,
                field: ARRAY_ELEMENT_FIELD,
                operator: 'gt',
                value: 1,
              },
              {
                kind: 'condition',
                enabled: true,
                field: ARRAY_ELEMENT_FIELD,
                operator: 'lt',
                value: 5,
              },
            ],
          },
        },
      ]);
    });

    it('reads a regex on an array of scalars on the array element field', () => {
      expect(itemsOf({ tags: { $elemMatch: { $regex: '^a', $options: 'i' } } })).toEqual([
        {
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
                operator: 'regex',
                pattern: '^a',
                options: 'i',
              },
            ],
          },
        },
      ]);
    });

    it('reads the fields of an array of objects inside the group', () => {
      expect(itemsOf({ items: { $elemMatch: { sku: 'x', qty: { $gt: 2 } } } })).toEqual([
        {
          kind: 'condition',
          enabled: true,
          field: 'items',
          operator: 'elemMatch',
          group: {
            kind: 'group',
            operator: 'and',
            items: [
              eq('sku', 'x'),
              { kind: 'condition', enabled: true, field: 'qty', operator: 'gt', value: 2 },
            ],
          },
        },
      ]);
    });

    it('reads a nested $or inside an object elemMatch', () => {
      expect(itemsOf({ items: { $elemMatch: { $or: [{ a: 1 }, { b: 2 }] } } })).toEqual([
        {
          kind: 'condition',
          enabled: true,
          field: 'items',
          operator: 'elemMatch',
          group: {
            kind: 'group',
            operator: 'and',
            items: [
              {
                kind: 'group',
                operator: 'or',
                items: [
                  { kind: 'group', operator: 'and', items: [eq('a', 1)] },
                  { kind: 'group', operator: 'and', items: [eq('b', 2)] },
                ],
              },
            ],
          },
        },
      ]);
    });

    it('reads $and inside an object elemMatch as fields of the element', () => {
      expect(itemsOf({ items: { $elemMatch: { $and: [{ a: 1 }] } } })).toEqual([
        {
          kind: 'condition',
          enabled: true,
          field: 'items',
          operator: 'elemMatch',
          group: { kind: 'group', operator: 'and', items: [eq('a', 1)] },
        },
      ]);
    });

    it('reads a body with a field operator and a logical key as the scalar form', () => {
      expect(itemsOf({ items: { $elemMatch: { $gt: 1, $and: [{ a: 1 }] } } })).toEqual([
        {
          kind: 'condition',
          enabled: true,
          field: 'items',
          operator: 'elemMatch',
          group: {
            kind: 'group',
            operator: 'and',
            items: [
              {
                kind: 'condition',
                enabled: true,
                field: ARRAY_ELEMENT_FIELD,
                operator: 'gt',
                value: 1,
              },
              raw(ARRAY_ELEMENT_FIELD, '$and', [{ a: 1 }]),
            ],
          },
        },
      ]);
    });

    it('reads an empty elemMatch as an empty group', () => {
      expect(itemsOf({ items: { $elemMatch: {} } })).toEqual([
        {
          kind: 'condition',
          enabled: true,
          field: 'items',
          operator: 'elemMatch',
          group: { kind: 'group', operator: 'and', items: [] },
        },
      ]);
    });
  });

  describe('logical keys', () => {
    it('reads each $or child as an AND group', () => {
      expect(itemsOf({ $or: [{ a: 1, b: { $gt: 2 } }, { c: 3 }] })).toEqual([
        {
          kind: 'group',
          operator: 'or',
          items: [
            {
              kind: 'group',
              operator: 'and',
              items: [
                eq('a', 1),
                { kind: 'condition', enabled: true, field: 'b', operator: 'gt', value: 2 },
              ],
            },
            { kind: 'group', operator: 'and', items: [eq('c', 3)] },
          ],
        },
      ]);
    });

    it('reads $nor like $or', () => {
      expect(itemsOf({ $nor: [{ a: 1 }] })).toEqual([
        {
          kind: 'group',
          operator: 'nor',
          items: [{ kind: 'group', operator: 'and', items: [eq('a', 1)] }],
        },
      ]);
    });

    it('splices $and children into the enclosing group', () => {
      expect(itemsOf({ a: 1, $and: [{ b: 2 }, { c: 3 }] })).toEqual([
        eq('a', 1),
        eq('b', 2),
        eq('c', 3),
      ]);
    });

    it('reads an overflow entry in $and as a condition of the parent group', () => {
      expect(itemsOf({ n: { $lt: 2 }, $and: [{ n: { $gt: 5 } }] })).toEqual([
        { kind: 'condition', enabled: true, field: 'n', operator: 'lt', value: 2 },
        { kind: 'condition', enabled: true, field: 'n', operator: 'gt', value: 5 },
      ]);
    });

    it('reads an empty object in $or as an empty AND group', () => {
      expect(itemsOf({ $or: [{}] })).toEqual([
        {
          kind: 'group',
          operator: 'or',
          items: [{ kind: 'group', operator: 'and', items: [] }],
        },
      ]);
    });

    it('keeps the order of top-level keys', () => {
      expect(itemsOf({ $expr: { $gt: ['$a', '$b'] }, a: 1, $or: [{ b: 1 }] })).toEqual([
        { kind: 'rawFragment', enabled: true, key: '$expr', value: { $gt: ['$a', '$b'] } },
        eq('a', 1),
        {
          kind: 'group',
          operator: 'or',
          items: [{ kind: 'group', operator: 'and', items: [eq('b', 1)] }],
        },
      ]);
    });

    it('reads a raw fragment inside an $or child', () => {
      expect(itemsOf({ $or: [{ $expr: {} }] })).toEqual([
        {
          kind: 'group',
          operator: 'or',
          items: [
            {
              kind: 'group',
              operator: 'and',
              items: [{ kind: 'rawFragment', enabled: true, key: '$expr', value: {} }],
            },
          ],
        },
      ]);
    });
  });

  describe('raw fragments', () => {
    it.each([
      ['$expr', { $gt: ['$a', '$b'] }],
      ['$text', { $search: 'coffee' }],
      ['$where', 'this.a > 1'],
      ['$jsonSchema', { required: ['a'] }],
    ])('reads top-level %s as a raw fragment', (key, value) => {
      expect(itemsOf({ [key]: value })).toEqual([
        { kind: 'rawFragment', enabled: true, key, value },
      ]);
    });

    it.each([
      ['$or', []],
      ['$or', 5],
      ['$or', [1]],
      ['$and', { a: 1 }],
      ['$nor', [[{ a: 1 }]]],
    ])('reads a malformed %s value as a raw fragment: %j', (key, value) => {
      expect(itemsOf({ [key]: value })).toEqual([
        { kind: 'rawFragment', enabled: true, key, value },
      ]);
    });
  });
});
