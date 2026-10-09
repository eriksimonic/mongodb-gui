import { CATALOG_SERIES, REPLICA_MEMBER_SEGMENT, type SeriesSpec } from './catalog';
import type { MonitorSample, RawServerSnapshot } from './types';

type PlainObject = Record<string, unknown>;

const BYTES_PER_MB = 1024 * 1024;
// Series keys for replica members read `<series id>@<member name>`. Member names hold colons.
const MEMBER_KEY_SEPARATOR = '@';

export function deriveSample(
  previous: RawServerSnapshot | undefined,
  current: RawServerSnapshot,
): MonitorSample {
  const status = current.serverStatus;
  const before = previous?.serverStatus;
  const elapsedSeconds = previous === undefined ? 0 : (current.at - previous.at) / 1000;
  const rate = (path: readonly string[]): number =>
    ratePerSecond(numberAt(before, path), numberAt(status, path), elapsedSeconds);

  const wiredTiger = deriveWiredTiger(previous?.serverStatus, status, elapsedSeconds);
  const globalLock = deriveGlobalLock(status);
  const replication = deriveReplication(
    current.replSetStatus,
    deriveOplogWindow(current.oplogFirst, current.oplogLast),
  );
  const active = numberAt(status, ['connections', 'active']);
  const pageFaults = numberAt(status, ['extra_info', 'page_faults']);

  return {
    at: new Date(current.at).toISOString(),
    uptimeSeconds: numberAt(status, ['uptime']) ?? 0,
    opcounters: {
      insert: rate(['opcounters', 'insert']),
      query: rate(['opcounters', 'query']),
      update: rate(['opcounters', 'update']),
      delete: rate(['opcounters', 'delete']),
      getmore: rate(['opcounters', 'getmore']),
      command: rate(['opcounters', 'command']),
    },
    connections: {
      current: numberAt(status, ['connections', 'current']) ?? 0,
      available: numberAt(status, ['connections', 'available']) ?? 0,
      ...(active === undefined ? {} : { active }),
    },
    network: {
      bytesInPerSec: rate(['network', 'bytesIn']),
      bytesOutPerSec: rate(['network', 'bytesOut']),
      requestsPerSec: rate(['network', 'numRequests']),
    },
    memory: {
      residentMb: numberAt(status, ['mem', 'resident']) ?? 0,
      virtualMb: numberAt(status, ['mem', 'virtual']) ?? 0,
    },
    ...(wiredTiger === undefined ? {} : { wiredTiger }),
    ...(globalLock === undefined ? {} : { globalLock }),
    ...(replication === undefined ? {} : { replication }),
    ...(pageFaults === undefined ? {} : { pageFaultsPerSec: rate(['extra_info', 'page_faults']) }),
    series: deriveSeries(previous, current),
  };
}

/**
 * One value per catalogue series, keyed by series id. Counters become per-second rates, and a
 * counter that went down (a restart) gives zero. Gauges pass through. A series the server did not
 * report is left out, so a chart shows a gap and not a zero. A counter needs two snapshots, so the
 * first sample has no counter series. A `*` path segment yields one key per replica member.
 */
export function deriveSeries(
  previous: RawServerSnapshot | undefined,
  current: RawServerSnapshot,
  catalog: readonly SeriesSpec[] = CATALOG_SERIES,
): Record<string, number> {
  const elapsedSeconds = previous === undefined ? 0 : (current.at - previous.at) / 1000;
  const series: Record<string, number> = {};
  for (const spec of catalog) {
    const now = valuesOfSeries(current, spec);
    if (spec.kind === 'gauge') {
      for (const [key, value] of now) {
        series[key] = value;
      }
      continue;
    }
    if (previous === undefined || elapsedSeconds <= 0) {
      continue;
    }
    const before = valuesOfSeries(previous, spec);
    for (const [key, value] of now) {
      const earlier = before.get(key);
      if (earlier !== undefined) {
        series[key] = Math.max(0, value - earlier) / elapsedSeconds;
      }
    }
  }
  return series;
}

/** The values one series reads from one snapshot, keyed by series key. Empty when absent. */
function valuesOfSeries(snapshot: RawServerSnapshot, spec: SeriesSpec): Map<string, number> {
  const values = new Map<string, number>();
  const [first, second, third] = spec.path;
  if (first === 'repl' && second === 'lag') {
    if (third !== REPLICA_MEMBER_SEGMENT) {
      return values;
    }
    const replication = deriveReplication(snapshot.replSetStatus, oplogWindowOf(snapshot));
    for (const member of replication?.members ?? []) {
      if (member.lagSeconds !== undefined) {
        values.set(`${spec.id}${MEMBER_KEY_SEPARATOR}${member.name}`, member.lagSeconds);
      }
    }
    return values;
  }
  const value = valueOfPath(snapshot, spec.path);
  if (value !== undefined) {
    values.set(spec.id, value);
  }
  return values;
}

