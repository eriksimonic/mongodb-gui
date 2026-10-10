import { describe, expect, it } from 'vitest';
import {
  SqlError,
  type Assignment,
  type BinaryOperator,
  type CallExpression,
  type CaseExpression,
  type ColumnRef,
  type DeleteStatement,
  type Expression,
  type InsertStatement,
  type JoinClause,
  type Literal,
  type OrderItem,
  type SelectColumn,
  type SelectStatement,
  type Span,
  type SqlStatement,
  type SqlType,
  type TableRef,
  type UpdateStatement,
} from './ast';
import { mongoDate, mongoNow, mongoObjectId, mongoRegex, type MongoStatement } from './mongo-model';
import { translateStatement, type FieldTypeHint, type TranslateOptions } from './translate';

// Builders. Every node gets the zero span unless a test passes one to check an error position.

const ZERO: Span = { start: 0, end: 0 };

function at(start: number, end: number): Span {
  return { start, end };
}

function col(...parts: string[]): ColumnRef {
  return { kind: 'column', parts, span: ZERO };
}

function lit(value: string | number | boolean | null): Literal {
  return { kind: 'literal', value, span: ZERO };
}

function bin(operator: BinaryOperator, left: Expression, right: Expression): Expression {
  return { kind: 'binary', operator, left, right, span: ZERO };
}

function eq(left: Expression, right: Expression): Expression {
  return bin('=', left, right);
}

function and(...parts: Expression[]): Expression {
  return parts.reduce((left, right) => bin('and', left, right));
}

function or(...parts: Expression[]): Expression {
  return parts.reduce((left, right) => bin('or', left, right));
}

function not(operand: Expression): Expression {
  return { kind: 'unary', operator: 'not', operand, span: ZERO };
}

function neg(operand: Expression): Expression {
  return { kind: 'unary', operator: 'negate', operand, span: ZERO };
}

function inList(expression: Expression, values: Expression[], negated = false): Expression {
  return { kind: 'in', expression, values, negated, span: ZERO };
}

function between(
  expression: Expression,
  low: Expression,
  high: Expression,
  negated = false,
): Expression {
  return { kind: 'between', expression, low, high, negated, span: ZERO };
}

function like(
  expression: Expression,
  pattern: Expression,
  options: { escape?: string; negated?: boolean } = {},
): Expression {
  return {
    kind: 'like',
    expression,
    pattern,
    escape: options.escape,
    negated: options.negated ?? false,
    span: ZERO,
  };
}

function isNull(expression: Expression, negated = false): Expression {
  return { kind: 'isNull', expression, negated, span: ZERO };
}

function call(
  name: string,
  args: Expression[] = [],
  options: { star?: boolean; distinct?: boolean } = {},
): CallExpression {
  return {
    kind: 'call',
    name,
    args,
    star: options.star ?? false,
    distinct: options.distinct ?? false,
    span: ZERO,
  };
}

function countStar(): CallExpression {
  return call('COUNT', [], { star: true });
}

function caseOf(
  whens: [Expression, Expression][],
  elseValue?: Expression,
  operand?: Expression,
): CaseExpression {
  return {
    kind: 'case',
    operand,
    whens: whens.map(([when, then]) => ({ when, then })),
    else: elseValue,
    span: ZERO,
  };
}

function cast(expression: Expression, type: SqlType): Expression {
  return { kind: 'cast', expression, type, span: ZERO };
}

function spanned<T extends { readonly span: Span }>(node: T, span: Span): T {
  return { ...node, span };
}

function table(name: string, alias?: string): TableRef {
  return { name, alias, span: ZERO };
}

function column(expression: Expression, alias?: string): SelectColumn {
  return { kind: 'expression', expression, alias, span: ZERO };
}

function star(qualifier?: string): SelectColumn {
  return { kind: 'star', qualifier, span: ZERO };
}

function join(kind: 'inner' | 'left', ref: TableRef, on: Expression): JoinClause {
  return { join: kind, table: ref, on, span: ZERO };
}

function order(expression: Expression, direction: 'asc' | 'desc' = 'asc'): OrderItem {
  return { expression, direction, span: ZERO };
}

function select(overrides: Partial<SelectStatement> = {}): SelectStatement {
  return {
    kind: 'select',
    span: ZERO,
    distinct: false,
    top: undefined,
    columns: [star()],
    from: table('orders'),
    joins: [],
    where: undefined,
    groupBy: [],
    having: undefined,
    orderBy: [],
    offset: undefined,
    fetch: undefined,
    ...overrides,
  };
}

function set(name: string, value: Expression): Assignment {
  return { column: col(...name.split('.')), value, span: ZERO };
}

function update(assignments: Assignment[], where?: Expression, ref = table('orders')) {
  const statement: UpdateStatement = { kind: 'update', span: ZERO, table: ref, assignments, where };
  return statement;
}

function del(where?: Expression, ref = table('orders')): DeleteStatement {
  return { kind: 'delete', span: ZERO, table: ref, where };
}

function insert(columns: string[], rows: Expression[][], ref = table('orders')): InsertStatement {
  return {
    kind: 'insert',
    span: ZERO,
    table: ref,
    columns: columns.map((c) => col(...c.split('.'))),
    rows,
  };
}

function find(
  args: MongoStatement['args'],
  chain: MongoStatement['chain'] = [],
  collection = 'orders',
): MongoStatement {
  return { collection, method: 'find', args, chain, kind: 'read', unsafe: false };
}

function aggregate(pipeline: readonly unknown[], collection = 'orders'): MongoStatement {
  return {
    collection,
    method: 'aggregate',
    args: [pipeline as MongoStatement['args']],
    chain: [],
    kind: 'read',
    unsafe: false,
  };
}

function write(
  method: 'updateMany' | 'deleteMany' | 'insertMany',
  args: MongoStatement['args'],
  unsafe = false,
): MongoStatement {
  return { collection: 'orders', method, args, chain: [], kind: 'write', unsafe };
}

/** Returns the `SqlError` the translator threw. Fails the test when it did not throw. */
function failure(statement: SqlStatement, options?: TranslateOptions): SqlError {
  try {
    translateStatement(statement, options);
  } catch (error) {
    if (error instanceof SqlError) {
      return error;
    }
    throw error;
  }
  throw new Error('expected translateStatement to throw');
}

/** Translates `SELECT * FROM orders WHERE <where>` and returns the filter. */
function filterOf(where: Expression, options?: TranslateOptions): unknown {
  return translateStatement(select({ where }), options).args[0];
}

/**
 * Translates `SELECT <expression> AS value FROM orders` and returns the projected expression. A
 * number or boolean comes back unwrapped from the `$literal` that `$project` needs; the wrapping
 * itself has its own cases under the aggregate shape.
 */
function exprOf(expression: Expression, options?: TranslateOptions): unknown {
  const statement = translateStatement(select({ columns: [column(expression, 'value')] }), options);
  const pipeline = statement.args[0] as { $project: { value: unknown } }[];
  const value = pipeline[0]?.$project.value;
  if (typeof value === 'object' && value !== null && '$literal' in value) {
    const inner = (value as { $literal: unknown }).$literal;
    if (typeof inner === 'number' || typeof inner === 'boolean') {
      return inner;
    }
  }
  return value;
}

function hints(map: Record<string, FieldTypeHint>): TranslateOptions {
  return { fieldType: (collection, path) => map[`${collection}.${path}`] };
}

describe('translateStatement with the find shape', () => {
  it('translates SELECT * into find with an empty filter and no projection', () => {
    expect(translateStatement(select())).toEqual(find([{}]));
  });

  it('projects listed columns with _id hidden', () => {
    const statement = select({ columns: [column(col('name')), column(col('address', 'city'))] });
    expect(translateStatement(statement)).toEqual(
      find([{}, { _id: 0, name: 1, 'address.city': 1 }]),
    );
  });

  it('keeps _id when it is listed', () => {
    const statement = select({ columns: [column(col('_id')), column(col('name'))] });
    expect(translateStatement(statement)).toEqual(find([{}, { _id: 1, name: 1 }]));
  });

  it('drops the table alias from a qualified column', () => {
    const statement = select({ from: table('orders', 'o'), columns: [column(col('o', 'name'))] });
    expect(translateStatement(statement)).toEqual(find([{}, { _id: 0, name: 1 }]));
  });

  it('drops the table name from a qualified column when there is no alias', () => {
    const statement = select({ columns: [column(col('orders', 'name'))] });
    expect(translateStatement(statement)).toEqual(find([{}, { _id: 0, name: 1 }]));
  });

  it('treats a first part that is no alias as a nested field', () => {
    const statement = select({
      from: table('orders', 'o'),
      columns: [column(col('address', 'city'))],
    });
    expect(translateStatement(statement)).toEqual(find([{}, { _id: 0, 'address.city': 1 }]));
  });

  it('treats alias.* of the base table as *', () => {
    const statement = select({ from: table('orders', 'o'), columns: [star('o')] });
    expect(translateStatement(statement)).toEqual(find([{}]));
  });

  it('chains limit for TOP', () => {
    expect(translateStatement(select({ top: 20 }))).toEqual(
      find([{}], [{ method: 'limit', args: [20] }]),
    );
  });

  it('chains skip and limit for OFFSET and FETCH', () => {
    expect(translateStatement(select({ offset: 10, fetch: 5 }))).toEqual(
      find(
        [{}],
        [
          { method: 'skip', args: [10] },
          { method: 'limit', args: [5] },
        ],
      ),
    );
  });

  it('chains sort for ORDER BY with both directions', () => {
    const statement = select({ orderBy: [order(col('total'), 'desc'), order(col('name'))] });
    expect(translateStatement(statement)).toEqual(
      find([{}], [{ method: 'sort', args: [{ total: -1, name: 1 }] }]),
    );
  });

  it('chains sort, skip and limit in that order', () => {
    const statement = select({ orderBy: [order(col('total'))], offset: 3, top: 7 });
    expect(translateStatement(statement).chain.map((c) => c.method)).toEqual([
      'sort',
      'skip',
      'limit',
    ]);
  });

  it('sorts by a column that is not in the projection', () => {
    const statement = select({ columns: [column(col('name'))], orderBy: [order(col('total'))] });
    expect(translateStatement(statement)).toEqual(
      find([{}, { _id: 0, name: 1 }], [{ method: 'sort', args: [{ total: 1 }] }]),
    );
  });

  it('translates the first spec example', () => {
    const statement = select({
      top: 20,
      columns: [column(col('name')), column(col('address', 'city')), column(col('total'))],
      where: and(
        eq(col('status'), lit('shipped')),
        bin('>=', col('total'), lit(100)),
        like(col('customer', 'email'), lit('%@gmail.com')),
      ),
      orderBy: [order(col('total'), 'desc')],
    });
    expect(translateStatement(statement)).toEqual(
      find(
        [
          {
            status: 'shipped',
            total: { $gte: 100 },
            'customer.email': mongoRegex('@gmail\\.com$', 'i'),
          },
          { _id: 0, name: 1, 'address.city': 1, total: 1 },
        ],
        [
          { method: 'sort', args: [{ total: -1 }] },
          { method: 'limit', args: [20] },
        ],
      ),
    );
  });

  it('refuses TOP together with FETCH', () => {
    const error = failure(spanned(select({ top: 1, fetch: 2 }), at(0, 30)));
    expect(error.message).toBe('TOP cannot be combined with OFFSET and FETCH');
    expect(error.span).toEqual(at(0, 30));
  });

  it('refuses a column name that starts with $', () => {
    const error = failure(select({ columns: [column(spanned(col('$where'), at(7, 13)))] }));
    expect(error.message).toBe('column name $where may not start with $');
    expect(error.span).toEqual(at(7, 13));
  });

  it('refuses a bracketed column part that contains a dot', () => {
    const error = failure(select({ columns: [column(spanned(col('a.b'), at(7, 12)))] }));
    expect(error.message).toBe('column name part a.b may not contain a dot');
    expect(error.span).toEqual(at(7, 12));
  });

  it('refuses a bare table alias used as a column', () => {
    const error = failure(
      select({ from: table('orders', 'o'), columns: [column(spanned(col('o'), at(7, 8)))] }),
    );
    expect(error.message).toBe('o is a table alias, not a column');
    expect(error.span).toEqual(at(7, 8));
  });
});

