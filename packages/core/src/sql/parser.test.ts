import { describe, expect, it } from 'vitest';
import {
  SqlError,
  type Expression,
  type SelectStatement,
  type Span,
  type SqlStatement,
  type SqlType,
} from './ast';
import { parseSql, parseStatement, splitSqlStatements } from './parser';

/** Removes every `span` so a tree can be compared by shape. */
function strip(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(strip);
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (key !== 'span') {
        out[key] = strip(entry);
      }
    }
    return out;
  }
  return value;
}

function one(text: string): SqlStatement {
  const statements = parseSql(text);
  expect(statements).toHaveLength(1);
  return statements[0] as SqlStatement;
}

function select(text: string): SelectStatement {
  const statement = one(text);
  expect(statement.kind).toBe('select');
  return statement as SelectStatement;
}

function where(text: string): unknown {
  return strip(select(`SELECT * FROM t WHERE ${text}`).where);
}

function whereNode(text: string): { expression: Expression; text: string } {
  const full = `SELECT * FROM t WHERE ${text}`;
  return { expression: select(full).where as Expression, text: full };
}

function column(...parts: string[]): unknown {
  return { kind: 'column', parts };
}

function literal(value: string | number | boolean | null): unknown {
  return { kind: 'literal', value };
}

function binary(operator: string, left: unknown, right: unknown): unknown {
  return { kind: 'binary', operator, left, right };
}

function call(
  name: string,
  args: unknown[],
  flags: Partial<{ star: boolean; distinct: boolean }> = {},
): unknown {
  return { kind: 'call', name, args, star: false, distinct: false, ...flags };
}

interface Failure {
  readonly message: string;
  readonly start: number;
  readonly end: number;
  /** The text the span points at. */
  readonly at: string;
}

function failure(text: string): Failure {
  try {
    parseSql(text);
  } catch (error) {
    if (error instanceof SqlError) {
      return {
        message: error.message,
        start: error.span.start,
        end: error.span.end,
        at: text.slice(error.span.start, error.span.end),
      };
    }
    throw error;
  }
  throw new Error(`expected ${JSON.stringify(text)} to fail`);
}

function sliceOf(text: string, span: Span): string {
  return text.slice(span.start, span.end);
}

