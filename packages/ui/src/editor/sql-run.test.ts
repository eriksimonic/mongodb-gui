import type { SchemaField } from '@mongo-gui/core';
import { describe, expect, it, vi } from 'vitest';
import { fieldHints, hintOf, prepareSqlRun, unsafeWriteQuestion, type SqlSampler } from './sql-run';

function field(path: string, types: readonly string[]): SchemaField {
  return { path, types: [...types], presence: 1 };
}

/** A sampler over fixed fields per collection, counting the collections it was asked about. */
function samplerOf(
  fields: Readonly<Record<string, readonly SchemaField[]>>,
): SqlSampler & { readonly asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    fieldsOf: (collection) => {
      asked.push(collection);
      return Promise.resolve([...(fields[collection] ?? [])]);
    },
  };
}

const ORDERS: readonly SchemaField[] = [
  field('_id', ['ObjectId']),
  field('createdAt', ['Date']),
  field('total', ['Double']),
  field('paid', ['Boolean']),
  field('status', ['String']),
  field('customer.id', ['ObjectId']),
  field('customer.since', ['Date']),
  field('note', ['Null', 'String']),
  field('mixed', ['Date', 'String']),
];

const CUSTOMERS: readonly SchemaField[] = [
  field('_id', ['ObjectId']),
  field('joined', ['Date']),
  field('name', ['String']),
];

const sampler = () => samplerOf({ orders: ORDERS, customers: CUSTOMERS });

async function okPlan(sql: string, source: SqlSampler = sampler()) {
  const plan = await prepareSqlRun(sql, source);
  if (!plan.ok) {
    throw new Error(`expected a plan for ${sql}: ${plan.message}`);
  }
  return plan;
}

async function failedPlan(sql: string, source: SqlSampler = sampler()) {
  const plan = await prepareSqlRun(sql, source);
  if (plan.ok) {
    throw new Error(`expected a failure for ${sql}`);
  }
  return plan;
}

describe('prepareSqlRun translation', () => {
  it('translates a plain select to find', async () => {
    const plan = await okPlan('SELECT * FROM orders');
    expect(plan.mongosh).toBe('db.orders.find({})');
    expect(plan.unsafe).toBe(false);
    expect(plan.unsafeWrites).toEqual([]);
  });

  it('turns a string compared with a sampled date field into ISODate', async () => {
    const plan = await okPlan("SELECT * FROM orders WHERE createdAt > '2026-01-02'");
    expect(plan.mongosh).toBe(
      "db.orders.find({ createdAt: { $gt: ISODate('2026-01-02T00:00:00.000Z') } })",
    );
  });

  it('keeps the string when the sampler knows no type for the field', async () => {
    const plan = await okPlan("SELECT * FROM orders WHERE createdAt > '2026-01-02'", samplerOf({}));
    expect(plan.mongosh).toBe("db.orders.find({ createdAt: { $gt: '2026-01-02' } })");
  });

  it('turns a string compared with a sampled id field into ObjectId', async () => {
    const plan = await okPlan("SELECT * FROM orders WHERE _id = '000000000000000000000001'");
    expect(plan.mongosh).toBe("db.orders.find({ _id: ObjectId('000000000000000000000001') })");
  });

  it('turns a numeric string compared with a sampled number field into a number', async () => {
    const plan = await okPlan("SELECT * FROM orders WHERE total > '5'");
    expect(plan.mongosh).toBe('db.orders.find({ total: { $gt: 5 } })');
  });

  it('turns a string compared with a sampled boolean field into a boolean', async () => {
    const plan = await okPlan("SELECT * FROM orders WHERE paid = 'true'");
    expect(plan.mongosh).toBe('db.orders.find({ paid: true })');
  });

  it('uses the hint of a nested field by its dotted path', async () => {
    const plan = await okPlan("SELECT * FROM orders WHERE customer.since < '2026-03-01'");
    expect(plan.mongosh).toBe(
      "db.orders.find({ 'customer.since': { $lt: ISODate('2026-03-01T00:00:00.000Z') } })",
    );
  });

  it('coerces an inserted value by the sampled type of its column', async () => {
    const plan = await okPlan("INSERT INTO orders (createdAt) VALUES ('2026-01-02')");
    expect(plan.mongosh).toBe(
      "db.orders.insertMany([{ createdAt: ISODate('2026-01-02T00:00:00.000Z') }])",
    );
  });

  it('samples the joined collection too and uses its types', async () => {
    const source = sampler();
    const plan = await okPlan(
      "SELECT o.total, c.name FROM orders o JOIN customers c ON o.customer.id = c._id WHERE c.joined > '2026-01-01'",
      source,
    );
    expect(plan.mongosh).toContain("ISODate('2026-01-01T00:00:00.000Z')");
    expect([...source.asked].sort()).toEqual(['customers', 'orders']);
  });

  it('asks the sampler once per collection', async () => {
    const source = sampler();
    await okPlan("SELECT * FROM orders WHERE createdAt > '2026-01-02' AND total > '1'", source);
    expect(source.asked).toEqual(['orders']);
  });

  it('samples a collection even when no column of it is compared', async () => {
    const source = sampler();
    await okPlan('SELECT * FROM orders', source);
    expect(source.asked).toEqual(['orders']);
  });

  it('counts a sampler failure as a collection without types', async () => {
    const source: SqlSampler = { fieldsOf: () => Promise.reject(new Error('offline')) };
    const plan = await okPlan("SELECT * FROM orders WHERE createdAt > '2026-01-02'", source);
    expect(plan.mongosh).toBe("db.orders.find({ createdAt: { $gt: '2026-01-02' } })");
  });

  it('counts a sampler that throws as a collection without types', async () => {
    const source: SqlSampler = {
      fieldsOf: () => {
        throw new Error('offline');
      },
    };
    const plan = await okPlan('SELECT * FROM orders', source);
    expect(plan.mongosh).toBe('db.orders.find({})');
  });
});

