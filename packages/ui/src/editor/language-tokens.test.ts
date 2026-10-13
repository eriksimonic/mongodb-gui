// @vitest-environment jsdom
import '../test-support/browser-shims';
import type * as Monaco from 'monaco-editor/editor/editor.api';
import { beforeAll, describe, expect, it, vi } from 'vitest';

// Monaco's own tokenizer runs here, over the real Monarch definitions. Only the worker setup is
// replaced, because jsdom has no workers.
vi.mock('../kit/code/monaco-setup', () => ({}));

let monaco: typeof Monaco;

beforeAll(async () => {
  monaco = await import('monaco-editor/editor/editor.api');
  const { registerMongoshLanguage } = await import('./mongosh-language');
  const { registerSqlLanguage } = await import('./sql-language');
  registerMongoshLanguage(monaco);
  registerSqlLanguage(monaco);
});

type Language = 'mongosh' | 'tsql';

/** The token of the first character of the nth occurrence of `needle`, without the language suffix. */
function kind(language: Language, text: string, needle: string, nth = 0): string {
  let index = -1;
  for (let count = 0; count <= nth; count++) {
    index = text.indexOf(needle, index + 1);
    if (index < 0) {
      throw new Error(`"${needle}" occurs fewer than ${nth + 1} times in the sample`);
    }
  }
  const lines = monaco.editor.tokenize(text, language);
  const before = text.slice(0, index).split('\n');
  const lineIndex = before.length - 1;
  const column = before[lineIndex]?.length ?? 0;
  const tokens = lines[lineIndex] ?? [];
  let found = tokens[0];
  for (const token of tokens) {
    if (token.offset <= column) {
      found = token;
    }
  }
  if (found === undefined) {
    throw new Error(`no token at "${needle}"`);
  }
  return found.type.replace(`.${language}`, '');
}

/** Every non-blank token of one line as `text:token`, for whole-line checks. */
function line(language: Language, text: string): string[] {
  const [tokens = []] = monaco.editor.tokenize(text, language);
  return tokens
    .map((token, i) => ({
      text: text.slice(token.offset, tokens[i + 1]?.offset ?? text.length),
      type: token.type.replace(`.${language}`, ''),
    }))
    .filter((token) => token.type !== 'white')
    .map((token) => `${token.text}:${token.type}`);
}

const mongo = (text: string, needle: string, nth = 0) => kind('mongosh', text, needle, nth);
const sql = (text: string, needle: string, nth = 0) => kind('tsql', text, needle, nth);