describe('parseSql select', () => {
  it('parses SELECT * FROM table with empty optional clauses', () => {
    const text = 'SELECT * FROM orders';
    const statement = select(text);
    expect(strip(statement)).toEqual({
      kind: 'select',
      distinct: false,
      top: undefined,
      columns: [{ kind: 'star', qualifier: undefined }],
      from: { name: 'orders', alias: undefined },
      joins: [],
      where: undefined,
      groupBy: [],
      having: undefined,
      orderBy: [],
      offset: undefined,
      fetch: undefined,
    });
    expect(sliceOf(text, statement.span)).toBe(text);
    expect(sliceOf(text, statement.from.span)).toBe('orders');
    expect(sliceOf(text, (statement.columns[0] as { span: Span }).span)).toBe('*');
  });

  it('parses a column list with every alias form', () => {
    const text = 'SELECT a, b AS bee, c cee, dee = d, [Full Name] AS [Name] FROM t';
    const statement = select(text);
    expect(strip(statement.columns)).toEqual([
      { kind: 'expression', expression: column('a'), alias: undefined },
      { kind: 'expression', expression: column('b'), alias: 'bee' },
      { kind: 'expression', expression: column('c'), alias: 'cee' },
      { kind: 'expression', expression: column('d'), alias: 'dee' },
      { kind: 'expression', expression: column('Full Name'), alias: 'Name' },
    ]);
    expect(statement.columns.map((item) => sliceOf(text, item.span))).toEqual([
      'a',
      'b AS bee',
      'c cee',
      'dee = d',
      '[Full Name] AS [Name]',
    ]);
  });

  it('parses a qualified star', () => {
    const text = 'SELECT o.*, c.name FROM orders o JOIN customers c ON o.customerId = c._id';
    const statement = select(text);
    expect(strip(statement.columns[0])).toEqual({ kind: 'star', qualifier: 'o' });
    expect(sliceOf(text, (statement.columns[0] as { span: Span }).span)).toBe('o.*');
  });

  it('parses DISTINCT', () => {
    expect(select('SELECT DISTINCT city FROM t').distinct).toBe(true);
    expect(select('SELECT ALL city FROM t').distinct).toBe(false);
  });

  it('parses TOP with and without parentheses', () => {
    expect(select('SELECT TOP 10 * FROM t').top).toBe(10);
    expect(select('SELECT TOP (25) * FROM t').top).toBe(25);
    expect(select('SELECT DISTINCT TOP 3 a FROM t')).toMatchObject({ distinct: true, top: 3 });
  });

  it('rejects TOP without a whole number', () => {
    expect(failure('SELECT TOP 1.5 * FROM t')).toMatchObject({
      message: "expected a whole number after TOP but found '1.5'",
      at: '1.5',
    });
    expect(failure('SELECT TOP * FROM t')).toMatchObject({
      message: "expected a whole number after TOP but found '*'",
      at: '*',
    });
  });

  it('refuses TOP 0 and FETCH NEXT 0 ROWS, which have no mongosh equivalent', () => {
    expect(failure('SELECT TOP 0 * FROM t')).toMatchObject({
      message: 'TOP 0 returns no rows and cannot be translated',
      at: '0',
    });
    expect(failure('SELECT TOP (0) * FROM t')).toMatchObject({
      message: 'TOP 0 returns no rows and cannot be translated',
      at: '0',
    });
    expect(failure('SELECT TOP 00 * FROM t')).toMatchObject({
      message: 'TOP 0 returns no rows and cannot be translated',
      at: '00',
    });
    expect(
      failure('SELECT * FROM t ORDER BY a OFFSET 5 ROWS FETCH NEXT 0 ROWS ONLY'),
    ).toMatchObject({
      message: 'FETCH 0 returns no rows and cannot be translated',
      at: '0',
    });
  });

  it('accepts OFFSET 0 ROWS and TOP 1', () => {
    expect(select('SELECT * FROM t ORDER BY a OFFSET 0 ROWS')).toMatchObject({ offset: 0 });
    expect(select('SELECT TOP 1 * FROM t').top).toBe(1);
  });

  it('drops the dbo. prefix and unwraps bracketed and quoted table names', () => {
    expect(select('SELECT * FROM dbo.orders').from.name).toBe('orders');
    expect(select('SELECT * FROM [dbo].[orders]').from.name).toBe('orders');
    expect(select('SELECT * FROM DBO.[Order Lines]').from.name).toBe('Order Lines');
    expect(select('SELECT * FROM "orders"').from.name).toBe('orders');
  });

  it('rejects a table prefix other than dbo with the span of the dotted name', () => {
    expect(failure('SELECT * FROM sales.orders')).toEqual({
      message: "table prefix 'sales' is not supported, only dbo. is accepted",
      start: 14,
      end: 26,
      at: 'sales.orders',
    });
    expect(failure('SELECT * FROM shop.dbo.orders')).toMatchObject({
      message: "table prefix 'shop.dbo' is not supported, only dbo. is accepted",
      at: 'shop.dbo.orders',
    });
  });

  it('parses a table alias with and without AS', () => {
    const text = 'SELECT * FROM orders AS o';
    const withAs = select(text);
    expect(withAs.from).toMatchObject({ name: 'orders', alias: 'o' });
    expect(sliceOf(text, withAs.from.span)).toBe('orders AS o');
    expect(select('SELECT * FROM orders o').from).toMatchObject({ name: 'orders', alias: 'o' });
    expect(select('SELECT * FROM orders [o]').from).toMatchObject({ alias: 'o' });
  });

  it('parses JOIN, INNER JOIN, LEFT JOIN and LEFT OUTER JOIN', () => {
    const text =
      'SELECT * FROM a JOIN b ON a.x = b.x INNER JOIN c ON a.y = c.y LEFT JOIN d ON d.z = a.z LEFT OUTER JOIN e AS ee ON ee.w = a.w';
    const statement = select(text);
    expect(strip(statement.joins)).toEqual([
      {
        join: 'inner',
        table: { name: 'b', alias: undefined },
        on: binary('=', column('a', 'x'), column('b', 'x')),
      },
      {
        join: 'inner',
        table: { name: 'c', alias: undefined },
        on: binary('=', column('a', 'y'), column('c', 'y')),
      },
      {
        join: 'left',
        table: { name: 'd', alias: undefined },
        on: binary('=', column('d', 'z'), column('a', 'z')),
      },
      {
        join: 'left',
        table: { name: 'e', alias: 'ee' },
        on: binary('=', column('ee', 'w'), column('a', 'w')),
      },
    ]);
    expect(statement.joins.map((join) => sliceOf(text, join.span))).toEqual([
      'JOIN b ON a.x = b.x',
      'INNER JOIN c ON a.y = c.y',
      'LEFT JOIN d ON d.z = a.z',
      'LEFT OUTER JOIN e AS ee ON ee.w = a.w',
    ]);
  });

  it('parses a join whose ON has a compound condition', () => {
    const statement = select('SELECT * FROM a JOIN b ON a.x = b.x AND b.active = 1');
    expect(strip(statement.joins[0]?.on)).toEqual(
      binary(
        'and',
        binary('=', column('a', 'x'), column('b', 'x')),
        binary('=', column('b', 'active'), literal(1)),
      ),
    );
  });

  it('parses WHERE, GROUP BY, HAVING and ORDER BY together', () => {
    const text =
      'SELECT city, COUNT(*) AS n FROM t WHERE active = 1 GROUP BY city, country HAVING COUNT(*) > 2 ORDER BY n DESC, city';
    const statement = select(text);
    expect(strip(statement.where)).toEqual(binary('=', column('active'), literal(1)));
    expect(strip(statement.groupBy)).toEqual([column('city'), column('country')]);
    expect(strip(statement.having)).toEqual(
      binary('>', call('COUNT', [], { star: true }), literal(2)),
    );
    expect(strip(statement.orderBy)).toEqual([
      { expression: column('n'), direction: 'desc' },
      { expression: column('city'), direction: 'asc' },
    ]);
    expect(statement.orderBy.map((item) => sliceOf(text, item.span))).toEqual(['n DESC', 'city']);
    expect(sliceOf(text, statement.span)).toBe(text);
  });

  it('parses ORDER BY ASC explicitly', () => {
    expect(
      select('SELECT * FROM t ORDER BY a ASC, b asc').orderBy.map((item) => item.direction),
    ).toEqual(['asc', 'asc']);
  });

  it('parses OFFSET alone and with FETCH', () => {
    expect(select('SELECT * FROM t ORDER BY a OFFSET 10 ROWS')).toMatchObject({
      offset: 10,
      fetch: undefined,
    });
    expect(
      select('SELECT * FROM t ORDER BY a OFFSET 10 ROWS FETCH NEXT 5 ROWS ONLY'),
    ).toMatchObject({
      offset: 10,
      fetch: 5,
    });
    expect(
      select('SELECT * FROM t ORDER BY a OFFSET 0 ROWS FETCH FIRST (1) ROW ONLY'),
    ).toMatchObject({
      offset: 0,
      fetch: 1,
    });
  });

  it('rejects an incomplete FETCH', () => {
    expect(failure('SELECT * FROM t OFFSET 1 ROWS FETCH NEXT 5 ROWS')).toMatchObject({
      message: 'expected ONLY but the statement ended',
      at: 'ROWS',
      start: 43,
    });
  });

  it('matches keywords case-insensitively', () => {
    const statement = select('select Top 2 a from Orders o where o.X = 1 order by a desc');
    expect(strip(statement)).toMatchObject({
      top: 2,
      from: { name: 'Orders', alias: 'o' },
      where: binary('=', column('o', 'X'), literal(1)),
      orderBy: [{ expression: column('a'), direction: 'desc' }],
    });
  });

  it('allows keywords as names only when bracketed', () => {
    expect(strip(select('SELECT [from], [select] FROM [order]').columns)).toEqual([
      { kind: 'expression', expression: column('from'), alias: undefined },
      { kind: 'expression', expression: column('select'), alias: undefined },
    ]);
    expect(failure('SELECT from FROM t')).toEqual({
      message: 'keyword FROM cannot be used as a name, write [from]',
      start: 7,
      end: 11,
      at: 'from',
    });
    expect(failure('SELECT * FROM order')).toMatchObject({
      message: 'keyword ORDER cannot be used as a name, write [order]',
      at: 'order',
    });
  });

  it('parses column parts in every notation', () => {
    const text = 'SELECT a.b.c, [a].[b], "a".b, o.[Order Id].x FROM t';
    const statement = select(text);
    expect(
      strip(statement.columns.map((item) => (item as { expression: Expression }).expression)),
    ).toEqual([
      column('a', 'b', 'c'),
      column('a', 'b'),
      column('a', 'b'),
      column('o', 'Order Id', 'x'),
    ]);
    expect(statement.columns.map((item) => sliceOf(text, item.span))).toEqual([
      'a.b.c',
      '[a].[b]',
      '"a".b',
      'o.[Order Id].x',
    ]);
  });

  it('rejects a dangling dot in a column', () => {
    expect(failure('SELECT a. FROM t')).toMatchObject({
      message: 'keyword FROM cannot be used as a name, write [FROM]',
      at: 'FROM',
    });
  });

  it('requires FROM', () => {
    expect(failure('SELECT 1')).toEqual({
      message: 'expected FROM but the statement ended',
      start: 7,
      end: 8,
      at: '1',
    });
    expect(failure('SELECT a WHERE b = 1')).toMatchObject({
      message: "expected FROM but found 'WHERE'",
      at: 'WHERE',
    });
  });

  it('rejects text after a complete statement', () => {
    expect(failure('SELECT * FROM t x y')).toEqual({
      message: "unexpected 'y' after the statement",
      start: 18,
      end: 19,
      at: 'y',
    });
  });
});

