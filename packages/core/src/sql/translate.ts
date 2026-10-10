/**
 * Turns one parsed T-SQL statement into a mongosh statement tree. SELECT becomes `find` when the
 * query only filters, projects, sorts and limits, and an `aggregate` pipeline otherwise. UPDATE,
 * DELETE and INSERT become `updateMany`, `deleteMany` and `insertMany`. Everything the subset
 * cannot express throws a `SqlError` that points at the clause.
 */

import {
  SqlError,
  type BinaryOperator,
  type CallExpression,
  type CastExpression,
  type ColumnRef,
  type DeleteStatement,
  type Expression,
  type InExpression,
  type InsertStatement,
  type JoinClause,
  type OrderItem,
  type SelectColumn,
  type SelectStatement,
  type Span,
  type SqlStatement,
  type SqlType,
  type UpdateStatement,
} from './ast';
import {
  SPECIAL,
  isMongoSpecial,
  mongoDate,
  mongoNow,
  mongoObjectId,
  mongoRegex,
  type MongoChainCall,
  type MongoObject,
  type MongoSpecial,
  type MongoStatement,
  type MongoValue,
} from './mongo-model';

/** The type of a field as the schema sampler saw it. */
export type FieldTypeHint = 'date' | 'objectId' | 'number' | 'string' | 'bool';

export interface TranslateOptions {
  /**
   * The type of a field from the sampled schema, so a string literal compared to a date or id field
   * is coerced. `path` is dotted and relative to the collection's documents.
   */
  readonly fieldType?: (collection: string, path: string) => FieldTypeHint | undefined;
}

const AGGREGATE_FUNCTIONS = new Set(['COUNT', 'SUM', 'AVG', 'MIN', 'MAX']);
const NOW_FUNCTIONS = new Set(['GETDATE', 'GETUTCDATE', 'SYSDATETIME', 'CURRENT_TIMESTAMP']);
const STRING_FUNCTIONS = new Set([
  'UPPER',
  'LOWER',
  'LTRIM',
  'RTRIM',
  'TRIM',
  'SUBSTRING',
  'CONCAT',
  'REPLACE',
]);
const NUMERIC_TEXT = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const INTEGER_TEXT = /^[+-]?\d+$/;
/** The time of day and offset that may follow a calendar date. Groups: hour, minute, second, fraction, offset. */
const TIME_TEXT =
  '(?:[T ](\\d{1,2}):(\\d{2})(?::(\\d{2})(?:\\.(\\d+))?)?)? ?(Z|[+-]\\d{2}:?\\d{2})?';
/**
 * A date or date-time as SQL Server users write it: `2026-01-02`, `2026-01-02 10:30`,
 * `2026-01-02T10:30:00.123`, with an optional `Z` or `+01:00` offset. Groups: year, month, day,
 * hour, minute, second, fraction, offset.
 */
const ISO_DATE_TEXT = new RegExp(`^(\\d{4})-(\\d{1,2})-(\\d{1,2})${TIME_TEXT}$`, 'i');
/**
 * The US form SQL Server reads under its default language: `1/2/2026` is January 2. Groups: month,
 * day, year, then the time groups.
 */
const US_DATE_TEXT = new RegExp(`^(\\d{1,2})/(\\d{1,2})/(\\d{4})${TIME_TEXT}$`, 'i');
const MILLISECONDS_PER_DAY = 86_400_000;
/** SQL Server counts a number cast to DATETIME as days since this date. */
const SQL_SERVER_EPOCH = Date.UTC(1900, 0, 1);
const OBJECT_ID_TEXT = /^[0-9a-fA-F]{24}$/;
const AGGREGATE_ERROR = 'aggregate functions need GROUP BY';
const ORDER_ERROR = 'ORDER BY must name a column, a select alias or an aggregate';
const UNIT_ERROR =
  'unit must be year, quarter, month, week, day, hour, minute, second or millisecond';

function groupError(column: ColumnRef): SqlError {
  return new SqlError(
    `column ${columnText(column)} must appear in GROUP BY or inside an aggregate function`,
    column.span,
  );
}

const DATE_UNITS: Readonly<Record<string, string>> = {
  year: 'year',
  yy: 'year',
  yyyy: 'year',
  quarter: 'quarter',
  qq: 'quarter',
  q: 'quarter',
  month: 'month',
  mm: 'month',
  m: 'month',
  week: 'week',
  wk: 'week',
  ww: 'week',
  day: 'day',
  dd: 'day',
  d: 'day',
  hour: 'hour',
  hh: 'hour',
  minute: 'minute',
  mi: 'minute',
  n: 'minute',
  second: 'second',
  ss: 'second',
  s: 'second',
  millisecond: 'millisecond',
  ms: 'millisecond',
};

/** Translates one statement. Throws `SqlError` with the span of the offending node. */
export function translateStatement(
  statement: SqlStatement,
  options: TranslateOptions = {},
): MongoStatement {
  switch (statement.kind) {
    case 'select':
      return translateSelect(statement, options);
    case 'update':
      return translateUpdate(statement, options);
    case 'delete':
      return translateDelete(statement, options);
    case 'insert':
      return translateInsert(statement, options);
  }
}

// Names and scope

interface JoinScope {
  /** The `as` field of the `$lookup`, the alias or the table name. */
  readonly alias: string;
  readonly table: string;
  readonly index: number;
}

interface Scope {
  readonly collection: string;
  readonly baseAlias: string;
  readonly joins: ReadonlyMap<string, JoinScope>;
  readonly fieldType: TranslateOptions['fieldType'];
}

interface ResolvedColumn {
  /** The path in the pipeline document, with the join alias prefix for joined columns. */
  readonly path: string;
  /** The path inside its own collection, used for type hints and `foreignField`. */
  readonly local: string;
  readonly join: JoinScope | undefined;
  readonly hint: FieldTypeHint | undefined;
}

function tableScope(
  table: { readonly name: string; readonly alias: string | undefined },
  joins: readonly JoinClause[],
  options: TranslateOptions,
): Scope {
  const map = new Map<string, JoinScope>();
  joins.forEach((join, index) => {
    const alias = join.table.alias ?? join.table.name;
    map.set(alias, { alias, table: join.table.name, index });
  });
  const scope: Scope = {
    collection: table.name,
    baseAlias: table.alias ?? table.name,
    joins: map,
    fieldType: options.fieldType,
  };
  return scope;
}

function columnText(column: ColumnRef): string {
  return column.parts.join('.');
}

function resolveColumn(column: ColumnRef, scope: Scope): ResolvedColumn {
  for (const part of column.parts) {
    if (part.startsWith('$')) {
      throw new SqlError(`column name ${part} may not start with $`, column.span);
    }
    if (part.includes('.')) {
      throw new SqlError(`column name part ${part} may not contain a dot`, column.span);
    }
  }
  const [first, ...rest] = column.parts;
  if (first === undefined) {
    throw new SqlError('column name is empty', column.span);
  }
  const join = scope.joins.get(first);
  if (join) {
    if (rest.length === 0) {
      throw new SqlError(`${first} is a table alias, not a column`, column.span);
    }
    const local = rest.join('.');
    return {
      path: `${join.alias}.${local}`,
      local,
      join,
      hint: scope.fieldType?.(join.table, local),
    };
  }
  const parts = first === scope.baseAlias ? rest : column.parts;
  if (parts.length === 0) {
    throw new SqlError(`${first} is a table alias, not a column`, column.span);
  }
  const path = parts.join('.');
  return { path, local: path, join: undefined, hint: scope.fieldType?.(scope.collection, path) };
}

function lastPart(path: string): string {
  return path.slice(path.lastIndexOf('.') + 1);
}

interface NameSet {
  readonly claim: (base: string) => string;
  readonly has: (name: string) => boolean;
}

/** Hands out unique output names: a used base name gets 2, 3 and so on appended. */
function nameSet(): NameSet {
  const used = new Set<string>();
  return {
    claim(base) {
      let name = base;
      for (let n = 2; used.has(name); n += 1) {
        name = `${base}${n}`;
      }
      used.add(name);
      return name;
    },
    has: (name) => used.has(name),
  };
}

/**
 * Claims every explicit select alias before any default name is handed out, so when two columns
 * contend for one output name the one the user typed keeps it and the implicit one is renumbered.
 * Returns the claimed name per select column, undefined for a column without an alias.
 */
