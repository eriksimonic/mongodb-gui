/**
 * Hostile and odd input through `translateSql`: SQL text in, mongosh text or an error out. Each
 * case asserts what a careful SQL Server user expects under the contract in the design spec.
 * Where the spec is silent the case says, in a comment, which output lets MongoDB return the same
 * rows as SQL Server.
 */
import { describe, expect, it } from 'vitest';
import {
  translateSql,
  translateSqlStatement,
  type SqlTranslationResult,
  type TranslateOptions,
} from './index';

/** Translates text that holds one statement and returns its mongosh text. Fails the test otherwise. */
function run(sql: string, options?: TranslateOptions): string {
  const results = translateSql(sql, options);
  expect(results).toHaveLength(1);
  const [result] = results;
  if (!result || !result.ok) {
    throw new Error(`expected a translation but got ${JSON.stringify(result)}`);
  }
  return result.translation.mongosh;
}

/** Translates text that holds one statement and returns the whole result. */
function one(sql: string, options?: TranslateOptions): SqlTranslationResult {
  const results = translateSql(sql, options);
  expect(results).toHaveLength(1);
  return results[0] as SqlTranslationResult;
}

/** Translates text that holds one failing statement and returns the message and the span text. */
function fail(sql: string, options?: TranslateOptions): { message: string; at: string } {
  const results = translateSql(sql, options);
  expect(results).toHaveLength(1);
  const [result] = results;
  if (!result || result.ok) {
    throw new Error(`expected an error but got ${JSON.stringify(result)}`);
  }
  return {
    message: result.error.message,
    at: sql.slice(result.error.span.start, result.error.span.end),
  };
}

function pipeline(access: string, stages: readonly string[]): string {
  return `${access}.aggregate([\n${stages.map((stage) => `  ${stage}`).join(',\n')}\n])`;
}

const OID = '507f1f77bcf86cd799439011';

describe('hostile identifiers', () => {
  it('accepts keywords as bracketed column names in a find', () => {
    expect(run('SELECT [order], [from], [select] FROM t WHERE [where] = 1')).toBe(
      'db.t.find({ where: 1 }, { _id: 0, order: 1, from: 1, select: 1 })',
    );
  });

  it('accepts a bracketed keyword as a group key and sort key', () => {
    expect(run('SELECT [group], COUNT(*) AS n FROM t GROUP BY [group] ORDER BY [group]')).toBe(
      pipeline('db.t', [
        "{ $group: { _id: '$group', n: { $sum: 1 } } }",
        "{ $project: { _id: 0, group: '$_id', n: 1 } }",
        '{ $sort: { group: 1 } }',
      ]),
    );
  });

  it('accepts a bracketed keyword as the alias in alias = expression form', () => {
    expect(run('SELECT [order] = a FROM t')).toBe(
      pipeline('db.t', ["{ $project: { _id: 0, order: '$a' } }"]),
    );
  });

  it('quotes identifiers with spaces and dashes and uses getCollection for the table', () => {
    expect(run('SELECT [Order Id], [Ship-To] FROM [My Orders]')).toBe(
      "db.getCollection('My Orders').find({}, { _id: 0, 'Order Id': 1, 'Ship-To': 1 })",
    );
  });

  it('unescapes ]] inside brackets and "" inside double quotes', () => {
    expect(run('SELECT [a]]b] FROM t')).toBe("db.t.find({}, { _id: 0, 'a]b': 1 })");
    expect(run('SELECT "Order Id", "say ""hi""" FROM t')).toBe(
      "db.t.find({}, { _id: 0, 'Order Id': 1, 'say \"hi\"': 1 })",
    );
  });

  it('keeps a semicolon, a line comment and a block comment inside brackets as name text', () => {
    expect(run('SELECT [a;b], [a--b], [a/*b*/] FROM t')).toBe(
      "db.t.find({}, { _id: 0, 'a;b': 1, 'a--b': 1, 'a/*b*/': 1 })",
    );
  });

  it('refuses a dot inside one bracketed part', () => {
    expect(fail('SELECT [a.b] FROM t')).toEqual({
      message: 'column name part a.b may not contain a dot',
      at: '[a.b]',
    });
  });

  it('refuses a column name that starts with a dollar sign', () => {
    expect(fail('SELECT [$set] FROM t')).toEqual({
      message: 'column name $set may not start with $',
      at: '[$set]',
    });
  });

  it('refuses a bare dollar sign in an identifier, which the tokenizer has no use for', () => {
    expect(fail('SELECT a$b FROM t')).toEqual({ message: "unexpected character '$'", at: '$' });
  });

  it('keeps a dollar sign in the middle of a bracketed column name', () => {
    expect(run('SELECT [a$b] FROM t')).toBe('db.t.find({}, { _id: 0, a$b: 1 })');
  });

  it('reaches a collection whose name has a dot or shadows a Database member', () => {
    expect(run('SELECT * FROM [system.users]')).toBe("db.getCollection('system.users').find({})");
    expect(run('SELECT * FROM [stats]')).toBe("db.getCollection('stats').find({})");
    expect(run('SELECT * FROM version WHERE n = 1')).toBe(
      "db.getCollection('version').find({ n: 1 })",
    );
    expect(run('SELECT * FROM [_hidden]')).toBe("db.getCollection('_hidden').find({})");
  });

  it('passes unicode names and strings through, quoting the non-ASCII keys', () => {
    expect(run("SELECT naïve, 名前 FROM clientes WHERE ciudad = 'Zürich' AND emoji = '😀'")).toBe(
      "db.clientes.find({ ciudad: 'Zürich', emoji: '😀' }, { _id: 0, 'naïve': 1, '名前': 1 })",
    );
    expect(run('SELECT * FROM Käufe')).toBe("db.getCollection('Käufe').find({})");
  });

  it('keeps _id in the projection without adding _id: 0', () => {
    expect(run('SELECT [_id], name FROM t')).toBe('db.t.find({}, { _id: 1, name: 1 })');
  });

  it('refuses an empty bracketed identifier', () => {
    // SQL Server rejects `[]` with a syntax error. The spec is silent; an empty field name is
    // not a usable projection key, so refusing is the only output that cannot mislead.
    expect(one('SELECT [] FROM t').ok).toBe(false);
  });

  it('tells the user to bracket a keyword used as a name', () => {
    expect(fail('SELECT order FROM t')).toEqual({
      message: 'keyword ORDER cannot be used as a name, write [order]',
      at: 'order',
    });
  });

  it('treats a double-quoted value as an identifier, as QUOTED_IDENTIFIER ON does', () => {
    expect(run('SELECT * FROM t WHERE a = "abc"')).toBe(
      "db.t.find({ $expr: { $eq: ['$a', '$abc'] } })",
    );
  });

  it('quotes a tab inside a bracketed name', () => {
    expect(run('SELECT [a\tb] FROM t')).toBe("db.t.find({}, { _id: 0, 'a\\tb': 1 })");
  });
});