describe('parseSql expressions', () => {
  it('applies precedence across OR, AND, NOT, comparison, addition and multiplication', () => {
    expect(where('a OR b AND NOT c = 1 + 2 * 3')).toEqual(
      binary(
        'or',
        column('a'),
        binary('and', column('b'), {
          kind: 'unary',
          operator: 'not',
          operand: binary(
            '=',
            column('c'),
            binary('+', literal(1), binary('*', literal(2), literal(3))),
          ),
        }),
      ),
    );
  });

  it('gives the deep precedence case the spans of its operands', () => {
    const { expression, text } = whereNode('a OR b AND NOT c = 1 + 2 * 3');
    expect(sliceOf(text, expression.span)).toBe('a OR b AND NOT c = 1 + 2 * 3');
    const or = expression as {
      right: { span: Span; operand: { span: Span; right: { span: Span } } };
    };
    expect(sliceOf(text, or.right.span)).toBe('b AND NOT c = 1 + 2 * 3');
    const and = or.right as unknown as {
      right: { span: Span; operand: { span: Span; right: { span: Span } } };
    };
    expect(sliceOf(text, and.right.span)).toBe('NOT c = 1 + 2 * 3');
    expect(sliceOf(text, and.right.operand.span)).toBe('c = 1 + 2 * 3');
    expect(sliceOf(text, and.right.operand.right.span)).toBe('1 + 2 * 3');
  });

  it('lets parentheses override precedence', () => {
    expect(where('(a OR b) AND c')).toEqual(
      binary('and', binary('or', column('a'), column('b')), column('c')),
    );
    expect(where('(1 + 2) * 3')).toEqual(
      binary('*', binary('+', literal(1), literal(2)), literal(3)),
    );
  });

  it('parses nested parentheses', () => {
    expect(where('(((a = 1)))')).toEqual(binary('=', column('a'), literal(1)));
    expect(where('((a + (b * (c - d))))')).toEqual(
      binary('+', column('a'), binary('*', column('b'), binary('-', column('c'), column('d')))),
    );
  });

  it('reports an unclosed parenthesis', () => {
    expect(failure('SELECT * FROM t WHERE (a = 1')).toMatchObject({
      message: "expected ')' but the statement ended",
      at: '1',
    });
  });

  it('parses every comparison operator and maps != to <>', () => {
    for (const [written, operator] of [
      ['=', '='],
      ['<>', '<>'],
      ['!=', '<>'],
      ['<', '<'],
      ['<=', '<='],
      ['>', '>'],
      ['>=', '>='],
    ] as const) {
      expect(where(`a ${written} 1`)).toEqual(binary(operator, column('a'), literal(1)));
    }
  });

  it('associates arithmetic to the left and ranks * / % above + -', () => {
    expect(where('a + b * c - d / e % f')).toEqual(
      binary(
        '-',
        binary('+', column('a'), binary('*', column('b'), column('c'))),
        binary('%', binary('/', column('d'), column('e')), column('f')),
      ),
    );
    expect(where('a - b - c')).toEqual(
      binary('-', binary('-', column('a'), column('b')), column('c')),
    );
  });

  it('parses IS NULL and IS NOT NULL with their spans', () => {
    expect(where('a IS NULL')).toEqual({ kind: 'isNull', expression: column('a'), negated: false });
    const { expression, text } = whereNode('a.b IS NOT NULL AND c = 1');
    expect(strip(expression)).toEqual(
      binary(
        'and',
        { kind: 'isNull', expression: column('a', 'b'), negated: true },
        binary('=', column('c'), literal(1)),
      ),
    );
    expect(sliceOf(text, (expression as { left: Expression }).left.span)).toBe('a.b IS NOT NULL');
  });

  it('rejects IS without NULL', () => {
    expect(failure('SELECT * FROM t WHERE a IS 1')).toMatchObject({
      message: "expected NULL but found '1'",
      at: '1',
    });
  });

  it('parses IN and NOT IN with a value list', () => {
    expect(where("status IN ('a', 'b', 3)")).toEqual({
      kind: 'in',
      expression: column('status'),
      values: [literal('a'), literal('b'), literal(3)],
      negated: false,
    });
    const { expression, text } = whereNode('x NOT IN (1 + 1, -2)');
    expect(strip(expression)).toEqual({
      kind: 'in',
      expression: column('x'),
      values: [binary('+', literal(1), literal(1)), literal(-2)],
      negated: true,
    });
    expect(sliceOf(text, expression.span)).toBe('x NOT IN (1 + 1, -2)');
  });

  it('rejects an empty IN list', () => {
    expect(failure('SELECT * FROM t WHERE a IN ()')).toEqual({
      message: 'IN needs at least one value',
      start: 27,
      end: 29,
      at: '()',
    });
  });

  it('parses BETWEEN and NOT BETWEEN, keeping the following AND for the outer expression', () => {
    expect(where('a BETWEEN 1 AND 10')).toEqual({
      kind: 'between',
      expression: column('a'),
      low: literal(1),
      high: literal(10),
      negated: false,
    });
    const { expression, text } = whereNode('a NOT BETWEEN b - 1 AND b + 1 AND c = 2');
    expect(strip(expression)).toEqual(
      binary(
        'and',
        {
          kind: 'between',
          expression: column('a'),
          low: binary('-', column('b'), literal(1)),
          high: binary('+', column('b'), literal(1)),
          negated: true,
        },
        binary('=', column('c'), literal(2)),
      ),
    );
    expect(sliceOf(text, (expression as { left: Expression }).left.span)).toBe(
      'a NOT BETWEEN b - 1 AND b + 1',
    );
  });

  it('parses LIKE, NOT LIKE and ESCAPE', () => {
    expect(where("name LIKE 'a%'")).toEqual({
      kind: 'like',
      expression: column('name'),
      pattern: literal('a%'),
      escape: undefined,
      negated: false,
    });
    const { expression, text } = whereNode("name NOT LIKE '50!%' ESCAPE '!'");
    expect(strip(expression)).toEqual({
      kind: 'like',
      expression: column('name'),
      pattern: literal('50!%'),
      escape: '!',
      negated: true,
    });
    expect(sliceOf(text, expression.span)).toBe("name NOT LIKE '50!%' ESCAPE '!'");
  });

  it('rejects an ESCAPE that is not a one character string', () => {
    expect(failure("SELECT * FROM t WHERE a LIKE 'x' ESCAPE 'ab'")).toMatchObject({
      message: "expected a one character string after ESCAPE but found ''ab''",
      at: "'ab'",
    });
    expect(failure("SELECT * FROM t WHERE a LIKE 'x' ESCAPE 1")).toMatchObject({ at: '1' });
  });

  it('rejects NOT followed by something other than IN, BETWEEN or LIKE', () => {
    expect(failure('SELECT * FROM t WHERE a NOT = 1')).toMatchObject({
      message: "expected IN, BETWEEN or LIKE after NOT but found '='",
      at: '=',
    });
  });

  it('parses NULL, TRUE and FALSE literals', () => {
    expect(where('a = NULL')).toEqual(binary('=', column('a'), literal(null)));
    expect(where('a = true OR b = FALSE')).toEqual(
      binary(
        'or',
        binary('=', column('a'), literal(true)),
        binary('=', column('b'), literal(false)),
      ),
    );
  });

  it('parses strings with escapes and the N prefix', () => {
    expect(where("a = 'it''s' OR b = N'ünïcode'")).toEqual(
      binary(
        'or',
        binary('=', column('a'), literal("it's")),
        binary('=', column('b'), literal('ünïcode')),
      ),
    );
    const { expression, text } = whereNode("a = N'x'");
    expect(sliceOf(text, (expression as { right: Expression }).right.span)).toBe("N'x'");
  });

  it('parses numbers with Number()', () => {
    expect(where('a = 1.5 OR a = .5 OR a = 1e3 OR a = 007')).toEqual(
      binary(
        'or',
        binary(
          'or',
          binary(
            'or',
            binary('=', column('a'), literal(1.5)),
            binary('=', column('a'), literal(0.5)),
          ),
          binary('=', column('a'), literal(1000)),
        ),
        binary('=', column('a'), literal(7)),
      ),
    );
  });

  it('folds a minus before a number into a negative literal with the span of both', () => {
    const { expression, text } = whereNode('a > -1.5');
    expect(strip(expression)).toEqual(binary('>', column('a'), literal(-1.5)));
    expect(sliceOf(text, (expression as { right: Expression }).right.span)).toBe('-1.5');
  });

  it('keeps a minus before a column or call as a negate node', () => {
    const { expression, text } = whereNode('-a < -ABS(b) AND - -c = 1');
    expect(strip(expression)).toEqual(
      binary(
        'and',
        binary(
          '<',
          { kind: 'unary', operator: 'negate', operand: column('a') },
          { kind: 'unary', operator: 'negate', operand: call('ABS', [column('b')]) },
        ),
        binary(
          '=',
          {
            kind: 'unary',
            operator: 'negate',
            operand: { kind: 'unary', operator: 'negate', operand: column('c') },
          },
          literal(1),
        ),
      ),
    );
    expect(
      sliceOf(
        text,
        ((expression as { left: Expression }).left as { right: Expression }).right.span,
      ),
    ).toBe('-ABS(b)');
  });

  it('accepts a unary plus and drops it', () => {
    expect(where('a = +1')).toEqual(binary('=', column('a'), literal(1)));
  });

  it('parses calls with arguments, COUNT(*) and COUNT(DISTINCT x)', () => {
    const text =
      'SELECT COUNT(*), count(DISTINCT city), SUM(total), ISNULL(a, 0), GETDATE(), IIF(a > 1, 1, 0) FROM t';
    const statement = select(text);
    expect(
      strip(statement.columns.map((item) => (item as { expression: Expression }).expression)),
    ).toEqual([
      call('COUNT', [], { star: true }),
      call('COUNT', [column('city')], { distinct: true }),
      call('SUM', [column('total')]),
      call('ISNULL', [column('a'), literal(0)]),
      call('GETDATE', []),
      call('IIF', [binary('>', column('a'), literal(1)), literal(1), literal(0)]),
    ]);
    expect(statement.columns.map((item) => sliceOf(text, item.span))).toEqual([
      'COUNT(*)',
      'count(DISTINCT city)',
      'SUM(total)',
      'ISNULL(a, 0)',
      'GETDATE()',
      'IIF(a > 1, 1, 0)',
    ]);
  });

  it('parses CURRENT_TIMESTAMP without parentheses as a call', () => {
    expect(where('a < CURRENT_TIMESTAMP')).toEqual(
      binary('<', column('a'), call('CURRENT_TIMESTAMP', [])),
    );
  });

  it('parses LEFT and RIGHT as functions when a parenthesis follows', () => {
    expect(where("LEFT(name, 3) = 'abc' AND RIGHT(name, 1) = 'z'")).toEqual(
      binary(
        'and',
        binary('=', call('LEFT', [column('name'), literal(3)]), literal('abc')),
        binary('=', call('RIGHT', [column('name'), literal(1)]), literal('z')),
      ),
    );
  });

  it('parses nested calls', () => {
    expect(where('UPPER(LTRIM(RTRIM(name))) = a')).toEqual(
      binary('=', call('UPPER', [call('LTRIM', [call('RTRIM', [column('name')])])]), column('a')),
    );
  });

  it('parses CAST with every type name', () => {
    const cases: [string, SqlType][] = [
      ['INT', 'int'],
      ['integer', 'int'],
      ['SMALLINT', 'int'],
      ['TINYINT', 'int'],
      ['BIGINT', 'bigint'],
      ['FLOAT', 'float'],
      ['REAL', 'float'],
      ['DECIMAL', 'decimal'],
      ['NUMERIC', 'decimal'],
      ['MONEY', 'decimal'],
      ['BIT', 'bit'],
      ['DATE', 'date'],
      ['DATETIME', 'datetime'],
      ['DATETIME2', 'datetime'],
      ['SMALLDATETIME', 'datetime'],
      ['DATETIMEOFFSET', 'datetime'],
      ['VARCHAR', 'string'],
      ['NVARCHAR', 'string'],
      ['CHAR', 'string'],
      ['NCHAR', 'string'],
      ['TEXT', 'string'],
      ['NTEXT', 'string'],
      ['OBJECTID', 'objectId'],
    ];
    for (const [name, type] of cases) {
      expect(where(`a = CAST(b AS ${name})`), name).toEqual(
        binary('=', column('a'), { kind: 'cast', expression: column('b'), type }),
      );
    }
  });

  it('parses CAST with a type length and keeps the span of the whole call', () => {
    const { expression, text } = whereNode(
      "CAST(a AS NVARCHAR(50)) = 'x' OR CAST(b AS DECIMAL(10, 2)) = 1 OR CAST(c AS VARCHAR(MAX)) = 'y'",
    );
    const [first, second, third] = flattenOr(expression);
    expect(strip(first)).toEqual(
      binary('=', { kind: 'cast', expression: column('a'), type: 'string' }, literal('x')),
    );
    expect(strip(second)).toEqual(
      binary('=', { kind: 'cast', expression: column('b'), type: 'decimal' }, literal(1)),
    );
    expect(strip(third)).toEqual(
      binary('=', { kind: 'cast', expression: column('c'), type: 'string' }, literal('y')),
    );
    expect(sliceOf(text, (first as { left: Expression }).left.span)).toBe(
      'CAST(a AS NVARCHAR(50))',
    );
    expect(sliceOf(text, (second as { left: Expression }).left.span)).toBe(
      'CAST(b AS DECIMAL(10, 2))',
    );
  });

  it('parses CONVERT with and without a style argument', () => {
    expect(where("a = CONVERT(DATE, '2026-01-01')")).toEqual(
      binary('=', column('a'), { kind: 'cast', expression: literal('2026-01-01'), type: 'date' }),
    );
    const { expression, text } = whereNode('a = CONVERT(NVARCHAR(10), b, 120)');
    expect(strip(expression)).toEqual(
      binary('=', column('a'), { kind: 'cast', expression: column('b'), type: 'string' }),
    );
    expect(sliceOf(text, (expression as { right: Expression }).right.span)).toBe(
      'CONVERT(NVARCHAR(10), b, 120)',
    );
  });

  it('rejects an unknown type name with its span', () => {
    expect(failure('SELECT * FROM t WHERE a = CAST(b AS XML)')).toEqual({
      message: "type 'XML' is not supported",
      start: 36,
      end: 39,
      at: 'XML',
    });
    expect(failure('SELECT CONVERT(uniqueidentifier, a) FROM t')).toMatchObject({
      message: "type 'uniqueidentifier' is not supported",
      at: 'uniqueidentifier',
    });
  });

  it('rejects a CAST without AS', () => {
    expect(failure('SELECT * FROM t WHERE a = CAST(b, INT)')).toMatchObject({
      message: "expected AS but found ','",
      at: ',',
    });
  });

  it('parses a simple CASE', () => {
    const { expression, text } = whereNode(
      "CASE status WHEN 1 THEN 'a' WHEN 2 THEN 'b' ELSE 'c' END = 'a'",
    );
    expect(strip(expression)).toEqual(
      binary(
        '=',
        {
          kind: 'case',
          operand: column('status'),
          whens: [
            { when: literal(1), then: literal('a') },
            { when: literal(2), then: literal('b') },
          ],
          else: literal('c'),
        },
        literal('a'),
      ),
    );
    expect(sliceOf(text, (expression as { left: Expression }).left.span)).toBe(
      "CASE status WHEN 1 THEN 'a' WHEN 2 THEN 'b' ELSE 'c' END",
    );
  });

  it('parses a searched CASE without ELSE', () => {
    expect(where("CASE WHEN a > 1 AND b = 2 THEN 'x' END IS NULL")).toEqual({
      kind: 'isNull',
      negated: false,
      expression: {
        kind: 'case',
        operand: undefined,
        whens: [
          {
            when: binary(
              'and',
              binary('>', column('a'), literal(1)),
              binary('=', column('b'), literal(2)),
            ),
            then: literal('x'),
          },
        ],
        else: undefined,
      },
    });
  });

  it('parses a nested CASE', () => {
    expect(where('CASE WHEN a THEN CASE b WHEN 1 THEN 2 END ELSE 3 END = 2')).toEqual(
      binary(
        '=',
        {
          kind: 'case',
          operand: undefined,
          whens: [
            {
              when: column('a'),
              then: {
                kind: 'case',
                operand: column('b'),
                whens: [{ when: literal(1), then: literal(2) }],
                else: undefined,
              },
            },
          ],
          else: literal(3),
        },
        literal(2),
      ),
    );
  });

  it('rejects a CASE without WHEN or without END', () => {
    expect(failure('SELECT CASE a END FROM t')).toMatchObject({
      message: "expected WHEN after CASE but found 'END'",
      at: 'END',
    });
    expect(failure('SELECT CASE WHEN a THEN 1 FROM t')).toMatchObject({
      message: "expected END but found 'FROM'",
      at: 'FROM',
    });
  });

  it('reports a missing expression at the end of the statement', () => {
    expect(failure('SELECT * FROM t WHERE a =')).toEqual({
      message: 'expected an expression but the statement ended',
      start: 24,
      end: 25,
      at: '=',
    });
    expect(failure('SELECT * FROM t WHERE a = )')).toMatchObject({
      message: "expected an expression but found ')'",
      at: ')',
    });
  });
});

