/**
 * A recursive descent parser for the T-SQL subset the editor translates to mongosh. It builds the
 * tree in `ast.ts`. Every construct outside the subset throws `SqlError` with a message that names
 * it and a span that points at it, so the editor can underline the clause.
 */
import {
  SqlError,
  type Assignment,
  type BinaryOperator,
  type CaseExpression,
  type ColumnRef,
  type DeleteStatement,
  type Expression,
  type InsertStatement,
  type JoinClause,
  type OrderItem,
  type SelectColumn,
  type SelectStatement,
  type Span,
  type SqlStatement,
  type SqlType,
  type TableRef,
  type UpdateStatement,
} from './ast';
import { scanRaw, tokenize, type Token } from './tokens';

/** Words that cannot be a column or table name unless bracketed. */
const RESERVED = new Set([
  'ALL',
  'AND',
  'AS',
  'ASC',
  'BETWEEN',
  'BY',
  'CASE',
  'CAST',
  'CONVERT',
  'CROSS',
  'DECLARE',
  'DELETE',
  'DESC',
  'DISTINCT',
  'ELSE',
  'END',
  'ESCAPE',
  'EXCEPT',
  'EXISTS',
  'FETCH',
  'FROM',
  'FULL',
  'GROUP',
  'HAVING',
  'IN',
  'INNER',
  'INSERT',
  'INTERSECT',
  'INTO',
  'IS',
  'JOIN',
  'LEFT',
  'LIKE',
  'NOT',
  'NULL',
  'OFFSET',
  'ON',
  'OR',
  'ORDER',
  'OUTER',
  'OVER',
  'RIGHT',
  'SELECT',
  'SET',
  'TABLE',
  'THEN',
  'TOP',
  'TRUNCATE',
  'UNION',
  'UPDATE',
  'VALUES',
  'WHEN',
  'WHERE',
  'WITH',
]);

/** Reserved words that are also function names when a parenthesis follows. */
const CALLABLE_KEYWORDS = new Set(['LEFT', 'RIGHT']);

const COMPARISONS: Record<string, BinaryOperator> = {
  '=': '=',
  '<>': '<>',
  '!=': '<>',
  '<': '<',
  '<=': '<=',
  '>': '>',
  '>=': '>=',
};

const TYPES: Record<string, SqlType> = {
  INT: 'int',
  INTEGER: 'int',
  SMALLINT: 'int',
  TINYINT: 'int',
  BIGINT: 'bigint',
  FLOAT: 'float',
  REAL: 'float',
  DECIMAL: 'decimal',
  NUMERIC: 'decimal',
  MONEY: 'decimal',
  SMALLMONEY: 'decimal',
  BIT: 'bit',
  DATE: 'date',
  DATETIME: 'datetime',
  DATETIME2: 'datetime',
  SMALLDATETIME: 'datetime',
  DATETIMEOFFSET: 'datetime',
  VARCHAR: 'string',
  NVARCHAR: 'string',
  CHAR: 'string',
  NCHAR: 'string',
  TEXT: 'string',
  NTEXT: 'string',
  OBJECTID: 'objectId',
};

interface Cursor {
  readonly tokens: readonly Token[];
  pos: number;
  /** The absolute span of the whole statement text. */
  readonly span: Span;
}

/**
 * Finds the spans of the statements in the editor text. A statement ends at `;` or at a `GO` word
 * alone on its line. Leading and trailing whitespace is trimmed and a segment with only whitespace
 * and comments is skipped. The scan never throws, so an unterminated string in one statement
 * surfaces when that statement is parsed.
 */
export function splitSqlStatements(text: string): Span[] {
  const raw = scanRaw(text);
  const spans: Span[] = [];
  let start = 0;
  let hasContent = false;

  const close = (end: number): void => {
    if (hasContent) {
      spans.push(trimSpan(text, start, end));
    }
    hasContent = false;
  };

  for (let index = 0; index < raw.length; index += 1) {
    const token = raw[index];
    if (!token) {
      break;
    }
    if (token.kind === 'whitespace' || token.kind === 'comment') {
      continue;
    }
    if (token.kind === 'operator' && token.text === ';') {
      close(token.start);
      start = token.end;
      continue;
    }
    if (token.kind === 'word' && token.text.toUpperCase() === 'GO') {
      const lineEnd = endOfGoLine(raw, index);
      if (lineEnd !== undefined) {
        close(token.start);
        start = raw[lineEnd]?.start ?? text.length;
        index = lineEnd - 1;
        continue;
      }
    }
    hasContent = true;
  }
  close(text.length);
  return spans;
}

/**
 * When the GO at `index` starts its line and nothing but comments follow it on that line, which is
 * how SSMS and sqlcmd read `GO -- done`, returns the index of the raw token where the next
 * statement starts (the line break, or `raw.length` at the end of the text). Returns undefined
 * when GO shares its line with other tokens and is a plain name.
 */
