import type { PlanStage, PlanTree, PlanWarning } from './plan-tree';
import { asBoolean, readNumber } from './raw-values';
import { flattenStages, isCollectionScanStage, isSortStage } from './stage-walk';

export const COLLSCAN_CRITICAL_DOCS = 1000;
export const HIGH_RATIO_THRESHOLD = 10;
export const SORT_MEMORY_CRITICAL_FRACTION = 0.9;
export const MANY_REJECTED_THRESHOLD = 3;

// Derives the warnings for a plan. The thresholds are the exported constants above.
export function deriveWarnings(tree: Omit<PlanTree, 'warnings'>): PlanWarning[] {
  const stages = flattenStages(tree.winning);
  return [
    ...collectionScanWarnings(stages, tree),
    ...sortWarnings(stages, tree),
    ...examinedRatioWarnings(tree),
    ...coveredFetchWarnings(stages),
    ...rejectedPlanWarnings(tree),
    ...multikeyWarnings(stages),
    ...noExecutionStatsWarnings(tree),
  ];
}

// Critical only when the examined count is known and above the threshold. An unknown count is a
// warning, because the plan may still be small.
function collectionScanWarnings(
  stages: PlanStage[],
  tree: Omit<PlanTree, 'warnings'>,
): PlanWarning[] {
  return stages
    .filter((stage) => isCollectionScanStage(stage.name))
    .map((stage) => {
      const docs = stage.docsExamined ?? tree.summary.docsExamined;
      const critical = docs !== undefined && docs > COLLSCAN_CRITICAL_DOCS;
      const message =
        docs === undefined
          ? 'The query scans the whole collection. The examined count is unknown.'
          : `The query scans the whole collection and examines ${docs} documents.`;
      return {
        code: 'COLLSCAN',
        severity: critical ? 'critical' : 'warning',
        message,
        stageName: stage.name,
      };
    });
}

function sortWarnings(stages: PlanStage[], tree: Omit<PlanTree, 'warnings'>): PlanWarning[] {
  return stages
    .filter((stage) => isSortStage(stage.name))
    .flatMap((stage): PlanWarning[] => {
      const spilled = sortSpilled(stage);
      const count = stage.nReturned ?? tree.summary.nReturned;
      const subject = count === undefined ? 'documents' : `${count} documents`;
      const inMemory: PlanWarning = {
        code: 'IN_MEMORY_SORT',
        severity: spilled === 'none' ? 'warning' : 'critical',
        message: `The query sorts ${subject} in memory.`,
        stageName: stage.name,
      };
      if (spilled === 'none') {
        return [inMemory];
      }
      const spillMessage =
        spilled === 'disk'
          ? 'The sort spilled to disk.'
          : 'The sort uses more than 90 percent of its memory limit and may spill to disk.';
      return [
        inMemory,
        {
          code: 'SORT_SPILLED',
          severity: 'critical',
          message: spillMessage,
          stageName: stage.name,
        },
      ];
    });
}

// 'disk' when the sort wrote to disk, 'memory' when it nears its limit, 'none' otherwise.
export function sortSpilled(stage: PlanStage): 'disk' | 'memory' | 'none' {
  if (stage.usedDisk === true) {
    return 'disk';
  }
  const used = stage.memUsageBytes;
  const limit = stage.memLimitBytes;
  if (
    used !== undefined &&
    limit !== undefined &&
    limit > 0 &&
    used > limit * SORT_MEMORY_CRITICAL_FRACTION
  ) {
    return 'memory';
  }
  return 'none';
}

function examinedRatioWarnings(tree: Omit<PlanTree, 'warnings'>): PlanWarning[] {
  const docs = tree.summary.docsExamined;
  const returned = tree.summary.nReturned;
  if (docs === undefined || returned === undefined || returned <= 0) {
    return [];
  }
  const ratio = docs / returned;
  if (ratio <= HIGH_RATIO_THRESHOLD) {
    return [];
  }
  return [
    {
      code: 'HIGH_EXAMINED_RATIO',
      severity: 'warning',
      message: `The query examined ${docs} documents to return ${returned}, a ratio of ${Math.round(ratio)} to 1.`,
    },
  ];
}

// A PROJECTION_SIMPLE over a FETCH over an IXSCAN can skip the fetch when the index holds every
// projected field. The warning fires when _id is still returned, because then the index cannot
// cover the query, and the advice is to exclude _id. It never fires when _id is excluded.
function coveredFetchWarnings(stages: PlanStage[]): PlanWarning[] {
  return stages.flatMap((stage): PlanWarning[] => {
    if (stage.name !== 'PROJECTION_SIMPLE') {
      return [];
    }
    const fetch = stage.children[0];
    const scan = fetch?.children[0];
    if (
      fetch === undefined ||
      scan === undefined ||
      fetch.name !== 'FETCH' ||
      fetch.filter !== undefined ||
      scan.name !== 'IXSCAN' ||
      scan.isMultiKey === true ||
      stage.projection === undefined ||
      !couldCover(stage.projection, scan.indexKeys ?? [])
    ) {
      return [];
    }
    return [
      {
        code: 'FETCH_AFTER_COVERED_INDEX',
        severity: 'info',
        message: `Index ${scan.index ?? 'used by this query'} holds every projected field except _id, so the query still fetches whole documents.`,
        stageName: fetch.name,
      },
    ];
  });
}

// True when _id is returned, every other projected field is an inclusion, and the index key
// holds all of those fields. A projection with no fields besides _id does not qualify.
function couldCover(projection: Record<string, unknown>, keys: string[]): boolean {
  const idValue = projection['_id'];
  if (idValue !== undefined && (readNumber(idValue) === 0 || asBoolean(idValue) === false)) {
    return false;
  }
  const fields = Object.keys(projection).filter((field) => field !== '_id');
  if (fields.length === 0) {
    return false;
  }
  return fields.every((field) => {
    const value = projection[field];
    const included = readNumber(value) === 1 || asBoolean(value) === true;
    return included && keys.includes(field);
  });
}

function rejectedPlanWarnings(tree: Omit<PlanTree, 'warnings'>): PlanWarning[] {
  const count = tree.rejected.length;
  if (count < MANY_REJECTED_THRESHOLD) {
    return [];
  }
  return [
    {
      code: 'MANY_REJECTED_PLANS',
      severity: 'info',
      message: `The planner rejected ${count} candidate plans.`,
    },
  ];
}

function multikeyWarnings(stages: PlanStage[]): PlanWarning[] {
  return stages
    .filter((stage) => stage.isMultiKey === true)
    .map((stage) => ({
      code: 'MULTIKEY_INDEX',
      severity: 'info',
      message: `The index ${stage.index ?? 'used by this stage'} is multikey. Each array element adds an index key.`,
      stageName: stage.name,
    }));
}

function noExecutionStatsWarnings(tree: Omit<PlanTree, 'warnings'>): PlanWarning[] {
  if (tree.verbosity !== 'queryPlanner') {
    return [];
  }
  return [
    {
      code: 'NO_EXECUTION_STATS',
      severity: 'info',
      message: 'The plan has no execution statistics. Run the explain at executionStats verbosity.',
    },
  ];
}