// Virtual sources come first. Every other path is a plain serverStatus read.
function valueOfPath(snapshot: RawServerSnapshot, path: readonly string[]): number | undefined {
  const [first, second, third] = path;
  const status = snapshot.serverStatus;
  if (first === 'oplog' && second === 'windowSeconds') {
    return oplogWindowOf(snapshot);
  }
  if (first === 'tickets') {
    return ticketCount(status, second, third);
  }
  if (first === 'wiredTiger' && second === 'checkpoints') {
    return checkpointCount(status);
  }
  if (first === 'wiredTiger' && second === 'checkpointMs') {
    return checkpointMs(status);
  }
  if (first === 'wiredTiger' && second === 'fillPercent') {
    return cacheFillPercent(status);
  }
  if (first === 'locks' && second === 'deadlockCount') {
    return deadlockTotal(status);
  }
  return realValue(status, path);
}

function realValue(status: unknown, path: readonly string[]): number | undefined {
  const value = numberAt(status, path);
  if (value === undefined) {
    return undefined;
  }
  // The memory section reports megabytes, and the catalogue stores bytes.
  return path[0] === 'mem' ? value * BYTES_PER_MB : value;
}

function oplogWindowOf(snapshot: RawServerSnapshot): number | undefined {
  return deriveOplogWindow(snapshot.oplogFirst, snapshot.oplogLast);
}

// The ticket pool sits under wiredTiger.concurrentTransactions up to 6.0, and under queues.execution
// from 7.0 on. The first location that reports the field wins.
function ticketCount(
  status: unknown,
  pool: string | undefined,
  field: string | undefined,
): number | undefined {
  if ((pool !== 'read' && pool !== 'write') || field === undefined) {
    return undefined;
  }
  return (
    numberAt(status, ['wiredTiger', 'concurrentTransactions', pool, field]) ??
    numberAt(status, ['queues', 'execution', pool, field])
  );
}

// The checkpoint count moved between versions. Older servers count it under wiredTiger.transaction.
function checkpointCount(status: unknown): number | undefined {
  return (
    numberAt(status, ['wiredTiger', 'transaction', 'transaction checkpoints']) ??
    numberAt(status, ['wiredTiger', 'checkpoint', 'total succeed number of checkpoints'])
  );
}

// The duration of the most recent checkpoint moved with the count. 8.0 reports it under wiredTiger.checkpoint.
function checkpointMs(status: unknown): number | undefined {
  return (
    numberAt(status, [
      'wiredTiger',
      'transaction',
      'transaction checkpoint most recent time (msecs)',
    ]) ?? numberAt(status, ['wiredTiger', 'checkpoint', 'most recent time (msecs)'])
  );
}

function cacheFillPercent(status: unknown): number | undefined {
  const used = numberAt(status, ['wiredTiger', 'cache', 'bytes currently in the cache']);
  const max = numberAt(status, ['wiredTiger', 'cache', 'maximum bytes configured']);
  if (used === undefined || max === undefined || max <= 0) {
    return undefined;
  }
  return (used / max) * 100;
}

// Each lock resource reports its deadlockCount only after its first deadlock. A locks section with
// no such field means no deadlock has happened yet, so the total is zero. A missing section is unknown.
function deadlockTotal(status: unknown): number | undefined {
  const locks = valueAt(status, ['locks']);
  if (!isPlainObject(locks)) {
    return undefined;
  }
  let total = 0;
  for (const resource of Object.values(locks)) {
    total += numberAt(resource, ['deadlockCount']) ?? 0;
  }
  return total;
}

// A counter that goes down means the server restarted, so the rate for that interval is zero.
function ratePerSecond(
  previous: number | undefined,
  current: number | undefined,
  elapsedSeconds: number,
): number {
  if (previous === undefined || current === undefined || elapsedSeconds <= 0) {
    return 0;
  }
  const delta = current - previous;
  return delta < 0 ? 0 : delta / elapsedSeconds;
}

function deriveWiredTiger(
  previousStatus: unknown,
  status: unknown,
  elapsedSeconds: number,
): MonitorSample['wiredTiger'] {
  const cacheUsed = numberAt(status, ['wiredTiger', 'cache', 'bytes currently in the cache']);
  if (cacheUsed === undefined) {
    return undefined;
  }
  const cachePath = (name: string): readonly string[] => ['wiredTiger', 'cache', name];
  const rate = (name: string): number =>
    ratePerSecond(
      numberAt(previousStatus, cachePath(name)),
      numberAt(status, cachePath(name)),
      elapsedSeconds,
    );
  return {
    cacheUsedMb: cacheUsed / BYTES_PER_MB,
    cacheMaxMb: (numberAt(status, cachePath('maximum bytes configured')) ?? 0) / BYTES_PER_MB,
    cacheDirtyMb:
      (numberAt(status, cachePath('tracked dirty bytes in the cache')) ?? 0) / BYTES_PER_MB,
    readIntoCachePerSec: rate('bytes read into cache'),
    writtenFromCachePerSec: rate('bytes written from cache'),
  };
}

