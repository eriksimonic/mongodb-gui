import { describe, expect, it } from 'vitest';
import { emitStatement } from './emit';
import {
  ARRAY_ELEMENT_FIELD,
  type AggregateStatement,
  type Accumulator,
  type AccumulatorRow,
  type ConditionOperator,
  type FindStatement,
  type PipelineStage,
  type ProjectionRow,
  type QueryGroup,
  type QueryItem,
  type QueryStatement,
  type SortRow,
  type StageBody,
} from './model';
import { parseStatementAt } from './parse';

type ValueOperator = Exclude<ConditionOperator, 'regex' | 'elemMatch'>;

const OID = { $oid: '64b7f0c2a1b2c3d4e5f60718' };

// Builders. Every part is enabled unless a test passes false.

function group(operator: QueryGroup['operator'], ...items: QueryItem[]): QueryGroup {
  return { kind: 'group', operator, items };
}

function cond(field: string, operator: ValueOperator, value: unknown, enabled = true): QueryItem {
  return { kind: 'condition', enabled, field, operator, value };
}

function regex(field: string, pattern: string, options = '', enabled = true): QueryItem {
  return { kind: 'condition', enabled, field, operator: 'regex', pattern, options };
}

function elemMatch(field: string, body: QueryGroup, enabled = true): QueryItem {
  return { kind: 'condition', enabled, field, operator: 'elemMatch', group: body };
}

function rawCond(field: string, operator: string, value: unknown, enabled = true): QueryItem {
  return { kind: 'rawCondition', enabled, field, operator, value };
}

function rawFragment(key: string, value: unknown, enabled = true): QueryItem {
  return { kind: 'rawFragment', enabled, key, value };
}

function field(name: string, include: boolean, enabled = true): ProjectionRow {
  return { kind: 'field', enabled, field: name, include };
}

function rawRow(name: string, value: unknown, enabled = true): ProjectionRow {
  return { kind: 'raw', enabled, field: name, value };
}

function sort(name: string, direction: 1 | -1, enabled = true): SortRow {
  return { enabled, field: name, direction };
}

function acc(output: string, accumulator: Accumulator, expression: unknown): AccumulatorRow {
  return { output, accumulator, expression };
}

