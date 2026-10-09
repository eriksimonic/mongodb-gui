import { describe, expect, it } from 'vitest';
import { normaliseExplain } from './normalise';
import { PlanTreeSchema } from './plan-tree';
import { flattenStages } from './stage-walk';

function parsed(raw: unknown) {
  const tree = normaliseExplain(raw);
  expect(PlanTreeSchema.safeParse(tree).success).toBe(true);
  return tree;
}

describe('normaliseExplain on unknown input', () => {
  it.each([
    ['null', null],
    ['an empty object', {}],
    ['an empty array', []],
    ['a string', 'explain'],
    ['a number', 42],
    ['a queryPlanner without a winning plan', { queryPlanner: {} }],
    ['a winning plan without a stage', { queryPlanner: { winningPlan: {} } }],
    ['an aggregate without a $cursor', { stages: [{ $match: {} }] }],
  ])('yields an unknown tree for %s and keeps the input as the raw', (_label, raw) => {
    const tree = parsed(raw);
    expect(tree.command).toBe('unknown');
    expect(tree.engine).toBe('unknown');
    expect(tree.winning.name).toBe('UNKNOWN');
    expect(tree.winning.children).toEqual([]);
    expect(tree.winning.raw).toBe(raw);
    expect(tree.warnings.map((warning) => warning.code)).toEqual(['NO_EXECUTION_STATS']);
  });

  it('turns a value that throws on access into an unknown tree', () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error('boom');
        },
      },
    );
    const tree = parsed(hostile);
    expect(tree.command).toBe('unknown');
    expect(tree.winning.raw).toBe(hostile);
  });
});

