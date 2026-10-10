import { describe, expect, it } from 'vitest';
import { formatSql } from './sql-format';

/** Joins lines so the expected text reads like the formatted output. */
function text(...lines: string[]): string {
  return lines.join('\n');
}

describe('formatSql keywords', () => {
  it('upper-cases keywords', () => {
    expect(formatSql('select * from orders')).toBe(text('SELECT *', 'FROM orders'));
  });

  it('leaves names and aliases as written', () => {
    expect(formatSql('select Total as GrandTotal from Orders')).toBe(
      text('SELECT Total AS GrandTotal', 'FROM Orders'),
    );
  });

  it('upper-cases mixed-case keywords', () => {
    expect(formatSql('SeLeCt a FrOm t WhErE a Is NuLl')).toBe(
      text('SELECT a', 'FROM t', 'WHERE a IS NULL'),
    );
  });

  it('leaves a keyword inside a string alone', () => {
    expect(formatSql("select 'select from where' from t")).toBe(
      text("SELECT 'select from where'", 'FROM t'),
    );
  });

  it('leaves a keyword inside a bracketed name alone', () => {
    expect(formatSql('select [from], [order by] from [where]')).toBe(
      text('SELECT [from],', '  [order by]', 'FROM [where]'),
    );
  });

  it('leaves a keyword inside a double-quoted name alone', () => {
    expect(formatSql('select "from" from t')).toBe(text('SELECT "from"', 'FROM t'));
  });

  it('leaves a keyword after a dot alone', () => {
    expect(formatSql('select a.order, a.group from t a')).toBe(
      text('SELECT a.order,', '  a.group', 'FROM t a'),
    );
  });

  it('upper-cases known function names before a parenthesis only', () => {
    expect(formatSql('select count(*), len(name), count from t')).toBe(
      text('SELECT COUNT(*),', '  LEN(name),', '  count', 'FROM t'),
    );
  });

  it('upper-cases the type of a CAST', () => {
    expect(formatSql('select cast(a as int), convert(varchar, b) from t')).toBe(
      text('SELECT CAST(a AS INT),', '  CONVERT(varchar, b)', 'FROM t'),
    );
  });

  it('upper-cases the words of an OFFSET clause', () => {
    expect(formatSql('select a from t order by a offset 5 rows fetch next 10 rows only')).toBe(
      text('SELECT a', 'FROM t', 'ORDER BY a', 'OFFSET 5 ROWS FETCH NEXT 10 ROWS ONLY'),
    );
  });

  it('leaves a column named like an OFFSET word alone outside that clause', () => {
    expect(formatSql('select next, first from t')).toBe(text('SELECT next,', '  first', 'FROM t'));
  });

  it('keeps a string with an escaped quote together', () => {
    expect(formatSql("select 'it''s from' from t")).toBe(text("SELECT 'it''s from'", 'FROM t'));
  });

  it('keeps an N-prefixed string together', () => {
    expect(formatSql("select * from t where a = n'x from y'")).toBe(
      text('SELECT *', 'FROM t', "WHERE a = n'x from y'"),
    );
  });

  it('keeps a bracketed name with a doubled closing bracket together', () => {
    expect(formatSql('select [a]] from] from t')).toBe(text('SELECT [a]] from]', 'FROM t'));
  });
});