function stage(body: StageBody, enabled = true): PipelineStage {
  return { ...body, enabled };
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

function aggregate(stages: PipelineStage[], collection = 'orders'): AggregateStatement {
  return { kind: 'aggregate', collection, stages };
}

// The model as the emitter writes it: disabled items, and groups with no live item, are removed.

function hasLive(item: QueryItem): boolean {
  return item.kind === 'group' ? item.items.some(hasLive) : item.enabled;
}

function liveGroup(value: QueryGroup): QueryGroup {
  return {
    kind: 'group',
    operator: value.operator,
    items: value.items.filter(hasLive).map(liveItem),
  };
}

function liveItem(item: QueryItem): QueryItem {
  if (item.kind === 'group') {
    return liveGroup(item);
  }
  if (item.kind === 'condition' && item.operator === 'elemMatch') {
    return { ...item, group: liveGroup(item.group) };
  }
  return item;
}

function noLiveRows(value: PipelineStage): boolean {
  if (value.stage !== '$project' && value.stage !== '$sort') {
    return false;
  }
  const rows: readonly { readonly enabled: boolean }[] = value.rows;
  return rows.every((row) => !row.enabled);
}

function liveStage(value: PipelineStage): PipelineStage {
  switch (value.stage) {
    case '$match':
      return { ...value, filter: liveGroup(value.filter) };
    case '$project':
      return { ...value, rows: value.rows.filter((row) => row.enabled) };
    case '$sort':
      return { ...value, rows: value.rows.filter((row) => row.enabled) };
    default:
      return value;
  }
}

function liveStatement(statement: QueryStatement): QueryStatement {
  if (statement.kind === 'find') {
    return {
      ...statement,
      filter: liveGroup(statement.filter),
      projection: statement.projection.filter((row) => row.enabled),
      sort: statement.sort.filter((row) => row.enabled),
    };
  }
  return {
    ...statement,
    stages: statement.stages.filter((value) => value.enabled && !noLiveRows(value)).map(liveStage),
  };
}

// Reads a statement text back. A text the parser refuses fails the test with the reason.

function readBack(text: string): QueryStatement {
  const result = parseStatementAt(text, 0);
  if (result === null) {
    throw new Error(`no statement in: ${text}`);
  }
  if ('unsupported' in result) {
    throw new Error(`${result.unsupported}, in: ${text}`);
  }
  return result.statement;
}

/** Model to text to model. The result must equal the model without its disabled items. */
function expectModelRoundTrip(statement: QueryStatement): void {
  expect(readBack(emitStatement(statement))).toEqual(liveStatement(statement));
}

/** Text to model to text to model. The second model must equal the first. */
function expectTextRoundTrip(text: string): void {
  const model = readBack(text);
  expect(readBack(emitStatement(model))).toEqual(model);
}

// Model samples. Each one holds only the parts the builder can create.

const FIND_ALL_PARTS = find({
  filter: group(
    'and',
    cond('status', 'eq', 'open'),
    cond('total', 'gte', 10),
    cond('total', 'lt', 500),
    cond('owner', 'eq', OID),
  ),
  projection: [field('name', true), field('_id', false)],
  sort: [sort('total', -1), sort('name', 1)],
  skip: 2,
  limit: 10,
});

const FIND_EMPTY = find();

const FIND_PROJECTION_ONLY = find({ projection: [field('name', true)] });

const FIND_SORT_ONLY = find({ sort: [sort('total', 1)] });

const FIND_SKIP_ZERO = find({ skip: 0, limit: 1 });

const FIND_EMPTY_FILTER_WITH_PROJECTION = find({
  projection: [field('name', false)],
  filter: group('and'),
});

const FIND_EVERY_OPERATOR = find({
  filter: group(
    'and',
    cond('status', 'eq', 'open'),
    cond('region', 'ne', 'eu'),
    cond('total', 'gt', 5),
    cond('qty', 'gte', 2),
    cond('score', 'lt', 9.5),
    cond('rank', 'lte', 3),
    cond('kind', 'in', ['a', 'b']),
    cond('code', 'nin', ['x']),
    cond('note', 'exists', true),
    cond('code2', 'type', 'string'),
    regex('name', '^a', 'i'),
    regex('sku', '^A'),
    cond('lines', 'size', 2),
    cond('labels', 'all', ['x', 'y']),
    elemMatch(
      'scores',
      group('and', cond(ARRAY_ELEMENT_FIELD, 'gte', 5), cond(ARRAY_ELEMENT_FIELD, 'lt', 9)),
    ),
    elemMatch('items', group('and', cond('sku', 'eq', 'A1'), cond('qty2', 'gt', 2))),
  ),
});

const FIND_VALUE_KINDS = find({
  filter: group(
    'and',
    cond('deletedAt', 'eq', null),
    cond('active', 'eq', false),
    cond('balance', 'lt', -5),
    cond('title', 'eq', 'say "hi" \\ it\'s'),
    cond('createdAt', 'gte', { $date: '2026-01-01T00:00:00.000Z' }),
    cond('owner', 'eq', OID),
    cond('name', 'eq', { $regularExpression: { pattern: '^a', options: 'i' } }),
    cond('price', 'eq', { $numberDecimal: '1.50' }),
    cond('big', 'eq', { $numberLong: '9007199254740993' }),
    cond('tags', 'eq', ['a', 1, null]),
  ),
});

// Dates. Years 0 to 9999 read as an ISO string with milliseconds. Other years read as
// `{ $numberLong }` milliseconds. 253402300800000 is 10000-01-01T00:00:00Z.
const UI_DATE = { $date: '2026-01-01T10:00:30.500Z' };

const FIND_UI_DATE = find({ filter: group('and', cond('ts', 'gte', UI_DATE)) });

const AGGREGATE_MATCH_UI_DATE = aggregate([
  stage({ stage: '$match', filter: group('and', cond('ts', 'gte', UI_DATE)) }),
]);

const FIND_UI_DATE_IN = find({
  filter: group('and', cond('ts', 'in', [UI_DATE, { $date: '0000-01-01T00:00:00.000Z' }])),
});

const FIND_DATE_YEAR_0 = find({
  filter: group('and', cond('ts', 'eq', { $date: '0000-01-01T00:00:00.000Z' })),
});

const FIND_DATE_YEAR_9999 = find({
  filter: group('and', cond('ts', 'eq', { $date: '9999-12-31T23:59:59.999Z' })),
});

const FIND_DATE_YEAR_10000 = find({
  filter: group('and', cond('ts', 'eq', { $date: { $numberLong: '253402300800000' } })),
});

const FIND_NESTED_OR_NOR = find({
  filter: group(
    'and',
    group('or', group('and', cond('a', 'eq', 1)), group('and', cond('b', 'gt', 2))),
    group(
      'nor',
      group('and', cond('c', 'lt', 3)),
      group('and', cond('d', 'eq', 'x'), cond('e', 'eq', 'y')),
    ),
  ),
});

// An AND group whose only child is an OR group, inside an OR, reads back as that OR group. The text
// `{ $or: [{ $or: [...] }, ...] }` cannot tell the two apart, and both mean the same. So the models
// below put the OR or NOR group directly under the OR or NOR group, with no AND group between them.
const OR_UNDER_OR = group(
  'and',
  group(
    'or',
    group('or', group('and', cond('f', 'eq', 1)), group('and', cond('g', 'eq', 2))),
    group('and', cond('h', 'eq', 3)),
  ),
);

const NOR_UNDER_OR = group(
  'and',
  group(
    'or',
    group('nor', group('and', cond('f', 'eq', 1)), group('and', cond('g', 'eq', 2))),
    group('and', cond('h', 'eq', 3)),
  ),
);

const OR_UNDER_NOR = group(
  'and',
  group(
    'nor',
    group('or', group('and', cond('f', 'eq', 1)), group('and', cond('g', 'eq', 2))),
    group('and', cond('h', 'eq', 3)),
  ),
);

const FIND_OR_UNDER_OR = find({ filter: OR_UNDER_OR });

const FIND_NOR_UNDER_OR = find({ filter: NOR_UNDER_OR });

const FIND_OR_UNDER_NOR = find({ filter: OR_UNDER_NOR });

const FIND_ELEM_MATCH_OBJECT = find({
  filter: group(
    'and',
    elemMatch('items', group('and', cond('sku', 'eq', 'A1'), cond('qty', 'gt', 2))),
  ),
});

const FIND_ELEM_MATCH_SCALAR = find({
  filter: group(
    'and',
    elemMatch(
      'scores',
      group('and', cond(ARRAY_ELEMENT_FIELD, 'gt', 5), cond(ARRAY_ELEMENT_FIELD, 'lte', 9)),
    ),
    elemMatch('tags', group('and', regex(ARRAY_ELEMENT_FIELD, '^a', 'i'))),
  ),
});

const FIND_ELEM_MATCH_EMPTY = find({
  filter: group('and', elemMatch('items', group('and'))),
});

const FIND_COLLECTION_NAMES = [
  find({ collection: 'order-items', filter: group('and', cond('a', 'eq', 1)) }),
  find({ collection: 'sales.2026', sort: [sort('total', 1)] }),
  find({ collection: 'with space' }),
];

const AGGREGATE_ALL_KINDS = aggregate([
  stage({
    stage: '$match',
    filter: group('and', cond('total', 'gt', 10), cond('total', 'lt', 99)),
  }),
  stage({ stage: '$project', rows: [field('name', true), field('_id', false)] }),
  stage({ stage: '$sort', rows: [sort('total', -1), sort('name', 1)] }),
  stage({ stage: '$skip', count: 5 }),
  stage({ stage: '$limit', count: 10 }),
  stage({ stage: '$count', output: 'n' }),
  stage({ stage: '$unwind', path: 'items', preserveEmpty: false }),
  stage({
    stage: '$group',
    id: '$status',
    accumulators: [
      acc('sum', '$sum', '$total'),
      acc('avg', '$avg', '$total'),
      acc('min', '$min', '$total'),
      acc('max', '$max', '$total'),
      acc('first', '$first', '$name'),
      acc('last', '$last', '$name'),
      acc('names', '$push', '$name'),
      acc('ids', '$addToSet', '$sku'),
    ],
  }),
  stage({
    stage: '$lookup',
    from: 'customers',
    localField: 'customerId',
    foreignField: '_id',
    as: 'customer',
  }),
  stage({ stage: 'raw', name: '$addFields', value: { flag: true } }),
]);

const AGGREGATE_MATCH = aggregate([
  stage({ stage: '$match', filter: group('and', cond('x', 'eq', 1)) }),
]);

const AGGREGATE_MATCH_OR_UNDER_OR = aggregate([stage({ stage: '$match', filter: OR_UNDER_OR })]);

const AGGREGATE_MATCH_NOR_UNDER_OR = aggregate([stage({ stage: '$match', filter: NOR_UNDER_OR })]);

const AGGREGATE_MATCH_OR_UNDER_NOR = aggregate([stage({ stage: '$match', filter: OR_UNDER_NOR })]);

const AGGREGATE_PROJECT = aggregate([
  stage({ stage: '$project', rows: [field('name', true), field('_id', false)] }),
]);

const AGGREGATE_SORT = aggregate([stage({ stage: '$sort', rows: [sort('total', -1)] })]);

const AGGREGATE_LIMIT = aggregate([stage({ stage: '$limit', count: 10 })]);

const AGGREGATE_SKIP = aggregate([stage({ stage: '$skip', count: 0 })]);

const AGGREGATE_COUNT = aggregate([stage({ stage: '$count', output: 'n' })]);

const AGGREGATE_UNWIND_PRESERVE = aggregate([
  stage({ stage: '$unwind', path: 'tags', preserveEmpty: true }),
]);

const AGGREGATE_GROUP_NULL_ID = aggregate([
  stage({ stage: '$group', id: null, accumulators: [acc('n', '$sum', 1)] }),
]);

const AGGREGATE_GROUP_OBJECT_ID = aggregate([
  stage({
    stage: '$group',
    id: { day: '$day', status: '$status' },
    accumulators: [acc('total', '$sum', '$total')],
  }),
]);

const AGGREGATE_LOOKUP = aggregate([
  stage({
    stage: '$lookup',
    from: 'customers',
    localField: 'customerId',
    foreignField: '_id',
    as: 'customer',
  }),
]);

const AGGREGATE_EMPTY = aggregate([]);

const AGGREGATE_COLLECTION_NAME = aggregate(
  [stage({ stage: '$count', output: 'n' })],
  'order-items',
);

const SAMPLES: [string, QueryStatement][] = [
  ['find with every part', FIND_ALL_PARTS],
  ['find with no filter, projection or sort', FIND_EMPTY],
  ['find with projection only', FIND_PROJECTION_ONLY],
  ['find with sort only', FIND_SORT_ONLY],
  ['find with skip 0', FIND_SKIP_ZERO],
  ['find with an empty filter and a projection', FIND_EMPTY_FILTER_WITH_PROJECTION],
  ['find with every filter operator', FIND_EVERY_OPERATOR],
  ['find with canonical values of every kind', FIND_VALUE_KINDS],
  ['find with a UI date', FIND_UI_DATE],
  ['aggregate $match with a UI date', AGGREGATE_MATCH_UI_DATE],
  ['find with dates in an $in list', FIND_UI_DATE_IN],
  ['find with a date in year 0000', FIND_DATE_YEAR_0],
  ['find with a date in year 9999', FIND_DATE_YEAR_9999],
  ['find with a date in year 10000, as $numberLong', FIND_DATE_YEAR_10000],
  ['find with nested or and nor groups', FIND_NESTED_OR_NOR],
  ['find with an or group directly under an or group', FIND_OR_UNDER_OR],
  ['find with a nor group directly under an or group', FIND_NOR_UNDER_OR],
  ['find with an or group directly under a nor group', FIND_OR_UNDER_NOR],
  ['find with an object elemMatch', FIND_ELEM_MATCH_OBJECT],
  ['find with a scalar elemMatch', FIND_ELEM_MATCH_SCALAR],
  ['find with an empty elemMatch', FIND_ELEM_MATCH_EMPTY],
  ['aggregate with every stage kind', AGGREGATE_ALL_KINDS],
  ['aggregate with $match', AGGREGATE_MATCH],
  ['aggregate $match with an or group directly under an or group', AGGREGATE_MATCH_OR_UNDER_OR],
  ['aggregate $match with a nor group directly under an or group', AGGREGATE_MATCH_NOR_UNDER_OR],
  ['aggregate $match with an or group directly under a nor group', AGGREGATE_MATCH_OR_UNDER_NOR],
  ['aggregate with $project', AGGREGATE_PROJECT],
  ['aggregate with $sort', AGGREGATE_SORT],
  ['aggregate with $limit', AGGREGATE_LIMIT],
  ['aggregate with $skip 0', AGGREGATE_SKIP],
  ['aggregate with $count', AGGREGATE_COUNT],
  ['aggregate with $unwind preserving empty arrays', AGGREGATE_UNWIND_PRESERVE],
  ['aggregate with $group on null', AGGREGATE_GROUP_NULL_ID],
  ['aggregate with $group on an object', AGGREGATE_GROUP_OBJECT_ID],
  ['aggregate with $lookup', AGGREGATE_LOOKUP],
  ['aggregate with no stages', AGGREGATE_EMPTY],
  ['aggregate on a collection with a hyphen', AGGREGATE_COLLECTION_NAME],
  ...FIND_COLLECTION_NAMES.map((model): [string, QueryStatement] => [
    `find on collection ${model.collection}`,
    model,
  ]),
];

// Texts the parser reads. Each one must read, emit, and read back to the same model.

const TEXTS = [
  'db.orders.find()',
  'db.orders.find({ status: "open" }, { name: 1, _id: 0 }).sort({ total: -1, name: 1 }).skip(2).limit(10);',
  'db.orders.find().limit(5).skip(1)',
  'db.orders.find({}, { name: 1 })',
  'db.orders.find().sort({ total: 1 }).skip(0)',
  'db.orders.find()\n  .sort({ total: -1 })\n  .limit(5);',
  'db.getCollection("order-items").find({ "sku-code": "A1" })',
  "db.getCollection('orders').find()",
  'db.orders.aggregate([])',
  'db.getCollection("order-items").aggregate([{ $match: { total: { $gt: 1 } } }])',
  'db.orders.find({ total: { $gt: -5, $lt: 1.5 } })',
  'db.orders.find({ name: /^a/i, sku: /^A/ })',
  'db.orders.find({ createdAt: { $gte: ISODate("2026-01-01T00:00:00Z") } })',
  'db.orders.find({ owner: ObjectId("64b7f0c2a1b2c3d4e5f60718") })',
  'db.orders.find({ price: Decimal128("1.50"), big: NumberLong("9007199254740993") })',
  'db.orders.find({ created: new Date("2026-01-01T00:00:00.000Z") })',
  'db.orders.find({ ts: { $gte: ISODate("2026-01-01T10:00:30.500Z") } })',
  'db.orders.aggregate([{ $match: { ts: { $gte: ISODate("2026-01-01T10:00:30.500Z") } } }])',
  'db.orders.find({ ts: { $in: [ISODate("2026-01-01T10:00:30.500Z"), ISODate("0000-01-01T00:00:00.000Z")] } })',
  'db.orders.find({ ts: ISODate("0000-01-01T00:00:00.000Z") })',
  'db.orders.find({ ts: ISODate("9999-12-31T23:59:59.999Z") })',
  'db.orders.find({ ts: new Date(253402300800000) })',
  'db.orders.find({ tags: { $size: 2, $all: ["a", "b"] } })',
  'db.orders.find({ scores: { $elemMatch: { $gt: 5, $lt: 9 } } })',
  'db.orders.find({ items: { $elemMatch: { sku: "A1", qty: { $gt: 2 } } } })',
  'db.orders.find({ $or: [ { status: "open" }, { $nor: [ { total: { $lt: 5 } } ] } ] })',
  'db.orders.find({ price: { $not: { $gt: 5 } } })',
  'db.orders.find({ $expr: { $gt: ["$a", "$b"] } })',
  'db.orders.find({}, { tags: { $slice: 5 } })',
  'db.orders.aggregate([{ $addFields: { flag: true } }])',
  'db.orders.aggregate([{ $match: { total: { $gt: 1 } } }, { $group: { _id: "$status", n: { $sum: 1 }, avg: { $avg: "$total" } } }, { $sort: { n: -1 } }, { $limit: 3 }])',
  'db.orders.aggregate([{ $unwind: { path: "$items", preserveNullAndEmptyArrays: true } }, { $count: "n" }])',
  'db.orders.aggregate([{ $lookup: { from: "customers", localField: "cid", foreignField: "_id", as: "c" } }, { $skip: 1 }, { $project: { c: 1 } }])',
];

describe('query builder round trip, model to text to model', () => {
  it.each(SAMPLES)('%s', (_name, statement) => {
    expectModelRoundTrip(statement);
  });
});

describe('query builder round trip, text to model to text', () => {
  it.each(TEXTS)('%s', (text) => {
    expectTextRoundTrip(text);
  });
});

describe('query builder round trip, raw items', () => {
  it.each<[string, QueryStatement]>([
    ['raw condition $not', find({ filter: group('and', rawCond('price', '$not', { $gt: 5 })) })],
    ['raw condition $mod', find({ filter: group('and', rawCond('qty', '$mod', [4, 0])) })],
    [
      'raw fragment $expr',
      find({ filter: group('and', rawFragment('$expr', { $gt: ['$a', '$b'] })) }),
    ],
    ['raw fragment $text', find({ filter: group('and', rawFragment('$text', { $search: 'x' })) })],
    ['raw fragment $where', find({ filter: group('and', rawFragment('$where', 'this.a > 1')) })],
    ['raw projection row with $slice', find({ projection: [rawRow('tags', { $slice: 5 })] })],
    [
      'raw projection row with $meta',
      find({ projection: [field('name', true), rawRow('score', { $meta: 'textScore' })] }),
    ],
    [
      'raw stage $addFields',
      aggregate([stage({ stage: 'raw', name: '$addFields', value: { flag: true } })]),
    ],
    [
      'raw stage $facet',
      aggregate([stage({ stage: 'raw', name: '$facet', value: { a: [{ $count: 'n' }] } })]),
    ],
    [
      'raw stage $lookup with a pipeline',
      aggregate([
        stage({
          stage: 'raw',
          name: '$lookup',
          value: { from: 'customers', pipeline: [{ $match: { x: 1 } }], as: 'c' },
        }),
      ]),
    ],
    [
      'raw stage $group with an accumulator outside the model',
      aggregate([
        stage({
          stage: 'raw',
          name: '$group',
          value: { _id: null, sd: { $stdDevPop: '$total' } },
        }),
      ]),
    ],
    [
      'raw stage $sort with a direction other than 1 or -1',
      aggregate([stage({ stage: 'raw', name: '$sort', value: { a: 2 } })]),
    ],
    [
      'raw stage $limit with a string',
      aggregate([stage({ stage: 'raw', name: '$limit', value: '5' })]),
    ],
    [
      'raw stage $unwind with a path without $',
      aggregate([stage({ stage: 'raw', name: '$unwind', value: { path: 'items' } })]),
    ],
  ])('%s', (_name, statement) => {
    expectModelRoundTrip(statement);
  });
});

describe('query builder round trip, known limits', () => {
  it('reads NumberInt(5) back as the plain number 5', () => {
    // Known limit of formatMongoshSyntax: it writes `$numberInt` as a bare number, so the int32
    // type is lost on write-back. This asserts the current behaviour. Change it when the type is kept.
    const model = readBack('db.orders.find({ n: NumberInt(5) })');
    expect(model).toEqual(find({ filter: group('and', cond('n', 'eq', { $numberInt: '5' })) }));
    expect(readBack(emitStatement(model))).toEqual(
      find({ filter: group('and', cond('n', 'eq', 5)) }),
    );
  });
});

describe('query builder round trip, disabled items', () => {
  it.each<[string, QueryStatement]>([
    [
      'disabled condition',
      find({
        filter: group('and', cond('status', 'eq', 'open'), cond('region', 'eq', 'eu', false)),
      }),
    ],
    [
      'disabled condition that is the only item',
      find({ filter: group('and', cond('region', 'eq', 'eu', false)) }),
    ],
    [
      'disabled regex condition',
      find({ filter: group('and', regex('name', '^a', 'i', false), cond('total', 'gt', 1)) }),
    ],
    [
      'disabled elemMatch condition',
      find({
        filter: group(
          'and',
          elemMatch('items', group('and', cond('sku', 'eq', 'A1')), false),
          cond('total', 'gt', 1),
        ),
      }),
    ],
    [
      'disabled condition inside a scalar elemMatch',
      find({
        filter: group(
          'and',
          elemMatch(
            'scores',
            group(
              'and',
              cond(ARRAY_ELEMENT_FIELD, 'gt', 5),
              cond(ARRAY_ELEMENT_FIELD, 'lt', 9, false),
            ),
          ),
        ),
      }),
    ],
    [
      'disabled condition inside an object elemMatch',
      find({
        filter: group(
          'and',
          elemMatch('items', group('and', cond('sku', 'eq', 'A1'), cond('qty', 'gt', 2, false))),
        ),
      }),
    ],
    [
      'or group with every item disabled',
      find({
        filter: group(
          'and',
          cond('status', 'eq', 'open'),
          group('or', group('and', cond('a', 'eq', 1, false))),
        ),
      }),
    ],
    [
      'disabled raw condition',
      find({
        filter: group('and', rawCond('price', '$not', { $gt: 5 }, false), cond('a', 'eq', 1)),
      }),
    ],
    [
      'disabled raw fragment',
      find({
        filter: group(
          'and',
          rawFragment('$expr', { $gt: ['$a', '$b'] }, false),
          cond('a', 'eq', 1),
        ),
      }),
    ],
    [
      'disabled projection field row',
      find({ projection: [field('name', true, false), field('_id', false)] }),
    ],
    [
      'disabled raw projection row',
      find({ projection: [rawRow('tags', { $slice: 5 }, false), field('name', true)] }),
    ],
    ['disabled sort row', find({ sort: [sort('total', -1, false), sort('name', 1)] })],
    ['sort with every row disabled', find({ sort: [sort('total', -1, false)] })],
    [
      'disabled find filter condition in a projection-only find',
      find({
        filter: group('and', cond('a', 'eq', 1, false)),
        projection: [field('name', true)],
      }),
    ],
    [
      'disabled aggregate stage',
      aggregate([
        stage({ stage: '$match', filter: group('and', cond('x', 'eq', 1)) }, false),
        stage({ stage: '$limit', count: 3 }),
      ]),
    ],
    [
      'disabled raw aggregate stage',
      aggregate([stage({ stage: 'raw', name: '$addFields', value: { flag: true } }, false)]),
    ],
    [
      'disabled $project stage',
      aggregate([stage({ stage: '$project', rows: [field('name', true)] }, false)]),
    ],
    [
      '$project stage with every row disabled',
      aggregate([stage({ stage: '$project', rows: [field('name', true, false)] })]),
    ],
    [
      'disabled row of a $sort stage',
      aggregate([stage({ stage: '$sort', rows: [sort('total', -1, false), sort('name', 1)] })]),
    ],
    [
      'disabled condition inside a $match stage',
      aggregate([
        stage({
          stage: '$match',
          filter: group('and', cond('total', 'gt', 1), cond('x', 'eq', 1, false)),
        }),
      ]),
    ],
  ])('%s', (_name, statement) => {
    expectModelRoundTrip(statement);
  });
});
