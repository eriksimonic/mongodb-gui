import { MongoServerError, type Document, type MongoClient } from 'mongodb';
import {
  AppErrorException,
  DEFAULT_PROFILE_LIMIT,
  ProfileFilterSchema,
  ProfilingLevelSchema,
  SetProfilingLevelInputSchema,
  TailProfileOptionsSchema,
  appError,
  toProfileEntry,
  type AppError,
  type ProfileEntry,
  type ProfileFilter,
  type ProfileOp,
  type ProfilingLevel,
  type SetProfilingLevelInput,
  type TailProfileOptions,
} from '@mongo-gui/core';
import { definedEntry, readNumber, readRecord } from '../documents';
import { mapDriverError } from '../errors';

export interface ProfileCollectionInfo {
  readonly exists: boolean;
  readonly sizeBytes?: number;
  readonly count?: number;
}

export interface ProfileTail {
  stop(): void;
  onEntries(listener: (entries: ProfileEntry[]) => void): () => void;
  onError(listener: (error: AppError) => void): () => void;
}

const PROFILE_COLLECTION = 'system.profile';
const PROFILE_NS_PATTERN = /\.system\.profile$/;
// Every read this module makes carries this comment. The exclusion clause in buildQuery drops
// those reads from listings and tails, so the profiler does not record its own polling.
const PROFILER_COMMENT = 'mongo-gui:profiler';
const DEFAULT_SLOW_MS = 100;
const TEXT_SEARCH_FETCH_FACTOR = 25;
const TEXT_SEARCH_FETCH_CAP = 50_000;
const TEXT_SEARCH_MAX_TIME_MS = 10_000;
const RAW_OPS: readonly ProfileOp[] = ['query', 'insert', 'update', 'remove', 'getmore', 'command'];

// Command names that the server reports under op "command" (or under the legacy op of the same
// meaning), keyed by the normalised op they map to. See toProfileEntry.
const COMMAND_NAMES_BY_OP: Readonly<Partial<Record<ProfileOp, readonly string[]>>> = {
  query: ['find', 'aggregate'],
  getmore: ['getMore'],
  insert: ['insert'],
  update: ['update'],
  remove: ['delete'],
};
const ALL_COMMAND_NAMES = Object.values(COMMAND_NAMES_BY_OP).flatMap((names) => names ?? []);

export async function getProfilingLevel(client: MongoClient, db: string): Promise<ProfilingLevel> {
  try {
    const reply: unknown = await client.db(db).command({ profile: -1, comment: PROFILER_COMMENT });
    return toProfilingLevel(reply);
  } catch (error) {
    throw toException(error);
  }
}

export async function setProfilingLevel(
  client: MongoClient,
  db: string,
  input: SetProfilingLevelInput,
): Promise<ProfilingLevel> {
  const parsed = SetProfilingLevelInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new AppErrorException(appError('VALIDATION', 'Invalid profiling settings'));
  }
  const command: Document = { profile: parsed.data.level, comment: PROFILER_COMMENT };
  if (parsed.data.slowMs !== undefined) {
    command.slowms = parsed.data.slowMs;
  }
  if (parsed.data.sampleRate !== undefined) {
    command.sampleRate = parsed.data.sampleRate;
  }
  if (parsed.data.filter !== undefined) {
    command.filter = parsed.data.filter;
  }
  try {
    await client.db(db).command(command);
  } catch (error) {
    throw toException(error);
  }
  return getProfilingLevel(client, db);
}

export async function listProfileEntries(
  client: MongoClient,
  db: string,
  filter: ProfileFilter,
): Promise<ProfileEntry[]> {
  const options = parseFilter(filter);
  const limit = options.limit ?? DEFAULT_PROFILE_LIMIT;
  const find = client
    .db(db)
    .collection(PROFILE_COLLECTION)
    .find(buildQuery(options), { comment: PROFILER_COMMENT })
    .sort({ ts: -1 });
  // Without a text search every fetched document is returned, so the server limit is exact.
  // A text search runs in memory, so it fetches a larger window under a time budget.
  const cursor =
    options.textSearch === undefined
      ? find.limit(limit)
      : find
          .limit(Math.min(limit * TEXT_SEARCH_FETCH_FACTOR, TEXT_SEARCH_FETCH_CAP))
          .maxTimeMS(TEXT_SEARCH_MAX_TIME_MS);
  const matched: ProfileEntry[] = [];
  try {
    // The loop stops at the limit, so a text search that rejects documents keeps reading
    // until it has enough matches or the window is exhausted.
    for await (const doc of cursor) {
      const entry = toProfileEntry(doc);
      if (matchesInMemory(entry, options)) {
        matched.push(entry);
        if (matched.length >= limit) {
          break;
        }
      }
    }
  } catch (error) {
    throw toException(error);
  }
  // Labels follow the canonical order, then the listing goes newest first like the server sort.
  return labelOccurrences(matched).reverse();
}

