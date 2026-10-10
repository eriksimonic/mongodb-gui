/**
 * Round two of hostile and odd input through `translateSql`: SQL text in, mongosh text or an error
 * out. Each case asserts what a careful SQL Server user expects under the design contract. Where
 * the contract is silent the case says, in a comment, which output lets MongoDB return the same
 * rows as SQL Server. The round one file `break-hostile-input.test.ts` is left as it is.
 */
import { describe, expect, it } from 'vitest';
import { translateSql, translateSqlStatement, type TranslateOptions } from './index';

/** Translates text that holds one statement and returns its mongosh text. Fails otherwise. */
function run(sql: string, options?: TranslateOptions): string {
  const results = translateSql(sql, options);
  expect(results).toHaveLength(1);
  const [result] = results;
  if (!result || !result.ok) {
    throw new Error(`expected a translation but got ${JSON.stringify(result)}`);
  }
  return result.translation.mongosh;
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

const hints =
  (table: Record<string, Record<string, 'date' | 'objectId' | 'number' | 'string' | 'bool'>>) =>
  (collection: string, path: string) =>
    table[collection]?.[path];

describe('identifiers that look like something else', () => {
  it('reads bracketed GROUP, BY and ORDER as columns of a table named order', () => {
    expect(run('SELECT [group], [by] FROM [order] WHERE [order].[group] = 1 ORDER BY [by]')).toBe(
      'db.order.find({ group: 1 }, { _id: 0, group: 1, by: 1 }).sort({ by: 1 })',
    );
  });

  // The contract says the table name wins over a field of the same name, so a bare column that
  // equals the table name is read as the qualifier with nothing after it.
  it('refuses a bare column whose name is the table name', () => {
    expect(fail('SELECT * FROM [order] WHERE [order] = 1')).toEqual({
      message: 'order is a table alias, not a column',
      at: '[order]',
    });
  });

  it('quotes a column with spaces everywhere it appears', () => {
    expect(run('SELECT [Order Id] FROM t WHERE [Order Id] > 5 ORDER BY [Order Id] DESC')).toBe(
      "db.t.find({ 'Order Id': { $gt: 5 } }, { _id: 0, 'Order Id': 1 }).sort({ 'Order Id': -1 })",
    );
  });

  it('joins bracketed parts with a dot into a nested path', () => {
    expect(run("SELECT [address].[city] FROM t WHERE [address].[zip] = '1000'")).toBe(
      "db.t.find({ 'address.zip': '1000' }, { _id: 0, 'address.city': 1 })",
    );
  });

  it('refuses a double-quoted name with a dot inside one part', () => {
    expect(fail('SELECT "a.b" FROM t')).toEqual({
      message: 'column name part a.b may not contain a dot',
      at: '"a.b"',
    });
  });

  it('reaches a bracketed dbo table whose name has a space through getCollection', () => {
    expect(run('SELECT * FROM [dbo].[Order Items]')).toBe(
      "db.getCollection('Order Items').find({})",
    );
  });

  it('refuses a schema prefix other than dbo and a three-part name, pointing at the whole name', () => {
    expect(fail('SELECT * FROM sales.orders')).toEqual({
      message: "table prefix 'sales' is not supported, only dbo. is accepted",
      at: 'sales.orders',
    });
    expect(fail('SELECT * FROM shop.dbo.orders')).toEqual({
      message: "table prefix 'shop.dbo' is not supported, only dbo. is accepted",
      at: 'shop.dbo.orders',
    });
  });

  it('accepts bare unicode words as names and quotes the keys that are not ASCII', () => {
    expect(run("SELECT naïve, 名前 FROM 顧客 WHERE 名前 = N'テスト'")).toBe(
      "db.getCollection('顧客').find({ '名前': 'テスト' }, { _id: 0, 'naïve': 1, '名前': 1 })",
    );
  });

  it('keeps an astral character in a string whole', () => {
    expect(run("SELECT * FROM t WHERE mood = '😀'")).toBe("db.t.find({ mood: '😀' })");
  });

  it('keeps a newline and the word GO inside a bracketed name as the name', () => {
    expect(run('SELECT [\nGO\n] FROM t')).toBe("db.t.find({}, { _id: 0, '\\nGO\\n': 1 })");
  });

  it('reads function names without parentheses as plain columns', () => {
    expect(run('SELECT year, month, count FROM t WHERE day = 1')).toBe(
      'db.t.find({ day: 1 }, { _id: 0, year: 1, month: 1, count: 1 })',
    );
  });

  it('renames to a bracketed keyword alias in both alias forms', () => {
    expect(run('SELECT a AS [from], b [order] FROM t')).toBe(
      pipeline('db.t', ["{ $project: { _id: 0, from: '$a', order: '$b' } }"]),
    );
  });

  it('refuses an unbracketed keyword as an alias', () => {
    expect(fail('SELECT a AS order FROM t')).toEqual({
      message: 'keyword ORDER cannot be used as a name, write [order]',
      at: 'order',
    });
  });

  it('accepts a table whose name starts with a dollar sign through getCollection', () => {
    expect(run('SELECT * FROM [$audit]')).toBe("db.getCollection('$audit').find({})");
  });
});

describe('statement boundaries', () => {
  it('keeps a semicolon inside a block comment inside a string', () => {
    expect(run("SELECT * FROM t WHERE a = '/* ; */'")).toBe("db.t.find({ a: '/* ; */' })");
  });

  it('splits at a semicolon between statements whose strings hold GO and semicolons', () => {
    const results = translateSql(
      "SELECT * FROM t WHERE note = 'a;b'; SELECT * FROM u WHERE note = 'x\nGO\ny'",
    );
    expect(
      results.map((result) => (result.ok ? result.translation.mongosh : result.error)),
    ).toEqual(["db.t.find({ note: 'a;b' })", "db.u.find({ note: 'x\\nGO\\ny' })"]);
  });

  // SSMS and sqlcmd accept a comment after GO on the same line, so the batch still ends there and
  // GO must not become the table alias.
  it('treats GO followed by a line comment as the batch separator', () => {
    expect(run('SELECT t.a FROM t\nGO -- run it')).toBe('db.t.find({}, { _id: 0, a: 1 })');
  });

  // GO 5 repeats the batch in sqlcmd. Repeating cannot be translated, so the statement must fail
  // somewhere on that line rather than parse GO as a table alias.
  it('refuses a GO with a repeat count', () => {
    const [result] = translateSql('SELECT * FROM t\nGO 5');
    expect(result?.ok).toBe(false);
    if (result && !result.ok) {
      expect(result.error.span.start).toBeGreaterThanOrEqual('SELECT * FROM t\n'.length);
    }
  });

  it('reports the whole text as empty when it holds only a block comment', () => {
    expect(translateSqlStatement('/* nothing\n here */')).toEqual({
      ok: false,
      span: { start: 0, end: 19 },
      error: { message: 'the statement is empty', span: { start: 0, end: 19 } },
    });
  });

  it('projects the string GO as a constant column', () => {
    expect(run("SELECT 'GO' AS word FROM t")).toBe(
      pipeline('db.t', ["{ $project: { _id: 0, word: 'GO' } }"]),
    );
  });
});

describe('strings', () => {
  it('compares with the empty string and with a lone quote', () => {
    expect(run("SELECT * FROM t WHERE name = '' OR q = ''''")).toBe(
      "db.t.find({ $or: [{ name: '' }, { q: '\\'' }] })",
    );
  });

  it('escapes a backslash that precedes a doubled quote', () => {
    expect(run("INSERT INTO t (s) VALUES ('\\''')")).toBe("db.t.insertMany([{ s: '\\\\\\'' }])");
  });

  it('keeps Windows line endings inside an inserted string', () => {
    expect(run("INSERT INTO t (note) VALUES ('line1\r\nline2')")).toBe(
      "db.t.insertMany([{ note: 'line1\\r\\nline2' }])",
    );
  });

  it('wraps a dollar string in $literal inside an $expr IN list', () => {
    expect(run("SELECT * FROM t WHERE UPPER(code) IN ('$A', 'B')")).toBe(
      "db.t.find({ $expr: { $in: [{ $toUpper: '$code' }, [{ $literal: '$A' }, 'B']] } })",
    );
  });

  it('reads = NULL as a null match, which is what the author meant', () => {
    // With ANSI_NULLS ON SQL Server returns no rows for = NULL; nobody writes it on purpose, and
    // the contract maps `column = literal` to a plain equality, so null it is.
    expect(run('SELECT * FROM t WHERE a = NULL')).toBe('db.t.find({ a: null })');
  });

  it('accepts the N prefix in lower case before a doubled quote', () => {
    expect(run("SELECT * FROM t WHERE s = n'it''s'")).toBe("db.t.find({ s: 'it\\'s' })");
  });
});

describe('LIKE patterns', () => {
  it('matches a literal dollar sign at the start', () => {
    expect(run("SELECT * FROM t WHERE price LIKE '$%'")).toBe('db.t.find({ price: /^\\$/i })');
  });

  it('keeps a backslash-escaped percent literal with ESCAPE', () => {
    expect(run("SELECT * FROM t WHERE s LIKE '100\\%' ESCAPE '\\'")).toBe(
      'db.t.find({ s: /^100%$/i })',
    );
  });

  it('keeps an escaped underscore literal with ESCAPE', () => {
    expect(run("SELECT * FROM t WHERE s LIKE 'a\\_b%' ESCAPE '\\'")).toBe(
      'db.t.find({ s: /^a_b/i })',
    );
  });

  it('passes a bracketed percent through as a class that matches the literal', () => {
    expect(run("SELECT * FROM t WHERE s LIKE '[%]'")).toBe('db.t.find({ s: /^[%]$/i })');
  });

  it('passes a negated class through', () => {
    expect(run("SELECT * FROM t WHERE s LIKE '[^0-9]%'")).toBe('db.t.find({ s: /^[^0-9]/i })');
  });

  it('escapes an unclosed bracket, which SQL Server matches literally', () => {
    expect(run("SELECT * FROM t WHERE s LIKE '[abc'")).toBe('db.t.find({ s: /^\\[abc$/i })');
  });

  // SQL Server's `[]]` matches a literal `]`. In a JavaScript regex `[]]` is an empty class, which
  // matches nothing, followed by `]`, so the bracket must be escaped for the same rows.
  it('turns the SQL Server class for a closing bracket into an escaped bracket', () => {
    expect(run("SELECT * FROM t WHERE s LIKE '[]]'")).toBe('db.t.find({ s: /^\\]$/i })');
  });

  it('escapes a dot in a pattern', () => {
    expect(run("SELECT * FROM t WHERE email LIKE '%.com'")).toBe(
      'db.t.find({ email: /\\.com$/i })',
    );
  });

  it('keeps NOT LIKE as $not in the $match of a pipeline', () => {
    expect(run("SELECT UPPER(name) AS n FROM t WHERE name NOT LIKE 'x%'")).toBe(
      pipeline('db.t', [
        '{ $match: { name: { $not: /^x/i } } }',
        "{ $project: { _id: 0, n: { $toUpper: '$name' } } }",
      ]),
    );
  });

  it('uses $regexMatch when the left side is an expression', () => {
    expect(run("SELECT * FROM t WHERE LOWER(name) LIKE 'a_c%'")).toBe(
      "db.t.find({ $expr: { $regexMatch: { input: { $toLower: '$name' }, regex: /^a.c/i } } })",
    );
  });

  it('matches a pattern that is only an escape character against that character', () => {
    expect(run("SELECT * FROM t WHERE s LIKE '!' ESCAPE '!'")).toBe('db.t.find({ s: /^!$/i })');
  });
});

describe('numbers', () => {
  it('reads a trailing dot and a leading dot with an exponent', () => {
    expect(run('SELECT * FROM t WHERE a = 1. AND b = .5e-3')).toBe(
      'db.t.find({ a: 1, b: 0.0005 })',
    );
  });

  it('folds a nested negation and a unary plus in a write', () => {
    expect(run('INSERT INTO t (a, b) VALUES (-(-1), +2)')).toBe(
      'db.t.insertMany([{ a: 1, b: 2 }])',
    );
  });

  it('keeps negative exponent bounds in BETWEEN', () => {
    expect(run('SELECT * FROM t WHERE a BETWEEN -1e2 AND 1e2')).toBe(
      'db.t.find({ a: { $gte: -100, $lte: 100 } })',
    );
  });

  it('refuses an exponent or a negative number after TOP and OFFSET', () => {
    expect(fail('SELECT TOP 1e1 * FROM t')).toEqual({
      message: "expected a whole number after TOP but found '1e1'",
      at: '1e1',
    });
    expect(fail('SELECT * FROM t ORDER BY a OFFSET -1 ROWS')).toEqual({
      message: "expected a whole number after OFFSET but found '-'",
      at: '-',
    });
  });

  it('refuses TOP together with OFFSET and FETCH, as SQL Server does', () => {
    expect(
      fail('SELECT TOP 5 * FROM t ORDER BY a OFFSET 10 ROWS FETCH NEXT 5 ROWS ONLY').message,
    ).toBe('TOP cannot be combined with OFFSET and FETCH');
  });

  // SQL Server refuses a literal that overflows float. mongosh would accept `Infinity` and store
  // it, matching nothing the user meant, so the translator should refuse it too.
  it('refuses a number literal that overflows to Infinity', () => {
    const [result] = translateSql('SELECT * FROM t WHERE a = 1e400');
    expect(result?.ok).toBe(false);
  });

  it('handles an IN list with 2500 strings', () => {
    const values = Array.from({ length: 2500 }, (_, i) => `'v${i}'`);
    const expected = Array.from({ length: 2500 }, (_, i) => `'v${i}'`);
    expect(run(`SELECT * FROM t WHERE k IN (${values.join(', ')})`)).toBe(
      `db.t.find({ k: { $in: [${expected.join(', ')}] } })`,
    );
  });

  // `x IN (1, NULL)` is `x = 1 OR x = NULL`, and `x = NULL` is never true, so SQL Server returns
  // only the rows with x = 1. `$in: [1, null]` would also return rows where x is null or missing.
  it('drops NULL from an IN list so null rows are not returned', () => {
    expect(run('SELECT * FROM t WHERE x IN (1, NULL)')).toBe('db.t.find({ x: { $in: [1] } })');
  });
});

describe('CAST and CONVERT', () => {
  it('truncates toward zero and folds the sign when casting numbers to INT and BIT', () => {
    expect(run('SELECT * FROM t WHERE a = CAST(-1.9 AS INT) AND b = CAST(-1 AS BIT)')).toBe(
      'db.t.find({ a: -1, b: true })',
    );
  });

  it('casts 1e3 and 2.5 to INT as 1000 and 2', () => {
    expect(run('INSERT INTO t (a, b) VALUES (CAST(1e3 AS INT), CAST(2.5 AS INT))')).toBe(
      'db.t.insertMany([{ a: 1000, b: 2 }])',
    );
  });

  it('trims padding and accepts a plus sign in a string cast to INT', () => {
    expect(run("INSERT INTO t (a, b) VALUES (CAST('  42  ' AS INT), CAST('+7' AS INT))")).toBe(
      'db.t.insertMany([{ a: 42, b: 7 }])',
    );
  });

  it('refuses a thousands separator, a hex prefix and an exponent in a string cast to INT', () => {
    for (const text of ["'1,000'", "'0x1F'", "'1e2'", "'TRUE'"]) {
      expect(fail(`SELECT * FROM t WHERE a = CAST(${text} AS INT)`)).toEqual({
        message: 'not a valid number',
        at: `CAST(${text} AS INT)`,
      });
    }
  });

  // SQL Server converts the empty string and a blank string to 0 for the integer types.
  it('casts an empty or blank string to INT as 0', () => {
    expect(run("INSERT INTO t (a, b) VALUES (CAST('' AS INT), CAST(' ' AS BIGINT))")).toBe(
      'db.t.insertMany([{ a: 0, b: 0 }])',
    );
  });

  it('casts padded TRUE in any case to BIT and refuses other words', () => {
    expect(run("INSERT INTO t (a, b) VALUES (CAST(' True ' AS BIT), CAST('0' AS BIT))")).toBe(
      'db.t.insertMany([{ a: true, b: false }])',
    );
    expect(fail("INSERT INTO t (a) VALUES (CAST('yes' AS BIT))")).toEqual({
      message: 'not a valid bit',
      at: "CAST('yes' AS BIT)",
    });
  });

  it('casts a fraction, a negative number and zero to BIT by whether they are nonzero', () => {
    expect(
      run('INSERT INTO t (a, b, c) VALUES (CAST(1.5 AS BIT), CAST(-3 AS BIT), CAST(0.0 AS BIT))'),
    ).toBe('db.t.insertMany([{ a: true, b: true, c: false }])');
  });

  it('casts booleans and a fraction to strings', () => {
    expect(
      run('INSERT INTO t (a, b) VALUES (CAST(TRUE AS VARCHAR), CAST(1.5 AS NVARCHAR(10)))'),
    ).toBe("db.t.insertMany([{ a: 'true', b: '1.5' }])");
  });

  it('refuses a boolean cast to DATE and a string cast to OBJECTID that is not hex', () => {
    expect(fail('SELECT * FROM t WHERE d = CAST(TRUE AS DATE)')).toEqual({
      message: 'not a valid date',
      at: 'CAST(TRUE AS DATE)',
    });
    expect(fail("SELECT * FROM t WHERE i = CAST('507f1f77bcf86cd79943901g' AS OBJECTID)")).toEqual({
      message: 'not a valid ObjectId: expected 24 hex characters',
      at: "CAST('507f1f77bcf86cd79943901g' AS OBJECTID)",
    });
  });

  it('accepts upper case hex and NULL for OBJECTID', () => {
    expect(
      run(
        `SELECT * FROM t WHERE i = CAST('${OID.toUpperCase()}' AS OBJECTID) OR j = CAST(NULL AS OBJECTID)`,
      ),
    ).toBe(`db.t.find({ $or: [{ i: ObjectId('${OID.toUpperCase()}') }, { j: null }] })`);
  });

  it('keeps an arithmetic operand of a cast as a $toInt expression', () => {
    expect(run('SELECT * FROM t WHERE x = CAST(0.1 + 0.2 AS INT)')).toBe(
      "db.t.find({ $expr: { $eq: ['$x', { $toInt: { $add: [0.1, 0.2] } }] } })",
    );
  });

  it('ignores a CONVERT style on a column and names the output expr_1', () => {
    expect(run('SELECT CONVERT(VARCHAR(10), createdAt, 120) FROM t')).toBe(
      pipeline('db.t', ["{ $project: { _id: 0, expr_1: { $toString: '$createdAt' } } }"]),
    );
  });

  it('refuses a fourth CONVERT argument', () => {
    expect(fail("SELECT CONVERT(INT, '1', 1, 2) FROM t")).toEqual({
      message: "expected ')' but found ','",
      at: ',',
    });
  });

  it('refuses a number converted to DATE and reads a negative number as a day before 1900', () => {
    expect(fail('SELECT * FROM t WHERE d = CONVERT(DATE, 45000)')).toEqual({
      message: 'a number cannot be cast to DATE, cast it to DATETIME',
      at: 'CONVERT(DATE, 45000)',
    });
    expect(run('SELECT * FROM t WHERE d = CONVERT(DATETIME, -1)')).toBe(
      "db.t.find({ d: ISODate('1899-12-31T00:00:00.000Z') })",
    );
  });
});

describe('dates', () => {
  it('accepts a leap day in a leap year and single-digit month and day', () => {
    expect(
      run("SELECT * FROM t WHERE d = CAST('2024-02-29' AS DATE) OR e = CAST('2026-1-5' AS DATE)"),
    ).toBe(
      "db.t.find({ $or: [{ d: ISODate('2024-02-29T00:00:00.000Z') }, { e: ISODate('2026-01-05T00:00:00.000Z') }] })",
    );
  });

  it('refuses month 13 and hour 24', () => {
    expect(fail("SELECT * FROM t WHERE d = CAST('2026-13-01' AS DATE)")).toEqual({
      message: "'2026-13-01' is not a valid date",
      at: "CAST('2026-13-01' AS DATE)",
    });
    expect(fail("SELECT * FROM t WHERE d = CAST('2026-01-01 24:00' AS DATETIME)")).toEqual({
      message: "'2026-01-01 24:00' is not a valid date",
      at: "CAST('2026-01-01 24:00' AS DATETIME)",
    });
  });

  it('applies positive and negative offsets', () => {
    expect(
      run(
        "SELECT * FROM t WHERE a = CAST('2026-01-01T10:00:00+02:00' AS DATETIME) AND b = CAST('2026-01-01 10:00:00-05:00' AS DATETIMEOFFSET)",
      ),
    ).toBe(
      "db.t.find({ a: ISODate('2026-01-01T08:00:00.000Z'), b: ISODate('2026-01-01T15:00:00.000Z') })",
    );
  });

  it('keeps the first three fraction digits of a DATETIME2', () => {
    expect(run("SELECT * FROM t WHERE d = CAST('2026-01-01 10:30:00.1234567' AS DATETIME2)")).toBe(
      "db.t.find({ d: ISODate('2026-01-01T10:30:00.123Z') })",
    );
  });

  // SQL Server (us_english) reads 1/2/2026 as January 2 with no time zone. The output must not
  // shift with the machine's zone the way `new Date('1/2/2026')` does.
  it('reads a US date as midnight UTC on every machine', () => {
    expect(run("SELECT * FROM t WHERE d = CAST('1/2/2026' AS DATE)")).toBe(
      "db.t.find({ d: ISODate('2026-01-02T00:00:00.000Z') })",
    );
  });

  // CAST(... AS DATE) drops the time in SQL Server, so `createdAt < CAST('2026-01-05 13:00' AS DATE)`
  // excludes everything on the fifth. Keeping 13:00 would include half of that day.
  it('drops the time of day when casting to DATE', () => {
    expect(run("SELECT * FROM t WHERE d < CAST('2026-01-05 13:00' AS DATE)")).toBe(
      "db.t.find({ d: { $lt: ISODate('2026-01-05T00:00:00.000Z') } })",
    );
  });

  it('refuses the empty string as a date, per the contract', () => {
    // SQL Server reads '' as 1900-01-01, but the contract says the text must parse as a date.
    expect(fail("SELECT * FROM t WHERE d = CAST('' AS DATE)")).toEqual({
      message: "'' is not a valid date",
      at: "CAST('' AS DATE)",
    });
  });

  it('trims padding around a date', () => {
    expect(run("SELECT * FROM t WHERE d = CAST(' 2026-01-01 ' AS DATE)")).toBe(
      "db.t.find({ d: ISODate('2026-01-01T00:00:00.000Z') })",
    );
  });

  it('refuses dayofyear, which $dateDiff has no unit for', () => {
    expect(fail('SELECT DATEDIFF(dayofyear, a, b) AS n FROM t')).toEqual({
      message:
        'DATEDIFF unit must be year, quarter, month, week, day, hour, minute, second or millisecond',
      at: 'dayofyear',
    });
  });

  it('refuses an invalid date literal inside DATEDIFF', () => {
    expect(fail("SELECT DATEDIFF(day, 'soon', b) AS n FROM t")).toEqual({
      message: "'soon' is not a valid date",
      at: "'soon'",
    });
  });

  it('reads a bracketed column named day as the start date next to the unit day', () => {
    expect(run('SELECT DATEDIFF(day, [day], d) AS n FROM t')).toBe(
      pipeline('db.t', [
        "{ $project: { _id: 0, n: { $dateDiff: { startDate: '$day', endDate: '$d', unit: 'day' } } } }",
      ]),
    );
  });

  it('subtracts a week with a negative DATEADD amount from GETDATE()', () => {
    expect(run('SELECT * FROM t WHERE d > DATEADD(day, -7, GETDATE())')).toBe(
      "db.t.find({ $expr: { $gt: ['$d', { $dateAdd: { startDate: '$$NOW', unit: 'day', amount: -7 } }] } })",
    );
  });
});

describe('type hints', () => {
  const options: TranslateOptions = {
    fieldType: hints({
      t: { _id: 'objectId', code: 'string', n: 'number', seen: 'date', 'meta.seen': 'date' },
    }),
  };

  it('leaves a 24 hex string as a string when there is no hint', () => {
    expect(run(`SELECT * FROM t WHERE _id = '${OID}'`)).toBe(`db.t.find({ _id: '${OID}' })`);
  });

  it('coerces only the 24 hex members of an IN list for an objectId field', () => {
    expect(
      run(`SELECT * FROM t WHERE _id IN ('${OID}', '${OID.slice(1)}', '${OID}0')`, options),
    ).toBe(`db.t.find({ _id: { $in: [ObjectId('${OID}'), '${OID.slice(1)}', '${OID}0'] } })`);
  });

  it('leaves NULL alone for an objectId field', () => {
    expect(run('SELECT * FROM t WHERE _id = NULL', options)).toBe('db.t.find({ _id: null })');
  });

  // SQL Server converts the string column to int, so 42 matches '42'. MongoDB never matches the
  // number 42 against a string field, so the literal has to become the string.
  it('turns a number literal into a string for a string field', () => {
    expect(run('SELECT * FROM t WHERE code = 42', options)).toBe("db.t.find({ code: '42' })");
  });

  it('mixes a coerced and an uncoerced member in an IN list for a number field', () => {
    expect(run("SELECT * FROM t WHERE n IN ('1', 'two', '3.5')", options)).toBe(
      "db.t.find({ n: { $in: [1, 'two', 3.5] } })",
    );
  });

  it('coerces a nested insert value by its dotted path', () => {
    expect(run("INSERT INTO t (meta.seen, code) VALUES ('2026-01-01', 'x')", options)).toBe(
      "db.t.insertMany([{ meta: { seen: ISODate('2026-01-01T00:00:00.000Z') }, code: 'x' }])",
    );
  });

  it('leaves a number alone for a date field', () => {
    expect(run('SELECT * FROM t WHERE seen > 20260101', options)).toBe(
      'db.t.find({ seen: { $gt: 20260101 } })',
    );
  });

  it('refuses unparseable text for a date field in BETWEEN and points at the text', () => {
    expect(fail("SELECT * FROM t WHERE seen BETWEEN '2026-01-01' AND 'later'", options)).toEqual({
      message: "'later' is not a valid date",
      at: "'later'",
    });
  });
});

describe('INSERT', () => {
  it('points at the second row when only it is short', () => {
    expect(fail('INSERT INTO t (a, b) VALUES (1, 2), (3)')).toEqual({
      message: 'INSERT row has 1 values for 2 columns',
      at: '3',
    });
  });

  it('merges three dotted columns into one nested object', () => {
    expect(run("INSERT INTO t (a.b.c, a.b.d, a.e) VALUES (1, 'two', NULL)")).toBe(
      "db.t.insertMany([{ a: { b: { c: 1, d: 'two' }, e: null } }])",
    );
  });

  it('builds nested objects from bracketed parts', () => {
    expect(run("INSERT INTO t ([address].[city], [address].[zip]) VALUES ('x', '1')")).toBe(
      "db.t.insertMany([{ address: { city: 'x', zip: '1' } }])",
    );
  });

  it('accepts TRUE and CURRENT_TIMESTAMP without parentheses as values', () => {
    expect(run('INSERT INTO t (active, at) VALUES (TRUE, CURRENT_TIMESTAMP)')).toBe(
      'db.t.insertMany([{ active: true, at: new Date() }])',
    );
  });

  it('refuses a CAST of an expression, pointing at the whole CAST', () => {
    expect(fail('INSERT INTO t (a) VALUES (CAST(1 + 1 AS INT))')).toEqual({
      message: 'INSERT values must be literals',
      at: 'CAST(1 + 1 AS INT)',
    });
  });

  it('refuses a column reference as a value', () => {
    expect(fail('INSERT INTO t (a) VALUES (b)')).toEqual({
      message: 'INSERT values must be literals',
      at: 'b',
    });
  });
});

describe('UPDATE', () => {
  it('mixes an expression, NULL and a date function in one pipeline $set', () => {
    expect(run('UPDATE t SET a = a + 1, b = NULL, d = DATEADD(month, 1, d) WHERE id = 1')).toBe(
      "db.t.updateMany({ id: 1 }, [{ $set: { a: { $add: ['$a', 1] }, b: null, d: { $dateAdd: { startDate: '$d', unit: 'month', amount: 1 } } } }])",
    );
  });

  it('copies one column into another with a pipeline update', () => {
    expect(run('UPDATE t SET a = b')).toBe("db.t.updateMany({}, [{ $set: { a: '$b' } }])");
  });

  // SQL Server refuses a column assigned twice in one SET; silently keeping the last value would
  // hide a typo.
  it('refuses the same column assigned twice', () => {
    expect(translateSql('UPDATE t SET a = 1, a = 2')[0]?.ok).toBe(false);
  });

  // mongosh refuses `$set: { 'a.b': 1, a: 2 }` with a path conflict at run time; the translator
  // should say so before the statement runs.
  it('refuses a nested path set next to its parent', () => {
    expect(translateSql('UPDATE t SET a.b = 1, a = 2')[0]?.ok).toBe(false);
  });

  it('refuses a subquery and a parameter as a SET value', () => {
    expect(fail('UPDATE t SET a = (SELECT 1)')).toEqual({
      message: 'subqueries are not supported',
      at: '(SELECT 1)',
    });
    expect(fail('UPDATE t SET a = @p')).toEqual({
      message: 'parameters are not supported',
      at: '@p',
    });
  });

  it('refuses an OUTPUT clause', () => {
    expect(fail('UPDATE t SET a = 1 OUTPUT inserted.a')).toEqual({
      message: "unexpected 'OUTPUT' after the statement",
      at: 'OUTPUT',
    });
  });

  it('keeps an OR of an equality and IS NULL in the filter', () => {
    expect(run("UPDATE t SET a = 1 WHERE b = 'x' OR c IS NULL")).toBe(
      "db.t.updateMany({ $or: [{ b: 'x' }, { c: null }] }, { $set: { a: 1 } })",
    );
  });
});

describe('DELETE and TRUNCATE', () => {
  it('flags TRUNCATE of a bracketed table as an unsafe write', () => {
    const [result] = translateSql('truncate table [Audit Log]');
    expect(result?.ok).toBe(true);
    if (result?.ok) {
      expect(result.translation.mongosh).toBe("db.getCollection('Audit Log').deleteMany({})");
      expect(result.translation.statement.kind).toBe('write');
      expect(result.translation.statement.unsafe).toBe(true);
    }
  });

  it('turns a tautology WHERE into an $expr that matches every document', () => {
    expect(run('DELETE FROM t WHERE 1 = 1')).toBe('db.t.deleteMany({ $expr: { $eq: [1, 1] } })');
  });

  it('reports a WHERE without an expression at the WHERE keyword', () => {
    expect(fail('DELETE FROM t WHERE')).toEqual({
      message: 'expected an expression but the statement ended',
      at: 'WHERE',
    });
  });
});

describe('refused constructs and their spans', () => {
  const cases: readonly [sql: string, message: string, at: string][] = [
    [
      'SELECT * FROM t WITH (NOLOCK)',
      'table hints such as WITH (NOLOCK) are not supported',
      'WITH (NOLOCK)',
    ],
    ['SELECT * FROM t WHERE EXISTS (SELECT 1 FROM u)', 'EXISTS is not supported', 'EXISTS'],
    [
      'SELECT ROW_NUMBER() OVER (ORDER BY a) FROM t',
      'window functions (OVER) are not supported',
      'OVER',
    ],
    ['SELECT * FROM t UNION SELECT * FROM u', 'UNION is not supported', 'UNION'],
    ['SELECT * FROM t EXCEPT SELECT * FROM u', 'EXCEPT is not supported', 'EXCEPT'],
    [
      'WITH c AS (SELECT 1 AS x) SELECT * FROM c',
      'WITH (common table expressions) is not supported',
      'WITH',
    ],
    ['DECLARE @x INT', 'DECLARE is not supported', 'DECLARE'],
    ['SELECT * FROM t WHERE a = @x', 'parameters are not supported', '@x'],
    ['SELECT TOP 10 PERCENT * FROM t', 'TOP ... PERCENT is not supported', 'PERCENT'],
    ['SELECT TOP 5 WITH TIES * FROM t ORDER BY a', 'WITH TIES is not supported', 'WITH TIES'],
    ['SELECT * FROM a RIGHT JOIN b ON a.x = b.y', 'RIGHT JOIN is not supported', 'RIGHT JOIN'],
    [
      'SELECT * FROM a FULL OUTER JOIN b ON a.x = b.y',
      'FULL JOIN is not supported',
      'FULL OUTER JOIN',
    ],
    ['SELECT * FROM a CROSS JOIN b', 'CROSS JOIN is not supported', 'CROSS JOIN'],
    ['SELECT * FROM a CROSS APPLY f(a.x)', 'CROSS APPLY is not supported', 'CROSS APPLY'],
    ['SELECT * FROM a OUTER APPLY f(a.x)', 'OUTER APPLY is not supported', 'OUTER APPLY'],
    ['INSERT INTO t (a) SELECT a FROM u', 'INSERT ... SELECT is not supported', 'SELECT'],
    ['UPDATE t SET a = 1 FROM t JOIN u ON t.id = u.id', 'UPDATE ... FROM is not supported', 'FROM'],
    ['DELETE TOP (10) FROM t', 'DELETE with TOP is not supported', 'TOP'],
    ['DELETE t FROM t JOIN u ON t.id = u.id', 'DELETE with JOIN is not supported', 'FROM'],
    ['SELECT a, COUNT(*) FROM t GROUP BY ROLLUP(a)', 'GROUP BY ROLLUP is not supported', 'ROLLUP'],
    ['SELECT a, COUNT(*) FROM t GROUP BY a WITH CUBE', 'GROUP BY CUBE is not supported', 'CUBE'],
    [
      'SELECT a, COUNT(*) FROM t GROUP BY GROUPING SETS (a)',
      'GROUP BY GROUPING SETS is not supported',
      'GROUPING SETS',
    ],
    [
      'SELECT * FROM t WHERE a IN (SELECT a FROM u)',
      'subqueries are not supported',
      '(SELECT a FROM u)',
    ],
    ['SELECT (SELECT 1) FROM t', 'subqueries are not supported', '(SELECT 1)'],
    ['SELECT * FROM (SELECT * FROM t) x', 'subqueries are not supported', '(SELECT * FROM t)'],
    ['SELECT a INTO tmp FROM t', 'SELECT ... INTO is not supported', 'INTO'],
    ['SELECT * FROM t, u', 'comma joins are not supported, use JOIN ... ON', ','],
    [
      'SELECT * FROM t WHERE a = 1 OPTION (RECOMPILE)',
      "unexpected 'OPTION' after the statement",
      'OPTION',
    ],
    ['SELECT NEWID() FROM t', 'function NEWID is not supported', 'NEWID()'],
  ];

  it.each(cases)('%s', (sql, message, at) => {
    expect(fail(sql)).toEqual({ message, at });
  });

  const others: readonly [sql: string, at: string][] = [
    ['CREATE TABLE t (a INT)', 'CREATE'],
    ['DROP TABLE t', 'DROP'],
    ['ALTER TABLE t ADD b INT', 'ALTER'],
    ['EXEC sp_who', 'EXEC'],
    ['SET NOCOUNT ON', 'SET'],
    ['USE shop', 'USE'],
    ['MERGE INTO t USING u ON t.id = u.id WHEN MATCHED THEN DELETE', 'MERGE'],
    ['BEGIN TRANSACTION', 'BEGIN'],
    ['GRANT SELECT ON t TO public', 'GRANT'],
  ];

  it.each(others)('%s is not one of the five statements', (sql, at) => {
    expect(fail(sql)).toEqual({
      message: 'Only SELECT, UPDATE, DELETE, INSERT and TRUNCATE statements are supported',
      at,
    });
  });

  it('refuses SELECT INTO a temp table before anything else', () => {
    // `#tmp` is the normal spelling. The refusal that helps is the one that names SELECT ... INTO.
    expect(fail('SELECT a INTO #tmp FROM t')).toEqual({
      message: 'SELECT ... INTO is not supported',
      at: 'INTO',
    });
  });
});