function claimAliases(columns: readonly SelectColumn[], names: NameSet): (string | undefined)[] {
  return columns.map((column) =>
    column.kind === 'expression' && column.alias !== undefined
      ? names.claim(column.alias)
      : undefined,
  );
}

/** Replaces every occurrence of `from` inside a value tree, compared structurally. */
function replaceValue(value: MongoValue, from: MongoValue, to: MongoValue): MongoValue {
  if (sameValue(value, from)) {
    return to;
  }
  if (isArray(value)) {
    return value.map((item) => replaceValue(item, from, to));
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, replaceValue(item, from, to)]),
    );
  }
  return value;
}

// Expression tree helpers

function children(expression: Expression): readonly Expression[] {
  switch (expression.kind) {
    case 'column':
    case 'literal':
      return [];
    case 'binary':
      return [expression.left, expression.right];
    case 'unary':
      return [expression.operand];
    case 'in':
      return [expression.expression, ...expression.values];
    case 'between':
      return [expression.expression, expression.low, expression.high];
    case 'like':
      return [expression.expression, expression.pattern];
    case 'isNull':
      return [expression.expression];
    case 'call':
      return expression.args;
    case 'case':
      return [
        ...(expression.operand ? [expression.operand] : []),
        ...expression.whens.flatMap((when) => [when.when, when.then]),
        ...(expression.else ? [expression.else] : []),
      ];
    case 'cast':
      return [expression.expression];
  }
}

function someNode(expression: Expression, test: (node: Expression) => boolean): boolean {
  return test(expression) || children(expression).some((child) => someNode(child, test));
}

function isAggregateCall(expression: Expression): expression is CallExpression {
  return expression.kind === 'call' && AGGREGATE_FUNCTIONS.has(expression.name);
}

function containsAggregate(expression: Expression): boolean {
  return someNode(expression, isAggregateCall);
}

function flattenLogical(expression: Expression, operator: 'and' | 'or'): Expression[] {
  if (expression.kind === 'binary' && expression.operator === operator) {
    return [
      ...flattenLogical(expression.left, operator),
      ...flattenLogical(expression.right, operator),
    ];
  }
  return [expression];
}

function flattenPlus(expression: Expression): Expression[] {
  if (expression.kind === 'binary' && expression.operator === '+') {
    return [...flattenPlus(expression.left), ...flattenPlus(expression.right)];
  }
  return [expression];
}

function isStringy(expression: Expression, scope: Scope): boolean {
  switch (expression.kind) {
    case 'literal':
      return typeof expression.value === 'string';
    case 'column':
      return resolveColumn(expression, scope).hint === 'string';
    case 'binary':
      return (
        expression.operator === '+' &&
        (isStringy(expression.left, scope) || isStringy(expression.right, scope))
      );
    case 'call':
      return STRING_FUNCTIONS.has(expression.name);
    case 'cast':
      return expression.type === 'string';
    default:
      return false;
  }
}

function isArray(value: MongoValue): value is readonly MongoValue[] {
  return Array.isArray(value);
}

function isPlainObject(value: MongoValue): value is MongoObject {
  return typeof value === 'object' && value !== null && !isArray(value) && !isMongoSpecial(value);
}

function specialKey(special: MongoSpecial): string {
  switch (special[SPECIAL]) {
    case 'date':
      return `date:${special.iso}`;
    case 'now':
      return 'now';
    case 'objectId':
      return `objectId:${special.hex}`;
    case 'regex':
      return `regex:${special.options}:${special.pattern}`;
  }
}

/** Structural equality over output values, so an ORDER BY expression can be matched to a column. */
function sameValue(a: MongoValue, b: MongoValue): boolean {
  if (a === b) {
    return true;
  }
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
    return false;
  }
  if (isArray(a) || isArray(b)) {
    return (
      isArray(a) &&
      isArray(b) &&
      a.length === b.length &&
      a.every((item, index) => {
        const other = b[index];
        return other !== undefined && sameValue(item, other);
      })
    );
  }
  if (isMongoSpecial(a) || isMongoSpecial(b)) {
    return isMongoSpecial(a) && isMongoSpecial(b) && specialKey(a) === specialKey(b);
  }
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  return (
    keysA.length === keysB.length &&
    keysA.every((key) => {
      const valueB = b[key];
      const valueA = a[key];
      return valueA !== undefined && valueB !== undefined && sameValue(valueA, valueB);
    })
  );
}

// Literals, casts and type hints

/**
 * What a literal is compared with or written to: a sampled field type, or `dateOnly` for the other
 * side of a CAST to DATE, whose time of day SQL Server drops.
 */
type LiteralHint = FieldTypeHint | 'dateOnly';

/** Applies the type of the other side to a literal, as SQL Server converts it before comparing. */
function coerceLiteral(
  value: string | number | boolean | null,
  hint: LiteralHint | undefined,
  span: Span,
): MongoValue {
  if (hint === 'bool') {
    if (value === 'true' || value === 1) {
      return true;
    }
    if (value === 'false' || value === 0) {
      return false;
    }
    return value;
  }
  if (hint === 'string' && typeof value === 'number') {
    return String(value);
  }
  if (typeof value !== 'string') {
    return value;
  }
  switch (hint) {
    case 'date':
      return parseDate(value, span);
    case 'dateOnly':
      return startOfDay(parseDate(value, span));
    case 'objectId':
      return OBJECT_ID_TEXT.test(value) ? mongoObjectId(value) : value;
    case 'number':
      return NUMERIC_TEXT.test(value) && Number.isFinite(Number(value)) ? Number(value) : value;
    default:
      return value;
  }
}

/** Drops the time of day, as a CAST to DATE does. */
function startOfDay(date: MongoSpecial): MongoSpecial {
  if (date[SPECIAL] !== 'date') {
    return date;
  }
  const time = new Date(date.iso).getTime();
  return mongoDate(new Date(time - (time % MILLISECONDS_PER_DAY)).toISOString());
}

/** Years below 100 go through the setter, since `Date.UTC` would read them as 19xx. */
function utcTime(
  fields: readonly [number, number, number, number, number, number, number],
): number {
  const [year, month, day, hour, minute, second, millisecond] = fields;
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, millisecond);
  return date.getTime();
}

function daysInMonth(year: number, month: number): number {
  return new Date(utcTime([year, month + 1, 0, 0, 0, 0, 0])).getUTCDate();
}

/**
 * Parses a date literal in the ISO shape or the US `m/d/yyyy` shape. A SQL Server datetime has no
 * time zone, so a text without an offset is read as UTC rather than as the machine's local time,
 * and the calendar fields must exist: a February 30 is refused instead of rolled over into March.
 * Any other shape is refused, since the runtime's own parser reads it in the machine's zone and
 * the output would differ per machine.
 */
function parseDate(text: string, span: Span): MongoSpecial {
  const invalid = (): SqlError => new SqlError(`'${text}' is not a valid date`, span);
  const trimmed = text.trim();
  const iso = ISO_DATE_TEXT.exec(trimmed);
  const us = iso ? undefined : US_DATE_TEXT.exec(trimmed);
  const match = iso ?? us;
  if (!match) {
    throw invalid();
  }
  const field = (index: number, fallback = '0'): number => Number(match[index] ?? fallback);
  const [y, mo, d] = iso ? [field(1), field(2), field(3)] : [field(3), field(1), field(2)];
  const [h, mi, sec] = [field(4), field(5), field(6)];
  const fraction = match[7] ?? '0';
  const offset = match[8];
  if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo) || h > 23 || mi > 59 || sec > 59) {
    throw invalid();
  }
  const milliseconds = Number(fraction.slice(0, 3).padEnd(3, '0'));
  let time = utcTime([y, mo, d, h, mi, sec, milliseconds]);
  if (offset !== undefined && offset.toUpperCase() !== 'Z') {
    const sign = offset.startsWith('-') ? -1 : 1;
    const digits = offset.slice(1).replace(':', '');
    const minutes = Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2));
    time -= sign * minutes * 60_000;
  }
  return mongoDate(new Date(time).toISOString());
}

/** A string literal in a date position is converted implicitly, as SQL Server does. */
function dateArg(expression: Expression, ctx: ExprContext): MongoValue {
  if (expression.kind === 'literal' && typeof expression.value === 'string') {
    return parseDate(expression.value, expression.span);
  }
  return toExpr(expression, ctx);
}

/**
 * Folds a CAST whose operand is already a constant. Returns undefined when the cast only makes
 * sense as an aggregation expression, such as a string cast of GETDATE().
 */