describe('mongosh tokens', () => {
  const find = "db.orders.find({ status: 'A', total: { $gt: 5 } }).sort({ createdAt: -1 })";

  it('colors a collection after db as a type and keeps db as a shell global', () => {
    expect(mongo(find, 'db')).toBe('type.identifier');
    expect(mongo(find, 'orders')).toBe('type');
  });

  it('colors a method before a parenthesis as a function', () => {
    expect(mongo(find, 'find')).toBe('function');
    expect(mongo(find, 'sort')).toBe('function');
  });

  it('colors keys before a colon as properties, at any depth', () => {
    expect(mongo(find, 'status')).toBe('property');
    expect(mongo(find, 'total')).toBe('property');
    expect(mongo(find, 'createdAt')).toBe('property');
  });

  it('keeps operators predefined, also as keys', () => {
    expect(mongo(find, '$gt')).toBe('predefined');
    expect(mongo('{ "$or": [] }', '"$or"')).toBe('predefined');
  });

  it('keeps strings, numbers and delimiters', () => {
    expect(mongo(find, "'A'")).toBe('string');
    expect(mongo(find, '5')).toBe('number');
    expect(mongo(find, ':')).toBe('delimiter');
  });

  it('colors a quoted key as a property, whatever the quote', () => {
    const text = `{ 'customer.email': 1, "a": 2, "b c" : 3 }`;
    expect(mongo(text, "'customer.email'")).toBe('property');
    expect(mongo(text, '"a"')).toBe('property');
    expect(mongo(text, '"b c"')).toBe('property');
  });

  it('keeps a quoted value a string', () => {
    const text = `{ a: 'x', b: "y" }`;
    expect(mongo(text, "'x'")).toBe('string');
    expect(mongo(text, '"y"')).toBe('string');
  });

  it('handles a quoted key that holds an escaped quote', () => {
    expect(mongo(String.raw`{ "a\"b": 1, c: 2 }`, 'c')).toBe('property');
  });

  it('colors a keyword used as a key as a property', () => {
    const text = '{ in: 1, new: 2, null: 3 }';
    expect(mongo(text, 'in')).toBe('property');
    expect(mongo(text, 'new')).toBe('property');
    expect(mongo(text, 'null')).toBe('property');
  });

  it('colors a member after a dot as a property', () => {
    expect(mongo('doc.status', 'status')).toBe('property');
    expect(mongo('db.orders.find().toArray().length', 'length')).toBe('property');
    expect(mongo('a.b.c', 'b')).toBe('property');
  });

  it('colors a member of a call result as a property or a function', () => {
    const text = 'db.getCollection("x").find().limit(2)';
    expect(mongo(text, 'getCollection')).toBe('function');
    expect(mongo(text, 'limit')).toBe('function');
  });

  it('colors the first member after db as a function when it is called', () => {
    expect(mongo('db.stats()', 'stats')).toBe('function');
    expect(mongo('db.runCommand({ ping: 1 })', 'runCommand')).toBe('function');
  });

  it('does not take a ternary else branch for a key', () => {
    const text = 'x ? y : z';
    expect(mongo(text, 'y')).toBe('identifier');
    expect(mongo(text, 'z')).toBe('identifier');
  });

  it('does not take a ternary inside an object for a key', () => {
    const text = '{ a: ok ? b : c, d: 1 }';
    expect(mongo(text, 'a')).toBe('property');
    expect(mongo(text, 'b')).toBe('identifier');
    expect(mongo(text, 'c')).toBe('identifier');
    expect(mongo(text, 'd')).toBe('property');
  });

  it('survives a nested ternary and an object inside a branch', () => {
    const text = '{ a: p ? q ? r : s : t, b: u ? { c: 1 } : 2, d: 3 }';
    expect(mongo(text, 'r')).toBe('identifier');
    expect(mongo(text, 's')).toBe('identifier');
    expect(mongo(text, 't')).toBe('identifier');
    expect(mongo(text, 'c')).toBe('property');
    expect(mongo(text, 'd')).toBe('property');
  });

  it('keeps a quoted string a string in a ternary branch', () => {
    const text = `{ a: ok ? "x" : "y", b: 1 }`;
    expect(mongo(text, '"x"')).toBe('string');
    expect(mongo(text, '"y"')).toBe('string');
    expect(mongo(text, 'b')).toBe('property');
  });

  it('ends an unfinished ternary at a closing bracket', () => {
    const text = 'f({ a: x ? y }, { b: 1 })';
    expect(mongo(text, 'b')).toBe('property');
  });

  it('ends an unfinished ternary at a semicolon', () => {
    const text = 'x ? y;\nq = { r: 1 }';
    expect(mongo(text, 'r')).toBe('property');
  });

  it('does not take a ternary in a call for a key', () => {
    const text = '{ a: f(ok ? b : c), d: 1 }';
    expect(mongo(text, 'b')).toBe('identifier');
    expect(mongo(text, 'c')).toBe('identifier');
    expect(mongo(text, 'd')).toBe('property');
  });

  it('treats optional chaining and nullish coalescing as operators', () => {
    const text = 'a?.b ?? c';
    expect(mongo(text, 'b')).toBe('property');
    expect(mongo(text, '??')).toBe('operator');
    expect(mongo('a?.run()', 'run')).toBe('function');
    expect(mongo('{ k: a?.b ? c : d, e: 1 }', 'e')).toBe('property');
  });

  it('keeps a label at the top level a plain identifier', () => {
    const text = 'outer: for (const x of y) { break outer }';
    expect(mongo(text, 'outer')).toBe('identifier');
    expect(mongo(text, 'for')).toBe('keyword');
  });

  it('does not let a label leave the tokenizer in a wrong state', () => {
    const text = 'loop: while (true) {\n  v = ok ? a : b\n}\ndb.orders.find({ kk: 1 })';
    expect(mongo(text, 'a')).toBe('identifier');
    expect(mongo(text, 'kk')).toBe('property');
    expect(mongo(text, 'orders')).toBe('type');
  });

  it('colors keys on later lines of a multi-line object', () => {
    const text = 'db.orders.find({\n  status: "A",\n  total: {\n    $gt: 5,\n    $lt: 9\n  }\n})';
    expect(mongo(text, 'status')).toBe('property');
    expect(mongo(text, 'total')).toBe('property');
    expect(mongo(text, '$gt')).toBe('predefined');
    expect(mongo(text, '$lt')).toBe('predefined');
  });

  it('colors keys inside arrays of objects, as in a pipeline', () => {
    const text =
      'db.orders.aggregate([{ $match: { status: "A" } }, { $group: { _id: "$c", n: { $sum: 1 } } }])';
    expect(mongo(text, 'aggregate')).toBe('function');
    expect(mongo(text, '$match')).toBe('predefined');
    expect(mongo(text, 'status')).toBe('property');
    expect(mongo(text, '_id')).toBe('property');
    expect(mongo(text, 'n')).toBe('property');
    expect(mongo(text, '$sum')).toBe('predefined');
  });

  it('keeps a dollar field path in a string a string', () => {
    expect(mongo('{ $sum: "$total" }', '"$total"')).toBe('string');
  });

  it('keeps keywords, shell globals, comments and numbers', () => {
    expect(mongo('const x = new ObjectId()', 'const')).toBe('keyword');
    expect(mongo('const x = new ObjectId()', 'ObjectId')).toBe('type.identifier');
    expect(mongo('// find()', 'find')).toBe('comment');
    expect(mongo('/* a: 1 */', 'a')).toBe('comment');
    expect(mongo('x = 1.5e3', '1.5e3')).toBe('number');
  });

  it('does not color a key inside a comment or a string', () => {
    expect(mongo("db.a.find({ s: 'k: 1' })", 'k')).toBe('string');
    expect(mongo('{ a: 1 } // b: 2', 'b')).toBe('comment');
  });

  it('colors a member after a spread as a plain identifier', () => {
    expect(mongo('{ ...base, a: 1 }', 'base')).toBe('identifier');
    expect(mongo('{ ...base, a: 1 }', 'a:')).toBe('property');
  });

  it('colors rs and sh calls as functions', () => {
    expect(mongo('rs.status()', 'status')).toBe('function');
    expect(mongo('sh.status()', 'status')).toBe('function');
  });

  it('tokenizes a whole statement left to right', () => {
    expect(line('mongosh', "db.users.find({ name: 'x' })")).toEqual([
      'db:type.identifier',
      '.:delimiter',
      'users:type',
      '.:delimiter',
      'find:function',
      '(:delimiter.parenthesis',
      '{:delimiter.curly',
      'name:property',
      '::delimiter',
      "'x':string",
      '}:delimiter.curly',
      '):delimiter.parenthesis',
    ]);
  });
});

