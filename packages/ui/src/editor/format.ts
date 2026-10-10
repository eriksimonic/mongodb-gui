/**
 * Reindents mongosh source. It breaks object and array literals over lines, one entry per line,
 * and starts each top-level statement on its own line. Lines outside literals and calls keep their
 * breaks, and a blank line between them is kept as one blank line. It keeps every token: strings,
 * regex literals and comments are copied as they are. It does not reflow long calls. Prettier is
 * not used here on purpose.
 */

type TokenKind = 'word' | 'punct' | 'text' | 'comment';

interface Token {
  readonly kind: TokenKind;
  readonly text: string;
  /** True when whitespace separated this token from the one before it. */
  readonly spaced: boolean;
  /** Newlines in the whitespace before this token. Two or more mean a blank line. */
  readonly newlines: number;
}

const WORD = /[A-Za-z0-9_$]/;
const DIVISION_PRECEDERS = /[A-Za-z0-9_$)\]]/;

/** Splits the source into tokens. Regex literals are read whole, so their text is kept. */
function tokenize(code: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  let spaced = false;
  let newlines = 0;
  while (index < code.length) {
    const char = code.charAt(index);
    const next = code.charAt(index + 1);
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r') {
      spaced = true;
      if (char === '\n') {
        newlines += 1;
      }
      index += 1;
      continue;
    }
    let end = index + 1;
    let kind: TokenKind = 'punct';
    if (char === '/' && next === '/') {
      end = lineEnd(code, index);
      kind = 'comment';
    } else if (char === '/' && next === '*') {
      const close = code.indexOf('*/', index + 2);
      end = close === -1 ? code.length : close + 2;
      kind = 'comment';
    } else if (char === '"' || char === "'" || char === '`') {
      end = closingQuote(code, index, char);
      kind = 'text';
    } else if (char === '/' && isRegexStart(tokens)) {
      end = regexEnd(code, index);
      kind = 'text';
    } else if (WORD.test(char)) {
      end = index;
      while (end < code.length && WORD.test(code.charAt(end))) {
        end += 1;
      }
      kind = 'word';
    }
    tokens.push({ kind, text: code.slice(index, end), spaced, newlines });
    spaced = false;
    newlines = 0;
    index = end;
  }
  return tokens;
}

function lineEnd(code: string, from: number): number {
  const newline = code.indexOf('\n', from);
  return newline === -1 ? code.length : newline;
}

/** The index just past a quoted string. A backslash keeps the next character. */
function closingQuote(code: string, from: number, quote: string): number {
  let index = from + 1;
  while (index < code.length) {
    const char = code.charAt(index);
    if (char === '\\') {
      index += 2;
    } else if (char === quote) {
      return index + 1;
    } else {
      index += 1;
    }
  }
  return code.length;
}

/** A slash starts a regex when the token before it cannot end an operand. */
function isRegexStart(tokens: readonly Token[]): boolean {
  const previous = tokens[tokens.length - 1];
  if (previous === undefined) {
    return true;
  }
  if (previous.kind === 'word' || previous.kind === 'text') {
    return false;
  }
  return !DIVISION_PRECEDERS.test(previous.text);
}

/** The index just past a regex literal and its flags. */
function regexEnd(code: string, from: number): number {
  let index = from + 1;
  let inClass = false;
  while (index < code.length) {
    const char = code.charAt(index);
    if (char === '\\') {
      index += 2;
      continue;
    }
    if (char === '\n') {
      return index;
    }
    if (char === '[') {
      inClass = true;
    } else if (char === ']') {
      inClass = false;
    } else if (char === '/' && !inClass) {
      index += 1;
      while (index < code.length && WORD.test(code.charAt(index))) {
        index += 1;
      }
      return index;
    }
    index += 1;
  }
  return code.length;
}

const OPENERS: readonly string[] = ['{', '[', '('];
const CLOSERS: readonly string[] = ['}', ']', ')'];
// Punctuation that sticks to the token before it.
const NO_SPACE_BEFORE: readonly string[] = [')', ']', '}', ',', ':', ';', '.'];
// Punctuation that sticks to the token after it.
const NO_SPACE_AFTER: readonly string[] = ['(', '[', '{', '.'];

/** Object and array literals break over lines. Parentheses of calls stay inline. */
function isLiteral(opener: string | undefined): boolean {
  return opener === '{' || opener === '[';
}

function isPunct(token: Token, texts: readonly string[]): boolean {
  return token.kind === 'punct' && texts.includes(token.text);
}

/**
 * Spacing between two tokens on one line. Punctuation follows the usual rules. Everything else keeps
 * the spacing of the source, collapsed to one space.
 */
function needsSpace(previous: Token, token: Token): boolean {
  if (isPunct(token, NO_SPACE_BEFORE)) {
    return false;
  }
  if (isPunct(previous, NO_SPACE_AFTER)) {
    return false;
  }
  if (isPunct(previous, [':', ','])) {
    return true;
  }
  return token.spaced;
}

/**
 * Formats mongosh source with `indentSize` spaces per level. A non-blank result ends with one
 * newline. A blank input gives an empty string.
 */
export function formatMongoshCode(code: string, indentSize = 2): string {
  const tokens = tokenize(code);
  const brackets: string[] = [];
  let out = '';
  let lineStart = true;
  let previous: Token | undefined;

  // Calls add no indentation, so only literals count toward the depth.
  const literalDepth = (): number => brackets.filter((bracket) => isLiteral(bracket)).length;
  // Indent of a chained call that started a line at depth zero. It lasts until the statement ends.
  let chainIndent = 0;
  const indentation = (): string => ' '.repeat(literalDepth() * indentSize + chainIndent);
  const newline = (): void => {
    out = out.replace(/[ \t]+$/, '');
    if (out !== '') {
      out += '\n';
    }
    lineStart = true;
  };

  tokens.forEach((token, position) => {
    const following = tokens.at(position + 1);
    const isOpening = isPunct(token, OPENERS);
    const isClosing = isPunct(token, CLOSERS);
    // Outside literals and calls, a source line break starts a new line. A chained call on its
    // own line is indented one level under its statement.
    if (brackets.length === 0 && previous !== undefined && token.newlines > 0) {
      const continuation = isPunct(token, ['.']);
      chainIndent = continuation ? indentSize : 0;
      if (!lineStart) {
        newline();
      }
      if (token.newlines > 1 && !out.endsWith('\n\n')) {
        out += '\n';
      }
    }

    if (isClosing) {
      const opener = brackets.pop();
      // An empty literal stays on one line: {} and []. Calls never break before their closing paren.
      const isEmpty = previous !== undefined && isPunct(previous, OPENERS);
      if (!isEmpty && !lineStart && isLiteral(opener)) {
        newline();
      }
      if (lineStart) {
        out += indentation();
      }
    } else if (lineStart) {
      out += indentation();
    } else if (previous !== undefined && needsSpace(previous, token)) {
      out += ' ';
    }
    lineStart = false;
    out += token.text;
    previous = token;

    if (isOpening) {
      brackets.push(token.text);
      if (isLiteral(token.text) && following !== undefined && !isPunct(following, CLOSERS)) {
        newline();
      }
    } else if (token.kind === 'comment' && token.text.startsWith('//')) {
      newline();
    } else if (isPunct(token, [',']) && brackets.length > 0 && brackets.at(-1) !== '(') {
      newline();
    } else if (isPunct(token, [';']) && brackets.length === 0) {
      chainIndent = 0;
      newline();
    }
  });

  const trimmed = out.replace(/[ \t\n]+$/, '');
  return trimmed === '' ? '' : `${trimmed}\n`;
}
