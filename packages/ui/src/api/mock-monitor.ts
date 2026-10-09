import {
  AppErrorException,
  appError,
  CATALOG_SERIES,
  DEFAULT_MONITOR_INTERVAL_MS,
  DEFAULT_MONITOR_RETENTION_MS,
  type SeriesUnit,
  type MonitorConfig,
  type MonitorSample,
  type RpcEvent,
  type RunningOperation,
} from '@mongo-gui/core';
import { mergeSamples } from '../monitor/series';

export interface MockMonitorOptions {
  readonly emit: (event: RpcEvent) => void;
  /** Adds the replication section to samples for these connections. */
  readonly hasReplication: (connectionId: string) => boolean;
  readonly now?: () => number;
}

export interface MockOperationsOptions {
  readonly includeIdle: boolean;
  readonly includeSystem: boolean;
}

export interface MockMonitor {
  start(connectionId: string, intervalMs?: number): MonitorConfig;
  stop(connectionId: string): void;
  samples(connectionId: string, sinceIso?: string): MonitorSample[];
  setInterval(connectionId: string, intervalMs: number): MonitorConfig;
  operations(connectionId: string, options: MockOperationsOptions): RunningOperation[];
  killOperation(connectionId: string, opid: string | number): void;
  /** Stops the sampler for one connection. Used when the connection leaves the connected state. */
  stopConnection(connectionId: string): void;
  stopAll(): void;
}

interface Run {
  config: MonitorConfig;
  readonly replication: boolean;
  readonly random: () => number;
  readonly uptimeBase: number;
  readonly history: MonitorSample[];
  timer: ReturnType<typeof setInterval> | undefined;
  tick: number;
}

interface FixtureOperation {
  readonly operation: RunningOperation;
  /** Seconds the operation had already run when the mock started. */
  readonly baseSeconds: number;
  readonly idle: boolean;
  readonly system: boolean;
}

const BACKFILL_SAMPLES = 150;
const SPIKE_PERIOD = 90;
const SPIKE_LENGTH = 10;
const CACHE_MAX_MB = 2048;
const RESIDENT_BASE_MB = 1820;
const VIRTUAL_OVERHEAD_MB = 1340;
// A server's connection limit is large. Available connections sit near this value, so the chart
// shows open connections on their own scale.
const CONNECTION_LIMIT = 800_000;
const BYTES_IN_PER_OP = 1150;
const BYTES_OUT_PER_OP = 2400;
const MS_PER_SECOND = 1000;
const MAX_HISTORY = 3600;
const UPTIME_BASE_SECONDS = 86_400;

// The operations stay in the mock until killed. The aggregation running for 214 s is the long one.
const FIXTURE_OPERATIONS: readonly FixtureOperation[] = [
  {
    operation: {
      opid: 1041,
      active: true,
      op: 'query',
      ns: 'shop.orders',
      client: '10.0.0.12:52110',
      desc: 'conn41',
      appName: 'orders-api',
      planSummary: 'IXSCAN { status: 1, createdAt: -1 }',
      command: { find: 'orders', filter: { status: 'paid' }, limit: 50 },
      waitingForLock: false,
    },
    baseSeconds: 0,
    idle: false,
    system: false,
  },
  {
    operation: {
      opid: 1052,
      active: true,
      op: 'update',
      ns: 'shop.orders',
      client: '10.0.0.12:52118',
      desc: 'conn52',
      appName: 'orders-api',
      planSummary: 'IXSCAN { orderNumber: 1 }',
      command: {
        update: 'orders',
        updates: [{ q: { orderNumber: 42 }, u: { $set: { status: 'shipped' } } }],
      },
      waitingForLock: true,
    },
    baseSeconds: 1,
    idle: false,
    system: false,
  },
  {
    operation: {
      opid: 1077,
      active: true,
      op: 'command',
      ns: 'shop.events',
      client: '10.0.0.20:40876',
      desc: 'conn77',
      appName: 'nightly-report',
      planSummary: 'COLLSCAN',
      command: {
        aggregate: 'events',
        pipeline: [
          { $match: { type: 'checkout' } },
          { $group: { _id: '$userId', count: { $sum: 1 } } },
        ],
        cursor: {},
      },
      waitingForLock: false,
    },
    baseSeconds: 214,
    idle: false,
    system: false,
  },
  {
    operation: {
      opid: 'conn:88',
      active: false,
      op: 'none',
      ns: '',
      client: '10.0.0.14:50231',
      appName: 'reporting',
      desc: 'conn88',
    },
    baseSeconds: 0,
    idle: true,
    system: false,
  },
  {
    operation: {
      opid: 12,
      active: false,
      op: 'none',
      ns: '',
      desc: 'JournalFlusher',
    },
    baseSeconds: 0,
    idle: false,
    system: true,
  },
];