function flattenOr(expression: Expression): Expression[] {
  if (expression.kind === 'binary' && expression.operator === 'or') {
    return [...flattenOr(expression.left), ...flattenOr(expression.right)];
  }
  return [expression];
}

describe('parseSql writes', () => {
  it('parses UPDATE with several assignments and WHERE', () => {
    const text =
      "UPDATE dbo.orders SET status = 'archived', archivedAt = GETDATE(), meta.count = meta.count + 1 WHERE createdAt < CAST('2025-01-01' AS DATE)";
    const statement = one(text);
    expect(strip(statement)).toEqual({
      kind: 'update',
      table: { name: 'orders', alias: undefined },
      assignments: [
        { column: column('status'), value: literal('archived') },
        { column: column('archivedAt'), value: call('GETDATE', []) },
        {
          column: column('meta', 'count'),
          value: binary('+', column('meta', 'count'), literal(1)),
        },
      ],
      where: binary('<', column('createdAt'), {
        kind: 'cast',
        expression: literal('2025-01-01'),
        type: 'date',
      }),
    });
    expect(sliceOf(text, statement.span)).toBe(text);
    if (statement.kind === 'update') {
      expect(statement.assignments.map((item) => sliceOf(text, item.span))).toEqual([
        "status = 'archived'",
        'archivedAt = GETDATE()',
        'meta.count = meta.count + 1',
      ]);
    }
  });

  it('parses UPDATE without WHERE', () => {
    expect(strip(one('UPDATE t SET a = NULL'))).toEqual({
      kind: 'update',
      table: { name: 't', alias: undefined },
      assignments: [{ column: column('a'), value: literal(null) }],
      where: undefined,
    });
  });

  it('rejects UPDATE without SET', () => {
    expect(failure('UPDATE t WHERE a = 1')).toMatchObject({
      message: "expected SET but found 'WHERE'",
      at: 'WHERE',
    });
  });

  it('parses DELETE with and without FROM and WHERE', () => {
    expect(strip(one('DELETE FROM orders WHERE a = 1'))).toEqual({
      kind: 'delete',
      table: { name: 'orders', alias: undefined },
      where: binary('=', column('a'), literal(1)),
    });
    expect(strip(one('DELETE [orders]'))).toEqual({
      kind: 'delete',
      table: { name: 'orders', alias: undefined },
      where: undefined,
    });
  });

  it('parses TRUNCATE TABLE as a DELETE without WHERE', () => {
    const text = 'TRUNCATE TABLE dbo.orders';
    const statement = one(text);
    expect(strip(statement)).toEqual({
      kind: 'delete',
      table: { name: 'orders', alias: undefined },
      where: undefined,
    });
    expect(sliceOf(text, statement.span)).toBe(text);
  });

  it('parses INSERT with one row and with several', () => {
    const text =
      "INSERT INTO orders (name, address.city, total) VALUES ('a', 'Ljubljana', 1.5), (N'b', NULL, -2)";
    const statement = one(text);
    expect(strip(statement)).toEqual({
      kind: 'insert',
      table: { name: 'orders', alias: undefined },
      columns: [column('name'), column('address', 'city'), column('total')],
      rows: [
        [literal('a'), literal('Ljubljana'), literal(1.5)],
        [literal('b'), literal(null), literal(-2)],
      ],
    });
    expect(sliceOf(text, statement.span)).toBe(text);
    if (statement.kind === 'insert') {
      expect(sliceOf(text, (statement.columns[1] as { span: Span }).span)).toBe('address.city');
    }
  });

  it('parses INSERT without INTO and with expressions in the values', () => {
    expect(strip(one("INSERT t (a, b) VALUES (GETDATE(), CAST('1' AS INT) + 1)"))).toMatchObject({
      kind: 'insert',
      columns: [column('a'), column('b')],
      rows: [
        [
          call('GETDATE', []),
          binary('+', { kind: 'cast', expression: literal('1'), type: 'int' }, literal(1)),
        ],
      ],
    });
  });

  it('requires a column list in INSERT', () => {
    expect(failure("INSERT INTO t VALUES ('a')")).toEqual({
      message: 'INSERT needs a column list before VALUES',
      start: 14,
      end: 20,
      at: 'VALUES',
    });
    expect(failure('INSERT INTO t DEFAULT VALUES')).toMatchObject({
      message: 'INSERT needs a column list before VALUES',
      at: 'VALUES',
    });
  });

  it('rejects INSERT rows that are not parenthesised', () => {
    expect(failure("INSERT INTO t (a) VALUES 'x'")).toMatchObject({
      message: "expected '(' but found ''x''",
      at: "'x'",
    });
  });
});

