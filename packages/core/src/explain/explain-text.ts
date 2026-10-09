import type { PlanStage, PlanTree, PlanWarning } from './plan-tree';
import { asRecord, readNumber } from './raw-values';
import { flattenStages, isCollectionScanStage, isSortStage } from './stage-walk';

const EQUALITY_OPERATORS: ReadonlySet<string> = new Set(['$eq', '$in']);
const RANGE_OPERATORS: ReadonlySet<string> = new Set(['$gt', '$gte', '$lt', '$lte']);

type KeyEntry = readonly [field: string, direction: number];

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
    sentences.push(suggestionFor(warning, tree));
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
  const examined = [
    summary.keysExamined === undefined || summary.keysExamined === 0
      ? undefined
      : `${summary.keysExamined} keys`,
    summary.docsExamined === undefined ? undefined : `${summary.docsExamined} documents`,
  ].filter((part): part is string => part !== undefined);
  const returned =
    summary.nReturned === undefined
      ? undefined
      : `${summary.nReturned} ${summary.nReturned === 1 ? 'document' : 'documents'}`;
  const time = summary.executionTimeMs === undefined ? undefined : `${summary.executionTimeMs} ms`;
  const examinedPart = examined.length === 0 ? '' : ` and examined ${examined.join(' and ')}`;
  const returnedPart = returned === undefined ? '' : ` to return ${returned}`;
  const timePart = time === undefined ? '' : ` in ${time}`;
  return `${lead}${examinedPart}${returnedPart}${timePart}.`;
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

function suggestionFor(warning: PlanWarning, tree: PlanTree): string {
  const stages = flattenStages(tree.winning);
  switch (warning.code) {
    case 'COLLSCAN': {
      const stage = stages.find((candidate) => isCollectionScanStage(candidate.name));
      const scope =
        tree.summary.docsExamined === undefined
          ? 'avoid scanning the whole collection'
          : `avoid scanning ${tree.summary.docsExamined} documents`;
      const keys = suggestIndexKeys(stage?.filter);
      if (keys.length === 0) {
        return `Add an index on the fields in the filter to ${scope}.`;
      }
      return `Add an index on ${formatKeys(keys)} to ${scope}.`;
    }
    case 'IN_MEMORY_SORT': {
      const stage = stages.find((candidate) => isSortStage(candidate.name));
      const keys = sortKeys(stage);
      const target = keys.length === 0 ? 'the sort fields' : formatKeys(keys);
      return `Add an index on ${target} so the server can return sorted documents without an in-memory sort.`;
    }
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
      return 'Each array element adds an index key, so check that the query needs the array field.';
    case 'NO_EXECUTION_STATS':
      return 'Run the explain at executionStats verbosity to see the keys, documents and time for each stage.';
  }
}

// Index key for a filter: top-level equality fields first, then range fields, all ascending.
// Operator objects other than equality and range are skipped, and so are $-prefixed top-level
// operators such as $or.
export function suggestIndexKeys(filter: unknown): KeyEntry[] {
  const record = asRecord(filter);
  if (record === undefined) {
    return [];
  }
  const equality: string[] = [];
  const range: string[] = [];
  for (const [field, value] of Object.entries(record)) {
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
  return [...new Set([...equality, ...range])].map((field) => [field, 1] as const);
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

function sortKeys(stage: PlanStage | undefined): KeyEntry[] {
  const raw = asRecord(stage?.raw);
  const spec = asRecord(raw?.[stage?.name ?? '']);
  const pattern =
    asRecord(raw?.['sortPattern']) ??
    asRecord(spec?.['sortKey']) ??
    asRecord(spec?.['sortPattern']) ??
    asRecord(raw?.['sortKey']);
  if (pattern === undefined) {
    return [];
  }
  return Object.entries(pattern).map(([field, value]): KeyEntry => [field, readNumber(value) ?? 1]);
}

function formatKeys(entries: readonly KeyEntry[]): string {
  return `{ ${entries.map(([field, direction]) => `${field}: ${direction}`).join(', ')} }`;
}