describe('normaliseExplain on classic find output', () => {
  const planner = {
    namespace: 'shop.orders',
    winningPlan: {
      stage: 'FETCH',
      filter: { status: 'paid' },
      inputStage: {
        stage: 'IXSCAN',
        indexName: 'status_1',
        keyPattern: { status: 1 },
        isMultiKey: false,
        direction: 'forward',
        indexBounds: { status: ['["paid", "paid"]'] },
      },
    },
    rejectedPlans: [],
  };

  it('reads the command from the echo and the server version from serverInfo', () => {
    const tree = parsed({
      queryPlanner: planner,
      command: { find: 'orders', $db: 'shop' },
      serverInfo: { version: '6.0.28' },
    });
    expect(tree.command).toBe('find');
    expect(tree.serverVersion).toBe('6.0.28');
    expect(tree.engine).toBe('classic');
    expect(tree.verbosity).toBe('queryPlanner');
  });

  it('copies planner fields onto the stages', () => {
    const tree = parsed({ queryPlanner: planner, command: { find: 'orders', $db: 'shop' } });
    expect(tree.winning.name).toBe('FETCH');
    expect(tree.winning.filter).toEqual({ status: 'paid' });
    const scan = tree.winning.children[0];
    expect(scan).toMatchObject({
      name: 'IXSCAN',
      index: 'status_1',
      isMultiKey: false,
      direction: 'forward',
      indexBounds: { status: ['["paid", "paid"]'] },
    });
    expect(tree.summary.indexesUsed).toEqual(['status_1']);
  });

  it('takes the namespace from the planner, or from the command when the planner has none', () => {
    const fromPlanner = parsed({ queryPlanner: { ...planner, namespace: 'a.b' } });
    expect(fromPlanner.namespace).toBe('a.b');
    const fromCommand = parsed({
      queryPlanner: { winningPlan: planner.winningPlan },
      command: { find: 'orders', $db: 'shop' },
    });
    expect(fromCommand.namespace).toBe('shop.orders');
  });

  it('gives an empty namespace when neither the planner nor the command has one', () => {
    expect(parsed({ queryPlanner: { winningPlan: planner.winningPlan } }).namespace).toBe('');
  });

  it('merges execution counters onto the planner tree by position', () => {
    const tree = parsed({
      queryPlanner: planner,
      executionStats: {
        nReturned: 5,
        executionTimeMillis: 2,
        totalKeysExamined: 5,
        totalDocsExamined: 5,
        executionStages: {
          stage: 'FETCH',
          nReturned: 5,
          docsExamined: 5,
          executionTimeMillisEstimate: 1,
          inputStage: {
            stage: 'IXSCAN',
            nReturned: 5,
            keysExamined: 5,
            executionTimeMillisEstimate: 1,
          },
        },
      },
    });
    expect(tree.verbosity).toBe('executionStats');
    expect(tree.winning).toMatchObject({
      name: 'FETCH',
      docsExamined: 5,
      nReturned: 5,
      executionTimeMs: 1,
    });
    expect(tree.winning.children[0]).toMatchObject({
      name: 'IXSCAN',
      keysExamined: 5,
      index: 'status_1',
      indexBounds: { status: ['["paid", "paid"]'] },
    });
    expect(tree.summary).toMatchObject({
      keysExamined: 5,
      docsExamined: 5,
      nReturned: 5,
      executionTimeMs: 2,
      totalDocsExaminedToReturnedRatio: 1,
    });
  });

  it('reports allPlansExecution when the execution block carries it', () => {
    const tree = parsed({
      queryPlanner: planner,
      executionStats: { nReturned: 0, executionTimeMillis: 0, allPlansExecution: [] },
    });
    expect(tree.verbosity).toBe('allPlansExecution');
  });

  it('keeps rejected plans as their own trees', () => {
    const tree = parsed({
      queryPlanner: {
        ...planner,
        rejectedPlans: [
          { stage: 'COLLSCAN', filter: {} },
          { stage: 'IXSCAN', indexName: 'other_1' },
        ],
      },
    });
    expect(tree.rejected.map((stage) => stage.name)).toEqual(['COLLSCAN', 'IXSCAN']);
    expect(tree.rejected[1]?.index).toBe('other_1');
  });

  it('reads EJSON number wrappers in the counters', () => {
    const tree = parsed({
      queryPlanner: planner,
      executionStats: {
        nReturned: { $numberInt: '3' },
        executionTimeMillis: { $numberLong: '7' },
        totalKeysExamined: { $numberLong: '3' },
        totalDocsExamined: { $numberDouble: '3.0' },
      },
    });
    expect(tree.summary).toMatchObject({
      nReturned: 3,
      executionTimeMs: 7,
      keysExamined: 3,
      docsExamined: 3,
    });
  });

  it('keeps the planner stage when the execution tree names a different stage', () => {
    const tree = parsed({
      queryPlanner: planner,
      executionStats: {
        executionStages: { stage: 'LIMIT', nReturned: 1 },
      },
    });
    expect(tree.winning.name).toBe('LIMIT');
    expect(tree.winning.children).toEqual([]);
  });

  it('builds OR and SUBPLAN children from inputStages', () => {
    const tree = parsed({
      queryPlanner: {
        winningPlan: {
          stage: 'SUBPLAN',
          inputStage: {
            stage: 'FETCH',
            inputStage: {
              stage: 'OR',
              inputStages: [
                { stage: 'IXSCAN', indexName: 'a_1' },
                { stage: 'IXSCAN', indexName: 'b_1' },
              ],
            },
          },
        },
      },
    });
    const or = tree.winning.children[0]?.children[0];
    expect(or?.children.map((child) => child.index)).toEqual(['a_1', 'b_1']);
    expect(tree.summary.indexesUsed).toEqual(['a_1', 'b_1']);
  });

  it('detects count, distinct, update and delete from the winning stage when there is no echo', () => {
    const cases: [string, string][] = [
      ['COUNT', 'count'],
      ['DISTINCT_SCAN', 'distinct'],
      ['UPDATE', 'update'],
      ['DELETE', 'delete'],
      ['BATCHED_DELETE', 'delete'],
      ['FETCH', 'find'],
    ];
    for (const [stageName, command] of cases) {
      const tree = parsed({ queryPlanner: { winningPlan: { stage: stageName } } });
      expect(tree.command, stageName).toBe(command);
    }
  });

  it('prefers the command echo over the winning stage', () => {
    const tree = parsed({
      queryPlanner: { winningPlan: { stage: 'FETCH' } },
      command: { distinct: 'orders', key: 'customerId', $db: 'shop' },
    });
    expect(tree.command).toBe('distinct');
  });

  it('ignores an echo that is not a known command', () => {
    const tree = parsed({
      queryPlanner: { winningPlan: { stage: 'UPDATE' } },
      command: { getMore: 1 },
    });
    expect(tree.command).toBe('update');
  });
});

