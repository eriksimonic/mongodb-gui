import type { PlanStage } from './plan-tree';

// Names of stages that sort in memory or on disk. The lowercase names are the slot-based engine.
const SORT_NAMES: ReadonlySet<string> = new Set(['SORT', 'sort', '$sort']);
const COLLECTION_SCAN_NAMES: ReadonlySet<string> = new Set(['COLLSCAN', 'scan']);
const FETCH_NAMES: ReadonlySet<string> = new Set(['FETCH', 'seek']);
const INDEX_SCAN_NAMES: ReadonlySet<string> = new Set(['IXSCAN', 'ixseek']);

// Returns the stage and all its descendants in pre-order.
export function flattenStages(stage: PlanStage): PlanStage[] {
  return [stage, ...stage.children.flatMap((child) => flattenStages(child))];
}

export function isSortStage(name: string): boolean {
  return SORT_NAMES.has(name);
}

export function isCollectionScanStage(name: string): boolean {
  return COLLECTION_SCAN_NAMES.has(name);
}

export function isFetchStage(name: string): boolean {
  return FETCH_NAMES.has(name);
}

export function isIndexScanStage(name: string): boolean {
  return INDEX_SCAN_NAMES.has(name);
}
