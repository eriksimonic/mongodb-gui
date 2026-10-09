import type { PlanStage, PlanTree, PlanWarning } from './plan-tree';
import { asArray, asRecord, readNumber } from './raw-values';
import { flattenStages, isCollectionScanStage, isSortStage } from './stage-walk';

const EQUALITY_OPERATORS: ReadonlySet<string> = new Set(['$eq', '$in']);
const RANGE_OPERATORS: ReadonlySet<string> = new Set(['$gt', '$gte', '$lt', '$lte']);
// Stages that change the documents so an index on the input cannot give the sort order. The
// classic names cover the slot-based engine, which runs a group inside $cursor.
const SORT_BLOCKING_STAGES: ReadonlySet<string> = new Set([
  '$group',
  '$unwind',
  '$project',
  'GROUP',
  'UNWIND',
]);
// Write and count stages, with the counter that holds the number of documents they touch.
const COUNTERS: Readonly<Record<string, { verb: string; key: string }>> = {
  DELETE: { verb: 'to delete', key: 'nWouldDelete' },
  BATCHED_DELETE: { verb: 'to delete', key: 'nWouldDelete' },
  UPDATE: { verb: 'to update', key: 'nWouldModify' },
  COUNT: { verb: 'counted', key: 'nCounted' },
};

export type KeyEntry = readonly [field: string, direction: number];

// Plain sentences that describe a normalised plan: the plan itself, the sharding and engine
// facts, and one sentence per warning with a suggestion.
export function explainInWords(tree: PlanTree): string[] {
  if (tree.command === 'unknown') {
    return [
      'The explain output has a shape this tool does not recognise. Only the raw JSON is available.',
    ];
  }
  const sentences = [planSentence(tree)];
  const shards = shardSentence(tree);
  if (shards !== undefined) {
    sentences.push(shards);
  }
  if (tree.engine !== 'unknown') {
    sentences.push(
      `The server ran the plan on the ${tree.engine === 'sbe' ? 'slot-based' : 'classic'} engine.`,
    );
  }
  for (const warning of tree.warnings) {
    const sentence = suggestionFor(warning, tree);
    if (sentence !== undefined) {
      sentences.push(sentence);
    }
  }
  return sentences;
}

function planSentence(tree: PlanTree): string {
  const summary = tree.summary;
  const indexes = summary.indexesUsed;
  const lead =
    indexes.length === 0
      ? summary.collectionScan
        ? 'The planner scanned the whole collection'
        : 'The planner ran the plan'
      : indexes.length === 1
        ? `The planner chose the index ${indexes[0]}`
        : `The planner chose the indexes ${indexes.join(' and ')}`;
  if (tree.verbosity === 'queryPlanner') {
    return `${lead}.`;
  }
  // A count examines keys only, so its zero document count is left out.
  const countsDocuments = tree.command !== 'count' || summary.docsExamined !== 0;
  const examined = [
    summary.keysExamined === undefined || summary.keysExamined === 0
      ? undefined
      : `${summary.keysExamined} keys`,
    summary.docsExamined === undefined || !countsDocuments
      ? undefined
      : `${summary.docsExamined} documents`,
  ].filter((part): part is string => part !== undefined);
  const time = summary.executionTimeMs === undefined ? undefined : `${summary.executionTimeMs} ms`;
  const examinedPart = examined.length === 0 ? '' : ` and examined ${examined.join(' and ')}`;
  const timePart = time === undefined ? '' : ` in ${time}`;
  return `${lead}${examinedPart}${resultPhrase(tree)}${timePart}.`;
}

// The clause that says what the operation produced. Writes and counts report their own counter,
// because nReturned is zero for them.
function resultPhrase(tree: PlanTree): string {
  for (const stage of flattenStages(tree.winning)) {
    const counter = COUNTERS[stage.name];
    if (counter === undefined) {
      continue;
    }
    const count = readNumber(asRecord(stage.raw)?.[counter.key]);
    if (count !== undefined) {
      return counter.verb === 'counted'
        ? ` and counted ${count} ${plural(count)}`
        : ` ${counter.verb} ${count} ${plural(count)}`;
    }
  }
  const returned = tree.summary.nReturned;
  return returned === undefined ? '' : ` to return ${returned} ${plural(returned)}`;
}

