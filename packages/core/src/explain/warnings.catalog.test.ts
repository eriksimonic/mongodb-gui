import { describe, expect, it } from 'vitest';
import { normaliseExplain } from './normalise';
import type { PlanWarningCode } from './plan-tree';

// A plan whose winning stage is a $cursor over a collection, followed by the given stages.
function aggregateDoc(stages: unknown[]): Record<string, unknown> {
  return {
    command: { aggregate: 'places', pipeline: [], cursor: {} },
    stages: [
      {
        $cursor: {
          queryPlanner: {
            namespace: 'shop.places',
            winningPlan: { stage: 'COLLSCAN', direction: 'forward' },
            rejectedPlans: [],
          },
          executionStats: {
            executionStages: { stage: 'COLLSCAN', nReturned: 500, docsExamined: 500 },
          },
        },
        nReturned: 500,
      },
      ...stages,
    ],
  };
}

function codesOf(raw: unknown): PlanWarningCode[] {
  return normaliseExplain(raw).warnings.map((warning) => warning.code);
}

describe('GROUP_SPILLED', () => {
  it('fires for a $group that wrote to disk and names the spill count', () => {
    const tree = normaliseExplain(
      aggregateDoc([{ $group: { _id: '$name' }, usedDisk: true, spills: 7, nReturned: 500 }]),
    );
    const warning = tree.warnings.find((item) => item.code === 'GROUP_SPILLED');
    expect(warning?.severity).toBe('critical');
    expect(warning?.message).toBe('The $group stage spilled to disk 7 times.');
    expect(warning?.stageName).toBe('$group');
    expect(warning?.advice).toContain('$match');
  });

  it('does not fire for a $group that stayed in memory', () => {
    const codes = codesOf(
      aggregateDoc([{ $group: { _id: '$name' }, usedDisk: false, spills: 0, nReturned: 5 }]),
    );
    expect(codes).not.toContain('GROUP_SPILLED');
  });
});

describe('ORPHANS_FILTERED', () => {
  function shardedFilter(chunkSkips: number): unknown {
    return {
      queryPlanner: {
        namespace: 'shop.places',
        winningPlan: {
          stage: 'SHARDING_FILTER',
          inputStage: { stage: 'COLLSCAN', direction: 'forward' },
        },
        rejectedPlans: [],
      },
      executionStats: {
        nReturned: 10,
        executionStages: {
          stage: 'SHARDING_FILTER',
          nReturned: 10,
          chunkSkips,
          inputStage: {
            stage: 'COLLSCAN',
            nReturned: 10 + chunkSkips,
            docsExamined: 10 + chunkSkips,
          },
        },
        totalDocsExamined: 10 + chunkSkips,
      },
    };
  }

  it('fires when the shard filter dropped many orphan documents', () => {
    const warning = normaliseExplain(shardedFilter(450)).warnings.find(
      (item) => item.code === 'ORPHANS_FILTERED',
    );
    expect(warning?.message).toBe(
      'The shard filter dropped 450 orphan documents that belong to other shards.',
    );
    expect(warning?.advice).toContain('cleanupOrphaned');
  });

  it('does not fire for a handful of orphans', () => {
    expect(codesOf(shardedFilter(3))).not.toContain('ORPHANS_FILTERED');
  });
});

describe('LOOKUP_WITHOUT_INDEX', () => {
  const slotLookup = (indexed: boolean): unknown => ({
    queryPlanner: {
      namespace: 'shop.places',
      winningPlan: {
        queryPlan: {
          stage: 'EQ_LOOKUP',
          planNodeId: 2,
          ...(indexed ? { indexName: 'region_1' } : {}),
          inputStage: { stage: 'COLLSCAN', planNodeId: 1 },
        },
        slotBasedPlan: {},
      },
      rejectedPlans: [],
    },
  });

  it('fires for an EQ_LOOKUP without an index name, with the index advice', () => {
    const warning = normaliseExplain(slotLookup(false)).warnings.find(
      (item) => item.code === 'LOOKUP_WITHOUT_INDEX',
    );
    expect(warning?.stageName).toBe('EQ_LOOKUP');
    expect(warning?.severity).toBe('warning');
    expect(warning?.advice).toContain('Create an index');
  });

  it('does not fire for an EQ_LOOKUP that uses an index', () => {
    expect(codesOf(slotLookup(true))).not.toContain('LOOKUP_WITHOUT_INDEX');
  });

  it('fires for a $lookup whose server-supplied inner plan scans a collection', () => {
    const codes = codesOf(
      aggregateDoc([
        {
          $lookup: {
            from: 'customers',
            as: 'm',
            pipeline: [
              {
                $cursor: {
                  queryPlanner: {
                    namespace: 'shop.customers',
                    winningPlan: { stage: 'COLLSCAN', direction: 'forward' },
                    rejectedPlans: [],
                  },
                  executionStats: {
                    executionStages: { stage: 'COLLSCAN', nReturned: 3, docsExamined: 300 },
                  },
                },
              },
            ],
          },
          nReturned: 500,
        },
      ]),
    );
    expect(codes).toContain('LOOKUP_WITHOUT_INDEX');
  });

  it('does not fire for a $lookup whose inner pipeline has no plan', () => {
    const codes = codesOf(
      aggregateDoc([
        {
          $lookup: {
            from: 'customers',
            as: 'm',
            pipeline: [{ $match: { $expr: { $eq: ['$region', '$$c'] } } }],
          },
          nReturned: 500,
        },
      ]),
    );
    expect(codes).not.toContain('LOOKUP_WITHOUT_INDEX');
  });
});

