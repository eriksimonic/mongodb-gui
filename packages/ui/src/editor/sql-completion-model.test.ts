import type { SchemaField } from '@mongo-gui/core';
import { describe, expect, it } from 'vitest';
import {
  SQL_FUNCTIONS,
  SQL_KEYWORDS,
  sqlCompletionContext,
  sqlCompletions,
  sqlIdentifier,
  sqlTargetTable,
  type SqlCompletionContext,
} from './sql-completion-model';

/** The context at the `|` in the text. */
function contextAt(text: string) {
  const offset = text.indexOf('|');
  if (offset === -1) {
    throw new Error('the text needs a | for the cursor');
  }
  return sqlCompletionContext(text.slice(0, offset) + text.slice(offset + 1), offset);
}

function field(path: string, types: string[] = ['string']): SchemaField {
  return { path, types, presence: 1 };
}

const ORDER_FIELDS = [
  field('_id', ['objectId']),
  field('total', ['double']),
  field('status'),
  field('address.city'),
  field('address.zip'),
  field('address.geo.lat', ['double']),
  field('items[].sku'),
  field('customerId', ['objectId']),
];

const CUSTOMER_FIELDS = [field('_id', ['objectId']), field('name'), field('email')];

const input = {
  collections: ['orders', 'customers', 'order items', 'select'],
  fieldsOf: (collection: string) => {
    if (collection === 'orders') {
      return ORDER_FIELDS;
    }
    if (collection === 'customers') {
      return CUSTOMER_FIELDS;
    }
    return undefined;
  },
  keywords: SQL_KEYWORDS,
  functions: SQL_FUNCTIONS,
};

function labels(items: readonly { label: string }[]): string[] {
  return items.map((item) => item.label);
}

