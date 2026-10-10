/**
 * The pure part of SQL completion. `sqlCompletionContext` reads the statement under the cursor and
 * says what the cursor position accepts: a table name, a column, a keyword, or nothing inside a
 * string or comment. `sqlCompletions` turns that context and the catalog into editor items. The
 * Monaco provider in sql-language.ts fetches the collections and the field samples and calls both.
 */
import { splitSqlStatements, type SchemaField, type Span } from '@mongo-gui/core';
import { fieldCompletions, mergeCompletions, type EditorCompletion } from './completion-model';

export type SqlCompletionKind = 'table' | 'column' | 'keyword' | 'none';

/** A table the statement names, with the alias that follows it when there is one. */
export interface SqlTableRef {
  readonly name: string;
  readonly alias: string | undefined;
}

export interface SqlCompletionContext {
  /** The word being typed. Empty right after a dot or a space. */
  readonly prefix: string;
  readonly kind: SqlCompletionKind;
  /** Every table of the statement, in source order. The first one is the FROM, UPDATE or INTO table. */
  readonly tables: readonly SqlTableRef[];
  /** The first part of the dotted word before the cursor, when it names a table or an alias. */
  readonly qualifier: string | undefined;
  /** The parts between the qualifier and the prefix, so `o.address.ci` gives `['address']`. */
  readonly parentPath: readonly string[];
}

export interface SqlCompletionInput {
  /** The collection names of the tab's database. */
  readonly collections: readonly string[];
  /** The sampled fields of a collection, or undefined when none were sampled. */
  readonly fieldsOf: (collection: string) => readonly SchemaField[] | undefined;
  readonly keywords: readonly string[];
  /** Function names. They complete to a call with the cursor between the parentheses. */
  readonly functions?: readonly string[] | undefined;
}

/** The clause words the translator understands, for the keyword items and the tokenizer. */
export const SQL_KEYWORDS: readonly string[] = [
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
  'DELETE',
  'DESC',
  'DISTINCT',
  'ELSE',
  'END',
  'ESCAPE',
  'EXISTS',
  'FETCH',
  'FIRST',
  'FROM',
  'FULL',
  'GO',
  'GROUP',
  'HAVING',
  'IN',
  'INNER',
  'INSERT',
  'INTO',
  'IS',
  'JOIN',
  'LEFT',
  'LIKE',
  'NEXT',
  'NOT',
  'NULL',
  'OFFSET',
  'ON',
  'ONLY',
  'OR',
  'ORDER',
  'OUTER',
  'PERCENT',
  'RIGHT',
  'ROW',
  'ROWS',
  'SELECT',
  'SET',
  'TIES',
  'TOP',
  'UPDATE',
  'VALUES',
  'WHEN',
  'WHERE',
  'WITH',
];

/** The functions the translator maps to aggregation operators. */
export const SQL_FUNCTIONS: readonly string[] = [
  'ABS',
  'AVG',
  'CEILING',
  'COALESCE',
  'CONCAT',
  'COUNT',
  'CURRENT_TIMESTAMP',
  'DATEADD',
  'DATEDIFF',
  'DAY',
  'FLOOR',
  'GETDATE',
  'GETUTCDATE',
  'IIF',
  'ISNULL',
  'LEN',
  'LOWER',
  'LTRIM',
  'MAX',
  'MIN',
  'MONTH',
  'NULLIF',
  'REPLACE',
  'ROUND',
  'RTRIM',
  'SUBSTRING',
  'SUM',
  'SYSDATETIME',
  'TRIM',
  'UPPER',
  'YEAR',
];

/** The type names CAST and CONVERT accept. */
export const SQL_TYPES: readonly string[] = [
  'BIGINT',
  'BIT',
  'CHAR',
  'DATE',
  'DATETIME',
  'DATETIME2',
  'DATETIMEOFFSET',
  'DECIMAL',
  'FLOAT',
  'INT',
  'INTEGER',
  'MONEY',
  'NCHAR',
  'NUMERIC',
  'NVARCHAR',
  'REAL',
  'SMALLDATETIME',
  'SMALLINT',
  'SMALLMONEY',
  'TEXT',
  'TINYINT',
  'VARCHAR',
];

/** Words that cannot be an alias, so `FROM orders WHERE` has no alias. */
const RESERVED = new Set([
  ...SQL_KEYWORDS,
  'DECLARE',
  'EXCEPT',
  'INTERSECT',
  'OVER',
  'TABLE',
  'THEN',
  'TRUNCATE',
  'UNION',
]);

/** The words a table name follows. */
const TABLE_INTRODUCERS = new Set(['FROM', 'JOIN', 'UPDATE', 'INTO']);

const PLAIN_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Writes a collection name as a SQL identifier: as is when it is a plain word that is not a
 * keyword, else in brackets with `]` doubled. Same rule as `collectionSelectStatement`.
 */
