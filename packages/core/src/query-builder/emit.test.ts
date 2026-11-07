import { describe, expect, it } from 'vitest';
import { emitStatement, projectionToEjson, sortToEjson, stageToEjson } from './emit';
import type {
  AggregateStatement,
  FindStatement,
  PipelineStage,
  ProjectionRow,
  QueryGroup,
  QueryItem,
  SortRow,
  StageBody,
} from './model';

// Builders. Every part is enabled unless a test passes false.

function group(operator: QueryGroup['operator'], ...items: QueryItem[]): QueryGroup {
  return { kind: 'group', operator, items };
}

function eq(field: string, value: unknown, enabled = true): QueryItem {
  return { kind: 'condition', enabled, field, operator: 'eq', value };
}

function field(name: string, include: boolean, enabled = true): ProjectionRow {
  return { kind: 'field', enabled, field: name, include };
}

function sort(name: string, direction: 1 | -1, enabled = true): SortRow {
  return { enabled, field: name, direction };
}

function find(overrides: Partial<FindStatement> = {}): FindStatement {
  return {
    kind: 'find',
    collection: 'orders',
    filter: group('and'),
    projection: [],
    sort: [],
    skip: null,
    limit: null,
    ...overrides,
  };
}

function stage(body: StageBody, enabled = true): PipelineStage {
  return { ...body, enabled } as PipelineStage;
}

function aggregate(stages: PipelineStage[], collection = 'orders'): AggregateStatement {
  return { kind: 'aggregate', collection, stages };
}

describe('emitStatement, find', () => {
  it('writes every part in chain order', () => {
    const statement = find({
      filter: group('and', eq('status', 'open'), {
        kind: 'condition',
        enabled: true,
        field: 'total',
        operator: 'gt',
        value: 10,
      }),
      projection: [field('name', true), field('_id', false)],
      sort: [sort('total', -1)],
      skip: 5,
      limit: 20,
    });

    expect(emitStatement(statement)).toBe(
      'db.orders.find({\n  status: "open",\n  total: {\n    $gt: 10\n  }\n}, {\n  name: 1,\n  _id: 0\n})' +
        '.sort({\n  total: -1\n}).skip(5).limit(20)',
    );
  });

  it('writes no arguments for an empty find', () => {
    expect(emitStatement(find())).toBe('db.orders.find()');
  });

  it('writes no arguments for a find whose only filter item is disabled', () => {
    expect(emitStatement(find({ filter: group('and', eq('a', 1, false)) }))).toBe(
      'db.orders.find()',
    );
  });

  it('writes an empty filter when a projection follows it', () => {
    const statement = find({ projection: [field('name', true)] });

    expect(emitStatement(statement)).toBe('db.orders.find({}, {\n  name: 1\n})');
  });

  it('leaves out disabled conditions, rows and sort keys', () => {
    const statement = find({
      filter: group('and', eq('a', 1, false), eq('b', 2)),
      projection: [field('name', true, false)],
      sort: [sort('total', -1, false)],
      skip: 3,
    });

    expect(emitStatement(statement)).toBe('db.orders.find({\n  b: 2\n}).skip(3)');
  });

  it('writes a collection name that is not an identifier with getCollection', () => {
    expect(emitStatement(find({ collection: 'order-items' }))).toBe(
      "db.getCollection('order-items').find()",
    );
  });
});

describe('projectionToEjson and sortToEjson', () => {
  it('writes include as 1, exclude as 0 and a raw row as its value', () => {
    const rows: ProjectionRow[] = [
      field('name', true),
      field('_id', false),
      { kind: 'raw', enabled: true, field: 'tags', value: { $slice: 2 } },
    ];

    expect(projectionToEjson(rows)).toEqual({ name: 1, _id: 0, tags: { $slice: 2 } });
  });

  it('drops disabled projection rows', () => {
    expect(projectionToEjson([field('name', true, false)])).toEqual({});
  });

  it('writes the sort direction and drops disabled rows', () => {
    expect(sortToEjson([sort('total', -1), sort('name', 1, false), sort('a', 1)])).toEqual({
      total: -1,
      a: 1,
    });
  });
});