describe('prepareSqlRun statements', () => {
  it('joins several statements with a semicolon and a newline', async () => {
    const plan = await okPlan('SELECT * FROM orders; SELECT * FROM customers');
    expect(plan.mongosh).toBe('db.orders.find({});\ndb.customers.find({})');
  });

  it('splits statements at GO on its own line', async () => {
    const plan = await okPlan('SELECT * FROM orders\nGO\nSELECT * FROM customers');
    expect(plan.mongosh).toBe('db.orders.find({});\ndb.customers.find({})');
  });

  it('samples every collection of a multi-statement text', async () => {
    const source = sampler();
    await okPlan('SELECT * FROM orders; SELECT * FROM customers', source);
    expect([...source.asked].sort()).toEqual(['customers', 'orders']);
  });

  it('applies the hints to every statement', async () => {
    const plan = await okPlan(
      "SELECT * FROM orders WHERE createdAt > '2026-01-02'; SELECT * FROM customers WHERE joined > '2026-01-03'",
    );
    expect(plan.mongosh).toBe(
      "db.orders.find({ createdAt: { $gt: ISODate('2026-01-02T00:00:00.000Z') } });\n" +
        "db.customers.find({ joined: { $gt: ISODate('2026-01-03T00:00:00.000Z') } })",
    );
  });

  it('refuses empty text', async () => {
    const plan = await failedPlan('   \n');
    expect(plan.message).toBe('the statement is empty');
    expect(plan.span).toEqual({ start: 0, end: 4 });
  });

  it('refuses a statement that is not SQL, pointing at the word', async () => {
    const plan = await failedPlan('SELEC * FROM orders');
    expect(plan.message).toContain('Only SELECT, UPDATE, DELETE, INSERT and TRUNCATE');
    expect(plan.span).toEqual({ start: 0, end: 5 });
  });

  it('points the span of a later statement at its place in the whole text', async () => {
    const sql = 'SELECT * FROM orders;\nSELECT * FROM customers WHERE';
    const plan = await failedPlan(sql);
    expect(plan.message).toBe('expected an expression but the statement ended');
    expect(plan.span.start).toBeGreaterThan(sql.indexOf('customers'));
    expect(plan.span.end).toBeLessThanOrEqual(sql.length);
  });

  it('reports the first failing statement and runs nothing', async () => {
    const source = sampler();
    const plan = await failedPlan('SELEC * FROM orders; SELECT * FROM customers', source);
    expect(plan.span).toEqual({ start: 0, end: 5 });
    expect(source.asked).toEqual([]);
  });

  it('does not sample before the text translates', async () => {
    const source = sampler();
    await failedPlan('SELECT * FROM orders WHERE', source);
    expect(source.asked).toEqual([]);
  });
});

