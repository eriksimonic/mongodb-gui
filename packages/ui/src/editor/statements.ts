/**
 * Splits editor text into statements. A statement ends at a `;` or a blank line that sits outside
 * brackets, strings and comments. A slash-delimited regex literal is not parsed, so a quote inside
 * one can confuse the split. Such text is rare, and the run still sends the whole selection.
 */

export interface Statement {
  /** Offset of the first character of the statement, after leading whitespace. */
  readonly start: number;
  /** Offset just after the last character of the statement, before trailing whitespace. */
  readonly end: number;
  readonly text: string;
}

export interface Selection {
  readonly start: number;
  readonly end: number;
}

export type RunTarget =
  | { readonly source: 'selection'; readonly text: string }
  | {
      readonly source: 'statement';
      readonly text: string;
      readonly start: number;
      readonly end: number;
    }
  | { readonly source: 'empty' };

const BLANK_LINE = /[ \t\r]*\n/y;

/** Every statement of the text, in order. Empty statements are dropped. */
export function splitStatements(code: string): Statement[] {
  const statements: Statement[] = [];
  let depth = 0;
  let quote: string | undefined;
  let lineComment = false;
  let blockComment = false;
  let segmentStart = 0;

  const flush = (end: number): void => {
    const raw = code.slice(segmentStart, end);
    const trimmed = raw.trim();
    if (trimmed !== '') {
      const start = segmentStart + (raw.length - raw.trimStart().length);
      statements.push({ start, end: start + trimmed.length, text: trimmed });
    }
  };

  for (let index = 0; index < code.length; index += 1) {
    const char = code.charAt(index);
    const next = code.charAt(index + 1);
    if (lineComment) {
      if (char === '\n') {
        lineComment = false;
      }
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote !== undefined) {
      if (char === '\\') {
        index += 1;
      } else if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === '/' && next === '/') {
      lineComment = true;
      index += 1;
    } else if (char === '/' && next === '*') {
      blockComment = true;
      index += 1;
    } else if (char === '"' || char === "'" || char === '`') {
      quote = char;
    } else if (char === '(' || char === '[' || char === '{') {
      depth += 1;
    } else if (char === ')' || char === ']' || char === '}') {
      depth = Math.max(0, depth - 1);
    } else if (depth === 0 && char === ';') {
      flush(index);
      segmentStart = index + 1;
    } else if (depth === 0 && char === '\n') {
      BLANK_LINE.lastIndex = index + 1;
      if (BLANK_LINE.test(code)) {
        flush(index);
        segmentStart = BLANK_LINE.lastIndex;
        index = segmentStart - 1;
      }
    }
  }
  flush(code.length);
  return statements;
}

/**
 * The statement that holds the offset. A cursor between two statements, or on a blank line, takes
 * the statement before it. Before the first statement it takes the first one.
 */
export function statementAt(code: string, offset: number): Statement | undefined {
  const statements = splitStatements(code);
  const inside = statements.find((item) => offset >= item.start && offset <= item.end);
  if (inside !== undefined) {
    return inside;
  }
  const before = statements.filter((item) => item.end < offset);
  return before[before.length - 1] ?? statements[0];
}

/**
 * What Run executes. A non-empty selection runs as written. Without one, Run executes the
 * statement under the cursor.
 */
export function runTargetFor(code: string, cursor: number, selection?: Selection): RunTarget {
  if (selection !== undefined && selection.end > selection.start) {
    const text = code.slice(selection.start, selection.end).trim();
    return text === '' ? { source: 'empty' } : { source: 'selection', text };
  }
  const statement = statementAt(code, cursor);
  if (statement === undefined) {
    return { source: 'empty' };
  }
  return {
    source: 'statement',
    text: statement.text,
    start: statement.start,
    end: statement.end,
  };
}