describe('WHERE filters', () => {
  it('writes equality as a plain value', () => {
    expect(filterOf(eq(col('status'), lit('shipped')))).toEqual({ status: 'shipped' });
  });

  it.each([
    ['<>', '$ne'],
    ['<', '$lt'],
    ['<=', '$lte'],
    ['>', '$gt'],
    ['>=', '$gte'],
  ] as const)('maps %s to %s', (operator, mongo) => {
    expect(filterOf(bin(operator, col('total'), lit(5)))).toEqual({ total: { [mongo]: 5 } });
  });

  it('flips the operator when the literal is on the left', () => {
    expect(filterOf(bin('<', lit(100), col('total')))).toEqual({ total: { $gt: 100 } });
    expect(filterOf(bin('>=', lit(100), col('total')))).toEqual({ total: { $lte: 100 } });
    expect(filterOf(eq(lit('x'), col('name')))).toEqual({ name: 'x' });
  });

  it('merges AND conjuncts with distinct keys into one document', () => {
    const where = and(eq(col('a'), lit(1)), eq(col('b'), lit(2)), bin('>', col('c'), lit(3)));
    expect(filterOf(where)).toEqual({ a: 1, b: 2, c: { $gt: 3 } });
  });

  it('uses $and when AND conjuncts share a key', () => {
    const where = and(bin('>=', col('total'), lit(1)), bin('<=', col('total'), lit(9)));
    expect(filterOf(where)).toEqual({ $and: [{ total: { $gte: 1 } }, { total: { $lte: 9 } }] });
  });

  it('flattens an OR chain into one $or', () => {
    const where = or(eq(col('a'), lit(1)), eq(col('a'), lit(2)), eq(col('b'), lit(3)));
    expect(filterOf(where)).toEqual({ $or: [{ a: 1 }, { a: 2 }, { b: 3 }] });
  });

  it('nests an AND inside an OR as a merged document', () => {
    const where = or(eq(col('a'), lit(1)), and(eq(col('b'), lit(2)), eq(col('c'), lit(3))));
    expect(filterOf(where)).toEqual({ $or: [{ a: 1 }, { b: 2, c: 3 }] });
  });

  it('negates an operator object with $not', () => {
    expect(filterOf(not(bin('>', col('total'), lit(5))))).toEqual({ total: { $not: { $gt: 5 } } });
  });

  it('negates a plain equality with $nor', () => {
    expect(filterOf(not(eq(col('a'), lit(1))))).toEqual({ $nor: [{ a: 1 }] });
  });

  it('negates a merged document with $nor', () => {
    expect(filterOf(not(and(eq(col('a'), lit(1)), eq(col('b'), lit(2)))))).toEqual({
      $nor: [{ a: 1, b: 2 }],
    });
  });

  it('translates IN and NOT IN with constant lists', () => {
    expect(filterOf(inList(col('status'), [lit('a'), lit('b')]))).toEqual({
      status: { $in: ['a', 'b'] },
    });
    expect(filterOf(inList(col('n'), [lit(1), neg(lit(2))], true))).toEqual({
      n: { $nin: [1, -2] },
    });
  });

  it('falls back to $expr for IN with a non-constant value', () => {
    expect(filterOf(inList(col('a'), [col('b'), lit(1)]))).toEqual({
      $expr: { $in: ['$a', ['$b', 1]] },
    });
  });

  it('translates BETWEEN and NOT BETWEEN', () => {
    expect(filterOf(between(col('total'), lit(1), lit(9)))).toEqual({
      total: { $gte: 1, $lte: 9 },
    });
    expect(filterOf(between(col('total'), lit(1), lit(9), true))).toEqual({
      total: { $not: { $gte: 1, $lte: 9 } },
    });
  });

  it('translates IS NULL and IS NOT NULL', () => {
    expect(filterOf(isNull(col('deletedAt')))).toEqual({ deletedAt: null });
    expect(filterOf(isNull(col('deletedAt'), true))).toEqual({ deletedAt: { $ne: null } });
  });

  it('translates LIKE and NOT LIKE as case insensitive regexes', () => {
    expect(filterOf(like(col('name'), lit('a%')))).toEqual({ name: mongoRegex('^a', 'i') });
    expect(filterOf(like(col('name'), lit('a%'), { negated: true }))).toEqual({
      name: { $not: mongoRegex('^a', 'i') },
    });
  });

  it('negates a LIKE with $not on the regex', () => {
    expect(filterOf(not(like(col('name'), lit('%x'))))).toEqual({
      name: { $not: mongoRegex('x$', 'i') },
    });
  });

  it('refuses a LIKE pattern that is not a string literal', () => {
    const error = failure(select({ where: like(col('name'), spanned(col('other'), at(20, 25))) }));
    expect(error.message).toBe('LIKE pattern must be a string literal');
    expect(error.span).toEqual(at(20, 25));
  });

  it('uses $expr when the comparison is between an expression and a literal', () => {
    expect(filterOf(bin('>', bin('+', col('a'), col('b')), lit(5)))).toEqual({
      $expr: { $gt: [{ $add: ['$a', '$b'] }, 5] },
    });
  });

  it('uses $expr when both sides are columns', () => {
    expect(filterOf(eq(col('a'), col('b')))).toEqual({ $expr: { $eq: ['$a', '$b'] } });
  });

  it('compares with GETDATE() as a literal date', () => {
    expect(filterOf(bin('<', col('expiresAt'), call('GETDATE')))).toEqual({
      expiresAt: { $lt: mongoNow() },
    });
  });

  it('compares with a CAST of a string as a date literal', () => {
    expect(filterOf(bin('>=', col('createdAt'), cast(lit('2026-01-01'), 'date')))).toEqual({
      createdAt: { $gte: mongoDate('2026-01-01T00:00:00.000Z') },
    });
  });

  it('keeps a negative number literal as a constant', () => {
    expect(filterOf(eq(col('delta'), neg(lit(5))))).toEqual({ delta: -5 });
  });

  it('keeps boolean and null literals', () => {
    expect(filterOf(eq(col('active'), lit(true)))).toEqual({ active: true });
    expect(filterOf(eq(col('x'), lit(null)))).toEqual({ x: null });
  });

  it('mixes a filter document with an $expr conjunct', () => {
    const where = and(eq(col('a'), lit(1)), bin('>', col('b'), col('c')));
    expect(filterOf(where)).toEqual({ a: 1, $expr: { $gt: ['$b', '$c'] } });
  });

  it('refuses an aggregate in WHERE', () => {
    const error = failure(select({ where: bin('>', spanned(countStar(), at(25, 33)), lit(1)) }));
    expect(error.message).toBe('aggregate functions need GROUP BY');
    expect(error.span).toEqual(at(25, 33));
  });

  it('refuses an unknown function', () => {
    const error = failure(
      select({ where: eq(spanned(call('SOUNDEX', [col('name')]), at(6, 19)), lit('x')) }),
    );
    expect(error.message).toBe('function SOUNDEX is not supported');
    expect(error.span).toEqual(at(6, 19));
  });
});

describe('LIKE patterns', () => {
  it.each([
    ['%@gmail.com', undefined, '@gmail\\.com$'],
    ['abc%', undefined, '^abc'],
    ['%abc%', undefined, 'abc'],
    ['a_c', undefined, '^a.c$'],
    ['a[bc]d', undefined, '^a[bc]d$'],
    ['[^a-z]%', undefined, '^[^a-z]'],
    ['a.b', undefined, '^a\\.b$'],
    ['%', undefined, '.*'],
    ['%%', undefined, '.*'],
    ['', undefined, '^$'],
    ['a+b', undefined, '^a\\+b$'],
    ['x_%', undefined, '^x.'],
    ['%_x', undefined, '.x$'],
    ['(a)', undefined, '^\\(a\\)$'],
    ['a[', undefined, '^a\\[$'],
    ['[%]50', undefined, '^[%]50$'],
    ['100\\%', '\\', '^100%$'],
    ['a!_b', '!', '^a_b$'],
    ['ab!', '!', '^ab!$'],
    ['50% off', undefined, '^50.* off$'],
    ['a\\b', undefined, '^a\\\\b$'],
    ['c:/x', undefined, '^c:/x$'],
    ['C:\\%', undefined, '^C:\\\\'],
    ['a\\%', undefined, '^a\\\\'],
    ['%\\', undefined, '\\\\$'],
    ['%a\\b%', undefined, 'a\\\\b'],
    ['%.*', undefined, '\\.\\*$'],
    ['.*%', undefined, '^\\.\\*'],
  ])('turns %j (escape %j) into %j', (pattern, escape, regex) => {
    const options = escape === undefined ? {} : { escape };
    expect(filterOf(like(col('name'), lit(pattern), options))).toEqual({
      name: mongoRegex(regex, 'i'),
    });
  });
});

describe('aggregation expressions', () => {
  it('adds numbers with $add', () => {
    expect(exprOf(bin('+', col('a'), lit(1)))).toEqual({ $add: ['$a', 1] });
  });

  it('concatenates when an operand is a string literal and flattens the chain', () => {
    const expression = bin('+', bin('+', col('first'), lit(' ')), col('last'));
    expect(exprOf(expression)).toEqual({ $concat: ['$first', ' ', '$last'] });
  });

  it('concatenates when an operand has a string type hint', () => {
    expect(exprOf(bin('+', col('a'), col('b')), hints({ 'orders.a': 'string' }))).toEqual({
      $concat: ['$a', '$b'],
    });
  });

  it('concatenates when an operand is a string function or cast', () => {
    expect(exprOf(bin('+', call('UPPER', [col('a')]), col('b')))).toEqual({
      $concat: [{ $toUpper: '$a' }, '$b'],
    });
    expect(exprOf(bin('+', col('a'), cast(col('n'), 'string')))).toEqual({
      $concat: ['$a', { $toString: '$n' }],
    });
  });

  it.each([
    ['-', '$subtract'],
    ['*', '$multiply'],
    ['/', '$divide'],
    ['%', '$mod'],
  ] as const)('maps %s to %s', (operator, mongo) => {
    expect(exprOf(bin(operator, col('a'), lit(2)))).toEqual({ [mongo]: ['$a', 2] });
  });

  it.each([
    ['=', '$eq'],
    ['<>', '$ne'],
    ['<', '$lt'],
    ['<=', '$lte'],
    ['>', '$gt'],
    ['>=', '$gte'],
  ] as const)('maps comparison %s to %s', (operator, mongo) => {
    expect(exprOf(bin(operator, col('a'), col('b')))).toEqual({ [mongo]: ['$a', '$b'] });
  });

  it('maps AND, OR and NOT and flattens logical chains', () => {
    const expression = and(eq(col('a'), lit(1)), or(eq(col('b'), lit(2)), eq(col('c'), lit(3))));
    expect(exprOf(expression)).toEqual({
      $and: [{ $eq: ['$a', 1] }, { $or: [{ $eq: ['$b', 2] }, { $eq: ['$c', 3] }] }],
    });
    expect(exprOf(not(eq(col('a'), lit(1))))).toEqual({ $not: [{ $eq: ['$a', 1] }] });
  });

  it('negates a column with $multiply and folds a negated number', () => {
    expect(exprOf(neg(col('a')))).toEqual({ $multiply: [-1, '$a'] });
    expect(exprOf(bin('*', col('a'), neg(lit(2))))).toEqual({ $multiply: ['$a', -2] });
  });

  it('maps IN, BETWEEN, IS NULL and LIKE in expression position', () => {
    expect(exprOf(inList(col('a'), [lit(1), lit(2)]))).toEqual({ $in: ['$a', [1, 2]] });
    expect(exprOf(inList(col('a'), [lit(1)], true))).toEqual({ $not: [{ $in: ['$a', [1]] }] });
    expect(exprOf(between(col('a'), lit(1), lit(2)))).toEqual({
      $and: [{ $gte: ['$a', 1] }, { $lte: ['$a', 2] }],
    });
    expect(exprOf(between(col('a'), lit(1), lit(2), true))).toEqual({
      $not: [{ $and: [{ $gte: ['$a', 1] }, { $lte: ['$a', 2] }] }],
    });
    expect(exprOf(isNull(col('a')))).toEqual({ $eq: [{ $ifNull: ['$a', null] }, null] });
    expect(exprOf(isNull(col('a'), true))).toEqual({ $ne: [{ $ifNull: ['$a', null] }, null] });
    expect(exprOf(like(call('UPPER', [col('a')]), lit('X%')))).toEqual({
      $regexMatch: { input: { $toUpper: '$a' }, regex: mongoRegex('^X', 'i') },
    });
    expect(exprOf(like(col('a'), lit('X%'), { negated: true }))).toEqual({
      $not: [{ $regexMatch: { input: '$a', regex: mongoRegex('^X', 'i') } }],
    });
  });

  it('translates a searched CASE with and without ELSE', () => {
    const expression = caseOf(
      [
        [bin('>', col('total'), lit(100)), lit('big')],
        [bin('>', col('total'), lit(10)), lit('medium')],
      ],
      lit('small'),
    );
    expect(exprOf(expression)).toEqual({
      $switch: {
        branches: [
          { case: { $gt: ['$total', 100] }, then: 'big' },
          { case: { $gt: ['$total', 10] }, then: 'medium' },
        ],
        default: 'small',
      },
    });
    expect(exprOf(caseOf([[eq(col('a'), lit(1)), lit('one')]]))).toEqual({
      $switch: { branches: [{ case: { $eq: ['$a', 1] }, then: 'one' }], default: null },
    });
  });

  it('translates a simple CASE with $eq cases', () => {
    const expression = caseOf([[lit(1), lit('one')]], lit('other'), col('status'));
    expect(exprOf(expression)).toEqual({
      $switch: { branches: [{ case: { $eq: ['$status', 1] }, then: 'one' }], default: 'other' },
    });
  });

  it('wraps a string literal that starts with $ in $literal', () => {
    expect(exprOf(bin('+', col('a'), lit('$x')))).toEqual({ $concat: ['$a', { $literal: '$x' }] });
  });

  it('uses the LIKE regex in a filter on an expression', () => {
    expect(filterOf(like(call('LOWER', [col('name')]), lit('%a')))).toEqual({
      $expr: { $regexMatch: { input: { $toLower: '$name' }, regex: mongoRegex('a$', 'i') } },
    });
  });
});

