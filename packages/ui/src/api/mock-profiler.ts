import {
  groupByShape,
  rpcContract,
  type ProfileEntry,
  type ProfileFilter,
  type ProfilingLevel,
  type RpcCall,
  type RpcClient,
  type RpcEvent,
} from '@mongo-gui/core';
import type { z } from 'zod';
import { bulkProfileEntries, fixtureProfileEntries, tailEntry } from './mock-profiler-fixtures';

type Rpc = RpcClient['profiler'];

/** What the profiler mock needs from the mock api around it. */
export interface MockProfilerDeps {
  /** Wraps a call with input and output validation and the configured latency. */
  wrap<I extends z.ZodType, O extends z.ZodType>(
    definition: RpcCall<I, O>,
    run: (input: z.output<I>) => z.output<O> | Promise<z.output<O>>,
  ): (raw: z.input<I>) => Promise<z.output<O>>;
  requireUnlocked(): void;
  requireConnected(connectionId: string): void;
  /** False once the connection or the vault is gone. A running tail stops then. */
  isAvailable(connectionId: string): boolean;
  emit(event: RpcEvent): void;
  /** When set, every database holds this many generated rows in its own namespace. For performance checks. */
  readonly bulkRows?: number | undefined;
  /** When set, every database holds these entries instead of the fixtures. For scenario tests. */
  readonly seedEntries?: readonly ProfileEntry[] | undefined;
}

interface MockLevel {
  level: ProfilingLevel['level'];
  slowMs: number;
  sampleRate: number;
}

interface MockTail {
  readonly timer: ReturnType<typeof setInterval>;
}

const TAIL_INDEX_START = 100;
const DEFAULT_MOCK_SLOW_MS = 100;
/** Databases of the local connection that the fixtures cover. Other databases start empty. */
const FIXTURE_PREFIXES: Readonly<Record<string, string>> = {
  shop: 'shop.',
  analytics: 'analytics.',
};
const DEFAULT_LEVELS: Readonly<Record<string, MockLevel>> = {
  shop: { level: 1, slowMs: DEFAULT_MOCK_SLOW_MS, sampleRate: 1 },
  analytics: { level: 1, slowMs: DEFAULT_MOCK_SLOW_MS, sampleRate: 1 },
};

function keyOf(connectionId: string, database: string): string {
  return `${connectionId}/${database}`;
}

/** Applies the contract filter to fixture rows, the same way the adapter does for real rows. */
export function matchesProfileFilter(entry: ProfileEntry, filter: ProfileFilter): boolean {
  if (filter.ns !== undefined && entry.ns !== filter.ns) {
    return false;
  }
  if (filter.op !== undefined && entry.op !== filter.op) {
    return false;
  }
  if (filter.minMillis !== undefined && entry.millis < filter.minMillis) {
    return false;
  }
  if (filter.since !== undefined && entry.ts < filter.since) {
    return false;
  }
  if (filter.until !== undefined && entry.ts >= filter.until) {
    return false;
  }
  if (filter.textSearch !== undefined) {
    const haystack = [
      JSON.stringify(entry.command ?? ''),
      entry.ns,
      entry.planSummary ?? '',
      entry.errMsg ?? '',
    ]
      .join('\n')
      .toLowerCase();
    return haystack.includes(filter.textSearch.toLowerCase());
  }
  return true;
}

/**
 * The profiler half of the mock api. Each database keeps its own rows and level. A tail adds one
 * row per poll while the level is above 0, the way a real server writes system.profile.
 */
