import type { MonitorSample, RawServerSnapshot } from './types';

type PlainObject = Record<string, unknown>;

const BYTES_PER_MB = 1024 * 1024;

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
  const replication = deriveReplication(current.replSetStatus);
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
  };
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

// The primary's optime is the reference point. Without a primary, no member has a lag.
function deriveReplication(replSetStatus: unknown): MonitorSample['replication'] {
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
    const memberOptime = dateMsAt(member, ['optimeDate']);
    const lagSeconds =
      primaryOptime === undefined || memberOptime === undefined
        ? undefined
        : Math.max(0, primaryOptime - memberOptime) / 1000;
    return [
      {
        name,
        state: stringAt(member, ['stateStr']) ?? String(numberAt(member, ['state']) ?? 'unknown'),
        health: numberAt(member, ['health']) ?? 0,
        ...(lagSeconds === undefined ? {} : { lagSeconds }),
        self: member['self'] === true,
      },
    ];
  });
  return { setName, members };
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