describe('functions', () => {
  it('maps ISNULL and COALESCE to $ifNull', () => {
    expect(exprOf(call('ISNULL', [col('a'), lit(0)]))).toEqual({ $ifNull: ['$a', 0] });
    expect(exprOf(call('COALESCE', [col('a'), col('b'), lit(0)]))).toEqual({
      $ifNull: ['$a', { $ifNull: ['$b', 0] }],
    });
  });

  it('maps NULLIF and IIF to $cond', () => {
    expect(exprOf(call('NULLIF', [col('a'), lit(0)]))).toEqual({
      $cond: [{ $eq: ['$a', 0] }, null, '$a'],
    });
    expect(exprOf(call('IIF', [bin('>', col('a'), lit(1)), lit('y'), lit('n')]))).toEqual({
      $cond: [{ $gt: ['$a', 1] }, 'y', 'n'],
    });
  });

  it.each(['GETDATE', 'GETUTCDATE', 'SYSDATETIME', 'CURRENT_TIMESTAMP'])(
    'maps %s() to $$NOW inside an expression',
    (name) => {
      expect(exprOf(bin('-', call(name), col('createdAt')))).toEqual({
        $subtract: ['$$NOW', '$createdAt'],
      });
    },
  );

  it('maps the string functions', () => {
    expect(exprOf(call('UPPER', [col('a')]))).toEqual({ $toUpper: '$a' });
    expect(exprOf(call('LOWER', [col('a')]))).toEqual({ $toLower: '$a' });
    expect(exprOf(call('LEN', [col('a')]))).toEqual({ $strLenCP: '$a' });
    expect(exprOf(call('LTRIM', [col('a')]))).toEqual({ $ltrim: { input: '$a' } });
    expect(exprOf(call('RTRIM', [col('a')]))).toEqual({ $rtrim: { input: '$a' } });
    expect(exprOf(call('TRIM', [col('a')]))).toEqual({ $trim: { input: '$a' } });
    expect(exprOf(call('CONCAT', [col('a'), lit('-'), col('b')]))).toEqual({
      $concat: ['$a', '-', '$b'],
    });
    expect(exprOf(call('REPLACE', [col('a'), lit('x'), lit('y')]))).toEqual({
      $replaceAll: { input: '$a', find: 'x', replacement: 'y' },
    });
  });

  it('maps SUBSTRING with a 1-based literal start and with an expression start', () => {
    expect(exprOf(call('SUBSTRING', [col('a'), lit(3), lit(2)]))).toEqual({
      $substrCP: ['$a', 2, 2],
    });
    expect(exprOf(call('SUBSTRING', [col('a'), col('s'), lit(2)]))).toEqual({
      $substrCP: ['$a', { $subtract: ['$s', 1] }, 2],
    });
  });

  it('maps the numeric functions', () => {
    expect(exprOf(call('ABS', [col('a')]))).toEqual({ $abs: '$a' });
    expect(exprOf(call('ROUND', [col('a')]))).toEqual({ $round: ['$a', 0] });
    expect(exprOf(call('ROUND', [col('a'), lit(2)]))).toEqual({ $round: ['$a', 2] });
    expect(exprOf(call('FLOOR', [col('a')]))).toEqual({ $floor: '$a' });
    expect(exprOf(call('CEILING', [col('a')]))).toEqual({ $ceil: '$a' });
  });

  it('maps the date part functions', () => {
    expect(exprOf(call('YEAR', [col('d')]))).toEqual({ $year: '$d' });
    expect(exprOf(call('MONTH', [col('d')]))).toEqual({ $month: '$d' });
    expect(exprOf(call('DAY', [col('d')]))).toEqual({ $dayOfMonth: '$d' });
  });

  it('maps DATEDIFF with a bare unit word and with a string unit', () => {
    expect(exprOf(call('DATEDIFF', [col('day'), col('a'), col('b')]))).toEqual({
      $dateDiff: { startDate: '$a', endDate: '$b', unit: 'day' },
    });
    expect(exprOf(call('DATEDIFF', [lit('hh'), col('a'), call('GETDATE')]))).toEqual({
      $dateDiff: { startDate: '$a', endDate: '$$NOW', unit: 'hour' },
    });
  });

  it('converts a string literal in a date position to an ISODate, as SQL Server does implicitly', () => {
    expect(exprOf(call('DATEDIFF', [col('day'), lit('2026-01-01'), col('b')]))).toEqual({
      $dateDiff: { startDate: mongoDate('2026-01-01T00:00:00.000Z'), endDate: '$b', unit: 'day' },
    });
    expect(exprOf(call('DATEDIFF', [col('day'), col('a'), lit('2026-01-02 10:30')]))).toEqual({
      $dateDiff: { startDate: '$a', endDate: mongoDate('2026-01-02T10:30:00.000Z'), unit: 'day' },
    });
    expect(exprOf(call('DATEADD', [col('day'), lit(1), lit('2026-01-01')]))).toEqual({
      $dateAdd: { startDate: mongoDate('2026-01-01T00:00:00.000Z'), unit: 'day', amount: 1 },
    });
    expect(exprOf(call('YEAR', [lit('2026-05-06')]))).toEqual({
      $year: mongoDate('2026-05-06T00:00:00.000Z'),
    });
    expect(exprOf(call('MONTH', [lit('2026-05-06')]))).toEqual({
      $month: mongoDate('2026-05-06T00:00:00.000Z'),
    });
    expect(exprOf(call('DAY', [lit('2026-05-06')]))).toEqual({
      $dayOfMonth: mongoDate('2026-05-06T00:00:00.000Z'),
    });
  });

  it('refuses a string in a date position that is not a date, pointing at the literal', () => {
    const bad = spanned(lit('soon'), at(20, 26));
    const error = failure(
      select({ columns: [column(call('DATEDIFF', [col('day'), bad, col('b')]), 'd')] }),
    );
    expect(error.message).toBe("'soon' is not a valid date");
    expect(error.span).toEqual(at(20, 26));
    const inAdd = failure(
      select({ columns: [column(call('DATEADD', [col('day'), lit(1), bad]), 'd')] }),
    );
    expect(inAdd.span).toEqual(at(20, 26));
    const inYear = failure(select({ columns: [column(call('YEAR', [bad]), 'y')] }));
    expect(inYear.message).toBe("'soon' is not a valid date");
  });

  it('leaves a number in a date position alone', () => {
    expect(exprOf(call('DATEDIFF', [col('day'), lit(0), col('b')]))).toEqual({
      $dateDiff: { startDate: 0, endDate: '$b', unit: 'day' },
    });
  });

  it('maps DATEADD and the T-SQL unit abbreviations', () => {
    expect(exprOf(call('DATEADD', [col('MONTH'), lit(3), col('d')]))).toEqual({
      $dateAdd: { startDate: '$d', unit: 'month', amount: 3 },
    });
    expect(exprOf(call('DATEADD', [col('mi'), neg(lit(5)), col('d')]))).toEqual({
      $dateAdd: { startDate: '$d', unit: 'minute', amount: -5 },
    });
  });

  it('refuses an unknown date unit', () => {
    const unit = spanned(col('fortnight'), at(16, 25));
    const error = failure(select({ columns: [column(call('DATEADD', [unit, lit(1), col('d')]))] }));
    expect(error.message).toBe(
      'DATEADD unit must be year, quarter, month, week, day, hour, minute, second or millisecond',
    );
    expect(error.span).toEqual(at(16, 25));
  });

  it.each([
    [call('ISNULL', [col('a')]), 'ISNULL takes 2 arguments'],
    [call('UPPER', [col('a'), col('b')]), 'UPPER takes 1 argument'],
    [call('CONCAT', [col('a')]), 'CONCAT takes at least 2 arguments'],
    [call('ROUND', [col('a'), lit(1), lit(2)]), 'ROUND takes 1 or 2 arguments'],
    [call('GETDATE', [lit(1)]), 'GETDATE takes 0 arguments'],
    [call('IIF', [col('a')]), 'IIF takes 3 arguments'],
  ])('checks the arity of %s', (expression, message) => {
    const error = failure(select({ columns: [column(spanned(expression, at(7, 20)))] }));
    expect(error.message).toBe(message);
    expect(error.span).toEqual(at(7, 20));
  });

  it('refuses an unsupported function in the select list', () => {
    const error = failure(select({ columns: [column(spanned(call('NEWID'), at(7, 14)), 'id')] }));
    expect(error.message).toBe('function NEWID is not supported');
    expect(error.span).toEqual(at(7, 14));
  });
});

describe('CAST and CONVERT', () => {
  it('folds a string literal cast to DATE or DATETIME into an ISODate', () => {
    expect(exprOf(cast(lit('2026-01-01'), 'date'))).toEqual(mongoDate('2026-01-01T00:00:00.000Z'));
    expect(exprOf(cast(lit('2026-03-04T05:06:07Z'), 'datetime'))).toEqual(
      mongoDate('2026-03-04T05:06:07.000Z'),
    );
  });

  it('refuses a date string that does not parse', () => {
    const expression = spanned(cast(lit('yesterday'), 'date'), at(10, 35));
    const error = failure(select({ where: bin('>', col('d'), expression) }));
    expect(error.message).toBe("'yesterday' is not a valid date");
    expect(error.span).toEqual(at(10, 35));
  });

  it('casts a column to a date with $toDate', () => {
    expect(exprOf(cast(col('d'), 'date'))).toEqual({ $toDate: '$d' });
  });

  it('folds a 24 hex string cast to OBJECTID and refuses other strings', () => {
    const hex = '507f1f77bcf86cd799439011';
    expect(exprOf(cast(lit(hex), 'objectId'))).toEqual(mongoObjectId(hex));
    const error = failure(
      select({ where: eq(col('_id'), spanned(cast(lit('nope'), 'objectId'), at(3, 9))) }),
    );
    expect(error.message).toBe('not a valid ObjectId: expected 24 hex characters');
    expect(error.span).toEqual(at(3, 9));
  });

  it('casts a column to an ObjectId with $toObjectId', () => {
    expect(exprOf(cast(col('ref'), 'objectId'))).toEqual({ $toObjectId: '$ref' });
  });

  it.each([
    ['int', '$toInt'],
    ['bigint', '$toLong'],
    ['float', '$toDouble'],
    ['decimal', '$toDecimal'],
    ['bit', '$toBool'],
    ['string', '$toString'],
  ] as const)('casts a column to %s with %s', (type, operator) => {
    expect(exprOf(cast(col('a'), type))).toEqual({ [operator]: '$a' });
  });

  it('folds literal casts to numbers, bits and strings', () => {
    expect(exprOf(cast(lit('5'), 'int'))).toBe(5);
    expect(exprOf(cast(lit(' -5 '), 'bigint'))).toBe(-5);
    expect(exprOf(cast(lit(5.7), 'int'))).toBe(5);
    expect(exprOf(cast(lit(-5.7), 'bigint'))).toBe(-5);
    expect(exprOf(cast(lit('5.7'), 'float'))).toBe(5.7);
    expect(exprOf(cast(lit('1e3'), 'decimal'))).toBe(1000);
    expect(exprOf(cast(lit(true), 'int'))).toBe(1);
    expect(exprOf(cast(lit('1'), 'bit'))).toBe(true);
    expect(exprOf(cast(lit('false'), 'bit'))).toBe(false);
    expect(exprOf(cast(lit(0), 'bit'))).toBe(false);
    expect(exprOf(cast(lit(12), 'string'))).toBe('12');
    expect(exprOf(cast(lit(null), 'int'))).toBeNull();
  });

  it('refuses a literal that cannot be folded to the target type', () => {
    const error = failure(
      select({ where: eq(col('n'), spanned(cast(lit('many'), 'int'), at(5, 20))) }),
    );
    expect(error.message).toBe('not a valid number');
    expect(error.span).toEqual(at(5, 20));
  });

  it('keeps a cast of GETDATE() to a string as an expression', () => {
    expect(exprOf(cast(call('GETDATE'), 'string'))).toEqual({ $toString: '$$NOW' });
    expect(exprOf(cast(call('GETDATE'), 'date'))).toEqual(mongoNow());
  });

  it.each([
    ['5.7', 'int'],
    ['1e3', 'int'],
    ['5.0', 'bigint'],
    ['0x10', 'int'],
  ] as const)('refuses the string %j cast to %s, as SQL Server and $toInt do', (text, type) => {
    const error = failure(
      update([{ column: col('a'), value: spanned(cast(lit(text), type), at(4, 9)), span: ZERO }]),
    );
    expect(error.message).toBe('not a valid number');
    expect(error.span).toEqual(at(4, 9));
  });

  it('casts a number to DATETIME as days since 1900-01-01, as SQL Server does', () => {
    expect(exprOf(cast(lit(0), 'datetime'))).toEqual(mongoDate('1900-01-01T00:00:00.000Z'));
    expect(exprOf(cast(lit(1), 'datetime'))).toEqual(mongoDate('1900-01-02T00:00:00.000Z'));
    expect(exprOf(cast(lit(0.5), 'datetime'))).toEqual(mongoDate('1900-01-01T12:00:00.000Z'));
    expect(exprOf(cast(lit(45000), 'datetime'))).toEqual(mongoDate('2023-03-17T00:00:00.000Z'));
    expect(exprOf(cast(neg(lit(1)), 'datetime'))).toEqual(mongoDate('1899-12-31T00:00:00.000Z'));
  });

  it('refuses a number cast to DATE, as SQL Server does', () => {
    const error = failure(select({ where: eq(col('d'), spanned(cast(lit(0), 'date'), at(3, 9))) }));
    expect(error.message).toBe('a number cannot be cast to DATE, cast it to DATETIME');
    expect(error.span).toEqual(at(3, 9));
  });

  describe('date text', () => {
    it.each([
      ['2026-01-02', '2026-01-02T00:00:00.000Z'],
      ['2026-1-2', '2026-01-02T00:00:00.000Z'],
      ['2026-01-02 10:30', '2026-01-02T10:30:00.000Z'],
      ['2026-01-02 10:30:45', '2026-01-02T10:30:45.000Z'],
      ['2026-01-02T10:30:45', '2026-01-02T10:30:45.000Z'],
      ['2026-01-02t10:30:45', '2026-01-02T10:30:45.000Z'],
      ['2026-01-02 10:30:45.5', '2026-01-02T10:30:45.500Z'],
      ['2026-01-02 10:30:45.1234567', '2026-01-02T10:30:45.123Z'],
      ['2026-01-02T10:30:45Z', '2026-01-02T10:30:45.000Z'],
      ['2026-01-02T10:30:45z', '2026-01-02T10:30:45.000Z'],
      ['2026-01-02T10:30:45+01:00', '2026-01-02T09:30:45.000Z'],
      ['2026-01-02T10:30:45-05:30', '2026-01-02T16:00:45.000Z'],
      ['2026-01-02T10:30:45+0100', '2026-01-02T09:30:45.000Z'],
      ['2026-01-02 10:30:45+01:00', '2026-01-02T09:30:45.000Z'],
      [' 2026-01-02 ', '2026-01-02T00:00:00.000Z'],
      ['2024-02-29', '2024-02-29T00:00:00.000Z'],
      ['2026-12-31 23:59:59.999', '2026-12-31T23:59:59.999Z'],
      ['0001-01-01', '0001-01-01T00:00:00.000Z'],
      ['9999-12-31', '9999-12-31T00:00:00.000Z'],
    ])('reads %j as UTC %j regardless of the machine time zone', (text, iso) => {
      expect(exprOf(cast(lit(text), 'datetime'))).toEqual(mongoDate(iso));
      // A cast to DATE drops the time of day, as it does in SQL Server.
      expect(exprOf(cast(lit(text), 'date'))).toEqual(
        mongoDate(`${iso.slice(0, 10)}T00:00:00.000Z`),
      );
    });

    it.each([
      '2026-02-30',
      '2026-02-29',
      '2026-13-01',
      '2026-00-10',
      '2026-01-00',
      '2026-04-31',
      '2026-01-02 24:00',
      '2026-01-02 10:60',
      '2026-01-02 10:30:60',
      '20260102',
      'yesterday',
      '',
    ])('refuses %j instead of rolling it over', (text) => {
      const error = failure(
        select({ where: eq(col('d'), spanned(cast(lit(text), 'datetime'), at(5, 12))) }),
      );
      expect(error.message).toBe(`'${text}' is not a valid date`);
      expect(error.span).toEqual(at(5, 12));
    });

    it('applies the same reading to a date type hint and to writes', () => {
      const options = hints({ 'orders.createdAt': 'date' });
      expect(filterOf(bin('>', col('createdAt'), lit('2026-03-01 12:00')), options)).toEqual({
        createdAt: { $gt: mongoDate('2026-03-01T12:00:00.000Z') },
      });
      const set = translateStatement(
        update([{ column: col('createdAt'), value: lit('2026-03-01 12:00'), span: ZERO }]),
        options,
      );
      expect(set.args[1]).toEqual({ $set: { createdAt: mongoDate('2026-03-01T12:00:00.000Z') } });
      const row = translateStatement(
        insert(['createdAt'], [[lit('2026-03-01T12:00:00')]]),
        options,
      );
      expect(row.args[0]).toEqual([{ createdAt: mongoDate('2026-03-01T12:00:00.000Z') }]);
      const bad = failure(insert(['createdAt'], [[spanned(lit('2026-02-30'), at(1, 2))]]), options);
      expect(bad.message).toBe("'2026-02-30' is not a valid date");
      expect(bad.span).toEqual(at(1, 2));
    });
  });
});

