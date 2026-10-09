import type { ProfileEntry, QueryShape } from './types';

type Plain = Record<string, unknown>;

const FILTER_FIELDS = ['filter', 'pipeline', 'q', 'query'] as const;
const P95 = 0.95;

// The key that groups entries. The server's queryHash wins when present. Otherwise the key
// holds the operation, namespace, command name and the filter structure with every value
// replaced by "?".
export function shapeKey(entry: ProfileEntry): string {
  if (entry.queryHash !== undefined && entry.queryHash !== '') {
    return entry.queryHash;
  }
  const name = commandName(entry.command) ?? '-';
  const source = filterSource(entry.command);
  const structure = source === undefined ? '-' : shapeOf(source);
  return `${entry.op}|${entry.ns}|${name}|${structure}`;
}

// One group per shape key, sorted by total time spent, slowest first.
export function groupByShape(entries: readonly ProfileEntry[]): QueryShape[] {
  const groups = new Map<string, ProfileEntry[]>();
  for (const entry of entries) {
    const key = shapeKey(entry);
    const members = groups.get(key);
    if (members === undefined) {
      groups.set(key, [entry]);
    } else {
      members.push(entry);
    }
  }
  return [...groups]
    .map(([key, members]) => buildShape(key, members))
    .sort((a, b) => b.totalMillis - a.totalMillis || compareText(a.key, b.key));
}

// The nearest-rank percentile is the value at position ceil(p * n) of the ascending list, 1-based.
export function percentileNearestRank(sorted: readonly number[], percentile: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil(percentile * sorted.length)));
  return sorted[rank - 1] ?? 0;
}

function buildShape(key: string, members: readonly ProfileEntry[]): QueryShape {
  const millis = members.map((member) => member.millis).sort((a, b) => a - b);
  const count = members.length;
  const totalMillis = millis.reduce((sum, value) => sum + value, 0);
  const example = slowest(members);
  return {
    key,
    ns: example.ns,
    op: example.op,
    count,
    totalMillis,
    avgMillis: totalMillis / count,
    maxMillis: millis[count - 1] ?? 0,
    p95Millis: percentileNearestRank(millis, P95),
    example,
    planSummaries: distinctPlanSummaries(members),
  };
}

function slowest(members: readonly ProfileEntry[]): ProfileEntry {
  let best = members[0];
  for (const member of members) {
    if (best === undefined || member.millis > best.millis) {
      best = member;
    }
  }
  if (best === undefined) {
    throw new Error('groupByShape received an empty group');
  }
  return best;
}

function distinctPlanSummaries(members: readonly ProfileEntry[]): string[] {
  const summaries = new Set<string>();
  for (const member of members) {
    if (member.planSummary !== undefined) {
      summaries.add(member.planSummary);
    }
  }
  return [...summaries].sort(compareText);
}

function commandName(command: unknown): string | undefined {
  if (!isPlainDocument(command)) {
    return undefined;
  }
  return Object.keys(command)[0];
}

// Returns the part of the command that holds the query: a find filter, an aggregate pipeline,
// or the match of an update or delete.
function filterSource(command: unknown): unknown {
  if (!isPlainDocument(command)) {
    return undefined;
  }
  for (const field of FILTER_FIELDS) {
    const value = command[field];
    if (value !== undefined) {
      return value;
    }
  }
  return firstStatementMatch(command.updates) ?? firstStatementMatch(command.deletes);
}

function firstStatementMatch(statements: unknown): unknown {
  if (!Array.isArray(statements)) {
    return undefined;
  }
  const first: unknown = statements[0];
  return isPlainDocument(first) ? first.q : undefined;
}

// Values become "?", arrays become "[?]", and object keys are sorted so that field order does
// not split a shape. Operator keys such as $gt stay in place because they are part of the shape.
function shapeOf(value: unknown): string {
  if (Array.isArray(value)) {
    return '[?]';
  }
  if (isPlainDocument(value)) {
    const fields = Object.keys(value)
      .sort(compareText)
      .map((key) => `${JSON.stringify(key)}:${shapeOf(value[key])}`);
    return `{${fields.join(',')}}`;
  }
  return '?';
}

function isPlainDocument(value: unknown): value is Plain {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function compareText(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  return a > b ? 1 : 0;
}
