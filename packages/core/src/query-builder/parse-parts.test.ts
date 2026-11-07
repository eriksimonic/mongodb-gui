import { describe, expect, it } from 'vitest';
import { filterFromEjson } from './parse-filter';
import { projectionFromEjson, sortFromEjson, stageFromEjson } from './parse-parts';

const expression = { $toString: '$a' };

describe('projectionFromEjson', () => {
  it('reads 1 and true as include, 0 and false as exclude', () => {
    expect(projectionFromEjson({ a: 1, b: true, c: 0, d: false })).toEqual([
      { kind: 'field', enabled: true, field: 'a', include: true },
      { kind: 'field', enabled: true, field: 'b', include: true },
      { kind: 'field', enabled: true, field: 'c', include: false },
      { kind: 'field', enabled: true, field: 'd', include: false },
    ]);
  });

  it('keeps the key order', () => {
    const rows = projectionFromEjson({ z: 1, _id: 0, a: 1 });
    expect(rows.map((row) => row.field)).toEqual(['z', '_id', 'a']);
  });

  it('reads any other value as a raw row with the value', () => {
    expect(
      projectionFromEjson({
        a: expression,
        b: { $slice: [1, 2] },
        c: '$x',
        d: 2,
        e: { $numberInt: '1' },
      }),
    ).toEqual([
      { kind: 'raw', enabled: true, field: 'a', value: expression },
      { kind: 'raw', enabled: true, field: 'b', value: { $slice: [1, 2] } },
      { kind: 'raw', enabled: true, field: 'c', value: '$x' },
      { kind: 'raw', enabled: true, field: 'd', value: 2 },
      { kind: 'raw', enabled: true, field: 'e', value: { $numberInt: '1' } },
    ]);
  });

  it('reads an empty projection as no rows', () => {
    expect(projectionFromEjson({})).toEqual([]);
  });
});

describe('sortFromEjson', () => {
  it('reads 1 and -1 as ascending and descending rows in key order', () => {
    expect(sortFromEjson({ b: -1, a: 1 })).toEqual([
      { enabled: true, field: 'b', direction: -1 },
      { enabled: true, field: 'a', direction: 1 },
    ]);
  });

  it('reads an empty sort as no rows', () => {
    expect(sortFromEjson({})).toEqual([]);
  });

  it.each([
    ['a string', { a: 'asc' }],
    ['zero', { a: 0 }],
    ['two', { a: 2 }],
    ['a $meta sort', { a: { $meta: 'textScore' } }],
    ['one bad key among good ones', { a: 1, b: 'desc' }],
  ])('returns null for %s', (_name, sort) => {
    expect(sortFromEjson(sort)).toBeNull();
  });
});

