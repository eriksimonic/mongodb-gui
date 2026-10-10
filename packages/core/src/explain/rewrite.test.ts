import { describe, expect, it } from 'vitest';
import type { PlanVerbosity } from './plan-tree';
import { COUNT_OPTIONS_NOT_EXPLAINED, EXPLAIN_NEEDS_ONE_QUERY, rewriteForExplain } from './rewrite';

function codeOf(statement: string, verbosity: PlanVerbosity = 'executionStats'): string {
  const result = rewriteForExplain(statement, verbosity);
  if (!result.ok) {
    throw new Error(`expected a rewrite, got: ${result.message}`);
  }
  return result.code;
}

function refusalOf(statement: string): string {
  const result = rewriteForExplain(statement, 'queryPlanner');
  if (result.ok) {
    throw new Error(`expected a refusal, got: ${result.code}`);
  }
  return result.message;
}

describe('rewriteForExplain on cursor methods', () => {
  it('appends explain to find and keeps the arguments', () => {
    expect(codeOf('db.orders.find({ status: "paid" })')).toBe(
      'db.orders.find({ status: "paid" }).explain("executionStats")',
    );
  });

  it('keeps a chained sort and limit before the explain', () => {
    expect(codeOf('db.orders.find({ status: "paid" }).sort({ total: 1 }).limit(5)')).toBe(
      'db.orders.find({ status: "paid" }).sort({ total: 1 }).limit(5).explain("executionStats")',
    );
  });

  it('keeps aggregate pipelines and appends explain', () => {
    expect(codeOf('db.orders.aggregate([{ $match: { status: "paid" } }])', 'queryPlanner')).toBe(
      'db.orders.aggregate([{ $match: { status: "paid" } }]).explain("queryPlanner")',
    );
  });

  it('rewrites findOne to find with limit 1', () => {
    expect(codeOf('db.orders.findOne({ _id: 7 }, { total: 1 })', 'allPlansExecution')).toBe(
      'db.orders.find({ _id: 7 }, { total: 1 }).limit(1).explain("allPlansExecution")',
    );
  });

  it('replaces an explain that is already in the chain', () => {
    expect(codeOf('db.orders.find({}).sort({ total: 1 }).explain("queryPlanner")')).toBe(
      'db.orders.find({}).sort({ total: 1 }).explain("executionStats")',
    );
  });

  it('refuses a findOne with a chained modifier', () => {
    expect(refusalOf('db.orders.findOne({}).sort({ total: 1 })')).toBe(EXPLAIN_NEEDS_ONE_QUERY);
  });
});

describe('rewriteForExplain on count, distinct and legacy writes', () => {
  it('puts explain in front of count', () => {
    expect(codeOf('db.orders.count({ status: "paid" })', 'queryPlanner')).toBe(
      'db.orders.explain("queryPlanner").count({ status: "paid" })',
    );
  });

  it('puts explain in front of distinct with its arguments', () => {
    expect(codeOf('db.orders.distinct("customerId", { status: "paid" })', 'queryPlanner')).toBe(
      'db.orders.explain("queryPlanner").distinct("customerId", { status: "paid" })',
    );
  });

  it('keeps legacy update and remove calls', () => {
    expect(codeOf('db.orders.update({ _id: 1 }, { $set: { x: 1 } }, { multi: true })')).toBe(
      'db.orders.explain("executionStats").update({ _id: 1 }, { $set: { x: 1 } }, { multi: true })',
    );
    expect(codeOf('db.orders.remove({ _id: 1 })')).toBe(
      'db.orders.explain("executionStats").remove({ _id: 1 })',
    );
  });
});

