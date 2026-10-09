import { describe, expect, it } from 'vitest';
import type { PlanStage } from './plan-tree';
import {
  flattenStages,
  isCollectionScanStage,
  isFetchStage,
  isIndexScanStage,
  isSortStage,
} from './stage-walk';

function stage(name: string, children: PlanStage[] = []): PlanStage {
  return { name, children, raw: {} };
}

describe('flattenStages', () => {
  it('returns the stage and its descendants in pre-order', () => {
    const tree = stage('A', [stage('B', [stage('C')]), stage('D')]);
    expect(flattenStages(tree).map((node) => node.name)).toEqual(['A', 'B', 'C', 'D']);
  });

  it('returns only the stage when it has no children', () => {
    expect(flattenStages(stage('A')).map((node) => node.name)).toEqual(['A']);
  });
});

describe('stage name predicates', () => {
  it('recognise sort stages in both engines and in aggregates', () => {
    expect(['SORT', 'sort', '$sort'].map(isSortStage)).toEqual([true, true, true]);
    expect(isSortStage('SORT_KEY_GENERATOR')).toBe(false);
  });

  it('recognise collection scans in both engines', () => {
    expect(['COLLSCAN', 'scan'].map(isCollectionScanStage)).toEqual([true, true]);
    expect(isCollectionScanStage('IXSCAN')).toBe(false);
  });

  it('recognise fetch stages, where the slot-based engine uses seek', () => {
    expect(['FETCH', 'seek'].map(isFetchStage)).toEqual([true, true]);
    expect(isFetchStage('ixseek')).toBe(false);
  });

  it('recognise index scans in both engines', () => {
    expect(['IXSCAN', 'ixseek'].map(isIndexScanStage)).toEqual([true, true]);
    expect(isIndexScanStage('FETCH')).toBe(false);
  });
});