describe('formatSql clauses', () => {
  it('puts each clause on its own line', () => {
    expect(formatSql('select a from t where a = 1 group by a having count(*) > 1 order by a')).toBe(
      text('SELECT a', 'FROM t', 'WHERE a = 1', 'GROUP BY a', 'HAVING COUNT(*) > 1', 'ORDER BY a'),
    );
  });

  it('puts select columns on one line each after the first', () => {
    expect(formatSql('select a, b, c from t')).toBe(text('SELECT a,', '  b,', '  c', 'FROM t'));
  });

  it('keeps a comma inside a function call on the line', () => {
    expect(formatSql('select isnull(a, 0), b from t')).toBe(
      text('SELECT ISNULL(a, 0),', '  b', 'FROM t'),
    );
  });

  it('keeps TOP and DISTINCT on the SELECT line', () => {
    expect(formatSql('select distinct top 5 a, b from t')).toBe(
      text('SELECT DISTINCT TOP 5 a,', '  b', 'FROM t'),
    );
  });

  it('keeps ORDER BY items on one line', () => {
    expect(formatSql('select a from t order by a desc, b asc')).toBe(
      text('SELECT a', 'FROM t', 'ORDER BY a DESC, b ASC'),
    );
  });

  it('keeps GROUP BY items on one line', () => {
    expect(formatSql('select a, b from t group by a, b')).toBe(
      text('SELECT a,', '  b', 'FROM t', 'GROUP BY a, b'),
    );
  });

  it('keeps FROM tables separated by a comma on one line', () => {
    expect(formatSql('select * from a, b')).toBe(text('SELECT *', 'FROM a, b'));
  });

  it('puts every join kind on its own line', () => {
    expect(
      formatSql(
        'select * from a join b on a.x = b.x inner join c on c.x = a.x left join d on d.x = a.x left outer join e on e.x = a.x',
      ),
    ).toBe(
      text(
        'SELECT *',
        'FROM a',
        'JOIN b ON a.x = b.x',
        'INNER JOIN c ON c.x = a.x',
        'LEFT JOIN d ON d.x = a.x',
        'LEFT OUTER JOIN e ON e.x = a.x',
      ),
    );
  });

  it('formats right, full and cross joins', () => {
    expect(formatSql('select * from a right join b on 1=1 full join c on 1=1 cross join d')).toBe(
      text('SELECT *', 'FROM a', 'RIGHT JOIN b ON 1 = 1', 'FULL JOIN c ON 1 = 1', 'CROSS JOIN d'),
    );
  });

  it('does not break before a LEFT function call', () => {
    expect(formatSql('select left(name, 3), right(name, 2) from t')).toBe(
      text('SELECT LEFT(name, 3),', '  RIGHT(name, 2)', 'FROM t'),
    );
  });

  it('indents AND and OR in WHERE', () => {
    expect(formatSql('select * from t where a = 1 and b = 2 or c = 3')).toBe(
      text('SELECT *', 'FROM t', 'WHERE a = 1', '  AND b = 2', '  OR c = 3'),
    );
  });

  it('indents AND in ON and HAVING', () => {
    expect(
      formatSql(
        'select a from t join u on t.a = u.a and t.b = u.b group by a having sum(x) > 1 and sum(x) < 9',
      ),
    ).toBe(
      text(
        'SELECT a',
        'FROM t',
        'JOIN u ON t.a = u.a',
        '  AND t.b = u.b',
        'GROUP BY a',
        'HAVING SUM(x) > 1',
        '  AND SUM(x) < 9',
      ),
    );
  });

  it('keeps AND of a BETWEEN on the line', () => {
    expect(formatSql('select * from t where a between 1 and 5 and b = 2')).toBe(
      text('SELECT *', 'FROM t', 'WHERE a BETWEEN 1 AND 5', '  AND b = 2'),
    );
  });

  it('keeps AND and OR inside parentheses on the line', () => {
    expect(formatSql('select * from t where (a = 1 or b = 2) and c = 3')).toBe(
      text('SELECT *', 'FROM t', 'WHERE (a = 1 OR b = 2)', '  AND c = 3'),
    );
  });

  it('keeps AND inside a CASE on the line', () => {
    expect(formatSql('select case when a = 1 and b = 2 then 1 else 0 end from t')).toBe(
      text('SELECT CASE WHEN a = 1 AND b = 2 THEN 1 ELSE 0 END', 'FROM t'),
    );
  });

  it('keeps a subquery on the line', () => {
    expect(formatSql('select * from t where a in (select b from u where c = 1)')).toBe(
      text('SELECT *', 'FROM t', 'WHERE a IN (SELECT b FROM u WHERE c = 1)'),
    );
  });

  it('formats UPDATE with one assignment per line', () => {
    expect(formatSql("update orders set status = 'x', total = 5 where id = 1")).toBe(
      text('UPDATE orders', "SET status = 'x',", '  total = 5', 'WHERE id = 1'),
    );
  });

  it('formats DELETE with FROM on the first line', () => {
    expect(formatSql('delete from orders where id = 1')).toBe(
      text('DELETE FROM orders', 'WHERE id = 1'),
    );
  });

  it('formats INSERT with VALUES on its own line', () => {
    expect(formatSql("insert into t (a, b) values (1, 'x'), (2, 'y')")).toBe(
      text('INSERT INTO t (a, b)', "VALUES (1, 'x'), (2, 'y')"),
    );
  });

  it('keeps UNION on its own line', () => {
    expect(formatSql('select a from t union all select a from u')).toBe(
      text('SELECT a', 'FROM t', 'UNION ALL', 'SELECT a', 'FROM u'),
    );
  });
});

