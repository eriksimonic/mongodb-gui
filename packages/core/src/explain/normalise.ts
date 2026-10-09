import {
  PlanCommandSchema,
  type PlanCommand,
  type PlanEngine,
  type PlanStage,
  type PlanSummary,
  type PlanTree,
  type PlanVerbosity,
} from './plan-tree';
import {
  asArray,
  asBoolean,
  asRecord,
  asString,
  definedFields,
  fieldNames,
  isRawRecord,
  readNumber,
  readStringMap,
  type DefinedFields,
  type RawRecord,
} from './raw-values';
import {
  flattenStages,
  isCollectionScanStage,
  isFetchStage,
  isIndexScanStage,
  isSortStage,
} from './stage-walk';
import { deriveWarnings } from './warnings';

// Input stages a plan node can hold, in walk order.
const CHILD_KEYS = [
  'inputStage',
  'inputStages',
  'thenStage',
  'elseStage',
  'outerStage',
  'innerStage',
] as const;
const UNKNOWN_STAGE = 'UNKNOWN';
const SHARD_STAGE = 'SHARD_MERGE';
// Slot-based stages that carry keys examined, documents read and sort or group spill counters.
const KEY_STAGES: ReadonlySet<string> = new Set(['ixseek', 'IXSCAN']);
const READ_STAGES: ReadonlySet<string> = new Set(['scan', 'seek']);
const SPILL_STAGES: ReadonlySet<string> = new Set(['sort', 'SORT', 'group', 'GROUP']);

// Totals for the whole operation, taken from the explain document.
interface Totals {
  keysExamined?: number;
  docsExamined?: number;
  nReturned?: number;
  executionTimeMs?: number;
}

interface PlannedTree {
  winning: PlanStage;
  rejected: PlanStage[];
  engine: PlanEngine;
  namespace: string | undefined;
}

interface TreeParts {
  command: PlanCommand;
  namespace: string;
  verbosity: PlanVerbosity;
  engine: PlanEngine;
  serverVersion: string | undefined;
  filter: unknown;
  winning: PlanStage;
  rejected: PlanStage[];
  totals: Totals;
}

// Index of slot-based execution stages by planNodeId. Each list is in walk order, so the first
// entry is the topmost stage with that id.
type SlotIndex = Map<number, RawRecord[]>;

// Normalises raw explain output from any supported server into one plan tree. Input that does
// not match a known shape yields command 'unknown' with one UNKNOWN stage that holds the input.
export function normaliseExplain(raw: unknown): PlanTree {
  try {
    return normaliseKnown(raw) ?? unknownTree(raw);
  } catch {
    return unknownTree(raw);
  }
}

function normaliseKnown(raw: unknown): PlanTree | undefined {
  const doc = asRecord(raw);
  if (doc === undefined) {
    return undefined;
  }
  const serverVersion = asString(asRecord(doc['serverInfo'])?.['version']);
  const pipeline = asArray(doc['stages']);
  if (pipeline !== undefined) {
    return normaliseAggregate(doc, pipeline, serverVersion);
  }
  const planner = asRecord(doc['queryPlanner']);
  if (planner === undefined) {
    return undefined;
  }
  const exec = asRecord(doc['executionStats']);
  const planned = planTree(planner, exec);
  if (planned === undefined) {
    return undefined;
  }
  return finishTree({
    command: detectCommand(doc, planned.winning),
    namespace: planned.namespace ?? namespaceFromCommand(doc) ?? '',
    verbosity: verbosityOf(exec),
    engine: planned.engine,
    serverVersion,
    filter: planner['parsedQuery'] ?? asRecord(doc['command'])?.['filter'],
    winning: planned.winning,
    rejected: planned.rejected,
    totals: totalsOf(exec),
  });
}