describe('stageToEjson', () => {
  it.each<[string, StageBody, unknown]>([
    [
      '$match',
      { stage: '$match', filter: group('and', eq('status', 'open')) },
      { $match: { status: 'open' } },
    ],
    [
      '$project',
      { stage: '$project', rows: [field('name', true), field('_id', false)] },
      { $project: { name: 1, _id: 0 } },
    ],
    ['$sort', { stage: '$sort', rows: [sort('total', -1)] }, { $sort: { total: -1 } }],
    ['$limit', { stage: '$limit', count: 10 }, { $limit: 10 }],
    ['$skip', { stage: '$skip', count: 2 }, { $skip: 2 }],
    ['$count', { stage: '$count', output: 'n' }, { $count: 'n' }],
    [
      '$unwind without empty arrays',
      { stage: '$unwind', path: 'tags', preserveEmpty: false },
      { $unwind: '$tags' },
    ],
    [
      '$unwind with empty arrays',
      { stage: '$unwind', path: 'tags', preserveEmpty: true },
      { $unwind: { path: '$tags', preserveNullAndEmptyArrays: true } },
    ],
    [
      '$group',
      {
        stage: '$group',
        id: '$customer',
        accumulators: [{ output: 'sum', accumulator: '$sum', expression: '$total' }],
      },
      { $group: { _id: '$customer', sum: { $sum: '$total' } } },
    ],
    [
      '$lookup',
      {
        stage: '$lookup',
        from: 'customers',
        localField: 'customer',
        foreignField: '_id',
        as: 'cust',
      },
      {
        $lookup: { from: 'customers', localField: 'customer', foreignField: '_id', as: 'cust' },
      },
    ],
    ['raw', { stage: 'raw', name: '$addFields', value: { x: 1 } }, { $addFields: { x: 1 } }],
  ])('writes the %s stage as EJSON', (_name, body, expected) => {
    expect(stageToEjson(body)).toEqual(expected);
  });

  it('writes every accumulator of a $group stage as its own field', () => {
    const body: StageBody = {
      stage: '$group',
      id: '$customer',
      accumulators: [
        { output: 'sum', accumulator: '$sum', expression: '$total' },
        { output: 'avg', accumulator: '$avg', expression: '$total' },
        { output: 'top', accumulator: '$max', expression: '$total' },
      ],
    };

    expect(stageToEjson(body)).toEqual({
      $group: {
        _id: '$customer',
        sum: { $sum: '$total' },
        avg: { $avg: '$total' },
        top: { $max: '$total' },
      },
    });
  });
});

describe('emitStatement, aggregate', () => {
  it('writes one stage object per enabled stage and keeps raw stages', () => {
    const statement = aggregate([
      stage({ stage: '$match', filter: group('and', eq('status', 'open')) }),
      stage({ stage: '$limit', count: 10 }),
      stage({ stage: '$skip', count: 2 }, false),
      stage({ stage: 'raw', name: '$addFields', value: { x: 1 } }),
    ]);

    expect(emitStatement(statement)).toBe(
      'db.orders.aggregate([\n  {\n    $match: {\n      status: "open"\n    }\n  },\n' +
        '  {\n    $limit: 10\n  },\n  {\n    $addFields: {\n      x: 1\n    }\n  }\n])',
    );
  });

  it('writes a $project, $sort and $unwind stage', () => {
    const statement = aggregate([
      stage({ stage: '$project', rows: [field('name', true)] }),
      stage({ stage: '$sort', rows: [sort('total', -1)] }),
      stage({ stage: '$unwind', path: 'tags', preserveEmpty: true }),
    ]);

    expect(emitStatement(statement)).toBe(
      'db.orders.aggregate([\n  {\n    $project: {\n      name: 1\n    }\n  },\n' +
        '  {\n    $sort: {\n      total: -1\n    }\n  },\n' +
        '  {\n    $unwind: {\n      path: "$tags",\n      preserveNullAndEmptyArrays: true\n    }\n  }\n])',
    );
  });

  it('writes $group, $count and $lookup stages', () => {
    const statement = aggregate([
      stage({
        stage: '$group',
        id: '$customer',
        accumulators: [{ output: 'sum', accumulator: '$sum', expression: '$total' }],
      }),
      stage({ stage: '$count', output: 'n' }),
      stage({
        stage: '$lookup',
        from: 'customers',
        localField: 'customer',
        foreignField: '_id',
        as: 'cust',
      }),
    ]);

    expect(emitStatement(statement)).toBe(
      'db.orders.aggregate([\n  {\n    $group: {\n      _id: "$customer",\n      sum: {\n        $sum: "$total"\n      }\n    }\n  },\n' +
        '  {\n    $count: "n"\n  },\n' +
        '  {\n    $lookup: {\n      from: "customers",\n      localField: "customer",\n      foreignField: "_id",\n      as: "cust"\n    }\n  }\n])',
    );
  });

  it('drops a $project or $sort stage with no enabled row', () => {
    const statement = aggregate([
      stage({ stage: '$project', rows: [] }),
      stage({ stage: '$sort', rows: [] }),
      stage({ stage: '$project', rows: [field('name', true, false)] }),
      stage({ stage: '$sort', rows: [sort('total', -1, false)] }),
      stage({ stage: '$limit', count: 1 }),
    ]);

    expect(emitStatement(statement)).toBe('db.orders.aggregate([\n  {\n    $limit: 1\n  }\n])');
  });

  it('keeps an empty $match stage', () => {
    const statement = aggregate([stage({ stage: '$match', filter: group('and') })]);

    expect(emitStatement(statement)).toBe('db.orders.aggregate([\n  {\n    $match: {}\n  }\n])');
  });

  it('uses getCollection for a name that is not an identifier', () => {
    expect(emitStatement(aggregate([], 'order-items'))).toBe(
      "db.getCollection('order-items').aggregate([])",
    );
  });
});