/** Deterministic pseudo-random numbers in [0, 1), so stories and tests see the same series. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function seedFor(connectionId: string): number {
  let seed = 7;
  for (const character of connectionId) {
    seed = (seed * 31 + character.charCodeAt(0)) >>> 0;
  }
  return seed;
}

function clamp(value: number, min: number): number {
  return Math.max(min, value);
}

/**
 * Builds the sample for one tick. A slow wave gives a rhythm, noise gives jitter, and every
 * SPIKE_PERIOD ticks a short spike lifts operations, queues and replication lag.
 */
function sampleAt(run: Run, tick: number, at: number, intervalMs: number): MonitorSample {
  const noise = (scale: number): number => (run.random() - 0.5) * 2 * scale;
  const wave = (amplitude: number, period: number): number => amplitude * Math.sin(tick / period);
  const spike = tick % SPIKE_PERIOD >= SPIKE_PERIOD - SPIKE_LENGTH ? 1 : 0;

  const opcounters = {
    insert: clamp(42 + wave(12, 40) + noise(5) + spike * 60, 0),
    query: clamp(180 + wave(55, 25) + noise(12) + spike * 320, 0),
    update: clamp(64 + wave(14, 35) + noise(6) + spike * 40, 0),
    delete: clamp(9 + wave(3, 50) + noise(1.5), 0),
    getmore: clamp(33 + wave(9, 30) + noise(3) + spike * 20, 0),
    command: clamp(88 + wave(15, 45) + noise(8) + spike * 80, 0),
  };
  const totalOps =
    opcounters.insert +
    opcounters.query +
    opcounters.update +
    opcounters.delete +
    opcounters.getmore +
    opcounters.command;
  const current = Math.round(clamp(38 + wave(4, 60) + noise(1) + spike * 14, 1));
  const residentMb = RESIDENT_BASE_MB + wave(25, 120) + tick * 0.02 + noise(4);
  const cacheUsedMb = Math.min(CACHE_MAX_MB - 8, 1180 + wave(60, 70) + tick * 0.05 + noise(6));

  const sample: MonitorSample = {
    series: {},
    at: new Date(at).toISOString(),
    uptimeSeconds: run.uptimeBase + (tick * intervalMs) / MS_PER_SECOND,
    opcounters,
    connections: {
      current,
      available: CONNECTION_LIMIT - current,
      active: Math.round(current * 0.4),
    },
    network: {
      bytesInPerSec: clamp(totalOps * BYTES_IN_PER_OP + noise(8000), 0),
      bytesOutPerSec: clamp(totalOps * BYTES_OUT_PER_OP + noise(15000), 0),
      requestsPerSec: totalOps,
    },
    memory: {
      residentMb,
      virtualMb: residentMb + VIRTUAL_OVERHEAD_MB + noise(3),
    },
    wiredTiger: {
      cacheUsedMb,
      cacheMaxMb: CACHE_MAX_MB,
      cacheDirtyMb: clamp(22 + wave(6, 20) + noise(2), 0),
      readIntoCachePerSec: clamp(2_100_000 + noise(120_000), 0),
      writtenFromCachePerSec: clamp(1_200_000 + noise(90_000) + spike * 400_000, 0),
    },
    globalLock: {
      // Queues stay at zero except during a spike, where the lock is contended.
      currentQueueReaders: Math.round(clamp(0.1 + noise(0.3) + spike * 5, 0)),
      currentQueueWriters: Math.round(clamp(0.1 + noise(0.2) + spike * 2, 0)),
      activeReaders: Math.round(clamp(opcounters.query / 20 + noise(1), 0)),
      activeWriters: Math.round(clamp(opcounters.update / 25 + noise(1), 0)),
    },
  };
  if (run.replication) {
    const lagBase = 0.4 + wave(0.25, 30) + spike * 2.5;
    sample.replication = {
      setName: 'rs0',
      members: [
        { name: 'db-1:27017', state: 'PRIMARY', health: 1, self: true },
        {
          name: 'db-2:27017',
          state: 'SECONDARY',
          health: 1,
          lagSeconds: clamp(lagBase + noise(0.2), 0),
          self: false,
        },
        {
          name: 'db-3:27017',
          state: 'SECONDARY',
          health: 1,
          lagSeconds: clamp(lagBase * 1.4 + noise(0.3), 0),
          self: false,
        },
      ],
      oplogWindowSeconds: 7_200 + wave(120, 80),
    };
  }
  Object.assign(sample.series, seriesValues(run, tick, sample));
  return sample;
}

