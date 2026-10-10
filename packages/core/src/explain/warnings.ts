import type { PlanStage, PlanTree, PlanWarning } from './plan-tree';
import { describeStage } from './stage-catalog';
import { asArray, asBoolean, asRecord, readNumber } from './raw-values';
import { flattenStages, isCollectionScanStage, isSortStage } from './stage-walk';

export const COLLSCAN_CRITICAL_DOCS = 1000;
export const HIGH_RATIO_THRESHOLD = 10;
export const SORT_MEMORY_CRITICAL_FRACTION = 0.9;
export const MANY_REJECTED_THRESHOLD = 3;
export const ORPHAN_FILTER_THRESHOLD = 100;
// An in-memory sort of more documents than this is critical even when it does not spill.
export const LARGE_IN_MEMORY_SORT_DOCS = 10_000;

// Group stages by name. The slot-based engine names its group stage in lowercase or uppercase.
const GROUP_STAGE_NAMES: ReadonlySet<string> = new Set([
  '$group',
  '$sortByCount',
  'group',
  'GROUP',
]);
// Stages that read all their input before they emit a row. A $match after one of them filters
// the output, not the input.
const BLOCKING_STAGE_NAMES: ReadonlySet<string> = new Set(['$group', '$sort', '$sortByCount']);
// Branch stages that bound the documents a $facet branch reads.
const BOUNDING_BRANCH_STAGES: ReadonlySet<string> = new Set(['$match', '$limit', '$sample']);

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
    ...groupSpillWarnings(stages).map(withCatalogAdvice),
    ...orphanWarnings(stages).map(withCatalogAdvice),
    ...lookupWarnings(stages),
    ...blockingBeforeMatchWarnings(stages).map(withCatalogAdvice),
    ...unboundedFacetWarnings(stages).map(withCatalogAdvice),
  ];
}

// Adds the advice that the stage catalogue gives for the stage a warning names.
function withCatalogAdvice(warning: PlanWarning): PlanWarning {
  const advice =
    warning.stageName === undefined ? undefined : describeStage(warning.stageName).advice;
  return advice === undefined ? warning : { ...warning, advice };
}

// A $group or $sortByCount that wrote to disk. The spill count is named when the server reports it.
function groupSpillWarnings(stages: PlanStage[]): PlanWarning[] {
  return stages
    .filter(
      (stage) =>
        GROUP_STAGE_NAMES.has(stage.name) && (stage.usedDisk === true || (stage.spills ?? 0) > 0),
    )
    .map((stage) => {
      const times =
        stage.spills === undefined || stage.spills === 0 ? '' : ` ${stage.spills} times`;
      return {
        code: 'GROUP_SPILLED',
        severity: 'critical',
        message: `The ${stage.name} stage spilled to disk${times}.`,
        stageName: stage.name,
      };
    });
}

// A SHARDING_FILTER that dropped many orphan documents. Each one was read from a shard that no
// longer owns its chunk, so the read was wasted.
function orphanWarnings(stages: PlanStage[]): PlanWarning[] {
  return stages
    .filter(
      (stage) =>
        stage.name === 'SHARDING_FILTER' && (stage.chunkSkips ?? 0) > ORPHAN_FILTER_THRESHOLD,
    )
    .map((stage) => ({
      code: 'ORPHANS_FILTERED',
      severity: 'warning',
      message: `The shard filter dropped ${stage.chunkSkips} orphan documents that belong to other shards.`,
      stageName: stage.name,
    }));
}

// Advice for a join with no index on its foreign field. Shown only with the warning.
const LOOKUP_INDEX_ADVICE =
  'Without an index on the foreign field, the join reads the foreign collection for each input document. Create an index on the foreignField.';

// A join without an index on the foreign field. An EQ_LOOKUP with no index name is one. A $lookup
// is one when the plan has no EQ_LOOKUP and a plan from the server, under its inner pipeline, scans
// a collection. The servers we captured report no inner plan for a pipeline $lookup.
function lookupWarnings(stages: PlanStage[]): PlanWarning[] {
  const eqLookupPresent = stages.some((stage) => stage.name === 'EQ_LOOKUP');
  return stages.flatMap((stage): PlanWarning[] => {
    if (stage.name === 'EQ_LOOKUP') {
      return stage.index === undefined
        ? [
            lookupWarning(
              stage.name,
              'The join has no index on the foreign field, so it reads the foreign collection for each input document.',
            ),
          ]
        : [];
    }
    if (stage.name !== '$lookup' || eqLookupPresent) {
      return [];
    }
    // Only a server-supplied inner plan has scan stages. Stages of the pipeline itself do not.
    const scans = stage.children
      .filter((child) => child.label?.startsWith('inner pipeline') === true)
      .flatMap((child) => flattenStages(child))
      .some((inner) => isCollectionScanStage(inner.name));
    return scans
      ? [
          lookupWarning(
            stage.name,
            'The inner pipeline of the $lookup scans a collection, because no index serves its match.',
          ),
        ]
      : [];
  });
}

function lookupWarning(stageName: string, message: string): PlanWarning {
  return {
    code: 'LOOKUP_WITHOUT_INDEX',
    severity: 'warning',
    message,
    stageName,
    advice: LOOKUP_INDEX_ADVICE,
  };
}