describe('empty text, comments and statement splitting', () => {
  it('yields no results for empty text, whitespace, comments, semicolons and lone GO', () => {
    expect(translateSql('')).toEqual([]);
    expect(translateSql('   \n\t  ')).toEqual([]);
    expect(translateSql('-- only a comment\n/* and a block */')).toEqual([]);
    expect(translateSql(';;;')).toEqual([]);
    expect(translateSql('GO\nGO\n')).toEqual([]);
  });

  it('reports an empty statement from translateSqlStatement', () => {
    expect(translateSqlStatement('')).toEqual({
      ok: false,
      span: { start: 0, end: 0 },
      error: { message: 'the statement is empty', span: { start: 0, end: 0 } },
    });
    const commentOnly = translateSqlStatement('/* nothing */');
    expect(commentOnly.ok).toBe(false);
    if (!commentOnly.ok) {
      expect(commentOnly.error.message).toBe('the statement is empty');
    }
  });

  it('does not split on a GO inside a string', () => {
    expect(run("SELECT * FROM t WHERE note = 'line1\nGO\nline2'")).toBe(
      "db.t.find({ note: 'line1\\nGO\\nline2' })",
    );
  });

  it('does not split on a semicolon inside a string', () => {
    const results = translateSql("SELECT * FROM t WHERE a = 'x;y'; SELECT * FROM u");
    expect(
      results.map((result) => (result.ok ? result.translation.mongosh : result.error)),
    ).toEqual(["db.t.find({ a: 'x;y' })", 'db.u.find({})']);
  });

  it('does not split on a semicolon or GO inside a comment', () => {
    expect(run('SELECT * FROM t -- ; not a split\nWHERE a = 1')).toBe('db.t.find({ a: 1 })');
    expect(run('SELECT * FROM t /* ; */ WHERE a = 1')).toBe('db.t.find({ a: 1 })');
    expect(run('SELECT * FROM t /*\nGO\n*/ WHERE a = 1')).toBe('db.t.find({ a: 1 })');
  });

  it('treats a GO that shares its line with the statement as a stray word', () => {
    expect(fail('SELECT * FROM t WHERE a = 1 GO')).toEqual({
      message: "unexpected 'GO' after the statement",
      at: 'GO',
    });
  });

  it('splits on GO with Windows line endings, lower case and trailing spaces', () => {
    const windows = translateSql('SELECT * FROM t\r\nGO\r\nSELECT * FROM u\r\n');
    expect(windows).toHaveLength(2);
    expect(windows[1]?.ok && windows[1].translation.sql).toBe('SELECT * FROM u');
    const lower = translateSql('SELECT * FROM t\ngo   \nSELECT * FROM u');
    expect(lower.map((result) => result.ok && result.translation.mongosh)).toEqual([
      'db.t.find({})',
      'db.u.find({})',
    ]);
  });

  it('skips a nested block comment the way SQL Server does', () => {
    expect(run('/* outer /* inner */ still a comment */ SELECT * FROM t')).toBe('db.t.find({})');
  });

  it('refuses several statements in translateSqlStatement and points at the second', () => {
    const text = 'SELECT * FROM t; SELECT * FROM u';
    const result = translateSqlStatement(text);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe('expected one statement but found several');
      expect(text.slice(result.error.span.start, result.error.span.end)).toBe('SELECT * FROM u');
    }
  });

  it('points at the opening character of unterminated input', () => {
    expect(fail("SELECT * FROM t WHERE a = 'abc")).toEqual({
      message: 'unterminated string',
      at: "'",
    });
    expect(fail("SELECT * FROM t WHERE a = N'abc")).toEqual({
      message: 'unterminated string',
      at: "N'",
    });
    expect(fail('SELECT [abc FROM t')).toEqual({
      message: 'unterminated bracketed identifier',
      at: '[',
    });
    expect(fail('SELECT "abc FROM t')).toEqual({
      message: 'unterminated quoted identifier',
      at: '"',
    });
    expect(fail('SELECT * FROM t /* abc')).toEqual({
      message: 'unterminated block comment',
      at: '/*',
    });
  });

  it('names a character the grammar has no use for', () => {
    expect(fail('SELECT * FROM t WHERE a = 1 # 2')).toEqual({
      message: "unexpected character '#'",
      at: '#',
    });
    expect(fail('SELECT * FROM `t`')).toEqual({ message: "unexpected character '`'", at: '`' });
  });

  it('keeps translating after a failing statement', () => {
    const text = 'SELECT * FROM t WHERE a = @p; SELECT * FROM u';
    const [first, second] = translateSql(text);
    expect(first?.ok).toBe(false);
    if (first && !first.ok) {
      expect(first.error.message).toBe('parameters are not supported');
      expect(text.slice(first.error.span.start, first.error.span.end)).toBe('@p');
    }
    expect(second?.ok && second.translation.mongosh).toBe('db.u.find({})');
  });

  it('drops the SQL comment from nothing but keeps the statement text as written', () => {
    const result = one('SELECT *\n  FROM t -- trailing');
    expect(result.ok && result.translation.sql).toBe('SELECT *\n  FROM t -- trailing');
  });
});

