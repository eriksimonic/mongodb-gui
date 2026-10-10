/**
 * The tokenizer for the T-SQL subset the editor translates to mongosh. `scanRaw` splits text into
 * every lexeme including whitespace and comments and never throws, so the statement splitter can
 * work on broken input. `tokenize` drops the whitespace and comments and throws `SqlError` for an
 * unterminated string, bracket or block comment and for a character the grammar has no use for.
 */
import { SqlError, type Span } from './ast';

export type TokenKind = 'word' | 'identifier' | 'string' | 'number' | 'operator' | 'parameter';

export interface Token {
  readonly kind: TokenKind;
  /** The source text as written, such as `[Order Id]` or `N'it''s'`. */
  readonly text: string;
  /**
   * The meaning of the token. A bracketed or quoted identifier without its wrapping and with `]]`
   * or `""` unescaped, a string without its quotes and with `''` unescaped, a parameter without
   * its `@`, and the text itself for a word, number or operator.
   */
  readonly value: string;
  readonly start: number;
  readonly end: number;
}

export type RawTokenKind = TokenKind | 'whitespace' | 'comment' | 'invalid';

/** A lexeme from `scanRaw`, which keeps whitespace, comments and unterminated input. */
export interface RawToken {
  readonly kind: RawTokenKind;
  readonly text: string;
  readonly value: string;
  readonly start: number;
  readonly end: number;
  /** A string, identifier or block comment that runs to the end of the text without closing. */
  readonly unterminated: boolean;
}

