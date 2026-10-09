import { describe, expect, it } from 'vitest';
import { explainInWords, suggestIndexKeys } from './explain-text';
import { normaliseExplain } from './normalise';
import type { PlanStage, PlanTree, PlanWarning, PlanWarningCode } from './plan-tree';

const FIXTURES = import.meta.glob<unknown>('./fixtures/**/*.json', {
  eager: true,
  import: 'default',
});

function stage(name: string, overrides: Partial<PlanStage> = {}): PlanStage {
  return { name, children: [], raw: {}, ...overrides };
}

function tree(overrides: Partial<PlanTree>): PlanTree {
  return {
    command: 'find',
    namespace: 'shop.orders',
    verbosity: 'executionStats',
    engine: 'classic',
    winning: stage('FETCH'),
    rejected: [],
    summary: { indexesUsed: [], inMemorySort: false, collectionScan: false },
    warnings: [],
    sharded: false,
    ...overrides,
  };
}

function warning(code: PlanWarningCode): PlanWarning {
  return { code, severity: 'warning', message: 'message' };
}

describe('explainInWords', () => {
  it('describes an index plan with its counters', () => {
    const words = explainInWords(
      tree({
        winning: stage('FETCH'),
        summary: {
          indexesUsed: ['customerId_1_createdAt_-1'],
          keysExamined: 12,
          docsExamined: 12,
          nReturned: 12,
          executionTimeMs: 1,
          inMemorySort: false,
          collectionScan: false,
        },
      }),
    );
    expect(words[0]).toBe(
      'The planner chose the index customerId_1_createdAt_-1 and examined 12 keys and 12 documents to return 12 documents in 1 ms.',
    );
  });

  it('describes a collection scan and suggests an index on the filter fields', () => {
    const words = explainInWords(
      tree({
        winning: stage('COLLSCAN', { filter: { total: { $gt: 5 } }, docsExamined: 2000 }),
        summary: {
          indexesUsed: [],
          docsExamined: 2000,
          nReturned: 1990,
          executionTimeMs: 0,
          inMemorySort: false,
          collectionScan: true,
        },
        warnings: [
          { code: 'COLLSCAN', severity: 'critical', message: 'scan', stageName: 'COLLSCAN' },
        ],
      }),
    );
    expect(words).toContain(
      'The planner scanned the whole collection and examined 2000 documents to return 1990 documents in 0 ms.',
    );
    expect(words).toContain('Add an index on { total: 1 } to avoid scanning 2000 documents.');
  });

  it('uses the singular for one returned document', () => {
    const words = explainInWords(
      tree({
        summary: {
          indexesUsed: ['status_1'],
          nReturned: 1,
          inMemorySort: false,
          collectionScan: false,
        },
      }),
    );
    expect(words[0]).toBe('The planner chose the index status_1 to return 1 document.');
  });

  it('keeps the plan sentence short at queryPlanner verbosity', () => {
    const words = explainInWords(
      tree({
        verbosity: 'queryPlanner',
        summary: { indexesUsed: ['status_1'], inMemorySort: false, collectionScan: false },
        warnings: [{ code: 'NO_EXECUTION_STATS', severity: 'info', message: 'none' }],
      }),
    );
    expect(words[0]).toBe('The planner chose the index status_1.');
    expect(words).toEqual([
      'The planner chose the index status_1.',
      'The server ran the plan on the classic engine.',
      'Run the explain at executionStats verbosity to see the keys, documents and time for each stage.',
    ]);
  });

  it('names several indexes in one sentence', () => {
    const words = explainInWords(
      tree({
        verbosity: 'queryPlanner',
        summary: {
          indexesUsed: ['a_1', 'b_1'],
          inMemorySort: false,
          collectionScan: false,
        },
      }),
    );
    expect(words[0]).toBe('The planner chose the indexes a_1 and b_1.');
  });

  it('returns one sentence for an unknown shape', () => {
    const unknown = normaliseExplain(null);
    expect(explainInWords(unknown)).toEqual([
      'The explain output has a shape this tool does not recognise. Only the raw JSON is available.',
    ]);
  });

  it('names the shards of a sharded plan', () => {
    const words = explainInWords(
      tree({
        sharded: true,
        winning: stage('SHARD_MERGE', {
          children: [stage('FETCH', { shard: 'shard01' }), stage('FETCH', { shard: 'shard02' })],
        }),
      }),
    );
    expect(words).toContain('The query ran on 2 shards: shard01, shard02.');
  });

  it('says a single shard in the singular', () => {
    const words = explainInWords(
      tree({ sharded: true, winning: stage('FETCH', { shard: 'shard01' }) }),
    );
    expect(words).toContain('The query ran on 1 shard: shard01.');
  });

  it('names the engine when it is known', () => {
    expect(explainInWords(tree({ engine: 'sbe' }))).toContain(
      'The server ran the plan on the slot-based engine.',
    );
    expect(explainInWords(tree({ engine: 'classic' }))).toContain(
      'The server ran the plan on the classic engine.',
    );
    expect(explainInWords(tree({ engine: 'unknown' }))).not.toContain(
      'The server ran the plan on the classic engine.',
    );
  });

  it('suggests the sort keys for an in-memory sort', () => {
    const words = explainInWords(
      tree({
        winning: stage('SORT', { raw: { sortPattern: { total: 1 } } }),
        warnings: [warning('IN_MEMORY_SORT')],
      }),
    );
    expect(words).toContain(
      'Add an index on { total: 1 } so the server can return sorted documents without an in-memory sort.',
    );
  });

  it('reads the sort keys of an aggregate $sort stage', () => {
    const words = explainInWords(
      tree({
        winning: stage('$sort', { raw: { $sort: { sortKey: { spent: -1 } } } }),
        warnings: [warning('IN_MEMORY_SORT')],
      }),
    );
    expect(words).toContain(
      'Add an index on { spent: -1 } so the server can return sorted documents without an in-memory sort.',
    );
  });

  it('writes one sentence for each warning code', () => {
    const codes: PlanWarningCode[] = [
      'COLLSCAN',
      'IN_MEMORY_SORT',
      'SORT_SPILLED',
      'HIGH_EXAMINED_RATIO',
      'FETCH_AFTER_COVERED_INDEX',
      'MANY_REJECTED_PLANS',
      'MULTIKEY_INDEX',
      'NO_EXECUTION_STATS',
    ];
    const words = explainInWords(
      tree({
        verbosity: 'queryPlanner',
        engine: 'unknown',
        winning: stage('SORT', { children: [stage('COLLSCAN')] }),
        summary: {
          indexesUsed: ['items.sku_1'],
          inMemorySort: true,
          collectionScan: true,
        },
        warnings: codes.map(warning),
      }),
    );
    // One plan sentence, then one sentence per warning.
    expect(words).toHaveLength(1 + codes.length);
  });

  it('never uses exclamation marks', () => {
    const words = explainInWords(
      tree({
        warnings: [
          warning('COLLSCAN'),
          warning('SORT_SPILLED'),
          warning('FETCH_AFTER_COVERED_INDEX'),
          warning('MANY_REJECTED_PLANS'),
        ],
      }),
    );
    expect(words.some((sentence) => sentence.includes('!'))).toBe(false);
  });

  it('writes every sentence for every fixture in sentence case and ends it with a period', () => {
    for (const [path, raw] of Object.entries(FIXTURES)) {
      for (const sentence of explainInWords(normaliseExplain(raw))) {
        expect(sentence, path).toMatch(/^[A-Z]/);
        expect(sentence, path).toMatch(/\.$/);
        expect(sentence, path).not.toContain('!');
      }
    }
  });
});

