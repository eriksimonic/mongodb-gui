import {
  DEFAULT_PROFILE_LIMIT,
  MAX_PROFILE_LIMIT,
  formatMongoshSyntax,
  formatRelaxedJson,
  shapeKey,
  type ProfileEntry,
  type ProfileFilter,
  type ProfileOp,
  type ProfilingLevel,
} from '@mongo-gui/core';

export const TIME_RANGES = [
  { value: '5m', label: 'Last 5 min', minutes: 5 },
  { value: '15m', label: 'Last 15 min', minutes: 15 },
  { value: '1h', label: 'Last hour', minutes: 60 },
  { value: 'all', label: 'All time', minutes: undefined },
  { value: 'custom', label: 'Custom', minutes: undefined },
] as const;

export type TimeRange = (typeof TIME_RANGES)[number]['value'];

export const OP_CHOICES = [
  'all',
  'query',
  'insert',
  'update',
  'remove',
  'getmore',
  'command',
  'other',
] as const satisfies readonly ('all' | ProfileOp)[];

export type OpChoice = (typeof OP_CHOICES)[number];

/** The filter row. Values are the form state, so numbers and times stay as the user typed them. */
export interface ProfilerFilters {
  readonly namespace: string;
  readonly op: OpChoice;
  readonly minMillis: number | undefined;
  readonly range: TimeRange;
  /** Local date and time as a datetime-local input writes it, for example 2026-10-09T10:00. */
  readonly since: string;
  readonly until: string;
  readonly textSearch: string;
  readonly limit: number;
  /** Hides rows that `isProblematic` rejects. Applied in the renderer, never sent to the server. */
  readonly onlyProblematic: boolean;
}

export const DEFAULT_FILTERS: ProfilerFilters = {
  namespace: '',
  op: 'all',
  minMillis: undefined,
  range: 'all',
  since: '',
  until: '',
  textSearch: '',
  limit: DEFAULT_PROFILE_LIMIT,
  onlyProblematic: false,
};

export type SortKey = 'time' | 'duration';

export interface EntrySort {
  readonly key: SortKey;
  readonly direction: 'asc' | 'desc';
}

export const DEFAULT_SORT: EntrySort = { key: 'time', direction: 'desc' };

const MS_PER_MINUTE = 60_000;
const PROFILE_PLAN_COLLSCAN = /COLLSCAN/;
/** Documents examined per document returned above which a query counts as problematic. */
export const PROBLEMATIC_EXAMINED_RATIO = 100;
/** Documents examined above which a query that returned nothing counts as problematic. */
export const PROBLEMATIC_EXAMINED_EMPTY = 1000;
const COMMAND_PREVIEW_CHARS = 120;

/** Maps the filter row to the contract filter. Relative ranges are measured from `now`. */
export function filtersToQuery(filters: ProfilerFilters, now: Date): ProfileFilter {
  const since = sinceFor(filters, now);
  const until = filters.range === 'custom' ? parseLocalTime(filters.until) : undefined;
  const namespace = filters.namespace.trim();
  const textSearch = filters.textSearch.trim();
  return {
    limit: clampLimit(filters.limit),
    ...(namespace === '' ? {} : { ns: namespace }),
    ...(filters.op === 'all' ? {} : { op: filters.op }),
    ...(filters.minMillis === undefined || filters.minMillis <= 0
      ? {}
      : { minMillis: filters.minMillis }),
    ...(since === undefined ? {} : { since }),
    ...(until === undefined ? {} : { until }),
    ...(textSearch === '' ? {} : { textSearch }),
  };
}

/**
 * The filter a tail uses. A tail only delivers entries newer than its start, so the time range
 * is left out and the server's own `since` decides where the tail begins.
 */
export function tailFilterFor(filters: ProfilerFilters, now: Date): ProfileFilter {
  return filtersToQuery({ ...filters, range: 'all', since: '', until: '' }, now);
}

function sinceFor(filters: ProfilerFilters, now: Date): string | undefined {
  if (filters.range === 'custom') {
    return parseLocalTime(filters.since);
  }
  const range = TIME_RANGES.find((item) => item.value === filters.range);
  if (range === undefined || range.minutes === undefined) {
    return undefined;
  }
  return new Date(now.getTime() - range.minutes * MS_PER_MINUTE).toISOString();
}

/** Reads a datetime-local value as local time. Returns undefined for an empty or invalid value. */
export function parseLocalTime(text: string): string | undefined {
  if (text.trim() === '') {
    return undefined;
  }
  const millis = Date.parse(text);
  return Number.isNaN(millis) ? undefined : new Date(millis).toISOString();
}