describe('strings, dollars and LIKE patterns', () => {
  it('escapes backslashes in a string, which SQL does not treat as escapes', () => {
    expect(run("SELECT * FROM t WHERE path = 'C:\\temp\\new'")).toBe(
      "db.t.find({ path: 'C:\\\\temp\\\\new' })",
    );
  });

  it('escapes a newline, a tab, a control character and a line separator in a string', () => {
    expect(run("SELECT * FROM t WHERE note = 'a\nb\tc'")).toBe("db.t.find({ note: 'a\\nb\\tc' })");
    expect(run("SELECT * FROM t WHERE note = 'a\u0001b\u2028c'")).toBe(
      "db.t.find({ note: 'a\\u0001b\\u2028c' })",
    );
  });

  it('keeps a string that starts with a dollar sign plain in a query filter', () => {
    expect(run("SELECT * FROM t WHERE code = '$foo'")).toBe("db.t.find({ code: '$foo' })");
    expect(run("SELECT * FROM t WHERE code IN ('$a', '$b')")).toBe(
      "db.t.find({ code: { $in: ['$a', '$b'] } })",
    );
  });

  it('wraps a string that starts with a dollar sign in $literal inside a pipeline', () => {
    expect(run("SELECT name + '$' AS s FROM t")).toBe(
      pipeline('db.t', ["{ $project: { _id: 0, s: { $concat: ['$name', { $literal: '$' }] } } }"]),
    );
    expect(run("SELECT '$x' AS s FROM t")).toBe(
      pipeline('db.t', ["{ $project: { _id: 0, s: { $literal: '$x' } } }"]),
    );
    expect(run("SELECT * FROM t WHERE UPPER(a) = '$X'")).toBe(
      "db.t.find({ $expr: { $eq: [{ $toUpper: '$a' }, { $literal: '$X' }] } })",
    );
  });

  it('keeps a dollar string plain in insertMany and a constant $set, wrapped in a pipeline $set', () => {
    expect(run("INSERT INTO t (a) VALUES ('$5')")).toBe("db.t.insertMany([{ a: '$5' }])");
    expect(run("UPDATE t SET a = '$5' WHERE id = 1")).toBe(
      "db.t.updateMany({ id: 1 }, { $set: { a: '$5' } })",
    );
    expect(run("UPDATE t SET a = '$5', b = b + 1 WHERE id = 1")).toBe(
      "db.t.updateMany({ id: 1 }, [{ $set: { a: { $literal: '$5' }, b: { $add: ['$b', 1] } } }])",
    );
  });

  it('treats the N prefix in either case as a plain string with doubled quotes unescaped', () => {
    expect(run("SELECT * FROM t WHERE name = N'Zoë'")).toBe("db.t.find({ name: 'Zoë' })");
    expect(run("SELECT * FROM t WHERE name = n'it''s'")).toBe("db.t.find({ name: 'it\\'s' })");
  });

  it('keeps a doubled quote inside a LIKE pattern as one quote', () => {
    expect(run("SELECT * FROM t WHERE name LIKE '%O''Brien%'")).toBe(
      "db.t.find({ name: /O'Brien/i })",
    );
  });

  it('escapes a backslash in a LIKE pattern that has no ESCAPE clause', () => {
    expect(run("SELECT * FROM t WHERE path LIKE 'C:\\%'")).toBe('db.t.find({ path: /^C:\\\\/i })');
  });

  it('drops the trailing .*$ after an escaped backslash too', () => {
    // The spec says a trailing `.*$` is dropped. `a\%` has a literal backslash then a wildcard,
    // so the regex is `^a\\` with no end anchor.
    expect(run("SELECT * FROM t WHERE s LIKE 'a\\%'")).toBe('db.t.find({ s: /^a\\\\/i })');
  });

  it('makes the ESCAPE character turn a wildcard into a literal', () => {
    expect(run("SELECT * FROM t WHERE pct LIKE '100\\%' ESCAPE '\\'")).toBe(
      'db.t.find({ pct: /^100%$/i })',
    );
    expect(run("SELECT * FROM t WHERE s NOT LIKE '50!_%' ESCAPE '!'")).toBe(
      'db.t.find({ s: { $not: /^50_/i } })',
    );
  });

  it('escapes a slash in a LIKE pattern so the regex literal stays valid', () => {
    expect(run("SELECT * FROM t WHERE path LIKE '%/usr/%'")).toBe(
      'db.t.find({ path: /\\/usr\\//i })',
    );
  });

  it('passes character classes through and escapes every other regex metacharacter', () => {
    expect(run("SELECT * FROM t WHERE code LIKE '[A-C]_[^0-9]%'")).toBe(
      'db.t.find({ code: /^[A-C].[^0-9]/i })',
    );
    expect(run("SELECT * FROM t WHERE s LIKE 'a.b+c*d?e(f)|g{h}^i$'")).toBe(
      'db.t.find({ s: /^a\\.b\\+c\\*d\\?e\\(f\\)\\|g\\{h\\}\\^i\\$$/i })',
    );
    expect(run("SELECT * FROM t WHERE s LIKE 'a[b'")).toBe('db.t.find({ s: /^a\\[b$/i })');
  });

  it('handles a bare wildcard, an empty pattern and inner wildcards', () => {
    expect(run("SELECT * FROM t WHERE s LIKE '%'")).toBe('db.t.find({ s: /.*/i })');
    expect(run("SELECT * FROM t WHERE s LIKE ''")).toBe('db.t.find({ s: /^$/i })');
    expect(run("SELECT * FROM t WHERE s LIKE 'x%y%'")).toBe('db.t.find({ s: /^x.*y/i })');
  });

  it('escapes a newline inside a LIKE pattern', () => {
    expect(run("SELECT * FROM t WHERE s LIKE 'a\nb'")).toBe('db.t.find({ s: /^a\\nb$/i })');
  });

  it('refuses a LIKE pattern that is not a string literal', () => {
    expect(fail('SELECT * FROM t WHERE a LIKE b')).toEqual({
      message: 'LIKE pattern must be a string literal',
      at: 'b',
    });
    expect(fail("SELECT * FROM t WHERE a LIKE 'x' + '%'")).toEqual({
      message: 'LIKE pattern must be a string literal',
      at: "'x' + '%'",
    });
  });
});

describe('numbers', () => {
  it('folds a negative literal on either side of the comparison', () => {
    expect(run('SELECT * FROM t WHERE x = -5')).toBe('db.t.find({ x: -5 })');
    expect(run('SELECT * FROM t WHERE -5 = x')).toBe('db.t.find({ x: -5 })');
    expect(run('SELECT * FROM t WHERE 5 < x')).toBe('db.t.find({ x: { $gt: 5 } })');
  });

  it('parses exponents, a leading dot and a huge number', () => {
    expect(run('SELECT * FROM t WHERE x > -1.5e3 AND y = .5 AND z = 1e21 AND w = 1.')).toBe(
      'db.t.find({ x: { $gt: -1500 }, y: 0.5, z: 1e+21, w: 1 })',
    );
  });

  it('reads a double minus as a line comment, as SQL Server does', () => {
    expect(fail('SELECT * FROM t WHERE x = --5')).toEqual({
      message: 'expected an expression but the statement ended',
      at: '=',
    });
  });

  it('folds parenthesised, doubled and unary plus signs', () => {
    expect(run('SELECT * FROM t WHERE x = -(5)')).toBe('db.t.find({ x: -5 })');
    expect(run('SELECT * FROM t WHERE x = - - 5')).toBe('db.t.find({ x: 5 })');
    expect(run('SELECT * FROM t WHERE x = +5')).toBe('db.t.find({ x: 5 })');
  });

  it('negates a column with $multiply', () => {
    expect(run('SELECT * FROM t WHERE x = -y')).toBe(
      "db.t.find({ $expr: { $eq: ['$x', { $multiply: [-1, '$y'] }] } })",
    );
  });

  it('refuses a hex literal rather than reading it as zero', () => {
    expect(fail('SELECT * FROM t WHERE x = 0x1F')).toEqual({
      message: "unexpected 'x1F' after the statement",
      at: 'x1F',
    });
  });

  it('keeps negative, decimal and exponent numbers in an IN list', () => {
    expect(run('SELECT * FROM t WHERE x IN (-1, 2.50, 3e0)')).toBe(
      'db.t.find({ x: { $in: [-1, 2.5, 3] } })',
    );
  });

  it('handles an IN list with a thousand values', () => {
    const values = Array.from({ length: 1000 }, (_, index) => index + 1);
    expect(run(`SELECT * FROM t WHERE x IN (${values.join(', ')})`)).toBe(
      `db.t.find({ x: { $in: [${values.join(', ')}] } })`,
    );
  });

  it('refuses a fractional or negative TOP', () => {
    expect(fail('SELECT TOP 1.5 * FROM t')).toEqual({
      message: "expected a whole number after TOP but found '1.5'",
      at: '1.5',
    });
    expect(fail('SELECT TOP -1 * FROM t')).toEqual({
      message: "expected a whole number after TOP but found '-'",
      at: '-',
    });
  });

  it('refuses TOP 0 because limit(0) in mongosh means no limit', () => {
    // SQL Server returns no rows for TOP 0. `.limit(0)` returns every row, the opposite, so the
    // only safe translation is a refusal.
    expect(one('SELECT TOP 0 * FROM t').ok).toBe(false);
  });
});

