import { describe, expect, it } from 'vitest';
import { splitSqlText, sqlRunTargetFor, sqlStatementAt } from './sql-statements';

describe('splitSqlText', () => {
  it('splits on semicolons and drops empty parts', () => {
    const code = 'SELECT 1;  ;SELECT 2\n;';
    expect(splitSqlText(code).map((item) => item.text)).toEqual(['SELECT 1', 'SELECT 2']);
  });

  it('reports offsets that point at the trimmed text', () => {
    const code = '  SELECT * FROM a  ;\n  SELECT * FROM b';
    const [first, second] = splitSqlText(code);
    expect(code.slice(first?.start, first?.end)).toBe('SELECT * FROM a');
    expect(code.slice(second?.start, second?.end)).toBe('SELECT * FROM b');
  });

  it('keeps a blank line inside one statement', () => {
    const code = 'SELECT a\n\nFROM orders\n\nWHERE x = 1';
    expect(splitSqlText(code)).toHaveLength(1);
  });

  it('splits at a GO on its own line', () => {
    const code = 'SELECT 1\nGO\nSELECT 2';
    expect(splitSqlText(code).map((item) => item.text)).toEqual(['SELECT 1', 'SELECT 2']);
  });

  it('ignores semicolons inside strings, brackets and comments', () => {
    const code = "SELECT 'a;b' AS [x;y] -- one; two\n/* three; four */ ; SELECT 2";
    expect(splitSqlText(code)).toHaveLength(2);
  });

  it('returns nothing for blank text and for comments only', () => {
    expect(splitSqlText(' \n\n ')).toEqual([]);
    expect(splitSqlText('-- nothing here')).toEqual([]);
  });
});

describe('sqlStatementAt', () => {
  const code = 'SELECT 1;\n\nSELECT 2';

  it('returns the statement that holds the cursor', () => {
    expect(sqlStatementAt(code, 3)?.text).toBe('SELECT 1');
    expect(sqlStatementAt(code, code.length - 2)?.text).toBe('SELECT 2');
  });

  it('counts the offset just after a statement as inside it', () => {
    expect(sqlStatementAt(code, 8)?.text).toBe('SELECT 1');
  });

  it('takes the statement before a cursor after the semicolon', () => {
    expect(sqlStatementAt(code, 9)?.text).toBe('SELECT 1');
    expect(sqlStatementAt(code, 10)?.text).toBe('SELECT 1');
  });

  it('takes the statement that starts at the cursor', () => {
    expect(sqlStatementAt(code, 11)?.text).toBe('SELECT 2');
  });

  it('takes the first statement before any text', () => {
    expect(sqlStatementAt('   SELECT 1', 0)?.text).toBe('SELECT 1');
  });

  it('takes the last statement for a cursor at the end of trailing blanks', () => {
    expect(sqlStatementAt('SELECT 1;\nSELECT 2;\n\n', 21)?.text).toBe('SELECT 2');
  });

  it('returns undefined for empty text', () => {
    expect(sqlStatementAt('', 0)).toBeUndefined();
    expect(sqlStatementAt('-- only a comment', 3)).toBeUndefined();
  });

  it('finds the statement across several lines', () => {
    const multi = 'SELECT a,\n  b\nFROM orders;\nDELETE FROM orders\nWHERE id = 1';
    expect(sqlStatementAt(multi, 14)?.text).toBe('SELECT a,\n  b\nFROM orders');
    expect(sqlStatementAt(multi, multi.length)?.text).toBe('DELETE FROM orders\nWHERE id = 1');
  });
});

describe('sqlRunTargetFor', () => {
  const code = 'SELECT * FROM a;\nSELECT * FROM b';

  it('runs a non-empty selection as written', () => {
    expect(sqlRunTargetFor(code, 0, { start: 0, end: 15 })).toEqual({
      source: 'selection',
      text: 'SELECT * FROM a',
    });
  });

  it('trims the selection', () => {
    expect(sqlRunTargetFor(code, 0, { start: 0, end: 17 })).toEqual({
      source: 'selection',
      text: 'SELECT * FROM a;',
    });
  });

  it('runs the statement under the cursor when the selection is empty', () => {
    const target = sqlRunTargetFor(code, 20, { start: 20, end: 20 });
    expect(target).toEqual({ source: 'statement', text: 'SELECT * FROM b', start: 17, end: 32 });
  });

  it('runs the statement under the cursor without a selection', () => {
    expect(sqlRunTargetFor(code, 3)).toEqual({
      source: 'statement',
      text: 'SELECT * FROM a',
      start: 0,
      end: 15,
    });
  });

  it('reports empty when there is nothing to run', () => {
    expect(sqlRunTargetFor('   ', 1)).toEqual({ source: 'empty' });
    expect(sqlRunTargetFor('-- note', 1)).toEqual({ source: 'empty' });
    expect(sqlRunTargetFor('SELECT 1', 0, { start: 2, end: 2 }).source).toBe('statement');
  });

  it('treats a whitespace-only selection as empty text', () => {
    expect(sqlRunTargetFor('  SELECT 1', 0, { start: 0, end: 2 })).toEqual({ source: 'empty' });
  });

  it('does not split on a blank line', () => {
    const target = sqlRunTargetFor('SELECT a\n\nFROM t', 12);
    expect(target).toEqual({ source: 'statement', text: 'SELECT a\n\nFROM t', start: 0, end: 16 });
  });
});