describe('stageFromEjson', () => {
  it('returns null for a document without exactly one key', () => {
    expect(stageFromEjson({})).toBeNull();
    expect(stageFromEjson({ $match: {}, $limit: 1 })).toBeNull();
  });

  it('reads $match with the filter parser', () => {
    const filter = { a: 1, $or: [{ b: 2 }, { c: 3 }] };
    expect(stageFromEjson({ $match: filter })).toEqual({
      stage: '$match',
      enabled: true,
      filter: filterFromEjson(filter),
    });
  });

  it('reads $match with a non-object value as a raw stage', () => {
    expect(stageFromEjson({ $match: [] })).toEqual({
      stage: 'raw',
      enabled: true,
      name: '$match',
      value: [],
    });
  });

  it('reads $project rows', () => {
    expect(stageFromEjson({ $project: { a: 1, b: 0, c: expression } })).toEqual({
      stage: '$project',
      enabled: true,
      rows: [
        { kind: 'field', enabled: true, field: 'a', include: true },
        { kind: 'field', enabled: true, field: 'b', include: false },
        { kind: 'raw', enabled: true, field: 'c', value: expression },
      ],
    });
  });

  it('reads $sort rows', () => {
    expect(stageFromEjson({ $sort: { a: -1, b: 1 } })).toEqual({
      stage: '$sort',
      enabled: true,
      rows: [
        { enabled: true, field: 'a', direction: -1 },
        { enabled: true, field: 'b', direction: 1 },
      ],
    });
  });

  it('reads a $sort with a bad direction as a raw stage', () => {
    expect(stageFromEjson({ $sort: { a: 'asc' } })).toEqual({
      stage: 'raw',
      enabled: true,
      name: '$sort',
      value: { a: 'asc' },
    });
  });

  it.each(['$limit', '$skip'] as const)('reads %s as a count', (name) => {
    expect(stageFromEjson({ [name]: 5 })).toEqual({
      stage: name,
      enabled: true,
      count: 5,
    });
  });

  it.each(['$limit', '$skip'] as const)('reads %s with a non-number as a raw stage', (name) => {
    expect(stageFromEjson({ [name]: '5' })).toEqual({
      stage: 'raw',
      enabled: true,
      name,
      value: '5',
    });
  });

  it('reads $count with its output field', () => {
    expect(stageFromEjson({ $count: 'total' })).toEqual({
      stage: '$count',
      enabled: true,
      output: 'total',
    });
  });

  it('reads $count with a non-string as a raw stage', () => {
    expect(stageFromEjson({ $count: 3 })).toEqual({
      stage: 'raw',
      enabled: true,
      name: '$count',
      value: 3,
    });
  });

  it('reads $unwind with a path string as keep-empty off', () => {
    expect(stageFromEjson({ $unwind: '$tags' })).toEqual({
      stage: '$unwind',
      enabled: true,
      path: 'tags',
      preserveEmpty: false,
    });
  });

  it('reads $unwind with the object form and its keep-empty flag', () => {
    expect(
      stageFromEjson({ $unwind: { path: '$tags', preserveNullAndEmptyArrays: true } }),
    ).toEqual({ stage: '$unwind', enabled: true, path: 'tags', preserveEmpty: true });
    expect(stageFromEjson({ $unwind: { path: '$tags' } })).toEqual({
      stage: '$unwind',
      enabled: true,
      path: 'tags',
      preserveEmpty: false,
    });
  });

  it.each([
    ['a path without $', { $unwind: 'tags' }],
    ['a bare $', { $unwind: '$' }],
    ['an object with includeArrayIndex', { $unwind: { path: '$a', includeArrayIndex: 'i' } }],
    ['a non-boolean keep-empty flag', { $unwind: { path: '$a', preserveNullAndEmptyArrays: 1 } }],
    ['a number', { $unwind: 1 }],
  ])('reads $unwind with %s as a raw stage', (_name, stage) => {
    expect(stageFromEjson(stage)).toEqual({
      stage: 'raw',
      enabled: true,
      name: '$unwind',
      value: Object.values(stage)[0],
    });
  });

  it('reads $group with the _id expression and one row per accumulator', () => {
    const idExpression = { $toString: '$a' };
    expect(
      stageFromEjson({
        $group: {
          _id: idExpression,
          total: { $sum: '$n' },
          avg: { $avg: '$n' },
          low: { $min: '$n' },
          high: { $max: '$n' },
          first: { $first: '$n' },
          last: { $last: '$n' },
          all: { $push: '$n' },
          unique: { $addToSet: '$n' },
        },
      }),
    ).toEqual({
      stage: '$group',
      enabled: true,
      id: idExpression,
      accumulators: [
        { output: 'total', accumulator: '$sum', expression: '$n' },
        { output: 'avg', accumulator: '$avg', expression: '$n' },
        { output: 'low', accumulator: '$min', expression: '$n' },
        { output: 'high', accumulator: '$max', expression: '$n' },
        { output: 'first', accumulator: '$first', expression: '$n' },
        { output: 'last', accumulator: '$last', expression: '$n' },
        { output: 'all', accumulator: '$push', expression: '$n' },
        { output: 'unique', accumulator: '$addToSet', expression: '$n' },
      ],
    });
  });

  it('reads a $group with a null _id and no accumulators', () => {
    expect(stageFromEjson({ $group: { _id: null } })).toEqual({
      stage: '$group',
      enabled: true,
      id: null,
      accumulators: [],
    });
  });

  it.each([
    ['an accumulator outside the model', { _id: null, sd: { $stdDevPop: '$n' } }],
    ['an accumulator object with two keys', { _id: null, t: { $sum: 1, $avg: 1 } }],
    ['an accumulator that is not an object', { _id: null, t: 1 }],
    ['no _id', { t: { $sum: 1 } }],
  ])('reads $group with %s as a raw stage', (_name, group) => {
    expect(stageFromEjson({ $group: group })).toEqual({
      stage: 'raw',
      enabled: true,
      name: '$group',
      value: group,
    });
  });

  it('reads $lookup with its four fields', () => {
    expect(
      stageFromEjson({
        $lookup: { from: 'users', localField: 'uid', foreignField: '_id', as: 'user' },
      }),
    ).toEqual({
      stage: '$lookup',
      enabled: true,
      from: 'users',
      localField: 'uid',
      foreignField: '_id',
      as: 'user',
    });
  });

  it('reads a $lookup with a pipeline as a raw stage', () => {
    const lookup = {
      from: 'users',
      let: { uid: '$uid' },
      pipeline: [{ $match: { $expr: { $eq: ['$_id', '$$uid'] } } }],
      as: 'user',
    };
    expect(stageFromEjson({ $lookup: lookup })).toEqual({
      stage: 'raw',
      enabled: true,
      name: '$lookup',
      value: lookup,
    });
  });

  it('reads a $lookup with a missing field as a raw stage', () => {
    const lookup = { from: 'users', localField: 'uid', foreignField: '_id' };
    expect(stageFromEjson({ $lookup: lookup })).toEqual({
      stage: 'raw',
      enabled: true,
      name: '$lookup',
      value: lookup,
    });
  });

  it.each([
    ['$addFields', { total: { $add: ['$a', '$b'] } }],
    ['$facet', { byYear: [{ $count: 'n' }] }],
    ['$replaceRoot', { newRoot: '$doc' }],
  ])('reads an unknown stage %s as a raw stage', (name, value) => {
    expect(stageFromEjson({ [name]: value })).toEqual({
      stage: 'raw',
      enabled: true,
      name,
      value,
    });
  });
});