describe('CAST and CONVERT', () => {
  it('accepts and ignores a CONVERT style', () => {
    expect(run("SELECT * FROM t WHERE d >= CONVERT(DATETIME, '2026-01-02T00:00:00Z', 120)")).toBe(
      "db.t.find({ d: { $gte: ISODate('2026-01-02T00:00:00.000Z') } })",
    );
    expect(run('SELECT CONVERT(VARCHAR(10), total, 101) AS s FROM t')).toBe(
      pipeline('db.t', ["{ $project: { _id: 0, s: { $toString: '$total' } } }"]),
    );
  });

  it('casts a string literal to every type', () => {
    const sql = [
      "UPDATE t SET a = CAST('42' AS INT), b = CAST(' 42 ' AS BIGINT), c = CAST('4.25' AS FLOAT),",
      "d = CAST('4.25' AS DECIMAL(10, 2)), e = CAST('true' AS BIT),",
      "f = CAST('2026-01-02T10:30:00Z' AS DATETIME), g = CAST('2026-01-02' AS DATE),",
      `h = CAST('abc' AS NVARCHAR(MAX)), i = CAST('${OID}' AS OBJECTID) WHERE id = 1`,
    ].join(' ');
    expect(run(sql)).toBe(
      'db.t.updateMany({ id: 1 }, { $set: { a: 42, b: 42, c: 4.25, d: 4.25, e: true, ' +
        "f: ISODate('2026-01-02T10:30:00.000Z'), g: ISODate('2026-01-02T00:00:00.000Z'), " +
        `h: 'abc', i: ObjectId('${OID}') } })`,
    );
  });

  it('casts a number literal to every numeric, bit and string type', () => {
    const sql =
      'UPDATE t SET a = CAST(4.7 AS INT), b = CAST(-4.7 AS BIGINT), c = CAST(3 AS FLOAT), ' +
      'd = CAST(3 AS MONEY), e = CAST(2 AS BIT), f = CAST(0 AS BIT), g = CAST(42 AS VARCHAR(10)), ' +
      'h = CAST(1.5 AS NVARCHAR) WHERE id = 1';
    expect(run(sql)).toBe(
      "db.t.updateMany({ id: 1 }, { $set: { a: 4, b: -4, c: 3, d: 3, e: true, f: false, g: '42', h: '1.5' } })",
    );
  });

  it('casts a number to DATETIME as days since 1900-01-01, as SQL Server does', () => {
    // The spec only covers string literals. SQL Server reads CAST(0 AS DATETIME) as 1900-01-01,
    // so that is the date MongoDB needs to match the same rows.
    expect(run('UPDATE t SET d = CAST(0 AS DATETIME) WHERE id = 1')).toBe(
      "db.t.updateMany({ id: 1 }, { $set: { d: ISODate('1900-01-01T00:00:00.000Z') } })",
    );
  });

  it('refuses a number cast to OBJECTID', () => {
    expect(fail('UPDATE t SET a = CAST(42 AS OBJECTID) WHERE id = 1')).toEqual({
      message: 'not a valid ObjectId: expected 24 hex characters',
      at: 'CAST(42 AS OBJECTID)',
    });
  });

  it('casts NULL to every type as null', () => {
    const sql =
      'UPDATE t SET a = CAST(NULL AS INT), b = CAST(NULL AS DATE), c = CAST(NULL AS VARCHAR(10)), ' +
      'd = CAST(NULL AS BIT), e = CAST(NULL AS OBJECTID) WHERE id = 1';
    expect(run(sql)).toBe(
      'db.t.updateMany({ id: 1 }, { $set: { a: null, b: null, c: null, d: null, e: null } })',
    );
  });

  it('casts the boolean extension literals to numbers and bits', () => {
    expect(
      run(
        'UPDATE t SET a = CAST(TRUE AS INT), b = CAST(FALSE AS BIT), c = CAST(TRUE AS FLOAT) WHERE id = 1',
      ),
    ).toBe('db.t.updateMany({ id: 1 }, { $set: { a: 1, b: false, c: 1 } })');
    expect(fail('UPDATE t SET a = CAST(TRUE AS DATE) WHERE id = 1')).toEqual({
      message: 'not a valid date',
      at: 'CAST(TRUE AS DATE)',
    });
  });

  it('refuses a string that is not a number or a bit', () => {
    expect(fail("UPDATE t SET a = CAST('abc' AS INT) WHERE id = 1")).toEqual({
      message: 'not a valid number',
      at: "CAST('abc' AS INT)",
    });
    expect(fail("UPDATE t SET a = CAST('yes' AS BIT) WHERE id = 1")).toEqual({
      message: 'not a valid bit',
      at: "CAST('yes' AS BIT)",
    });
  });

  it('refuses a fractional string cast to INT, as SQL Server and $toInt both do', () => {
    // SQL Server: "Conversion failed when converting the varchar value '4.7' to data type int".
    // $toInt of '4.7' fails at run time too. Truncating silently to 4 matches neither.
    expect(one("UPDATE t SET a = CAST('4.7' AS INT) WHERE id = 1").ok).toBe(false);
  });

  it('casts an exponent string to FLOAT', () => {
    expect(run("UPDATE t SET a = CAST('1e3' AS FLOAT) WHERE id = 1")).toBe(
      'db.t.updateMany({ id: 1 }, { $set: { a: 1000 } })',
    );
  });

  it('refuses invalid dates, including a day that does not exist', () => {
    expect(fail("SELECT * FROM t WHERE d = CAST('2026-13-45' AS DATE)")).toEqual({
      message: "'2026-13-45' is not a valid date",
      at: "CAST('2026-13-45' AS DATE)",
    });
    expect(fail("SELECT * FROM t WHERE d = CAST('not a date' AS DATETIME)")).toEqual({
      message: "'not a date' is not a valid date",
      at: "CAST('not a date' AS DATETIME)",
    });
    // SQL Server refuses February 30. V8 rolls it over to March 2, which silently matches the
    // wrong rows, so the spec's "must be valid" has to mean the calendar date, not Date.parse.
    expect(one("SELECT * FROM t WHERE d = CAST('2026-02-30' AS DATE)").ok).toBe(false);
  });

  it("refuses SQL Server's compact yyyymmdd form because Date.parse does not read it", () => {
    // The spec parses with new Date(text). A SQL Server user might expect '20260102' to work;
    // this case documents that it does not and that the error names the text.
    expect(fail("SELECT * FROM t WHERE d = CAST('20260102' AS DATE)")).toEqual({
      message: "'20260102' is not a valid date",
      at: "CAST('20260102' AS DATE)",
    });
  });

  it('reads a wall-clock datetime as UTC, the same on every machine', () => {
    // The spec says new Date(text), which reads a text without a zone suffix as local time, so
    // the ISODate would depend on the machine's timezone. A SQL Server datetime has no zone, so
    // the translator reads the text as UTC and the expectation is fixed.
    expect(run("SELECT * FROM t WHERE d = CAST('2026-01-02 10:30:00' AS DATETIME)")).toBe(
      "db.t.find({ d: ISODate('2026-01-02T10:30:00.000Z') })",
    );
  });

  it('refuses a type the translator does not know', () => {
    expect(fail('SELECT * FROM t WHERE CAST(a AS UNIQUEIDENTIFIER) = 1')).toEqual({
      message: "type 'UNIQUEIDENTIFIER' is not supported",
      at: 'UNIQUEIDENTIFIER',
    });
    expect(fail('SELECT CONVERT(XML, a) AS x FROM t')).toEqual({
      message: "type 'XML' is not supported",
      at: 'XML',
    });
  });

  it('accepts only 24 hex characters as an ObjectId', () => {
    const short = '0123456789abcdef0123456';
    const long = '0123456789abcdef012345678';
    const upper = 'ABCDEF0123456789ABCDEF01';
    const bad = '0123456789abcdef0123456g';
    expect(fail(`SELECT * FROM t WHERE _id = CAST('${short}' AS OBJECTID)`)).toEqual({
      message: 'not a valid ObjectId: expected 24 hex characters',
      at: `CAST('${short}' AS OBJECTID)`,
    });
    expect(fail(`SELECT * FROM t WHERE _id = CAST('${long}' AS OBJECTID)`).message).toBe(
      'not a valid ObjectId: expected 24 hex characters',
    );
    expect(fail(`SELECT * FROM t WHERE _id = CAST('${bad}' AS OBJECTID)`).message).toBe(
      'not a valid ObjectId: expected 24 hex characters',
    );
    expect(run(`SELECT * FROM t WHERE _id = CAST('${upper}' AS OBJECTID)`)).toBe(
      `db.t.find({ _id: ObjectId('${upper}') })`,
    );
  });

  it('casts a column with the $to operators and GETDATE() as a constant', () => {
    expect(run('SELECT * FROM t WHERE CAST(total AS INT) > 5')).toBe(
      "db.t.find({ $expr: { $gt: [{ $toInt: '$total' }, 5] } })",
    );
    expect(run('SELECT * FROM t WHERE d < CAST(GETDATE() AS DATE)')).toBe(
      'db.t.find({ d: { $lt: new Date() } })',
    );
    expect(run('SELECT CAST(a AS BIGINT) AS big, CAST(b AS BIT) AS flag FROM t')).toBe(
      pipeline('db.t', [
        "{ $project: { _id: 0, big: { $toLong: '$a' }, flag: { $toBool: '$b' } } }",
      ]),
    );
  });

  it('folds a nested cast of a literal', () => {
    expect(run("SELECT * FROM t WHERE a = CAST(CAST('42' AS VARCHAR) AS INT)")).toBe(
      'db.t.find({ a: 42 })',
    );
  });

  it('refuses CONVERT without a value', () => {
    expect(fail('SELECT CONVERT(INT) AS x FROM t')).toEqual({
      message: "expected ',' but found ')'",
      at: ')',
    });
  });
});