describe('type hints', () => {
  it('coerces a string compared with a date field', () => {
    const options = hints({ 'orders.createdAt': 'date' });
    expect(filterOf(bin('>=', col('createdAt'), lit('2026-01-01')), options)).toEqual({
      createdAt: { $gte: mongoDate('2026-01-01T00:00:00.000Z') },
    });
  });

  it('refuses a string that is not a date for a date field', () => {
    const options = hints({ 'orders.createdAt': 'date' });
    const error = failure(
      select({ where: eq(col('createdAt'), spanned(lit('soon'), at(18, 24))) }),
      options,
    );
    expect(error.message).toBe("'soon' is not a valid date");
    expect(error.span).toEqual(at(18, 24));
  });

  it('coerces a 24 hex string compared with an objectId field and leaves others', () => {
    const options = hints({ 'orders._id': 'objectId' });
    const hex = '507f1f77bcf86cd799439011';
    expect(filterOf(eq(col('_id'), lit(hex)), options)).toEqual({ _id: mongoObjectId(hex) });
    expect(filterOf(eq(col('_id'), lit('abc')), options)).toEqual({ _id: 'abc' });
  });

  it('coerces numeric text for a number field and leaves other text', () => {
    const options = hints({ 'orders.total': 'number' });
    expect(filterOf(bin('>', col('total'), lit('42.5')), options)).toEqual({
      total: { $gt: 42.5 },
    });
    expect(filterOf(eq(col('total'), lit('n/a')), options)).toEqual({ total: 'n/a' });
  });

  it('coerces true, false, 1 and 0 for a bool field', () => {
    const options = hints({ 'orders.active': 'bool' });
    expect(filterOf(eq(col('active'), lit('true')), options)).toEqual({ active: true });
    expect(filterOf(eq(col('active'), lit('false')), options)).toEqual({ active: false });
    expect(filterOf(eq(col('active'), lit(1)), options)).toEqual({ active: true });
    expect(filterOf(eq(col('active'), lit(0)), options)).toEqual({ active: false });
  });

  it('coerces IN lists and BETWEEN bounds', () => {
    const options = hints({ 'orders.createdAt': 'date', 'orders.n': 'number' });
    expect(filterOf(inList(col('n'), [lit('1'), lit('2')]), options)).toEqual({
      n: { $in: [1, 2] },
    });
    expect(
      filterOf(between(col('createdAt'), lit('2026-01-01'), lit('2026-02-01')), options),
    ).toEqual({
      createdAt: {
        $gte: mongoDate('2026-01-01T00:00:00.000Z'),
        $lte: mongoDate('2026-02-01T00:00:00.000Z'),
      },
    });
  });

  it('coerces inside $expr comparisons too', () => {
    const options = hints({ 'orders.n': 'number' });
    expect(exprOf(bin('>', col('n'), lit('3')), options)).toEqual({ $gt: ['$n', 3] });
    expect(exprOf(bin('>', lit('3'), col('n')), options)).toEqual({ $gt: [3, '$n'] });
  });

  it('looks up a joined column by its table and local path', () => {
    const seen: string[] = [];
    const options: TranslateOptions = {
      fieldType: (collection, path) => {
        seen.push(`${collection}.${path}`);
        return collection === 'customers' && path === 'joinedAt' ? 'date' : undefined;
      },
    };
    const statement = select({
      from: table('orders', 'o'),
      columns: [column(col('o', 'total'))],
      joins: [join('inner', table('customers', 'c'), eq(col('o', 'customerId'), col('c', '_id')))],
      where: bin('>', col('c', 'joinedAt'), lit('2026-01-01')),
    });
    const pipeline = translateStatement(statement, options).args[0] as unknown[];
    expect(pipeline).toContainEqual({
      $match: { 'c.joinedAt': { $gt: mongoDate('2026-01-01T00:00:00.000Z') } },
    });
    expect(seen).toContain('customers.joinedAt');
  });

  it('leaves strings alone without hints', () => {
    expect(filterOf(eq(col('createdAt'), lit('2026-01-01')))).toEqual({
      createdAt: '2026-01-01',
    });
  });
});

describe('the aggregate shape without GROUP BY', () => {
  it('projects an aliased column by renaming it', () => {
    const statement = select({ columns: [column(col('name'), 'n'), column(col('total'))] });
    expect(translateStatement(statement)).toEqual(
      aggregate([{ $project: { _id: 0, n: '$name', total: 1 } }]),
    );
  });

  it('projects a computed column', () => {
    const statement = select({
      columns: [column(col('name')), column(bin('*', col('total'), lit(1.22)), 'gross')],
    });
    expect(translateStatement(statement)).toEqual(
      aggregate([{ $project: { _id: 0, name: 1, gross: { $multiply: ['$total', 1.22] } } }]),
    );
  });

  it('names unaliased expressions after the function or the position', () => {
    const statement = select({
      columns: [column(call('UPPER', [col('name')])), column(bin('+', col('a'), lit(1)))],
    });
    expect(translateStatement(statement)).toEqual(
      aggregate([
        { $project: { _id: 0, upper_name: { $toUpper: '$name' }, expr_2: { $add: ['$a', 1] } } },
      ]),
    );
  });

  it('keeps the whole document with * and adds computed columns with $addFields', () => {
    const statement = select({
      columns: [star(), column(col('name')), column(bin('*', col('total'), lit(2)), 'double')],
    });
    expect(translateStatement(statement)).toEqual(
      aggregate([{ $addFields: { double: { $multiply: ['$total', 2] } } }]),
    );
  });

  it('adds an aliased column with $addFields when * is present', () => {
    const statement = select({ columns: [star(), column(col('name'), 'n')] });
    expect(translateStatement(statement)).toEqual(aggregate([{ $addFields: { n: '$name' } }]));
  });

  it('wraps a number or boolean select column in $literal so $project does not read it as inclusion', () => {
    const statement = select({
      columns: [
        column(lit(1), 'one'),
        column(lit(0), 'zero'),
        column(lit(true), 'yes'),
        column(lit(false), 'no'),
        column(lit('s'), 'text'),
        column(lit(null), 'nothing'),
        column(col('name')),
      ],
    });
    expect(translateStatement(statement)).toEqual(
      aggregate([
        {
          $project: {
            _id: 0,
            one: { $literal: 1 },
            zero: { $literal: 0 },
            yes: { $literal: true },
            no: { $literal: false },
            text: 's',
            nothing: null,
            name: 1,
          },
        },
      ]),
    );
  });

  it('wraps a folded CAST and a negated number in $literal too', () => {
    const statement = select({
      columns: [column(cast(lit('42'), 'int'), 'a'), column(neg(lit(2)), 'b')],
    });
    expect(translateStatement(statement)).toEqual(
      aggregate([{ $project: { _id: 0, a: { $literal: 42 }, b: { $literal: -2 } } }]),
    );
  });

  it('matches ORDER BY against the unwrapped constant and keeps $literal in $project', () => {
    const statement = select({
      columns: [column(lit(1), 'one'), column(col('name'))],
      orderBy: [order(col('one'))],
    });
    expect(translateStatement(statement)).toEqual(
      aggregate([{ $project: { _id: 0, one: { $literal: 1 }, name: 1 } }, { $sort: { one: 1 } }]),
    );
  });

  it('writes a constant next to * with $addFields, where $literal is harmless', () => {
    const statement = select({ columns: [star(), column(lit(1), 'one')] });
    expect(translateStatement(statement)).toEqual(
      aggregate([{ $addFields: { one: { $literal: 1 } } }]),
    );
  });

  it('keeps _id when it is listed next to an alias', () => {
    const statement = select({ columns: [column(col('_id')), column(col('name'), 'n')] });
    expect(translateStatement(statement)).toEqual(
      aggregate([{ $project: { _id: 1, n: '$name' } }]),
    );
  });

  it('deduplicates output names by appending a number, aliases first', () => {
    // The aliases the user typed claim their names in select order before the plain column, whose
    // implicit name is the one renumbered.
    const statement = select({
      columns: [column(col('name')), column(col('other'), 'name'), column(col('third'), 'name')],
    });
    expect(translateStatement(statement)).toEqual(
      aggregate([{ $project: { _id: 0, name: '$other', name2: '$third', name3: '$name' } }]),
    );
  });

  it('puts the WHERE filter in a $match before the projection', () => {
    const statement = select({
      columns: [column(col('name'), 'n')],
      where: eq(col('status'), lit('x')),
    });
    expect(translateStatement(statement)).toEqual(
      aggregate([{ $match: { status: 'x' } }, { $project: { _id: 0, n: '$name' } }]),
    );
  });

  it('sorts by an alias after the projection', () => {
    const statement = select({
      columns: [column(bin('*', col('total'), lit(2)), 'gross')],
      orderBy: [order(col('gross'), 'desc')],
    });
    expect(translateStatement(statement)).toEqual(
      aggregate([
        { $project: { _id: 0, gross: { $multiply: ['$total', 2] } } },
        { $sort: { gross: -1 } },
      ]),
    );
  });

  it('sorts by a column that is in the projection after it', () => {
    const statement = select({
      columns: [column(col('name'), 'n'), column(col('total'))],
      orderBy: [order(col('total'))],
    });
    expect(translateStatement(statement)).toEqual(
      aggregate([{ $project: { _id: 0, n: '$name', total: 1 } }, { $sort: { total: 1 } }]),
    );
  });

  it('sorts by a renamed column under its output name', () => {
    const statement = select({
      columns: [column(col('name'), 'n')],
      orderBy: [order(col('name'))],
    });
    expect(translateStatement(statement)).toEqual(
      aggregate([{ $project: { _id: 0, n: '$name' } }, { $sort: { n: 1 } }]),
    );
  });

  it('sorts before the projection by a column that the projection drops', () => {
    const statement = select({
      columns: [column(col('name'), 'n')],
      orderBy: [order(col('total'), 'desc')],
    });
    expect(translateStatement(statement)).toEqual(
      aggregate([{ $sort: { total: -1 } }, { $project: { _id: 0, n: '$name' } }]),
    );
  });

  it('sorts by an expression that matches a select column', () => {
    const statement = select({
      columns: [column(bin('*', col('total'), lit(2)), 'gross')],
      orderBy: [order(bin('*', col('total'), lit(2)))],
    });
    expect(translateStatement(statement)).toEqual(
      aggregate([
        { $project: { _id: 0, gross: { $multiply: ['$total', 2] } } },
        { $sort: { gross: 1 } },
      ]),
    );
  });

  it('refuses to sort by an expression that is not selected', () => {
    const statement = select({
      columns: [column(col('name'), 'n')],
      orderBy: [spanned(order(bin('*', col('total'), lit(2))), at(30, 39))],
    });
    const error = failure(statement);
    expect(error.message).toBe('ORDER BY must name a column, a select alias or an aggregate');
    expect(error.span).toEqual(at(30, 39));
  });

  it('refuses to mix an alias with a column the projection drops', () => {
    const statement = select({
      columns: [column(bin('*', col('total'), lit(2)), 'gross')],
      orderBy: [order(col('gross')), spanned(order(col('name')), at(40, 44))],
    });
    const error = failure(statement);
    expect(error.message).toBe(
      'ORDER BY cannot combine a select alias with a column that is not in the select list',
    );
    expect(error.span).toEqual(at(40, 44));
  });

  it('adds $skip and $limit after the sort', () => {
    const statement = select({
      columns: [column(col('name'), 'n')],
      orderBy: [order(col('n'))],
      offset: 10,
      fetch: 5,
    });
    expect(translateStatement(statement)).toEqual(
      aggregate([
        { $project: { _id: 0, n: '$name' } },
        { $sort: { n: 1 } },
        { $skip: 10 },
        { $limit: 5 },
      ]),
    );
  });

  it('uses TOP as the $limit', () => {
    const statement = select({ top: 3, columns: [column(col('name'), 'n')] });
    expect(translateStatement(statement).args[0]).toEqual([
      { $project: { _id: 0, n: '$name' } },
      { $limit: 3 },
    ]);
  });

  it('refuses HAVING without GROUP BY or an aggregate', () => {
    const statement = select({
      columns: [column(col('name'), 'n')],
      having: spanned(eq(col('name'), lit('x')), at(50, 60)),
    });
    const error = failure(statement);
    expect(error.message).toBe('HAVING needs GROUP BY or an aggregate function');
    expect(error.span).toEqual(at(50, 60));
  });
});