describe('formatSql spacing', () => {
  it('puts single spaces around operators', () => {
    expect(formatSql('select a+b*2, c<>d from t where a>=1 and b<=2 and c!=3')).toBe(
      text(
        'SELECT a + b * 2,',
        '  c <> d',
        'FROM t',
        'WHERE a >= 1',
        '  AND b <= 2',
        '  AND c != 3',
      ),
    );
  });

  it('keeps a unary minus attached', () => {
    expect(formatSql('select -a, 1 - -2, b*-1 from t where x=-5')).toBe(
      text('SELECT -a,', '  1 - -2,', '  b * -1', 'FROM t', 'WHERE x = -5'),
    );
  });

  it('keeps dotted names and a star together', () => {
    expect(formatSql('select o . id, o . * from orders o')).toBe(
      text('SELECT o.id,', '  o.*', 'FROM orders o'),
    );
  });

  it('keeps decimals and exponents together', () => {
    expect(formatSql('select 1.5, .5, 2e10 from t')).toBe(
      text('SELECT 1.5,', '  .5,', '  2e10', 'FROM t'),
    );
  });

  it('keeps parameters together', () => {
    expect(formatSql('select * from t where a=@id and b=@@rowcount')).toBe(
      text('SELECT *', 'FROM t', 'WHERE a = @id', '  AND b = @@rowcount'),
    );
  });

  it('removes space inside parentheses and before commas', () => {
    expect(formatSql('select * from t where a in ( 1 , 2 ,3 )')).toBe(
      text('SELECT *', 'FROM t', 'WHERE a IN (1, 2, 3)'),
    );
  });

  it('puts a space before the parenthesis after a keyword', () => {
    expect(formatSql('select * from t where a in(1) and not(b = 2)')).toBe(
      text('SELECT *', 'FROM t', 'WHERE a IN (1)', '  AND NOT (b = 2)'),
    );
  });

  it('collapses runs of whitespace and line breaks', () => {
    expect(formatSql('select    a   ,\n\n\n b\n\n   from\n t')).toBe(
      text('SELECT a,', '  b', 'FROM t'),
    );
  });

  it('accepts Windows line endings', () => {
    expect(formatSql('select a\r\nfrom t -- note\r\nwhere a = 1')).toBe(
      text('SELECT a', 'FROM t -- note', 'WHERE a = 1'),
    );
  });
});

describe('formatSql statements', () => {
  it('separates statements with a blank line and keeps the semicolons', () => {
    expect(formatSql('select 1;select 2 ; select 3')).toBe(
      text('SELECT 1;', '', 'SELECT 2;', '', 'SELECT 3'),
    );
  });

  it('drops empty statements', () => {
    expect(formatSql('select 1;;;  ;select 2;')).toBe(text('SELECT 1;', '', 'SELECT 2;'));
  });

  it('keeps GO on its own line', () => {
    expect(formatSql('select 1\ngo\nselect 2')).toBe(text('SELECT 1', 'GO', '', 'SELECT 2'));
  });

  it('does not take a go column for a separator', () => {
    expect(formatSql('select go from t')).toBe(text('SELECT go', 'FROM t'));
  });

  it('keeps a semicolon inside a string', () => {
    expect(formatSql("select 'a;b' from t; select 2")).toBe(
      text("SELECT 'a;b'", 'FROM t;', '', 'SELECT 2'),
    );
  });

  it('returns an empty string for blank text', () => {
    expect(formatSql('')).toBe('');
    expect(formatSql(' \n\t \n')).toBe('');
  });

  it('removes leading and trailing blank lines', () => {
    expect(formatSql('\n\n  select 1  \n\n')).toBe('SELECT 1');
  });
});