describe('DATEDIFF and DATEADD', () => {
  it('maps every datepart spelling to a $dateDiff unit', () => {
    const sql =
      'SELECT DATEDIFF(day, a, b) AS d, DATEDIFF(hh, a, b) AS h, DATEDIFF(mi, a, b) AS mi, ' +
      'DATEDIFF(n, a, b) AS n2, DATEDIFF(ss, a, b) AS s, DATEDIFF(ms, a, b) AS ms, ' +
      'DATEDIFF(MONTH, a, b) AS m, DATEDIFF(yyyy, a, b) AS y, DATEDIFF(wk, a, b) AS w, ' +
      'DATEDIFF(qq, a, b) AS q FROM t';
    const diff = (unit: string): string =>
      `{ $dateDiff: { startDate: '$a', endDate: '$b', unit: '${unit}' } }`;
    expect(run(sql)).toBe(
      pipeline('db.t', [
        `{ $project: { _id: 0, d: ${diff('day')}, h: ${diff('hour')}, mi: ${diff('minute')}, ` +
          `n2: ${diff('minute')}, s: ${diff('second')}, ms: ${diff('millisecond')}, ` +
          `m: ${diff('month')}, y: ${diff('year')}, w: ${diff('week')}, q: ${diff('quarter')} } }`,
      ]),
    );
  });

  it('refuses an unknown datepart and a wrong arity', () => {
    expect(fail('SELECT DATEDIFF(fortnight, a, b) AS d FROM t')).toEqual({
      message:
        'DATEDIFF unit must be year, quarter, month, week, day, hour, minute, second or millisecond',
      at: 'fortnight',
    });
    expect(fail('SELECT DATEDIFF(day, a) AS d FROM t')).toEqual({
      message: 'DATEDIFF takes 3 arguments',
      at: 'DATEDIFF(day, a)',
    });
  });

  it('uses $$NOW for GETDATE() inside a date function', () => {
    expect(run('SELECT DATEDIFF(day, createdAt, GETDATE()) AS age FROM t')).toBe(
      pipeline('db.t', [
        "{ $project: { _id: 0, age: { $dateDiff: { startDate: '$createdAt', endDate: '$$NOW', unit: 'day' } } } }",
      ]),
    );
    expect(run('SELECT * FROM t WHERE createdAt > DATEADD(day, -7, GETDATE())')).toBe(
      "db.t.find({ $expr: { $gt: ['$createdAt', { $dateAdd: { startDate: '$$NOW', unit: 'day', amount: -7 } }] } })",
    );
  });

  it('coerces a date string literal given to DATEDIFF, as SQL Server converts it implicitly', () => {
    // The spec is silent. $dateDiff rejects a string at run time, and SQL Server converts the
    // literal to datetime, so MongoDB needs an ISODate to compute the same result.
    expect(run("SELECT DATEDIFF(day, '2026-01-01', b) AS d FROM t")).toBe(
      pipeline('db.t', [
        "{ $project: { _id: 0, d: { $dateDiff: { startDate: ISODate('2026-01-01T00:00:00.000Z'), endDate: '$b', unit: 'day' } } } }",
      ]),
    );
  });
});