export function sqlIdentifier(name: string): string {
  if (PLAIN_NAME.test(name) && !RESERVED.has(name.toUpperCase())) {
    return name;
  }
  return `[${name.replaceAll(']', ']]')}]`;
}

type TokenKind = 'word' | 'identifier' | 'string' | 'number' | 'operator' | 'comment' | 'space';

interface Token {
  readonly kind: TokenKind;
  /** The meaning: the inner text of a bracketed identifier, the text itself otherwise. */
  readonly value: string;
  readonly start: number;
  readonly end: number;
  /** A string, bracket or block comment that the text ends before closing. */
  readonly open: boolean;
}

// The same word shape as the Monaco wordPattern of the language, so the prefix here is the range
// Monaco replaces on accept.
const WORD = /[A-Za-z_@#][A-Za-z0-9_$]*/y;
const NUMBER = /\d+(?:\.\d*)?(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?/y;
const SPACE = /\s+/y;
const OPERATOR = /<>|<=|>=|!=|[=<>+\-*/%(),.;]/y;

function matchAt(pattern: RegExp, text: string, index: number): string | undefined {
  pattern.lastIndex = index;
  return pattern.exec(text)?.[0];
}

/** The index after the closing character, where that character doubled stands for itself. */
function closeOf(text: string, start: number, close: string): number | undefined {
  let index = start + 1;
  while (index < text.length) {
    if (text.charAt(index) !== close) {
      index += 1;
    } else if (text.charAt(index + 1) === close) {
      index += 2;
    } else {
      return index + 1;
    }
  }
  return undefined;
}

/**
 * Splits text into tokens with absolute offsets. Never throws: an unterminated string, bracket or
 * block comment runs to the end and is marked open. Offsets are relative to `base`.
 */
function scan(text: string, base: number): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  const push = (kind: TokenKind, end: number, value?: string, open = false): void => {
    tokens.push({
      kind,
      value: value ?? text.slice(index, end),
      start: base + index,
      end: base + end,
      open,
    });
    index = end;
  };
  while (index < text.length) {
    const char = text.charAt(index);
    const next = text.charAt(index + 1);
    const space = matchAt(SPACE, text, index);
    if (space !== undefined) {
      push('space', index + space.length);
    } else if (char === '-' && next === '-') {
      const newline = text.indexOf('\n', index);
      push('comment', newline === -1 ? text.length : newline);
    } else if (char === '/' && next === '*') {
      const close = text.indexOf('*/', index + 2);
      push('comment', close === -1 ? text.length : close + 2, undefined, close === -1);
    } else if (char === "'" || ((char === 'N' || char === 'n') && next === "'")) {
      const quote = char === "'" ? index : index + 1;
      const close = closeOf(text, quote, "'");
      push('string', close ?? text.length, undefined, close === undefined);
    } else if (char === '[' || char === '"') {
      const closeChar = char === '[' ? ']' : '"';
      const close = closeOf(text, index, closeChar);
      const end = close ?? text.length;
      const inner = text.slice(index + 1, close === undefined ? end : end - 1);
      push(
        'identifier',
        end,
        inner.replaceAll(closeChar + closeChar, closeChar),
        close === undefined,
      );
    } else {
      const number = matchAt(NUMBER, text, index);
      const word = number === undefined ? matchAt(WORD, text, index) : undefined;
      const operator =
        number === undefined && word === undefined ? matchAt(OPERATOR, text, index) : undefined;
      if (number !== undefined) {
        push('number', index + number.length);
      } else if (word !== undefined) {
        push('word', index + word.length);
      } else if (operator !== undefined) {
        push('operator', index + operator.length);
      } else {
        push('operator', index + 1);
      }
    }
  }
  return tokens;
}

function isWord(token: Token | undefined, ...words: string[]): boolean {
  return token !== undefined && token.kind === 'word' && words.includes(token.value.toUpperCase());
}

function isOperator(token: Token | undefined, text: string): boolean {
  return token !== undefined && token.kind === 'operator' && token.value === text;
}

/** A word or a bracketed identifier, which is what a name can be. */
function isName(token: Token | undefined): token is Token {
  return token !== undefined && (token.kind === 'word' || token.kind === 'identifier');
}

/**
 * The statement the cursor belongs to. A cursor inside a span or in the whitespace after it
 * belongs to that span, unless a `;` or a GO sits between the span and the cursor, which starts a
 * new, empty statement. The result's end is the span end or the cursor, whichever is later.
 */
function statementAround(code: string, offset: number): Span | undefined {
  let found: Span | undefined;
  for (const span of splitSqlStatements(code)) {
    if (span.start <= offset) {
      found = span;
    }
  }
  if (found === undefined) {
    return undefined;
  }
  if (offset > found.end) {
    const gap = scan(code.slice(found.end, offset), found.end);
    if (gap.some((token) => isOperator(token, ';') || isWord(token, 'GO'))) {
      return undefined;
    }
  }
  return { start: found.start, end: Math.max(found.end, offset) };
}

interface TableScan {
  readonly tables: SqlTableRef[];
  /** Start offsets of the FROM, JOIN, UPDATE and INTO words and of the commas of a FROM list. */
  readonly introducers: Set<number>;
  /** End offsets of the last token of each table reference, name or alias. */
  readonly refEnds: Set<number>;
}

/** Reads `name [AS] [alias]` at `index`. Returns the index after it, or `index` when no name is there. */
function readTableRef(tokens: readonly Token[], index: number, into: TableScan): number {
  let at = index;
  if (!isName(tokens[at])) {
    return index;
  }
  let name = (tokens[at] as Token).value;
  at += 1;
  // A schema prefix such as `dbo.orders` has no meaning here, so the last part is the name.
  while (isOperator(tokens[at], '.') && isName(tokens[at + 1])) {
    name = (tokens[at + 1] as Token).value;
    at += 2;
  }
  let alias: string | undefined;
  if (isWord(tokens[at], 'AS')) {
    at += 1;
  }
  const candidate = tokens[at];
  if (
    isName(candidate) &&
    (candidate.kind === 'identifier' || !RESERVED.has(candidate.value.toUpperCase()))
  ) {
    alias = candidate.value;
    at += 1;
  }
  into.tables.push({ name, alias });
  into.refEnds.add((tokens[at - 1] as Token).end);
  return at;
}

/** The tables named after FROM, JOIN, UPDATE and INTO, and after the commas of a FROM list. */
function scanTables(tokens: readonly Token[]): TableScan {
  const result: TableScan = { tables: [], introducers: new Set(), refEnds: new Set() };
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index] as Token;
    if (token.kind !== 'word' || !TABLE_INTRODUCERS.has(token.value.toUpperCase())) {
      index += 1;
      continue;
    }
    result.introducers.add(token.start);
    index = readTableRef(tokens, index + 1, result);
    if (token.value.toUpperCase() !== 'FROM') {
      continue;
    }
    while (isOperator(tokens[index], ',')) {
      result.introducers.add((tokens[index] as Token).start);
      index = readTableRef(tokens, index + 1, result);
    }
  }
  return result;
}