describe('prepareSqlRun unsafe writes', () => {
  it('flags an UPDATE without WHERE', async () => {
    const plan = await okPlan("UPDATE orders SET status = 'x'");
    expect(plan.mongosh).toBe("db.orders.updateMany({}, { $set: { status: 'x' } })");
    expect(plan.unsafe).toBe(true);
    expect(plan.unsafeWrites).toEqual([{ statement: 'UPDATE', collection: 'orders' }]);
  });

  it('flags a DELETE without WHERE', async () => {
    const plan = await okPlan('DELETE FROM orders');
    expect(plan.mongosh).toBe('db.orders.deleteMany({})');
    expect(plan.unsafeWrites).toEqual([{ statement: 'DELETE', collection: 'orders' }]);
  });

  it('does not flag a write with WHERE', async () => {
    const plan = await okPlan("DELETE FROM orders WHERE status = 'x'");
    expect(plan.unsafe).toBe(false);
  });

  it('does not flag an INSERT', async () => {
    const plan = await okPlan("INSERT INTO orders (status) VALUES ('x')");
    expect(plan.unsafe).toBe(false);
  });

  it('flags a multi-statement text when any statement is unsafe', async () => {
    const plan = await okPlan("SELECT * FROM orders; UPDATE customers SET name = 'x'");
    expect(plan.unsafe).toBe(true);
    expect(plan.unsafeWrites).toEqual([{ statement: 'UPDATE', collection: 'customers' }]);
  });

  it('lists every unsafe write of a multi-statement text in order', async () => {
    const plan = await okPlan("DELETE FROM orders; UPDATE customers SET name = 'x'");
    expect(plan.unsafeWrites).toEqual([
      { statement: 'DELETE', collection: 'orders' },
      { statement: 'UPDATE', collection: 'customers' },
    ]);
  });
});

describe('unsafeWriteQuestion', () => {
  it('names the statement and the collection of one write', () => {
    expect(unsafeWriteQuestion([{ statement: 'UPDATE', collection: 'orders' }])).toBe(
      'This UPDATE has no WHERE and changes every document of orders. Run it?',
    );
  });

  it('lists several writes', () => {
    expect(
      unsafeWriteQuestion([
        { statement: 'DELETE', collection: 'orders' },
        { statement: 'UPDATE', collection: 'customers' },
      ]),
    ).toBe(
      'These statements have no WHERE and change every document of their collections: DELETE orders, UPDATE customers. Run them?',
    );
  });

  it('is empty without writes', () => {
    expect(unsafeWriteQuestion([])).toBe('');
  });
});

describe('hintOf', () => {
  it.each([
    [['Date'], 'date'],
    [['ObjectId'], 'objectId'],
    [['Int32'], 'number'],
    [['Long'], 'number'],
    [['Double'], 'number'],
    [['Decimal128'], 'number'],
    [['Boolean'], 'bool'],
    [['String'], 'string'],
  ])('maps %j to %s', (types, hint) => {
    expect(hintOf(types)).toBe(hint);
  });

  it('ignores null and undefined beside the real type', () => {
    expect(hintOf(['Null', 'String'])).toBe('string');
    expect(hintOf(['Date', 'Undefined'])).toBe('date');
  });

  it('gives no hint for a field with several real types', () => {
    expect(hintOf(['Date', 'String'])).toBeUndefined();
    expect(hintOf(['Int32', 'Long'])).toBeUndefined();
  });

  it('gives no hint for a type the translator has none for', () => {
    expect(hintOf(['Object'])).toBeUndefined();
    expect(hintOf(['Array'])).toBeUndefined();
    expect(hintOf(['Binary'])).toBeUndefined();
  });

  it('gives no hint for a field without types', () => {
    expect(hintOf([])).toBeUndefined();
    expect(hintOf(['Null'])).toBeUndefined();
  });
});

describe('fieldHints', () => {
  it('keys the hints by dotted path and skips fields without one', () => {
    const hints = fieldHints(ORDERS);
    expect(hints.get('customer.since')).toBe('date');
    expect(hints.get('note')).toBe('string');
    expect(hints.has('mixed')).toBe(false);
    expect(hints.size).toBe(8);
  });

  it('is empty for no fields', () => {
    expect(fieldHints([]).size).toBe(0);
  });

  it('does not call the sampler for a text that names no collection', async () => {
    const fieldsOf = vi.fn<SqlSampler['fieldsOf']>().mockResolvedValue([]);
    await failedPlan('', { fieldsOf });
    expect(fieldsOf).not.toHaveBeenCalled();
  });
});