describe('parseSql refusals', () => {
  const cases: [string, string, string][] = [
    ['SELECT TOP 10 PERCENT * FROM t', 'TOP ... PERCENT is not supported', 'PERCENT'],
    ['SELECT TOP 10 WITH TIES * FROM t ORDER BY a', 'WITH TIES is not supported', 'WITH TIES'],
    ['SELECT * FROM a RIGHT JOIN b ON a.x = b.x', 'RIGHT JOIN is not supported', 'RIGHT JOIN'],
    [
      'SELECT * FROM a RIGHT OUTER JOIN b ON a.x = b.x',
      'RIGHT JOIN is not supported',
      'RIGHT OUTER JOIN',
    ],
    ['SELECT * FROM a FULL JOIN b ON a.x = b.x', 'FULL JOIN is not supported', 'FULL JOIN'],
    [
      'SELECT * FROM a full outer join b ON a.x = b.x',
      'FULL JOIN is not supported',
      'full outer join',
    ],
    ['SELECT * FROM a CROSS JOIN b', 'CROSS JOIN is not supported', 'CROSS JOIN'],
    ['SELECT * FROM a CROSS APPLY f(a.x)', 'CROSS APPLY is not supported', 'CROSS APPLY'],
    ['SELECT * FROM a OUTER APPLY f(a.x)', 'OUTER APPLY is not supported', 'OUTER APPLY'],
    ['SELECT * FROM a, b WHERE a.x = b.x', 'comma joins are not supported, use JOIN ... ON', ','],
    ['SELECT * FROM a UNION SELECT * FROM b', 'UNION is not supported', 'UNION'],
    ['SELECT * FROM a UNION ALL SELECT * FROM b', 'UNION is not supported', 'UNION'],
    ['SELECT * FROM a EXCEPT SELECT * FROM b', 'EXCEPT is not supported', 'EXCEPT'],
    ['SELECT * FROM a INTERSECT SELECT * FROM b', 'INTERSECT is not supported', 'INTERSECT'],
    [
      'WITH c AS (SELECT * FROM t) SELECT * FROM c',
      'WITH (common table expressions) is not supported',
      'WITH',
    ],
    [
      'SELECT * FROM t WHERE a IN (SELECT a FROM u)',
      'subqueries are not supported',
      '(SELECT a FROM u)',
    ],
    [
      'SELECT * FROM t WHERE a = (SELECT MAX(a) FROM u)',
      'subqueries are not supported',
      '(SELECT MAX(a) FROM u)',
    ],
    [
      'SELECT * FROM t WHERE a = (SELECT MAX(a) FROM u WHERE (b > 1))',
      'subqueries are not supported',
      '(SELECT MAX(a) FROM u WHERE (b > 1))',
    ],
    ['SELECT * FROM (SELECT * FROM t) AS s', 'subqueries are not supported', '(SELECT * FROM t)'],
    ['SELECT (SELECT 1) AS one FROM t', 'subqueries are not supported', '(SELECT 1)'],
    ['(SELECT * FROM t)', 'subqueries are not supported', '(SELECT * FROM t)'],
    ['SELECT * FROM t WHERE a = (SELECT 1', 'subqueries are not supported', '(SELECT 1'],
    ['SELECT a INTO u FROM t', 'SELECT ... INTO is not supported', 'INTO'],
    ['INSERT INTO t (a) SELECT a FROM u', 'INSERT ... SELECT is not supported', 'SELECT'],
    ['INSERT INTO t SELECT a FROM u', 'INSERT ... SELECT is not supported', 'SELECT'],
    [
      'UPDATE t SET a = u.a FROM t JOIN u ON t.id = u.id',
      'UPDATE ... FROM is not supported',
      'FROM',
    ],
    ['UPDATE TOP (10) t SET a = 1', 'UPDATE with TOP is not supported', 'TOP'],
    ['DELETE TOP (10) FROM t', 'DELETE with TOP is not supported', 'TOP'],
    ['DELETE t FROM t JOIN u ON t.id = u.id', 'DELETE with JOIN is not supported', 'FROM'],
    ['DELETE FROM t INNER JOIN u ON t.id = u.id', 'DELETE with JOIN is not supported', 'INNER'],
    ['SELECT * FROM t WHERE EXISTS (SELECT 1 FROM u)', 'EXISTS is not supported', 'EXISTS'],
    ['SELECT * FROM t WHERE NOT EXISTS (SELECT 1 FROM u)', 'EXISTS is not supported', 'EXISTS'],
    [
      'SELECT ROW_NUMBER() OVER (ORDER BY a) FROM t',
      'window functions (OVER) are not supported',
      'OVER',
    ],
    [
      'SELECT SUM(a) over (PARTITION BY b) FROM t',
      'window functions (OVER) are not supported',
      'over',
    ],
    ['SELECT a FROM t GROUP BY ROLLUP(a)', 'GROUP BY ROLLUP is not supported', 'ROLLUP'],
    ['SELECT a FROM t GROUP BY a, CUBE(b)', 'GROUP BY CUBE is not supported', 'CUBE'],
    ['SELECT a FROM t GROUP BY a WITH ROLLUP', 'GROUP BY ROLLUP is not supported', 'ROLLUP'],
    ['SELECT a FROM t GROUP BY a WITH CUBE', 'GROUP BY CUBE is not supported', 'CUBE'],
    [
      'SELECT a FROM t GROUP BY GROUPING SETS ((a), (b))',
      'GROUP BY GROUPING SETS is not supported',
      'GROUPING SETS',
    ],
    [
      'SELECT * FROM t WITH (NOLOCK)',
      'table hints such as WITH (NOLOCK) are not supported',
      'WITH (NOLOCK)',
    ],
    [
      'SELECT * FROM t o WITH (NOLOCK, INDEX(0)) WHERE a = 1',
      'table hints such as WITH (NOLOCK) are not supported',
      'WITH (NOLOCK, INDEX(0))',
    ],
    [
      'UPDATE t WITH (ROWLOCK) SET a = 1',
      'table hints such as WITH (NOLOCK) are not supported',
      'WITH (ROWLOCK)',
    ],
    ['SELECT * FROM t WHERE a = @id', 'parameters are not supported', '@id'],
    ['SELECT TOP @n * FROM t', 'parameters are not supported', '@n'],
    ['SELECT @@ROWCOUNT FROM t', 'parameters are not supported', '@@ROWCOUNT'],
    ['UPDATE t SET @x = 1', 'parameters are not supported', '@x'],
    ['@x', 'parameters are not supported', '@x'],
    ['DECLARE @x INT = 1', 'DECLARE is not supported', 'DECLARE'],
  ];

  for (const [text, message, at] of cases) {
    it(`refuses ${text}`, () => {
      const result = failure(text);
      expect(result.message).toBe(message);
      expect(result.at).toBe(at);
      expect(result.start).toBe(text.indexOf(at));
      expect(result.end).toBe(text.indexOf(at) + at.length);
    });
  }

  it('refuses other statement kinds with one message and the span of the first word', () => {
    for (const text of [
      'CREATE TABLE t (a INT)',
      'DROP TABLE t',
      'ALTER TABLE t ADD b INT',
      'EXEC sp_who',
      'MERGE INTO t USING u ON t.id = u.id',
      'SET NOCOUNT ON',
      'USE shop',
      'BEGIN TRANSACTION',
      'grant select on t to u',
    ]) {
      const word = text.split(' ')[0] as string;
      expect(failure(text), text).toEqual({
        message: 'Only SELECT, UPDATE, DELETE, INSERT and TRUNCATE statements are supported',
        start: 0,
        end: word.length,
        at: word,
      });
    }
  });

  it('refuses a statement that starts with a string or number', () => {
    expect(failure("'abc'")).toMatchObject({
      message: 'Only SELECT, UPDATE, DELETE, INSERT and TRUNCATE statements are supported',
      at: "'abc'",
    });
    expect(failure('42')).toMatchObject({ at: '42' });
  });
});