describe('normaliseExplain on slot-based engine output', () => {
  it('uses the classic plan for structure and takes the slot-based scan filter and index facts', () => {
    const tree = parsed({
      queryPlanner: {
        winningPlan: {
          queryPlan: {
            stage: 'FETCH',
            inputStage: {
              stage: 'IXSCAN',
              indexName: 'items.sku_1',
              isMultiKey: true,
              direction: 'forward',
              indexBounds: { 'items.sku': ['["A1", "A1"]'] },
            },
          },
          slotBasedPlan: { stages: 'opaque' },
        },
      },
      executionStats: {
        executionTimeMillis: 1,
        executionStages: {
          stage: 'nlj',
          nReturned: 4,
          outerStage: { stage: 'scan', nReturned: 4, numReads: 4 },
          innerStage: {
            stage: 'ixseek',
            indexName: 'items.sku_1',
            keysExamined: 4,
            nReturned: 4,
          },
        },
      },
    });
    expect(tree.engine).toBe('sbe');
    expect(tree.winning.name).toBe('nlj');
    const scan = tree.winning.children[0];
    expect(scan).toMatchObject({ name: 'scan', docsExamined: 4 });
    const seek = tree.winning.children[1];
    expect(seek).toMatchObject({
      name: 'ixseek',
      index: 'items.sku_1',
      keysExamined: 4,
      isMultiKey: true,
      indexBounds: { 'items.sku': ['["A1", "A1"]'] },
    });
    expect(tree.summary.collectionScan).toBe(true);
    expect(tree.summary.indexesUsed).toEqual(['items.sku_1']);
  });

  it('gives a scan the query filter of the classic collection scan, in order', () => {
    const tree = parsed({
      queryPlanner: {
        winningPlan: {
          queryPlan: {
            stage: 'COLLSCAN',
            filter: { total: { $gt: 5 } },
          },
          slotBasedPlan: {},
        },
      },
      executionStats: {
        executionStages: { stage: 'filter', inputStage: { stage: 'scan', numReads: 9 } },
      },
    });
    expect(tree.winning.children[0]?.filter).toEqual({ total: { $gt: 5 } });
    expect(tree.summary.docsExamined).toBeUndefined();
  });

  it('reads the sort memory counters of the slot-based sort', () => {
    const tree = parsed({
      queryPlanner: { winningPlan: { queryPlan: { stage: 'SORT' }, slotBasedPlan: {} } },
      executionStats: {
        executionStages: {
          stage: 'sort',
          memLimit: 100,
          totalDataSizeSorted: 95,
          usedDisk: false,
        },
      },
    });
    expect(tree.winning).toMatchObject({
      name: 'sort',
      memLimitBytes: 100,
      memUsageBytes: 95,
      usedDisk: false,
    });
    expect(tree.summary.inMemorySort).toBe(true);
  });
});

describe('normaliseExplain on aggregate output', () => {
  const cursor = {
    queryPlanner: {
      namespace: 'shop.orders',
      winningPlan: {
        stage: 'FETCH',
        inputStage: { stage: 'IXSCAN', indexName: 'status_1' },
      },
      rejectedPlans: [],
    },
    executionStats: {
      nReturned: 3,
      executionTimeMillis: 1,
      totalKeysExamined: 3,
      totalDocsExamined: 3,
      executionStages: { stage: 'FETCH', nReturned: 3, docsExamined: 3 },
    },
  };

  it('chains the pipeline stages above $cursor, last stage as the root', () => {
    const tree = parsed({
      stages: [
        { $cursor: cursor },
        { $group: { _id: 1 }, nReturned: 2, executionTimeMillisEstimate: 1 },
        { $sort: { sortKey: { spent: -1 } }, nReturned: 2, executionTimeMillisEstimate: 2 },
      ],
      command: { aggregate: 'orders', $db: 'shop' },
    });
    expect(tree.command).toBe('aggregate');
    expect(tree.namespace).toBe('shop.orders');
    expect(tree.winning.name).toBe('$sort');
    expect(tree.winning.children[0]?.name).toBe('$group');
    expect(tree.winning.children[0]?.children[0]?.name).toBe('$cursor');
    expect(flattenStages(tree.winning).map((stage) => stage.name)).toEqual([
      '$sort',
      '$group',
      '$cursor',
      'FETCH',
      'IXSCAN',
    ]);
    expect(tree.summary).toMatchObject({
      inMemorySort: true,
      indexesUsed: ['status_1'],
      nReturned: 2,
      executionTimeMs: 2,
    });
    expect(tree.summary.docsExamined).toBe(3);
  });

  it('uses the top-level totals when the document has them', () => {
    const tree = parsed({
      stages: [{ $cursor: cursor }, { $limit: 2, nReturned: 2 }],
      executionStats: {
        nReturned: 2,
        executionTimeMillis: 9,
        totalDocsExamined: 40,
        totalKeysExamined: 41,
      },
    });
    expect(tree.summary).toMatchObject({
      nReturned: 2,
      executionTimeMs: 9,
      docsExamined: 40,
      keysExamined: 41,
    });
  });

  it('reads $lookup index usage from its indexesUsed array', () => {
    const tree = parsed({
      stages: [
        { $cursor: { queryPlanner: { winningPlan: { stage: 'COLLSCAN' } } } },
        {
          $lookup: { from: 'orders', as: 'x', localField: 'a', foreignField: 'b' },
          indexesUsed: ['b_1'],
          totalDocsExamined: 100,
        },
      ],
    });
    expect(tree.summary.indexesUsed).toEqual(['b_1']);
    expect(tree.summary.collectionScan).toBe(true);
    expect(tree.verbosity).toBe('queryPlanner');
  });

  it('marks a pipeline stage that is not an object as absent', () => {
    const tree = parsed({ stages: [{ $cursor: cursor }, 'not-a-stage'] });
    expect(tree.winning.name).toBe('$cursor');
  });

  it('reads a slot-based aggregate with a top-level plan', () => {
    const tree = parsed({
      queryPlanner: {
        namespace: 'shop.orders',
        winningPlan: {
          queryPlan: {
            stage: 'EQ_LOOKUP',
            indexName: 'customerId_1_createdAt_-1',
            inputStage: { stage: 'COLLSCAN' },
          },
          slotBasedPlan: {},
        },
      },
      command: { aggregate: 'orders', pipeline: [], cursor: {}, $db: 'shop' },
    });
    expect(tree.command).toBe('aggregate');
    expect(tree.engine).toBe('sbe');
    expect(tree.summary.indexesUsed).toEqual(['customerId_1_createdAt_-1']);
  });
});

