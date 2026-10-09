import { describe, expect, it } from 'vitest';
import {
  PlanStageSchema,
  PlanSummarySchema,
  PlanTreeSchema,
  PlanWarningSchema,
  type PlanTree,
} from './plan-tree';

const minimal: PlanTree = {
  command: 'find',
  namespace: 'shop.orders',
  verbosity: 'executionStats',
  engine: 'classic',
  serverVersion: '8.0.17',
  winning: {
    name: 'FETCH',
    docsExamined: 2,
    children: [{ name: 'IXSCAN', index: 'status_1', children: [], raw: { stage: 'IXSCAN' } }],
    raw: { stage: 'FETCH' },
  },
  rejected: [],
  summary: { indexesUsed: ['status_1'], inMemorySort: false, collectionScan: false },
  warnings: [{ code: 'MULTIKEY_INDEX', severity: 'info', message: 'x', stageName: 'IXSCAN' }],
  sharded: false,
};

describe('PlanTreeSchema', () => {
  it('accepts a complete tree', () => {
    expect(PlanTreeSchema.safeParse(minimal).success).toBe(true);
  });

  it('accepts a tree without the optional server version', () => {
    const { serverVersion, ...rest } = minimal;
    expect(serverVersion).toBe('8.0.17');
    expect(PlanTreeSchema.safeParse(rest).success).toBe(true);
  });

  it('rejects an unknown command', () => {
    expect(PlanTreeSchema.safeParse({ ...minimal, command: 'drop' }).success).toBe(false);
  });

  it('rejects an unknown engine and verbosity', () => {
    expect(PlanTreeSchema.safeParse({ ...minimal, engine: 'bonsai' }).success).toBe(false);
    expect(PlanTreeSchema.safeParse({ ...minimal, verbosity: 'verbose' }).success).toBe(false);
  });

  it('rejects a warning code that is not in the union', () => {
    const bad = { ...minimal, warnings: [{ code: 'MADE_UP', severity: 'info', message: 'x' }] };
    expect(PlanTreeSchema.safeParse(bad).success).toBe(false);
  });

  it('requires the raw field on every stage, including nested ones', () => {
    const nested = {
      ...minimal,
      winning: { name: 'FETCH', children: [{ name: 'IXSCAN', children: [] }], raw: {} },
    };
    expect(PlanTreeSchema.safeParse(nested).success).toBe(false);
  });

  it('keeps the raw value of a stage unchanged', () => {
    const parsed = PlanTreeSchema.parse(minimal);
    expect(parsed.winning.raw).toEqual({ stage: 'FETCH' });
  });
});

describe('PlanStageSchema', () => {
  it('rejects a stage with a non-numeric counter', () => {
    const bad = { name: 'X', docsExamined: '2', children: [], raw: {} };
    expect(PlanStageSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects an indexBounds value that is not a string array', () => {
    const bad = { name: 'X', indexBounds: { a: [1] }, children: [], raw: {} };
    expect(PlanStageSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a direction other than forward or backward', () => {
    const bad = { name: 'X', direction: 'up', children: [], raw: {} };
    expect(PlanStageSchema.safeParse(bad).success).toBe(false);
  });
});

describe('PlanSummarySchema and PlanWarningSchema', () => {
  it('requires the boolean summary flags', () => {
    expect(PlanSummarySchema.safeParse({ indexesUsed: [] }).success).toBe(false);
    expect(
      PlanSummarySchema.safeParse({ indexesUsed: [], inMemorySort: false, collectionScan: true })
        .success,
    ).toBe(true);
  });

  it('accepts only the three severities', () => {
    const base = { code: 'COLLSCAN', message: 'x' };
    expect(PlanWarningSchema.safeParse({ ...base, severity: 'critical' }).success).toBe(true);
    expect(PlanWarningSchema.safeParse({ ...base, severity: 'error' }).success).toBe(false);
  });
});