function plural(count: number): string {
  return count === 1 ? 'document' : 'documents';
}

function shardSentence(tree: PlanTree): string | undefined {
  if (!tree.sharded) {
    return undefined;
  }
  const names = [
    ...new Set(
      flattenStages(tree.winning).flatMap((stage) =>
        stage.shard === undefined ? [] : [stage.shard],
      ),
    ),
  ];
  const count = names.length;
  return `The query ran on ${count} ${count === 1 ? 'shard' : 'shards'}: ${names.join(', ')}.`;
}

function suggestionFor(warning: PlanWarning, tree: PlanTree): string | undefined {
  const stages = flattenStages(tree.winning);
  switch (warning.code) {
    case 'COLLSCAN': {
      const stage = stages.find((candidate) => isCollectionScanStage(candidate.name));
      const scope =
        tree.summary.docsExamined === undefined
          ? 'avoid scanning the whole collection'
          : `avoid scanning ${tree.summary.docsExamined} documents`;
      const keys = indexKeyFor(stage?.filter, []);
      const target = keys.length === 0 ? 'the fields in the filter' : formatKeys(keys);
      return `Add an index on ${target} to ${scope}.`;
    }
    case 'IN_MEMORY_SORT':
      return sortAdvice(stages, tree);
    case 'SORT_SPILLED':
      return 'Add an index on the sort fields so the sort stays in memory and does not spill to disk.';
    case 'HIGH_EXAMINED_RATIO':
      return 'Add an index that matches the filter so the query examines fewer documents.';
    case 'FETCH_AFTER_COVERED_INDEX': {
      const index = tree.summary.indexesUsed[0] ?? 'the index';
      return `Exclude _id from the projection. Index ${index} then covers the query, and the fetch stage is not needed.`;
    }
    case 'MANY_REJECTED_PLANS':
      return 'Several plans competed for this query. A compound index that matches the filter and the sort can remove the competition.';
    case 'MULTIKEY_INDEX':
      return 'Use $elemMatch on the array field to match one element and cut the index keys read.';
    case 'NO_EXECUTION_STATS':
      return 'Run the explain at executionStats verbosity to see the keys, documents and time for each stage.';
  }
}

// Advice for an in-memory sort. Nothing is advised when the sort follows a stage that changes the
// documents, and nothing when an index already used starts with the advised keys.
function sortAdvice(stages: PlanStage[], tree: PlanTree): string | undefined {
  const plan = sortIndexPlan(stages, tree);
  const generic =
    'Add an index on the sort fields so the server can return sorted documents without an in-memory sort.';
  switch (plan.kind) {
    case 'blocked':
      return `The $sort follows a ${plan.blocker} stage, so an index cannot return the documents in sorted order.`;
    case 'generic':
      return generic;
    case 'covered':
      return undefined;
    case 'keys':
      return `Add an index on ${formatKeys(plan.keys)} so the server can return sorted documents without an in-memory sort.`;
  }
}

type SortIndexPlan =
  | { readonly kind: 'blocked'; readonly blocker: string }
  | { readonly kind: 'generic' }
  | { readonly kind: 'covered' }
  | { readonly kind: 'keys'; readonly keys: KeyEntry[] };

// What an index for an in-memory sort would need. Nothing is needed when the sort follows a stage
// that changes the documents, or when an index already used starts with the advised keys.
function sortIndexPlan(stages: PlanStage[], tree: PlanTree): SortIndexPlan {
  const sort = stages.find((candidate) => isSortStage(candidate.name));
  const blocker =
    sort === undefined
      ? undefined
      : precedingNames(sort).find((name) => SORT_BLOCKING_STAGES.has(name));
  if (blocker !== undefined) {
    return { kind: 'blocked', blocker };
  }
  const keys = indexKeyFor(tree.filter, sortEntries(sort));
  if (keys.length === 0) {
    return { kind: 'generic' };
  }
  const covered = stages.some((stage) => {
    const used = stage.indexKeys ?? [];
    return used.length >= keys.length && keys.every(([field], index) => used[index] === field);
  });
  return covered ? { kind: 'covered' } : { kind: 'keys', keys };
}

