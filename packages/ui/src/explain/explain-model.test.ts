import { describe, expect, it } from 'vitest';
import type { PlanStage } from '@mongo-gui/core';
import {
  ancestorIds,
  applyLookupMeasures,
  lookupRuns,
  barPercent,
  commandCollection,
  createIndexLine,
  explainTitle,
  groupKey,
  hotStageId,
  planRows,
  revealKeys,
  stageIdByName,
  lookupIndexUse,
  planLayout,
  selfTimeMs,
  stageEntries,
  stageTags,
  stageDetail,
} from './explain-model';

function stage(
  name: string,
  extra: Partial<PlanStage> = {},
  children: PlanStage[] = [],
): PlanStage {
  return { name, children, raw: undefined, ...extra };
}

const TREE = stage('FETCH', { docsExamined: 10 }, [
  stage('IXSCAN', { keysExamined: 12, index: 'status_1' }),
  stage('SORT', { docsExamined: 40, executionTimeMs: 3 }),
]);

describe('explainTitle and commandCollection', () => {
  it('titles the panel with the collection, or the plain word without one', () => {
    expect(explainTitle('orders')).toBe('Explain · orders');
    expect(explainTitle(undefined)).toBe('Explain');
  });

  it('reads the collection from the first key of a command', () => {
    expect(commandCollection('{"find":"orders","filter":{}}')).toBe('orders');
    expect(commandCollection('{"filter":{},"find":"orders"}')).toBeUndefined();
    expect(commandCollection('not json')).toBeUndefined();
    expect(commandCollection('[1,2]')).toBeUndefined();
  });
});

describe('planRows', () => {
  it('lists every stage in order with its depth', () => {
    const rows = planRows(TREE, new Set());
    expect(rows.map((row) => [row.id, row.depth])).toEqual([
      ['0', 0],
      ['0.0', 1],
      ['0.1', 1],
    ]);
  });

  it('hides the descendants of a collapsed stage', () => {
    expect(planRows(TREE, new Set(['0'])).map((row) => row.id)).toEqual(['0']);
  });

  it('puts a labelled heading before each sub-tree and keeps the label as the normaliser gave it', () => {
    const sharded = stage('SHARD_MERGE', {}, [
      stage('FETCH', { shard: 'a', label: 'shard a' }, [stage('IXSCAN', { shard: 'a' })]),
      stage('FETCH', { shard: 'b', label: 'shard b' }),
    ]);
    const kinds = planRows(sharded, new Set()).map((row) =>
      row.kind === 'group' ? `group ${row.label}` : row.id,
    );
    expect(kinds).toEqual(['0', 'group shard a', '0.0', '0.0.0', 'group shard b', '0.1']);
  });

  it('shares one heading across consecutive siblings with the same label', () => {
    const lookup = stage('$lookup', {}, [
      stage('$match', { label: 'inner pipeline of $lookup from customers' }),
      stage('COLLSCAN', { label: 'inner pipeline of $lookup from customers' }),
    ]);
    const rows = planRows(lookup, new Set());
    expect(rows.filter((row) => row.kind === 'group')).toHaveLength(1);
    expect(rows.map((row) => row.id)).toEqual(['0', '0#group:0', '0.0', '0.1']);
  });

  it('hides a labelled sub-tree when its heading is collapsed', () => {
    const sharded = stage('SHARD_MERGE', {}, [
      stage('FETCH', { label: 'shard a' }, [stage('IXSCAN')]),
    ]);
    const rows = planRows(sharded, new Set([groupKey('0', 0)]));
    expect(rows.map((row) => row.id)).toEqual(['0', '0#group:0']);
    expect(rows[1]).toMatchObject({ kind: 'group', expanded: false });
  });

  it('does not add a heading for children without a label', () => {
    const rows = planRows(TREE, new Set());
    expect(rows.some((row) => row.kind === 'group')).toBe(false);
  });

  it('reveals a stage by opening its ancestors and the labelled groups above it', () => {
    const collapsed = new Set(['0', '0#group:0', '0.1', '0.1#group:1', '0.2']);
    expect([...revealKeys(collapsed, '0.1.0')]).toEqual(['0.2']);
  });
});