describe('splitSqlStatements', () => {
  it('splits on semicolons and trims whitespace', () => {
    const text = '  SELECT 1 ;\n  SELECT 2  ;  ';
    const spans = splitSqlStatements(text);
    expect(spans.map((span) => sliceOf(text, span))).toEqual(['SELECT 1', 'SELECT 2']);
    expect(spans).toEqual([
      { start: 2, end: 10 },
      { start: 15, end: 23 },
    ]);
  });

  it('splits on GO alone on its line, in any case', () => {
    const text = 'SELECT 1\nGO\nSELECT 2\n  go  \nSELECT 3\nGo';
    expect(splitSqlStatements(text).map((span) => sliceOf(text, span))).toEqual([
      'SELECT 1',
      'SELECT 2',
      'SELECT 3',
    ]);
  });

  it('keeps GO that shares a line with other tokens', () => {
    const text = 'SELECT go FROM t GO';
    expect(splitSqlStatements(text).map((span) => sliceOf(text, span))).toEqual([text]);
    const leading = 'GO SELECT 1';
    expect(splitSqlStatements(leading).map((span) => sliceOf(leading, span))).toEqual([leading]);
  });

  it('treats GO as a separator with Windows line endings', () => {
    const text = 'SELECT 1\r\nGO\r\nSELECT 2\r\n';
    const spans = splitSqlStatements(text);
    expect(spans.map((span) => sliceOf(text, span))).toEqual(['SELECT 1', 'SELECT 2']);
    expect(spans[1]).toEqual({ start: 14, end: 22 });
  });

  it('drops empty segments and segments with only comments', () => {
    const text = ';;SELECT 1;; -- done\n/* end */;';
    expect(splitSqlStatements(text).map((span) => sliceOf(text, span))).toEqual(['SELECT 1']);
    expect(splitSqlStatements('')).toEqual([]);
    expect(splitSqlStatements('  \n ')).toEqual([]);
    expect(splitSqlStatements('-- only a comment')).toEqual([]);
    expect(splitSqlStatements('GO\nGO')).toEqual([]);
  });

  it('keeps a comment that belongs to a statement inside its span', () => {
    const text = '-- first\nSELECT 1 -- trailing\n;\nSELECT 2 /* x */';
    expect(splitSqlStatements(text).map((span) => sliceOf(text, span))).toEqual([
      '-- first\nSELECT 1 -- trailing',
      'SELECT 2 /* x */',
    ]);
  });

  it('ignores separators inside strings, brackets and comments', () => {
    const text = "SELECT ';' AS [a;b] /* ; GO */ FROM t -- ;\n; SELECT 2";
    expect(splitSqlStatements(text).map((span) => sliceOf(text, span))).toEqual([
      "SELECT ';' AS [a;b] /* ; GO */ FROM t -- ;",
      'SELECT 2',
    ]);
    const block = 'SELECT 1 /*\nGO\n*/ FROM t';
    expect(splitSqlStatements(block)).toEqual([{ start: 0, end: block.length }]);
  });

  it('does not throw on an unterminated string and keeps the rest in one statement', () => {
    const text = "SELECT 1; SELECT 'abc; SELECT 2";
    expect(splitSqlStatements(text).map((span) => sliceOf(text, span))).toEqual([
      'SELECT 1',
      "SELECT 'abc; SELECT 2",
    ]);
  });
});