const MIB = 1024 * 1024;

/** Values for series the sample's own fields do not hold. Ticket pools sit near their totals. */
const GENERIC_BASE: Readonly<Record<SeriesUnit, number>> = {
  count: 12,
  'per-second': 25,
  bytes: 512 * MIB,
  'bytes-per-second': 150_000,
  ms: 35,
  percent: 40,
  seconds: 7200,
};
const GENERIC_BASE_OVERRIDES: Readonly<Record<string, number>> = {
  'tickets-read-available': 120,
  'tickets-read-out': 8,
  'tickets-write-available': 124,
  'tickets-write-out': 4,
  'queue-readers': 0,
  'queue-writers': 0,
  deadlocks: 0,
  'cursor-timed-out': 0,
};

/** Series with a value in the sample's own fields. Each one matches the field it is drawn from. */
const FROM_SAMPLE: Readonly<Record<string, (sample: MonitorSample) => number | undefined>> = {
  'op-insert': (sample) => sample.opcounters.insert,
  'op-query': (sample) => sample.opcounters.query,
  'op-update': (sample) => sample.opcounters.update,
  'op-delete': (sample) => sample.opcounters.delete,
  'op-getmore': (sample) => sample.opcounters.getmore,
  'op-command': (sample) => sample.opcounters.command,
  'conn-current': (sample) => sample.connections.current,
  'conn-active': (sample) => sample.connections.active,
  'conn-available': (sample) => sample.connections.available,
  'net-in': (sample) => sample.network.bytesInPerSec,
  'net-out': (sample) => sample.network.bytesOutPerSec,
  'net-requests': (sample) => sample.network.requestsPerSec,
  'mem-resident': (sample) => sample.memory.residentMb * MIB,
  'mem-virtual': (sample) => sample.memory.virtualMb * MIB,
  'wt-cache-used': (sample) =>
    sample.wiredTiger === undefined ? undefined : sample.wiredTiger.cacheUsedMb * MIB,
  'wt-cache-dirty': (sample) =>
    sample.wiredTiger === undefined ? undefined : sample.wiredTiger.cacheDirtyMb * MIB,
  'wt-cache-max': (sample) =>
    sample.wiredTiger === undefined ? undefined : sample.wiredTiger.cacheMaxMb * MIB,
  'wt-cache-fill': (sample) =>
    sample.wiredTiger === undefined || sample.wiredTiger.cacheMaxMb <= 0
      ? undefined
      : (sample.wiredTiger.cacheUsedMb / sample.wiredTiger.cacheMaxMb) * 100,
  'wt-bytes-read-in': (sample) => sample.wiredTiger?.readIntoCachePerSec,
  'wt-bytes-written-out': (sample) => sample.wiredTiger?.writtenFromCachePerSec,
  'queue-readers': (sample) => sample.globalLock?.currentQueueReaders,
  'queue-writers': (sample) => sample.globalLock?.currentQueueWriters,
  'oplog-window': (sample) => sample.replication?.oplogWindowSeconds,
  'page-faults': (sample) => sample.pageFaultsPerSec,
};

/**
 * One value per catalogue series, as the real sampler would produce them. Series the sample holds
 * take the sample's value, so the two agree. Replica lag is one key per member. The rest are generated
 * from a per-unit base with a slow wave, keyed by the series id.
 */
function seriesValues(run: Run, tick: number, sample: MonitorSample): Record<string, number> {
  const values: Record<string, number> = {};
  for (const spec of CATALOG_SERIES) {
    if (spec.path[0] === 'repl' && spec.path[1] === 'lag') {
      if (run.replication) {
        for (const member of sample.replication?.members ?? []) {
          if (member.lagSeconds !== undefined) {
            values[`${spec.id}@${member.name}`] = member.lagSeconds;
          }
        }
      }
      continue;
    }
    const fromSample = FROM_SAMPLE[spec.id]?.(sample);
    if (fromSample !== undefined && Number.isFinite(fromSample)) {
      values[spec.id] = Math.max(0, fromSample);
      continue;
    }
    const base = GENERIC_BASE_OVERRIDES[spec.id] ?? GENERIC_BASE[spec.unit];
    const phase = seedFor(spec.id) % 97;
    const wave = 1 + 0.25 * Math.sin(tick / (20 + (phase % 40)) + phase);
    values[spec.id] = Math.max(0, base * wave * (1 + (run.random() - 0.5) * 0.1));
  }
  return values;
}

/**
 * A fake sampler for the browser mock. A start fills the history with a backfill, so the charts
 * have a full window on the first render. After that it emits one sample per interval, as the
 * real sampler does.
 */
