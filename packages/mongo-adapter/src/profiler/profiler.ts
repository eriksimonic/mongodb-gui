// shell-runtime compiles this source with no Node types of its own, and the tail uses timers.
/// <reference types="node" />
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
const DEFAULT_SLOW_MS = 100;
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
    const reply: unknown = await client.db(db).command({ profile: -1 });
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
  const command: Document = { profile: parsed.data.level };
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
  const cursor = client
    .db(db)
    .collection(PROFILE_COLLECTION)
    .find(buildQuery(options))
    .sort({ ts: -1 });
  const entries: ProfileEntry[] = [];
  try {
    // The loop stops at the limit, so a text search that rejects documents keeps reading
    // until it has enough matches or the collection is exhausted.
    for await (const doc of cursor) {
      const entry = toProfileEntry(doc);
      if (matchesInMemory(entry, options)) {
        entries.push(entry);
        if (entries.length >= limit) {
          break;
        }
      }
    }
  } catch (error) {
    throw toException(error);
  }
  return entries;
}

// Polls system.profile with setTimeout chaining. Each poll reads entries at or after the newest
// timestamp already delivered, in ascending order, and skips ids already delivered at that
// timestamp. Polling works on every supported server version, unlike a tailable cursor, which
// needs a capped collection that the profiler may recreate on a level change.
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
      const fetched = await fetchAfter(client, db, cursorTs, filter, limit);
      if (stopped) {
        return;
      }
      if (fetched.length > 0) {
        const newest = fetched[fetched.length - 1]?.ts ?? cursorTs;
        const fresh = fetched.filter((entry) => entry.ts !== cursorTs || !delivered.has(entry.id));
        const carried = newest === cursorTs ? delivered : new Set<string>();
        const next = new Set(carried);
        for (const entry of fetched) {
          if (entry.ts === newest) {
            next.add(entry.id);
          }
        }
        cursorTs = newest;
        delivered = next;
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
      .listCollections({ name: PROFILE_COLLECTION }, { nameOnly: true })
      .toArray();
    if (rows.length === 0) {
      return { exists: false };
    }
    const stats: unknown = await client.db(db).command({ collStats: PROFILE_COLLECTION });
    return {
      exists: true,
      ...definedEntry('sizeBytes', readNumber(stats, 'size')),
      ...definedEntry('count', readNumber(stats, 'count')),
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
  const base = buildQuery(filter ?? {});
  const query: Document = { $and: [base, { ts: { $gte: new Date(cursorTs) } }] };
  const cursor = client
    .db(db)
    .collection(PROFILE_COLLECTION)
    .find(query)
    .sort({ ts: 1 })
    .limit(limit);
  const docs = await cursor.toArray();
  return docs.map((doc) => toProfileEntry(doc));
}

function buildQuery(filter: ProfileFilter): Document {
  const clauses: Document[] = [];
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
  return clauses.length === 0 ? {} : { $and: clauses };
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
    return safeJson(entry.command).toLowerCase().includes(needle);
  }
  return true;
}

function safeJson(value: unknown): string {
  if (value === undefined) {
    return '';
  }
  try {
    return JSON.stringify(value) ?? '';
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