describe('type hints that agree and disagree with the literal', () => {
  const types: Record<string, 'date' | 'objectId' | 'number' | 'string' | 'bool'> = {
    createdAt: 'date',
    _id: 'objectId',
    customerId: 'objectId',
    qty: 'number',
    active: 'bool',
    first: 'string',
  };
  const hints: TranslateOptions = { fieldType: (_collection, path) => types[path] };

  it('coerces numeric text for a number field and leaves other text alone', () => {
    expect(run("SELECT * FROM t WHERE qty = '12'", hints)).toBe('db.t.find({ qty: 12 })');
    expect(run("SELECT * FROM t WHERE qty = '1e3'", hints)).toBe('db.t.find({ qty: 1000 })');
    expect(run("SELECT * FROM t WHERE qty = 'abc'", hints)).toBe("db.t.find({ qty: 'abc' })");
  });

  it('coerces true, false, 1 and 0 for a bool field and leaves other values alone', () => {
    expect(run('SELECT * FROM t WHERE active = 1 AND deleted = 1', hints)).toBe(
      'db.t.find({ active: true, deleted: 1 })',
    );
    expect(run("SELECT * FROM t WHERE active = 'false' OR active = 0", hints)).toBe(
      'db.t.find({ $or: [{ active: false }, { active: false }] })',
    );
    expect(run("SELECT * FROM t WHERE active = 'yes'", hints)).toBe("db.t.find({ active: 'yes' })");
  });

  it('refuses unparseable text for a date field and leaves a number alone', () => {
    expect(fail("SELECT * FROM t WHERE createdAt > 'yesterday'", hints)).toEqual({
      message: "'yesterday' is not a valid date",
      at: "'yesterday'",
    });
    expect(run('SELECT * FROM t WHERE createdAt > 5', hints)).toBe(
      'db.t.find({ createdAt: { $gt: 5 } })',
    );
  });

  it('coerces only a 24 hex string for an objectId field', () => {
    expect(run(`SELECT * FROM t WHERE _id = '${OID}'`, hints)).toBe(
      `db.t.find({ _id: ObjectId('${OID}') })`,
    );
    expect(run("SELECT * FROM t WHERE _id = '0123456789abcdef0123456'", hints)).toBe(
      "db.t.find({ _id: '0123456789abcdef0123456' })",
    );
    expect(run("SELECT * FROM t WHERE _id = '0123456789abcdef012345678'", hints)).toBe(
      "db.t.find({ _id: '0123456789abcdef012345678' })",
    );
    expect(run(`SELECT * FROM t WHERE _id IN ('${OID}', 'bad')`, hints)).toBe(
      `db.t.find({ _id: { $in: [ObjectId('${OID}'), 'bad'] } })`,
    );
  });

  it('applies the date hint in IN and BETWEEN', () => {
    expect(
      run("SELECT * FROM t WHERE createdAt BETWEEN '2026-01-01' AND '2026-02-01'", hints),
    ).toBe(
      "db.t.find({ createdAt: { $gte: ISODate('2026-01-01T00:00:00.000Z'), $lte: ISODate('2026-02-01T00:00:00.000Z') } })",
    );
    expect(run("SELECT * FROM t WHERE createdAt IN ('2026-01-01', '2026-01-02')", hints)).toBe(
      "db.t.find({ createdAt: { $in: [ISODate('2026-01-01T00:00:00.000Z'), ISODate('2026-01-02T00:00:00.000Z')] } })",
    );
  });

  it('applies the hints to INSERT values and UPDATE SET values', () => {
    expect(
      run(
        `INSERT INTO t (createdAt, _id, qty, active) VALUES ('2026-01-01', '${OID}', '7', 'true')`,
        hints,
      ),
    ).toBe(
      `db.t.insertMany([{ createdAt: ISODate('2026-01-01T00:00:00.000Z'), _id: ObjectId('${OID}'), qty: 7, active: true }])`,
    );
    expect(run(`UPDATE t SET createdAt = '2026-01-01' WHERE _id = '${OID}'`, hints)).toBe(
      `db.t.updateMany({ _id: ObjectId('${OID}') }, { $set: { createdAt: ISODate('2026-01-01T00:00:00.000Z') } })`,
    );
  });

  it('looks up a joined column relative to its own collection', () => {
    const options: TranslateOptions = {
      fieldType: (collection, path) =>
        collection === 'customers' && path === '_id' ? 'objectId' : undefined,
    };
    expect(
      run(
        `SELECT o.id, c.name FROM orders o JOIN customers c ON o.customerId = c._id WHERE c._id = '${OID}'`,
        options,
      ),
    ).toBe(
      pipeline('db.orders', [
        "{ $lookup: { from: 'customers', localField: 'customerId', foreignField: '_id', as: 'c' } }",
        "{ $unwind: '$c' }",
        `{ $match: { 'c._id': ObjectId('${OID}') } }`,
        "{ $project: { _id: 0, id: 1, name: '$c.name' } }",
      ]),
    );
  });

  it('turns + into $concat for a string literal or a string hint, else $add', () => {
    expect(run("SELECT first + ' ' + last AS fullName FROM t")).toBe(
      pipeline('db.t', [
        "{ $project: { _id: 0, fullName: { $concat: ['$first', ' ', '$last'] } } }",
      ]),
    );
    expect(run('SELECT first + last AS fullName FROM t', hints)).toBe(
      pipeline('db.t', ["{ $project: { _id: 0, fullName: { $concat: ['$first', '$last'] } } }"]),
    );
    expect(run('SELECT qty + bonus AS total FROM t', hints)).toBe(
      pipeline('db.t', ["{ $project: { _id: 0, total: { $add: ['$qty', '$bonus'] } } }"]),
    );
  });

  it('lets an explicit string CAST override a date hint', () => {
    // The user asked for text, so the comparison stays a string comparison.
    expect(run("SELECT * FROM t WHERE createdAt = CAST('2026-01-01' AS VARCHAR)", hints)).toBe(
      "db.t.find({ createdAt: '2026-01-01' })",
    );
  });
});

describe('INSERT', () => {
  it('refuses a row with too few or too many values and points at the row', () => {
    expect(fail('INSERT INTO t (a, b) VALUES (1)')).toEqual({
      message: 'INSERT row has 1 values for 2 columns',
      at: '1',
    });
    expect(fail('INSERT INTO t (a, b) VALUES (1, 2, 3)')).toEqual({
      message: 'INSERT row has 3 values for 2 columns',
      at: '1, 2, 3',
    });
    expect(fail('INSERT INTO t (a, b) VALUES (1, 2), (3)')).toEqual({
      message: 'INSERT row has 1 values for 2 columns',
      at: '3',
    });
  });

  it('builds nested objects from dotted column names', () => {
    expect(run("INSERT INTO t (name, address.city, address.zip) VALUES ('A', 'B', 'C')")).toBe(
      "db.t.insertMany([{ name: 'A', address: { city: 'B', zip: 'C' } }])",
    );
    expect(run('INSERT INTO t (a.b.c, a.b.d, a.e) VALUES (1, 2, 3)')).toBe(
      'db.t.insertMany([{ a: { b: { c: 1, d: 2 }, e: 3 } }])',
    );
  });

  it('refuses a column that overlaps a nested column, in either order', () => {
    expect(fail("INSERT INTO t (address, address.city) VALUES ('x', 'y')")).toEqual({
      message: 'INSERT column address.city overlaps another column',
      at: 'address.city',
    });
    // SQL Server has no nested columns, but a value that silently replaces an object another
    // column just built loses data, so this order must be refused too.
    expect(one("INSERT INTO t (address.city, address) VALUES ('y', 'x')").ok).toBe(false);
  });

  it('refuses a column listed twice, as SQL Server does', () => {
    // SQL Server: "Column name 'a' specified more than once". Silently keeping the last value
    // hides the mistake.
    expect(one('INSERT INTO t (a, a) VALUES (1, 2)').ok).toBe(false);
  });

  it('drops the table qualifier and quotes a bracketed column', () => {
    expect(run('INSERT INTO t (t.a, [b c]) VALUES (1, 2)')).toBe(
      "db.t.insertMany([{ a: 1, 'b c': 2 }])",
    );
  });

  it('accepts every literal kind, GETDATE() and a CAST of a literal', () => {
    expect(
      run(
        "INSERT INTO t (a, b, c, d, e, f, g) VALUES (-1, NULL, GETDATE(), CAST('2026-01-01' AS DATE), N'x', TRUE, 1e3)",
      ),
    ).toBe(
      "db.t.insertMany([{ a: -1, b: null, c: new Date(), d: ISODate('2026-01-01T00:00:00.000Z'), e: 'x', f: true, g: 1000 }])",
    );
  });

  it('refuses an expression, a function call and a column as a value', () => {
    expect(fail('INSERT INTO t (a) VALUES (1 + 1)')).toEqual({
      message: 'INSERT values must be literals',
      at: '1 + 1',
    });
    expect(fail("INSERT INTO t (a) VALUES (UPPER('x'))")).toEqual({
      message: 'INSERT values must be literals',
      at: "UPPER('x')",
    });
    expect(fail('INSERT INTO t (a) VALUES (b)')).toEqual({
      message: 'INSERT values must be literals',
      at: 'b',
    });
  });

  it('refuses a missing column list and an empty row', () => {
    expect(fail('INSERT INTO t VALUES (1)')).toEqual({
      message: 'INSERT needs a column list before VALUES',
      at: 'VALUES',
    });
    expect(fail('INSERT INTO t (a) VALUES ()')).toEqual({
      message: "expected an expression but found ')'",
      at: ')',
    });
  });

  it('inserts several rows with an empty string and a zero', () => {
    expect(run("INSERT INTO t (a, b) VALUES ('', 0), ('x', -0.5)")).toBe(
      "db.t.insertMany([{ a: '', b: 0 }, { a: 'x', b: -0.5 }])",
    );
  });
});

