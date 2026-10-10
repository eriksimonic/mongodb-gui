import { describe, expect, it } from 'vitest';
import { normaliseExplain } from './normalise';
import type { PlanStage } from './plan-tree';

// Builds an aggregate explain whose first stage is a $cursor over a COLLSCAN of places.
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
            executionStages: { stage: 'COLLSCAN', nReturned: 10, docsExamined: 10 },
          },
        },
        nReturned: 10,
      },
      ...stages,
    ],
  };
}

function find(stage: PlanStage, name: string): PlanStage | undefined {
  if (stage.name === name) {
    return stage;
  }
  for (const child of stage.children) {
    const hit = find(child, name);
    if (hit !== undefined) {
      return hit;
    }
  }
  return undefined;
}

describe('normaliseExplain sub-trees of aggregate stages', () => {
  it('models the inner pipeline of a $lookup as a labelled child chain', () => {
    const tree = normaliseExplain(
      aggregateDoc([
        {
          $lookup: {
            from: 'customers',
            as: 'm',
            pipeline: [{ $match: { tier: 'gold' } }, { $limit: 3 }],
          },
          nReturned: 10,
        },
      ]),
    );
    const lookup = tree.winning;
    expect(lookup.name).toBe('$lookup');
    const inner = lookup.children.find((child) => child.label !== undefined);
    expect(inner?.label).toBe('inner pipeline of $lookup from customers');
    expect(inner?.name).toBe('$limit');
    expect(inner?.children[0]?.name).toBe('$match');
  });

  it('models each $facet branch as a labelled child with the branch name', () => {
    const tree = normaliseExplain(
      aggregateDoc([
        {
          $facet: {
            byRating: [{ $sortByCount: '$rating' }],
            total: [{ $count: 'n' }],
          },
        },
      ]),
    );
    const branches = tree.winning.children.filter((child) => child.label !== undefined);
    expect(branches.map((child) => child.label)).toEqual([
      '$facet branch byRating',
      '$facet branch total',
    ]);
    expect(branches[0]?.name).toBe('$sortByCount');
    expect(branches[1]?.name).toBe('$count');
  });

  it('models each $unionWith input from its own cursor plan', () => {
    const tree = normaliseExplain(
      aggregateDoc([
        {
          $unionWith: {
            coll: 'customers',
            pipeline: [
              {
                $cursor: {
                  queryPlanner: {
                    namespace: 'shop.customers',
                    winningPlan: { stage: 'COLLSCAN', direction: 'forward' },
                    rejectedPlans: [],
                  },
                  executionStats: {
                    executionStages: { stage: 'COLLSCAN', nReturned: 4, docsExamined: 300 },
                  },
                },
              },
            ],
          },
          nReturned: 14,
        },
      ]),
    );
    const union = tree.winning;
    expect(union.name).toBe('$unionWith');
    expect(union.children[1]?.label).toBe('union input from customers');
    expect(union.children[1]?.name).toBe('COLLSCAN');
    expect(union.children[1]?.docsExamined).toBe(300);
  });

  it('reads the query of a $geoNear from its own cursor key', () => {
    const doc = {
      stages: [
        {
          $geoNearCursor: {
            queryPlanner: {
              namespace: 'shop.places',
              winningPlan: { stage: 'GEO_NEAR_2DSPHERE', indexName: 'loc_2dsphere' },
              rejectedPlans: [],
            },
          },
        },
        { $limit: 5 },
      ],
    };
    const tree = normaliseExplain(doc);
    expect(tree.command).toBe('aggregate');
    expect(tree.winning.name).toBe('$limit');
    expect(find(tree.winning, '$geoNearCursor')?.children[0]?.name).toBe('GEO_NEAR_2DSPHERE');
    expect(tree.summary.indexesUsed).toEqual(['loc_2dsphere']);
  });

  it('keeps the raw input of an unrecognised aggregate as an UNKNOWN tree', () => {
    const raw = { stages: [{ $unknownStage: { a: 1 } }] };
    const tree = normaliseExplain(raw);
    expect(tree.command).toBe('unknown');
    expect(tree.winning.name).toBe('UNKNOWN');
    expect(tree.winning.raw).toBe(raw);
  });
});

