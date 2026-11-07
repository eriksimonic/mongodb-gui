import { describe, expect, it } from 'vitest';
import { emitFilter, filterToEjson } from './emit-filter';
import {
  ARRAY_ELEMENT_FIELD,
  type ElemMatchCondition,
  type GroupOperator,
  type QueryGroup,
  type QueryItem,
  type RawCondition,
  type RawFragment,
  type RegexCondition,
  type ValueCondition,
} from './model';

// Builders. Every item is enabled unless a test passes false.

function cond(
  field: string,
  operator: ValueCondition['operator'],
  value: unknown,
  enabled = true,
): ValueCondition {
  return { kind: 'condition', enabled, field, operator, value };
}

function regex(field: string, pattern: string, options: string): RegexCondition {
  return { kind: 'condition', enabled: true, field, operator: 'regex', pattern, options };
}

function elemMatch(field: string, group: QueryGroup): ElemMatchCondition {
  return { kind: 'condition', enabled: true, field, operator: 'elemMatch', group };
}

function raw(field: string, operator: string, value: unknown, enabled = true): RawCondition {
  return { kind: 'rawCondition', enabled, field, operator, value };
}

function fragment(key: string, value: unknown, enabled = true): RawFragment {
  return { kind: 'rawFragment', enabled, key, value };
}

function group(operator: GroupOperator, ...items: QueryItem[]): QueryGroup {
  return { kind: 'group', operator, items };
}