function castConstant(type: SqlType, value: MongoValue, span: Span): MongoValue | undefined {
  if (value === null) {
    return null;
  }
  switch (type) {
    case 'date':
    case 'datetime': {
      const date = castDate(type, value, span);
      return type === 'date' && isMongoSpecial(date) ? startOfDay(date) : date;
    }
    case 'objectId':
      if (isMongoSpecial(value) && value[SPECIAL] === 'objectId') {
        return value;
      }
      if (typeof value === 'string' && OBJECT_ID_TEXT.test(value)) {
        return mongoObjectId(value);
      }
      throw new SqlError('not a valid ObjectId: expected 24 hex characters', span);
    case 'int':
    case 'bigint':
    case 'float':
    case 'decimal': {
      const whole = type === 'int' || type === 'bigint';
      if (typeof value === 'number') {
        return whole ? Math.trunc(value) : value;
      }
      if (typeof value === 'boolean') {
        return value ? 1 : 0;
      }
      if (typeof value === 'string') {
        const text = value.trim();
        // SQL Server converts an empty or blank string to 0 for every numeric type.
        if (text === '') {
          return 0;
        }
        if (whole ? INTEGER_TEXT.test(text) : NUMERIC_TEXT.test(text)) {
          const number = Number(text);
          if (!Number.isFinite(number)) {
            throw new SqlError('the floating point value is out of range', span);
          }
          return number;
        }
      }
      if (isMongoSpecial(value)) {
        return undefined;
      }
      throw new SqlError('not a valid number', span);
    }
    case 'bit':
      if (typeof value === 'boolean') {
        return value;
      }
      if (typeof value === 'number') {
        return value !== 0;
      }
      if (typeof value === 'string') {
        const text = value.trim().toLowerCase();
        if (text === 'true' || text === '1') {
          return true;
        }
        if (text === 'false' || text === '0' || text === '') {
          return false;
        }
      }
      if (isMongoSpecial(value)) {
        return undefined;
      }
      throw new SqlError('not a valid bit', span);
    case 'string':
      if (typeof value === 'string') {
        return value;
      }
      if (typeof value === 'number' || typeof value === 'boolean') {
        return String(value);
      }
      return undefined;
  }
}

/** A constant cast to DATE or DATETIME. A number counts days since the SQL Server epoch. */
function castDate(type: 'date' | 'datetime', value: MongoValue, span: Span): MongoValue {
  if (isMongoSpecial(value) && (value[SPECIAL] === 'date' || value[SPECIAL] === 'now')) {
    return value;
  }
  if (typeof value === 'string') {
    return parseDate(value, span);
  }
  if (typeof value === 'number') {
    if (type === 'date') {
      throw new SqlError('a number cannot be cast to DATE, cast it to DATETIME', span);
    }
    const time = Math.round(SQL_SERVER_EPOCH + value * MILLISECONDS_PER_DAY);
    return mongoDate(new Date(time).toISOString());
  }
  throw new SqlError('not a valid date', span);
}

function castOperator(type: SqlType): string {
  switch (type) {
    case 'int':
      return '$toInt';
    case 'bigint':
      return '$toLong';
    case 'float':
      return '$toDouble';
    case 'decimal':
      return '$toDecimal';
    case 'bit':
      return '$toBool';
    case 'date':
    case 'datetime':
      return '$toDate';
    case 'string':
      return '$toString';
    case 'objectId':
      return '$toObjectId';
  }
}

/**
 * The value of an expression that is a constant: a literal, a negated number, GETDATE() or a CAST
 * of one of those. Returns undefined for anything that needs an aggregation expression.
 */
function constantOf(
  expression: Expression,
  scope: Scope,
  hint: LiteralHint | undefined,
): MongoValue | undefined {
  switch (expression.kind) {
    case 'literal':
      return coerceLiteral(expression.value, hint, expression.span);
    case 'unary':
      if (
        expression.operator === 'negate' &&
        expression.operand.kind === 'literal' &&
        typeof expression.operand.value === 'number'
      ) {
        return -expression.operand.value;
      }
      return undefined;
    case 'call':
      if (NOW_FUNCTIONS.has(expression.name)) {
        checkArity(expression, 0, 0);
        return mongoNow();
      }
      return undefined;
    case 'cast': {
      const inner = constantOf(expression.expression, scope, undefined);
      return inner === undefined
        ? undefined
        : castConstant(expression.type, inner, expression.span);
    }
    default:
      return undefined;
  }
}

/** A string that starts with `$` would read as a field path inside a pipeline, so wrap it. */
function literalValue(value: MongoValue): MongoValue {
  return typeof value === 'string' && value.startsWith('$') ? { $literal: value } : value;
}

/**
 * A bare number or boolean as a `$project` value means inclusion or exclusion, not a constant
 * column, so a select column that evaluates to one is wrapped in `$literal`.
 */
function projectValue(value: MongoValue): MongoValue {
  return typeof value === 'number' || typeof value === 'boolean' ? { $literal: value } : value;
}

// Aggregation expressions

interface ExprContext {
  readonly scope: Scope;
  /** Called first for every node. A value replaces the node's translation. */
  readonly rewrite?: (expression: Expression) => MongoValue | undefined;
  readonly column: (column: ColumnRef) => MongoValue;
  /** Absent when aggregate functions are not allowed in this position. */
  readonly aggregate?: (call: CallExpression) => MongoValue;
  readonly aggregateError?: string;
}

function plainContext(scope: Scope): ExprContext {
  return { scope, column: (column) => `$${resolveColumn(column, scope).path}` };
}

function checkArity(call: CallExpression, min: number, max: number): void {
  const count = call.args.length;
  if (call.star || call.distinct || count < min || count > max) {
    const expected =
      min === max
        ? `${min} argument${min === 1 ? '' : 's'}`
        : max === Number.POSITIVE_INFINITY
          ? `at least ${min} arguments`
          : `${min} or ${max} arguments`;
    throw new SqlError(`${call.name} takes ${expected}`, call.span);
  }
}

/**
 * The type a literal is compared with: the sampled type of a column, or the target type of a CAST
 * or CONVERT to DATE, DATETIME or OBJECTID. SQL Server converts the literal to that type, and a
 * string next to `$toDate` or `$toObjectId` would never match in MongoDB.
 */
function hintOf(expression: Expression, scope: Scope): LiteralHint | undefined {
  switch (expression.kind) {
    case 'column':
      return resolveColumn(expression, scope).hint;
    case 'cast':
      return castHint(expression.type);
    default:
      return undefined;
  }
}

function castHint(type: SqlType): LiteralHint | undefined {
  switch (type) {
    case 'date':
      return 'dateOnly';
    case 'datetime':
      return 'date';
    case 'objectId':
      return 'objectId';
    default:
      return undefined;
  }
}

/** Translates an operand, coercing a literal by the hint of the column it is compared with. */
function operand(expression: Expression, other: Expression, ctx: ExprContext): MongoValue {
  if (expression.kind === 'literal') {
    return literalValue(coerceLiteral(expression.value, hintOf(other, ctx.scope), expression.span));
  }
  return toExpr(expression, ctx);
}

/**
 * The members of an IN list without NULL. `x IN (1, NULL)` is `x = 1 OR x = NULL`, and the second
 * test is never true, so SQL Server returns only the rows with x = 1, while `$in` with null would
 * also return rows where x is null or missing. `NOT IN` with a NULL matches no row at all in SQL
 * Server, which is never what the user meant, so it is refused with an explanation.
 */
function inListValues(expression: InExpression): Expression[] {
  const nulls = expression.values.filter(
    (value) => value.kind === 'literal' && value.value === null,
  );
  const first = nulls[0];
  if (first && expression.negated) {
    throw new SqlError(
      'NOT IN with NULL matches no row in SQL Server, remove the NULL from the list',
      first.span,
    );
  }
  return expression.values.filter((value) => !nulls.includes(value));
}

function comparisonOperator(operator: BinaryOperator): string | undefined {
  switch (operator) {
    case '=':
      return '$eq';
    case '<>':
      return '$ne';
    case '<':
      return '$lt';
    case '<=':
      return '$lte';
    case '>':
      return '$gt';
    case '>=':
      return '$gte';
    default:
      return undefined;
  }
}