export function createMockMonitor(options: MockMonitorOptions): MockMonitor {
  const now = options.now ?? Date.now;
  const runs = new Map<string, Run>();
  // The newest sample time per connection. It outlives a stop, so a restart backfills only after it.
  const newestAt = new Map<string, number>();
  const startedAt = now();
  const operationsState = FIXTURE_OPERATIONS.map((item) => ({ ...item, removed: false }));

  function stopRun(connectionId: string): void {
    const run = runs.get(connectionId);
    if (run === undefined) {
      return;
    }
    if (run.timer !== undefined) {
      clearInterval(run.timer);
    }
    runs.delete(connectionId);
  }

  function scheduleTicks(connectionId: string, run: Run): void {
    if (run.timer !== undefined) {
      clearInterval(run.timer);
    }
    run.timer = setInterval(() => {
      run.tick += 1;
      const sample = sampleAt(run, run.tick, now(), run.config.intervalMs);
      newestAt.set(connectionId, Date.parse(sample.at));
      run.history.push(sample);
      if (run.history.length > MAX_HISTORY) {
        run.history.shift();
      }
      options.emit({ type: 'monitor:sample', connectionId, sample });
    }, run.config.intervalMs);
  }

  return {
    start(connectionId, intervalMs) {
      const existing = runs.get(connectionId);
      if (existing !== undefined) {
        return existing.config;
      }
      const config: MonitorConfig = {
        intervalMs: intervalMs ?? DEFAULT_MONITOR_INTERVAL_MS,
        retentionMs: DEFAULT_MONITOR_RETENTION_MS,
      };
      const run: Run = {
        config,
        replication: options.hasReplication(connectionId),
        random: mulberry32(seedFor(connectionId)),
        uptimeBase: UPTIME_BASE_SECONDS + (now() - startedAt) / MS_PER_SECOND,
        history: [],
        timer: undefined,
        tick: 0,
      };
      // The backfill covers the ticks before now. The last one sits one interval before now.
      // A restart after a gap starts the backfill after the newest sample already emitted, so
      // the history never runs backwards in time when the view merges the two runs.
      const backfillStart = now() - BACKFILL_SAMPLES * config.intervalMs;
      const floor = newestAt.get(connectionId) ?? Number.NEGATIVE_INFINITY;
      for (let index = 0; index < BACKFILL_SAMPLES; index += 1) {
        const at = backfillStart + index * config.intervalMs;
        if (at <= floor) {
          continue;
        }
        const tick = index - BACKFILL_SAMPLES;
        run.history.push(sampleAt(run, tick, at, config.intervalMs));
      }
      const last = run.history.at(-1);
      if (last !== undefined) {
        newestAt.set(connectionId, Math.max(floor, Date.parse(last.at)));
      }
      runs.set(connectionId, run);
      scheduleTicks(connectionId, run);
      return config;
    },

    stop(connectionId) {
      stopRun(connectionId);
    },

    samples(connectionId, sinceIso) {
      const run = runs.get(connectionId);
      if (run === undefined) {
        return [];
      }
      if (sinceIso === undefined) {
        return mergeSamples([], run.history, run.config.retentionMs);
      }
      const threshold = Date.parse(sinceIso);
      return run.history.filter((sample) => Date.parse(sample.at) > threshold);
    },

    setInterval(connectionId, intervalMs) {
      const run = runs.get(connectionId);
      if (run === undefined) {
        throw new AppErrorException(
          appError('VALIDATION', 'Monitoring is not running for this connection.'),
        );
      }
      run.config = { ...run.config, intervalMs };
      scheduleTicks(connectionId, run);
      return run.config;
    },

    operations(_connectionId, filter) {
      const elapsedSeconds = (now() - startedAt) / MS_PER_SECOND;
      return operationsState.flatMap((item) => {
        if (item.removed) {
          return [];
        }
        if (item.idle && !filter.includeIdle) {
          return [];
        }
        if (item.system && !filter.includeSystem) {
          return [];
        }
        if (!item.operation.active) {
          return [item.operation];
        }
        const secsRunning = Math.round(item.baseSeconds + elapsedSeconds);
        return [{ ...item.operation, secsRunning }];
      });
    },

    killOperation(_connectionId, opid) {
      const target = operationsState.find((item) => !item.removed && item.operation.opid === opid);
      if (target === undefined) {
        throw new AppErrorException(
          appError('COMMAND_FAILED', 'Operation not found', String(opid)),
        );
      }
      target.removed = true;
    },

    stopConnection(connectionId) {
      stopRun(connectionId);
    },

    stopAll() {
      for (const connectionId of [...runs.keys()]) {
        stopRun(connectionId);
      }
    },
  };
}