// Polls system.profile with setTimeout chaining. Each poll reads entries at or after the newest
// timestamp already delivered, in ascending order. Entries already delivered at that timestamp
// are recognised by their labelled id. Polling works on every supported server version, unlike a
// tailable cursor, which needs a capped collection that the profiler may recreate on a level change.
export function tailProfileEntries(
  client: MongoClient,
  db: string,
  options: TailProfileOptions,
): ProfileTail {
  const parsed = TailProfileOptionsSchema.safeParse(options);
  if (!parsed.success) {
    throw new AppErrorException(appError('VALIDATION', 'Invalid tail options'));
  }
  const { pollMs, filter } = parsed.data;
  const limit = filter?.limit ?? DEFAULT_PROFILE_LIMIT;
  const entryListeners = new Set<(entries: ProfileEntry[]) => void>();
  const errorListeners = new Set<(error: AppError) => void>();
  let cursorTs = new Date(parsed.data.since).toISOString();
  // Labelled ids already delivered at cursorTs. Each poll fetches the delivered rows again, so
  // the window grows by their count and a timestamp with more than limit rows still advances.
  let delivered = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const schedule = (delayMs: number): void => {
    if (stopped) {
      return;
    }
    timer = setTimeout(() => {
      timer = undefined;
      void poll();
    }, delayMs);
    timer.unref();
  };

  const poll = async (): Promise<void> => {
    try {
      const fetched = await fetchAfter(client, db, cursorTs, filter, limit + delivered.size);
      if (stopped) {
        return;
      }
      const newest = fetched[fetched.length - 1]?.ts;
      if (newest !== undefined) {
        const fresh = fetched.filter((entry) => entry.ts !== cursorTs || !delivered.has(entry.id));
        cursorTs = newest;
        delivered = new Set(
          fetched.filter((entry) => entry.ts === newest).map((entry) => entry.id),
        );
        const matches = fresh.filter((entry) => matchesInMemory(entry, filter));
        if (matches.length > 0) {
          for (const listener of entryListeners) {
            listener(matches);
          }
        }
      }
    } catch (error) {
      if (!stopped) {
        const failure = toException(error).error;
        for (const listener of errorListeners) {
          listener(failure);
        }
      }
    }
    schedule(pollMs);
  };

  schedule(0);

  return {
    stop(): void {
      stopped = true;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      entryListeners.clear();
      errorListeners.clear();
    },
    onEntries(listener): () => void {
      entryListeners.add(listener);
      return () => {
        entryListeners.delete(listener);
      };
    },
    onError(listener): () => void {
      errorListeners.add(listener);
      return () => {
        errorListeners.delete(listener);
      };
    },
  };
}

export async function profileCollectionInfo(
  client: MongoClient,
  db: string,
): Promise<ProfileCollectionInfo> {
  try {
    const rows: unknown[] = await client
      .db(db)
      .listCollections({ name: PROFILE_COLLECTION }, { nameOnly: true, comment: PROFILER_COMMENT })
      .toArray();
    if (rows.length === 0) {
      return { exists: false };
    }
    const stats: unknown[] = await client
      .db(db)
      .collection(PROFILE_COLLECTION)
      .aggregate([{ $collStats: { storageStats: {} } }], { comment: PROFILER_COMMENT })
      .toArray();
    const storage = readRecord(stats[0], 'storageStats');
    return {
      exists: true,
      ...definedEntry('sizeBytes', readNumber(storage, 'size')),
      ...definedEntry('count', readNumber(storage, 'count')),
    };
  } catch (error) {
    throw toException(error);
  }
}

function parseFilter(filter: ProfileFilter): ProfileFilter {
  const parsed = ProfileFilterSchema.safeParse(filter);
  if (!parsed.success) {
    throw new AppErrorException(appError('VALIDATION', 'Invalid profile filter'));
  }
  return parsed.data;
}

async function fetchAfter(
  client: MongoClient,
  db: string,
  cursorTs: string,
  filter: ProfileFilter | undefined,
  limit: number,
): Promise<ProfileEntry[]> {
  const query: Document = {
    $and: [buildQuery(filter ?? {}), { ts: { $gte: new Date(cursorTs) } }],
  };
  const docs = await client
    .db(db)
    .collection(PROFILE_COLLECTION)
    .find(query, { comment: PROFILER_COMMENT })
    .sort({ ts: 1 })
    .limit(limit)
    .toArray();
  return labelOccurrences(docs.map((doc) => toProfileEntry(doc)));
}