function arithmeticOperator(operator: BinaryOperator): string | undefined {
  switch (operator) {
    case '+':
      return '$add';
    case '-':
      return '$subtract';
    case '*':
      return '$multiply';
    case '/':
      return '$divide';
    case '%':
      return '$mod';
    default:
      return undefined;
  }
}

function toExpr(expression: Expression, ctx: ExprContext): MongoValue {
  const rewritten = ctx.rewrite?.(expression);
  if (rewritten !== undefined) {
    return rewritten;
  }
  switch (expression.kind) {
    case 'column':
      return ctx.column(expression);
    case 'literal':
      return literalValue(expression.value);
    case 'binary': {
      const { operator, left, right } = expression;
      if (operator === 'and' || operator === 'or') {
        return {
          [`$${operator}`]: flattenLogical(expression, operator).map((part) => toExpr(part, ctx)),
        };
      }
      const comparison = comparisonOperator(operator);
      if (comparison !== undefined) {
        return { [comparison]: [operand(left, right, ctx), operand(right, left, ctx)] };
      }
      if (operator === '+' && (isStringy(left, ctx.scope) || isStringy(right, ctx.scope))) {
        return { $concat: flattenPlus(expression).map((part) => toExpr(part, ctx)) };
      }
      const arithmetic = arithmeticOperator(operator);
      if (arithmetic === undefined) {
        throw new SqlError(`operator ${operator} is not supported`, expression.span);
      }
      return { [arithmetic]: [toExpr(left, ctx), toExpr(right, ctx)] };
    }
    case 'unary': {
      if (expression.operator === 'not') {
        return { $not: [toExpr(expression.operand, ctx)] };
      }
      const constant = constantOf(expression, ctx.scope, undefined);
      return constant === undefined
        ? { $multiply: [-1, toExpr(expression.operand, ctx)] }
        : constant;
    }
    case 'in': {
      const subject = toExpr(expression.expression, ctx);
      const values = inListValues(expression).map((value) =>
        operand(value, expression.expression, ctx),
      );
      const test = { $in: [subject, values] };
      return expression.negated ? { $not: [test] } : test;
    }
    case 'between': {
      const subject = toExpr(expression.expression, ctx);
      const test = {
        $and: [
          { $gte: [subject, operand(expression.low, expression.expression, ctx)] },
          { $lte: [subject, operand(expression.high, expression.expression, ctx)] },
        ],
      };
      return expression.negated ? { $not: [test] } : test;
    }
    case 'isNull': {
      const subject = { $ifNull: [toExpr(expression.expression, ctx), null] };
      return { [expression.negated ? '$ne' : '$eq']: [subject, null] };
    }
    case 'like': {
      const test = {
        $regexMatch: {
          input: toExpr(expression.expression, ctx),
          regex: likeRegex(expression.pattern, expression.escape),
        },
      };
      return expression.negated ? { $not: [test] } : test;
    }
    case 'call':
      return callExpr(expression, ctx);
    case 'case': {
      const branches = expression.whens.map((when) => ({
        case: expression.operand
          ? { $eq: [toExpr(expression.operand, ctx), toExpr(when.when, ctx)] }
          : toExpr(when.when, ctx),
        then: toExpr(when.then, ctx),
      }));
      return {
        $switch: { branches, default: expression.else ? toExpr(expression.else, ctx) : null },
      };
    }
    case 'cast':
      return castExpr(expression, ctx);
  }
}

function castExpr(expression: CastExpression, ctx: ExprContext): MongoValue {
  const constant = constantOf(expression, ctx.scope, undefined);
  if (constant !== undefined) {
    return literalValue(constant);
  }
  return { [castOperator(expression.type)]: toExpr(expression.expression, ctx) };
}

function dateUnit(call: CallExpression, argument: Expression): string {
  const text =
    argument.kind === 'column' && argument.parts.length === 1
      ? argument.parts[0]
      : argument.kind === 'literal' && typeof argument.value === 'string'
        ? argument.value
        : undefined;
  const unit = text === undefined ? undefined : DATE_UNITS[text.toLowerCase()];
  if (unit === undefined) {
    throw new SqlError(`${call.name} ${UNIT_ERROR}`, argument.span);
  }
  return unit;
}

function callExpr(call: CallExpression, ctx: ExprContext): MongoValue {
  if (AGGREGATE_FUNCTIONS.has(call.name)) {
    if (!ctx.aggregate) {
      throw new SqlError(ctx.aggregateError ?? AGGREGATE_ERROR, call.span);
    }
    return ctx.aggregate(call);
  }
  if (NOW_FUNCTIONS.has(call.name)) {
    checkArity(call, 0, 0);
    return '$$NOW';
  }
  const args = (): MongoValue[] => call.args.map((argument) => toExpr(argument, ctx));
  const one = (): MongoValue => {
    checkArity(call, 1, 1);
    return toExpr(call.args[0] as Expression, ctx);
  };
  switch (call.name) {
    case 'ISNULL':
      checkArity(call, 2, 2);
      return { $ifNull: args() };
    case 'COALESCE': {
      checkArity(call, 2, Number.POSITIVE_INFINITY);
      // MongoDB 4.4 accepts exactly two operands in $ifNull, so a longer list nests.
      const values = args();
      return values
        .slice(0, -1)
        .reduceRight<MongoValue>(
          (rest, value) => ({ $ifNull: [value, rest] }),
          values.at(-1) as MongoValue,
        );
    }
    case 'NULLIF': {
      checkArity(call, 2, 2);
      const [a, b] = args() as [MongoValue, MongoValue];
      return { $cond: [{ $eq: [a, b] }, null, a] };
    }
    case 'IIF':
      checkArity(call, 3, 3);
      return { $cond: args() };
    case 'UPPER':
      return { $toUpper: one() };
    case 'LOWER':
      return { $toLower: one() };
    case 'LEN':
      return { $strLenCP: one() };
    case 'LTRIM':
      return { $ltrim: { input: one() } };
    case 'RTRIM':
      return { $rtrim: { input: one() } };
    case 'TRIM':
      return { $trim: { input: one() } };
    case 'SUBSTRING': {
      checkArity(call, 3, 3);
      const [text, start, length] = call.args as [Expression, Expression, Expression];
      const from =
        start.kind === 'literal' && typeof start.value === 'number'
          ? start.value - 1
          : { $subtract: [toExpr(start, ctx), 1] };
      return { $substrCP: [toExpr(text, ctx), from, toExpr(length, ctx)] };
    }
    case 'CONCAT':
      checkArity(call, 2, Number.POSITIVE_INFINITY);
      return { $concat: args() };
    case 'REPLACE': {
      checkArity(call, 3, 3);
      const [input, find, replacement] = args() as [MongoValue, MongoValue, MongoValue];
      return { $replaceAll: { input, find, replacement } };
    }
    case 'ABS':
      return { $abs: one() };
    case 'ROUND': {
      checkArity(call, 1, 2);
      const values = args();
      return { $round: values.length === 1 ? [...values, 0] : values };
    }
    case 'FLOOR':
      return { $floor: one() };
    case 'CEILING':
      return { $ceil: one() };
    case 'YEAR':
    case 'MONTH':
    case 'DAY': {
      checkArity(call, 1, 1);
      const operator =
        call.name === 'YEAR' ? '$year' : call.name === 'MONTH' ? '$month' : '$dayOfMonth';
      return { [operator]: dateArg(call.args[0] as Expression, ctx) };
    }
    case 'DATEDIFF': {
      checkArity(call, 3, 3);
      const [unit, start, end] = call.args as [Expression, Expression, Expression];
      return {
        $dateDiff: {
          startDate: dateArg(start, ctx),
          endDate: dateArg(end, ctx),
          unit: dateUnit(call, unit),
        },
      };
    }
    case 'DATEADD': {
      checkArity(call, 3, 3);
      const [unit, amount, date] = call.args as [Expression, Expression, Expression];
      return {
        $dateAdd: {
          startDate: dateArg(date, ctx),
          unit: dateUnit(call, unit),
          amount: toExpr(amount, ctx),
        },
      };
    }
    default:
      throw new SqlError(`function ${call.name} is not supported`, call.span);
  }
}

// LIKE