export function clampLimit(limit: number): number {
  if (!Number.isFinite(limit)) {
    return DEFAULT_PROFILE_LIMIT;
  }
  return Math.min(MAX_PROFILE_LIMIT, Math.max(1, Math.trunc(limit)));
}

/**
 * Adds tail entries to the table. Entries already listed are skipped, the newest come first,
 * and the table keeps at most `limit` rows. `added` lists the ids that are new, for the highlight.
 */
export function mergeTailEntries(
  current: readonly ProfileEntry[],
  incoming: readonly ProfileEntry[],
  limit: number,
): { readonly entries: ProfileEntry[]; readonly added: string[] } {
  const known = new Set(current.map((entry) => entry.id));
  const fresh: ProfileEntry[] = [];
  for (const entry of incoming) {
    if (!known.has(entry.id)) {
      known.add(entry.id);
      fresh.push(entry);
    }
  }
  if (fresh.length === 0) {
    return { entries: [...current], added: [] };
  }
  const merged = [...fresh, ...current].sort(compareTimeDesc);
  return {
    entries: merged.slice(0, clampLimit(limit)),
    added: fresh.map((entry) => entry.id),
  };
}

export function sortEntries(entries: readonly ProfileEntry[], sort: EntrySort): ProfileEntry[] {
  const sign = sort.direction === 'asc' ? 1 : -1;
  const compare =
    sort.key === 'time'
      ? (a: ProfileEntry, b: ProfileEntry) => compareText(a.ts, b.ts)
      : (a: ProfileEntry, b: ProfileEntry) => a.millis - b.millis;
  return [...entries].sort((a, b) => sign * compare(a, b) || compareText(a.id, b.id));
}

/** A click on a sortable header. The same column flips its direction. A new column starts descending. */
export function toggleSort(sort: EntrySort, key: SortKey): EntrySort {
  if (sort.key === key) {
    return { key, direction: sort.direction === 'asc' ? 'desc' : 'asc' };
  }
  return { key, direction: 'desc' };
}

/** The rows of one query shape. The key is the shape key from core, computed on the same entries. */
export function entriesOfShape(entries: readonly ProfileEntry[], key: string): ProfileEntry[] {
  return entries.filter((entry) => shapeKey(entry) === key);
}

export function isCollscan(planSummary: string | undefined): boolean {
  return planSummary !== undefined && PROFILE_PLAN_COLLSCAN.test(planSummary);
}

/**
 * True when an entry shows one of the signs the "Only problematic" filter looks for:
 *
 * - the plan summary contains COLLSCAN;
 * - `hasSortStage` is true, so the server sorted in memory;
 * - more than 100 documents were examined per document returned (`nreturned` above 0);
 * - more than 1000 documents were examined and nothing was returned (`nreturned` 0 or absent).
 *
 * A missing plan summary or missing counters is not a sign on its own.
 */
export function isProblematic(entry: ProfileEntry): boolean {
  if (isCollscan(entry.planSummary) || entry.hasSortStage === true) {
    return true;
  }
  if (entry.docsExamined === undefined) {
    return false;
  }
  if (entry.nreturned === undefined || entry.nreturned === 0) {
    return entry.docsExamined > PROBLEMATIC_EXAMINED_EMPTY;
  }
  return entry.docsExamined / entry.nreturned > PROBLEMATIC_EXAMINED_RATIO;
}

/** Documents examined per document returned. With nothing returned, the examined count itself. */
export function examinedRatio(entry: ProfileEntry): number | undefined {
  if (entry.docsExamined === undefined) {
    return undefined;
  }
  if (entry.nreturned === undefined || entry.nreturned === 0) {
    return entry.docsExamined;
  }
  return entry.docsExamined / entry.nreturned;
}

/** Width of a duration bar as a whole percentage of the slowest row in view. */
export function durationPercent(millis: number, maxMillis: number): number {
  if (maxMillis <= 0) {
    return 0;
  }
  return Math.min(100, Math.round((millis / maxMillis) * 100));
}

export function clientLabel(entry: ProfileEntry): string {
  return entry.appName ?? entry.client ?? '-';
}

/** The command as formatted canonical extended JSON. The values arrive already canonical. */
// Fields the driver adds to every command. They are session plumbing, not part of the query, so a
// copied command or one sent to the editor leaves them out.
const DRIVER_FIELDS: readonly string[] = ['lsid', '$db', '$clusterTime', '$readPreference'];