function endOfGoLine(raw: readonly RawTokenLike[], index: number): number | undefined {
  const before = raw[index - 1];
  const startsLine =
    before === undefined ||
    (before.kind === 'whitespace' && (before.text.includes('\n') || index === 1));
  if (!startsLine) {
    return undefined;
  }
  for (let next = index + 1; next < raw.length; next += 1) {
    const token = raw[next] as RawTokenLike;
    if (token.kind === 'whitespace') {
      if (token.text.includes('\n')) {
        return next;
      }
    } else if (token.kind === 'comment') {
      if (token.text.startsWith('--')) {
        return next + 1;
      }
    } else {
      return undefined;
    }
  }
  return raw.length;
}

interface RawTokenLike {
  readonly kind: string;
  readonly text: string;
}

function trimSpan(text: string, start: number, end: number): Span {
  let from = start;
  let to = end;
  while (from < to && /\s/.test(text.charAt(from))) {
    from += 1;
  }
  while (to > from && /\s/.test(text.charAt(to - 1))) {
    to -= 1;
  }
  return { start: from, end: to };
}

/** Parses every statement of the editor text in order. Throws `SqlError` at the first failure. */
export function parseSql(text: string): SqlStatement[] {
  return splitSqlStatements(text).map((span) =>
    parseStatement(text.slice(span.start, span.end), span.start),
  );
}

/**
 * Parses one statement. `offset` is the position of `text` in the full editor text, so the spans
 * in the tree and in errors are absolute.
 */
export function parseStatement(text: string, offset: number): SqlStatement {
  const tokens = tokenize(text, offset);
  const cursor: Cursor = { tokens, pos: 0, span: { start: offset, end: offset + text.length } };
  const first = tokens[0];
  if (!first) {
    throw new SqlError('the statement is empty', cursor.span);
  }
  const statement = parseStatementBody(cursor, first);
  const extra = peek(cursor);
  if (extra) {
    if (isWord(cursor, 'UNION', 'EXCEPT', 'INTERSECT')) {
      throw refusal(`${extra.text.toUpperCase()} is not supported`, extra);
    }
    throw new SqlError(`unexpected '${extra.text}' after the statement`, spanOf(extra));
  }
  return statement;
}

function parseStatementBody(cursor: Cursor, first: Token): SqlStatement {
  if (first.kind === 'parameter') {
    throw refusal('parameters are not supported', first);
  }
  if (first.kind === 'operator' && first.text === '(' && isWordAt(cursor, 1, 'SELECT')) {
    throw subqueryRefusal(cursor, cursor.pos);
  }
  const keyword = first.kind === 'word' ? first.text.toUpperCase() : '';
  switch (keyword) {
    case 'SELECT':
      return parseSelect(cursor);
    case 'UPDATE':
      return parseUpdate(cursor);
    case 'DELETE':
      return parseDelete(cursor);
    case 'INSERT':
      return parseInsert(cursor);
    case 'TRUNCATE':
      return parseTruncate(cursor);
    case 'WITH':
      throw refusal('WITH (common table expressions) is not supported', first);
    case 'DECLARE':
      throw refusal('DECLARE is not supported', first);
    default:
      throw new SqlError(
        'Only SELECT, UPDATE, DELETE, INSERT and TRUNCATE statements are supported',
        spanOf(first),
      );
  }
}

// Statements

function parseSelect(cursor: Cursor): SelectStatement {
  const start = expectWord(cursor, 'SELECT');
  let distinct = false;
  if (takeWord(cursor, 'DISTINCT')) {
    distinct = true;
  } else {
    takeWord(cursor, 'ALL');
  }
  let top: number | undefined;
  if (takeWord(cursor, 'TOP')) {
    top = parseCount(cursor, 'TOP');
    const percent = takeWord(cursor, 'PERCENT');
    if (percent) {
      throw refusal('TOP ... PERCENT is not supported', percent);
    }
    if (isWord(cursor, 'WITH') && isWordAt(cursor, 1, 'TIES')) {
      throw refusal('WITH TIES is not supported', tokenAt(cursor, 0), tokenAt(cursor, 1));
    }
  }
  const columns = parseSelectColumns(cursor);
  const into = takeWord(cursor, 'INTO');
  if (into) {
    throw refusal('SELECT ... INTO is not supported', into);
  }
  expectWord(cursor, 'FROM');
  const from = parseTableRef(cursor);
  const joins = parseJoins(cursor);
  const where = takeWord(cursor, 'WHERE') ? parseExpression(cursor) : undefined;
  let groupBy: Expression[] = [];
  if (takeWord(cursor, 'GROUP')) {
    expectWord(cursor, 'BY');
    groupBy = parseGroupBy(cursor);
  }
  const having = takeWord(cursor, 'HAVING') ? parseExpression(cursor) : undefined;
  let orderBy: OrderItem[] = [];
  if (takeWord(cursor, 'ORDER')) {
    expectWord(cursor, 'BY');
    orderBy = parseOrderItems(cursor);
  }
  let offset: number | undefined;
  let fetch: number | undefined;
  if (takeWord(cursor, 'OFFSET')) {
    offset = parseCount(cursor, 'OFFSET');
    expectWord(cursor, 'ROWS', 'ROW');
    if (takeWord(cursor, 'FETCH')) {
      expectWord(cursor, 'NEXT', 'FIRST');
      fetch = parseCount(cursor, 'FETCH');
      expectWord(cursor, 'ROWS', 'ROW');
      expectWord(cursor, 'ONLY');
    }
  }
  return {
    kind: 'select',
    span: spanFrom(start, lastToken(cursor)),
    distinct,
    top,
    columns,
    from,
    joins,
    where,
    groupBy,
    having,
    orderBy,
    offset,
    fetch,
  };
}