function deriveGlobalLock(status: unknown): MonitorSample['globalLock'] {
  const queued = numberAt(status, ['globalLock', 'currentQueue', 'total']);
  if (queued === undefined) {
    return undefined;
  }
  return {
    currentQueueReaders: numberAt(status, ['globalLock', 'currentQueue', 'readers']) ?? 0,
    currentQueueWriters: numberAt(status, ['globalLock', 'currentQueue', 'writers']) ?? 0,
    activeReaders: numberAt(status, ['globalLock', 'activeClients', 'readers']) ?? 0,
    activeWriters: numberAt(status, ['globalLock', 'activeClients', 'writers']) ?? 0,
  };
}

// The primary's optime is the reference point. Only a healthy secondary with a real optime has a
// lag. The primary reports no lag, and an unreachable member reports a zero or stale optime.
function deriveReplication(
  replSetStatus: unknown,
  oplogWindowSeconds: number | undefined,
): MonitorSample['replication'] {
  const setName = stringAt(replSetStatus, ['set']);
  if (setName === undefined) {
    return undefined;
  }
  const rawMembers = arrayAt(replSetStatus, ['members']).filter(isPlainObject);
  const primary = rawMembers.find((member) => stringAt(member, ['stateStr']) === 'PRIMARY');
  const primaryOptime = dateMsAt(primary, ['optimeDate']);
  const members = rawMembers.flatMap((member) => {
    const name = stringAt(member, ['name']);
    if (name === undefined) {
      return [];
    }
    const state =
      stringAt(member, ['stateStr']) ?? String(numberAt(member, ['state']) ?? 'unknown');
    const lagSeconds = memberLagSeconds(member, state, primaryOptime);
    return [
      {
        name,
        state,
        health: numberAt(member, ['health']) ?? 0,
        ...(lagSeconds === undefined ? {} : { lagSeconds }),
        self: member['self'] === true,
      },
    ];
  });
  return {
    setName,
    members,
    ...(oplogWindowSeconds === undefined ? {} : { oplogWindowSeconds }),
  };
}

function memberLagSeconds(
  member: PlainObject,
  state: string,
  primaryOptime: number | undefined,
): number | undefined {
  const memberOptime = dateMsAt(member, ['optimeDate']);
  const healthy = numberAt(member, ['health']) === 1;
  if (
    primaryOptime === undefined ||
    memberOptime === undefined ||
    memberOptime <= 0 ||
    !healthy ||
    state !== 'SECONDARY'
  ) {
    return undefined;
  }
  return Math.max(0, primaryOptime - memberOptime) / 1000;
}

// The window runs from the first to the last oplog entry. A timestamp's seconds are unsigned, so
// the high 32 bits are read as unsigned. A signed read would break after 2038-01-19.
function deriveOplogWindow(first: unknown, last: unknown): number | undefined {
  const firstSeconds = timestampSeconds(first);
  const lastSeconds = timestampSeconds(last);
  if (firstSeconds === undefined || lastSeconds === undefined || lastSeconds < firstSeconds) {
    return undefined;
  }
  return lastSeconds - firstSeconds;
}

function timestampSeconds(entry: unknown): number | undefined {
  const seconds = numberAt(entry, ['ts', 't']);
  if (seconds !== undefined) {
    return seconds;
  }
  const high = numberAt(entry, ['ts', 'high']);
  return high === undefined ? undefined : high >>> 0;
}

function isPlainObject(value: unknown): value is PlainObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function valueAt(source: unknown, path: readonly string[]): unknown {
  let current: unknown = source;
  for (const key of path) {
    if (!isPlainObject(current)) {
      return undefined;
    }
    current = current[key];
  }
  return current;
}

// BigInt values come from Long fields when promoteLongs is off. Both forms are counters.
function numberAt(source: unknown, path: readonly string[]): number | undefined {
  const value = valueAt(source, path);
  if (typeof value === 'bigint') {
    return Number(value);
  }
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stringAt(source: unknown, path: readonly string[]): string | undefined {
  const value = valueAt(source, path);
  return typeof value === 'string' ? value : undefined;
}

function arrayAt(source: unknown, path: readonly string[]): unknown[] {
  const value = valueAt(source, path);
  return Array.isArray(value) ? value : [];
}

function dateMsAt(source: unknown, path: readonly string[]): number | undefined {
  const value = valueAt(source, path);
  if (!(value instanceof Date)) {
    return undefined;
  }
  const time = value.getTime();
  return Number.isFinite(time) ? time : undefined;
}