// Every query excludes the profiler's own reads and anything in system.profile itself.
function buildQuery(filter: ProfileFilter): Document {
  const clauses: Document[] = [
    { ns: { $not: PROFILE_NS_PATTERN } },
    { 'command.comment': { $ne: PROFILER_COMMENT } },
  ];
  if (filter.ns !== undefined) {
    clauses.push({ ns: filter.ns });
  }
  if (filter.op !== undefined) {
    clauses.push(opClause(filter.op));
  }
  if (filter.minMillis !== undefined) {
    clauses.push({ millis: { $gte: filter.minMillis } });
  }
  const range: Document = {};
  if (filter.since !== undefined) {
    range.$gte = new Date(filter.since);
  }
  if (filter.until !== undefined) {
    range.$lt = new Date(filter.until);
  }
  if (Object.keys(range).length > 0) {
    clauses.push({ ts: range });
  }
  return { $and: clauses };
}

// Server-side approximation of the normalised op. matchesInMemory checks the normalised op too,
// so this clause only needs to keep the right documents, not to be exact.
function opClause(op: ProfileOp): Document {
  if (op === 'other') {
    return { op: { $nin: [...RAW_OPS] } };
  }
  if (op === 'command') {
    return {
      op: 'command',
      $nor: ALL_COMMAND_NAMES.map((name) => ({ [`command.${name}`]: { $exists: true } })),
    };
  }
  const commandNames = COMMAND_NAMES_BY_OP[op] ?? [];
  return {
    $or: [
      { op },
      ...commandNames.map((name) => ({ op: 'command', [`command.${name}`]: { $exists: true } })),
    ],
  };
}

function matchesInMemory(entry: ProfileEntry, filter: ProfileFilter | undefined): boolean {
  if (filter === undefined) {
    return true;
  }
  if (filter.op !== undefined && entry.op !== filter.op) {
    return false;
  }
  if (filter.minMillis !== undefined && entry.millis < filter.minMillis) {
    return false;
  }
  if (filter.textSearch !== undefined) {
    const needle = filter.textSearch.toLowerCase();
    const haystack = [
      safeJson(entry.command),
      entry.ns,
      entry.planSummary ?? '',
      entry.errMsg ?? '',
    ].join('\n');
    return haystack.toLowerCase().includes(needle);
  }
  return true;
}

// Profile documents with the same content in the same millisecond share a base id. Each repeat
// gets a suffix with its occurrence index, so ids stay unique within one listing or poll.
// The suffixes follow one order, ascending by timestamp then base id, whatever order the server
// returned the batch in. A list and a tail that read the same documents then label them alike,
// so the renderer never shows one document twice under two ids.
export function labelOccurrences(entries: readonly ProfileEntry[]): ProfileEntry[] {
  const ordered = [...entries].sort((a, b) => compareText(a.ts, b.ts) || compareText(a.id, b.id));
  const occurrences = new Map<string, number>();
  return ordered.map((entry) => {
    const key = `${entry.ts}|${entry.id}`;
    const occurrence = occurrences.get(key) ?? 0;
    occurrences.set(key, occurrence + 1);
    return occurrence === 0 ? entry : { ...entry, id: `${entry.id}~${occurrence}` };
  });
}

function compareText(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  return a > b ? 1 : 0;
}

function safeJson(value: unknown): string {
  if (value === undefined) {
    return '';
  }
  try {
    return (
      JSON.stringify(value, (_key, item: unknown) =>
        typeof item === 'bigint' ? item.toString() : item,
      ) ?? ''
    );
  } catch {
    return '';
  }
}

function toProfilingLevel(reply: unknown): ProfilingLevel {
  const sampleRate = readNumber(reply, 'sampleRate');
  const filter = readRecord(reply, 'filter');
  const parsed = ProfilingLevelSchema.safeParse({
    level: readNumber(reply, 'was'),
    slowMs: readNumber(reply, 'slowms') ?? DEFAULT_SLOW_MS,
    ...definedEntry('sampleRate', sampleRate),
    ...definedEntry('filter', filter),
  });
  if (!parsed.success) {
    throw new AppErrorException(
      appError('COMMAND_FAILED', 'The server did not report a profiling level'),
    );
  }
  return parsed.data;
}

// A server reply that carries an error code is a refusal. Auth and connection failures keep
// the codes that mapDriverError assigns to them.
function toException(error: unknown): AppErrorException {
  if (error instanceof AppErrorException) {
    return error;
  }
  const mapped = mapDriverError(error);
  if (error instanceof MongoServerError && mapped.code !== 'AUTH_FAILED') {
    return new AppErrorException(
      appError('COMMAND_FAILED', 'The server refused the profiler command', mapped.detail),
    );
  }
  return new AppErrorException(mapped);
}