describe('BLOCKING_STAGE_BEFORE_MATCH', () => {
  it('does not fire for a $match on an accumulator, which cannot move above the $group', () => {
    const codes = codesOf(
      aggregateDoc([
        { $group: { _id: '$s', n: { $sum: 1 } }, nReturned: 5 },
        { $match: { n: { $gt: 5 } }, nReturned: 2 },
      ]),
    );
    expect(codes).not.toContain('BLOCKING_STAGE_BEFORE_MATCH');
  });

  it('fires for a $match on _id after a $group, which the server could move up', () => {
    const tree = normaliseExplain(
      aggregateDoc([
        { $group: { _id: '$cuisine', n: { $sum: 1 } }, nReturned: 5 },
        { $match: { _id: 'thai' }, nReturned: 1 },
      ]),
    );
    const warning = tree.warnings.find((item) => item.code === 'BLOCKING_STAGE_BEFORE_MATCH');
    expect(warning?.message).toContain('runs after a $group');
    expect(warning?.stageName).toBe('$match');
  });

  it('does not fire when an $addFields between a $group and a $match creates the field', () => {
    const codes = codesOf(
      aggregateDoc([
        { $group: { _id: '$s', n: { $sum: 1 } }, nReturned: 5 },
        { $addFields: { m: '$n' }, nReturned: 5 },
        { $match: { m: 1 }, nReturned: 1 },
      ]),
    );
    expect(codes).not.toContain('BLOCKING_STAGE_BEFORE_MATCH');
  });

  it('does not fire on a dotted path into an accumulator', () => {
    const codes = codesOf(
      aggregateDoc([
        { $group: { _id: '$s', n: { $push: '$x' } }, nReturned: 5 },
        { $match: { 'n.x': 1 }, nReturned: 1 },
      ]),
    );
    expect(codes).not.toContain('BLOCKING_STAGE_BEFORE_MATCH');
  });

  it('fires for a $match on a plain field after a $sort', () => {
    const codes = codesOf(
      aggregateDoc([
        { $sort: { sortKey: { name: 1 } }, nReturned: 500 },
        { $match: { cuisine: 'thai' }, nReturned: 100 },
      ]),
    );
    expect(codes).toContain('BLOCKING_STAGE_BEFORE_MATCH');
  });

  it('does not fire after a $sort when an earlier $match already filters the same field', () => {
    const codes = codesOf(
      aggregateDoc([
        { $match: { cuisine: 'thai' }, nReturned: 100 },
        { $sort: { sortKey: { name: 1 } }, nReturned: 100 },
        { $match: { cuisine: 'thai' }, nReturned: 100 },
      ]),
    );
    expect(codes).not.toContain('BLOCKING_STAGE_BEFORE_MATCH');
  });

  it('does not fire after a $sort when a $project above it creates the field', () => {
    const codes = codesOf(
      aggregateDoc([
        { $sort: { sortKey: { score: 1 } }, nReturned: 100 },
        { $project: { score: 1 }, nReturned: 100 },
        { $match: { score: 5 }, nReturned: 10 },
      ]),
    );
    expect(codes).not.toContain('BLOCKING_STAGE_BEFORE_MATCH');
  });
});

describe('UNBOUNDED_FACET', () => {
  it('fires when a branch has no $match, $limit or $sample', () => {
    const codes = codesOf(
      aggregateDoc([
        {
          $facet: { byRating: [{ $sortByCount: '$rating' }], total: [{ $count: 'n' }] },
          nReturned: 1,
        },
      ]),
    );
    expect(codes).toContain('UNBOUNDED_FACET');
  });

  it('does not fire when every branch is bounded', () => {
    const codes = codesOf(
      aggregateDoc([
        {
          $facet: {
            thai: [{ $match: { cuisine: 'thai' } }, { $count: 'n' }],
            top: [{ $limit: 5 }],
          },
          nReturned: 1,
        },
      ]),
    );
    expect(codes).not.toContain('UNBOUNDED_FACET');
  });
});

describe('IN_MEMORY_SORT threshold', () => {
  function sortedRows(count: number): unknown {
    return aggregateDoc([
      {
        $sort: { sortKey: { name: 1 } },
        nReturned: count,
        usedDisk: false,
      },
    ]);
  }

  it('keeps a small in-memory sort at warning severity', () => {
    const warning = normaliseExplain(sortedRows(50)).warnings.find(
      (item) => item.code === 'IN_MEMORY_SORT',
    );
    expect(warning?.severity).toBe('warning');
    expect(warning?.message).toBe('The query sorts 50 documents in memory.');
  });

  it('makes an in-memory sort above the threshold critical and names the threshold', () => {
    const warning = normaliseExplain(sortedRows(20_000)).warnings.find(
      (item) => item.code === 'IN_MEMORY_SORT',
    );
    expect(warning?.severity).toBe('critical');
    expect(warning?.message).toContain('more than 10000 documents');
  });
});