describe('sqlCompletionContext', () => {
  describe('kind', () => {
    it('is keyword in an empty editor', () => {
      expect(contextAt('|')).toEqual({
        prefix: '',
        kind: 'keyword',
        tables: [],
        qualifier: undefined,
        parentPath: [],
      });
    });

    it('is keyword for the first word of a statement', () => {
      expect(contextAt('SEL|')).toMatchObject({ prefix: 'SEL', kind: 'keyword' });
    });

    it('is keyword after a semicolon that closed the last statement', () => {
      expect(contextAt('SELECT * FROM orders; |')).toMatchObject({ kind: 'keyword', tables: [] });
    });

    it('is keyword for the word that starts a second statement', () => {
      expect(contextAt('SELECT * FROM orders;\nUP|')).toMatchObject({
        prefix: 'UP',
        kind: 'keyword',
        tables: [],
      });
    });

    it('is keyword after a GO line', () => {
      expect(contextAt('SELECT * FROM orders\nGO\n|')).toMatchObject({ kind: 'keyword' });
    });

    it('is table after FROM', () => {
      expect(contextAt('SELECT * FROM |')).toMatchObject({ prefix: '', kind: 'table' });
    });

    it('is table for a name being typed after FROM', () => {
      expect(contextAt('SELECT * FROM ord|')).toMatchObject({ prefix: 'ord', kind: 'table' });
    });

    it('is table after JOIN', () => {
      expect(contextAt('SELECT * FROM orders o JOIN cu|')).toMatchObject({
        prefix: 'cu',
        kind: 'table',
      });
    });

    it('is table after LEFT JOIN', () => {
      expect(contextAt('SELECT * FROM orders o LEFT JOIN |')).toMatchObject({ kind: 'table' });
    });

    it('is table after UPDATE', () => {
      expect(contextAt('UPDATE |')).toMatchObject({ kind: 'table' });
    });

    it('is table after INSERT INTO', () => {
      expect(contextAt('INSERT INTO |')).toMatchObject({ kind: 'table' });
    });

    it('is table after DELETE FROM', () => {
      expect(contextAt('DELETE FROM |')).toMatchObject({ kind: 'table' });
    });

    it('is table after a comma in the FROM list', () => {
      expect(contextAt('SELECT * FROM orders o, |')).toMatchObject({ kind: 'table' });
    });

    it('is table after a comma that follows an unaliased FROM table', () => {
      expect(contextAt('SELECT * FROM orders, cus|')).toMatchObject({
        kind: 'table',
        prefix: 'cus',
      });
    });

    it('is not table after a comma in the select list', () => {
      expect(contextAt('SELECT total, |FROM orders')).toMatchObject({ kind: 'column' });
    });

    it('is not table after a comma in an IN list', () => {
      expect(contextAt('SELECT * FROM orders WHERE status IN (1, |')).toMatchObject({
        kind: 'column',
      });
    });

    it('is column after SELECT', () => {
      expect(contextAt('SELECT |')).toMatchObject({ kind: 'column' });
    });

    it('is column after WHERE', () => {
      expect(contextAt('SELECT * FROM orders WHERE |')).toMatchObject({ kind: 'column' });
    });

    it('is column after AND', () => {
      expect(contextAt('SELECT * FROM orders WHERE total > 1 AND st|')).toMatchObject({
        kind: 'column',
        prefix: 'st',
      });
    });

    it('is column after ORDER BY', () => {
      expect(contextAt('SELECT * FROM orders ORDER BY |')).toMatchObject({ kind: 'column' });
    });

    it('is column after SET', () => {
      expect(contextAt('UPDATE orders SET |')).toMatchObject({ kind: 'column' });
    });

    it('is column in the column list of an INSERT', () => {
      expect(contextAt('INSERT INTO orders (|')).toMatchObject({ kind: 'column' });
    });

    it('is column after ON', () => {
      expect(contextAt('SELECT * FROM orders o JOIN customers c ON |')).toMatchObject({
        kind: 'column',
      });
    });

    it('is keyword right after a table name, where a clause word follows', () => {
      expect(contextAt('SELECT * FROM orders |')).toMatchObject({ kind: 'keyword' });
    });

    it('is keyword after an alias', () => {
      expect(contextAt('SELECT * FROM orders o |')).toMatchObject({ kind: 'keyword' });
    });

    it('is keyword while a clause word is typed after the table', () => {
      expect(contextAt('SELECT * FROM orders WH|')).toMatchObject({
        kind: 'keyword',
        prefix: 'WH',
      });
    });

    it('is none inside a string', () => {
      expect(contextAt("SELECT * FROM orders WHERE status = 'pa|")).toMatchObject({
        kind: 'none',
      });
    });

    it('is none inside a closed string', () => {
      expect(contextAt("SELECT * FROM orders WHERE status = 'pa|id'")).toMatchObject({
        kind: 'none',
      });
    });

    it('is none inside a string with a doubled quote', () => {
      expect(contextAt("SELECT * FROM orders WHERE name = 'it''s |")).toMatchObject({
        kind: 'none',
      });
    });

    it('is column right after a closed string', () => {
      expect(contextAt("SELECT * FROM orders WHERE status = 'paid' |")).toMatchObject({
        kind: 'column',
      });
    });

    it('is none inside a line comment', () => {
      expect(contextAt('SELECT * FROM orders -- the st|')).toMatchObject({ kind: 'none' });
    });

    it('is none inside a line comment that ends before the next line', () => {
      expect(contextAt('SELECT * -- all|\nFROM orders')).toMatchObject({ kind: 'none' });
    });

    it('is none inside a block comment', () => {
      expect(contextAt('SELECT * /* st| */ FROM orders')).toMatchObject({ kind: 'none' });
    });

    it('is none inside a block comment that never closes', () => {
      expect(contextAt('SELECT * FROM orders /* st|')).toMatchObject({ kind: 'none' });
    });

    it('is column on the line after a comment', () => {
      expect(contextAt('SELECT * -- all\n|FROM orders')).toMatchObject({ kind: 'column' });
    });

    it('is none inside a bracketed name', () => {
      expect(contextAt('SELECT * FROM [ord|')).toMatchObject({ kind: 'none' });
    });

    it('is none after a comment that follows a semicolon', () => {
      expect(contextAt('SELECT 1; -- do|')).toMatchObject({ kind: 'none' });
    });
  });

  describe('tables', () => {
    it('lists the FROM table without an alias', () => {
      expect(contextAt('SELECT | FROM orders').tables).toEqual([
        { name: 'orders', alias: undefined },
      ]);
    });

    it('lists the FROM table with its alias', () => {
      expect(contextAt('SELECT | FROM orders o').tables).toEqual([{ name: 'orders', alias: 'o' }]);
    });

    it('reads an alias after AS', () => {
      expect(contextAt('SELECT | FROM orders AS o').tables).toEqual([
        { name: 'orders', alias: 'o' },
      ]);
    });

    it('does not take a clause word as an alias', () => {
      expect(contextAt('SELECT | FROM orders WHERE total > 1').tables).toEqual([
        { name: 'orders', alias: undefined },
      ]);
    });

    it('lists the join tables after the FROM table', () => {
      expect(
        contextAt(
          'SELECT | FROM orders o JOIN customers c ON o.customerId = c._id LEFT JOIN products p ON 1 = 1',
        ).tables,
      ).toEqual([
        { name: 'orders', alias: 'o' },
        { name: 'customers', alias: 'c' },
        { name: 'products', alias: 'p' },
      ]);
    });

    it('lists every table of a FROM list', () => {
      expect(contextAt('SELECT | FROM orders o, customers c, products').tables).toEqual([
        { name: 'orders', alias: 'o' },
        { name: 'customers', alias: 'c' },
        { name: 'products', alias: undefined },
      ]);
    });

    it('lists the UPDATE table', () => {
      expect(contextAt('UPDATE orders SET status = |').tables).toEqual([
        { name: 'orders', alias: undefined },
      ]);
    });

    it('lists the INSERT INTO table', () => {
      expect(contextAt('INSERT INTO orders (status) VALUES (|').tables).toEqual([
        { name: 'orders', alias: undefined },
      ]);
    });

    it('lists the DELETE table', () => {
      expect(contextAt('DELETE FROM orders WHERE |').tables).toEqual([
        { name: 'orders', alias: undefined },
      ]);
    });

    it('unwraps a bracketed table name', () => {
      expect(contextAt('SELECT | FROM [order items] oi').tables).toEqual([
        { name: 'order items', alias: 'oi' },
      ]);
    });

    it('unwraps a doubled bracket in a table name', () => {
      expect(contextAt('SELECT | FROM [a]]b]').tables).toEqual([{ name: 'a]b', alias: undefined }]);
    });

    it('takes the last part of a schema qualified name', () => {
      expect(contextAt('SELECT | FROM dbo.orders o').tables).toEqual([
        { name: 'orders', alias: 'o' },
      ]);
    });

    it('sees the tables named after the cursor', () => {
      expect(contextAt('SELECT o.| FROM orders o JOIN customers c ON 1 = 1').tables).toHaveLength(
        2,
      );
    });

    it('keeps the tables of the current statement only', () => {
      expect(contextAt('SELECT * FROM customers;\nSELECT | FROM orders').tables).toEqual([
        { name: 'orders', alias: undefined },
      ]);
    });

    it('ignores a FROM inside a string', () => {
      expect(contextAt("SELECT 'FROM nowhere' | FROM orders").tables).toEqual([
        { name: 'orders', alias: undefined },
      ]);
    });

    it('ignores a FROM inside a comment', () => {
      expect(contextAt('SELECT * /* FROM nowhere */ | FROM orders').tables).toEqual([
        { name: 'orders', alias: undefined },
      ]);
    });

    it('reads the clause words in any case', () => {
      expect(contextAt('select | from orders o inner join customers c on 1 = 1').tables).toEqual([
        { name: 'orders', alias: 'o' },
        { name: 'customers', alias: 'c' },
      ]);
    });
  });

  describe('qualifier and parent path', () => {
    it('reads an alias as the qualifier', () => {
      expect(contextAt('SELECT o.| FROM orders o')).toMatchObject({
        prefix: '',
        qualifier: 'o',
        parentPath: [],
        kind: 'column',
      });
    });

    it('reads a table name as the qualifier', () => {
      expect(contextAt('SELECT orders.to| FROM orders')).toMatchObject({
        prefix: 'to',
        qualifier: 'orders',
        parentPath: [],
      });
    });

    it('matches the qualifier in any case', () => {
      expect(contextAt('SELECT O.| FROM orders o')).toMatchObject({ qualifier: 'O' });
    });

    it('puts the parts between the qualifier and the prefix in the parent path', () => {
      expect(contextAt('SELECT o.address.ci| FROM orders o')).toMatchObject({
        prefix: 'ci',
        qualifier: 'o',
        parentPath: ['address'],
      });
    });

    it('reads a deeper parent path', () => {
      expect(contextAt('SELECT o.address.geo.| FROM orders o')).toMatchObject({
        prefix: '',
        qualifier: 'o',
        parentPath: ['address', 'geo'],
      });
    });

    it('reads a parent path without a qualifier', () => {
      expect(contextAt('SELECT address.ci| FROM orders')).toMatchObject({
        prefix: 'ci',
        qualifier: undefined,
        parentPath: ['address'],
      });
    });

    it('reads a bracketed part of the path', () => {
      expect(contextAt('SELECT o.[address].| FROM orders o')).toMatchObject({
        qualifier: 'o',
        parentPath: ['address'],
      });
    });

    it('stops the chain at a space before the dot', () => {
      expect(contextAt('SELECT o .| FROM orders o')).toMatchObject({
        qualifier: undefined,
        parentPath: [],
      });
    });

    it('reads the qualifier in a WHERE clause', () => {
      expect(
        contextAt('SELECT * FROM orders o JOIN customers c ON o.customerId = c.|'),
      ).toMatchObject({ qualifier: 'c', parentPath: [], kind: 'column' });
    });

    it('cuts the prefix at the cursor inside a word', () => {
      expect(contextAt('SELECT o.sta|tus FROM orders o')).toMatchObject({
        prefix: 'sta',
        qualifier: 'o',
      });
    });
  });
});