// The stages that move a field's value, so a $match on that field cannot be judged by its name.
const FIELD_CREATING_STAGES: ReadonlySet<string> = new Set([
  '$project',
  '$addFields',
  '$set',
  '$unwind',
  '$group',
  '$lookup',
  '$facet',
  '$graphLookup',
  '$unionWith',
  '$replaceRoot',
  '$replaceWith',
]);

// The top-level field names of a $match, or undefined when the match uses an operator such as $and
// or $expr, which this check does not judge.
function matchFields(stage: PlanStage): string[] | undefined {
  const spec = asRecord(asRecord(stage.raw)?.['$match']);
  const keys = Object.keys(spec ?? {});
  return keys.length === 0 || keys.some((key) => key.startsWith('$')) ? undefined : keys;
}

// The accumulator names of a $group, which exist only after the group. $sortByCount makes one.
function accumulatorNames(stage: PlanStage): string[] {
  if (stage.name === '$sortByCount') {
    return ['count'];
  }
  const spec = asRecord(asRecord(stage.raw)?.['$group']);
  return Object.keys(spec ?? {}).filter((key) => key !== '_id');
}

// A $match after a blocking stage that it could move before the stage. The walk follows the
// pipeline input and stops at a $cursor, because that input is a query plan.
function blockingBeforeMatchWarnings(stages: PlanStage[]): PlanWarning[] {
  return stages
    .filter((stage) => stage.name === '$match')
    .flatMap((stage): PlanWarning[] => {
      const fields = matchFields(stage);
      const found = blockingInput(stage);
      if (fields === undefined || found === undefined) {
        return [];
      }
      const { blocker, between } = found;
      if (!isMovable(blocker, fields, between)) {
        return [];
      }
      return [
        {
          code: 'BLOCKING_STAGE_BEFORE_MATCH',
          severity: 'warning',
          message: `The $match runs after a ${blocker.name}, so the ${blocker.name} handles every document before the filter. Move the $match before the ${blocker.name}.`,
          stageName: stage.name,
        },
      ];
    });
}

// Whether the $match can move above its blocking stage. After a $group, only fields the group
// does not compute can move, which means _id. After a $sort, the fields must be plain document
// fields, and no $match above the sort may already filter on them.
function isMovable(blocker: PlanStage, fields: string[], between: PlanStage[]): boolean {
  // A stage between the match and the blocker that creates fields may define the matched field.
  if (between.some((stage) => FIELD_CREATING_STAGES.has(stage.name))) {
    return false;
  }
  if (blocker.name === '$sort') {
    return !earlierMatchOn(blocker, fields);
  }
  // A dotted path reads inside its first segment, so n.x reads the accumulator n.
  const computed = accumulatorNames(blocker);
  return fields.every((field) => !computed.includes(field.split('.')[0] ?? field));
}

// A $match below the sort, on any of the fields, already filters them.
function earlierMatchOn(blocker: PlanStage, fields: string[]): boolean {
  let current: PlanStage | undefined = blocker.children[0];
  while (current !== undefined && current.name !== '$cursor') {
    if (current.name === '$match') {
      const earlier = matchFields(current) ?? [];
      if (earlier.some((field) => fields.includes(field))) {
        return true;
      }
    }
    current = current.children[0];
  }
  return false;
}

// The nearest blocking stage below a $match, with the stages between them.
function blockingInput(stage: PlanStage): { blocker: PlanStage; between: PlanStage[] } | undefined {
  const between: PlanStage[] = [];
  let current: PlanStage | undefined = stage.children[0];
  while (current !== undefined && current.name !== '$cursor') {
    if (BLOCKING_STAGE_NAMES.has(current.name)) {
      return { blocker: current, between };
    }
    between.push(current);
    current = current.children[0];
  }
  return undefined;
}

// A $facet with a branch that has no $match, $limit or $sample. That branch reads every document
// that reaches the $facet.
function unboundedFacetWarnings(stages: PlanStage[]): PlanWarning[] {
  return stages
    .filter((stage) => stage.name === '$facet')
    .flatMap((stage): PlanWarning[] => {
      const branches = Object.values(asRecord(asRecord(stage.raw)?.['$facet']) ?? {});
      const unbounded = branches.some((branch) => {
        const names = (asArray(branch) ?? []).map((entry) => Object.keys(asRecord(entry) ?? {})[0]);
        return !names.some((name) => name !== undefined && BOUNDING_BRANCH_STAGES.has(name));
      });
      return unbounded
        ? [
            {
              code: 'UNBOUNDED_FACET',
              severity: 'warning',
              message:
                'A $facet branch has no $match, $limit or $sample, so it reads every document that reaches the $facet.',
              stageName: stage.name,
            },
          ]
        : [];
    });
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
      const large = count !== undefined && count > LARGE_IN_MEMORY_SORT_DOCS;
      const inMemory: PlanWarning = {
        code: 'IN_MEMORY_SORT',
        severity: spilled === 'none' && !large ? 'warning' : 'critical',
        message: large
          ? `The query sorts ${subject} in memory, more than ${LARGE_IN_MEMORY_SORT_DOCS} documents.`
          : `The query sorts ${subject} in memory.`,
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