/** The dotted name that ends at the cursor, as its parts, with the index of the token before it. */
function chainBefore(
  tokens: readonly Token[],
  offset: number,
): { parts: string[]; before: number } {
  const parts: string[] = [];
  let index = tokens.length - 1;
  const last = tokens[index];
  let edge: number;
  if (isName(last) && last.end === offset) {
    parts.unshift(last.value);
    edge = last.start;
    index -= 1;
  } else if (last !== undefined && isOperator(last, '.') && last.end === offset) {
    parts.unshift('');
    edge = offset;
  } else {
    return { parts: [''], before: index };
  }
  while (isOperator(tokens[index], '.') && (tokens[index] as Token).end === edge) {
    const name = tokens[index - 1];
    if (!isName(name) || name.end !== (tokens[index] as Token).start) {
      break;
    }
    parts.unshift(name.value);
    edge = name.start;
    index -= 2;
  }
  return { parts, before: index };
}

const EMPTY_CONTEXT: SqlCompletionContext = {
  prefix: '',
  kind: 'keyword',
  tables: [],
  qualifier: undefined,
  parentPath: [],
};

/**
 * What the cursor position in `code` accepts. The statement under the cursor comes from
 * `splitSqlStatements`. The word before the cursor, split on dots, gives the qualifier when its
 * first part names a table or an alias of the statement, the parent path and the prefix.
 */
export function sqlCompletionContext(code: string, offset: number): SqlCompletionContext {
  const statement = statementAround(code, offset);
  const all = scan(
    code.slice(statement?.start ?? 0, statement?.end ?? offset),
    statement?.start ?? 0,
  );
  const atCursor = all.filter((token) => token.start < offset).pop();
  if (atCursor !== undefined && atCursor.end >= offset && insideOf(atCursor, offset)) {
    return { ...EMPTY_CONTEXT, kind: 'none' };
  }
  const meaningful = all.filter((token) => token.kind !== 'space' && token.kind !== 'comment');
  // A word the cursor splits counts up to the cursor only, so `sta|tus` has the prefix `sta`.
  const tokens = meaningful
    .filter((token) => token.start < offset)
    .map((token) =>
      token.end > offset
        ? { ...token, value: code.slice(token.start, offset), end: offset }
        : token,
    );
  const chain = chainBefore(tokens, offset);
  const prefix = chain.parts[chain.parts.length - 1] ?? '';
  if (statement === undefined) {
    return { ...EMPTY_CONTEXT, prefix };
  }
  const found = scanTables(meaningful);
  const qualifiers = chain.parts.slice(0, -1);
  const before = tokens[chain.before];
  const first = qualifiers[0];
  const qualified = first !== undefined && found.tables.some((table) => matches(table, first));
  const typedToken = tokens[chain.before + 1];
  let kind: SqlCompletionKind;
  if (before !== undefined && found.introducers.has(before.start)) {
    kind = 'table';
  } else if (before === undefined) {
    kind = 'keyword';
  } else if (
    qualifiers.length === 0 &&
    (found.refEnds.has(before.end) ||
      (typedToken !== undefined && found.refEnds.has(typedToken.end)))
  ) {
    kind = 'keyword';
  } else {
    kind = 'column';
  }
  return {
    prefix,
    kind,
    tables: found.tables,
    qualifier: qualified ? first : undefined,
    parentPath: qualified ? qualifiers.slice(1) : qualifiers,
  };
}