describe('T-SQL tokens', () => {
  it('colors the table after FROM as a type and a column as a property', () => {
    const text = 'SELECT status FROM orders';
    expect(sql(text, 'SELECT')).toBe('keyword');
    expect(sql(text, 'status')).toBe('property');
    expect(sql(text, 'FROM')).toBe('keyword');
    expect(sql(text, 'orders')).toBe('type');
  });

  it('colors a table with an alias, and the alias, as types', () => {
    const text = 'SELECT o.total FROM orders o WHERE o.total > 5';
    expect(sql(text, 'orders')).toBe('type');
    expect(sql(text, 'o', 0)).toBe('type');
    expect(sql(text, 'total')).toBe('property');
    expect(sql(text, 'WHERE')).toBe('keyword');
  });

  it('colors the alias after AS as a type', () => {
    const text = 'SELECT 1 FROM orders AS o';
    expect(sql(text, 'AS')).toBe('keyword');
    expect(sql(text, 'o', 1)).toBe('type');
  });

  it('colors FROM without an alias and a following keyword', () => {
    for (const next of ['WHERE x = 1', 'ORDER BY x', 'GROUP BY x', 'JOIN c ON 1 = 1']) {
      const text = `SELECT * FROM orders ${next}`;
      expect(sql(text, 'orders')).toBe('type');
      expect(sql(text, next.split(' ')[0] ?? '')).toBe('keyword');
    }
  });

  it('ends the table at a semicolon, a parenthesis or the end of the line', () => {
    expect(sql('SELECT * FROM orders;', 'orders')).toBe('type');
    expect(sql('INSERT INTO orders (a, b) VALUES (1, 2)', 'orders')).toBe('type');
    expect(sql('INSERT INTO orders (a, b) VALUES (1, 2)', 'a')).toBe('property');
    expect(sql('SELECT * FROM orders\nWHERE status = 1', 'status')).toBe('property');
    expect(sql('SELECT * FROM orders\nGO', 'GO')).toBe('keyword');
  });

  it('colors the table after JOIN, UPDATE, INTO and TABLE as a type', () => {
    expect(sql('SELECT 1 FROM a INNER JOIN items i ON i.x = a.x', 'items')).toBe('type');
    expect(sql('UPDATE orders SET status = 1', 'orders')).toBe('type');
    expect(sql('UPDATE orders SET status = 1', 'status')).toBe('property');
    expect(sql('INSERT INTO orders VALUES (1)', 'orders')).toBe('type');
    expect(sql('TRUNCATE TABLE orders', 'orders')).toBe('type');
    expect(sql('TRUNCATE TABLE orders', 'TABLE')).toBe('keyword');
    expect(sql('DELETE FROM orders WHERE a = 1', 'orders')).toBe('type');
  });

  it('colors a qualifier before a dot as a type and the column after it as a property', () => {
    const text = 'SELECT o.id, c.name FROM orders o JOIN customers c ON c.id = o.cid';
    expect(sql(text, 'c', 0)).toBe('type');
    expect(sql(text, 'id', 0)).toBe('property');
    expect(sql(text, 'name')).toBe('property');
    expect(sql(text, 'cid')).toBe('property');
  });

  it('colors every part of a schema qualified table as a type', () => {
    const text = 'SELECT * FROM dbo.orders o';
    expect(sql(text, 'dbo')).toBe('type');
    expect(sql(text, 'orders')).toBe('type');
    expect(sql(text, 'o', 1)).toBe('type');
  });

  it('colors a bracketed name by position', () => {
    const text = 'SELECT [first name] FROM [dbo].[order items] [i] WHERE [i].[qty] > 1';
    expect(sql(text, '[first name]')).toBe('property');
    expect(sql(text, '[dbo]')).toBe('type');
    expect(sql(text, '[order items]')).toBe('type');
    expect(sql(text, '[i]', 0)).toBe('type');
    expect(sql(text, '[i]', 1)).toBe('type');
    expect(sql(text, '[qty]')).toBe('property');
  });

  it('keeps a doubled closing bracket inside a bracketed name', () => {
    expect(sql('SELECT [a]]b] FROM t', '[a]]b]')).toBe('property');
    expect(sql('SELECT [a]]b] FROM t', 't')).toBe('type');
  });

  it('colors a double-quoted name by position', () => {
    const text = 'SELECT "Total" FROM "Orders" WHERE "Orders"."Total" > 1';
    expect(sql(text, '"Total"', 0)).toBe('property');
    expect(sql(text, '"Orders"', 0)).toBe('type');
    expect(sql(text, '"Orders"', 1)).toBe('type');
    expect(sql(text, '"Total"', 1)).toBe('property');
  });

  it('recovers from an unclosed bracket on the same line only', () => {
    const text = 'SELECT [abc\nFROM orders';
    expect(sql(text, 'orders')).toBe('type');
  });

  it('keeps function names predefined and unknown calls functions', () => {
    const text = 'SELECT COUNT(*), dbo.fn_tax(total), my_fn(1) FROM orders';
    expect(sql(text, 'COUNT')).toBe('predefined');
    expect(sql(text, 'fn_tax')).toBe('function');
    expect(sql(text, 'my_fn')).toBe('function');
    expect(sql(text, 'total')).toBe('property');
  });

  it('keeps data types apart from tables', () => {
    const text = 'SELECT CAST(x AS INT) FROM orders';
    expect(sql(text, 'INT')).toBe('keyword.type');
    expect(sql(text, 'orders')).toBe('type');
    expect(sql(text, 'x')).toBe('property');
  });

  it('colors a table named like a function or a type', () => {
    expect(sql('SELECT * FROM text', 'text')).toBe('type');
    expect(sql('SELECT * FROM day', 'day')).toBe('type');
  });

  it('ignores case in keywords, functions and types', () => {
    const text = 'select count(*) from Orders as o where cast(o.n as int) > 1';
    expect(sql(text, 'select')).toBe('keyword');
    expect(sql(text, 'count')).toBe('predefined');
    expect(sql(text, 'from')).toBe('keyword');
    expect(sql(text, 'Orders')).toBe('type');
    expect(sql(text, 'int')).toBe('keyword.type');
  });

  it('colors variables, strings, numbers and comments', () => {
    expect(sql('SELECT @id, @@ROWCOUNT', '@id')).toBe('variable');
    expect(sql('SELECT @id, @@ROWCOUNT', '@@ROWCOUNT')).toBe('variable');
    expect(sql("WHERE a = N'x'", "N'x'")).toBe('string');
    expect(sql("WHERE a = 'it''s'", "'it''s'")).toBe('string');
    expect(sql('SELECT 1.5', '1.5')).toBe('number');
    expect(sql('-- FROM orders', 'orders')).toBe('comment');
    expect(sql('/* FROM orders */', 'orders')).toBe('comment');
  });

  it('colors a comment between a table keyword and its name', () => {
    expect(sql('SELECT * FROM /* x */ orders', 'orders')).toBe('type');
    expect(sql('SELECT * FROM orders -- c\nWHERE a = 1', 'a')).toBe('property');
  });

  it('colors a temporary table as a type', () => {
    expect(sql('SELECT * FROM #tmp', '#tmp')).toBe('type');
  });

  it('does not take an alias for a clause word', () => {
    expect(sql('SELECT * FROM orders WITH (NOLOCK)', 'WITH')).toBe('keyword');
    expect(sql('SELECT * FROM orders UNION SELECT * FROM x', 'UNION')).toBe('keyword');
    expect(sql('UPDATE orders SET a = 1 FROM orders o', 'o', 2)).toBe('type');
  });

  it('colors a subquery in FROM and its alias', () => {
    const text = 'SELECT * FROM (SELECT a FROM t) AS s WHERE s.a = 1';
    expect(sql(text, 'a')).toBe('property');
    expect(sql(text, 't')).toBe('type');
    expect(sql(text, 's', 0)).toBe('property');
  });

  it('tokenizes a whole statement left to right', () => {
    expect(line('tsql', 'SELECT o.id FROM orders o')).toEqual([
      'SELECT:keyword',
      'o:type',
      '.:delimiter',
      'id:property',
      'FROM:keyword',
      'orders:type',
      'o:type',
    ]);
  });

  it('keeps the table state across a line break', () => {
    expect(sql('SELECT *\nFROM\n  orders\n  o\nWHERE a = 1', 'orders')).toBe('type');
    expect(sql('SELECT *\nFROM\n  orders\n  o\nWHERE a = 1', 'o', 1)).toBe('type');
  });
});