describe('rewriteForExplain on modern writes', () => {
  it('maps updateMany to a multi update', () => {
    expect(
      codeOf('db.orders.updateMany({ status: "paid" }, { $set: { x: 1 } })', 'queryPlanner'),
    ).toBe(
      'db.orders.explain("queryPlanner").update({ status: "paid" }, { $set: { x: 1 } }, { multi: true })',
    );
  });

  it('maps updateOne to a single update and keeps the options', () => {
    expect(
      codeOf(
        'db.orders.updateOne({ _id: 1 }, { $set: { x: 1 } }, { upsert: true })',
        'queryPlanner',
      ),
    ).toBe(
      'db.orders.explain("queryPlanner").update({ _id: 1 }, { $set: { x: 1 } }, { ...({ upsert: true }), multi: false })',
    );
  });

  it('maps replaceOne to findOneAndReplace, which accepts a replacement', () => {
    expect(codeOf('db.orders.replaceOne({ _id: 2 }, { total: 9 })', 'queryPlanner')).toBe(
      'db.orders.explain("queryPlanner").findOneAndReplace({ _id: 2 }, { total: 9 })',
    );
  });

  it('maps deleteOne and deleteMany to remove with justOne', () => {
    expect(codeOf('db.orders.deleteOne({ _id: 1 })', 'queryPlanner')).toBe(
      'db.orders.explain("queryPlanner").remove({ _id: 1 }, { justOne: true })',
    );
    expect(codeOf('db.orders.deleteMany({ status: "cancelled" })', 'queryPlanner')).toBe(
      'db.orders.explain("queryPlanner").remove({ status: "cancelled" }, { justOne: false })',
    );
  });

  it('maps countDocuments to the aggregate the driver runs', () => {
    expect(codeOf('db.orders.countDocuments({ status: "paid" })', 'queryPlanner')).toBe(
      'db.orders.explain("queryPlanner").aggregate([{ $match: { status: "paid" } }, { $group: { _id: 1, n: { $sum: 1 } } }])',
    );
    expect(codeOf('db.orders.countDocuments()', 'queryPlanner')).toBe(
      'db.orders.explain("queryPlanner").aggregate([{ $match: {} }, { $group: { _id: 1, n: { $sum: 1 } } }])',
    );
  });

  it('refuses countDocuments options', () => {
    expect(refusalOf('db.orders.countDocuments({}, { limit: 5 })')).toBe(
      COUNT_OPTIONS_NOT_EXPLAINED,
    );
  });

  it('refuses a write method with a chained call', () => {
    expect(refusalOf('db.orders.updateMany({}, { $set: { x: 1 } }).toArray()')).toBe(
      EXPLAIN_NEEDS_ONE_QUERY,
    );
  });

  it('refuses updateOne without an update document', () => {
    expect(refusalOf('db.orders.updateOne({ _id: 1 })')).toBe(EXPLAIN_NEEDS_ONE_QUERY);
  });

  it('keeps a comma inside a nested argument when it maps a write', () => {
    expect(codeOf('db.orders.deleteMany({ $or: [{ a: 1 }, { b: 2 }] })', 'queryPlanner')).toBe(
      'db.orders.explain("queryPlanner").remove({ $or: [{ a: 1 }, { b: 2 }] }, { justOne: false })',
    );
  });
});

describe('rewriteForExplain on collection access and layout', () => {
  it('accepts db.getCollection with a string name', () => {
    const result = rewriteForExplain('db.getCollection("order-items").find({})', 'queryPlanner');
    expect(result).toEqual({
      ok: true,
      code: 'db.getCollection("order-items").find({}).explain("queryPlanner")',
      collection: 'order-items',
      operation: 'find',
    });
  });

  it('reports the collection and the operation', () => {
    expect(rewriteForExplain('db.orders.count({})', 'queryPlanner')).toMatchObject({
      ok: true,
      collection: 'orders',
      operation: 'count',
    });
  });

  it('accepts a multi-line chain', () => {
    expect(codeOf('db.orders\n  .find({ status: "paid" })\n  .sort({ total: 1 })')).toBe(
      'db.orders.find({ status: "paid" }).sort({ total: 1 }).explain("executionStats")',
    );
  });

  it('accepts one trailing semicolon', () => {
    expect(codeOf('db.orders.find({});')).toBe('db.orders.find({}).explain("executionStats")');
  });

  it('strips line and block comments from the output', () => {
    expect(
      codeOf('// the paid orders\ndb.orders.find(/* filter */ { status: "paid" }) // done'),
    ).toBe('db.orders.find({ status: "paid" }).explain("executionStats")');
  });

  it('keeps comment markers inside strings', () => {
    expect(codeOf('db.orders.find({ note: "see http://example.test /* x */" })')).toBe(
      'db.orders.find({ note: "see http://example.test /* x */" }).explain("executionStats")',
    );
  });

  it('keeps a semicolon inside a string argument', () => {
    expect(codeOf('db.orders.find({ note: "a; b" })')).toBe(
      'db.orders.find({ note: "a; b" }).explain("executionStats")',
    );
  });

  it('keeps a regular expression with a quote inside it', () => {
    expect(codeOf('db.orders.find({ name: /"x"/i })')).toBe(
      'db.orders.find({ name: /"x"/i }).explain("executionStats")',
    );
  });
});