describe('suggestIndexKeys', () => {
  it('puts equality fields before range fields, in filter order', () => {
    expect(suggestIndexKeys({ total: { $gt: 5 }, status: 'paid', customerId: { $eq: 7 } })).toEqual(
      [
        ['status', 1],
        ['customerId', 1],
        ['total', 1],
      ],
    );
  });

  it('treats $in as equality and skips $ne and $exists', () => {
    expect(
      suggestIndexKeys({
        status: { $in: ['paid', 'open'] },
        note: { $ne: 'x' },
        flag: { $exists: true },
      }),
    ).toEqual([['status', 1]]);
  });

  it('reads canonical EJSON number wrappers as plain values', () => {
    expect(suggestIndexKeys({ customerId: { $numberInt: '7' } })).toEqual([['customerId', 1]]);
  });

  it('skips top-level operators such as $or', () => {
    expect(suggestIndexKeys({ $or: [{ a: 1 }] })).toEqual([]);
  });

  it('returns nothing for a filter that is not an object', () => {
    expect(suggestIndexKeys(undefined)).toEqual([]);
    expect(suggestIndexKeys('total > 5')).toEqual([]);
  });

  it('lists a field once when it is both equality and range', () => {
    expect(suggestIndexKeys({ total: { $gt: 1, $eq: 2 } })).toEqual([['total', 1]]);
  });
});
