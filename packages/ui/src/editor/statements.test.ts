import { describe, expect, it } from 'vitest';
import { runTargetFor, splitStatements, statementAt } from './statements';

describe('splitStatements', () => {
  it('splits on top-level semicolons and drops empty parts', () => {
    const code = 'print("a");  ;db.orders.countDocuments()\n;';
    expect(splitStatements(code).map((item) => item.text)).toEqual([
      'print("a")',
      'db.orders.countDocuments()',
    ]);
  });

  it('reports offsets that point at the trimmed text', () => {
    const code = '  db.a.find()  ;\n  db.b.find()';
    const [first, second] = splitStatements(code);
    expect(code.slice(first?.start, first?.end)).toBe('db.a.find()');
    expect(code.slice(second?.start, second?.end)).toBe('db.b.find()');
  });

  it('splits on a blank line outside brackets', () => {
    const code = 'db.a.find()\n\ndb.b.find()\n   \ndb.c.find()';
    expect(splitStatements(code).map((item) => item.text)).toEqual([
      'db.a.find()',
      'db.b.find()',
      'db.c.find()',
    ]);
  });

  it('keeps a blank line inside an object literal together', () => {
    const code = 'db.a.find({\n\n  status: "paid"\n})';
    expect(splitStatements(code)).toHaveLength(1);
  });

  it('ignores semicolons inside strings, comments and brackets', () => {
    const code = 'db.a.find({ note: "x; y" }) // one; two\n/* three; four */ ; db.b.find(\'a;b\')';
    expect(splitStatements(code).map((item) => item.text)).toEqual([
      'db.a.find({ note: "x; y" }) // one; two\n/* three; four */',
      "db.b.find('a;b')",
    ]);
  });

  it('handles escaped quotes inside strings', () => {
    const code = 'print("say \\"hi;\\""); db.a.find()';
    expect(splitStatements(code)).toHaveLength(2);
  });

  it('returns nothing for blank text', () => {
    expect(splitStatements(' \n\n ')).toEqual([]);
  });
});

describe('statementAt', () => {
  const code = 'db.a.find()\n\ndb.b.find()';

  it('returns the statement that holds the cursor', () => {
    expect(statementAt(code, 3)?.text).toBe('db.a.find()');
    expect(statementAt(code, code.length - 2)?.text).toBe('db.b.find()');
  });

  it('counts the offset just after a statement as inside it', () => {
    expect(statementAt(code, 11)?.text).toBe('db.a.find()');
  });

  it('takes the statement before a cursor on a blank line', () => {
    expect(statementAt(code, 12)?.text).toBe('db.a.find()');
  });

  it('takes the first statement before any text', () => {
    expect(statementAt('   db.a.find()', 0)?.text).toBe('db.a.find()');
  });

  it('returns undefined for empty text', () => {
    expect(statementAt('', 0)).toBeUndefined();
  });
});

describe('runTargetFor', () => {
  const code = 'db.a.find();\ndb.b.find()';

  it('runs a non-empty selection as written', () => {
    expect(runTargetFor(code, 0, { start: 0, end: 11 })).toEqual({
      source: 'selection',
      text: 'db.a.find()',
    });
  });

  it('runs the statement under the cursor when the selection is empty', () => {
    const target = runTargetFor(code, 15, { start: 15, end: 15 });
    expect(target).toEqual({ source: 'statement', text: 'db.b.find()', start: 13, end: 24 });
  });

  it('reports empty when there is nothing to run', () => {
    expect(runTargetFor('   ', 1)).toEqual({ source: 'empty' });
    expect(runTargetFor('db.a.find()', 0, { start: 2, end: 2 }).source).toBe('statement');
  });

  it('treats a whitespace-only selection as empty text', () => {
    expect(runTargetFor('  db.a.find()', 0, { start: 0, end: 2 })).toEqual({ source: 'empty' });
  });
});