describe('UPDATE', () => {
  it('uses a pipeline update when a value is an expression', () => {
    expect(run('UPDATE t SET a = a + 1 WHERE id = 1')).toBe(
      "db.t.updateMany({ id: 1 }, [{ $set: { a: { $add: ['$a', 1] } } }])",
    );
  });

  it('keeps constants and NULL plain inside a pipeline update', () => {
    expect(run("UPDATE t SET a = a + 1, b = 'x', c = NULL WHERE id = 1")).toBe(
      "db.t.updateMany({ id: 1 }, [{ $set: { a: { $add: ['$a', 1] }, b: 'x', c: null } }])",
    );
  });

  it('sets a column to NULL with a plain $set and flags the missing WHERE as unsafe', () => {
    const result = one('UPDATE t SET a = NULL');
    expect(result.ok && result.translation.mongosh).toBe(
      'db.t.updateMany({}, { $set: { a: null } })',
    );
    expect(result.ok && result.translation.statement.unsafe).toBe(true);
    expect(result.ok && result.translation.statement.kind).toBe('write');
  });

  it('translates string concatenation, negation and GETDATE() in one pipeline', () => {
    expect(run("UPDATE t SET name = name + ' (old)', n = -n, u = GETDATE() WHERE id = 1")).toBe(
      "db.t.updateMany({ id: 1 }, [{ $set: { name: { $concat: ['$name', ' (old)'] }, n: { $multiply: [-1, '$n'] }, u: new Date() } }])",
    );
  });

  it('sets a nested path and a bracketed keyword, dropping the table qualifier', () => {
    expect(run("UPDATE t SET address.city = 'X', [order] = 2 WHERE t.id = 1")).toBe(
      "db.t.updateMany({ id: 1 }, { $set: { 'address.city': 'X', order: 2 } })",
    );
  });

  it('translates CASE and ISNULL in SET and a literal comparison in WHERE', () => {
    expect(run("UPDATE t SET a = CASE WHEN a > 1 THEN 'big' ELSE 'small' END WHERE 1 = 1")).toBe(
      "db.t.updateMany({ $expr: { $eq: [1, 1] } }, [{ $set: { a: { $switch: { branches: [{ case: { $gt: ['$a', 1] }, then: 'big' }], default: 'small' } } } }])",
    );
    expect(run('UPDATE t SET a = ISNULL(a, 0) + 1 WHERE id = 1')).toBe(
      "db.t.updateMany({ id: 1 }, [{ $set: { a: { $add: [{ $ifNull: ['$a', 0] }, 1] } } }])",
    );
  });

  it('refuses an aggregate, a subquery and TOP in UPDATE', () => {
    expect(fail('UPDATE t SET a = COUNT(*) WHERE id = 1')).toEqual({
      message: 'aggregate functions need GROUP BY',
      at: 'COUNT(*)',
    });
    expect(fail('UPDATE t SET a = (SELECT 1) WHERE id = 1')).toEqual({
      message: 'subqueries are not supported',
      at: '(SELECT 1)',
    });
    expect(fail('UPDATE TOP (10) t SET a = 1')).toEqual({
      message: 'UPDATE with TOP is not supported',
      at: 'TOP',
    });
  });
});

describe('TRUNCATE', () => {
  it('becomes an unsafe deleteMany with an empty filter', () => {
    const result = one('TRUNCATE TABLE t');
    expect(result.ok && result.translation.mongosh).toBe('db.t.deleteMany({})');
    expect(result.ok && result.translation.statement.unsafe).toBe(true);
    expect(result.ok && result.translation.statement.kind).toBe('write');
  });

  it('drops the dbo prefix and quotes a bracketed table, in any keyword case', () => {
    expect(run('TRUNCATE TABLE dbo.[My Table]')).toBe(
      "db.getCollection('My Table').deleteMany({})",
    );
    expect(run('truncate table t')).toBe('db.t.deleteMany({})');
  });

  it('refuses a missing TABLE keyword and a WHERE clause', () => {
    expect(fail('TRUNCATE t')).toEqual({ message: "expected TABLE but found 't'", at: 't' });
    expect(fail('TRUNCATE TABLE t WHERE a = 1')).toEqual({
      message: "unexpected 'WHERE' after the statement",
      at: 'WHERE',
    });
  });
});

describe('refused constructs and their spans', () => {
  const cases: readonly [sql: string, message: string, at: string][] = [
    ['SELECT TOP 10 PERCENT * FROM t', 'TOP ... PERCENT is not supported', 'PERCENT'],
    ['SELECT TOP 5 WITH TIES * FROM t ORDER BY a', 'WITH TIES is not supported', 'WITH TIES'],
    ['SELECT * FROM a RIGHT JOIN b ON a.x = b.y', 'RIGHT JOIN is not supported', 'RIGHT JOIN'],
    [
      'SELECT * FROM a RIGHT OUTER JOIN b ON a.x = b.y',
      'RIGHT JOIN is not supported',
      'RIGHT OUTER JOIN',
    ],
    ['SELECT * FROM a FULL JOIN b ON a.x = b.y', 'FULL JOIN is not supported', 'FULL JOIN'],
    ['SELECT * FROM a CROSS JOIN b', 'CROSS JOIN is not supported', 'CROSS JOIN'],
    ['SELECT * FROM a CROSS APPLY b', 'CROSS APPLY is not supported', 'CROSS APPLY'],
    ['SELECT * FROM a OUTER APPLY b', 'OUTER APPLY is not supported', 'OUTER APPLY'],
    ['SELECT * FROM a UNION SELECT * FROM b', 'UNION is not supported', 'UNION'],
    ['SELECT * FROM a UNION ALL SELECT * FROM b', 'UNION is not supported', 'UNION'],
    ['SELECT * FROM a EXCEPT SELECT * FROM b', 'EXCEPT is not supported', 'EXCEPT'],
    ['SELECT * FROM a INTERSECT SELECT * FROM b', 'INTERSECT is not supported', 'INTERSECT'],
    [
      'WITH cte AS (SELECT 1 AS x FROM t) SELECT * FROM cte',
      'WITH (common table expressions) is not supported',
      'WITH',
    ],
    ['SELECT * FROM (SELECT * FROM t) x', 'subqueries are not supported', '(SELECT * FROM t)'],
    [
      'SELECT * FROM t WHERE id IN (SELECT id FROM u)',
      'subqueries are not supported',
      '(SELECT id FROM u)',
    ],
    ['SELECT (SELECT 1) AS one FROM t', 'subqueries are not supported', '(SELECT 1)'],
    [
      'SELECT * FROM t WHERE a = (SELECT MAX(a) FROM t)',
      'subqueries are not supported',
      '(SELECT MAX(a) FROM t)',
    ],
    ['INSERT INTO t (a) SELECT a FROM u', 'INSERT ... SELECT is not supported', 'SELECT'],
    ['INSERT INTO t SELECT * FROM u', 'INSERT ... SELECT is not supported', 'SELECT'],
    ['UPDATE t SET a = 1 FROM t JOIN u ON t.id = u.id', 'UPDATE ... FROM is not supported', 'FROM'],
    ['DELETE TOP (10) FROM t', 'DELETE with TOP is not supported', 'TOP'],
    ['DELETE t FROM t JOIN u ON t.a = u.b', 'DELETE with JOIN is not supported', 'FROM'],
    ['DELETE FROM t JOIN u ON t.a = u.b', 'DELETE with JOIN is not supported', 'JOIN'],
    ['SELECT * FROM t WHERE EXISTS (SELECT 1 FROM u)', 'EXISTS is not supported', 'EXISTS'],
    [
      'SELECT ROW_NUMBER() OVER (ORDER BY a) AS n FROM t',
      'window functions (OVER) are not supported',
      'OVER',
    ],
    ['SELECT a, COUNT(*) FROM t GROUP BY ROLLUP(a)', 'GROUP BY ROLLUP is not supported', 'ROLLUP'],
    [
      'SELECT a, COUNT(*) FROM t GROUP BY a WITH ROLLUP',
      'GROUP BY ROLLUP is not supported',
      'ROLLUP',
    ],
    ['SELECT a, COUNT(*) FROM t GROUP BY CUBE(a)', 'GROUP BY CUBE is not supported', 'CUBE'],
    [
      'SELECT a, COUNT(*) FROM t GROUP BY GROUPING SETS (a)',
      'GROUP BY GROUPING SETS is not supported',
      'GROUPING SETS',
    ],
    [
      'SELECT * FROM t WITH (NOLOCK)',
      'table hints such as WITH (NOLOCK) are not supported',
      'WITH (NOLOCK)',
    ],
    ['SELECT * FROM t WHERE a = @p', 'parameters are not supported', '@p'],
    ['SELECT * FROM t WHERE a = @@ROWCOUNT', 'parameters are not supported', '@@ROWCOUNT'],
    ['SELECT TOP @n * FROM t', 'parameters are not supported', '@n'],
    ['DECLARE @x INT', 'DECLARE is not supported', 'DECLARE'],
    ['SELECT * INTO u FROM t', 'SELECT ... INTO is not supported', 'INTO'],
    ['SELECT * FROM t, u', 'comma joins are not supported, use JOIN ... ON', ','],
    [
      'SELECT * FROM other.dbo.t',
      "table prefix 'other.dbo' is not supported, only dbo. is accepted",
      'other.dbo.t',
    ],
    ['SELECT SUM(DISTINCT a) AS s FROM t', 'SUM(DISTINCT) is not supported', 'SUM(DISTINCT a)'],
    ['SELECT FOO(1) AS x FROM t', 'function FOO is not supported', 'FOO(1)'],
    [
      'SELECT * FROM t ORDER BY a + 1',
      'ORDER BY must name a column, a select alias or an aggregate',
      'a + 1',
    ],
    ['SELECT * FROM t WHERE a IN ()', 'IN needs at least one value', '()'],
    [
      'SELECT * FROM t WHERE a NOT = 1',
      "expected IN, BETWEEN or LIKE after NOT but found '='",
      '=',
    ],
    ['SELECT * FROM t WHERE d < CURRENT_TIMESTAMP()', "unexpected '(' after the statement", '('],
    ['SELECT * FROM t WHERE d < GETDATE(1)', 'GETDATE takes 0 arguments', 'GETDATE(1)'],
    ['SELECT a b c FROM t', "expected FROM but found 'c'", 'c'],
    [
      'SELECT * FROM t WHERE a = 1 GROUP BY',
      'expected an expression but the statement ended',
      'BY',
    ],
    [
      'SELECT COUNT(*) AS n FROM t WHERE COUNT(*) > 1',
      'aggregate functions need GROUP BY',
      'COUNT(*)',
    ],
  ];

  it.each(cases)('%s', (sql, message, at) => {
    expect(fail(sql)).toEqual({ message, at });
  });

  it.each([
    'CREATE TABLE t (a INT)',
    'DROP TABLE t',
    'ALTER TABLE t ADD b INT',
    'EXEC sp_who',
    'MERGE INTO t USING u ON t.id = u.id WHEN MATCHED THEN DELETE',
    'SET NOCOUNT ON',
    'USE master',
    'BEGIN TRANSACTION',
    "PRINT 'hi'",
  ])('refuses the statement keyword of %s', (sql) => {
    const first = sql.split(' ')[0] as string;
    expect(fail(sql)).toEqual({
      message: 'Only SELECT, UPDATE, DELETE, INSERT and TRUNCATE statements are supported',
      at: first,
    });
  });
});