function parseSelectColumns(cursor: Cursor): SelectColumn[] {
  const columns: SelectColumn[] = [parseSelectColumn(cursor)];
  while (takeOperator(cursor, ',')) {
    columns.push(parseSelectColumn(cursor));
  }
  return columns;
}

function parseSelectColumn(cursor: Cursor): SelectColumn {
  const token = peek(cursor);
  if (token && token.kind === 'operator' && token.text === '*') {
    cursor.pos += 1;
    return { kind: 'star', qualifier: undefined, span: spanOf(token) };
  }
  if (token && isName(token)) {
    if (isOperatorAt(cursor, 1, '.') && isOperatorAt(cursor, 2, '*')) {
      cursor.pos += 3;
      return { kind: 'star', qualifier: token.value, span: spanFrom(token, lastToken(cursor)) };
    }
    if (isOperatorAt(cursor, 1, '=')) {
      cursor.pos += 2;
      const expression = parseExpression(cursor);
      return {
        kind: 'expression',
        expression,
        alias: token.value,
        span: { start: token.start, end: expression.span.end },
      };
    }
  }
  const expression = parseExpression(cursor);
  let alias: string | undefined;
  if (takeWord(cursor, 'AS')) {
    alias = parseName(cursor, 'an alias after AS').value;
  } else {
    const candidate = peek(cursor);
    if (candidate && isName(candidate)) {
      cursor.pos += 1;
      alias = candidate.value;
    }
  }
  return {
    kind: 'expression',
    expression,
    alias,
    span: { start: expression.span.start, end: lastToken(cursor).end },
  };
}

function parseTableRef(cursor: Cursor): TableRef {
  const open = peek(cursor);
  if (open && open.kind === 'operator' && open.text === '(' && isWordAt(cursor, 1, 'SELECT')) {
    throw subqueryRefusal(cursor, cursor.pos);
  }
  const parts: Token[] = [parseName(cursor, 'a table name')];
  while (isOperator(cursor, '.')) {
    cursor.pos += 1;
    parts.push(parseName(cursor, "a table name after '.'"));
  }
  const first = parts[0] as Token;
  const last = parts[parts.length - 1] as Token;
  if (parts.some((part) => part.kind === 'word' && part.text.startsWith('#'))) {
    throw refusal('temporary tables are not supported', first, last);
  }
  let name: string;
  if (parts.length === 1) {
    name = first.value;
  } else if (parts.length === 2 && first.value.toLowerCase() === 'dbo') {
    name = last.value;
  } else {
    const prefix = parts
      .slice(0, -1)
      .map((part) => part.value)
      .join('.');
    throw new SqlError(
      `table prefix '${prefix}' is not supported, only dbo. is accepted`,
      spanFrom(first, last),
    );
  }
  let alias: string | undefined;
  if (takeWord(cursor, 'AS')) {
    alias = parseName(cursor, 'an alias after AS').value;
  } else {
    const candidate = peek(cursor);
    if (candidate && isName(candidate)) {
      cursor.pos += 1;
      alias = candidate.value;
    }
  }
  if (isWord(cursor, 'WITH') && isOperatorAt(cursor, 1, '(')) {
    const close = matchingParen(cursor, cursor.pos + 1);
    throw refusal(
      'table hints such as WITH (NOLOCK) are not supported',
      tokenAt(cursor, 0),
      close ?? tokenAt(cursor, 1),
    );
  }
  return { name, alias, span: spanFrom(first, lastToken(cursor)) };
}

