/**
 * The query builder model: the parts of a find or aggregate statement and the filter tree. The
 * builder edits this tree. The parser and the emitter turn it to and from statement text. Every
 * value is canonical EJSON, as the router sends it, for example `{ "$oid": "..." }`.
 */

export const GROUP_OPERATORS = ['and', 'or', 'nor'] as const;
export type GroupOperator = (typeof GROUP_OPERATORS)[number];

/** Every condition operator the builder knows. The order is the order of the operator menu. */
export const CONDITION_OPERATORS = [
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
  'size',
  'all',
  'elemMatch',
] as const;
export type ConditionOperator = (typeof CONDITION_OPERATORS)[number];

/** The field name that stands for the element of an array of scalars inside `$elemMatch`. */
export const ARRAY_ELEMENT_FIELD = '<Array Element>';

/** A field compared with one value. A disabled condition is left out of the statement text. */
export interface ValueCondition {
  readonly kind: 'condition';
  readonly enabled: boolean;
  readonly field: string;
  readonly operator: Exclude<ConditionOperator, 'regex' | 'elemMatch'>;
  readonly value: unknown;
}

/** A `$regex` condition with its `$options`. */
export interface RegexCondition {
  readonly kind: 'condition';
  readonly enabled: boolean;
  readonly field: string;
  readonly operator: 'regex';
  readonly pattern: string;
  readonly options: string;
}

/** An `$elemMatch` condition. Its group holds the conditions on the array element. */
export interface ElemMatchCondition {
  readonly kind: 'condition';
  readonly enabled: boolean;
  readonly field: string;
  readonly operator: 'elemMatch';
  readonly group: QueryGroup;
}

export type QueryCondition = ValueCondition | RegexCondition | ElemMatchCondition;

/**
 * One operator the model does not know, such as `$not` or `$mod`. Emitted unchanged unless
 * disabled.
 */
export interface RawCondition {
  readonly kind: 'rawCondition';
  readonly enabled: boolean;
  readonly field: string;
  readonly operator: string;
  readonly value: unknown;
}

/**
 * One top-level key the model does not know, such as `$expr` or `$where`. Emitted unchanged unless
 * disabled.
 */
export interface RawFragment {
  readonly kind: 'rawFragment';
  readonly enabled: boolean;
  readonly key: string;
  readonly value: unknown;
}

/** Items joined by one logical operator. Each child of an `$or` or `$nor` is a group. */
export interface QueryGroup {
  readonly kind: 'group';
  readonly operator: GroupOperator;
  readonly items: readonly QueryItem[];
}

export type QueryItem = QueryCondition | RawCondition | RawFragment | QueryGroup;

/** A projection row. A raw row holds any value other than `1`, `0`, `true` or `false`. */
export type ProjectionRow =
  | {
      readonly kind: 'field';
      readonly enabled: boolean;
      readonly field: string;
      readonly include: boolean;
    }
  | {
      readonly kind: 'raw';
      readonly enabled: boolean;
      readonly field: string;
      readonly value: unknown;
    };

export interface SortRow {
  readonly enabled: boolean;
  readonly field: string;
  readonly direction: 1 | -1;
}

export const ACCUMULATORS = [
  '$sum',
  '$avg',
  '$min',
  '$max',
  '$first',
  '$last',
  '$push',
  '$addToSet',
] as const;
export type Accumulator = (typeof ACCUMULATORS)[number];

/** One output field of a `$group` stage. */
export interface AccumulatorRow {
  readonly output: string;
  readonly accumulator: Accumulator;
  readonly expression: unknown;
}

/** The body of an aggregation stage. The `stage` field names the stage operator. */
export type StageBody =
  | { readonly stage: '$match'; readonly filter: QueryGroup }
  | { readonly stage: '$project'; readonly rows: readonly ProjectionRow[] }
  | { readonly stage: '$sort'; readonly rows: readonly SortRow[] }
  | { readonly stage: '$limit' | '$skip'; readonly count: number }
  | { readonly stage: '$count'; readonly output: string }
  | { readonly stage: '$unwind'; readonly path: string; readonly preserveEmpty: boolean }
  | {
      readonly stage: '$group';
      readonly id: unknown;
      readonly accumulators: readonly AccumulatorRow[];
    }
  | {
      readonly stage: '$lookup';
      readonly from: string;
      readonly localField: string;
      readonly foreignField: string;
      readonly as: string;
    }
  /** Any other stage, such as `$addFields` or a `$lookup` with a pipeline. */
  | { readonly stage: 'raw'; readonly name: string; readonly value: unknown };

export type PipelineStage = StageBody & { readonly enabled: boolean };

export interface FindStatement {
  readonly kind: 'find';
  readonly collection: string;
  /** An empty group is the filter `{}`. */
  readonly filter: QueryGroup;
  readonly projection: readonly ProjectionRow[];
  readonly sort: readonly SortRow[];
  readonly skip: number | null;
  readonly limit: number | null;
}

export interface AggregateStatement {
  readonly kind: 'aggregate';
  readonly collection: string;
  readonly stages: readonly PipelineStage[];
}

export type QueryStatement = FindStatement | AggregateStatement;

/** A field of a collection with the BSON type names seen for it, such as `String` or `Array`. */
export interface FieldInfo {
  /** Dot path. Array elements appear as `path[]`, as in the schema sample. */
  readonly path: string;
  readonly types: readonly string[];
}