function normaliseAggregate(
  doc: RawRecord,
  pipeline: unknown[],
  serverVersion: string | undefined,
): PlanTree | undefined {
  const cursor = asRecord(asRecord(pipeline[0])?.['$cursor']);
  const cursorPlanner = asRecord(cursor?.['queryPlanner']);
  if (cursor === undefined || cursorPlanner === undefined) {
    return undefined;
  }
  const cursorExec = asRecord(cursor['executionStats']);
  const planned = planTree(cursorPlanner, cursorExec);
  if (planned === undefined) {
    return undefined;
  }
  const topExec = asRecord(doc['executionStats']);
  const wrappers: PlanStage[] = [
    {
      name: '$cursor',
      ...metricFields(cursorExec, 'top'),
      children: [planned.winning],
      raw: cursor,
    },
  ];
  // Each later pipeline stage consumes the stage before it, so the last stage is the root.
  for (const entry of pipeline.slice(1)) {
    const input = wrappers[wrappers.length - 1];
    const stage = input === undefined ? undefined : pipelineStage(entry, input);
    if (stage !== undefined) {
      wrappers.push(stage);
    }
  }
  const winning = wrappers[wrappers.length - 1] ?? planned.winning;
  const firstMatch = asRecord(asArray(asRecord(doc['command'])?.['pipeline'])?.[0])?.['$match'];
  return finishTree({
    command: 'aggregate',
    namespace: planned.namespace ?? namespaceFromCommand(doc) ?? '',
    verbosity: verbosityOf(topExec, cursorExec),
    engine: planned.engine,
    serverVersion,
    filter: cursorPlanner['parsedQuery'] ?? firstMatch,
    winning,
    rejected: planned.rejected,
    totals: aggregateTotals(topExec, wrappers),
  });
}

// A pipeline stage after $cursor. The counters sit beside the stage name, next to its spec.
function pipelineStage(entry: unknown, input: PlanStage): PlanStage | undefined {
  const record = asRecord(entry);
  const name = record === undefined ? undefined : Object.keys(record)[0];
  if (record === undefined || name === undefined) {
    return undefined;
  }
  const sortPattern =
    name === '$sort' ? sortPatternOf(asRecord(record[name])?.['sortKey']) : undefined;
  return {
    name,
    ...metricFields(record, 'estimate'),
    ...(sortPattern === undefined ? {} : { sortPattern }),
    children: [input],
    raw: record,
  };
}

// Totals for an aggregate. The top-level block wins when present. Otherwise the wrapper stages
// add up, because each stage reports the documents it examined.
function aggregateTotals(topExec: RawRecord | undefined, wrappers: PlanStage[]): Totals {
  if (topExec !== undefined) {
    return totalsOf(topExec);
  }
  const last = wrappers[wrappers.length - 1];
  const docs = sumDefined(wrappers.map((stage) => stage.docsExamined));
  const keys = sumDefined(wrappers.map((stage) => stage.keysExamined));
  return definedFields({
    docsExamined: docs,
    keysExamined: keys,
    nReturned: last?.nReturned,
    executionTimeMs: last?.executionTimeMs,
  });
}

function sumDefined(values: (number | undefined)[]): number | undefined {
  const defined = values.filter((value): value is number => value !== undefined);
  return defined.length === 0 ? undefined : defined.reduce((sum, value) => sum + value, 0);
}

// Builds the winning and rejected trees of one queryPlanner block, with the execution stats
// merged in when the block carries them.
function planTree(planner: RawRecord, exec: RawRecord | undefined): PlannedTree | undefined {
  const winningRaw = asRecord(planner['winningPlan']);
  if (winningRaw === undefined) {
    return undefined;
  }
  const winning = buildRoot(winningRaw, asRecord(exec?.['executionStages']), undefined);
  if (winning === undefined || winning.name === UNKNOWN_STAGE) {
    return undefined;
  }
  const rejected = rejectedStages(
    asArray(planner['rejectedPlans']),
    asArray(exec?.['allPlansExecution']),
  );
  const namespace = asString(planner['namespace']);
  return {
    winning,
    rejected,
    engine: isSlotBased(winningRaw) ? 'sbe' : 'classic',
    namespace,
  };
}

// The slot-based engine nests the classic plan under queryPlan and adds slotBasedPlan.
function isSlotBased(winningRaw: RawRecord): boolean {
  return 'queryPlan' in winningRaw || 'slotBasedPlan' in winningRaw;
}