describe('normaliseExplain on sharded output', () => {
  const shard = (name: string, stage: string) => ({
    shardName: name,
    winningPlan: { stage, inputStage: { stage: 'IXSCAN', indexName: 'i_1' } },
  });

  it('gives each shard subtree its own shard name and marks the tree sharded', () => {
    const tree = parsed({
      queryPlanner: { winningPlan: { shards: [shard('rs0', 'FETCH'), shard('rs1', 'FETCH')] } },
    });
    expect(tree.sharded).toBe(true);
    expect(tree.winning.name).toBe('SHARD_MERGE');
    expect(tree.winning.children.map((child) => child.shard)).toEqual(['rs0', 'rs1']);
    expect(tree.winning.children[0]?.children[0]?.shard).toBe('rs0');
    expect(tree.summary.indexesUsed).toEqual(['i_1']);
  });

  it('names a shard by its position when the entry has no name', () => {
    const tree = parsed({
      queryPlanner: {
        winningPlan: { stage: 'SHARD_MERGE_SORT', shards: [{ winningPlan: { stage: 'FETCH' } }] },
      },
    });
    expect(tree.winning.name).toBe('SHARD_MERGE_SORT');
    expect(tree.winning.children[0]?.shard).toBe('shard0');
  });

  it('pairs execution shards with planner shards by position', () => {
    const tree = parsed({
      queryPlanner: { winningPlan: { shards: [shard('rs0', 'FETCH')] } },
      executionStats: {
        nReturned: 4,
        executionStages: {
          stage: 'SHARD_MERGE',
          shards: [
            {
              shardName: 'rs0',
              executionStages: { stage: 'FETCH', nReturned: 4, docsExamined: 4 },
            },
          ],
        },
      },
    });
    expect(tree.winning.children[0]).toMatchObject({
      name: 'FETCH',
      docsExamined: 4,
      shard: 'rs0',
    });
  });
});

describe('normaliseExplain on count, distinct, update and delete output', () => {
  it('reads a count plan with execution counters', () => {
    const tree = parsed({
      queryPlanner: {
        winningPlan: { stage: 'COUNT', inputStage: { stage: 'COUNT_SCAN', indexName: 's_1' } },
      },
      executionStats: {
        nReturned: 0,
        executionTimeMillis: 0,
        totalKeysExamined: 6,
        totalDocsExamined: 0,
      },
    });
    expect(tree.command).toBe('count');
    expect(tree.summary).toMatchObject({ keysExamined: 6, docsExamined: 0, nReturned: 0 });
  });

  it('reads an update plan with the write stage on top', () => {
    const tree = parsed({
      queryPlanner: {
        winningPlan: { stage: 'UPDATE', inputStage: { stage: 'IXSCAN', indexName: 's_1' } },
      },
      command: { update: 'orders', updates: [] },
    });
    expect(tree.command).toBe('update');
    expect(tree.winning.children[0]?.index).toBe('s_1');
  });
});