describe('parseSql with several statements', () => {
  it('returns the statements in order with absolute spans', () => {
    const text = "SELECT a FROM t;\nUPDATE u SET b = 'x' WHERE c = 1;\nGO\nDELETE FROM v";
    const statements = parseSql(text);
    expect(statements.map((statement) => statement.kind)).toEqual(['select', 'update', 'delete']);
    const update = statements[1];
    expect(update && sliceOf(text, update.span)).toBe("UPDATE u SET b = 'x' WHERE c = 1");
    if (update?.kind === 'update') {
      expect(sliceOf(text, update.table.span)).toBe('u');
      expect(sliceOf(text, update.where?.span as Span)).toBe('c = 1');
      expect(sliceOf(text, (update.assignments[0] as { value: Expression }).value.span)).toBe(
        "'x'",
      );
      expect(update.assignments[0]?.value.span).toEqual({ start: 34, end: 37 });
    }
    expect(statements[2]?.span).toEqual({ start: 54, end: 67 });
  });

  it('reports an error in the second statement with an absolute span', () => {
    const text = 'SELECT 1 FROM t;\nSELECT * FROM t WHERE a = @p';
    expect(failure(text)).toEqual({
      message: 'parameters are not supported',
      start: 43,
      end: 45,
      at: '@p',
    });
  });

  it('reports an unterminated string in the second statement with an absolute span', () => {
    const text = "SELECT 1 FROM t;\nSELECT 'oops FROM t";
    expect(failure(text)).toEqual({ message: 'unterminated string', start: 24, end: 25, at: "'" });
  });

  it('ignores comments and whitespace between and inside statements', () => {
    const text =
      '/* header */\nSELECT -- pick\n\ta /* the column */ ,\r\n\tb\nFROM\n\tt -- table\nWHERE a/*x*/=/*y*/1\n;\n-- footer';
    const statements = parseSql(text);
    expect(statements).toHaveLength(1);
    expect(strip(statements[0])).toMatchObject({
      columns: [
        { kind: 'expression', expression: column('a'), alias: undefined },
        { kind: 'expression', expression: column('b'), alias: undefined },
      ],
      from: { name: 't', alias: undefined },
      where: binary('=', column('a'), literal(1)),
    });
    const statement = statements[0] as SelectStatement;
    expect(sliceOf(text, statement.span)).toBe(
      'SELECT -- pick\n\ta /* the column */ ,\r\n\tb\nFROM\n\tt -- table\nWHERE a/*x*/=/*y*/1',
    );
    expect(sliceOf(text, statement.where?.span as Span)).toBe('a/*x*/=/*y*/1');
  });

  it('returns nothing for text without statements', () => {
    expect(parseSql('')).toEqual([]);
    expect(parseSql('-- nothing\n;;')).toEqual([]);
  });
});