describe('sqlTargetTable', () => {
  it('is the table the qualifier names', () => {
    expect(sqlTargetTable(contextAt('SELECT c.| FROM orders o JOIN customers c ON 1 = 1'))).toBe(
      'customers',
    );
  });

  it('is the FROM table when the word is unqualified', () => {
    expect(sqlTargetTable(contextAt('SELECT * FROM orders o JOIN customers c ON |'))).toBe(
      'orders',
    );
  });

  it('is undefined when the statement names no table', () => {
    expect(sqlTargetTable(contextAt('SELECT |'))).toBeUndefined();
  });
});

describe('sqlIdentifier', () => {
  it('keeps a plain name', () => {
    expect(sqlIdentifier('orders')).toBe('orders');
  });

  it('brackets a name with a space', () => {
    expect(sqlIdentifier('order items')).toBe('[order items]');
  });

  it('brackets a name that starts with a digit', () => {
    expect(sqlIdentifier('2024')).toBe('[2024]');
  });

  it('brackets a keyword in any case', () => {
    expect(sqlIdentifier('select')).toBe('[select]');
    expect(sqlIdentifier('Order')).toBe('[Order]');
  });

  it('doubles a closing bracket', () => {
    expect(sqlIdentifier('a]b')).toBe('[a]]b]');
  });
});

