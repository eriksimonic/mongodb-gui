import { describe, expect, it } from 'vitest';
import { explainInWords } from './explain-text';
import { normaliseExplain } from './normalise';
import { PlanTreeSchema } from './plan-tree';

// Keys the normaliser reads, so random objects reach its branches often.
const KEYS = [
  'queryPlanner',
  'winningPlan',
  'queryPlan',
  'slotBasedPlan',
  'rejectedPlans',
  'stage',
  'inputStage',
  'inputStages',
  'shards',
  'shardName',
  'executionStats',
  'executionStages',
  'allPlansExecution',
  'stages',
  '$cursor',
  '$sort',
  'command',
  'serverInfo',
  'version',
  'nReturned',
  'docsExamined',
  'keysExamined',
  'indexName',
  'filter',
  'direction',
  'indexBounds',
  'transformBy',
  'usedDisk',
  'isMultiKey',
  'memLimit',
  '$numberInt',
];
const STAGES = [
  'FETCH',
  'IXSCAN',
  'COLLSCAN',
  'SORT',
  'sort',
  'scan',
  'COUNT',
  'UPDATE',
  'SHARD_MERGE',
];

// Small seeded generator, so a failing case can be replayed from its seed.
function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function randomValue(next: () => number, depth: number): unknown {
  const pick = next();
  if (depth <= 0 || pick < 0.25) {
    const scalars: unknown[] = [
      null,
      true,
      false,
      0,
      -1,
      2.5,
      'FETCH',
      '',
      'text',
      { $numberLong: '3' },
    ];
    return scalars[Math.floor(next() * scalars.length)];
  }
  if (pick < 0.4) {
    const length = Math.floor(next() * 4);
    return Array.from({ length }, () => randomValue(next, depth - 1));
  }
  const object: Record<string, unknown> = {};
  const count = 1 + Math.floor(next() * 4);
  for (let index = 0; index < count; index += 1) {
    const key = KEYS[Math.floor(next() * KEYS.length)];
    if (key === undefined) {
      continue;
    }
    object[key] =
      key === 'stage' ? STAGES[Math.floor(next() * STAGES.length)] : randomValue(next, depth - 1);
  }
  return object;
}

// A chain of nested plan nodes, deeper than any real plan.
function deepPlan(depth: number): unknown {
  let node: Record<string, unknown> = { stage: 'COLLSCAN', filter: { a: 1 } };
  for (let level = 0; level < depth; level += 1) {
    node = { stage: 'FETCH', inputStage: node };
  }
  return { queryPlanner: { winningPlan: node }, executionStats: { executionStages: node } };
}

describe('normaliseExplain never throws', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['an empty object', {}],
    ['an empty array', []],
    ['an empty string', ''],
    ['a string', 'queryPlanner'],
    ['a number', Number.NaN],
    ['a boolean', true],
    ['a nested empty array', [[[]]]],
    ['an object of nulls', { queryPlanner: null, executionStats: null, stages: null }],
    ['a stages array of nulls', { stages: [null, null] }],
    ['a winning plan that is a string', { queryPlanner: { winningPlan: 'FETCH' } }],
    ['a winning plan with a non-array shards', { queryPlanner: { winningPlan: { shards: 'x' } } }],
  ])('accepts %s and returns a valid tree', (_label, raw) => {
    const tree = normaliseExplain(raw);
    expect(PlanTreeSchema.safeParse(tree).success).toBe(true);
    expect(() => explainInWords(tree)).not.toThrow();
  });

  it('handles a plan nested 400 stages deep', () => {
    const tree = normaliseExplain(deepPlan(400));
    expect(PlanTreeSchema.safeParse(tree).success).toBe(true);
    expect(tree.command).toBe('find');
  });

  it('handles 500 random nested objects without throwing', () => {
    const next = generator(20260901);
    for (let trial = 0; trial < 500; trial += 1) {
      const raw = randomValue(next, 12);
      const tree = normaliseExplain(raw);
      const parsed = PlanTreeSchema.safeParse(tree);
      if (!parsed.success) {
        throw new Error(`trial ${trial} produced an invalid tree: ${parsed.error.message}`);
      }
      expect(() => explainInWords(tree)).not.toThrow();
    }
  });

  it('wraps random plan-shaped objects that include the winning plan keys', () => {
    const next = generator(7);
    for (let trial = 0; trial < 300; trial += 1) {
      const raw = {
        queryPlanner: { winningPlan: randomValue(next, 10) },
        executionStats: randomValue(next, 6),
      };
      expect(PlanTreeSchema.safeParse(normaliseExplain(raw)).success).toBe(true);
    }
  });
});