describe('filterToEjson', () => {
  it('joins the top-level items with AND and writes eq as a plain value', () => {
    const filter = group('and', cond('a', 'eq', 1), cond('b', 'gt', 2));

    expect(filterToEjson(filter)).toEqual({ a: 1, b: { $gt: 2 } });
  });

  it('writes each value operator under its name', () => {
    const filter = group(
      'and',
      cond('a', 'lte', 1),
      cond('b', 'in', [1, 2]),
      cond('c', 'nin', [3]),
      cond('d', 'exists', true),
      cond('e', 'type', 'string'),
      cond('f', 'size', 2),
      cond('g', 'all', [1, 2]),
    );

    expect(filterToEjson(filter)).toEqual({
      a: { $lte: 1 },
      b: { $in: [1, 2] },
      c: { $nin: [3] },
      d: { $exists: true },
      e: { $type: 'string' },
      f: { $size: 2 },
      g: { $all: [1, 2] },
    });
  });

  it('writes an eq whose value is an operator object as $eq', () => {
    const filter = group('and', cond('a', 'eq', { $gt: 1 }));

    expect(filterToEjson(filter)).toEqual({ a: { $eq: { $gt: 1 } } });
  });

  it('writes an eq whose value is an EJSON wrapper as a plain value', () => {
    const oid = { $oid: '65a1b2c3d4e5f60718293a4b' };
    const filter = group('and', cond('a', 'eq', oid));

    expect(filterToEjson(filter)).toEqual({ a: oid });
  });

  it('writes ne alone as $ne', () => {
    const filter = group('and', cond('a', 'ne', 1));

    expect(filterToEjson(filter)).toEqual({ a: { $ne: 1 } });
  });

  it('merges several operators on one field into one operator object', () => {
    const filter = group('and', cond('n', 'gt', 1), cond('n', 'lt', 5));

    expect(filterToEjson(filter)).toEqual({ n: { $gt: 1, $lt: 5 } });
  });

  it('writes eq as $eq when the field has another operator', () => {
    const filter = group('and', cond('n', 'eq', 1), cond('n', 'ne', 3));

    expect(filterToEjson(filter)).toEqual({ n: { $eq: 1, $ne: 3 } });
  });

  it('writes two eq on one field as $eq, the second one in $and', () => {
    const filter = group('and', cond('n', 'eq', 1), cond('n', 'eq', 2));

    expect(filterToEjson(filter)).toEqual({ n: { $eq: 1 }, $and: [{ n: { $eq: 2 } }] });
  });

  it('writes a regex with its options', () => {
    const filter = group('and', regex('name', '^a', 'i'));

    expect(filterToEjson(filter)).toEqual({ name: { $regex: '^a', $options: 'i' } });
  });

  it('writes a regex without options as $regex alone', () => {
    const filter = group('and', regex('name', '^a', ''));

    expect(filterToEjson(filter)).toEqual({ name: { $regex: '^a' } });
  });

  it('moves a second regex with options into $and whole', () => {
    const filter = group('and', regex('n', 'a', 'i'), regex('n', 'b', 'm'));

    expect(filterToEjson(filter)).toEqual({
      n: { $regex: 'a', $options: 'i' },
      $and: [{ n: { $regex: 'b', $options: 'm' } }],
    });
  });

  it('moves a second regex without options into $and whole, keeping the first options', () => {
    const filter = group('and', regex('n', 'a', 'i'), regex('n', 'b', ''));

    expect(filterToEjson(filter)).toEqual({
      n: { $regex: 'a', $options: 'i' },
      $and: [{ n: { $regex: 'b' } }],
    });
  });

  it('keeps a regex without options and moves a second regex with options into $and', () => {
    const filter = group('and', regex('n', 'a', ''), regex('n', 'b', 'i'));

    expect(filterToEjson(filter)).toEqual({
      n: { $regex: 'a' },
      $and: [{ n: { $regex: 'b', $options: 'i' } }],
    });
  });

  it('nests OR and NOR groups inside an AND group', () => {
    const filter = group(
      'and',
      cond('a', 'eq', 1),
      group(
        'or',
        group('and', cond('b', 'eq', 2), cond('c', 'eq', 3)),
        group('nor', cond('d', 'eq', 4)),
      ),
    );

    expect(filterToEjson(filter)).toEqual({
      a: 1,
      $or: [{ b: 2, c: 3 }, { $nor: [{ d: 4 }] }],
    });
  });

  it('writes a top-level OR as an $or array', () => {
    const filter = group('or', cond('a', 'eq', 1), cond('b', 'eq', 2));

    expect(filterToEjson(filter)).toEqual({ $or: [{ a: 1 }, { b: 2 }] });
  });

  it('writes a top-level NOR with one item as a one-element $nor array', () => {
    const filter = group('nor', cond('a', 'eq', 1));

    expect(filterToEjson(filter)).toEqual({ $nor: [{ a: 1 }] });
  });

  it('flattens a nested AND group into its parent', () => {
    const filter = group(
      'and',
      cond('a', 'eq', 1),
      group('and', cond('b', 'eq', 2), group('and', cond('c', 'gt', 3))),
    );

    expect(filterToEjson(filter)).toEqual({ a: 1, b: 2, c: { $gt: 3 } });
  });

  it('merges a flattened AND group into the operators of its parent field', () => {
    const filter = group('and', cond('a', 'gt', 1), group('and', cond('a', 'lt', 5)));

    expect(filterToEjson(filter)).toEqual({ a: { $gt: 1, $lt: 5 } });
  });

  it('flattens a nested AND group inside an OR element', () => {
    const filter = group('or', group('and', group('and', cond('b', 'eq', 2), cond('c', 'eq', 3))));

    expect(filterToEjson(filter)).toEqual({ $or: [{ b: 2, c: 3 }] });
  });

  it('writes an elemMatch on an array of scalars with the array element as operators', () => {
    const filter = group(
      'and',
      elemMatch(
        'tags',
        group('and', cond(ARRAY_ELEMENT_FIELD, 'gt', 1), cond(ARRAY_ELEMENT_FIELD, 'lt', 5)),
      ),
    );

    expect(filterToEjson(filter)).toEqual({ tags: { $elemMatch: { $gt: 1, $lt: 5 } } });
  });

  it('keeps the first condition of each operator in a scalar elemMatch', () => {
    const filter = group(
      'and',
      elemMatch(
        'tags',
        group(
          'and',
          cond(ARRAY_ELEMENT_FIELD, 'gt', 1),
          cond(ARRAY_ELEMENT_FIELD, 'gt', 3),
          cond(ARRAY_ELEMENT_FIELD, 'lt', 5),
        ),
      ),
    );

    expect(filterToEjson(filter)).toEqual({ tags: { $elemMatch: { $gt: 1, $lt: 5 } } });
  });

  it('skips nested groups in a scalar elemMatch', () => {
    const filter = group(
      'and',
      elemMatch(
        'tags',
        group(
          'and',
          cond(ARRAY_ELEMENT_FIELD, 'gt', 1),
          group('or', cond(ARRAY_ELEMENT_FIELD, 'lt', 0), cond(ARRAY_ELEMENT_FIELD, 'ne', 2)),
          group('and', cond(ARRAY_ELEMENT_FIELD, 'lt', 5)),
        ),
      ),
    );

    expect(filterToEjson(filter)).toEqual({ tags: { $elemMatch: { $gt: 1 } } });
  });

  it('keeps the first regex of a scalar elemMatch whole', () => {
    const filter = group(
      'and',
      elemMatch(
        'tags',
        group('and', regex(ARRAY_ELEMENT_FIELD, 'a', 'i'), regex(ARRAY_ELEMENT_FIELD, 'b', 'm')),
      ),
    );

    expect(filterToEjson(filter)).toEqual({
      tags: { $elemMatch: { $regex: 'a', $options: 'i' } },
    });
  });

  it('leaves out a disabled condition in a scalar elemMatch', () => {
    const filter = group(
      'and',
      elemMatch(
        'tags',
        group('and', cond(ARRAY_ELEMENT_FIELD, 'gt', 1), cond(ARRAY_ELEMENT_FIELD, 'lt', 5, false)),
      ),
    );

    expect(filterToEjson(filter)).toEqual({ tags: { $elemMatch: { $gt: 1 } } });
  });

  it('keeps an elemMatch whose body has no live items as an empty $elemMatch', () => {
    const filter = group(
      'and',
      elemMatch('items', group('and', cond('qty', 'gte', 2, false))),
      elemMatch('tags', group('and', cond(ARRAY_ELEMENT_FIELD, 'gt', 1, false))),
    );

    expect(filterToEjson(filter)).toEqual({
      items: { $elemMatch: {} },
      tags: { $elemMatch: {} },
    });
  });

  it('writes an elemMatch on an array of documents with field conditions', () => {
    const filter = group(
      'and',
      elemMatch('items', group('and', cond('sku', 'eq', 'x'), cond('qty', 'gte', 2))),
    );

    expect(filterToEjson(filter)).toEqual({
      items: { $elemMatch: { sku: 'x', qty: { $gte: 2 } } },
    });
  });

  it('leaves out a disabled condition in an elemMatch on documents', () => {
    const filter = group(
      'and',
      elemMatch('items', group('and', cond('sku', 'eq', 'x'), cond('qty', 'gte', 2, false))),
    );

    expect(filterToEjson(filter)).toEqual({ items: { $elemMatch: { sku: 'x' } } });
  });

  it('writes a raw condition as its own operator', () => {
    const filter = group('and', raw('n', '$mod', [4, 0]));

    expect(filterToEjson(filter)).toEqual({ n: { $mod: [4, 0] } });
  });

  it('writes a raw condition on the same field as an eq with $eq', () => {
    const filter = group('and', cond('n', 'eq', 1), raw('n', '$mod', [4, 0]));

    expect(filterToEjson(filter)).toEqual({ n: { $eq: 1, $mod: [4, 0] } });
  });

  it('writes a raw fragment unchanged under its key', () => {
    const expr = { $eq: ['$a', '$b'] };
    const filter = group('and', cond('a', 'eq', 1), fragment('$expr', expr));

    expect(filterToEjson(filter)).toEqual({ a: 1, $expr: expr });
  });

  it('moves a second operator of the same kind on one field into $and', () => {
    const filter = group('and', cond('n', 'gt', 1), cond('n', 'gt', 5));

    expect(filterToEjson(filter)).toEqual({ n: { $gt: 1 }, $and: [{ n: { $gt: 5 } }] });
  });

  it('leaves out a disabled condition', () => {
    const filter = group('and', cond('a', 'eq', 1, false), cond('b', 'eq', 2));

    expect(filterToEjson(filter)).toEqual({ b: 2 });
  });

  it('leaves out a disabled condition when it would be the second on its field', () => {
    const filter = group('and', cond('n', 'eq', 1), cond('n', 'gt', 0, false));

    expect(filterToEjson(filter)).toEqual({ n: 1 });
  });

  it('leaves out a disabled raw condition and a disabled raw fragment', () => {
    const filter = group('and', raw('n', '$mod', [4, 0], false), fragment('$expr', {}, false));

    expect(filterToEjson(filter)).toEqual({});
  });

  it('leaves out a condition with no field yet, so no empty key is written', () => {
    const filter = group('and', cond('', 'eq', ''), cond('b', 'eq', 2));

    expect(filterToEjson(filter)).toEqual({ b: 2 });
  });

  it('leaves out a condition with no field from an OR group, and a group that has only that', () => {
    const filter = group(
      'or',
      cond('', 'eq', ''),
      group('and', cond('', 'gt', 1)),
      cond('b', 'eq', 2),
    );

    expect(filterToEjson(filter)).toEqual({ $or: [{ b: 2 }] });
  });

  it('leaves out a disabled condition inside an OR group', () => {
    const filter = group('or', cond('a', 'eq', 1, false), cond('b', 'eq', 2));

    expect(filterToEjson(filter)).toEqual({ $or: [{ b: 2 }] });
  });

  it('drops a nested group with no live items', () => {
    const filter = group(
      'and',
      cond('a', 'eq', 1),
      group('or'),
      group('and', cond('b', 'eq', 2, false)),
      group('nor', group('or', cond('c', 'eq', 3, false))),
    );

    expect(filterToEjson(filter)).toEqual({ a: 1 });
  });

  it('drops an empty AND element from an OR group', () => {
    const filter = group('or', group('and'), cond('b', 'eq', 2));

    expect(filterToEjson(filter)).toEqual({ $or: [{ b: 2 }] });
  });

  it('writes an empty top-level group as an empty object', () => {
    expect(filterToEjson(group('and'))).toEqual({});
    expect(filterToEjson(group('or'))).toEqual({});
    expect(filterToEjson(group('nor'))).toEqual({});
  });

  it('writes a top-level group with only disabled items as an empty object', () => {
    expect(filterToEjson(group('and', cond('a', 'eq', 1, false)))).toEqual({});
    expect(filterToEjson(group('or', cond('a', 'eq', 1, false)))).toEqual({});
  });
});

describe('emitFilter', () => {
  it('prints an empty filter as an empty object', () => {
    expect(emitFilter(group('and'))).toBe('{}');
    expect(emitFilter(group('or'))).toBe('{}');
  });

  it('prints mongosh syntax with two-space indent', () => {
    const filter = group('and', cond('a', 'eq', 1), cond('b', 'gt', 2));

    expect(emitFilter(filter)).toBe('{\n  a: 1,\n  b: {\n    $gt: 2\n  }\n}');
  });

  it('prints an OR group with its nested items', () => {
    const filter = group(
      'or',
      group('and', cond('a', 'eq', 1), cond('b', 'eq', 2)),
      group('nor', cond('c', 'eq', 3)),
    );

    expect(emitFilter(filter)).toBe(
      '{\n  $or: [\n    {\n      a: 1,\n      b: 2\n    },\n    {\n      $nor: [\n        {\n          c: 3\n        }\n      ]\n    }\n  ]\n}',
    );
  });

  it('prints a date value as ISODate', () => {
    const filter = group('and', cond('when', 'eq', { $date: '2026-01-02T00:00:00.000Z' }));

    expect(emitFilter(filter)).toBe('{\n  when: ISODate("2026-01-02T00:00:00.000Z")\n}');
  });
});