// The index key pattern that would remove the warning for the plan's first COLLSCAN or
// IN_MEMORY_SORT warning, as field and direction pairs. Undefined when no index is advised or the
// keys cannot be read from the query.
export function suggestedIndexKeys(tree: PlanTree): KeyEntry[] | undefined {
  const stages = flattenStages(tree.winning);
  const warning = tree.warnings.find(
    (candidate) => candidate.code === 'COLLSCAN' || candidate.code === 'IN_MEMORY_SORT',
  );
  if (warning === undefined) {
    return undefined;
  }
  if (warning.code === 'COLLSCAN') {
    const stage = stages.find((candidate) => isCollectionScanStage(candidate.name));
    const keys = indexKeyFor(stage?.filter, []);
    return keys.length === 0 ? undefined : keys;
  }
  const plan = sortIndexPlan(stages, tree);
  return plan.kind === 'keys' ? plan.keys : undefined;
}

// Names of the stages below a stage, following the first input.
function precedingNames(stage: PlanStage): string[] {
  const names: string[] = [];
  let current = stage.children[0];
  while (current !== undefined) {
    names.push(current.name);
    current = current.children[0];
  }
  return names;
}

function sortEntries(stage: PlanStage | undefined): KeyEntry[] {
  return Object.entries(stage?.sortPattern ?? {}).map(([field, direction]): KeyEntry => [
    field,
    direction,
  ]);
}

// Index key for a query. Equality fields come first, then the sort keys, then range fields. Each
// field appears once.
export function indexKeyFor(filter: unknown, sort: readonly KeyEntry[]): KeyEntry[] {
  const { equality, range } = filterFields(filter);
  const entries: KeyEntry[] = [];
  const seen = new Set<string>();
  const add = (field: string, direction: number): void => {
    if (!seen.has(field)) {
      seen.add(field);
      entries.push([field, direction]);
    }
  };
  for (const field of equality) {
    add(field, 1);
  }
  for (const [field, direction] of sort) {
    add(field, direction);
  }
  for (const field of range) {
    add(field, 1);
  }
  return entries;
}

// Top-level equality and range fields of a filter. Operators other than equality and range are
// skipped, and so are $-prefixed top-level operators such as $or.
// A top-level $and merges the fields of its clauses.
function filterFields(filter: unknown): { equality: string[]; range: string[] } {
  const record = asRecord(filter);
  const equality: string[] = [];
  const range: string[] = [];
  if (record === undefined) {
    return { equality, range };
  }
  for (const [field, value] of Object.entries(record)) {
    if (field === '$and') {
      for (const clause of asArray(value) ?? []) {
        const inner = filterFields(clause);
        equality.push(...inner.equality);
        range.push(...inner.range);
      }
      continue;
    }
    if (field.startsWith('$')) {
      continue;
    }
    const kind = operatorKind(value);
    if (kind === 'equality') {
      equality.push(field);
    } else if (kind === 'range') {
      range.push(field);
    }
  }
  return { equality, range };
}

function operatorKind(value: unknown): 'equality' | 'range' | 'other' {
  const operators = asRecord(value);
  const keys = operators === undefined ? [] : Object.keys(operators);
  if (keys.length === 0 || !keys.some((key) => key.startsWith('$'))) {
    return 'equality';
  }
  if (keys.some((key) => RANGE_OPERATORS.has(key))) {
    return 'range';
  }
  if (keys.some((key) => EQUALITY_OPERATORS.has(key))) {
    return 'equality';
  }
  // A canonical EJSON wrapper such as {"$numberInt": "7"} is a value, not an operator.
  return keys.length === 1 && keys[0] !== undefined && keys[0].startsWith('$number')
    ? 'equality'
    : 'other';
}

function formatKeys(entries: readonly KeyEntry[]): string {
  return `{ ${entries.map(([field, direction]) => `${field}: ${direction}`).join(', ')} }`;
}
