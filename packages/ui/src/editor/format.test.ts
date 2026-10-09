import { describe, expect, it } from 'vitest';
import { formatMongoshCode } from './format';

describe('formatMongoshCode', () => {
  it('returns nothing for blank input', () => {
    expect(formatMongoshCode('   \n\t ')).toBe('');
  });

  it('breaks an object literal over lines and indents its entries', () => {
    expect(formatMongoshCode('db.orders.find({status:"paid",total:{$gt:10}})')).toBe(
      ['db.orders.find({', '  status: "paid",', '  total: {', '    $gt: 10', '  }', '})', ''].join(
        '\n',
      ),
    );
  });

  it('keeps empty literals on one line', () => {
    expect(formatMongoshCode('db.a.find({}, [])')).toBe('db.a.find({}, [])\n');
  });

  it('keeps call arguments inline', () => {
    expect(formatMongoshCode('db.a.updateOne( {_id:1} , { $set:{a:1} } )')).toBe(
      ['db.a.updateOne({', '  _id: 1', '}, {', '  $set: {', '    a: 1', '  }', '})', ''].join('\n'),
    );
  });

  it('starts each top-level statement on its own line', () => {
    expect(formatMongoshCode('print("hi"); db.orders.countDocuments()')).toBe(
      'print("hi");\ndb.orders.countDocuments()\n',
    );
  });

  it('leaves strings, regex literals and comments unchanged', () => {
    const code = 'db.a.find({ name: "a,{b}  c", re: /x,{y}/i }) // keep: {this}';
    const formatted = formatMongoshCode(code);
    expect(formatted).toContain('"a,{b}  c"');
    expect(formatted).toContain('/x,{y}/i');
    expect(formatted).toContain('// keep: {this}');
  });

  it('does not treat a division as a regex', () => {
    expect(formatMongoshCode('db.a.find({ ratio: a / b })')).toContain('a / b');
  });

  it('is idempotent', () => {
    const once = formatMongoshCode(
      'db.a.aggregate([{$match:{status:"paid"}},{$group:{_id:"$c",n:{$sum:1}}}])',
    );
    expect(formatMongoshCode(once)).toBe(once);
  });
});