function parseJoins(cursor: Cursor): JoinClause[] {
  const joins: JoinClause[] = [];
  for (;;) {
    const token = peek(cursor);
    if (!token) {
      return joins;
    }
    if (token.kind === 'operator' && token.text === ',') {
      throw refusal('comma joins are not supported, use JOIN ... ON', token);
    }
    if (token.kind !== 'word') {
      return joins;
    }
    let join: JoinClause['join'];
    switch (token.text.toUpperCase()) {
      case 'JOIN':
        cursor.pos += 1;
        join = 'inner';
        break;
      case 'INNER':
        cursor.pos += 1;
        expectWord(cursor, 'JOIN');
        join = 'inner';
        break;
      case 'LEFT':
        cursor.pos += 1;
        takeWord(cursor, 'OUTER');
        expectWord(cursor, 'JOIN');
        join = 'left';
        break;
      case 'RIGHT':
      case 'FULL': {
        cursor.pos += 1;
        takeWord(cursor, 'OUTER');
        takeWord(cursor, 'JOIN');
        throw refusal(
          `${token.text.toUpperCase()} JOIN is not supported`,
          token,
          lastToken(cursor),
        );
      }
      case 'CROSS': {
        cursor.pos += 1;
        const kind = takeWord(cursor, 'APPLY') ? 'APPLY' : 'JOIN';
        takeWord(cursor, 'JOIN');
        throw refusal(`CROSS ${kind} is not supported`, token, lastToken(cursor));
      }
      case 'OUTER': {
        cursor.pos += 1;
        takeWord(cursor, 'APPLY');
        throw refusal('OUTER APPLY is not supported', token, lastToken(cursor));
      }
      default:
        return joins;
    }
    const table = parseTableRef(cursor);
    expectWord(cursor, 'ON');
    const on = parseExpression(cursor);
    joins.push({ join, table, on, span: { start: token.start, end: on.span.end } });
  }
}

function parseGroupBy(cursor: Cursor): Expression[] {
  const expressions: Expression[] = [];
  do {
    refuseGrouping(cursor);
    expressions.push(parseExpression(cursor));
  } while (takeOperator(cursor, ','));
  if (isWord(cursor, 'WITH') && (isWordAt(cursor, 1, 'ROLLUP') || isWordAt(cursor, 1, 'CUBE'))) {
    cursor.pos += 1;
    refuseGrouping(cursor);
  }
  return expressions;
}

function refuseGrouping(cursor: Cursor): void {
  const token = peek(cursor);
  if (!token || token.kind !== 'word') {
    return;
  }
  const word = token.text.toUpperCase();
  if (word === 'ROLLUP' || word === 'CUBE') {
    throw refusal(`GROUP BY ${word} is not supported`, token);
  }
  if (word === 'GROUPING' && isWordAt(cursor, 1, 'SETS')) {
    throw refusal('GROUP BY GROUPING SETS is not supported', token, tokenAt(cursor, 1));
  }
}

function parseOrderItems(cursor: Cursor): OrderItem[] {
  const items: OrderItem[] = [];
  do {
    const expression = parseExpression(cursor);
    let direction: OrderItem['direction'] = 'asc';
    if (takeWord(cursor, 'DESC')) {
      direction = 'desc';
    } else {
      takeWord(cursor, 'ASC');
    }
    items.push({
      expression,
      direction,
      span: { start: expression.span.start, end: lastToken(cursor).end },
    });
  } while (takeOperator(cursor, ','));
  return items;
}

function parseUpdate(cursor: Cursor): UpdateStatement {
  const start = expectWord(cursor, 'UPDATE');
  const top = takeWord(cursor, 'TOP');
  if (top) {
    throw refusal('UPDATE with TOP is not supported', top);
  }
  const table = parseTableRef(cursor);
  expectWord(cursor, 'SET');
  const assignments: Assignment[] = [];
  do {
    const column = parseColumnRef(cursor);
    expectOperator(cursor, '=');
    const value = parseExpression(cursor);
    assignments.push({ column, value, span: { start: column.span.start, end: value.span.end } });
  } while (takeOperator(cursor, ','));
  const from = takeWord(cursor, 'FROM');
  if (from) {
    throw refusal('UPDATE ... FROM is not supported', from);
  }
  const where = takeWord(cursor, 'WHERE') ? parseExpression(cursor) : undefined;
  return { kind: 'update', span: spanFrom(start, lastToken(cursor)), table, assignments, where };
}

