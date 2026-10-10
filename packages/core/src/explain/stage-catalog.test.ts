import { describe, expect, it } from 'vitest';
import { STAGE_CATEGORIES, STAGE_METRICS, describeStage, stageCatalog } from './stage-catalog';

// Every stage the plan asks the catalogue to cover, from the P3-4 task.
const REQUIRED_STAGES = [
  'COLLSCAN',
  'IXSCAN',
  'FETCH',
  'SORT',
  'SORT_MERGE',
  'SORT_KEY_GENERATOR',
  'PROJECTION_SIMPLE',
  'PROJECTION_COVERED',
  'PROJECTION_DEFAULT',
  'LIMIT',
  'SKIP',
  'OR',
  'AND_SORTED',
  'AND_HASH',
  'SUBPLAN',
  'CACHED_PLAN',
  'IDHACK',
  'CLUSTERED_IXSCAN',
  'EXPRESS_IXSCAN',
  'EXPRESS_CLUSTERED_IXSCAN',
  'EXPRESS_UPDATE',
  'EXPRESS_DELETE',
  'COUNT',
  'COUNT_SCAN',
  'DISTINCT_SCAN',
  'TEXT_MATCH',
  'TEXT_OR',
  'GEO_NEAR_2D',
  'GEO_NEAR_2DSPHERE',
  'SHARDING_FILTER',
  'SHARD_MERGE',
  'SHARD_MERGE_SORT',
  'EQ_LOOKUP',
  'UPDATE',
  'DELETE',
  'BATCHED_DELETE',
  '$_internalUnpackBucket',
  '$lookup',
  '$unionWith',
  '$facet',
  '$graphLookup',
  '$group',
  '$unwind',
  '$match',
  '$project',
  '$addFields',
  '$sort',
  '$limit',
  '$skip',
  '$count',
  '$out',
  '$merge',
  '$cursor',
];

describe('describeStage', () => {
  it.each(REQUIRED_STAGES)('describes %s with a category, a sentence and metrics', (name) => {
    const info = describeStage(name);
    expect(info.name).toBe(name);
    expect(info.category).not.toBe('unknown');
    expect(info.description.endsWith('.')).toBe(true);
    expect(info.metrics.length).toBeGreaterThan(0);
  });

  it('gives every catalogue entry a category from the fixed list and metrics from the fixed list', () => {
    for (const entry of stageCatalog()) {
      expect(STAGE_CATEGORIES).toContain(entry.category);
      for (const metric of entry.metrics) {
        expect(STAGE_METRICS).toContain(metric);
      }
    }
  });

  it('lists each stage name once', () => {
    const names = stageCatalog().map((entry) => entry.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('gives a name that is not listed the unknown category and names it', () => {
    const info = describeStage('MADE_UP_STAGE');
    expect(info.category).toBe('unknown');
    expect(info.description).toContain('MADE_UP_STAGE');
    expect(info.advice).toBeUndefined();
  });

  it('gives UNKNOWN the unknown category', () => {
    expect(describeStage('UNKNOWN').category).toBe('unknown');
  });

  it('gives advice to the stages that warrant it and none to a plain index scan', () => {
    expect(describeStage('COLLSCAN').advice).toContain('index');
    expect(describeStage('SORT').advice).toContain('spill');
    expect(describeStage('$group').advice).toContain('$match');
    expect(describeStage('IXSCAN').advice).toBeUndefined();
  });

  it('lists the spill metrics on the sort and group stages', () => {
    for (const name of ['SORT', '$sort', '$group', 'group', 'sort']) {
      expect(describeStage(name).metrics).toEqual(
        expect.arrayContaining(['usedDisk', 'spills', 'spilledBytes', 'memUsageBytes']),
      );
    }
  });

  it('gives the slot-based engine names a category', () => {
    expect(describeStage('nlj').category).toBe('lookup');
    expect(describeStage('ixseek').category).toBe('scan');
    expect(describeStage('hash_lookup').category).toBe('lookup');
  });
});