function likeRegex(pattern: Expression, escape: string | undefined): MongoSpecial {
  if (pattern.kind !== 'literal' || typeof pattern.value !== 'string') {
    throw new SqlError('LIKE pattern must be a string literal', pattern.span);
  }
  return mongoRegex(likeToRegex(pattern.value, escape), 'i');
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Turns the body of a SQL Server `[...]` class into a regex class. The first member may be `]`
 * itself, as in `[]]`, which a JavaScript class must escape (an empty `[]` class matches nothing),
 * and a backslash is a plain member in SQL Server. The class `[]]` alone is written as `\\]`.
 */
function classToRegex(body: string): string {
  if (body === ']') {
    return '\\]';
  }
  const negated = body.startsWith('^') && body.length > 1;
  const members = (negated ? body.slice(1) : body).replace(/[\\\]]/g, '\\$&');
  return `[${negated ? '^' : ''}${members}]`;
}

/**
 * Turns a LIKE pattern into an anchored regular expression source. The pieces are kept apart so a
 * `%` wildcard at either end can be dropped together with its anchor without mistaking an escaped
 * character such as `\\` followed by `.*` for one.
 */
function likeToRegex(pattern: string, escape: string | undefined): string {
  const WILDCARD = '.*';
  const pieces: { text: string; wildcard: boolean }[] = [];
  const literal = (text: string): void => {
    pieces.push({ text, wildcard: false });
  };
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i] as string;
    if (escape !== undefined && char === escape) {
      const next = pattern[i + 1];
      if (next !== undefined) {
        literal(escapeRegex(next));
        i += 1;
      } else {
        literal(escapeRegex(char));
      }
    } else if (char === '%') {
      pieces.push({ text: WILDCARD, wildcard: true });
    } else if (char === '_') {
      literal('.');
    } else if (char === '[') {
      // The first member may be `]` itself, and `^` before it negates the class, so the search for
      // the closing bracket starts after that first member.
      const close = pattern.indexOf(']', pattern[i + 1] === '^' ? i + 3 : i + 2);
      if (close === -1) {
        literal('\\[');
      } else {
        literal(classToRegex(pattern.slice(i + 1, close)));
        i = close;
      }
    } else {
      literal(escapeRegex(char));
    }
  }
  let anchoredStart = true;
  let anchoredEnd = true;
  if (pieces[0]?.wildcard) {
    pieces.shift();
    anchoredStart = false;
  }
  if (pieces[pieces.length - 1]?.wildcard) {
    pieces.pop();
    anchoredEnd = false;
  }
  const body = pieces.map((piece) => piece.text).join('');
  if (body === '' && !(anchoredStart && anchoredEnd)) {
    return WILDCARD;
  }
  return `${anchoredStart ? '^' : ''}${body}${anchoredEnd ? '$' : ''}`;
}

// Query filters

interface FieldRef {
  readonly path: string;
  readonly hint: FieldTypeHint | undefined;
}

interface FilterContext {
  readonly scope: Scope;
  /** Resolves an expression that can stand as a query field, a column or a HAVING accumulator. */
  readonly field: (expression: Expression) => FieldRef | undefined;
  readonly expr: ExprContext;
}

function whereContext(scope: Scope): FilterContext {
  return {
    scope,
    field: (expression) => {
      if (expression.kind !== 'column') {
        return undefined;
      }
      const resolved = resolveColumn(expression, scope);
      return { path: resolved.path, hint: resolved.hint };
    },
    expr: plainContext(scope),
  };
}

function flipOperator(operator: BinaryOperator): BinaryOperator {
  switch (operator) {
    case '<':
      return '>';
    case '>':
      return '<';
    case '<=':
      return '>=';
    case '>=':
      return '<=';
    default:
      return operator;
  }
}

function comparisonFilter(path: string, operator: BinaryOperator, value: MongoValue): MongoObject {
  if (operator === '=') {
    return { [path]: value };
  }
  const mongo = comparisonOperator(operator) as string;
  return { [path]: { [mongo]: value } };
}

function isOperatorObject(value: MongoValue): boolean {
  if (isMongoSpecial(value)) {
    return value[SPECIAL] === 'regex';
  }
  return isPlainObject(value) && Object.keys(value).every((key) => key.startsWith('$'));
}

function negateFilter(filter: MongoObject): MongoObject {
  const keys = Object.keys(filter);
  const key = keys[0];
  if (keys.length === 1 && key !== undefined && !key.startsWith('$')) {
    const value = filter[key] as MongoValue;
    if (isOperatorObject(value)) {
      return { [key]: { $not: value } };
    }
  }
  return { $nor: [filter] };
}

/** Merges AND conjuncts into one document when their keys differ, else wraps them in `$and`. */
function mergeAnd(filters: readonly MongoObject[]): MongoObject {
  if (filters.length === 1) {
    return filters[0] as MongoObject;
  }
  const merged: Record<string, MongoValue> = {};
  for (const filter of filters) {
    for (const [key, value] of Object.entries(filter)) {
      if (key in merged) {
        return { $and: filters };
      }
      merged[key] = value;
    }
  }
  return merged;
}

function toFilter(expression: Expression, ctx: FilterContext): MongoObject {
  switch (expression.kind) {
    case 'binary': {
      const { operator, left, right } = expression;
      if (operator === 'and') {
        return mergeAnd(flattenLogical(expression, 'and').map((part) => toFilter(part, ctx)));
      }
      if (operator === 'or') {
        return { $or: flattenLogical(expression, 'or').map((part) => toFilter(part, ctx)) };
      }
      if (comparisonOperator(operator) !== undefined) {
        const leftField = ctx.field(left);
        const rightValue = leftField ? constantOf(right, ctx.scope, leftField.hint) : undefined;
        if (leftField && rightValue !== undefined) {
          return comparisonFilter(leftField.path, operator, rightValue);
        }
        const rightField = ctx.field(right);
        const leftValue = rightField ? constantOf(left, ctx.scope, rightField.hint) : undefined;
        if (rightField && leftValue !== undefined) {
          return comparisonFilter(rightField.path, flipOperator(operator), leftValue);
        }
      }
      break;
    }
    case 'unary':
      if (expression.operator === 'not') {
        return negateFilter(toFilter(expression.operand, ctx));
      }
      break;
    case 'in': {
      const field = ctx.field(expression.expression);
      if (field) {
        const values = inListValues(expression).map((value) =>
          constantOf(value, ctx.scope, field.hint),
        );
        if (values.every((value) => value !== undefined)) {
          return { [field.path]: { [expression.negated ? '$nin' : '$in']: values } };
        }
      }
      break;
    }
    case 'between': {
      const field = ctx.field(expression.expression);
      const low = field ? constantOf(expression.low, ctx.scope, field.hint) : undefined;
      const high = field ? constantOf(expression.high, ctx.scope, field.hint) : undefined;
      if (field && low !== undefined && high !== undefined) {
        const range = { $gte: low, $lte: high };
        return { [field.path]: expression.negated ? { $not: range } : range };
      }
      break;
    }
    case 'isNull': {
      const field = ctx.field(expression.expression);
      if (field) {
        return { [field.path]: expression.negated ? { $ne: null } : null };
      }
      break;
    }
    case 'like': {
      const regex = likeRegex(expression.pattern, expression.escape);
      const field = ctx.field(expression.expression);
      if (field) {
        return { [field.path]: expression.negated ? { $not: regex } : regex };
      }
      break;
    }
    default:
      break;
  }
  return { $expr: toExpr(expression, ctx.expr) };
}

// SELECT

function translateSelect(statement: SelectStatement, options: TranslateOptions): MongoStatement {
  const scope = tableScope(statement.from, statement.joins, options);
  if (statement.top !== undefined && statement.fetch !== undefined) {
    throw new SqlError('TOP cannot be combined with OFFSET and FETCH', statement.span);
  }
  if (usesFind(statement, scope)) {
    return translateFind(statement, scope);
  }
  return translateAggregate(statement, scope);
}

function isBaseStar(column: SelectColumn, scope: Scope): boolean {
  return (
    column.kind === 'star' &&
    (column.qualifier === undefined || column.qualifier === scope.baseAlias)
  );
}

function usesFind(statement: SelectStatement, scope: Scope): boolean {
  if (
    statement.joins.length > 0 ||
    statement.groupBy.length > 0 ||
    statement.having !== undefined ||
    statement.distinct
  ) {
    return false;
  }
  const plainColumns = statement.columns.every(
    (column) =>
      isBaseStar(column, scope) ||
      (column.kind === 'expression' &&
        column.alias === undefined &&
        column.expression.kind === 'column'),
  );
  const plainOrder = statement.orderBy.every((item) => item.expression.kind === 'column');
  return plainColumns && plainOrder;
}