describe('joins', () => {
  const customers = (kind: 'inner' | 'left' = 'inner'): JoinClause =>
    join(kind, table('customers', 'c'), eq(col('o', 'customerId'), col('c', '_id')));

  it('translates the third spec example', () => {
    const statement = select({
      from: table('orders', 'o'),
      columns: [
        column(col('o', 'orderId')),
        column(col('o', 'total')),
        column(col('c', 'name')),
        column(col('c', 'email')),
      ],
      joins: [customers()],
      where: bin('>', col('o', 'total'), lit(500)),
    });
    expect(translateStatement(statement)).toEqual(
      aggregate([
        { $match: { total: { $gt: 500 } } },
        { $lookup: { from: 'customers', localField: 'customerId', foreignField: '_id', as: 'c' } },
        { $unwind: '$c' },
        { $project: { _id: 0, orderId: 1, total: 1, name: '$c.name', email: '$c.email' } },
      ]),
    );
  });

  it('renames a base column whose output name a joined column already took', () => {
    const statement = select({
      from: table('orders', 'o'),
      columns: [column(col('c', 'name')), column(col('o', 'name'))],
      joins: [customers()],
    });
    expect(translateStatement(statement).args[0]).toEqual([
      { $lookup: { from: 'customers', localField: 'customerId', foreignField: '_id', as: 'c' } },
      { $unwind: '$c' },
      { $project: { _id: 0, name: '$c.name', name2: '$name' } },
    ]);
  });

  it('renames a base column between two joined columns of the same name', () => {
    const regions = join('inner', table('regions', 'r'), eq(col('c', 'regionId'), col('r', '_id')));
    const statement = select({
      from: table('orders', 'o'),
      columns: [column(col('c', 'name')), column(col('o', 'name')), column(col('r', 'name'))],
      joins: [customers(), regions],
    });
    expect(translateStatement(statement).args[0]).toEqual([
      { $lookup: { from: 'customers', localField: 'customerId', foreignField: '_id', as: 'c' } },
      { $unwind: '$c' },
      { $lookup: { from: 'regions', localField: 'c.regionId', foreignField: '_id', as: 'r' } },
      { $unwind: '$r' },
      { $project: { _id: 0, name: '$c.name', name2: '$name', name3: '$r.name' } },
    ]);
  });

  it('renames a base column whose output name a select alias already took', () => {
    const statement = select({
      from: table('orders', 'o'),
      columns: [column(col('c', 'name'), 'total'), column(col('o', 'total'))],
      joins: [customers()],
    });
    expect(translateStatement(statement).args[0]).toEqual([
      { $lookup: { from: 'customers', localField: 'customerId', foreignField: '_id', as: 'c' } },
      { $unwind: '$c' },
      { $project: { _id: 0, total: '$c.name', total2: '$total' } },
    ]);
  });

  it('renames a base column whose name an expression alias took, without a join', () => {
    const statement = select({
      columns: [column(bin('*', col('total'), lit(2)), 'total'), column(col('total'))],
    });
    expect(translateStatement(statement).args[0]).toEqual([
      { $project: { _id: 0, total: { $multiply: ['$total', 2] }, total2: '$total' } },
    ]);
  });

  it('renames a renumbered base column in $addFields when * is present too', () => {
    const statement = select({
      from: table('orders', 'o'),
      columns: [star(), column(col('c', 'name')), column(col('o', 'name'))],
      joins: [customers()],
    });
    expect(translateStatement(statement).args[0]).toEqual([
      { $lookup: { from: 'customers', localField: 'customerId', foreignField: '_id', as: 'c' } },
      { $unwind: '$c' },
      { $addFields: { name: '$c.name', name2: '$name' } },
    ]);
  });

  it('renames a whole join object whose alias an earlier column took', () => {
    const statement = select({
      from: table('orders', 'o'),
      columns: [column(col('o', 'name'), 'c'), star('c')],
      joins: [customers()],
    });
    expect(translateStatement(statement).args[0]).toEqual([
      { $lookup: { from: 'customers', localField: 'customerId', foreignField: '_id', as: 'c' } },
      { $unwind: '$c' },
      { $project: { _id: 0, c: '$name', c2: '$c' } },
    ]);
  });

  it('sorts a renumbered base column by its pipeline path before the projection', () => {
    const statement = select({
      from: table('orders', 'o'),
      columns: [column(col('c', 'name')), column(col('o', 'name'))],
      joins: [customers()],
      orderBy: [order(col('o', 'name'), 'desc')],
    });
    expect(translateStatement(statement).args[0]).toEqual([
      { $lookup: { from: 'customers', localField: 'customerId', foreignField: '_id', as: 'c' } },
      { $unwind: '$c' },
      { $project: { _id: 0, name: '$c.name', name2: '$name' } },
      { $sort: { name2: -1 } },
    ]);
  });

  it('preserves unmatched documents for a LEFT JOIN', () => {
    const statement = select({
      from: table('orders', 'o'),
      columns: [column(col('c', 'name'))],
      joins: [customers('left')],
    });
    expect(translateStatement(statement).args[0]).toEqual([
      { $lookup: { from: 'customers', localField: 'customerId', foreignField: '_id', as: 'c' } },
      { $unwind: { path: '$c', preserveNullAndEmptyArrays: true } },
      { $project: { _id: 0, name: '$c.name' } },
    ]);
  });

  it('splits WHERE conjuncts around the lookups', () => {
    const statement = select({
      from: table('orders', 'o'),
      columns: [column(col('c', 'name'))],
      joins: [customers()],
      where: and(
        eq(col('o', 'status'), lit('shipped')),
        eq(col('c', 'country'), lit('SI')),
        bin('>', col('total'), lit(1)),
      ),
    });
    expect(translateStatement(statement).args[0]).toEqual([
      { $match: { status: 'shipped', total: { $gt: 1 } } },
      { $lookup: { from: 'customers', localField: 'customerId', foreignField: '_id', as: 'c' } },
      { $unwind: '$c' },
      { $match: { 'c.country': 'SI' } },
      { $project: { _id: 0, name: '$c.name' } },
    ]);
  });

  it('moves an OR that mixes both tables after the lookups', () => {
    const statement = select({
      from: table('orders', 'o'),
      columns: [column(col('c', 'name'))],
      joins: [customers()],
      where: or(eq(col('o', 'status'), lit('x')), eq(col('c', 'vip'), lit(true))),
    });
    const pipeline = translateStatement(statement).args[0] as { $match?: unknown }[];
    expect(pipeline[0]).toHaveProperty('$lookup');
    expect(pipeline[2]).toEqual({ $match: { $or: [{ status: 'x' }, { 'c.vip': true }] } });
  });

  it('chains a second join on the first join alias', () => {
    const statement = select({
      from: table('orders', 'o'),
      columns: [column(col('n', 'name'), 'country')],
      joins: [
        customers(),
        join('inner', table('countries', 'n'), eq(col('n', 'code'), col('c', 'countryCode'))),
      ],
    });
    expect(translateStatement(statement).args[0]).toEqual([
      { $lookup: { from: 'customers', localField: 'customerId', foreignField: '_id', as: 'c' } },
      { $unwind: '$c' },
      {
        $lookup: { from: 'countries', localField: 'c.countryCode', foreignField: 'code', as: 'n' },
      },
      { $unwind: '$n' },
      { $project: { _id: 0, country: '$n.name' } },
    ]);
  });

  it('accepts the ON columns in either order', () => {
    const statement = select({
      from: table('orders', 'o'),
      columns: [column(col('c', 'name'))],
      joins: [join('inner', table('customers', 'c'), eq(col('c', '_id'), col('o', 'customerId')))],
    });
    const pipeline = translateStatement(statement).args[0] as unknown[];
    expect(pipeline[0]).toEqual({
      $lookup: { from: 'customers', localField: 'customerId', foreignField: '_id', as: 'c' },
    });
  });

  it('uses the table name as the alias when the join has none', () => {
    const statement = select({
      columns: [column(col('customers', 'name'))],
      joins: [join('inner', table('customers'), eq(col('customerId'), col('customers', '_id')))],
    });
    expect(translateStatement(statement).args[0]).toEqual([
      {
        $lookup: {
          from: 'customers',
          localField: 'customerId',
          foreignField: '_id',
          as: 'customers',
        },
      },
      { $unwind: '$customers' },
      { $project: { _id: 0, name: '$customers.name' } },
    ]);
  });

  it('keeps the whole joined object for alias.*', () => {
    const statement = select({
      from: table('orders', 'o'),
      columns: [column(col('o', 'total')), star('c')],
      joins: [customers()],
    });
    const pipeline = translateStatement(statement).args[0] as unknown[];
    expect(pipeline[2]).toEqual({ $project: { _id: 0, total: 1, c: 1 } });
  });

  it('refuses alias.* for an unknown alias', () => {
    const statement = select({ columns: [spanned(star('x'), at(7, 10))] });
    const error = failure(statement);
    expect(error.message).toBe('unknown table alias x');
    expect(error.span).toEqual(at(7, 10));
  });

  it('refuses an ON that is not an equality', () => {
    const on = spanned(bin('>', col('o', 'customerId'), col('c', '_id')), at(40, 60));
    const statement = select({
      from: table('orders', 'o'),
      columns: [column(col('c', 'name'))],
      joins: [join('inner', table('customers', 'c'), on)],
    });
    const error = failure(statement);
    expect(error.message).toBe('JOIN ... ON must compare one column of each table with =');
    expect(error.span).toEqual(at(40, 60));
  });

  it('refuses an ON with a literal side', () => {
    const on = spanned(eq(col('c', '_id'), lit(1)), at(40, 50));
    const statement = select({
      from: table('orders', 'o'),
      columns: [column(col('c', 'name'))],
      joins: [join('inner', table('customers', 'c'), on)],
    });
    expect(failure(statement).span).toEqual(at(40, 50));
  });

  it('refuses an ON whose columns both belong to the base table', () => {
    const on = spanned(eq(col('o', 'a'), col('o', 'b')), at(40, 50));
    const statement = select({
      from: table('orders', 'o'),
      columns: [column(col('c', 'name'))],
      joins: [join('inner', table('customers', 'c'), on)],
    });
    const error = failure(statement);
    expect(error.message).toBe('JOIN ... ON must compare one column of each table with =');
    expect(error.span).toEqual(at(40, 50));
  });

  it('refuses an ON that references a later join', () => {
    const first = join(
      'inner',
      table('customers', 'c'),
      spanned(eq(col('c', 'countryCode'), col('n', 'code')), at(40, 50)),
    );
    const second = join('inner', table('countries', 'n'), eq(col('n', 'x'), col('o', 'y')));
    const statement = select({
      from: table('orders', 'o'),
      columns: [column(col('c', 'name'))],
      joins: [first, second],
    });
    expect(failure(statement).span).toEqual(at(40, 50));
  });

  it('lets a join alias win over a nested field of the same name', () => {
    const statement = select({
      from: table('orders', 'o'),
      columns: [column(col('c', 'name'))],
      joins: [customers()],
      orderBy: [order(col('c', 'name'))],
    });
    const pipeline = translateStatement(statement).args[0] as unknown[];
    expect(pipeline[2]).toEqual({ $project: { _id: 0, name: '$c.name' } });
    expect(pipeline[3]).toEqual({ $sort: { name: 1 } });
  });

  it('keeps a nested path on the joined column as a nested output key', () => {
    const statement = select({
      from: table('orders', 'o'),
      columns: [column(col('c', 'address', 'city'))],
      joins: [customers()],
    });
    const pipeline = translateStatement(statement).args[0] as unknown[];
    expect(pipeline[2]).toEqual({ $project: { _id: 0, 'address.city': '$c.address.city' } });
  });
});

describe('GROUP BY and aggregates', () => {
  it('translates the second spec example', () => {
    const statement = select({
      columns: [
        column(col('customer', 'id'), 'customer'),
        column(countStar(), 'orders'),
        column(call('SUM', [col('total')]), 'revenue'),
      ],
      where: bin('>=', col('createdAt'), cast(lit('2026-01-01'), 'date')),
      groupBy: [col('customer', 'id')],
      having: bin('>', call('SUM', [col('total')]), lit(1000)),
      orderBy: [order(col('revenue'), 'desc')],
    });
    expect(translateStatement(statement)).toEqual(
      aggregate([
        { $match: { createdAt: { $gte: mongoDate('2026-01-01T00:00:00.000Z') } } },
        { $group: { _id: '$customer.id', orders: { $sum: 1 }, revenue: { $sum: '$total' } } },
        { $match: { revenue: { $gt: 1000 } } },
        { $project: { _id: 0, customer: '$_id', orders: 1, revenue: 1 } },
        { $sort: { revenue: -1 } },
      ]),
    );
  });

  it('groups by several keys as an object named by the last path part', () => {
    const statement = select({
      columns: [column(col('address', 'city')), column(col('status')), column(countStar())],
      groupBy: [col('address', 'city'), col('status')],
    });
    expect(translateStatement(statement)).toEqual(
      aggregate([
        { $group: { _id: { city: '$address.city', status: '$status' }, count: { $sum: 1 } } },
        { $project: { _id: 0, city: '$_id.city', status: '$_id.status', count: 1 } },
      ]),
    );
  });

  it('names a key by the alias of the matching select column', () => {
    const statement = select({
      columns: [column(col('a'), 'x'), column(col('b'), 'y')],
      groupBy: [col('a'), col('b')],
    });
    expect(translateStatement(statement)).toEqual(
      aggregate([
        { $group: { _id: { x: '$a', y: '$b' } } },
        { $project: { _id: 0, x: '$_id.x', y: '$_id.y' } },
      ]),
    );
  });

  it('deduplicates key names that share a last part', () => {
    const statement = select({
      columns: [column(col('a', 'id')), column(col('b', 'id'))],
      groupBy: [col('a', 'id'), col('b', 'id')],
    });
    expect(translateStatement(statement)).toEqual(
      aggregate([
        { $group: { _id: { id: '$a.id', id2: '$b.id' } } },
        { $project: { _id: 0, id: '$_id.id', id2: '$_id.id2' } },
      ]),
    );
  });

  it('groups by null when the select list has only aggregates', () => {
    const statement = select({
      columns: [column(countStar()), column(call('MAX', [col('total')]))],
    });
    expect(translateStatement(statement)).toEqual(
      aggregate([
        { $group: { _id: null, count: { $sum: 1 }, max_total: { $max: '$total' } } },
        { $project: { _id: 0, count: 1, max_total: 1 } },
      ]),
    );
  });

  it('counts a column with a null check', () => {
    const statement = select({ columns: [column(call('COUNT', [col('email')]))] });
    expect(translateStatement(statement).args[0]).toEqual([
      {
        $group: {
          _id: null,
          count_email: { $sum: { $cond: [{ $gt: ['$email', null] }, 1, 0] } },
        },
      },
      { $project: { _id: 0, count_email: 1 } },
    ]);
  });

  it('counts distinct values with $addToSet and $size', () => {
    const statement = select({
      columns: [
        column(col('status')),
        column(call('COUNT', [col('city')], { distinct: true }), 'cities'),
      ],
      groupBy: [col('status')],
    });
    expect(translateStatement(statement).args[0]).toEqual([
      { $group: { _id: '$status', cities: { $addToSet: '$city' } } },
      {
        $project: {
          _id: 0,
          status: '$_id',
          cities: { $size: { $filter: { input: '$cities', cond: { $ne: ['$$this', null] } } } },
        },
      },
    ]);
  });

  it('maps SUM, AVG, MIN and MAX and names them by the lower case path', () => {
    const statement = select({
      columns: [
        column(call('SUM', [col('customer', 'Total')])),
        column(call('AVG', [col('total')])),
        column(call('MIN', [col('x')])),
        column(call('MAX', [col('x')])),
      ],
    });
    expect(translateStatement(statement).args[0]).toEqual([
      {
        $group: {
          _id: null,
          sum_customer_total: { $sum: '$customer.Total' },
          avg_total: { $avg: '$total' },
          min_x: { $min: '$x' },
          max_x: { $max: '$x' },
        },
      },
      { $project: { _id: 0, sum_customer_total: 1, avg_total: 1, min_x: 1, max_x: 1 } },
    ]);
  });

  it('aggregates an expression', () => {
    const statement = select({
      columns: [column(call('SUM', [bin('*', col('qty'), col('price'))]), 'gross')],
    });
    expect(translateStatement(statement).args[0]).toEqual([
      { $group: { _id: null, gross: { $sum: { $multiply: ['$qty', '$price'] } } } },
      { $project: { _id: 0, gross: 1 } },
    ]);
  });

  it('computes an expression over aggregates and keys after the group', () => {
    const statement = select({
      columns: [
        column(col('status')),
        column(bin('/', call('SUM', [col('total')]), countStar()), 'average'),
        column(call('UPPER', [col('status')]), 'label'),
      ],
      groupBy: [col('status')],
    });
    expect(translateStatement(statement).args[0]).toEqual([
      { $group: { _id: '$status', sum_total: { $sum: '$total' }, count: { $sum: 1 } } },
      {
        $project: {
          _id: 0,
          status: '$_id',
          average: { $divide: ['$sum_total', '$count'] },
          label: { $toUpper: '$_id' },
        },
      },
    ]);
  });

  it('matches a select expression to a GROUP BY expression', () => {
    const statement = select({
      columns: [column(call('YEAR', [col('createdAt')]), 'year'), column(countStar(), 'n')],
      groupBy: [call('YEAR', [col('createdAt')])],
    });
    expect(translateStatement(statement).args[0]).toEqual([
      { $group: { _id: { $year: '$createdAt' }, n: { $sum: 1 } } },
      { $project: { _id: 0, year: '$_id', n: 1 } },
    ]);
  });

  it('shares one accumulator between equal aggregates', () => {
    const statement = select({
      columns: [column(call('SUM', [col('total')]), 'a'), column(call('SUM', [col('total')]), 'b')],
    });
    expect(translateStatement(statement).args[0]).toEqual([
      { $group: { _id: null, a: { $sum: '$total' } } },
      { $project: { _id: 0, a: 1, b: '$a' } },
    ]);
  });

  it('refuses a select column that is neither a key nor an aggregate', () => {
    const statement = select({
      columns: [column(col('status')), column(spanned(col('name'), at(15, 19)))],
      groupBy: [col('status')],
    });
    const error = failure(statement);
    expect(error.message).toBe(
      'column name must appear in GROUP BY or inside an aggregate function',
    );
    expect(error.span).toEqual(at(15, 19));
  });

  it('refuses a column inside an expression that is not a key', () => {
    const statement = select({
      columns: [column(bin('+', spanned(col('o', 'name'), at(8, 14)), lit('x')))],
      groupBy: [col('status')],
    });
    const error = failure(statement);
    expect(error.message).toBe(
      'column o.name must appear in GROUP BY or inside an aggregate function',
    );
    expect(error.span).toEqual(at(8, 14));
  });

  it('refuses * with GROUP BY', () => {
    const statement = select({
      columns: [spanned(star(), at(7, 8))],
      groupBy: [col('status')],
    });
    const error = failure(statement);
    expect(error.message).toBe('SELECT * cannot be combined with GROUP BY or aggregate functions');
    expect(error.span).toEqual(at(7, 8));
  });

  it('refuses an aggregate without GROUP BY next to a plain column', () => {
    const statement = select({
      columns: [column(spanned(col('name'), at(7, 11))), column(countStar())],
    });
    expect(failure(statement).message).toBe(
      'column name must appear in GROUP BY or inside an aggregate function',
    );
  });

  it('refuses a nested aggregate', () => {
    const inner = spanned(call('SUM', [col('a')]), at(11, 17));
    const statement = select({ columns: [column(call('MAX', [inner]))] });
    const error = failure(statement);
    expect(error.message).toBe('aggregate functions cannot be nested');
    expect(error.span).toEqual(at(11, 17));
  });

  it('refuses an aggregate in GROUP BY', () => {
    const statement = select({
      columns: [column(countStar())],
      groupBy: [spanned(call('SUM', [col('a')]), at(30, 36))],
    });
    const error = failure(statement);
    expect(error.message).toBe('aggregate functions cannot be used in GROUP BY');
    expect(error.span).toEqual(at(30, 36));
  });

  it('checks the arity and DISTINCT of aggregates', () => {
    expect(
      failure(select({ columns: [column(spanned(call('SUM', [], { star: true }), at(1, 2)))] })),
    ).toMatchObject({ message: 'SUM takes 1 argument', span: at(1, 2) });
    expect(
      failure(select({ columns: [column(call('COUNT', [col('a'), col('b')]))] })).message,
    ).toBe('COUNT takes 1 argument');
    expect(
      failure(select({ columns: [column(call('AVG', [col('a')], { distinct: true }))] })).message,
    ).toBe('AVG(DISTINCT) is not supported');
  });

  it('refuses a plain column when ORDER BY has an aggregate', () => {
    const statement = select({
      columns: [column(spanned(col('name'), at(7, 11)))],
      orderBy: [order(countStar())],
    });
    const error = failure(statement);
    expect(error.message).toBe(
      'column name must appear in GROUP BY or inside an aggregate function',
    );
    expect(error.span).toEqual(at(7, 11));
  });

  it('limits after the projection', () => {
    const statement = select({
      top: 5,
      columns: [column(col('status')), column(countStar(), 'n')],
      groupBy: [col('status')],
      orderBy: [order(col('n'), 'desc')],
    });
    expect(translateStatement(statement).args[0]).toEqual([
      { $group: { _id: '$status', n: { $sum: 1 } } },
      { $project: { _id: 0, status: '$_id', n: 1 } },
      { $sort: { n: -1 } },
      { $limit: 5 },
    ]);
  });
});