describe('normaliseExplain spill metrics', () => {
  it('reads the spill counters of a $group, and the largest accumulator as memory', () => {
    const tree = normaliseExplain(
      aggregateDoc([
        {
          $group: { _id: '$name', n: { $sum: 1 } },
          maxAccumulatorMemoryUsageBytes: { n: 640, other: 120 },
          usedDisk: true,
          spills: 3,
          spilledDataStorageSize: 4096,
          nReturned: 10,
        },
      ]),
    );
    const group = tree.winning;
    expect(group.name).toBe('$group');
    expect(group.usedDisk).toBe(true);
    expect(group.spills).toBe(3);
    expect(group.spilledBytes).toBe(4096);
    expect(group.memUsageBytes).toBe(640);
  });

  it('reads the spill counters of a $sort that spilled', () => {
    const tree = normaliseExplain(
      aggregateDoc([
        {
          $sort: { sortKey: { name: 1 } },
          totalDataSizeSortedBytesEstimate: 1784070,
          usedDisk: true,
          spills: 59,
          spilledBytes: 1151770,
          nReturned: 10,
        },
      ]),
    );
    const sort = tree.winning;
    expect(sort.name).toBe('$sort');
    expect(sort.spills).toBe(59);
    expect(sort.spilledBytes).toBe(1151770);
    expect(sort.memUsageBytes).toBe(1784070);
    expect(sort.usedDisk).toBe(true);
  });

  it('leaves the spill fields absent when the server reports none', () => {
    const tree = normaliseExplain(aggregateDoc([{ $group: { _id: null }, nReturned: 1 }]));
    expect(tree.winning.usedDisk).toBeUndefined();
    expect(tree.winning.spills).toBeUndefined();
    expect(tree.winning.spilledBytes).toBeUndefined();
  });
});

describe('normaliseExplain edge cases', () => {
  it('keeps an empty $facet branch as an empty labelled node', () => {
    const tree = normaliseExplain(
      aggregateDoc([{ $facet: { none: [], total: [{ $count: 'n' }] }, nReturned: 1 }]),
    );
    const branches = tree.winning.children.filter((child) => child.label !== undefined);
    expect(branches.map((child) => child.label)).toEqual([
      '$facet branch none',
      '$facet branch total',
    ]);
    expect(branches[0]?.children).toEqual([]);
  });

  it('keeps a failed shard as a labelled node that carries its error', () => {
    const tree = normaliseExplain({
      queryPlanner: {
        winningPlan: {
          shards: [
            { shardName: 's1', winningPlan: { stage: 'COLLSCAN' } },
            { shardName: 's2', error: { errmsg: 'boom' } },
          ],
        },
      },
    });
    const failed = tree.winning.children.find((child) => child.label === 'shard s2');
    expect(failed?.name).toBe('SHARD_ERROR');
    expect(failed?.raw).toEqual({ shardName: 's2', error: { errmsg: 'boom' } });
    expect(tree.winning.children.map((child) => child.label)).toEqual(['shard s1', 'shard s2']);
    expect(tree.sharded).toBe(true);
  });

  it('makes a non-string stage name UNKNOWN and still normalises its inputs', () => {
    const tree = normaliseExplain({
      queryPlanner: {
        namespace: 'shop.orders',
        winningPlan: { stage: 5, inputStage: { stage: 'IXSCAN', indexName: 'status_1' } },
        rejectedPlans: [],
      },
    });
    expect(tree.command).toBe('find');
    expect(tree.winning.name).toBe('UNKNOWN');
    expect(tree.winning.children[0]?.name).toBe('IXSCAN');
    expect(tree.summary.indexesUsed).toEqual(['status_1']);
  });
});
