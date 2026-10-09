import { describe, expect, it } from 'vitest';
import type { PlanStage, PlanSummary, PlanTree, PlanVerbosity } from './plan-tree';
import { deriveWarnings, sortSpilled } from './warnings';

function stage(name: string, overrides: Partial<PlanStage> = {}): PlanStage {
  return { name, children: [], raw: {}, ...overrides };
}

function tree(
  winning: PlanStage,
  options: {
    summary?: Partial<PlanSummary>;
    verbosity?: PlanVerbosity;
    rejected?: PlanStage[];
  } = {},
): Omit<PlanTree, 'warnings'> {
  return {
    command: 'find',
    namespace: 'shop.orders',
    verbosity: options.verbosity ?? 'executionStats',
    engine: 'classic',
    winning,
    rejected: options.rejected ?? [],
    summary: { indexesUsed: [], inMemorySort: false, collectionScan: false, ...options.summary },
    sharded: false,
  };
}

function codes(input: Omit<PlanTree, 'warnings'>): string[] {
  return deriveWarnings(input).map((warning) => warning.code);
}

describe('deriveWarnings', () => {
  it('returns no warnings for a clean indexed find with execution stats', () => {
    const input = tree(stage('FETCH', { docsExamined: 3, nReturned: 3, executionTimeMs: 0 }), {
      summary: { indexesUsed: ['status_1'], docsExamined: 3, nReturned: 3, executionTimeMs: 0 },
    });
    expect(deriveWarnings(input)).toEqual([]);
  });

  describe('COLLSCAN', () => {
    it('is a warning at exactly 1000 examined documents', () => {
      const input = tree(stage('COLLSCAN', { docsExamined: 1000 }), {
        summary: { collectionScan: true, docsExamined: 1000 },
      });
      expect(deriveWarnings(input)).toEqual([
        expect.objectContaining({ code: 'COLLSCAN', severity: 'warning', stageName: 'COLLSCAN' }),
      ]);
    });

    it('is critical above 1000 examined documents', () => {
      const input = tree(stage('COLLSCAN', { docsExamined: 1001 }), {
        summary: { collectionScan: true, docsExamined: 1001 },
      });
      expect(deriveWarnings(input)[0]?.severity).toBe('critical');
    });

    it('is critical when the examined count is unknown', () => {
      const input = tree(stage('COLLSCAN'), {
        verbosity: 'queryPlanner',
        summary: { collectionScan: true },
      });
      const warnings = deriveWarnings(input);
      expect(warnings.map((warning) => warning.code)).toEqual(['COLLSCAN', 'NO_EXECUTION_STATS']);
      expect(warnings[0]?.severity).toBe('critical');
    });

    it('falls back to the summary count when the stage has none', () => {
      const input = tree(stage('COLLSCAN'), {
        summary: { collectionScan: true, docsExamined: 5000 },
      });
      expect(deriveWarnings(input)[0]?.message).toContain('5000 documents');
    });
  });

  describe('IN_MEMORY_SORT and SORT_SPILLED', () => {
    it('is a warning for an in-memory sort that stays well inside its limit', () => {
      const input = tree(
        stage('SORT', { nReturned: 10, memLimitBytes: 1000, memUsageBytes: 100, usedDisk: false }),
        { summary: { inMemorySort: true, nReturned: 10 } },
      );
      expect(deriveWarnings(input)).toEqual([
        expect.objectContaining({ code: 'IN_MEMORY_SORT', severity: 'warning', stageName: 'SORT' }),
      ]);
    });

    it('is critical with SORT_SPILLED when the sort wrote to disk', () => {
      const input = tree(stage('SORT', { usedDisk: true }), { summary: { inMemorySort: true } });
      const warnings = deriveWarnings(input);
      expect(warnings.map((warning) => [warning.code, warning.severity])).toEqual([
        ['IN_MEMORY_SORT', 'critical'],
        ['SORT_SPILLED', 'critical'],
      ]);
      expect(warnings[1]?.message).toContain('spilled to disk');
    });

    it('is critical when memory use passes 90 percent of the limit', () => {
      const input = tree(stage('SORT', { memLimitBytes: 100, memUsageBytes: 91 }), {
        summary: { inMemorySort: true },
      });
      const warnings = deriveWarnings(input);
      expect(warnings.map((warning) => warning.code)).toEqual(['IN_MEMORY_SORT', 'SORT_SPILLED']);
      expect(warnings[1]?.message).toContain('90 percent');
    });

    it('stays a warning at exactly 90 percent of the limit', () => {
      const input = tree(stage('SORT', { memLimitBytes: 100, memUsageBytes: 90 }), {
        summary: { inMemorySort: true },
      });
      expect(codes(input)).toEqual(['IN_MEMORY_SORT']);
    });

    it('treats the $sort stage of an aggregate as an in-memory sort', () => {
      const input = tree(stage('$sort', { nReturned: 4 }), { summary: { inMemorySort: true } });
      expect(deriveWarnings(input)[0]?.message).toBe('The query sorts 4 documents in memory.');
    });
  });

  describe('sortSpilled', () => {
    it('reports none when no limit is known', () => {
      expect(sortSpilled(stage('SORT', { memUsageBytes: 999 }))).toBe('none');
    });

    it('reports disk before memory', () => {
      expect(
        sortSpilled(stage('SORT', { usedDisk: true, memLimitBytes: 100, memUsageBytes: 99 })),
      ).toBe('disk');
    });

    it('reports memory when usage is over 90 percent of a positive limit', () => {
      expect(sortSpilled(stage('SORT', { memLimitBytes: 10, memUsageBytes: 10 }))).toBe('memory');
      expect(sortSpilled(stage('SORT', { memLimitBytes: 0, memUsageBytes: 10 }))).toBe('none');
    });
  });

  describe('HIGH_EXAMINED_RATIO', () => {
    it('is not raised at exactly ten documents examined per returned document', () => {
      const input = tree(stage('FETCH'), { summary: { docsExamined: 100, nReturned: 10 } });
      expect(codes(input)).not.toContain('HIGH_EXAMINED_RATIO');
    });

    it('is raised above ten documents examined per returned document', () => {
      const input = tree(stage('FETCH'), { summary: { docsExamined: 101, nReturned: 10 } });
      const warning = deriveWarnings(input).find((item) => item.code === 'HIGH_EXAMINED_RATIO');
      expect(warning?.severity).toBe('warning');
      expect(warning?.message).toContain('a ratio of 10 to 1');
    });

    it('is not raised when nothing is returned', () => {
      const input = tree(stage('FETCH'), { summary: { docsExamined: 500, nReturned: 0 } });
      expect(codes(input)).not.toContain('HIGH_EXAMINED_RATIO');
    });

    it('is not raised when either count is unknown', () => {
      expect(codes(tree(stage('FETCH'), { summary: { docsExamined: 500 } }))).not.toContain(
        'HIGH_EXAMINED_RATIO',
      );
      expect(codes(tree(stage('FETCH'), { summary: { nReturned: 1 } }))).not.toContain(
        'HIGH_EXAMINED_RATIO',
      );
    });
  });

  describe('FETCH_AFTER_COVERED_INDEX', () => {
    const keyPattern = { customerId: 1, createdAt: -1 };

    function projectionPlan(
      transformBy: Record<string, unknown>,
      options: { fetchFilter?: unknown; keys?: Record<string, number> } = {},
    ): PlanStage {
      const scan = stage('IXSCAN', {
        index: 'customerId_1_createdAt_-1',
        raw: { keyPattern: options.keys ?? keyPattern },
      });
      const fetch = stage('FETCH', {
        children: [scan],
        ...(options.fetchFilter === undefined ? {} : { filter: options.fetchFilter }),
      });
      return stage('PROJECTION_SIMPLE', { raw: { transformBy }, children: [fetch] });
    }

    it('flags a projection that only needs indexed fields when _id is excluded', () => {
      const warnings = deriveWarnings(tree(projectionPlan({ customerId: 1, _id: 0 })));
      expect(warnings).toEqual([
        expect.objectContaining({
          code: 'FETCH_AFTER_COVERED_INDEX',
          severity: 'info',
          stageName: 'FETCH',
        }),
      ]);
    });

    it('does not flag when _id is not excluded', () => {
      expect(codes(tree(projectionPlan({ customerId: 1 })))).not.toContain(
        'FETCH_AFTER_COVERED_INDEX',
      );
    });

    it('does not flag when a projected field is outside the index key', () => {
      expect(codes(tree(projectionPlan({ customerId: 1, total: 1, _id: 0 })))).not.toContain(
        'FETCH_AFTER_COVERED_INDEX',
      );
    });

    it('does not flag an exclusion projection', () => {
      expect(codes(tree(projectionPlan({ customerId: 0, _id: 0 })))).not.toContain(
        'FETCH_AFTER_COVERED_INDEX',
      );
    });

    it('does not flag when the fetch has a filter', () => {
      expect(
        codes(tree(projectionPlan({ customerId: 1, _id: 0 }, { fetchFilter: { total: 1 } }))),
      ).not.toContain('FETCH_AFTER_COVERED_INDEX');
    });

    it('does not flag an empty projection', () => {
      expect(codes(tree(projectionPlan({ _id: 0 })))).not.toContain('FETCH_AFTER_COVERED_INDEX');
    });

    it('does not flag when the scan is not an index scan', () => {
      const plan = projectionPlan({ customerId: 1, _id: 0 });
      const fetch = plan.children[0];
      const scan = fetch?.children[0];
      if (scan === undefined || fetch === undefined) {
        throw new Error('fixture plan is incomplete');
      }
      const replaced = {
        ...plan,
        children: [{ ...fetch, children: [{ ...scan, name: 'COLLSCAN' }] }],
      };
      expect(codes(tree(replaced))).not.toContain('FETCH_AFTER_COVERED_INDEX');
    });
  });

  describe('MANY_REJECTED_PLANS', () => {
    it('is not raised for two rejected plans', () => {
      const input = tree(stage('FETCH'), { rejected: [stage('IXSCAN'), stage('IXSCAN')] });
      expect(codes(input)).not.toContain('MANY_REJECTED_PLANS');
    });

    it('is raised at three rejected plans', () => {
      const input = tree(stage('FETCH'), {
        rejected: [stage('IXSCAN'), stage('IXSCAN'), stage('COLLSCAN')],
      });
      expect(deriveWarnings(input)).toEqual([
        expect.objectContaining({ code: 'MANY_REJECTED_PLANS', severity: 'info' }),
      ]);
    });
  });

  describe('MULTIKEY_INDEX', () => {
    it('is an info warning on each multikey stage, with the index name', () => {
      const input = tree(
        stage('FETCH', { children: [stage('IXSCAN', { index: 'items.sku_1', isMultiKey: true })] }),
      );
      expect(deriveWarnings(input)).toEqual([
        expect.objectContaining({
          code: 'MULTIKEY_INDEX',
          severity: 'info',
          stageName: 'IXSCAN',
          message: expect.stringContaining('items.sku_1'),
        }),
      ]);
    });

    it('is not raised for a plain index', () => {
      expect(codes(tree(stage('IXSCAN', { isMultiKey: false })))).toEqual([]);
    });
  });

  describe('NO_EXECUTION_STATS', () => {
    it('is an info warning at queryPlanner verbosity only', () => {
      expect(codes(tree(stage('FETCH'), { verbosity: 'queryPlanner' }))).toEqual([
        'NO_EXECUTION_STATS',
      ]);
      expect(codes(tree(stage('FETCH'), { verbosity: 'executionStats' }))).toEqual([]);
      expect(codes(tree(stage('FETCH'), { verbosity: 'allPlansExecution' }))).toEqual([]);
    });
  });
});
