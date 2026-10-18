import { describe, expect, it } from 'vitest';
import {
  bindVariables,
  echoedAggregate,
  lookupPosition,
  lookupSpec,
  measuredCommand,
  parseSample,
  sampleCode,
} from './lookup-measure';

const INNER = [{ $match: { $expr: { $eq: ['$productId', '$$p'] } } }, { $limit: 3 }];
const LOOKUP = { $lookup: { from: 'reviews', let: { p: '$_id' }, pipeline: INNER, as: 'top' } };
const PIPELINE = [{ $match: { categoryId: 4 } }, LOOKUP, { $sort: { name: 1 } }];

describe('lookup-measure', () => {
  it('reads the echoed aggregate and finds the $lookup in it', () => {
    const raw = JSON.stringify({ command: { aggregate: 'products', pipeline: PIPELINE } });
    const echo = echoedAggregate(raw);
    expect(echo?.collection).toBe('products');
    const spec = lookupSpec(LOOKUP);
    expect(spec).toMatchObject({ from: 'reviews', as: 'top', let: { p: '$_id' } });
    expect(lookupPosition(echo?.pipeline ?? [], spec ?? { from: '', as: '' })).toBe(1);
    expect(echoedAggregate(JSON.stringify({ queryPlanner: {} }))).toBeUndefined();
    expect(lookupSpec({ $match: {} })).toBeUndefined();
  });

  it('builds one shell expression that runs the stages before the $lookup and takes one document', () => {
    const code = sampleCode('products', PIPELINE.slice(0, 1), {
      from: 'reviews',
      as: 'top',
      let: { p: '$_id' },
      localField: 'items.productId',
    });
    expect(code.startsWith('(() => {')).toBe(true);
    expect(code.endsWith('})()')).toBe(true);
    expect(code).toContain('db.getCollection("products")');
    expect(code).toContain('$limit');
    expect(code).toContain('$items.productId');
  });

  it('reads the sample the shell returned, as the EJSON text of a string', () => {
    const text = JSON.stringify({ vars: { p: { $numberInt: '64' } }, local: [[1, 2]] });
    expect(parseSample(JSON.stringify(text))).toEqual({
      vars: { p: { $numberInt: '64' } },
      local: [1, 2],
    });
    expect(parseSample('null')).toBeUndefined();
  });

  it('binds variables and their paths as literals and leaves system variables alone', () => {
    const vars = { p: 64, o: { items: [{ sku: 'a' }, { sku: 'b' }] } };
    expect(bindVariables(['$$p', '$$o.items.sku', '$$ROOT', '$$missing', '$p'], vars)).toEqual([
      { $literal: 64 },
      { $literal: ['a', 'b'] },
      '$$ROOT',
      '$$missing',
      '$p',
    ]);
  });

  it('turns the $lookup into an aggregate on the joined collection for the sample', () => {
    const spec = lookupSpec(LOOKUP);
    if (spec === undefined) {
      throw new Error('no spec');
    }
    expect(JSON.parse(measuredCommand(spec, { vars: { p: 64 } }))).toEqual({
      aggregate: 'reviews',
      pipeline: [{ $match: { $expr: { $eq: ['$productId', { $literal: 64 }] } } }, { $limit: 3 }],
      cursor: {},
    });
    const joined = { from: 'products', as: 'p', localField: 'pid', foreignField: '_id' };
    expect(JSON.parse(measuredCommand(joined, { vars: {}, local: [3, 4] })).pipeline).toEqual([
      { $match: { _id: { $in: [3, 4] } } },
    ]);
  });
});