describe('odd but valid shapes', () => {
  it('wraps a number literal in a select list with $literal so $project does not read it as inclusion', () => {
    // `{ $project: { one: 1 } }` includes a field named one; it does not output the number 1.
    // SQL Server returns the constant on every row, so MongoDB needs `{ $literal: 1 }`.
    expect(run('SELECT 1 AS one, name FROM t')).toBe(
      pipeline('db.t', ['{ $project: { _id: 0, one: { $literal: 1 }, name: 1 } }']),
    );
  });

  it('compares two literals and two columns with $expr', () => {
    expect(run('SELECT * FROM t WHERE 1 = 1')).toBe('db.t.find({ $expr: { $eq: [1, 1] } })');
    expect(run('SELECT * FROM t WHERE a = b')).toBe("db.t.find({ $expr: { $eq: ['$a', '$b'] } })");
  });

  it('negates with $nor for equality and $not on an operator object', () => {
    expect(run('SELECT * FROM t WHERE NOT a = 1')).toBe('db.t.find({ $nor: [{ a: 1 }] })');
    expect(run('SELECT * FROM t WHERE NOT a > 1')).toBe('db.t.find({ a: { $not: { $gt: 1 } } })');
    expect(run('SELECT * FROM t WHERE NOT (a = 1 AND b = 2)')).toBe(
      'db.t.find({ $nor: [{ a: 1, b: 2 }] })',
    );
    expect(run('SELECT * FROM t WHERE NOT NOT a = 1')).toBe(
      'db.t.find({ $nor: [{ $nor: [{ a: 1 }] }] })',
    );
    expect(run("SELECT * FROM t WHERE NOT a LIKE 'x%'")).toBe('db.t.find({ a: { $not: /^x/i } })');
  });

  it('keeps AND conjuncts on the same key in $and and respects AND over OR precedence', () => {
    expect(run('SELECT * FROM t WHERE a > 1 AND a < 5')).toBe(
      'db.t.find({ $and: [{ a: { $gt: 1 } }, { a: { $lt: 5 } }] })',
    );
    expect(run('SELECT * FROM t WHERE a = 1 OR b = 2 AND c = 3')).toBe(
      'db.t.find({ $or: [{ a: 1 }, { b: 2, c: 3 }] })',
    );
  });

  it('ignores keyword case and deep parentheses', () => {
    expect(run('sElEcT * fRoM t wHeRe a Is NoT nUlL')).toBe('db.t.find({ a: { $ne: null } })');
    expect(run('SELECT * FROM t WHERE ((((a = 1))))')).toBe('db.t.find({ a: 1 })');
  });

  it('groups DISTINCT on a bracketed keyword', () => {
    expect(run('SELECT DISTINCT [order] FROM t')).toBe(
      pipeline('db.t', [
        "{ $group: { _id: { order: '$order' } } }",
        "{ $project: { _id: 0, order: '$_id.order' } }",
      ]),
    );
  });

  it('accepts CURRENT_TIMESTAMP without parentheses as a constant', () => {
    expect(run('SELECT * FROM t WHERE d < CURRENT_TIMESTAMP')).toBe(
      'db.t.find({ d: { $lt: new Date() } })',
    );
  });

  it('mixes literal kinds in one IN list', () => {
    // NULL is dropped: `a = NULL` is never true in SQL Server, while `$in` with null would also
    // return rows where a is null or missing.
    expect(run("SELECT * FROM t WHERE a IN (1, 'two', NULL, TRUE)")).toBe(
      "db.t.find({ a: { $in: [1, 'two', true] } })",
    );
    expect(run('SELECT * FROM t WHERE a IN (1, b)')).toBe(
      "db.t.find({ $expr: { $in: ['$a', [1, '$b']] } })",
    );
  });

  it('keeps reversed BETWEEN bounds as written, which matches nothing in both systems', () => {
    expect(run('SELECT * FROM t WHERE a BETWEEN 10 AND 1')).toBe(
      'db.t.find({ a: { $gte: 10, $lte: 1 } })',
    );
  });
});