function sortDocument(items: readonly { name: string; direction: 'asc' | 'desc' }[]): MongoObject {
  const sort: Record<string, number> = {};
  for (const item of items) {
    sort[item.name] = item.direction === 'asc' ? 1 : -1;
  }
  return sort;
}

function translateFind(statement: SelectStatement, scope: Scope): MongoStatement {
  const filter = statement.where ? toFilter(statement.where, whereContext(scope)) : {};
  const args: MongoValue[] = [filter];
  if (!statement.columns.some((column) => isBaseStar(column, scope))) {
    const projection: Record<string, MongoValue> = {};
    for (const column of statement.columns) {
      if (column.kind === 'expression' && column.expression.kind === 'column') {
        projection[resolveColumn(column.expression, scope).path] = 1;
      }
    }
    args.push('_id' in projection ? projection : { _id: 0, ...projection });
  }
  const chain: MongoChainCall[] = [];
  if (statement.orderBy.length > 0) {
    const items = statement.orderBy.map((item) => ({
      name: resolveColumn(item.expression as ColumnRef, scope).path,
      direction: item.direction,
    }));
    chain.push({ method: 'sort', args: [sortDocument(items)] });
  }
  if (statement.offset !== undefined) {
    chain.push({ method: 'skip', args: [statement.offset] });
  }
  const limit = statement.fetch ?? statement.top;
  if (limit !== undefined) {
    chain.push({ method: 'limit', args: [limit] });
  }
  return {
    collection: scope.collection,
    method: 'find',
    args,
    chain,
    kind: 'read',
    unsafe: false,
  };
}

/** One key of the output document and the aggregation value that produces it. */
interface OutputColumn {
  readonly name: string;
  /** The value in the `$project` stage. */
  readonly value: MongoValue;
  /** The value as an aggregation expression, matched against ORDER BY items. */
  readonly ref: MongoValue;
  /** True for a plain base column kept by `name: 1`, which `$addFields` must skip. */
  readonly passthrough: boolean;
}

interface Accumulator {
  readonly name: string;
  readonly value: MongoObject;
  readonly distinct: boolean;
  readonly call: CallExpression;
  readonly argument: MongoValue | undefined;
}

function lookupStages(joins: readonly JoinClause[], scope: Scope): MongoValue[] {
  const stages: MongoValue[] = [];
  joins.forEach((join, index) => {
    const on = join.on;
    const error = (): SqlError =>
      new SqlError('JOIN ... ON must compare one column of each table with =', on.span);
    if (
      on.kind !== 'binary' ||
      on.operator !== '=' ||
      on.left.kind !== 'column' ||
      on.right.kind !== 'column'
    ) {
      throw error();
    }
    const left = resolveColumn(on.left, scope);
    const right = resolveColumn(on.right, scope);
    const isJoined = (column: ResolvedColumn): boolean => column.join?.index === index;
    const isEarlier = (column: ResolvedColumn): boolean =>
      column.join === undefined || column.join.index < index;
    const [joined, local] =
      isJoined(left) && isEarlier(right)
        ? [left, right]
        : isJoined(right) && isEarlier(left)
          ? [right, left]
          : [undefined, undefined];
    if (!joined || !local) {
      throw error();
    }
    const alias = joined.join?.alias as string;
    stages.push({
      $lookup: {
        from: join.table.name,
        localField: local.path,
        foreignField: joined.local,
        as: alias,
      },
    });
    stages.push({
      $unwind:
        join.join === 'inner'
          ? `$${alias}`
          : { path: `$${alias}`, preserveNullAndEmptyArrays: true },
    });
  });
  return stages;
}

function defaultName(expression: Expression, scope: Scope, position: number): string {
  switch (expression.kind) {
    case 'column':
      return lastPart(resolveColumn(expression, scope).path);
    case 'call': {
      const first = expression.args[0];
      const name = expression.name.toLowerCase();
      if (first?.kind === 'column') {
        return `${name}_${resolveColumn(first, scope).path.replaceAll('.', '_').toLowerCase()}`;
      }
      return name;
    }
    default:
      return `expr_${position}`;
  }
}

/** The stages of one select shape: those before the sort, then the `$project` or `$addFields`. */
interface Shape {
  readonly stages: MongoValue[];
  readonly projection: MongoValue[];
  readonly sort: SortPlacement;
}

interface SortPlacement {
  readonly before: MongoObject | undefined;
  readonly after: MongoObject | undefined;
}

/**
 * Decides where `$sort` goes: after `$project` when every item is an output column, before it when
 * every item is a pipeline path that `$project` would drop.
 */
function placeSort(
  items: readonly { pre: string | undefined; post: string | undefined; item: OrderItem }[],
): SortPlacement {
  if (items.length === 0) {
    return { before: undefined, after: undefined };
  }
  if (items.every((entry) => entry.post !== undefined)) {
    const after = sortDocument(
      items.map((entry) => ({ name: entry.post as string, direction: entry.item.direction })),
    );
    return { before: undefined, after };
  }
  if (items.every((entry) => entry.pre !== undefined)) {
    const before = sortDocument(
      items.map((entry) => ({ name: entry.pre as string, direction: entry.item.direction })),
    );
    return { before, after: undefined };
  }
  const offender = items.find((entry) => entry.post === undefined) as (typeof items)[number];
  throw new SqlError(
    'ORDER BY cannot combine a select alias with a column that is not in the select list',
    offender.item.span,
  );
}

/** Resolves ORDER BY items against the outputs. `pre` is a path that works before `$project`. */
function orderPlacement(
  statement: SelectStatement,
  outputs: readonly OutputColumn[],
  translate: (expression: Expression) => MongoValue,
  star: boolean,
): SortPlacement {
  const entries = statement.orderBy.map((item) => {
    const expression = item.expression;
    const aliased =
      expression.kind === 'column' && expression.parts.length === 1
        ? outputs.find((output) => output.name === expression.parts[0])
        : undefined;
    const value = aliased ? aliased.ref : translate(expression);
    const match = aliased ?? outputs.find((output) => sameValue(output.ref, value));
    const pre =
      typeof value === 'string' && value.startsWith('$') && !value.startsWith('$$')
        ? value.slice(1)
        : undefined;
    const post = match?.name ?? (star ? pre : undefined);
    if (pre === undefined && post === undefined) {
      throw new SqlError(ORDER_ERROR, item.span);
    }
    return { pre, post, item };
  });
  return placeSort(entries);
}

function translateAggregate(statement: SelectStatement, scope: Scope): MongoStatement {
  const pipeline: MongoValue[] = [];
  const where = whereContext(scope);
  const mentionsJoin = (expression: Expression): boolean =>
    someNode(
      expression,
      (node) => node.kind === 'column' && resolveColumn(node, scope).join !== undefined,
    );
  const conjuncts = statement.where ? flattenLogical(statement.where, 'and') : [];
  const baseConjuncts = conjuncts.filter((conjunct) => !mentionsJoin(conjunct));
  const joinConjuncts = conjuncts.filter((conjunct) => mentionsJoin(conjunct));
  if (baseConjuncts.length > 0) {
    pipeline.push({ $match: mergeAnd(baseConjuncts.map((part) => toFilter(part, where))) });
  }
  pipeline.push(...lookupStages(statement.joins, scope));
  if (joinConjuncts.length > 0) {
    pipeline.push({ $match: mergeAnd(joinConjuncts.map((part) => toFilter(part, where))) });
  }

  const grouped =
    statement.groupBy.length > 0 ||
    statement.columns.some(
      (column) => column.kind === 'expression' && containsAggregate(column.expression),
    ) ||
    (statement.having !== undefined && containsAggregate(statement.having)) ||
    statement.orderBy.some((item) => containsAggregate(item.expression));
  let shape: Shape;
  if (statement.distinct) {
    if (grouped) {
      throw new SqlError(
        'DISTINCT cannot be combined with GROUP BY or aggregate functions',
        statement.span,
      );
    }
    shape = distinctStages(statement, scope);
  } else if (grouped) {
    shape = groupedStages(statement, scope);
  } else {
    if (statement.having !== undefined) {
      throw new SqlError('HAVING needs GROUP BY or an aggregate function', statement.having.span);
    }
    shape = projectedStages(statement, scope);
  }
  pipeline.push(...shape.stages);
  if (shape.sort.before) {
    pipeline.push({ $sort: shape.sort.before });
  }
  pipeline.push(...shape.projection);
  if (shape.sort.after) {
    pipeline.push({ $sort: shape.sort.after });
  }
  if (statement.offset !== undefined) {
    pipeline.push({ $skip: statement.offset });
  }
  const limit = statement.fetch ?? statement.top;
  if (limit !== undefined) {
    pipeline.push({ $limit: limit });
  }
  return {
    collection: scope.collection,
    method: 'aggregate',
    args: [pipeline],
    chain: [],
    kind: 'read',
    unsafe: false,
  };
}