describe('formatSql comments', () => {
  it('keeps a trailing line comment on its line', () => {
    expect(formatSql('select a, -- first\n b from t -- table')).toBe(
      text('SELECT a, -- first', '  b', 'FROM t -- table'),
    );
  });

  it('keeps a line comment on its own line', () => {
    expect(formatSql('-- heading\nselect a\n-- middle\nfrom t')).toBe(
      text('-- heading', 'SELECT a', '-- middle', 'FROM t'),
    );
  });

  it('leaves keywords inside comments alone', () => {
    expect(formatSql('select a /* select from where */ from t -- and or')).toBe(
      text('SELECT a /* select from where */', 'FROM t -- and or'),
    );
  });

  it('keeps a block comment before a statement on its own line', () => {
    expect(formatSql('/* header */ select 1')).toBe(text('/* header */', 'SELECT 1'));
  });

  it('keeps a multi-line block comment as written', () => {
    expect(formatSql('select a /* one\n   two */ from t')).toBe(
      text('SELECT a /* one', '   two */', 'FROM t'),
    );
  });

  it('puts the semicolon on a new line after a line comment', () => {
    expect(formatSql('select 1 -- c\n;')).toBe(text('SELECT 1 -- c', ';'));
  });

  it('keeps a comment after the last statement in a block of its own', () => {
    expect(formatSql('select 1; -- done')).toBe(text('SELECT 1;', '', '-- done'));
  });

  it('keeps a comment that has no statement', () => {
    expect(formatSql('-- nothing\n')).toBe('-- nothing');
  });

  it('does not take a dash pair inside a string for a comment', () => {
    expect(formatSql("select '--x', '/* y */' from t")).toBe(
      text("SELECT '--x',", "  '/* y */'", 'FROM t'),
    );
  });

  it('keeps a comment before a clause on its own line', () => {
    expect(formatSql('select a\n-- only paid\nwhere a = 1 -- tail\nand b = 2')).toBe(
      text('SELECT a', '-- only paid', 'WHERE a = 1 -- tail', '  AND b = 2'),
    );
  });
});

describe('formatSql broken text', () => {
  it('keeps an unterminated string as written', () => {
    expect(formatSql("select 'abc from t")).toBe("SELECT 'abc from t");
  });

  it('keeps an unterminated bracket as written', () => {
    expect(formatSql('select [abc from t')).toBe('SELECT [abc from t');
  });

  it('keeps an unterminated block comment as written', () => {
    expect(formatSql('select 1 /* open from')).toBe('SELECT 1 /* open from');
  });

  it('keeps characters the grammar does not know', () => {
    expect(formatSql('select a ? b from t')).toBe(text('SELECT a ? b', 'FROM t'));
  });

  it('formats text that does not parse', () => {
    expect(formatSql('select from where')).toBe(text('SELECT', 'FROM', 'WHERE'));
  });
});

describe('formatSql idempotence', () => {
  const samples = [
    "select o.id, c.name, count(*) as n from orders o inner join customers c on o.cid = c.id and c.x = 1 where o.total between 1 and 5 and o.status in ('a', 'b') or o.x is not null group by o.id, c.name having count(*) > 1 order by n desc offset 5 rows fetch next 10 rows only;",
    "update orders set status='x', total = total*-1 where id=1;delete from orders where a = 1\ngo\ninsert into t(a,b) values (1,2),(3,4)",
    '-- lead\nselect a, -- first\n b /* c */ from t -- end\n;\n-- tail',
    "select case when a=1 and b=2 then 'select from' else null end, cast(x as int), [from], a.order from [where] where x like '%and%'",
    'select 1 -- c\n;',
    'select a -- one\n, b\nfrom t',
    "select 'abc from t",
    'select [a from t; select 2',
    'select 1 /* open',
    'select left(name, 3) from t cross join u',
    'select a from t where b = 1\n-- hold\nand c = 2',
    '/* h */ select 1; go\nselect 2\nGO',
    'select a ? b from t',
    '',
  ];

  it.each(samples)('formats %j to a fixed point', (sample) => {
    const once = formatSql(sample);
    expect(formatSql(once)).toBe(once);
  });

  it('keeps formatted text unchanged', () => {
    const formatted = text(
      'SELECT o.id,',
      '  c.name',
      'FROM orders o',
      'INNER JOIN customers c ON o.cid = c.id',
      'WHERE o.total > 5',
      "  AND c.name LIKE 'A%';",
      '',
      'DELETE FROM orders',
      'WHERE id = 1;',
    );
    expect(formatSql(formatted)).toBe(formatted);
  });
});