describe('editor themes on Monaco', () => {
  /** The color Monaco paints a word with, read from the colorized HTML and its token stylesheet. */
  async function colorOf(language: Language, text: string, word: string): Promise<string | null> {
    const html = await monaco.editor.colorize(text, language, {});
    const span = new RegExp(`<span class="(mtk\\d+)[^"]*">${word}</span>`).exec(html);
    if (span?.[1] === undefined) {
      throw new Error(`no span for ${word} in ${html}`);
    }
    const css = Array.from(document.querySelectorAll('style'))
      .map((style) => style.textContent ?? '')
      .join('\n');
    const rule = new RegExp(`\\.${span[1]}\\s*\\{[^}]*?color:\\s*(#[0-9a-fA-F]+)`).exec(css);
    return rule?.[1]?.toLowerCase() ?? null;
  }

  it('paints names in the dark theme', async () => {
    const { defineEditorThemes } = await import('../kit/code/editor-theme');
    defineEditorThemes(monaco);
    monaco.editor.setTheme('mongo-gui-dark');
    const text = 'db.orders.find({ status: 1 })';
    expect(await colorOf('mongosh', text, 'status')).toBe('#d0d0cd');
    expect(await colorOf('mongosh', text, 'orders')).toBe('#ab79ed');
    expect(await colorOf('mongosh', text, 'find')).toBe('#a9c7fb');
    // A plain identifier is not painted with the property color.
    expect(await colorOf('mongosh', 'g(plain)', 'plain')).not.toBe('#d0d0cd');
  });

  it('paints names in the light theme', async () => {
    const { defineEditorThemes } = await import('../kit/code/editor-theme');
    defineEditorThemes(monaco);
    monaco.editor.setTheme('mongo-gui-light');
    const text = 'SELECT status FROM orders';
    expect(await colorOf('tsql', text, 'status')).toBe('#001080');
    expect(await colorOf('tsql', text, 'orders')).toBe('#267f99');
  });
});