function parseDelete(cursor: Cursor): DeleteStatement {
  const start = expectWord(cursor, 'DELETE');
  const top = takeWord(cursor, 'TOP');
  if (top) {
    throw refusal('DELETE with TOP is not supported', top);
  }
  takeWord(cursor, 'FROM');
  const table = parseTableRef(cursor);
  const joinWord = peek(cursor);
  if (joinWord && isWord(cursor, 'FROM', 'JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'CROSS')) {
    throw refusal('DELETE with JOIN is not supported', joinWord);
  }
  const where = takeWord(cursor, 'WHERE') ? parseExpression(cursor) : undefined;
  return { kind: 'delete', span: spanFrom(start, lastToken(cursor)), table, where };
}

function parseTruncate(cursor: Cursor): DeleteStatement {
  const start = expectWord(cursor, 'TRUNCATE');
  expectWord(cursor, 'TABLE');
  const table = parseTableRef(cursor);
  return { kind: 'delete', span: spanFrom(start, lastToken(cursor)), table, where: undefined };
}

function parseInsert(cursor: Cursor): InsertStatement {
  const start = expectWord(cursor, 'INSERT');
  takeWord(cursor, 'INTO');
  const table = parseTableRef(cursor);
  const select = peek(cursor);
  if (select && isWord(cursor, 'SELECT')) {
    throw refusal('INSERT ... SELECT is not supported', select);
  }
  if (select && isWord(cursor, 'VALUES')) {
    throw new SqlError('INSERT needs a column list before VALUES', spanOf(select));
  }
  expectOperator(cursor, '(');
  const columns: ColumnRef[] = [];
  do {
    columns.push(parseColumnRef(cursor));
  } while (takeOperator(cursor, ','));
  expectOperator(cursor, ')');
  const afterColumns = peek(cursor);
  if (afterColumns && isWord(cursor, 'SELECT')) {
    throw refusal('INSERT ... SELECT is not supported', afterColumns);
  }
  expectWord(cursor, 'VALUES');
  const rows: Expression[][] = [];
  do {
    expectOperator(cursor, '(');
    const row: Expression[] = [];
    do {
      row.push(parseExpression(cursor));
    } while (takeOperator(cursor, ','));
    expectOperator(cursor, ')');
    rows.push(row);
  } while (takeOperator(cursor, ','));
  return { kind: 'insert', span: spanFrom(start, lastToken(cursor)), table, columns, rows };
}

/** `n` or `(n)` after TOP, OFFSET or FETCH. */
function parseCount(cursor: Cursor, keyword: string): number {
  const wrapped = takeOperator(cursor, '(');
  const token = peek(cursor);
  if (token && token.kind === 'parameter') {
    throw refusal('parameters are not supported', token);
  }
  if (!token || token.kind !== 'number' || !/^\d+$/.test(token.text)) {
    throw unexpected(cursor, `a whole number after ${keyword}`);
  }
  cursor.pos += 1;
  if (wrapped) {
    expectOperator(cursor, ')');
  }
  const count = Number(token.text);
  if (count === 0 && keyword !== 'OFFSET') {
    // SQL Server returns no rows; mongosh reads limit(0) as no limit, the opposite.
    throw refusal(`${keyword} 0 returns no rows and cannot be translated`, token);
  }
  return count;
}

// Expressions

function parseExpression(cursor: Cursor): Expression {
  return parseOr(cursor);
}

function parseOr(cursor: Cursor): Expression {
  let left = parseAnd(cursor);
  while (takeWord(cursor, 'OR')) {
    const right = parseAnd(cursor);
    left = binary('or', left, right);
  }
  return left;
}

function parseAnd(cursor: Cursor): Expression {
  let left = parseNot(cursor);
  while (takeWord(cursor, 'AND')) {
    const right = parseNot(cursor);
    left = binary('and', left, right);
  }
  return left;
}

function parseNot(cursor: Cursor): Expression {
  const not = takeWord(cursor, 'NOT');
  if (not) {
    const operand = parseNot(cursor);
    return {
      kind: 'unary',
      operator: 'not',
      operand,
      span: { start: not.start, end: operand.span.end },
    };
  }
  return parseComparison(cursor);
}

function parseComparison(cursor: Cursor): Expression {
  const left = parseAdditive(cursor);
  const token = peek(cursor);
  if (!token) {
    return left;
  }
  if (token.kind === 'operator') {
    const operator = COMPARISONS[token.text];
    if (operator) {
      cursor.pos += 1;
      const right = parseAdditive(cursor);
      return binary(operator, left, right);
    }
    return left;
  }
  if (token.kind !== 'word') {
    return left;
  }
  if (takeWord(cursor, 'IS')) {
    const negated = takeWord(cursor, 'NOT') !== undefined;
    const nullWord = expectWord(cursor, 'NULL');
    return {
      kind: 'isNull',
      expression: left,
      negated,
      span: { start: left.span.start, end: nullWord.end },
    };
  }
  const negated = takeWord(cursor, 'NOT') !== undefined;
  if (takeWord(cursor, 'IN')) {
    const open = expectOperator(cursor, '(');
    if (isWord(cursor, 'SELECT')) {
      throw subqueryRefusal(cursor, cursor.pos - 1);
    }
    if (isOperator(cursor, ')')) {
      throw new SqlError('IN needs at least one value', spanFrom(open, tokenAt(cursor, 0)));
    }
    const values: Expression[] = [];
    do {
      values.push(parseExpression(cursor));
    } while (takeOperator(cursor, ','));
    const close = expectOperator(cursor, ')');
    return {
      kind: 'in',
      expression: left,
      values,
      negated,
      span: { start: left.span.start, end: close.end },
    };
  }
  if (takeWord(cursor, 'BETWEEN')) {
    const low = parseAdditive(cursor);
    expectWord(cursor, 'AND');
    const high = parseAdditive(cursor);
    return {
      kind: 'between',
      expression: left,
      low,
      high,
      negated,
      span: { start: left.span.start, end: high.span.end },
    };
  }
  if (takeWord(cursor, 'LIKE')) {
    const pattern = parseAdditive(cursor);
    let escape: string | undefined;
    let end = pattern.span.end;
    if (takeWord(cursor, 'ESCAPE')) {
      const escapeToken = peek(cursor);
      if (!escapeToken || escapeToken.kind !== 'string' || escapeToken.value.length !== 1) {
        throw unexpected(cursor, 'a one character string after ESCAPE');
      }
      cursor.pos += 1;
      escape = escapeToken.value;
      end = escapeToken.end;
    }
    return {
      kind: 'like',
      expression: left,
      pattern,
      escape,
      negated,
      span: { start: left.span.start, end },
    };
  }
  if (negated) {
    throw unexpected(cursor, 'IN, BETWEEN or LIKE after NOT');
  }
  return left;
}

function parseAdditive(cursor: Cursor): Expression {
  let left = parseTerm(cursor);
  for (;;) {
    const operator = takeOperator(cursor, '+') ?? takeOperator(cursor, '-');
    if (!operator) {
      return left;
    }
    const right = parseTerm(cursor);
    left = binary(operator.text as BinaryOperator, left, right);
  }
}

function parseTerm(cursor: Cursor): Expression {
  let left = parseUnary(cursor);
  for (;;) {
    const operator =
      takeOperator(cursor, '*') ?? takeOperator(cursor, '/') ?? takeOperator(cursor, '%');
    if (!operator) {
      return left;
    }
    const right = parseUnary(cursor);
    left = binary(operator.text as BinaryOperator, left, right);
  }
}

function parseUnary(cursor: Cursor): Expression {
  const minus = takeOperator(cursor, '-');
  if (minus) {
    const operand = parseUnary(cursor);
    const span = { start: minus.start, end: operand.span.end };
    if (operand.kind === 'literal' && typeof operand.value === 'number') {
      return { kind: 'literal', value: -operand.value, span };
    }
    return { kind: 'unary', operator: 'negate', operand, span };
  }
  if (takeOperator(cursor, '+')) {
    return parseUnary(cursor);
  }
  return parsePrimary(cursor);
}

function parsePrimary(cursor: Cursor): Expression {
  const token = peek(cursor);
  if (!token) {
    throw unexpected(cursor, 'an expression');
  }
  switch (token.kind) {
    case 'string':
      cursor.pos += 1;
      return { kind: 'literal', value: token.value, span: spanOf(token) };
    case 'number': {
      cursor.pos += 1;
      const value = Number(token.text);
      if (!Number.isFinite(value)) {
        throw new SqlError('the floating point value is out of range', spanOf(token));
      }
      return { kind: 'literal', value, span: spanOf(token) };
    }
    case 'parameter':
      throw refusal('parameters are not supported', token);
    case 'identifier':
      return parseColumnRef(cursor);
    case 'operator':
      if (token.text === '(') {
        if (isWordAt(cursor, 1, 'SELECT')) {
          throw subqueryRefusal(cursor, cursor.pos);
        }
        cursor.pos += 1;
        const inner = parseExpression(cursor);
        expectOperator(cursor, ')');
        return inner;
      }
      throw unexpected(cursor, 'an expression');
    case 'word':
      return parseWordExpression(cursor, token);
  }
}

function parseWordExpression(cursor: Cursor, token: Token): Expression {
  const word = token.text.toUpperCase();
  switch (word) {
    case 'NULL':
      cursor.pos += 1;
      return { kind: 'literal', value: null, span: spanOf(token) };
    case 'TRUE':
    case 'FALSE':
      cursor.pos += 1;
      return { kind: 'literal', value: word === 'TRUE', span: spanOf(token) };
    case 'CASE':
      return parseCase(cursor);
    case 'CAST':
      return parseCast(cursor);
    case 'CONVERT':
      return parseConvert(cursor);
    case 'EXISTS':
      throw refusal('EXISTS is not supported', token);
    case 'CURRENT_TIMESTAMP':
      cursor.pos += 1;
      return {
        kind: 'call',
        name: word,
        args: [],
        star: false,
        distinct: false,
        span: spanOf(token),
      };
    default:
      break;
  }
  if (isOperatorAt(cursor, 1, '(') && (!RESERVED.has(word) || CALLABLE_KEYWORDS.has(word))) {
    return parseCall(cursor);
  }
  return parseColumnRef(cursor);
}

function parseCall(cursor: Cursor): Expression {
  const name = next(cursor);
  expectOperator(cursor, '(');
  const args: Expression[] = [];
  let star = false;
  let distinct = false;
  if (isOperator(cursor, '*')) {
    cursor.pos += 1;
    star = true;
  } else if (!isOperator(cursor, ')')) {
    if (takeWord(cursor, 'DISTINCT')) {
      distinct = true;
    }
    do {
      args.push(parseExpression(cursor));
    } while (takeOperator(cursor, ','));
  }
  const close = expectOperator(cursor, ')');
  const over = peek(cursor);
  if (over && isWord(cursor, 'OVER')) {
    throw refusal('window functions (OVER) are not supported', over);
  }
  return {
    kind: 'call',
    name: name.text.toUpperCase(),
    args,
    star,
    distinct,
    span: spanFrom(name, close),
  };
}

function parseCase(cursor: Cursor): CaseExpression {
  const start = expectWord(cursor, 'CASE');
  const operand = isWord(cursor, 'WHEN') ? undefined : parseExpression(cursor);
  const whens: { when: Expression; then: Expression }[] = [];
  while (takeWord(cursor, 'WHEN')) {
    const when = parseExpression(cursor);
    expectWord(cursor, 'THEN');
    const then = parseExpression(cursor);
    whens.push({ when, then });
  }
  if (whens.length === 0) {
    throw unexpected(cursor, 'WHEN after CASE');
  }
  const elseExpression = takeWord(cursor, 'ELSE') ? parseExpression(cursor) : undefined;
  const end = expectWord(cursor, 'END');
  return { kind: 'case', operand, whens, else: elseExpression, span: spanFrom(start, end) };
}

function parseCast(cursor: Cursor): Expression {
  const start = expectWord(cursor, 'CAST');
  expectOperator(cursor, '(');
  const expression = parseExpression(cursor);
  expectWord(cursor, 'AS');
  const type = parseType(cursor);
  const end = expectOperator(cursor, ')');
  return { kind: 'cast', expression, type, span: spanFrom(start, end) };
}

function parseConvert(cursor: Cursor): Expression {
  const start = expectWord(cursor, 'CONVERT');
  expectOperator(cursor, '(');
  const type = parseType(cursor);
  expectOperator(cursor, ',');
  const expression = parseExpression(cursor);
  if (takeOperator(cursor, ',')) {
    parseExpression(cursor);
  }
  const end = expectOperator(cursor, ')');
  return { kind: 'cast', expression, type, span: spanFrom(start, end) };
}

/** A type name with an optional length such as `NVARCHAR(50)`, `VARCHAR(MAX)` or `DECIMAL(10, 2)`. */
function parseType(cursor: Cursor): SqlType {
  const token = peek(cursor);
  if (!token || token.kind !== 'word') {
    throw unexpected(cursor, 'a type name');
  }
  const type = TYPES[token.text.toUpperCase()];
  if (!type) {
    throw new SqlError(`type '${token.text}' is not supported`, spanOf(token));
  }
  cursor.pos += 1;
  if (takeOperator(cursor, '(')) {
    do {
      const length = peek(cursor);
      if (
        length &&
        (length.kind === 'number' ||
          (length.kind === 'word' && length.text.toUpperCase() === 'MAX'))
      ) {
        cursor.pos += 1;
      } else {
        throw unexpected(cursor, 'a length after the type name');
      }
    } while (takeOperator(cursor, ','));
    expectOperator(cursor, ')');
  }
  return type;
}

/** A dotted name such as `o.address.city`, with each part a bare word or a bracketed name. */
function parseColumnRef(cursor: Cursor): ColumnRef {
  const first = parseName(cursor, 'a column name');
  const parts = [first.value];
  let last = first;
  while (isOperator(cursor, '.')) {
    cursor.pos += 1;
    last = parseName(cursor, "a name after '.'");
    parts.push(last.value);
  }
  return { kind: 'column', parts, span: spanFrom(first, last) };
}

// Cursor helpers

function binary(operator: BinaryOperator, left: Expression, right: Expression): Expression {
  return {
    kind: 'binary',
    operator,
    left,
    right,
    span: { start: left.span.start, end: right.span.end },
  };
}

function spanOf(token: Token): Span {
  return { start: token.start, end: token.end };
}

function spanFrom(first: Token, last: Token): Span {
  return { start: first.start, end: last.end };
}

function refusal(message: string, from: Token, to: Token = from): SqlError {
  return new SqlError(message, spanFrom(from, to));
}

/** The refusal for `(SELECT ...)`, spanning to the matching parenthesis when there is one. */
function subqueryRefusal(cursor: Cursor, openIndex: number): SqlError {
  const open = cursor.tokens[openIndex] as Token;
  const close = matchingParen(cursor, openIndex);
  const last = close ?? cursor.tokens[cursor.tokens.length - 1] ?? open;
  return new SqlError('subqueries are not supported', spanFrom(open, last));
}

function matchingParen(cursor: Cursor, openIndex: number): Token | undefined {
  let depth = 0;
  for (let index = openIndex; index < cursor.tokens.length; index += 1) {
    const token = cursor.tokens[index];
    if (!token || token.kind !== 'operator') {
      continue;
    }
    if (token.text === '(') {
      depth += 1;
    } else if (token.text === ')') {
      depth -= 1;
      if (depth === 0) {
        return token;
      }
    }
  }
  return undefined;
}

function peek(cursor: Cursor): Token | undefined {
  return cursor.tokens[cursor.pos];
}

function tokenAt(cursor: Cursor, ahead: number): Token {
  const token = cursor.tokens[cursor.pos + ahead];
  if (!token) {
    throw unexpected(cursor, 'more input');
  }
  return token;
}

function lastToken(cursor: Cursor): Token {
  const token = cursor.tokens[cursor.pos - 1] ?? cursor.tokens[0];
  if (!token) {
    throw new SqlError('the statement is empty', cursor.span);
  }
  return token;
}

function next(cursor: Cursor): Token {
  const token = peek(cursor);
  if (!token) {
    throw unexpected(cursor, 'more input');
  }
  cursor.pos += 1;
  return token;
}

function isWordAt(cursor: Cursor, ahead: number, ...words: string[]): boolean {
  const token = cursor.tokens[cursor.pos + ahead];
  return token !== undefined && token.kind === 'word' && words.includes(token.text.toUpperCase());
}

function isWord(cursor: Cursor, ...words: string[]): boolean {
  return isWordAt(cursor, 0, ...words);
}

function isOperatorAt(cursor: Cursor, ahead: number, operator: string): boolean {
  const token = cursor.tokens[cursor.pos + ahead];
  return token !== undefined && token.kind === 'operator' && token.text === operator;
}

function isOperator(cursor: Cursor, operator: string): boolean {
  return isOperatorAt(cursor, 0, operator);
}

function takeWord(cursor: Cursor, ...words: string[]): Token | undefined {
  if (!isWord(cursor, ...words)) {
    return undefined;
  }
  return next(cursor);
}

function takeOperator(cursor: Cursor, operator: string): Token | undefined {
  if (!isOperator(cursor, operator)) {
    return undefined;
  }
  return next(cursor);
}

function expectWord(cursor: Cursor, ...words: string[]): Token {
  const token = takeWord(cursor, ...words);
  if (!token) {
    throw unexpected(cursor, words.join(' or '));
  }
  return token;
}

function expectOperator(cursor: Cursor, operator: string): Token {
  const token = takeOperator(cursor, operator);
  if (!token) {
    throw unexpected(cursor, `'${operator}'`);
  }
  return token;
}

/** A bare word that is not reserved, or a bracketed or quoted identifier. */
function isName(token: Token): boolean {
  return (
    token.kind === 'identifier' ||
    (token.kind === 'word' && !RESERVED.has(token.text.toUpperCase()))
  );
}

function parseName(cursor: Cursor, expected: string): Token {
  const token = peek(cursor);
  if (!token) {
    throw unexpected(cursor, expected);
  }
  if (token.kind === 'word' && RESERVED.has(token.text.toUpperCase())) {
    throw new SqlError(
      `keyword ${token.text.toUpperCase()} cannot be used as a name, write [${token.text}]`,
      spanOf(token),
    );
  }
  if (token.kind === 'parameter') {
    throw refusal('parameters are not supported', token);
  }
  if (!isName(token)) {
    throw unexpected(cursor, expected);
  }
  cursor.pos += 1;
  return token;
}

/** "expected X but found 'y'", or "expected X but the statement ended" at the last token. */
function unexpected(cursor: Cursor, expected: string): SqlError {
  const token = peek(cursor);
  if (token) {
    return new SqlError(`expected ${expected} but found '${token.text}'`, spanOf(token));
  }
  const last = cursor.tokens[cursor.tokens.length - 1];
  const span = last ? spanOf(last) : cursor.span;
  return new SqlError(`expected ${expected} but the statement ended`, span);
}