describe('constants in a grouped select list', () => {
  it('wraps a number or boolean next to an aggregate in $literal', () => {
    const statement = select({
      columns: [
        column(lit(1), 'one'),
        column(lit(true), 'yes'),
        column(call('COUNT', [], { star: true }), 'n'),
      ],
    });
    expect(translateStatement(statement).args[0]).toEqual([
      { $group: { _id: null, n: { $sum: 1 } } },
      { $project: { _id: 0, one: { $literal: 1 }, yes: { $literal: true }, n: 1 } },
    ]);
  });

  it('wraps a constant next to a group key in $literal', () => {
    const statement = select({
      columns: [column(col('status')), column(lit(0), 'zero')],
      groupBy: [col('status')],
    });
    expect(translateStatement(statement).args[0]).toEqual([
      { $group: { _id: '$status' } },
      { $project: { _id: 0, status: '$_id', zero: { $literal: 0 } } },
    ]);
  });
});

describe('HAVING', () => {
  it('adds a hidden accumulator for an aggregate only used in HAVING', () => {
    const statement = select({
      columns: [column(col('status')), column(countStar(), 'n')],
      groupBy: [col('status')],
      having: and(
        bin('>', call('SUM', [col('total')]), lit(100)),
        bin('<', call('MAX', [col('total')]), lit(1000)),
      ),
    });
    expect(translateStatement(statement).args[0]).toEqual([
      {
        $group: {
          _id: '$status',
          n: { $sum: 1 },
          having_1: { $sum: '$total' },
          having_2: { $max: '$total' },
        },
      },
      { $match: { having_1: { $gt: 100 }, having_2: { $lt: 1000 } } },
      { $project: { _id: 0, status: '$_id', n: 1 } },
    ]);
  });

  it('reuses the select accumulator for the same aggregate', () => {
    const statement = select({
      columns: [column(countStar())],
      having: bin('>=', countStar(), lit(2)),
    });
    expect(translateStatement(statement).args[0]).toEqual([
      { $group: { _id: null, count: { $sum: 1 } } },
      { $match: { count: { $gte: 2 } } },
      { $project: { _id: 0, count: 1 } },
    ]);
  });

  it('uses $expr for an expression over aggregates', () => {
    const statement = select({
      columns: [column(col('status'))],
      groupBy: [col('status')],
      having: bin('>', bin('/', call('SUM', [col('a')]), countStar()), lit(5)),
    });
    const pipeline = translateStatement(statement).args[0] as unknown[];
    expect(pipeline[1]).toEqual({
      $match: { $expr: { $gt: [{ $divide: ['$having_1', '$having_2'] }, 5] } },
    });
  });

  it('filters a group key through the _id path', () => {
    const single = select({
      columns: [column(col('status'))],
      groupBy: [col('status')],
      having: bin('<>', col('status'), lit('void')),
    });
    expect((translateStatement(single).args[0] as unknown[])[1]).toEqual({
      $match: { _id: { $ne: 'void' } },
    });
    const several = select({
      columns: [column(col('status')), column(col('city'))],
      groupBy: [col('status'), col('city')],
      having: eq(col('city'), lit('Ljubljana')),
    });
    expect((translateStatement(several).args[0] as unknown[])[1]).toEqual({
      $match: { '_id.city': 'Ljubljana' },
    });
  });

  it('uses $expr with $size for COUNT(DISTINCT)', () => {
    const statement = select({
      columns: [column(col('status'))],
      groupBy: [col('status')],
      having: bin('>', call('COUNT', [col('city')], { distinct: true }), lit(1)),
    });
    expect(translateStatement(statement).args[0]).toEqual([
      { $group: { _id: '$status', having_1: { $addToSet: '$city' } } },
      {
        $match: {
          $expr: {
            $gt: [
              { $size: { $filter: { input: '$having_1', cond: { $ne: ['$$this', null] } } } },
              1,
            ],
          },
        },
      },
      { $project: { _id: 0, status: '$_id' } },
    ]);
  });

  it('refuses a column that is not a group key', () => {
    const statement = select({
      columns: [column(col('status'))],
      groupBy: [col('status')],
      having: bin('>', spanned(col('total'), at(60, 65)), lit(1)),
    });
    const error = failure(statement);
    expect(error.message).toBe(
      'column total must appear in GROUP BY or inside an aggregate function',
    );
    expect(error.span).toEqual(at(60, 65));
  });
});