function projectionStage(outputs: readonly OutputColumn[], star: boolean): MongoValue[] {
  if (star) {
    const fields: Record<string, MongoValue> = {};
    for (const output of outputs) {
      if (!output.passthrough) {
        fields[output.name] = output.value;
      }
    }
    return Object.keys(fields).length > 0 ? [{ $addFields: fields }] : [];
  }
  const project: Record<string, MongoValue> = { _id: 0 };
  for (const output of outputs) {
    project[output.name] = output.value;
  }
  return [{ $project: project }];
}

/**
 * An output that keeps a pipeline path as it is. When the output name still equals the path the
 * column is included with `name: 1`; when a joined column or an alias took the name first, the
 * renumbered output must be a rename, since `name2: 1` would include a field no document has.
 */
function keep(path: string, name: string): OutputColumn {
  const ref = `$${path}`;
  return name === path
    ? { name, value: 1, ref, passthrough: true }
    : { name, value: ref, ref, passthrough: false };
}

/** A select without GROUP BY or aggregates that still needs a pipeline for joins or aliases. */
function projectedStages(statement: SelectStatement, scope: Scope): Shape {
  const ctx = plainContext(scope);
  const names = nameSet();
  const aliases = claimAliases(statement.columns, names);
  const outputs: OutputColumn[] = [];
  let star = false;
  statement.columns.forEach((column, index) => {
    if (column.kind === 'star') {
      if (isBaseStar(column, scope)) {
        star = true;
        return;
      }
      const join = scope.joins.get(column.qualifier as string);
      if (!join) {
        throw new SqlError(`unknown table alias ${column.qualifier}`, column.span);
      }
      outputs.push(keep(join.alias, names.claim(join.alias)));
      return;
    }
    const { expression } = column;
    const alias = aliases[index];
    if (expression.kind === 'column') {
      const resolved = resolveColumn(expression, scope);
      if (alias === undefined && resolved.join === undefined) {
        outputs.push(keep(resolved.path, names.claim(resolved.path)));
      } else {
        const ref = `$${resolved.path}`;
        outputs.push({
          name: alias ?? names.claim(resolved.local),
          value: ref,
          ref,
          passthrough: false,
        });
      }
      return;
    }
    const value = toExpr(expression, ctx);
    outputs.push({
      name: alias ?? names.claim(defaultName(expression, scope, index + 1)),
      value: projectValue(value),
      ref: value,
      passthrough: false,
    });
  });
  const sort = orderPlacement(statement, outputs, (expression) => toExpr(expression, ctx), star);
  return { stages: [], projection: projectionStage(outputs, star), sort };
}

function distinctStages(statement: SelectStatement, scope: Scope): Shape {
  const ctx = plainContext(scope);
  const names = nameSet();
  const aliases = claimAliases(statement.columns, names);
  const keys: Record<string, MongoValue> = {};
  const outputs: OutputColumn[] = [];
  statement.columns.forEach((column, index) => {
    if (column.kind === 'star') {
      throw new SqlError('SELECT DISTINCT * is not supported', column.span);
    }
    const name = aliases[index] ?? names.claim(defaultName(column.expression, scope, index + 1));
    keys[name] = toExpr(column.expression, ctx);
    outputs.push({ name, value: `$_id.${name}`, ref: `$_id.${name}`, passthrough: false });
  });
  const sort = orderPlacement(
    statement,
    outputs,
    (expression) => {
      const value = toExpr(expression, ctx);
      const match = outputs.find((output) => sameValue(keys[output.name] as MongoValue, value));
      if (!match) {
        throw new SqlError('ORDER BY with DISTINCT must name a select column', expression.span);
      }
      return match.ref;
    },
    false,
  );
  return { stages: [{ $group: { _id: keys } }], projection: projectionStage(outputs, false), sort };
}

function groupedStages(statement: SelectStatement, scope: Scope): Shape {
  const names = nameSet();
  const aliases = claimAliases(statement.columns, names);
  const pre = plainContext(scope);
  const inAggregate: ExprContext = {
    ...pre,
    aggregate: (call) => {
      throw new SqlError('aggregate functions cannot be nested', call.span);
    },
  };

  // Group keys, named by the select alias of the column that repeats them.
  const keyValues = statement.groupBy.map((expression) => {
    if (containsAggregate(expression)) {
      throw new SqlError('aggregate functions cannot be used in GROUP BY', expression.span);
    }
    return toExpr(expression, pre);
  });
  const selectValues = statement.columns.map((column) =>
    column.kind === 'expression' && !containsAggregate(column.expression)
      ? toExpr(column.expression, pre)
      : undefined,
  );
  const keyColumn = keyValues.map((value) =>
    selectValues.findIndex((candidate) => candidate !== undefined && sameValue(candidate, value)),
  );
  const keyNames = keyValues.map(
    (_, index) =>
      aliases[keyColumn[index] as number] ??
      names.claim(defaultName(statement.groupBy[index] as Expression, scope, index + 1)),
  );
  const keyRef = (index: number): string =>
    keyValues.length === 1 ? '$_id' : `$_id.${keyNames[index] as string}`;
  const keyIndex = (value: MongoValue): number =>
    keyValues.findIndex((key) => sameValue(key, value));

  // Accumulators, shared between the select list, HAVING and ORDER BY. `name` is called only for a
  // new accumulator and returns its claimed output name.
  const accumulators: Accumulator[] = [];
  const accumulatorFor = (call: CallExpression, name: () => string): Accumulator => {
    const argument = call.star ? undefined : toExpr(call.args[0] as Expression, inAggregate);
    if (!call.star && call.args.length !== 1) {
      throw new SqlError(`${call.name} takes 1 argument`, call.span);
    }
    const existing = accumulators.find(
      (candidate) =>
        candidate.call.name === call.name &&
        candidate.call.star === call.star &&
        candidate.call.distinct === call.distinct &&
        (argument === undefined
          ? candidate.argument === undefined
          : candidate.argument !== undefined && sameValue(candidate.argument, argument)),
    );
    if (existing) {
      return existing;
    }
    const value = accumulatorValue(call, argument);
    const accumulator: Accumulator = {
      name: name(),
      value,
      distinct: call.name === 'COUNT' && call.distinct,
      call,
      argument,
    };
    accumulators.push(accumulator);
    return accumulator;
  };
  // COUNT(DISTINCT x) ignores NULL in SQL, and $addToSet keeps an explicit null, so the size
  // counts the set without it.
  const accumulatorRef = (accumulator: Accumulator): MongoValue =>
    accumulator.distinct
      ? {
          $size: {
            $filter: { input: `$${accumulator.name}`, cond: { $ne: ['$$this', null] } },
          },
        }
      : `$${accumulator.name}`;
  const grouped: ExprContext = {
    scope,
    column: (column) => {
      throw groupError(column);
    },
    aggregate: (call) =>
      accumulatorRef(accumulatorFor(call, () => names.claim(defaultName(call, scope, 0)))),
    rewrite: (expression) => {
      if (isAggregateCall(expression) || containsAggregate(expression)) {
        return undefined;
      }
      const index = keyIndex(toExpr(expression, pre));
      return index === -1 ? undefined : keyRef(index);
    },
  };

  // The select list.
  const outputs: OutputColumn[] = [];
  statement.columns.forEach((column, index) => {
    if (column.kind === 'star') {
      throw new SqlError(
        'SELECT * cannot be combined with GROUP BY or aggregate functions',
        column.span,
      );
    }
    const { expression } = column;
    const alias = aliases[index];
    const ownName = (): string => alias ?? names.claim(defaultName(expression, scope, index + 1));
    if (isAggregateCall(expression)) {
      const before = accumulators.length;
      const accumulator = accumulatorFor(expression, ownName);
      const name = accumulators.length > before ? accumulator.name : ownName();
      const ref = accumulatorRef(accumulator);
      outputs.push({
        name,
        value: name === accumulator.name && !accumulator.distinct ? 1 : ref,
        ref,
        passthrough: false,
      });
      return;
    }
    const selectValue = selectValues[index];
    const key = selectValue === undefined ? -1 : keyIndex(selectValue);
    if (key !== -1) {
      const name = keyColumn[key] === index ? (keyNames[key] as string) : ownName();
      outputs.push({ name, value: keyRef(key), ref: keyRef(key), passthrough: false });
      return;
    }
    const value = toExpr(expression, grouped);
    outputs.push({
      name: ownName(),
      value: projectValue(value),
      ref: value,
      passthrough: false,
    });
  });

  // HAVING, which may add accumulators that the output never shows.
  let havingCount = 0;
  const havingName = (): string => {
    havingCount += 1;
    return `having_${havingCount}`;
  };
  const hidden = (): string => names.claim(havingName());
  const havingExpr: ExprContext = {
    ...grouped,
    aggregate: (call) => accumulatorRef(accumulatorFor(call, hidden)),
  };
  const having = statement.having
    ? toFilter(statement.having, {
        scope,
        expr: havingExpr,
        field: (expression) => {
          if (isAggregateCall(expression)) {
            const accumulator = accumulatorFor(expression, hidden);
            return accumulator.distinct ? undefined : { path: accumulator.name, hint: undefined };
          }
          if (expression.kind === 'column') {
            const index = keyIndex(toExpr(expression, pre));
            if (index === -1) {
              throw groupError(expression);
            }
            return { path: keyRef(index).slice(1), hint: undefined };
          }
          return undefined;
        },
      })
    : undefined;

  // ORDER BY on a COUNT(DISTINCT) that no select column shows sorts on a set, which cannot be
  // ordered, so the set is replaced by its size in an `$addFields` before the sort.
  const sized: Accumulator[] = [];
  const sort = orderPlacement(
    statement,
    outputs,
    (expression) => {
      const value = toExpr(expression, grouped);
      const accumulator = accumulators.find(
        (candidate) => candidate.distinct && sameValue(accumulatorRef(candidate), value),
      );
      if (!accumulator || outputs.some((output) => sameValue(output.ref, value))) {
        return value;
      }
      if (!sized.includes(accumulator)) {
        sized.push(accumulator);
      }
      return `$${accumulator.name}`;
    },
    false,
  );
  const shown = outputs.map((output) =>
    sized.reduce<OutputColumn>(
      (current, accumulator) => ({
        ...current,
        value: replaceValue(current.value, accumulatorRef(accumulator), `$${accumulator.name}`),
        ref: replaceValue(current.ref, accumulatorRef(accumulator), `$${accumulator.name}`),
      }),
      output,
    ),
  );

  const group: Record<string, MongoValue> = {
    _id:
      keyValues.length === 0
        ? null
        : keyValues.length === 1
          ? (keyValues[0] as MongoValue)
          : Object.fromEntries(
              keyNames.map((name, index) => [name, keyValues[index] as MongoValue]),
            ),
  };
  for (const accumulator of accumulators) {
    group[accumulator.name] = accumulator.value;
  }
  const stages: MongoValue[] = [{ $group: group }];
  if (having) {
    stages.push({ $match: having });
  }
  if (sized.length > 0) {
    stages.push({
      $addFields: Object.fromEntries(
        sized.map((accumulator) => [accumulator.name, accumulatorRef(accumulator)]),
      ),
    });
  }
  return { stages, projection: projectionStage(shown, false), sort };
}