describe('rewriteForExplain bracket and prefix forms', () => {
  it('reads db["orders"] as db.getCollection("orders")', () => {
    expect(codeOf('db["orders"].find({ status: "paid" })')).toBe(
      'db.getCollection("orders").find({ status: "paid" }).explain("executionStats")',
    );
  });

  it("reads db['orders'] with single quotes too", () => {
    const result = rewriteForExplain("db['order-items'].count({})", 'queryPlanner');
    expect(result).toEqual({
      ok: true,
      code: 'db.getCollection(\'order-items\').explain("queryPlanner").count({})',
      collection: 'order-items',
      operation: 'count',
    });
  });

  it('refuses a bracket name that is not a string literal', () => {
    expect(refusalOf('db[name].find({})')).toBe(EXPLAIN_NEEDS_ONE_QUERY);
  });

  it('replaces the verbosity of the prefix form db.<coll>.explain(v).find(...)', () => {
    expect(codeOf('db.orders.explain("queryPlanner").find({ status: "paid" })')).toBe(
      'db.orders.find({ status: "paid" }).explain("executionStats")',
    );
  });

  it('replaces the verbosity of the prefix form with a write method', () => {
    expect(codeOf('db.orders.explain().deleteMany({ status: "cancelled" })', 'queryPlanner')).toBe(
      'db.orders.explain("queryPlanner").remove({ status: "cancelled" }, { justOne: false })',
    );
  });

  it('refuses an explain with no method after it', () => {
    expect(refusalOf('db.orders.explain("queryPlanner")')).toBe(EXPLAIN_NEEDS_ONE_QUERY);
  });
});

describe('rewriteForExplain refusals', () => {
  it.each([
    ['two statements on one line', 'db.orders.find({}); db.orders.find({})'],
    ['two statements on separate lines', 'db.orders.find({})\ndb.orders.count({})'],
    ['an assignment', 'const cursor = db.orders.find({})'],
    ['a database method', 'db.runCommand({ ping: 1 })'],
    ['a terminal cursor method', 'db.orders.find({}).toArray()'],
    ['a cursor count', 'db.orders.find({}).count()'],
    ['an insert', 'db.orders.insertOne({ x: 1 })'],
    ['a method that is not a query', 'db.orders.stats()'],
    ['a property with no call', 'db.orders.find'],
    ['an explain that is not last', 'db.orders.find({}).explain().sort({ total: 1 })'],
    ['an empty statement', '   '],
    ['an unbalanced call', 'db.orders.find({ status: "paid" '],
    ['text after the chain', 'db.orders.find({}) + 1'],
    ['a name that starts with db', 'dbx.orders.find({})'],
    ['a collection given a non-string', 'db.getCollection(name).find({})'],
    ['only a comment', '// nothing here'],
  ])('refuses %s', (_name, statement) => {
    expect(refusalOf(statement)).toBe(EXPLAIN_NEEDS_ONE_QUERY);
  });
});

describe('rewriteForExplain refuses template literals and a bare explain property', () => {
  it('refuses a backtick collection name with a template placeholder in bracket form', () => {
    const result = rewriteForExplain('db[`orders${id}`].find({})', 'queryPlanner');
    expect(result).toEqual({ ok: false, message: EXPLAIN_NEEDS_ONE_QUERY });
  });

  it('refuses a backtick collection name with a template placeholder in getCollection form', () => {
    const result = rewriteForExplain('db.getCollection(`orders${id}`).find({})', 'queryPlanner');
    expect(result).toEqual({ ok: false, message: EXPLAIN_NEEDS_ONE_QUERY });
  });

  it('accepts a backtick collection name without a placeholder', () => {
    const result = rewriteForExplain('db.getCollection(`orders`).find({})', 'queryPlanner');
    expect(result.ok).toBe(true);
  });

  it('refuses the prefix form when explain has no call parentheses', () => {
    const result = rewriteForExplain('db.orders.explain.find({})', 'queryPlanner');
    expect(result).toEqual({ ok: false, message: EXPLAIN_NEEDS_ONE_QUERY });
  });

  it('refuses the prefix form when explain has no call parentheses before a count', () => {
    const result = rewriteForExplain('db.orders.explain.count({})', 'executionStats');
    expect(result).toEqual({ ok: false, message: EXPLAIN_NEEDS_ONE_QUERY });
  });

  it('still accepts the prefix form with its verbosity argument', () => {
    const result = rewriteForExplain(
      'db.orders.explain("allPlansExecution").find({})',
      'queryPlanner',
    );
    expect(result.ok).toBe(true);
  });
});
