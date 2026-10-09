import type {
  PlanCommand,
  PlanEngine,
  PlanStage,
  PlanSummary,
  PlanTree,
  PlanVerbosity,
} from './plan-tree';
import {
  asArray,
  asBoolean,
  asRecord,
  asString,
  definedFields,
  isRawRecord,
  type DefinedFields,
  readNumber,
  readStringMap,
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
const COMMANDS: ReadonlySet<string> = new Set([
  'find',
  'aggregate',
  'count',
  'distinct',
  'update',
  'delete',
]);
const UNKNOWN_STAGE = 'UNKNOWN';
const SHARD_STAGE = 'SHARD_MERGE';

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
  winning: PlanStage;
  rejected: PlanStage[];
  totals: Totals;
}

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
  return finishTree({
    command: 'aggregate',
    namespace: planned.namespace ?? namespaceFromCommand(doc) ?? '',
    verbosity: verbosityOf(topExec, cursorExec),
    engine: planned.engine,
    serverVersion,
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
  return {
    name,
    ...metricFields(record, 'estimate'),
    children: [input],
    raw: record,
  };
}

// Totals for an aggregate. The top-level block wins when present. Otherwise the wrapper stages
// add up, because each stage reports the documents it examined.
function aggregateTotals(topExec: RawRecord | undefined, wrappers: PlanStage[]): Totals {
  const last = wrappers[wrappers.length - 1];
  const returned = last?.nReturned;
  const time = last?.executionTimeMs;
  if (topExec !== undefined) {
    return totalsOf(topExec);
  }
  const docs = sumDefined(wrappers.map((stage) => stage.docsExamined));
  const keys = sumDefined(wrappers.map((stage) => stage.keysExamined));
  return definedFields({
    docsExamined: docs,
    keysExamined: keys,
    nReturned: returned,
    executionTimeMs: time,
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
  // The slot-based engine nests the classic plan under queryPlan and adds slotBasedPlan.
  const slotBased = 'queryPlan' in winningRaw || 'slotBasedPlan' in winningRaw;
  const plannerNode = slotBased ? asRecord(winningRaw['queryPlan']) : winningRaw;
  const execNode = asRecord(exec?.['executionStages']);
  const built = buildStage(plannerNode, execNode, undefined, slotBased);
  // A plan that names no stage at all is not a plan this module can read.
  if (built === undefined || built.name === UNKNOWN_STAGE) {
    return undefined;
  }
  const winning =
    slotBased && plannerNode !== undefined ? withPlannerFacts(built, plannerNode) : built;
  const rejected = (asArray(planner['rejectedPlans']) ?? [])
    .map((entry) => buildStage(asRecord(entry), undefined, undefined, false))
    .filter((stage): stage is PlanStage => stage !== undefined);
  const namespace = asString(planner['namespace']);
  return {
    winning,
    rejected,
    engine: engineOf(winning, slotBased),
    namespace,
  };
}

function engineOf(winning: PlanStage, slotBased: boolean): PlanEngine {
  if (slotBased) {
    return 'sbe';
  }
  if (winning.name === UNKNOWN_STAGE) {
    return 'unknown';
  }
  // Slot-based stages have lowercase names (scan, nlj, ixseek). Classic stages are uppercase.
  return winning.name === winning.name.toLowerCase() ? 'sbe' : 'classic';
}

// Builds one node from its planner description and its execution description. Either may be
// missing. When both exist but name different stages, the execution tree is used alone. The
// slot-based engine reports its own stage names, so the planner tree does not line up with it.
function buildStage(
  planner: RawRecord | undefined,
  exec: RawRecord | undefined,
  shard: string | undefined,
  slotBased: boolean,
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
    ? shardChildren(paired, exec, slotBased)
    : childStages(paired, exec, shard, slotBased);
  return {
    name,
    ...plannerFields(paired),
    ...metricFields(exec, 'estimate'),
    ...(shard === undefined ? {} : { shard }),
    children,
    raw: exec ?? planner,
  };
}

// Each shard contributes one subtree. The planner side is the shard's winningPlan. The execution
// side is the shard's executionStages.
function shardChildren(
  planner: RawRecord | undefined,
  exec: RawRecord | undefined,
  slotBased: boolean,
): PlanStage[] {
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
    const child = buildStage(
      asRecord(plannerEntry?.['winningPlan']),
      asRecord(execEntry?.['executionStages']),
      shardName,
      slotBased,
    );
    if (child !== undefined) {
      children.push(child);
    }
  }
  return children;
}

function childStages(
  planner: RawRecord | undefined,
  exec: RawRecord | undefined,
  shard: string | undefined,
  slotBased: boolean,
): PlanStage[] {
  const children: PlanStage[] = [];
  for (const key of CHILD_KEYS) {
    const plannerList = nodeList(planner?.[key]);
    const execList = nodeList(exec?.[key]);
    const count = Math.max(plannerList.length, execList.length);
    for (let index = 0; index < count; index += 1) {
      const child = buildStage(plannerList[index], execList[index], shard, slotBased);
      if (child !== undefined) {
        children.push(child);
      }
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

function plannerFields(node: RawRecord | undefined): DefinedFields<PlanStage> {
  if (node === undefined) {
    return {};
  }
  return definedFields({
    index: asString(node['indexName']),
    indexBounds: readStringMap(node['indexBounds']),
    direction: directionOf(node['direction']),
    isMultiKey: asBoolean(node['isMultiKey']),
    filter: isRawRecord(node['filter']) ? node['filter'] : undefined,
  });
}

// Counters and flags of one stage, in both engines' names. The `scope` only changes which time
// field is read. Top-level execution blocks report executionTimeMillis, stages report the
// estimate.
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
    // numReads is the record count read by the slot-based scan stage.
    docsExamined:
      readNumber(node['docsExamined']) ??
      readNumber(node['totalDocsExamined']) ??
      readNumber(node['numReads']),
    nReturned: readNumber(node['nReturned']),
    executionTimeMs: time,
    works: readNumber(node['works']),
    // The sort reports bytes sorted. The server does not report the memory in use directly.
    memUsageBytes: readNumber(node['memUsage']) ?? readNumber(node['totalDataSizeSorted']),
    memLimitBytes: readNumber(node['memLimit']),
    usedDisk: asBoolean(node['usedDisk']),
    index: asString(node['indexName']),
    isMultiKey: asBoolean(node['isMultiKey']),
    indexBounds: readStringMap(node['indexBounds']),
    direction: directionOf(node['direction']),
    filter: isRawRecord(node['filter']) ? node['filter'] : undefined,
  });
}

function directionOf(value: unknown): PlanStage['direction'] {
  return value === 'forward' || value === 'backward' ? value : undefined;
}

// Query filters of the collection scans in a classic-named plan, in walk order.
function collectionScanFilters(node: RawRecord): unknown[] {
  const own = node['stage'] === 'COLLSCAN' && isRawRecord(node['filter']) ? [node['filter']] : [];
  const nested = CHILD_KEYS.flatMap((key) =>
    nodeList(node[key]).flatMap((child) =>
      child === undefined ? [] : collectionScanFilters(child),
    ),
  );
  return [...own, ...nested];
}

// The slot-based engine keeps the query filter, index bounds and multikey flag on the classic
// plan only. Its execution tree names indexes but not those facts, so they are copied over by
// index name, and each scan node takes the next collection scan filter in walk order.
function withPlannerFacts(stage: PlanStage, plannerNode: RawRecord): PlanStage {
  const facts = new Map<string, PlannerIndexFacts>();
  const filters = collectionScanFilters(plannerNode);
  collectIndexFacts(plannerNode, facts);
  return applyPlannerFacts(stage, facts, filters);
}

interface PlannerIndexFacts {
  isMultiKey?: boolean;
  indexBounds?: Record<string, string[]>;
  direction?: PlanStage['direction'];
}

function collectIndexFacts(node: RawRecord, facts: Map<string, PlannerIndexFacts>): void {
  const name = asString(node['indexName']);
  if (node['stage'] === 'IXSCAN' && name !== undefined && !facts.has(name)) {
    facts.set(
      name,
      definedFields({
        isMultiKey: asBoolean(node['isMultiKey']),
        indexBounds: readStringMap(node['indexBounds']),
        direction: directionOf(node['direction']),
      }),
    );
  }
  for (const key of CHILD_KEYS) {
    for (const child of nodeList(node[key])) {
      if (child !== undefined) {
        collectIndexFacts(child, facts);
      }
    }
  }
}

function applyPlannerFacts(
  stage: PlanStage,
  facts: Map<string, PlannerIndexFacts>,
  filters: unknown[],
): PlanStage {
  const fact = stage.index === undefined ? undefined : facts.get(stage.index);
  const filter = stage.name === 'scan' && stage.filter === undefined ? filters.shift() : undefined;
  const merged = definedFields({
    isMultiKey: stage.isMultiKey ?? fact?.isMultiKey,
    indexBounds: stage.indexBounds ?? fact?.indexBounds,
    direction: stage.direction ?? fact?.direction,
    filter: stage.filter ?? filter,
  });
  const children = stage.children.map((child) => applyPlannerFacts(child, facts, filters));
  return { ...stage, ...merged, children };
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
  const echoed = Object.keys(asRecord(doc['command']) ?? {})[0];
  if (echoed !== undefined && COMMANDS.has(echoed)) {
    return echoed as PlanCommand;
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

// Index names listed in a stage's `indexesUsed` array. The slot-based nested loop join uses it.
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