describe('parseStatement', () => {
  it('adds the offset to every span', () => {
    const statement = parseStatement('SELECT a FROM t', 100);
    expect(statement.span).toEqual({ start: 100, end: 115 });
    expect(statement.kind === 'select' && statement.from.span).toEqual({ start: 114, end: 115 });
    expect(statement.kind === 'select' && statement.columns[0]?.span).toEqual({
      start: 107,
      end: 108,
    });
  });

  it('adds the offset to error spans', () => {
    try {
      parseStatement('SELECT a FROM t WHERE', 10);
      throw new Error('expected a failure');
    } catch (error) {
      expect(error).toBeInstanceOf(SqlError);
      expect((error as SqlError).message).toBe('expected an expression but the statement ended');
      expect((error as SqlError).span).toEqual({ start: 26, end: 31 });
    }
  });

  it('rejects an empty statement with the span of the text', () => {
    try {
      parseStatement('  -- nothing ', 5);
      throw new Error('expected a failure');
    } catch (error) {
      expect((error as SqlError).message).toBe('the statement is empty');
      expect((error as SqlError).span).toEqual({ start: 5, end: 18 });
    }
  });

  it('parses a statement with a trailing semicolon removed by the splitter only', () => {
    expect(() => parseStatement('SELECT a FROM t;', 0)).toThrow(
      "unexpected ';' after the statement",
    );
  });
});

// Regressions from the adversarial rounds.

describe('regression: GO followed by a comment', () => {
  it('ends the batch at GO followed by a line comment', () => {
    const text = 'SELECT 1\nGO -- run it\nSELECT 2';
    expect(splitSqlStatements(text).map((span) => sliceOf(text, span))).toEqual([
      'SELECT 1',
      'SELECT 2',
    ]);
  });

  it('ends the batch at GO followed by a line comment at the end of the text', () => {
    const text = 'SELECT t.a FROM t\nGO -- run it';
    expect(splitSqlStatements(text).map((span) => sliceOf(text, span))).toEqual([
      'SELECT t.a FROM t',
    ]);
    const statement = parseSql(text)[0];
    expect(statement?.kind).toBe('select');
    expect(statement?.kind === 'select' ? statement.from.alias : 'x').toBeUndefined();
  });

  it('ends the batch at GO followed by a block comment on the same line', () => {
    const text = 'SELECT 1\nGO /* batch */\nSELECT 2';
    expect(splitSqlStatements(text).map((span) => sliceOf(text, span))).toEqual([
      'SELECT 1',
      'SELECT 2',
    ]);
    const trailing = 'SELECT 1\nGO /* a */ /* b */  ';
    expect(splitSqlStatements(trailing).map((span) => sliceOf(trailing, span))).toEqual([
      'SELECT 1',
    ]);
  });

  it('keeps GO when a block comment is followed by more tokens on the line', () => {
    const text = 'SELECT 1\nGO /* a */ SELECT 2';
    expect(splitSqlStatements(text).map((span) => sliceOf(text, span))).toEqual([text]);
  });

  it('keeps GO that follows a comment on the same line', () => {
    const text = 'SELECT 1 /* a */ GO\nSELECT 2';
    expect(splitSqlStatements(text).map((span) => sliceOf(text, span))).toEqual([text]);
  });

  it('keeps a GO that is not alone on its line', () => {
    const text = 'SELECT go FROM t GO -- c';
    expect(splitSqlStatements(text).map((span) => sliceOf(text, span))).toEqual([text]);
  });

  it('handles Windows line endings after the comment', () => {
    const text = 'SELECT 1\r\nGO -- c\r\nSELECT 2\r\n';
    expect(splitSqlStatements(text).map((span) => sliceOf(text, span))).toEqual([
      'SELECT 1',
      'SELECT 2',
    ]);
  });
});

describe('regression: number literals that overflow', () => {
  it('refuses a literal that overflows to Infinity, pointing at it', () => {
    expect(failure('SELECT * FROM t WHERE a = 1e400')).toEqual({
      message: 'the floating point value is out of range',
      start: 26,
      end: 31,
      at: '1e400',
    });
  });

  it('refuses a negative overflow and one in a select list', () => {
    expect(failure('SELECT * FROM t WHERE a = -1e309').at).toBe('1e309');
    expect(failure('SELECT 2e308 AS x FROM t').at).toBe('2e308');
  });

  it('accepts the largest finite double', () => {
    expect(where('a = 1.7976931348623157e308')).toEqual(
      binary('=', column('a'), literal(1.7976931348623157e308)),
    );
  });
});

describe('regression: temporary table names', () => {
  it('refuses SELECT INTO a temp table at INTO', () => {
    expect(failure('SELECT a INTO #tmp FROM t')).toEqual({
      message: 'SELECT ... INTO is not supported',
      start: 9,
      end: 13,
      at: 'INTO',
    });
    expect(failure('SELECT a INTO ##shared FROM t').at).toBe('INTO');
  });

  it('refuses a temp table in FROM, JOIN and the writes', () => {
    expect(failure('SELECT * FROM #tmp')).toEqual({
      message: 'temporary tables are not supported',
      start: 14,
      end: 18,
      at: '#tmp',
    });
    expect(failure('SELECT * FROM t JOIN ##shared s ON t.id = s.id').at).toBe('##shared');
    expect(failure('UPDATE #tmp SET a = 1').at).toBe('#tmp');
    expect(failure('DELETE FROM #tmp').at).toBe('#tmp');
    expect(failure('INSERT INTO #tmp (a) VALUES (1)').at).toBe('#tmp');
    expect(failure('TRUNCATE TABLE #tmp').at).toBe('#tmp');
  });

  it('refuses a temp table with a dbo prefix at the whole name', () => {
    expect(failure('SELECT * FROM dbo.#tmp').at).toBe('dbo.#tmp');
  });

  it('splits at GO before the next statement, leaving the comment out of both spans', () => {
    const text = 'SELECT 1\nGO -- run it\n  SELECT 2';
    expect(splitSqlStatements(text)).toEqual([
      { start: 0, end: 8 },
      { start: 24, end: 32 },
    ]);
  });

  it('still refuses a bare hash as a character', () => {
    expect(failure('SELECT * FROM t WHERE a = 1 # 2')).toMatchObject({
      message: "unexpected character '#'",
      at: '#',
    });
  });
});