describe('ORDER BY in grouped queries', () => {
  it('sorts by an aggregate that is not selected before the projection', () => {
    const statement = select({
      columns: [column(col('status'))],
      groupBy: [col('status')],
      orderBy: [order(countStar(), 'desc')],
    });
    expect(translateStatement(statement).args[0]).toEqual([
      { $group: { _id: '$status', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $project: { _id: 0, status: '$_id' } },
    ]);
  });

  it('sorts by a selected aggregate under its output name', () => {
    const statement = select({
      columns: [column(col('status')), column(call('SUM', [col('total')]), 'revenue')],
      groupBy: [col('status')],
      orderBy: [order(call('SUM', [col('total')]))],
    });
    const pipeline = translateStatement(statement).args[0] as unknown[];
    expect(pipeline[2]).toEqual({ $sort: { revenue: 1 } });
  });

  it('sorts by a group key column under its output name', () => {
    const statement = select({
      columns: [column(col('address', 'city'), 'town'), column(countStar(), 'n')],
      groupBy: [col('address', 'city')],
      orderBy: [order(col('address', 'city')), order(col('n'), 'desc')],
    });
    const pipeline = translateStatement(statement).args[0] as unknown[];
    expect(pipeline[2]).toEqual({ $sort: { town: 1, n: -1 } });
  });

  it('sorts by a group key that is not selected through the _id path', () => {
    const statement = select({
      columns: [column(countStar(), 'n')],
      groupBy: [col('a'), col('b')],
      orderBy: [order(col('b'))],
    });
    expect(translateStatement(statement).args[0]).toEqual([
      { $group: { _id: { a: '$a', b: '$b' }, n: { $sum: 1 } } },
      { $sort: { '_id.b': 1 } },
      { $project: { _id: 0, n: 1 } },
    ]);
  });

  it('sorts by an expression that matches a select column', () => {
    const statement = select({
      columns: [column(bin('/', call('SUM', [col('a')]), countStar()), 'ratio')],
      orderBy: [order(bin('/', call('SUM', [col('a')]), countStar()), 'desc')],
    });
    const pipeline = translateStatement(statement).args[0] as unknown[];
    expect(pipeline[2]).toEqual({ $sort: { ratio: -1 } });
  });

  it('refuses to sort by an expression over aggregates that is not selected', () => {
    const statement = select({
      columns: [column(countStar(), 'n')],
      orderBy: [spanned(order(bin('*', countStar(), lit(2))), at(40, 50))],
    });
    const error = failure(statement);
    expect(error.message).toBe('ORDER BY must name a column, a select alias or an aggregate');
    expect(error.span).toEqual(at(40, 50));
  });
});

describe('DISTINCT', () => {
  it('groups by the select columns and projects them', () => {
    const statement = select({ distinct: true, columns: [column(col('address', 'city'))] });
    expect(translateStatement(statement)).toEqual(
      aggregate([
        { $group: { _id: { city: '$address.city' } } },
        { $project: { _id: 0, city: '$_id.city' } },
      ]),
    );
  });

  it('handles several columns, aliases, expressions and ORDER BY', () => {
    const statement = select({
      distinct: true,
      columns: [column(col('status'), 's'), column(call('UPPER', [col('city')]))],
      where: eq(col('active'), lit(true)),
      orderBy: [order(col('s')), order(call('UPPER', [col('city')]), 'desc')],
    });
    expect(translateStatement(statement)).toEqual(
      aggregate([
        { $match: { active: true } },
        { $group: { _id: { s: '$status', upper_city: { $toUpper: '$city' } } } },
        { $project: { _id: 0, s: '$_id.s', upper_city: '$_id.upper_city' } },
        { $sort: { s: 1, upper_city: -1 } },
      ]),
    );
  });

  it('refuses DISTINCT with an aggregate', () => {
    const statement = spanned(
      select({ distinct: true, columns: [column(countStar())] }),
      at(0, 40),
    );
    const error = failure(statement);
    expect(error.message).toBe('DISTINCT cannot be combined with GROUP BY or aggregate functions');
    expect(error.span).toEqual(at(0, 40));
  });

  it('refuses DISTINCT *', () => {
    const error = failure(select({ distinct: true, columns: [spanned(star(), at(16, 17))] }));
    expect(error.message).toBe('SELECT DISTINCT * is not supported');
    expect(error.span).toEqual(at(16, 17));
  });

  it('refuses ORDER BY on a column that is not selected', () => {
    const statement = select({
      distinct: true,
      columns: [column(col('city'))],
      orderBy: [order(spanned(col('total'), at(40, 45)))],
    });
    const error = failure(statement);
    expect(error.message).toBe('ORDER BY with DISTINCT must name a select column');
    expect(error.span).toEqual(at(40, 45));
  });
});

describe('UPDATE', () => {
  it('translates the fourth spec example with a literal $set', () => {
    const statement = update(
      [set('status', lit('archived')), set('archivedAt', call('GETDATE'))],
      bin('<', col('createdAt'), cast(lit('2025-01-01'), 'date')),
    );
    expect(translateStatement(statement)).toEqual(
      write('updateMany', [
        { createdAt: { $lt: mongoDate('2025-01-01T00:00:00.000Z') } },
        { $set: { status: 'archived', archivedAt: mongoNow() } },
      ]),
    );
  });

  it('is unsafe without WHERE', () => {
    expect(translateStatement(update([set('a', lit(1))]))).toEqual(
      write('updateMany', [{}, { $set: { a: 1 } }], true),
    );
  });

  it('uses a pipeline update when a value is an expression', () => {
    const statement = update(
      [set('total', bin('*', col('total'), lit(1.1))), set('note', lit('raised'))],
      eq(col('_id'), lit(5)),
    );
    expect(translateStatement(statement)).toEqual(
      write('updateMany', [
        { _id: 5 },
        [{ $set: { total: { $multiply: ['$total', 1.1] }, note: 'raised' } }],
      ]),
    );
  });

  it('wraps a $ string in $literal inside a pipeline update', () => {
    const statement = update([set('a', col('b')), set('tag', lit('$x'))]);
    expect(translateStatement(statement).args[1]).toEqual([
      { $set: { a: '$b', tag: { $literal: '$x' } } },
    ]);
  });

  it('sets NULL, negative numbers and literal casts', () => {
    const statement = update([
      set('a', lit(null)),
      set('b', neg(lit(2))),
      set('c', cast(lit('7'), 'int')),
    ]);
    expect(translateStatement(statement).args[1]).toEqual({ $set: { a: null, b: -2, c: 7 } });
  });

  it('drops the table alias from SET columns and applies hints', () => {
    const statement = update(
      [{ column: col('o', 'when'), value: lit('2026-05-06'), span: ZERO }],
      undefined,
      table('orders', 'o'),
    );
    const options = hints({ 'orders.when': 'date' });
    expect(translateStatement(statement, options).args[1]).toEqual({
      $set: { when: mongoDate('2026-05-06T00:00:00.000Z') },
    });
  });

  it('sets a nested path', () => {
    expect(translateStatement(update([set('address.city', lit('x'))])).args[1]).toEqual({
      $set: { 'address.city': 'x' },
    });
  });

  it('refuses an unknown function in SET', () => {
    const error = failure(update([set('a', spanned(call('NEWID'), at(20, 27)))]));
    expect(error.message).toBe('function NEWID is not supported');
    expect(error.span).toEqual(at(20, 27));
  });
});

describe('DELETE', () => {
  it('translates a filtered delete', () => {
    expect(translateStatement(del(eq(col('status'), lit('void'))))).toEqual(
      write('deleteMany', [{ status: 'void' }]),
    );
  });

  it('is unsafe without WHERE', () => {
    expect(translateStatement(del())).toEqual(write('deleteMany', [{}], true));
  });

  it('uses the table name as the collection', () => {
    expect(translateStatement(del(undefined, table('audit'))).collection).toBe('audit');
  });
});

describe('INSERT', () => {
  it('inserts one document per row', () => {
    const statement = insert(
      ['name', 'total'],
      [
        [lit('a'), lit(1)],
        [lit('b'), lit(2)],
      ],
    );
    expect(translateStatement(statement)).toEqual(
      write('insertMany', [
        [
          { name: 'a', total: 1 },
          { name: 'b', total: 2 },
        ],
      ]),
    );
  });

  it('builds nested objects for dotted columns', () => {
    const statement = insert(
      ['address.city', 'address.zip', 'name'],
      [[lit('Ljubljana'), lit('1000'), lit('x')]],
    );
    expect(translateStatement(statement).args[0]).toEqual([
      { address: { city: 'Ljubljana', zip: '1000' }, name: 'x' },
    ]);
  });

  it('accepts casts of literals, GETDATE() and negative numbers', () => {
    const statement = insert(
      ['createdAt', 'ref', 'delta', 'now'],
      [
        [
          cast(lit('2026-01-01'), 'datetime'),
          cast(lit('507f1f77bcf86cd799439011'), 'objectId'),
          neg(lit(3)),
          call('GETDATE'),
        ],
      ],
    );
    expect(translateStatement(statement).args[0]).toEqual([
      {
        createdAt: mongoDate('2026-01-01T00:00:00.000Z'),
        ref: mongoObjectId('507f1f77bcf86cd799439011'),
        delta: -3,
        now: mongoNow(),
      },
    ]);
  });

  it('applies type hints to the values', () => {
    const statement = insert(['when', 'n'], [[lit('2026-01-01'), lit('5')]]);
    const options = hints({ 'orders.when': 'date', 'orders.n': 'number' });
    expect(translateStatement(statement, options).args[0]).toEqual([
      { when: mongoDate('2026-01-01T00:00:00.000Z'), n: 5 },
    ]);
  });

  it('refuses a row with the wrong number of values', () => {
    const statement = insert(
      ['a', 'b'],
      [[spanned(lit(1), at(30, 31)), spanned(lit(2), at(33, 34)), spanned(lit(3), at(36, 37))]],
    );
    const error = failure(statement);
    expect(error.message).toBe('INSERT row has 3 values for 2 columns');
    expect(error.span).toEqual(at(30, 37));
  });

  it('refuses an expression value', () => {
    const statement = insert(['a'], [[spanned(bin('+', lit(1), lit(2)), at(30, 35))]]);
    const error = failure(statement);
    expect(error.message).toBe('INSERT values must be literals');
    expect(error.span).toEqual(at(30, 35));
  });

  it('refuses a column value', () => {
    const error = failure(insert(['a'], [[spanned(col('b'), at(30, 31))]]));
    expect(error.message).toBe('INSERT values must be literals');
    expect(error.span).toEqual(at(30, 31));
  });

  it('refuses a nested column that overlaps a scalar column', () => {
    const statement: InsertStatement = {
      kind: 'insert',
      span: ZERO,
      table: table('orders'),
      columns: [col('address'), spanned(col('address', 'city'), at(22, 34))],
      rows: [[lit('x'), lit('y')]],
    };
    const error = failure(statement);
    expect(error.message).toBe('INSERT column address.city overlaps another column');
    expect(error.span).toEqual(at(22, 34));
  });

  it('refuses a scalar column that overlaps an earlier nested column', () => {
    const statement: InsertStatement = {
      kind: 'insert',
      span: ZERO,
      table: table('orders'),
      columns: [col('address', 'city'), spanned(col('address'), at(30, 37))],
      rows: [[lit('y'), lit('x')]],
    };
    const error = failure(statement);
    expect(error.message).toBe('INSERT column address overlaps another column');
    expect(error.span).toEqual(at(30, 37));
  });

  it('refuses a deeper overlap in either order', () => {
    const deeper: InsertStatement = {
      ...insert(['a.b.c', 'a'], [[lit(1), lit(2)]]),
      columns: [col('a', 'b', 'c'), spanned(col('a'), at(1, 2))],
    };
    expect(failure(deeper).message).toBe('INSERT column a overlaps another column');
    const shallower: InsertStatement = {
      ...insert(['a', 'a.b.c'], [[lit(1), lit(2)]]),
      columns: [col('a'), spanned(col('a', 'b', 'c'), at(1, 2))],
    };
    expect(failure(shallower).message).toBe('INSERT column a.b.c overlaps another column');
  });

  it('accepts sibling nested columns and columns that only share a prefix text', () => {
    expect(
      translateStatement(insert(['a.b', 'a.c', 'ab'], [[lit(1), lit(2), lit(3)]])).args[0],
    ).toEqual([{ a: { b: 1, c: 2 }, ab: 3 }]);
  });

  it('refuses a column listed twice, as SQL Server does', () => {
    const statement: InsertStatement = {
      ...insert(['a', 'a'], [[lit(1), lit(2)]]),
      columns: [col('a'), spanned(col('a'), at(18, 19))],
    };
    const error = failure(statement);
    expect(error.message).toBe('INSERT column a is listed twice');
    expect(error.span).toEqual(at(18, 19));
    const nested: InsertStatement = {
      ...insert(['a.b', 'a.b'], [[lit(1), lit(2)]]),
      columns: [col('a', 'b'), spanned(col('a', 'b'), at(20, 23))],
    };
    expect(failure(nested).message).toBe('INSERT column a.b is listed twice');
    expect(failure(nested).span).toEqual(at(20, 23));
  });

  it('treats an aliased and a bare spelling of the same column as the same column', () => {
    const statement: InsertStatement = {
      ...insert(['a', 'a'], [[lit(1), lit(2)]]),
      columns: [col('orders', 'a'), spanned(col('a'), at(3, 4))],
    };
    expect(failure(statement).message).toBe('INSERT column a is listed twice');
  });

  it('drops the table alias from the column list', () => {
    const statement = insert(['orders.name'], [[lit('x')]]);
    const withParts: InsertStatement = { ...statement, columns: [col('orders', 'name')] };
    expect(translateStatement(withParts).args[0]).toEqual([{ name: 'x' }]);
  });

  it('is never unsafe', () => {
    expect(translateStatement(insert(['a'], [[lit(1)]])).unsafe).toBe(false);
  });
});

// Regressions from the adversarial rounds. Each block names the defect it guards against.

describe('regression: a CAST as the other side of a comparison types the literal', () => {
  it('reads a string compared with a column cast to DATETIME as a date', () => {
    const where = bin('>=', cast(col('createdAt'), 'datetime'), lit('2026-01-01'));
    expect(filterOf(where)).toEqual({
      $expr: { $gte: [{ $toDate: '$createdAt' }, mongoDate('2026-01-01T00:00:00.000Z')] },
    });
  });

  it('types the literal on the left as well', () => {
    const where = bin('<', lit('2026-01-01'), cast(col('createdAt'), 'datetime'));
    expect(filterOf(where)).toEqual({
      $expr: { $lt: [mongoDate('2026-01-01T00:00:00.000Z'), { $toDate: '$createdAt' }] },
    });
  });

  it('drops the time of day from a literal compared with a cast to DATE', () => {
    const where = eq(cast(col('createdAt'), 'date'), lit('2026-01-05 13:00'));
    expect(filterOf(where)).toEqual({
      $expr: { $eq: [{ $toDate: '$createdAt' }, mongoDate('2026-01-05T00:00:00.000Z')] },
    });
  });

  it('reads a 24 hex string compared with a cast to OBJECTID as an ObjectId', () => {
    const hex = '507f1f77bcf86cd799439011';
    const where = eq(cast(col('ref'), 'objectId'), lit(hex));
    expect(filterOf(where)).toEqual({
      $expr: { $eq: [{ $toObjectId: '$ref' }, mongoObjectId(hex)] },
    });
  });

  it('leaves a string that is not hex alone next to a cast to OBJECTID', () => {
    const where = eq(cast(col('ref'), 'objectId'), lit('nope'));
    expect(filterOf(where)).toEqual({ $expr: { $eq: [{ $toObjectId: '$ref' }, 'nope'] } });
  });

  it('applies the cast type to IN and BETWEEN members', () => {
    expect(
      filterOf(inList(cast(col('d'), 'datetime'), [lit('2026-01-01'), lit('2026-02-01')])),
    ).toEqual({
      $expr: {
        $in: [
          { $toDate: '$d' },
          [mongoDate('2026-01-01T00:00:00.000Z'), mongoDate('2026-02-01T00:00:00.000Z')],
        ],
      },
    });
    expect(
      filterOf(between(cast(col('d'), 'datetime'), lit('2026-01-01'), lit('2026-02-01'))),
    ).toEqual({
      $expr: {
        $and: [
          { $gte: [{ $toDate: '$d' }, mongoDate('2026-01-01T00:00:00.000Z')] },
          { $lte: [{ $toDate: '$d' }, mongoDate('2026-02-01T00:00:00.000Z')] },
        ],
      },
    });
  });

  it('does not type a literal next to a cast to INT or string', () => {
    expect(filterOf(eq(cast(col('n'), 'int'), lit('5')))).toEqual({
      $expr: { $eq: [{ $toInt: '$n' }, '5'] },
    });
    expect(filterOf(eq(cast(col('n'), 'string'), lit(5)))).toEqual({
      $expr: { $eq: [{ $toString: '$n' }, 5] },
    });
  });

  it('refuses a string that is not a date next to a cast to DATETIME', () => {
    const error = failure(
      select({ where: eq(cast(col('d'), 'datetime'), spanned(lit('soon'), at(30, 36))) }),
    );
    expect(error.message).toBe("'soon' is not a valid date");
    expect(error.span).toEqual(at(30, 36));
  });
});

describe('regression: a number literal compared with a string field becomes a string', () => {
  const options = hints({ 'orders.code': 'string' });

  it('in a filter', () => {
    expect(filterOf(eq(col('code'), lit(42)), options)).toEqual({ code: '42' });
    expect(filterOf(bin('>', col('code'), lit(1.5)), options)).toEqual({ code: { $gt: '1.5' } });
  });

  it('in an IN list and a BETWEEN', () => {
    expect(filterOf(inList(col('code'), [lit(1), lit('b')]), options)).toEqual({
      code: { $in: ['1', 'b'] },
    });
    expect(filterOf(between(col('code'), lit(1), lit(9)), options)).toEqual({
      code: { $gte: '1', $lte: '9' },
    });
  });

  it('in an expression comparison', () => {
    expect(filterOf(eq(lit(42), bin('+', col('code'), lit('x'))))).toEqual({
      $expr: { $eq: [42, { $concat: ['$code', 'x'] }] },
    });
    expect(exprOf(eq(col('code'), lit(42)), options)).toEqual({ $eq: ['$code', '42'] });
  });

  it('in INSERT and UPDATE values', () => {
    expect(translateStatement(insert(['code'], [[lit(7)]]), options)).toEqual(
      write('insertMany', [[{ code: '7' }]]),
    );
    expect(translateStatement(update([set('code', lit(7))]), options)).toEqual(
      write('updateMany', [{}, { $set: { code: '7' } }], true),
    );
  });

  it('leaves booleans and NULL alone for a string field', () => {
    expect(filterOf(eq(col('code'), lit(true)), options)).toEqual({ code: true });
    expect(filterOf(eq(col('code'), lit(null)), options)).toEqual({ code: null });
  });

  it('leaves a number alone without a hint', () => {
    expect(filterOf(eq(col('code'), lit(42)))).toEqual({ code: 42 });
  });
});

describe('regression: NULL inside an IN list', () => {
  it('drops NULL from a filter IN list', () => {
    expect(filterOf(inList(col('x'), [lit(1), lit(null)]))).toEqual({ x: { $in: [1] } });
    expect(filterOf(inList(col('x'), [lit(null), lit(1), lit(null), lit(2)]))).toEqual({
      x: { $in: [1, 2] },
    });
  });

  it('leaves an empty list when every member is NULL, which matches nothing', () => {
    expect(filterOf(inList(col('x'), [lit(null)]))).toEqual({ x: { $in: [] } });
  });

  it('drops NULL from an IN list in expression position', () => {
    expect(exprOf(inList(bin('+', col('a'), lit(1)), [lit(1), lit(null)]))).toEqual({
      $in: [{ $add: ['$a', 1] }, [1]],
    });
  });

  it('refuses NOT IN with NULL, which matches no row in SQL Server', () => {
    const error = failure(
      select({ where: inList(col('x'), [lit(1), spanned(lit(null), at(40, 44))], true) }),
    );
    expect(error.message).toBe(
      'NOT IN with NULL matches no row in SQL Server, remove the NULL from the list',
    );
    expect(error.span).toEqual(at(40, 44));
  });

  it('refuses NOT IN with NULL in expression position too', () => {
    const where = inList(bin('+', col('a'), lit(1)), [spanned(lit(null), at(3, 7))], true);
    const error = failure(select({ where }));
    expect(error.span).toEqual(at(3, 7));
  });

  it('keeps NOT IN without NULL as $nin', () => {
    expect(filterOf(inList(col('x'), [lit(1), lit(2)], true))).toEqual({ x: { $nin: [1, 2] } });
  });
});

describe('regression: LIKE classes with a closing bracket', () => {
  it.each([
    ['[]]', '^\\]$'],
    ['a[]]b', '^a\\]b$'],
    ['[]a]', '^[\\]a]$'],
    ['[^]]', '^[^\\]]$'],
    ['[^]a]', '^[^\\]a]$'],
    ['[\\]', '^[\\\\]$'],
    ['[a\\b]', '^[a\\\\b]$'],
    ['%[]]%', '\\]'],
    ['[]', '^\\[\\]$'],
    ['[%]', '^[%]$'],
    ['[a-c]', '^[a-c]$'],
  ])('turns %j into /%s/i', (pattern, source) => {
    expect(filterOf(like(col('s'), lit(pattern)))).toEqual({ s: mongoRegex(source, 'i') });
  });

  it('escapes the bracket in expression position as well', () => {
    expect(exprOf(like(bin('+', col('a'), lit('x')), lit('[]]')))).toEqual({
      $regexMatch: { input: { $concat: ['$a', 'x'] }, regex: mongoRegex('^\\]$', 'i') },
    });
  });
});

describe('regression: numeric casts of blank strings and overflowing text', () => {
  it.each([
    ['', 'int'],
    [' ', 'bigint'],
    ['\t', 'int'],
    ['', 'float'],
    ['  ', 'decimal'],
  ] as const)('casts %j to %s as 0, as SQL Server does', (text, type) => {
    expect(exprOf(cast(lit(text), type))).toBe(0);
  });

  it('casts an empty string to BIT as false', () => {
    expect(exprOf(cast(lit(''), 'bit'))).toBe(false);
    expect(exprOf(cast(lit('  '), 'bit'))).toBe(false);
  });

  it('writes the zero in INSERT and UPDATE', () => {
    expect(
      translateStatement(insert(['a', 'b'], [[cast(lit(''), 'int'), cast(lit(' '), 'bigint')]])),
    ).toEqual(write('insertMany', [[{ a: 0, b: 0 }]]));
    expect(translateStatement(update([set('a', cast(lit(''), 'int'))]))).toEqual(
      write('updateMany', [{}, { $set: { a: 0 } }], true),
    );
  });

  it('still refuses text that is not a number', () => {
    const error = failure(update([set('a', spanned(cast(lit('abc'), 'int'), at(4, 9)))]));
    expect(error.message).toBe('not a valid number');
    expect(error.span).toEqual(at(4, 9));
  });

  it('refuses text that overflows a double', () => {
    const error = failure(update([set('a', spanned(cast(lit('1e400'), 'float'), at(4, 9)))]));
    expect(error.message).toBe('the floating point value is out of range');
    expect(error.span).toEqual(at(4, 9));
    expect(() => exprOf(cast(lit('-1e400'), 'decimal'))).toThrow(
      'the floating point value is out of range',
    );
  });

  it('keeps an overflowing string as a string under a number hint', () => {
    expect(filterOf(eq(col('n'), lit('1e400')), hints({ 'orders.n': 'number' }))).toEqual({
      n: '1e400',
    });
  });
});

describe('regression: date text in the US form and the DATE cast', () => {
  it.each([
    ['1/2/2026', '2026-01-02T00:00:00.000Z'],
    ['01/02/2026', '2026-01-02T00:00:00.000Z'],
    ['12/31/2026', '2026-12-31T00:00:00.000Z'],
    ['1/2/2026 10:30', '2026-01-02T10:30:00.000Z'],
    ['1/2/2026 10:30:45.5', '2026-01-02T10:30:45.500Z'],
    ['1/2/2026 10:30:45+01:00', '2026-01-02T09:30:45.000Z'],
    [' 1/2/2026 ', '2026-01-02T00:00:00.000Z'],
    ['2/29/2024', '2024-02-29T00:00:00.000Z'],
  ])('reads %j as UTC %j regardless of the machine time zone', (text, iso) => {
    expect(exprOf(cast(lit(text), 'datetime'))).toEqual(mongoDate(iso));
  });

  it.each(['2/30/2026', '13/1/2026', '0/1/2026', '1/0/2026', '1/2/26', '2026/1/2'])(
    'refuses the US form %j',
    (text) => {
      expect(() => exprOf(cast(lit(text), 'datetime'))).toThrow(`'${text}' is not a valid date`);
    },
  );

  it.each(['January 2, 2026', 'Jan 2 2026', '2 Jan 2026', 'Thu, 01 Jan 2026 00:00:00 GMT', 'now'])(
    'refuses %j instead of reading it in the machine time zone',
    (text) => {
      expect(() => exprOf(cast(lit(text), 'datetime'))).toThrow(`'${text}' is not a valid date`);
    },
  );

  it('accepts an offset after a space, as a DATETIMEOFFSET literal is written', () => {
    expect(exprOf(cast(lit('2026-01-02 10:30:00 +01:00'), 'datetime'))).toEqual(
      mongoDate('2026-01-02T09:30:00.000Z'),
    );
  });

  it.each([
    ['2026-01-05 13:00', '2026-01-05T00:00:00.000Z'],
    ['2026-01-05T23:59:59.999', '2026-01-05T00:00:00.000Z'],
    ['2026-01-05 01:00+02:00', '2026-01-04T00:00:00.000Z'],
    ['1/5/2026 13:00', '2026-01-05T00:00:00.000Z'],
  ])('drops the time of day when casting %j to DATE', (text, iso) => {
    expect(exprOf(cast(lit(text), 'date'))).toEqual(mongoDate(iso));
    expect(filterOf(bin('<', col('d'), cast(lit(text), 'date')))).toEqual({
      d: { $lt: mongoDate(iso) },
    });
  });

  it('keeps the time of day when casting to DATETIME', () => {
    expect(exprOf(cast(lit('2026-01-05 13:00'), 'datetime'))).toEqual(
      mongoDate('2026-01-05T13:00:00.000Z'),
    );
  });

  it('drops the time of day under a DATE hint from a cast, not under a date field hint', () => {
    expect(filterOf(eq(cast(col('d'), 'date'), lit('2026-01-05 13:00')))).toEqual({
      $expr: { $eq: [{ $toDate: '$d' }, mongoDate('2026-01-05T00:00:00.000Z')] },
    });
    expect(filterOf(eq(col('d'), lit('2026-01-05 13:00')), hints({ 'orders.d': 'date' }))).toEqual({
      d: mongoDate('2026-01-05T13:00:00.000Z'),
    });
  });

  it('casts a DATETIME constant to DATE at midnight', () => {
    expect(exprOf(cast(cast(lit('2026-01-05 13:00'), 'datetime'), 'date'))).toEqual(
      mongoDate('2026-01-05T00:00:00.000Z'),
    );
  });
});

describe('regression: an explicit alias keeps a contested output name', () => {
  const customers = join(
    'inner',
    table('customers', 'c'),
    eq(col('o', 'customerId'), col('c', '_id')),
  );
  const lookup = {
    $lookup: { from: 'customers', localField: 'customerId', foreignField: '_id', as: 'c' },
  };

  it('renumbers the unaliased base column, not the alias', () => {
    const statement = select({
      from: table('orders', 'o'),
      joins: [customers],
      columns: [column(col('o', 'name')), column(col('c', 'name'), 'name')],
    });
    expect(translateStatement(statement).args[0]).toEqual([
      lookup,
      { $unwind: '$c' },
      { $project: { _id: 0, name2: '$name', name: '$c.name' } },
    ]);
  });

  it('renumbers an unaliased joined column after an alias', () => {
    const statement = select({
      from: table('orders', 'o'),
      joins: [customers],
      columns: [column(col('c', 'name')), column(col('o', 'label'), 'name')],
    });
    expect(translateStatement(statement).args[0]).toEqual([
      lookup,
      { $unwind: '$c' },
      { $project: { _id: 0, name2: '$c.name', name: '$label' } },
    ]);
  });

  it('renumbers a computed column default name after an alias', () => {
    const statement = select({
      columns: [column(call('UPPER', [col('name')])), column(col('other'), 'upper_name')],
    });
    expect(translateStatement(statement).args[0]).toEqual([
      { $project: { _id: 0, upper_name2: { $toUpper: '$name' }, upper_name: '$other' } },
    ]);
  });

  it('renumbers the second of two equal aliases in select order', () => {
    const statement = select({
      columns: [column(col('a'), 'x'), column(col('b'), 'x')],
    });
    expect(translateStatement(statement).args[0]).toEqual([
      { $project: { _id: 0, x: '$a', x2: '$b' } },
    ]);
  });

  it('sorts by the alias, not by the renumbered column', () => {
    const statement = select({
      columns: [column(col('name')), column(col('other'), 'name')],
      orderBy: [order(col('name'), 'desc')],
    });
    expect(translateStatement(statement).args[0]).toEqual([
      { $project: { _id: 0, name2: '$name', name: '$other' } },
      { $sort: { name: -1 } },
    ]);
  });

  it('gives a DISTINCT alias priority over a default name', () => {
    const statement = select({
      distinct: true,
      columns: [column(col('name')), column(col('other'), 'name')],
    });
    expect(translateStatement(statement).args[0]).toEqual([
      { $group: { _id: { name2: '$name', name: '$other' } } },
      { $project: { _id: 0, name2: '$_id.name2', name: '$_id.name' } },
    ]);
  });

  it('gives a key alias priority over the default name of an earlier key', () => {
    const statement = select({
      columns: [column(col('region'), 'name'), column(col('name')), column(countStar(), 'n')],
      groupBy: [col('name'), col('region')],
    });
    expect(translateStatement(statement).args[0]).toEqual([
      { $group: { _id: { name2: '$name', name: '$region' }, n: { $sum: 1 } } },
      { $project: { _id: 0, name: '$_id.name', name2: '$_id.name2', n: 1 } },
    ]);
  });

  it('gives an aggregate alias priority over a key default name', () => {
    const statement = select({
      columns: [column(col('name')), column(countStar(), 'name')],
      groupBy: [col('name')],
    });
    expect(translateStatement(statement).args[0]).toEqual([
      { $group: { _id: '$name', name: { $sum: 1 } } },
      { $project: { _id: 0, name2: '$_id', name: 1 } },
    ]);
  });

  it('gives an alias priority over a hidden accumulator name', () => {
    const statement = select({
      columns: [column(col('status')), column(col('other'), 'count')],
      groupBy: [col('status'), col('other')],
      orderBy: [order(countStar(), 'desc')],
    });
    expect(translateStatement(statement).args[0]).toEqual([
      { $group: { _id: { status: '$status', count: '$other' }, count2: { $sum: 1 } } },
      { $sort: { count2: -1 } },
      { $project: { _id: 0, status: '$_id.status', count: '$_id.count' } },
    ]);
  });
});

describe('regression: ORDER BY on a hidden COUNT(DISTINCT)', () => {
  it('replaces the set by its size before the sort', () => {
    const statement = select({
      columns: [column(col('status'))],
      groupBy: [col('status')],
      orderBy: [order(call('COUNT', [col('city')], { distinct: true }), 'desc')],
    });
    expect(translateStatement(statement).args[0]).toEqual([
      { $group: { _id: '$status', count_city: { $addToSet: '$city' } } },
      {
        $addFields: {
          count_city: {
            $size: { $filter: { input: '$count_city', cond: { $ne: ['$$this', null] } } },
          },
        },
      },
      { $sort: { count_city: -1 } },
      { $project: { _id: 0, status: '$_id' } },
    ]);
  });

  it('adds the size stage after the HAVING match', () => {
    const statement = select({
      columns: [column(col('status'))],
      groupBy: [col('status')],
      having: bin('>', countStar(), lit(1)),
      orderBy: [order(call('COUNT', [col('city')], { distinct: true }))],
    });
    expect(translateStatement(statement).args[0]).toEqual([
      {
        $group: { _id: '$status', having_1: { $sum: 1 }, count_city: { $addToSet: '$city' } },
      },
      { $match: { having_1: { $gt: 1 } } },
      {
        $addFields: {
          count_city: {
            $size: { $filter: { input: '$count_city', cond: { $ne: ['$$this', null] } } },
          },
        },
      },
      { $sort: { count_city: 1 } },
      { $project: { _id: 0, status: '$_id' } },
    ]);
  });

  it('sorts a selected COUNT(DISTINCT) after the projection with no extra stage', () => {
    const statement = select({
      columns: [
        column(col('status')),
        column(call('COUNT', [col('city')], { distinct: true }), 'n'),
      ],
      groupBy: [col('status')],
      orderBy: [order(call('COUNT', [col('city')], { distinct: true }), 'desc')],
    });
    expect(translateStatement(statement).args[0]).toEqual([
      { $group: { _id: '$status', n: { $addToSet: '$city' } } },
      {
        $project: {
          _id: 0,
          status: '$_id',
          n: { $size: { $filter: { input: '$n', cond: { $ne: ['$$this', null] } } } },
        },
      },
      { $sort: { n: -1 } },
    ]);
  });

  it('shares the sized accumulator with a HAVING on the same COUNT(DISTINCT)', () => {
    const statement = select({
      columns: [column(col('status'))],
      groupBy: [col('status')],
      having: bin('>', call('COUNT', [col('city')], { distinct: true }), lit(1)),
      orderBy: [order(call('COUNT', [col('city')], { distinct: true }), 'desc')],
    });
    expect(translateStatement(statement).args[0]).toEqual([
      { $group: { _id: '$status', having_1: { $addToSet: '$city' } } },
      {
        $match: {
          $expr: {
            $gt: [
              { $size: { $filter: { input: '$having_1', cond: { $ne: ['$$this', null] } } } },
              1,
            ],
          },
        },
      },
      {
        $addFields: {
          having_1: { $size: { $filter: { input: '$having_1', cond: { $ne: ['$$this', null] } } } },
        },
      },
      { $sort: { having_1: -1 } },
      { $project: { _id: 0, status: '$_id' } },
    ]);
  });

  it('reads the sized field as a number in a select expression over the same aggregate', () => {
    const distinct = call('COUNT', [col('city')], { distinct: true });
    const statement = select({
      columns: [column(col('status')), column(bin('+', distinct, lit(1)), 'n')],
      groupBy: [col('status')],
      orderBy: [order(distinct, 'desc')],
    });
    expect(translateStatement(statement).args[0]).toEqual([
      { $group: { _id: '$status', count_city: { $addToSet: '$city' } } },
      {
        $addFields: {
          count_city: {
            $size: { $filter: { input: '$count_city', cond: { $ne: ['$$this', null] } } },
          },
        },
      },
      { $sort: { count_city: -1 } },
      { $project: { _id: 0, status: '$_id', n: { $add: ['$count_city', 1] } } },
    ]);
  });

  it('sizes two hidden COUNT(DISTINCT) accumulators in one stage', () => {
    const statement = select({
      columns: [column(col('status'))],
      groupBy: [col('status')],
      orderBy: [
        order(call('COUNT', [col('city')], { distinct: true }), 'desc'),
        order(call('COUNT', [col('zip')], { distinct: true })),
      ],
    });
    expect(translateStatement(statement).args[0]).toEqual([
      {
        $group: {
          _id: '$status',
          count_city: { $addToSet: '$city' },
          count_zip: { $addToSet: '$zip' },
        },
      },
      {
        $addFields: {
          count_city: {
            $size: { $filter: { input: '$count_city', cond: { $ne: ['$$this', null] } } },
          },
          count_zip: {
            $size: { $filter: { input: '$count_zip', cond: { $ne: ['$$this', null] } } },
          },
        },
      },
      { $sort: { count_city: -1, count_zip: 1 } },
      { $project: { _id: 0, status: '$_id' } },
    ]);
  });
});

describe('regression: UPDATE refuses a column assigned twice or overlapping', () => {
  it('refuses the same column assigned twice, pointing at the second', () => {
    const second: Assignment = {
      column: spanned(col('a'), at(16, 17)),
      value: lit(2),
      span: ZERO,
    };
    const error = failure(update([set('a', lit(1)), second]));
    expect(error.message).toBe('UPDATE column a is assigned twice');
    expect(error.span).toEqual(at(16, 17));
  });

  it('treats a table-qualified and a plain column as the same column', () => {
    const error = failure(update([set('orders.a', lit(1)), set('a', lit(2))]));
    expect(error.message).toBe('UPDATE column a is assigned twice');
  });

  it('refuses a nested path next to its parent, in either order', () => {
    expect(failure(update([set('a.b', lit(1)), set('a', lit(2))])).message).toBe(
      'UPDATE column a overlaps another column',
    );
    expect(failure(update([set('a', lit(2)), set('a.b', lit(1))])).message).toBe(
      'UPDATE column a.b overlaps another column',
    );
    expect(failure(update([set('a.b.c', lit(1)), set('a.b', lit(2))])).message).toBe(
      'UPDATE column a.b overlaps another column',
    );
  });

  it('checks before the pipeline shape is chosen', () => {
    expect(failure(update([set('a', col('b')), set('a', lit(2))])).message).toBe(
      'UPDATE column a is assigned twice',
    );
  });

  it('accepts sibling nested paths and a prefix that is not a path parent', () => {
    expect(translateStatement(update([set('a.b', lit(1)), set('a.c', lit(2))]))).toEqual(
      write('updateMany', [{}, { $set: { 'a.b': 1, 'a.c': 2 } }], true),
    );
    expect(translateStatement(update([set('ab', lit(1)), set('a', lit(2))]))).toEqual(
      write('updateMany', [{}, { $set: { ab: 1, a: 2 } }], true),
    );
  });
});