describe('hot stage and bars', () => {
  it('picks the stage with the most documents examined', () => {
    expect(hotStageId(TREE)).toBe('0.1');
  });

  it('picks the slowest stage when no stage reports documents', () => {
    const timed = stage('A', { executionTimeMs: 1 }, [stage('B', { executionTimeMs: 9 })]);
    expect(hotStageId(timed)).toBe('0.0');
  });

  it('gives no hot stage when every value is zero or unknown', () => {
    expect(hotStageId(stage('A'))).toBeUndefined();
  });

  it('scales bars to the largest value and gives zero for unknown values', () => {
    expect(barPercent(20, 40)).toBe(50);
    expect(barPercent(undefined, 40)).toBe(0);
    expect(barPercent(5, 0)).toBe(0);
  });
});

describe('selection helpers', () => {
  it('finds the first stage with a name', () => {
    expect(stageIdByName(TREE, 'IXSCAN')).toBe('0.0');
    expect(stageIdByName(TREE, 'COLLSCAN')).toBeUndefined();
  });

  it('lists the ancestors of a stage from the root down', () => {
    expect(ancestorIds('0.1.2')).toEqual(['0', '0.1']);
    expect(ancestorIds('0')).toEqual([]);
  });
});

describe('createIndexLine', () => {
  it('writes the keys in mongosh form', () => {
    expect(
      createIndexLine('orders', [
        ['status', 1],
        ['createdAt', -1],
      ]),
    ).toBe('db.orders.createIndex({ status: 1, createdAt: -1 })');
  });

  it('quotes field names that are not identifiers and uses getCollection for odd collections', () => {
    expect(createIndexLine('order-items', [['items.sku', 1]])).toBe(
      'db.getCollection("order-items").createIndex({ "items.sku": 1 })',
    );
  });
});

describe('planLayout', () => {
  it('puts the inputs one row down and centres a stage over its first and last input', () => {
    const layout = planLayout(TREE, new Set());
    const [root, scan, sort] = layout.nodes;
    expect(layout.nodes.map((node) => node.id)).toEqual(['0', '0.0', '0.1']);
    expect(scan?.y).toBe(sort?.y);
    expect(scan?.y).toBeGreaterThan(root?.y ?? 0);
    expect(root?.x).toBe(((scan?.x ?? 0) + (sort?.x ?? 0)) / 2);
    expect(layout.edges).toEqual([
      { from: '0', to: '0.0' },
      { from: '0', to: '0.1' },
    ]);
  });

  it('hides the inputs of a collapsed stage and counts them', () => {
    const layout = planLayout(TREE, new Set(['0']));
    expect(layout.nodes).toHaveLength(1);
    expect(layout.nodes[0]?.hidden).toBe(2);
    expect(layout.edges).toEqual([]);
  });
});

describe('selfTimeMs, stageTags and stageDetail', () => {
  const timed = stage('LIMIT', { executionTimeMs: 10, nReturned: 5 }, [
    stage('FETCH', { executionTimeMs: 8, nReturned: 50, docsExamined: 50 }, [
      stage('IXSCAN', { executionTimeMs: 1, nReturned: 50, index: 'status_1' }),
    ]),
  ]);

  it('takes the inputs off a stage time and never goes below zero', () => {
    expect(selfTimeMs(timed)).toBe(2);
    expect(
      selfTimeMs(stage('X', { executionTimeMs: 1 }, [stage('Y', { executionTimeMs: 3 })])),
    ).toBe(0);
    expect(selfTimeMs(stage('X'))).toBeUndefined();
  });

  it('marks the slowest, largest and most examined stage', () => {
    const tags = stageTags(stageEntries(timed));
    expect(tags.get('0.0')).toEqual(['slowest', 'most examined']);
    // FETCH and IXSCAN both return 50. The scan is nearer the data, so it gets the mark.
    expect(tags.get('0.0.0')).toEqual(['largest']);
    expect(tags.get('0')).toBeUndefined();
  });

  it('describes a stage by index, joined collection, group key or sort', () => {
    expect(stageDetail(stage('IXSCAN', { index: 'status_1' }))).toBe('status_1');
    expect(stageDetail(stage('$lookup', { raw: { $lookup: { from: 'customers' } } }))).toBe(
      'from customers',
    );
    expect(stageDetail(stage('$group', { raw: { $group: { _id: '$country' } } }))).toBe(
      'by "$country"',
    );
    expect(stageDetail(stage('SORT', { sortPattern: { createdAt: -1 } }))).toBe(
      'by {createdAt: -1}',
    );
    expect(stageDetail(stage('$limit', { raw: { $limit: { $numberInt: '3' } } }))).toBe('3');
  });
});

