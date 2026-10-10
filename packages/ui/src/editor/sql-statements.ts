/**
 * Finds the SQL statement to run in the editor. The split comes from the translator, so a statement
 * ends at a `;` or at a `GO` alone on its line, and a blank line does not end one.
 */
import { splitSqlStatements } from '@mongo-gui/core';
import type { RunTarget, Selection, Statement } from './statements';

/** Every SQL statement of the text, in order. Empty statements are dropped. */
export function splitSqlText(code: string): Statement[] {
  return splitSqlStatements(code).map((span) => ({
    start: span.start,
    end: span.end,
    text: code.slice(span.start, span.end),
  }));
}

/**
 * The SQL statement that holds the offset. A cursor between two statements, or after the last
 * `;`, takes the statement before it. Before the first statement it takes the first one.
 */
export function sqlStatementAt(code: string, offset: number): Statement | undefined {
  const statements = splitSqlText(code);
  const inside = statements.find((item) => offset >= item.start && offset <= item.end);
  if (inside !== undefined) {
    return inside;
  }
  const before = statements.filter((item) => item.end < offset);
  return before[before.length - 1] ?? statements[0];
}

/**
 * What Run executes in a SQL tab. A non-empty selection runs as written. Without one, Run executes
 * the statement under the cursor.
 */
export function sqlRunTargetFor(code: string, cursor: number, selection?: Selection): RunTarget {
  if (selection !== undefined && selection.end > selection.start) {
    const text = code.slice(selection.start, selection.end).trim();
    return text === '' ? { source: 'empty' } : { source: 'selection', text };
  }
  const statement = sqlStatementAt(code, cursor);
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