describe('sqlCompletions', () => {
  it('returns nothing for the none kind', () => {
    expect(sqlCompletions(contextAt("SELECT '|"), input)).toEqual([]);
  });

  it('lists the collections after FROM', () => {
    const items = sqlCompletions(contextAt('SELECT * FROM |'), input);
    expect(labels(items)).toEqual(['customers', 'order items', 'orders', 'select']);
    expect(items.every((item) => item.kind === 'collection')).toBe(true);
  });

  it('filters the collections by the prefix', () => {
    expect(labels(sqlCompletions(contextAt('SELECT * FROM ord|'), input))).toEqual([
      'order items',
      'orders',
    ]);
  });

  it('inserts brackets around a name that needs them', () => {
    const items = sqlCompletions(contextAt('SELECT * FROM |'), input);
    expect(items.find((item) => item.label === 'order items')?.insertText).toBe('[order items]');
    expect(items.find((item) => item.label === 'select')?.insertText).toBe('[select]');
    expect(items.find((item) => item.label === 'orders')?.insertText).toBeUndefined();
  });

  it('lists the fields of the FROM table after SELECT', () => {
    const items = sqlCompletions(contextAt('SELECT | FROM orders'), input);
    expect(labels(items)).toContain('total');
    expect(labels(items)).toContain('address.city');
    expect(items.find((item) => item.label === 'total')).toMatchObject({
      kind: 'property',
      detail: 'double',
    });
  });

  it('leaves out array element paths', () => {
    const items = sqlCompletions(contextAt('SELECT | FROM orders'), input);
    expect(labels(items).some((label) => label.includes('[]'))).toBe(false);
  });

  it('lists the fields of the table the alias names', () => {
    const items = sqlCompletions(
      contextAt('SELECT c.| FROM orders o JOIN customers c ON o.customerId = c._id'),
      input,
    );
    expect(labels(items)).toEqual(['_id', 'email', 'name']);
  });

  it('lists the fields of the FROM table under a qualifier that is its name', () => {
    const items = sqlCompletions(contextAt('SELECT orders.| FROM orders'), input);
    expect(labels(items)).toContain('status');
  });

  it('lists the children of the parent path', () => {
    const items = sqlCompletions(contextAt('SELECT o.address.| FROM orders o'), input);
    expect(labels(items)).toEqual(['city', 'zip', 'geo.lat']);
  });

  it('lists the children of a parent path without a qualifier', () => {
    const items = sqlCompletions(contextAt('SELECT address.| FROM orders'), input);
    expect(labels(items)).toEqual(['city', 'zip', 'geo.lat']);
  });

  it('filters the fields by the prefix', () => {
    expect(labels(sqlCompletions(contextAt('SELECT o.address.ci| FROM orders o'), input))).toEqual([
      'city',
    ]);
  });

  it('matches the prefix in any case', () => {
    expect(labels(sqlCompletions(contextAt('SELECT ST| FROM orders'), input))).toContain('status');
  });

  it('adds the aliases of the statement to an unqualified column position', () => {
    const items = sqlCompletions(
      contextAt('SELECT | FROM orders o JOIN customers c ON o.customerId = c._id'),
      input,
    );
    expect(items.find((item) => item.label === 'o')).toMatchObject({
      kind: 'collection',
      detail: 'orders',
    });
    expect(items.find((item) => item.label === 'c')).toMatchObject({
      kind: 'collection',
      detail: 'customers',
    });
  });

  it('adds the table name as a qualifier when it has no alias', () => {
    const items = sqlCompletions(contextAt('SELECT | FROM orders'), input);
    expect(items.find((item) => item.label === 'orders')).toMatchObject({
      kind: 'collection',
      detail: 'table',
    });
  });

  it('lists the aliases before the fields', () => {
    const items = sqlCompletions(contextAt('SELECT | FROM orders o'), input);
    expect(labels(items)[0]).toBe('o');
  });

  it('adds no aliases under a qualifier', () => {
    const items = sqlCompletions(contextAt('SELECT o.| FROM orders o'), input);
    expect(labels(items)).not.toContain('o');
  });

  it('adds no aliases under a parent path', () => {
    const items = sqlCompletions(contextAt('SELECT address.| FROM orders o'), input);
    expect(labels(items)).not.toContain('o');
  });

  it('lists keywords in a column position once the prefix has two letters', () => {
    const items = sqlCompletions(contextAt('SELECT * FROM orders o WHERE 1 = 1 OR|'), input);
    expect(labels(items)).toContain('ORDER');
    expect(items.find((item) => item.label === 'ORDER')?.kind).toBe('keyword');
  });

  it('lists no keywords in a column position with a one letter prefix', () => {
    const items = sqlCompletions(contextAt('SELECT * FROM orders o WHERE O|'), input);
    expect(labels(items)).not.toContain('ORDER');
  });

  it('lists no keywords in a column position with an empty prefix', () => {
    const items = sqlCompletions(contextAt('SELECT * FROM orders o WHERE |'), input);
    expect(items.some((item) => item.kind === 'keyword')).toBe(false);
  });

  it('lists functions in a column position as snippets', () => {
    const items = sqlCompletions(contextAt('SELECT co| FROM orders'), input);
    expect(items.find((item) => item.label === 'COUNT')).toMatchObject({
      kind: 'method',
      insertText: 'COUNT($1)',
      snippet: true,
    });
  });

  it('lists the fields before the keywords', () => {
    const items = sqlCompletions(contextAt('SELECT to| FROM orders'), input);
    expect(labels(items).indexOf('total')).toBeLessThan(labels(items).indexOf('TOP'));
  });

  it('lists the keywords at the start of a statement', () => {
    const items = sqlCompletions(contextAt('SEL|'), input);
    expect(labels(items)).toEqual(['SELECT']);
  });

  it('lists every keyword and function in an empty editor', () => {
    const items = sqlCompletions(contextAt('|'), input);
    expect(labels(items)).toContain('SELECT');
    expect(labels(items)).toContain('UPDATE');
    expect(labels(items)).toContain('GETDATE');
  });

  it('lists the clause words after a table name', () => {
    const items = sqlCompletions(contextAt('SELECT * FROM orders o W|'), input);
    expect(labels(items)).toEqual(['WHEN', 'WHERE', 'WITH']);
  });

  it('lists nothing for a column when no table is known', () => {
    expect(sqlCompletions(contextAt('SELECT |'), input)).toEqual([]);
  });

  it('lists nothing for a column of a collection without a sample', () => {
    expect(sqlCompletions(contextAt('SELECT | FROM products'), input)).toEqual([
      { label: 'products', kind: 'collection', detail: 'table', rank: 1 },
    ]);
  });

  it('leaves the functions out when none are given', () => {
    const context: SqlCompletionContext = {
      prefix: '',
      kind: 'keyword',
      tables: [],
      qualifier: undefined,
      parentPath: [],
    };
    const items = sqlCompletions(context, { ...input, functions: undefined });
    expect(items.some((item) => item.kind === 'method')).toBe(false);
  });

  it('matches the keywords by prefix in any case', () => {
    expect(labels(sqlCompletions(contextAt('sel|'), input))).toEqual(['SELECT']);
  });
});