function accumulatorValue(call: CallExpression, argument: MongoValue | undefined): MongoObject {
  if (call.name === 'COUNT') {
    if (call.star) {
      return { $sum: 1 };
    }
    if (call.distinct) {
      return { $addToSet: argument as MongoValue };
    }
    return { $sum: { $cond: [{ $gt: [argument as MongoValue, null] }, 1, 0] } };
  }
  if (call.star) {
    throw new SqlError(`${call.name} takes 1 argument`, call.span);
  }
  if (call.distinct) {
    throw new SqlError(`${call.name}(DISTINCT) is not supported`, call.span);
  }
  return { [`$${call.name.toLowerCase()}`]: argument as MongoValue };
}

// Writes

function translateUpdate(statement: UpdateStatement, options: TranslateOptions): MongoStatement {
  const scope = tableScope(statement.table, [], options);
  const filter = statement.where ? toFilter(statement.where, whereContext(scope)) : {};
  const ctx = plainContext(scope);
  const constants: Record<string, MongoValue> = {};
  const expressions: Record<string, MongoValue> = {};
  let allConstant = true;
  const columns = statement.assignments.map((assignment) => assignment.column);
  checkWriteColumns(
    'UPDATE',
    columns,
    columns.map((column) => resolveColumn(column, scope)),
  );
  for (const assignment of statement.assignments) {
    const resolved = resolveColumn(assignment.column, scope);
    const constant = constantOf(assignment.value, scope, resolved.hint);
    if (constant === undefined) {
      allConstant = false;
      expressions[resolved.path] = toExpr(assignment.value, ctx);
    } else {
      constants[resolved.path] = constant;
      expressions[resolved.path] = literalValue(constant);
    }
  }
  return {
    collection: scope.collection,
    method: 'updateMany',
    args: [filter, allConstant ? { $set: constants } : [{ $set: expressions }]],
    chain: [],
    kind: 'write',
    unsafe: statement.where === undefined,
  };
}

function translateDelete(statement: DeleteStatement, options: TranslateOptions): MongoStatement {
  const scope = tableScope(statement.table, [], options);
  const filter = statement.where ? toFilter(statement.where, whereContext(scope)) : {};
  return {
    collection: scope.collection,
    method: 'deleteMany',
    args: [filter],
    chain: [],
    kind: 'write',
    unsafe: statement.where === undefined,
  };
}

/** Assigns a dotted path inside a document. `checkWriteColumns` has ruled out overlaps. */
function setNested(target: Record<string, MongoValue>, path: string, value: MongoValue): void {
  const parts = path.split('.');
  let current = target;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const part = parts[i] as string;
    const existing = current[part];
    if (existing !== undefined && isPlainObject(existing)) {
      current = existing as Record<string, MongoValue>;
    } else {
      const next: Record<string, MongoValue> = {};
      current[part] = next;
      current = next;
    }
  }
  current[parts[parts.length - 1] as string] = value;
}

/**
 * Refuses a column listed twice, as SQL Server does, and a column that is a parent or child path
 * of another (`address` next to `address.city`), where an INSERT would silently keep one value and
 * mongosh would refuse the `$set` of an UPDATE at run time with a path conflict.
 */
function checkWriteColumns(
  verb: 'INSERT' | 'UPDATE',
  columns: readonly ColumnRef[],
  resolved: readonly ResolvedColumn[],
): void {
  resolved.forEach((column, index) => {
    const span = (columns[index] as ColumnRef).span;
    const twice = verb === 'INSERT' ? 'is listed twice' : 'is assigned twice';
    for (const earlier of resolved.slice(0, index)) {
      if (earlier.path === column.path) {
        throw new SqlError(`${verb} column ${column.path} ${twice}`, span);
      }
      if (
        column.path.startsWith(`${earlier.path}.`) ||
        earlier.path.startsWith(`${column.path}.`)
      ) {
        throw new SqlError(`${verb} column ${column.path} overlaps another column`, span);
      }
    }
  });
}

function translateInsert(statement: InsertStatement, options: TranslateOptions): MongoStatement {
  const scope = tableScope(statement.table, [], options);
  const columns = statement.columns.map((column) => resolveColumn(column, scope));
  checkWriteColumns('INSERT', statement.columns, columns);
  const documents = statement.rows.map((row) => {
    if (row.length !== columns.length) {
      const first = row[0];
      const last = row[row.length - 1];
      const span: Span =
        first && last ? { start: first.span.start, end: last.span.end } : statement.span;
      throw new SqlError(`INSERT row has ${row.length} values for ${columns.length} columns`, span);
    }
    const document: Record<string, MongoValue> = {};
    row.forEach((value, index) => {
      const column = columns[index] as ResolvedColumn;
      const constant = constantOf(value, scope, column.hint);
      if (constant === undefined) {
        throw new SqlError('INSERT values must be literals', value.span);
      }
      setNested(document, column.path, constant);
    });
    return document;
  });
  return {
    collection: scope.collection,
    method: 'insertMany',
    args: [documents],
    chain: [],
    kind: 'write',
    unsafe: false,
  };
}