/** True when the cursor at `offset` sits inside the token's string, comment or open bracket. */
function insideOf(token: Token, offset: number): boolean {
  if (token.kind === 'comment') {
    return token.open || token.value.startsWith('--') || offset < token.end;
  }
  if (token.kind === 'string' || token.kind === 'identifier') {
    return token.open || offset < token.end;
  }
  return false;
}

function matches(table: SqlTableRef, name: string): boolean {
  const needle = name.toLowerCase();
  return table.alias?.toLowerCase() === needle || table.name.toLowerCase() === needle;
}

/**
 * The collection whose fields the cursor asks for: the table the qualifier names, or the first
 * table of the statement when the word is unqualified. Undefined when the statement names none.
 */
export function sqlTargetTable(context: SqlCompletionContext): string | undefined {
  if (context.qualifier !== undefined) {
    const qualifier = context.qualifier;
    return context.tables.find((table) => matches(table, qualifier))?.name;
  }
  return context.tables[0]?.name;
}

const TABLE_RANK = 1;
const ALIAS_RANK = 1;
const KEYWORD_RANK = 5;
const FUNCTION_RANK = 6;

function keywordItems(input: SqlCompletionInput): EditorCompletion[] {
  const keywords: EditorCompletion[] = input.keywords.map((keyword) => ({
    label: keyword,
    kind: 'keyword',
    rank: KEYWORD_RANK,
  }));
  const functions: EditorCompletion[] = (input.functions ?? []).map((name) => ({
    label: name,
    kind: 'method',
    detail: 'function',
    rank: FUNCTION_RANK,
    insertText: `${name}($1)`,
    snippet: true,
  }));
  return [...keywords, ...functions];
}

/**
 * The items for a context, filtered by its prefix and sorted. Tables list the collections, with
 * the insert text in brackets where the name needs them. Columns list the fields of the target
 * table under the parent path, plus the aliases and table names of the statement when the word
 * is unqualified at depth zero. Keywords appear in a keyword position, and in a column position
 * once the prefix has two letters. Array element paths, which SQL cannot address, are left out.
 */
export function sqlCompletions(
  context: SqlCompletionContext,
  input: SqlCompletionInput,
): EditorCompletion[] {
  switch (context.kind) {
    case 'none':
      return [];
    case 'keyword':
      return mergeCompletions(context.prefix, [keywordItems(input)]);
    case 'table':
      return mergeCompletions(context.prefix, [
        input.collections.map((name): EditorCompletion => ({
          label: name,
          kind: 'collection',
          rank: TABLE_RANK,
          ...(sqlIdentifier(name) === name ? {} : { insertText: sqlIdentifier(name) }),
        })),
      ]);
    case 'column':
      return mergeCompletions(context.prefix, columnSources(context, input));
    default:
      return [];
  }
}

function columnSources(
  context: SqlCompletionContext,
  input: SqlCompletionInput,
): EditorCompletion[][] {
  const sources: EditorCompletion[][] = [];
  const target = sqlTargetTable(context);
  const fields = target === undefined ? undefined : input.fieldsOf(target);
  if (fields !== undefined) {
    const parent = context.parentPath.length === 0 ? undefined : context.parentPath.join('.');
    sources.push(
      fieldCompletions(fields, false, { parent }).filter((item) => !item.label.includes('[]')),
    );
  }
  if (context.qualifier === undefined && context.parentPath.length === 0) {
    sources.push(
      context.tables.map((table): EditorCompletion => ({
        label: table.alias ?? table.name,
        kind: 'collection',
        detail: table.alias === undefined ? 'table' : table.name,
        rank: ALIAS_RANK,
      })),
    );
    if (/^[A-Za-z]{2}/.test(context.prefix)) {
      sources.push(keywordItems(input));
    }
  }
  return sources;
}