export function createMockProfiler(deps: MockProfilerDeps): Rpc {
  const levels = new Map<string, MockLevel>();
  const rows = new Map<string, ProfileEntry[]>();
  const tails = new Map<string, MockTail>();
  let nextTailIndex = TAIL_INDEX_START;

  function ensureDatabase(connectionId: string, database: string): string {
    const key = keyOf(connectionId, database);
    if (!rows.has(key)) {
      const prefix = FIXTURE_PREFIXES[database];
      const fixtures =
        deps.seedEntries !== undefined
          ? deps.seedEntries.slice()
          : deps.bulkRows !== undefined
            ? bulkProfileEntries(deps.bulkRows, Date.now(), database)
            : fixtureProfileEntries(Date.now()).filter(
                (entry) => prefix !== undefined && entry.ns.startsWith(prefix),
              );
      rows.set(key, fixtures);
      levels.set(
        key,
        DEFAULT_LEVELS[database] ?? { level: 0, slowMs: DEFAULT_MOCK_SLOW_MS, sampleRate: 1 },
      );
    }
    return key;
  }

  function levelOf(connectionId: string, database: string): MockLevel {
    const key = ensureDatabase(connectionId, database);
    return levels.get(key) ?? { level: 0, slowMs: DEFAULT_MOCK_SLOW_MS, sampleRate: 1 };
  }

  function matching(connectionId: string, database: string, filter: ProfileFilter): ProfileEntry[] {
    const key = ensureDatabase(connectionId, database);
    const found = (rows.get(key) ?? [])
      .filter((entry) => matchesProfileFilter(entry, filter))
      .sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
    return found.slice(0, filter.limit ?? found.length);
  }

  function stopTail(key: string): void {
    const tail = tails.get(key);
    if (tail !== undefined) {
      clearInterval(tail.timer);
      tails.delete(key);
    }
  }

  function poll(connectionId: string, database: string, filter: ProfileFilter): void {
    const key = keyOf(connectionId, database);
    if (!deps.isAvailable(connectionId)) {
      stopTail(key);
      return;
    }
    if (levelOf(connectionId, database).level === 0) {
      return;
    }
    const entry = tailEntry(nextTailIndex, Date.now());
    nextTailIndex += 1;
    const current = rows.get(key) ?? [];
    rows.set(key, [entry, ...current]);
    if (matchesProfileFilter(entry, filter)) {
      deps.emit({ type: 'profiler:entries', connectionId, database, entries: [entry] });
    }
  }

  return {
    level: deps.wrap(rpcContract.profiler.level, ({ connectionId, database }) => {
      deps.requireUnlocked();
      deps.requireConnected(connectionId);
      return levelOf(connectionId, database);
    }),
    setLevel: deps.wrap(rpcContract.profiler.setLevel, (input) => {
      deps.requireUnlocked();
      deps.requireConnected(input.connectionId);
      const key = ensureDatabase(input.connectionId, input.database);
      const current = levelOf(input.connectionId, input.database);
      const next: MockLevel = {
        level: input.level,
        slowMs: input.slowMs ?? current.slowMs,
        sampleRate: input.sampleRate ?? current.sampleRate,
      };
      levels.set(key, next);
      const result: ProfilingLevel =
        next.level === 1
          ? { level: 1, slowMs: next.slowMs, sampleRate: next.sampleRate }
          : { level: next.level, slowMs: next.slowMs };
      return result;
    }),
    list: deps.wrap(rpcContract.profiler.list, ({ connectionId, database, filter }) => {
      deps.requireUnlocked();
      deps.requireConnected(connectionId);
      return matching(connectionId, database, filter);
    }),
    shapes: deps.wrap(rpcContract.profiler.shapes, ({ connectionId, database, filter }) => {
      deps.requireUnlocked();
      deps.requireConnected(connectionId);
      return groupByShape(matching(connectionId, database, filter));
    }),
    info: deps.wrap(rpcContract.profiler.info, ({ connectionId, database }) => {
      deps.requireUnlocked();
      deps.requireConnected(connectionId);
      const count = (rows.get(ensureDatabase(connectionId, database)) ?? []).length;
      return { exists: true, sizeBytes: count * 1024, count };
    }),
    tail: deps.wrap(
      rpcContract.profiler.tail,
      ({ connectionId, database, enabled, pollMs, filter }) => {
        deps.requireUnlocked();
        deps.requireConnected(connectionId);
        const key = keyOf(connectionId, database);
        stopTail(key);
        if (!enabled) {
          return;
        }
        const timer = setInterval(() => {
          poll(connectionId, database, filter ?? {});
        }, pollMs);
        tails.set(key, { timer });
      },
    ),
  };
}