/** The command without the driver's session fields. Other values are returned unchanged. */
export function userCommand(command: unknown): unknown {
  if (typeof command !== 'object' || command === null || Array.isArray(command)) {
    return command;
  }
  return Object.fromEntries(
    Object.entries(command).filter(([key]) => !DRIVER_FIELDS.includes(key)),
  );
}

/** What the explain of a profiler entry runs. Undefined when the entry cannot be explained. */
export interface ExplainTarget {
  readonly command: unknown;
  // Set for an update or remove, whose profiled command is a bare statement.
  readonly profileOp?: 'update' | 'remove';
  readonly collection?: string;
}

/**
 * The command to explain for a profiler entry. A getMore explains the find that opened its cursor,
 * and an entry without that command cannot be explained. An update or remove names its collection
 * from the namespace, so the router can wrap the statement.
 */
export function explainTarget(entry: ProfileEntry, command: unknown): ExplainTarget | undefined {
  if (entry.op === 'update' || entry.op === 'remove') {
    const collection = collectionOfNamespace(entry.ns);
    return collection === undefined ? undefined : { command, profileOp: entry.op, collection };
  }
  if (typeof command === 'object' && command !== null && !Array.isArray(command)) {
    const record = command as Record<string, unknown>;
    if ('getMore' in record) {
      const original = record['originatingCommand'];
      return typeof original === 'object' && original !== null && !Array.isArray(original)
        ? { command: original }
        : undefined;
    }
  }
  return { command };
}

// The collection of a namespace such as shop.orders. The database name has no dot, so the split
// is at the first one.
function collectionOfNamespace(ns: string): string | undefined {
  const dot = ns.indexOf('.');
  const collection = dot === -1 ? '' : ns.slice(dot + 1);
  return collection === '' ? undefined : collection;
}

/** The command as mongosh source, so a pasted command keeps the server's types. */
export function formatCommand(command: unknown, indent = 2): string {
  const text = JSON.stringify(command);
  return text === undefined ? '' : formatMongoshSyntax(text, { indent });
}

/** The command as relaxed extended JSON, for the JSON view. */
export function formatCommandJson(command: unknown): string {
  const text = JSON.stringify(command);
  return text === undefined ? '' : formatRelaxedJson(text);
}

/** One line of mongosh source for a table cell, shortened with an ellipsis. */
export function commandPreview(command: unknown): string {
  const text = formatCommand(command, 0);
  return text.length <= COMMAND_PREVIEW_CHARS
    ? text
    : `${text.slice(0, COMMAND_PREVIEW_CHARS - 1)}…`;
}

/** Local time with milliseconds. The table and the detail pane both show this form. */
export function formatLocalTime(iso: string): string {
  const date = new Date(iso);
  const time = date.toLocaleTimeString(undefined, { hour12: false });
  return `${time}.${String(date.getMilliseconds()).padStart(3, '0')}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit] ?? 'TB'}`;
}

/** Form state for the level control. The numbers are the values the user last applied or typed. */
export interface LevelDraft {
  readonly level: ProfilingLevel['level'];
  readonly slowMs: number;
  readonly sampleRate: number;
}

export const DEFAULT_LEVEL_DRAFT: LevelDraft = { level: 0, slowMs: 100, sampleRate: 1 };

/** Reads the value of the level control. Anything that is not 1 or 2 is Off. */
export function levelFromText(value: string): ProfilingLevel['level'] {
  if (value === '1') {
    return 1;
  }
  return value === '2' ? 2 : 0;
}

export function draftFromLevel(level: ProfilingLevel): LevelDraft {
  return {
    level: level.level,
    slowMs: level.slowMs,
    sampleRate: level.sampleRate ?? 1,
  };
}

/** True when the draft would change the server's level. */
export function isDraftDirty(draft: LevelDraft, level: ProfilingLevel | undefined): boolean {
  if (level === undefined) {
    return true;
  }
  if (draft.level !== level.level) {
    return true;
  }
  return (
    draft.level === 1 &&
    (draft.slowMs !== level.slowMs || draft.sampleRate !== (level.sampleRate ?? 1))
  );
}

/** The arguments of setLevel for a draft. Only level 1 uses the threshold and the sample rate. */
export function setLevelInput(draft: LevelDraft): {
  readonly level: ProfilingLevel['level'];
  readonly slowMs?: number;
  readonly sampleRate?: number;
} {
  if (draft.level === 1) {
    return { level: 1, slowMs: draft.slowMs, sampleRate: draft.sampleRate };
  }
  return { level: draft.level };
}

function compareTimeDesc(a: ProfileEntry, b: ProfileEntry): number {
  return compareText(b.ts, a.ts) || compareText(b.id, a.id);
}

function compareText(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  return a > b ? 1 : 0;
}