// Builds the root of one winningPlan. A slot-based plan is built from its classic queryPlan,
// with the execution counters joined by planNodeId.
function buildRoot(
  winningRaw: RawRecord | undefined,
  execNode: RawRecord | undefined,
  shard: string | undefined,
): PlanStage | undefined {
  if (winningRaw !== undefined && isSlotBased(winningRaw)) {
    const plan = asRecord(winningRaw['queryPlan']);
    return plan === undefined ? undefined : buildSlotStage(plan, slotIndex(execNode), shard);
  }
  return buildStage(winningRaw, execNode, shard);
}

// Each rejected plan pairs with the allPlansExecution entry that describes the same plan. Classic
// plans match on stage and index names. Slot-based plans match on the root planNodeId and the
// index names, because their execution stages use slot-based names.
function rejectedStages(
  planEntries: unknown[] | undefined,
  allPlans: unknown[] | undefined,
): PlanStage[] {
  const pool: RawRecord[] = (allPlans ?? []).flatMap((entry) => {
    const root = asRecord(asRecord(entry)?.['executionStages']);
    return root === undefined ? [] : [root];
  });
  return (planEntries ?? []).flatMap((entry): PlanStage[] => {
    const planner = asRecord(entry);
    if (planner === undefined) {
      return [];
    }
    const at = pool.findIndex((root) => matchesRejected(root, planner));
    const execRoot = at === -1 ? undefined : pool.splice(at, 1)[0];
    const stage = buildRoot(planner, execRoot, undefined);
    return stage === undefined ? [] : [stage];
  });
}

function matchesRejected(root: RawRecord, planner: RawRecord): boolean {
  if (isSlotBased(planner)) {
    const plan = asRecord(planner['queryPlan']);
    const planId = readNumber(plan?.['planNodeId']);
    return (
      plan !== undefined &&
      planId !== undefined &&
      readNumber(root['planNodeId']) === planId &&
      sameList(indexNamesOf(root), indexNamesOf(plan))
    );
  }
  return sameList(stageSignature(root), stageSignature(planner));
}

// Index names in walk order, from any stage that names one.
function indexNamesOf(node: RawRecord): string[] {
  const own = asString(node['indexName']);
  const nested = CHILD_KEYS.flatMap((key) =>
    nodeList(node[key]).flatMap((child) => (child === undefined ? [] : indexNamesOf(child))),
  );
  return own === undefined ? nested : [own, ...nested];
}

// Stage and index names of a classic tree, in walk order.
function stageSignature(node: RawRecord): string[] {
  const own = `${asString(node['stage']) ?? ''}|${asString(node['indexName']) ?? ''}`;
  const nested = CHILD_KEYS.flatMap((key) =>
    nodeList(node[key]).flatMap((child) => (child === undefined ? [] : stageSignature(child))),
  );
  return [own, ...nested];
}