describe('lookupIndexUse', () => {
  it('reads the indexes and collection scans a $lookup reports', () => {
    const lookup = stage('$lookup', {
      raw: {
        $lookup: { from: 'reviews' },
        indexesUsed: ['_id_', 'productId_1_rating_-1'],
        collectionScans: { $numberLong: '0' },
      },
    });
    expect(lookupIndexUse(lookup)).toEqual({
      indexes: ['_id_', 'productId_1_rating_-1'],
      collectionScans: 0,
    });
    expect(lookupIndexUse(stage('FETCH', { raw: {} }))).toBeUndefined();
  });
});

describe('measured $lookup', () => {
  const lookup = stage(
    '$lookup',
    { nReturned: 100, raw: { $lookup: { from: 'customers', as: 'c' } } },
    [
      stage('COLLSCAN', { nReturned: 100, docsExamined: 100 }),
      stage('$match', { label: 'inner pipeline of $lookup from customers' }),
    ],
  );
  const root = stage('$project', {}, [lookup]);
  const inner = stage('FETCH', { docsExamined: 1, nReturned: 1, executionTimeMs: 2 }, [
    stage('IXSCAN', { keysExamined: 1, nReturned: 1 }),
  ]);

  it('counts the runs from the documents the input returns', () => {
    expect(lookupRuns(lookup)).toBe(100);
    expect(lookupRuns(stage('$lookup', { nReturned: 7 }))).toBe(7);
    expect(lookupRuns(stage('$lookup'))).toBe(1);
  });

  it('replaces the spec stages with the measured plan, scaled by the runs', () => {
    const applied = applyLookupMeasures(root, { '0.0': { state: 'measured', inner, runs: 100 } });
    const measured = applied.children[0]?.children ?? [];
    expect(measured.map((child) => child.name)).toEqual(['COLLSCAN', 'FETCH']);
    const fetch = measured[1];
    expect(fetch?.docsExamined).toBe(100);
    expect(fetch?.executionTimeMs).toBe(200);
    expect(fetch?.children[0]?.keysExamined).toBe(100);
    expect(fetch?.label).toContain('from customers');
    expect(fetch?.label).toContain('100 runs (estimate)');
  });

  it('keeps the spec stages while a measure is running or has failed', () => {
    const measuring = applyLookupMeasures(root, { '0.0': { state: 'measuring' } });
    const failed = applyLookupMeasures(root, { '0.0': { state: 'failed', reason: 'nested' } });
    for (const applied of [measuring, failed]) {
      expect(applied.children[0]?.children.map((child) => child.name)).toEqual([
        'COLLSCAN',
        '$match',
      ]);
    }
  });

  it('leaves the plan and the measure alone when nothing is measured', () => {
    expect(applyLookupMeasures(root, undefined)).toBe(root);
    expect(applyLookupMeasures(root, {})).toBe(root);
    applyLookupMeasures(root, { '0.0': { state: 'measured', inner, runs: 100 } });
    expect(inner.docsExamined).toBe(1);
  });
});