const WHITESPACE = /\s+/y;
/** A word, or a temporary table name such as `#tmp` or `##shared`, so the parser can refuse it. */
const WORD = /#{0,2}[\p{L}_][\p{L}\p{N}_]*/uy;
const NUMBER = /\d+(?:\.\d*)?(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?/y;
const PARAMETER = /@@?[\p{L}_][\p{L}\p{N}_]*/uy;
const OPERATORS = [
  '<>',
  '<=',
  '>=',
  '!=',
  '=',
  '<',
  '>',
  '+',
  '-',
  '*',
  '/',
  '%',
  '(',
  ')',
  ',',
  '.',
  ';',
];

function matchAt(pattern: RegExp, text: string, index: number): string | undefined {
  pattern.lastIndex = index;
  const match = pattern.exec(text);
  return match ? match[0] : undefined;
}

/**
 * Reads an enclosed lexeme starting at the opening character. The closing character doubled stands
 * for itself. Returns the exclusive end offset, or undefined when the text ends first.
 */
function readEnclosed(text: string, start: number, close: string): number | undefined {
  let index = start + 1;
  while (index < text.length) {
    if (text.charAt(index) === close) {
      if (text.charAt(index + 1) === close) {
        index += 2;
        continue;
      }
      return index + 1;
    }
    index += 1;
  }
  return undefined;
}

function unwrap(text: string, open: string, close: string): string {
  const inner = text.endsWith(close)
    ? text.slice(open.length, -close.length)
    : text.slice(open.length);
  return inner.split(close + close).join(close);
}

function readBlockComment(text: string, start: number): number | undefined {
  let depth = 0;
  let index = start;
  while (index < text.length) {
    if (text.startsWith('/*', index)) {
      depth += 1;
      index += 2;
    } else if (text.startsWith('*/', index)) {
      depth -= 1;
      index += 2;
      if (depth === 0) {
        return index;
      }
    } else {
      index += 1;
    }
  }
  return undefined;
}

function readLineComment(text: string, start: number): number {
  const newline = text.indexOf('\n', start);
  if (newline === -1) {
    return text.length;
  }
  return text.charAt(newline - 1) === '\r' ? newline - 1 : newline;
}

/** Splits the text into lexemes, keeping whitespace and comments. Never throws. */
export function scanRaw(text: string): RawToken[] {
  const tokens: RawToken[] = [];
  let index = 0;
  const push = (kind: RawTokenKind, end: number, value?: string, unterminated = false): void => {
    const raw = text.slice(index, end);
    tokens.push({ kind, text: raw, value: value ?? raw, start: index, end, unterminated });
    index = end;
  };

  while (index < text.length) {
    const char = text.charAt(index);
    const pair = text.slice(index, index + 2);

    const whitespace = matchAt(WHITESPACE, text, index);
    if (whitespace !== undefined) {
      push('whitespace', index + whitespace.length);
      continue;
    }
    if (pair === '--') {
      push('comment', readLineComment(text, index));
      continue;
    }
    if (pair === '/*') {
      const end = readBlockComment(text, index);
      push('comment', end ?? text.length, undefined, end === undefined);
      continue;
    }
    if (char === "'" || ((char === 'N' || char === 'n') && pair.charAt(1) === "'")) {
      const quote = char === "'" ? index : index + 1;
      const end = readEnclosed(text, quote, "'");
      const raw = text.slice(quote, end ?? text.length);
      push('string', end ?? text.length, unwrap(raw, "'", "'"), end === undefined);
      continue;
    }
    if (char === '[') {
      const end = readEnclosed(text, index, ']');
      const raw = text.slice(index, end ?? text.length);
      push('identifier', end ?? text.length, unwrap(raw, '[', ']'), end === undefined);
      continue;
    }
    if (char === '"') {
      const end = readEnclosed(text, index, '"');
      const raw = text.slice(index, end ?? text.length);
      push('identifier', end ?? text.length, unwrap(raw, '"', '"'), end === undefined);
      continue;
    }
    const number = matchAt(NUMBER, text, index);
    if (number !== undefined) {
      push('number', index + number.length);
      continue;
    }
    const parameter = matchAt(PARAMETER, text, index);
    if (parameter !== undefined) {
      push('parameter', index + parameter.length, parameter.slice(1));
      continue;
    }
    const word = matchAt(WORD, text, index);
    if (word !== undefined) {
      push('word', index + word.length);
      continue;
    }
    const operator = OPERATORS.find((candidate) => text.startsWith(candidate, index));
    if (operator !== undefined) {
      push('operator', index + operator.length);
      continue;
    }
    push('invalid', index + 1);
  }
  return tokens;
}

/** The span of the opening character of an unterminated lexeme, `N'` and `/*` being two wide. */
function openingSpan(raw: RawToken, offset: number): Span {
  const twoWide = raw.kind === 'comment' || (raw.kind === 'string' && !raw.text.startsWith("'"));
  return { start: raw.start + offset, end: raw.start + offset + (twoWide ? 2 : 1) };
}

function unterminatedMessage(raw: RawToken): string {
  switch (raw.kind) {
    case 'comment':
      return 'unterminated block comment';
    case 'string':
      return 'unterminated string';
    default:
      return raw.text.startsWith('[')
        ? 'unterminated bracketed identifier'
        : 'unterminated quoted identifier';
  }
}

/**
 * Tokenizes a statement. `offset` is the position of `text` in the full editor text, so every span
 * is absolute. Throws `SqlError` for unterminated input and for a character outside the grammar.
 */
export function tokenize(text: string, offset = 0): Token[] {
  const tokens: Token[] = [];
  for (const raw of scanRaw(text)) {
    if (raw.unterminated) {
      throw new SqlError(unterminatedMessage(raw), openingSpan(raw, offset));
    }
    if (raw.kind === 'invalid') {
      throw new SqlError(`unexpected character '${raw.text}'`, {
        start: raw.start + offset,
        end: raw.end + offset,
      });
    }
    if (raw.kind === 'whitespace' || raw.kind === 'comment') {
      continue;
    }
    if (raw.kind === 'identifier' && raw.value === '') {
      throw new SqlError('an identifier cannot be empty', {
        start: raw.start + offset,
        end: raw.end + offset,
      });
    }
    tokens.push({
      kind: raw.kind,
      text: raw.text,
      value: raw.value,
      start: raw.start + offset,
      end: raw.end + offset,
    });
  }
  return tokens;
}