function sameList(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

// Builds a node of the classic engine from its planner description and its execution
// description. Either may be missing. When both exist but name different stages, the execution
// node is used alone.
function buildStage(
  planner: RawRecord | undefined,
  exec: RawRecord | undefined,
  shard: string | undefined,
): PlanStage | undefined {
  if (planner === undefined && exec === undefined) {
    return undefined;
  }
  const plannerName = asString(planner?.['stage']);
  const execName = asString(exec?.['stage']);
  const shardsPresent =
    asArray(planner?.['shards']) !== undefined || asArray(exec?.['shards']) !== undefined;
  const namesAgree =
    plannerName === undefined || execName === undefined || plannerName === execName;
  const paired = namesAgree ? planner : undefined;
  const name = execName ?? plannerName ?? (shardsPresent ? SHARD_STAGE : UNKNOWN_STAGE);
  const children = shardsPresent
    ? shardChildren(paired, exec)
    : classicChildren(paired, exec, shard);
  return {
    name,
    ...plannerFields(paired),
    ...metricFields(exec, 'estimate'),
    ...(shard === undefined ? {} : { shard }),
    children,
    raw: exec ?? planner,
  };
}

function classicChildren(
  planner: RawRecord | undefined,
  exec: RawRecord | undefined,
  shard: string | undefined,
): PlanStage[] {
  const children: PlanStage[] = [];
  for (const key of CHILD_KEYS) {
    const plannerList = nodeList(planner?.[key]);
    const execList = nodeList(exec?.[key]);
    const count = Math.max(plannerList.length, execList.length);
    for (let index = 0; index < count; index += 1) {
      const child = buildStage(plannerList[index], execList[index], shard);
      if (child !== undefined) {
        children.push(child);
      }
    }
  }
  return children;
}

// Each shard contributes one subtree. The planner side is the shard's winningPlan and the
// execution side is the shard's executionStages. A slot-based shard is unwrapped the same way
// as a top-level plan.
function shardChildren(planner: RawRecord | undefined, exec: RawRecord | undefined): PlanStage[] {
  const plannerShards = asArray(planner?.['shards']) ?? [];
  const execShards = asArray(exec?.['shards']) ?? [];
  const count = Math.max(plannerShards.length, execShards.length);
  const children: PlanStage[] = [];
  for (let index = 0; index < count; index += 1) {
    const plannerEntry = asRecord(plannerShards[index]);
    const execEntry = asRecord(execShards[index]);
    const shardName =
      asString(plannerEntry?.['shardName']) ??
      asString(execEntry?.['shardName']) ??
      `shard${index}`;
    const child = buildRoot(
      asRecord(plannerEntry?.['winningPlan']),
      asRecord(execEntry?.['executionStages']),
      shardName,
    );
    if (child !== undefined) {
      children.push(child);
    }
  }
  return children;
}

// A child is either one stage object or an array of them (OR, SUBPLAN and similar).
function nodeList(value: unknown): (RawRecord | undefined)[] {
  const single = asRecord(value);
  if (single !== undefined) {
    return [single];
  }
  return (asArray(value) ?? []).map((entry) => asRecord(entry));
}

// Walks a slot-based execution tree and groups its stages by planNodeId, topmost first.
function slotIndex(node: RawRecord | undefined): SlotIndex {
  const index: SlotIndex = new Map();
  const visit = (current: RawRecord): void => {
    const id = readNumber(current['planNodeId']);
    if (id !== undefined) {
      index.set(id, [...(index.get(id) ?? []), current]);
    }
    for (const key of CHILD_KEYS) {
      for (const child of nodeList(current[key])) {
        if (child !== undefined) {
          visit(child);
        }
      }
    }
  };
  if (node !== undefined) {
    visit(node);
  }
  return index;
}

// Builds a node of the slot-based engine. The shape and the query facts come from the classic
// queryPlan node. The counters come from the slot-based stages with the same planNodeId. The
// topmost of those stages gives nReturned and time. Its raw JSON is kept on the node.
function buildSlotStage(plan: RawRecord, index: SlotIndex, shard: string | undefined): PlanStage {
  const counters = slotCounters(plan, index);
  const children = CHILD_KEYS.flatMap((key) =>
    nodeList(plan[key]).flatMap((child) =>
      child === undefined ? [] : [buildSlotStage(child, index, shard)],
    ),
  );
  return {
    name: asString(plan['stage']) ?? UNKNOWN_STAGE,
    ...plannerFields(plan),
    ...counters.fields,
    ...(shard === undefined ? {} : { shard }),
    children,
    raw: counters.raw ?? plan,
  };
}

function slotCounters(
  plan: RawRecord,
  index: SlotIndex,
): { fields: DefinedFields<PlanStage>; raw: RawRecord | undefined } {
  const id = readNumber(plan['planNodeId']);
  const matches = id === undefined ? [] : (index.get(id) ?? []);
  const top = matches[0];
  const keyStage = matches.find((stage) => KEY_STAGES.has(asString(stage['stage']) ?? ''));
  const readStage = matches.find((stage) => READ_STAGES.has(asString(stage['stage']) ?? ''));
  const spillStage = matches.find((stage) => SPILL_STAGES.has(asString(stage['stage']) ?? ''));
  return {
    fields: definedFields({
      nReturned: readNumber(top?.['nReturned']),
      executionTimeMs: readNumber(top?.['executionTimeMillisEstimate']),
      keysExamined: readNumber(keyStage?.['keysExamined']),
      // numReads on a scan or seek stage counts the documents it read.
      docsExamined: readNumber(readStage?.['numReads']),
      memLimitBytes: readNumber(spillStage?.['memLimit']),
      memUsageBytes:
        readNumber(spillStage?.['totalDataSizeSorted']) ??
        readNumber(spillStage?.['totalDataSizeSortedBytesEstimate']),
      usedDisk: asBoolean(spillStage?.['usedDisk']),
    }),
    raw: top,
  };
}

function plannerFields(node: RawRecord | undefined): DefinedFields<PlanStage> {
  if (node === undefined) {
    return {};
  }
  const keys = fieldNames(node['keyPattern']);
  return definedFields({
    index: asString(node['indexName']),
    indexBounds: readStringMap(node['indexBounds']),
    indexKeys: keys.length === 0 ? undefined : keys,
    direction: directionOf(node['direction']),
    isMultiKey: asBoolean(node['isMultiKey']),
    filter: isRawRecord(node['filter']) ? node['filter'] : undefined,
    projection: isRawRecord(node['transformBy']) ? node['transformBy'] : undefined,
    sortPattern: sortPatternOf(node['sortPattern']),
  });
}

// Counters and flags of one stage. The `scope` only changes which time field is read. Top-level
// execution blocks report executionTimeMillis, stages report the estimate.
function metricFields(
  node: RawRecord | undefined,
  scope: 'top' | 'estimate',
): DefinedFields<PlanStage> {
  if (node === undefined) {
    return {};
  }
  const time =
    scope === 'top'
      ? readNumber(node['executionTimeMillis'])
      : (readNumber(node['executionTimeMillisEstimate']) ??
        readNumber(node['executionTimeMillis']));
  return definedFields({
    keysExamined: readNumber(node['keysExamined']) ?? readNumber(node['totalKeysExamined']),
    docsExamined: readNumber(node['docsExamined']) ?? readNumber(node['totalDocsExamined']),
    nReturned: readNumber(node['nReturned']),
    executionTimeMs: time,
    works: readNumber(node['works']),
    // Sorts report the bytes they sorted. The server does not report the memory held directly.
    memUsageBytes:
      readNumber(node['memUsage']) ??
      readNumber(node['totalDataSizeSorted']) ??
      readNumber(node['totalDataSizeSortedBytesEstimate']),
    memLimitBytes: readNumber(node['memLimit']),
    usedDisk: asBoolean(node['usedDisk']),
    index: asString(node['indexName']),
    isMultiKey: asBoolean(node['isMultiKey']),
    indexBounds: readStringMap(node['indexBounds']),
    direction: directionOf(node['direction']),
    filter: isRawRecord(node['filter']) ? node['filter'] : undefined,
  });
}

// Sort keys as field to direction. Canonical EJSON wraps the direction as a number.
function sortPatternOf(value: unknown): Record<string, number> | undefined {
  const record = asRecord(value);
  if (record === undefined) {
    return undefined;
  }
  const pattern: Record<string, number> = {};
  for (const [field, direction] of Object.entries(record)) {
    pattern[field] = readNumber(direction) ?? 1;
  }
  return Object.keys(pattern).length === 0 ? undefined : pattern;
}

function directionOf(value: unknown): PlanStage['direction'] {
  return value === 'forward' || value === 'backward' ? value : undefined;
}

function totalsOf(exec: RawRecord | undefined): Totals {
  if (exec === undefined) {
    return {};
  }
  return definedFields({
    keysExamined: readNumber(exec['totalKeysExamined']),
    docsExamined: readNumber(exec['totalDocsExamined']),
    nReturned: readNumber(exec['nReturned']),
    executionTimeMs: readNumber(exec['executionTimeMillis']),
  });
}

// allPlansExecution is present on the execution block when the verbosity asks for it.
function verbosityOf(...execs: (RawRecord | undefined)[]): PlanVerbosity {
  if (execs.some((exec) => Array.isArray(exec?.['allPlansExecution']))) {
    return 'allPlansExecution';
  }
  return execs.some((exec) => exec !== undefined) ? 'executionStats' : 'queryPlanner';
}

// Some servers do not echo the command in explain output. Then the winning stage tells the
// command apart. A distinct on a plain index looks like a find on those servers.
function detectCommand(doc: RawRecord, winning: PlanStage): PlanCommand {
  const echoed = PlanCommandSchema.safeParse(Object.keys(asRecord(doc['command']) ?? {})[0]);
  if (echoed.success && echoed.data !== 'unknown') {
    return echoed.data;
  }
  switch (winning.name) {
    case 'COUNT':
      return 'count';
    case 'DISTINCT_SCAN':
      return 'distinct';
    case 'UPDATE':
      return 'update';
    case 'DELETE':
    case 'BATCHED_DELETE':
      return 'delete';
    default:
      return 'find';
  }
}

function namespaceFromCommand(doc: RawRecord): string | undefined {
  const command = asRecord(doc['command']);
  const database = asString(command?.['$db']);
  const collection = asString(command?.['aggregate']) ?? asString(command?.['find']);
  return database === undefined || collection === undefined
    ? undefined
    : `${database}.${collection}`;
}

function finishTree(parts: TreeParts): PlanTree {
  const stages = flattenStages(parts.winning);
  const base: Omit<PlanTree, 'warnings'> = {
    command: parts.command,
    namespace: parts.namespace,
    verbosity: parts.verbosity,
    engine: parts.engine,
    ...(parts.serverVersion === undefined ? {} : { serverVersion: parts.serverVersion }),
    ...(parts.filter === undefined ? {} : { filter: parts.filter }),
    winning: parts.winning,
    rejected: parts.rejected,
    summary: summarise(stages, parts.totals),
    sharded: stages.some((stage) => stage.shard !== undefined),
  };
  return { ...base, warnings: deriveWarnings(base) };
}

function summarise(stages: PlanStage[], totals: Totals): PlanSummary {
  const indexes = new Set<string>();
  for (const stage of stages) {
    if (stage.index !== undefined) {
      indexes.add(stage.index);
    }
    for (const name of stageIndexes(stage)) {
      indexes.add(name);
    }
  }
  const hasFetch = stages.some((stage) => isFetchStage(stage.name));
  const hasCovered = stages.some((stage) => stage.name === 'PROJECTION_COVERED');
  const hasIndexScan = stages.some((stage) => isIndexScanStage(stage.name));
  const covered = hasCovered ? true : hasFetch ? false : hasIndexScan ? true : undefined;
  const docs = totals.docsExamined;
  const returned = totals.nReturned;
  const ratio =
    docs !== undefined && returned !== undefined && returned > 0 ? docs / returned : undefined;
  return {
    indexesUsed: [...indexes],
    inMemorySort: stages.some((stage) => isSortStage(stage.name)),
    collectionScan: stages.some((stage) => isCollectionScanStage(stage.name)),
    ...(covered === undefined ? {} : { covered }),
    ...definedFields({
      keysExamined: totals.keysExamined,
      docsExamined: docs,
      nReturned: returned,
      executionTimeMs: totals.executionTimeMs,
      totalDocsExaminedToReturnedRatio: ratio,
    }),
  };
}

// Index names listed in a stage's `indexesUsed` array. The classic $lookup reports them there.
function stageIndexes(stage: PlanStage): string[] {
  const raw = asRecord(stage.raw);
  return (asArray(raw?.['indexesUsed']) ?? []).flatMap((entry) => {
    const name = asString(entry);
    return name === undefined ? [] : [name];
  });
}

function unknownTree(raw: unknown): PlanTree {
  const base: Omit<PlanTree, 'warnings'> = {
    command: 'unknown',
    namespace: '',
    verbosity: 'queryPlanner',
    engine: 'unknown',
    winning: { name: UNKNOWN_STAGE, children: [], raw },
    rejected: [],
    summary: { indexesUsed: [], inMemorySort: false, collectionScan: false },
    sharded: false,
  };
  return { ...base, warnings: deriveWarnings(base) };
}
