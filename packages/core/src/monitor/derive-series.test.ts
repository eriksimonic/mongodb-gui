import { describe, expect, it } from 'vitest';
import { CATALOG_SERIES, findSeries } from './catalog';
import { deriveSample, deriveSeries } from './derive';
import { MonitorSampleSchema } from './schemas';
import type { RawServerSnapshot } from './types';

const T0 = Date.UTC(2026, 0, 1, 12, 0, 0);
const MIB = 1024 * 1024;

/** A deep copy of plain JSON fixtures, so a test can change one copy without touching the other. */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function snapshot(
  at: number,
  serverStatus: unknown,
  extra: Partial<RawServerSnapshot> = {},
): RawServerSnapshot {
  return { at, serverStatus, ...extra };
}

/** A standalone server with the sections a 7.0 or later server reports. Counters grow with `step`. */
function status(step: number, options: { tickets?: 'queues' | 'legacy' | 'none' } = {}): unknown {
  const tickets = options.tickets ?? 'queues';
  const pool = { out: 2 + step, available: 126 - step, totalTickets: 128 };
  return {
    uptime: 100 + step,
    opcounters: {
      insert: 10 * step,
      query: 20 * step,
      update: 5 * step,
      delete: step,
      getmore: 0,
      command: 30 * step,
    },
    connections: { current: 12, available: 800, active: 4 },
    network: {
      bytesIn: 1000 * step,
      bytesOut: 2000 * step,
      numRequests: 50 * step,
      physicalBytesIn: 3000 * step,
    },
    mem: { resident: 512, virtual: 2048 },
    extra_info: { page_faults: 7 * step },
    asserts: { regular: step, warning: 0, msg: 0, user: 2 * step },
    metrics: {
      document: {
        inserted: 100 * step,
        updated: 30 * step,
        deleted: 4 * step,
        returned: 500 * step,
      },
      cursor: { timedOut: step, open: { total: 6, noTimeout: 1, pinned: 2 } },
      ttl: { passes: 60 * step, deletedDocuments: 8 * step },
    },
    transactions: {
      currentActive: 1,
      currentInactive: 2,
      currentOpen: 3,
      totalStarted: 9 * step,
      totalCommitted: 8 * step,
      totalAborted: step,
    },
    logicalSessionRecordCache: { activeSessionsCount: 11 },
    locks: {
      Global: { acquireCount: { r: 40 * step, w: 10 * step, W: 2 * step } },
    },
    globalLock: { currentQueue: { total: 3, readers: 1, writers: 2 } },
    wiredTiger: {
      cache: {
        'bytes currently in the cache': 268_435_456,
        'maximum bytes configured': 536_870_912,
        'tracked dirty bytes in the cache': 1_048_576,
        'bytes read into cache': 10_000 * step,
        'bytes written from cache': 20_000 * step,
        'pages read into cache': 4 * step,
        'pages written from cache': 6 * step,
      },
      'block-manager': { 'bytes read': 500 * step, 'bytes written': 700 * step },
      transaction: {
        'transaction checkpoints': 2 * step,
        'transaction checkpoint most recent time (msecs)': 37,
      },
      concurrentTransactions: tickets === 'legacy' ? { read: pool, write: pool } : undefined,
    },
    ...(tickets === 'queues' ? { queues: { execution: { read: pool, write: pool } } } : {}),
  };
}

describe('deriveSeries', () => {
  it('turns counters into per-second rates and passes gauges through', () => {
    const previous = snapshot(T0, status(1));
    const current = snapshot(T0 + 2000, status(3));
    const values = deriveSeries(previous, current);

    // Two seconds elapsed, and the insert counter grew from 10 to 30.
    expect(values['op-insert']).toBeCloseTo(10);
    expect(values['net-in']).toBeCloseTo(1000);
    expect(values['conn-current']).toBe(12);
    expect(values['mem-resident']).toBe(512 * MIB);
    expect(values['wt-cache-used']).toBe(268_435_456);
    expect(values['wt-cache-fill']).toBeCloseTo(50);
    expect(values['tx-open']).toBe(3);
  });

  it('has no counter series on the first sample but keeps the gauges', () => {
    const values = deriveSeries(undefined, snapshot(T0, status(1)));
    expect(values['op-insert']).toBeUndefined();
    expect(values['net-in']).toBeUndefined();
    expect(values['conn-current']).toBe(12);
    expect(values['tx-open']).toBe(3);
  });

  it('clamps a counter that went down to zero, as after a restart', () => {
    const values = deriveSeries(snapshot(T0, status(5)), snapshot(T0 + 1000, status(2)));
    expect(values['op-insert']).toBe(0);
    expect(values['net-out']).toBe(0);
  });

  it('gives a zero rate for an unchanged counter, not a missing one', () => {
    const values = deriveSeries(snapshot(T0, status(2)), snapshot(T0 + 1000, status(2)));
    expect(values['op-query']).toBe(0);
  });

  it('converts memory from megabytes to bytes', () => {
    const values = deriveSeries(undefined, snapshot(T0, status(1)));
    expect(values['mem-virtual']).toBe(2048 * MIB);
  });

  it('omits series whose sections the server does not report', () => {
    const bare = {
      uptime: 1,
      opcounters: { insert: 1, query: 1, update: 1, delete: 1, getmore: 1, command: 1 },
    };
    const values = deriveSeries(snapshot(T0, bare), snapshot(T0 + 1000, { ...bare }));
    expect(values['op-insert']).toBe(0);
    expect(values['net-in']).toBeUndefined();
    expect(values['mem-resident']).toBeUndefined();
    expect(values['wt-cache-used']).toBeUndefined();
    expect(values['tickets-read-available']).toBeUndefined();
    expect(values['repl-lag']).toBeUndefined();
    expect(values['oplog-window']).toBeUndefined();
    expect(values['deadlocks']).toBeUndefined();
    expect(Object.keys(values).every((key) => !key.includes('undefined'))).toBe(true);
  });

  it('reads tickets from queues.execution on 7.0 and later', () => {
    const values = deriveSeries(undefined, snapshot(T0, status(1, { tickets: 'queues' })));
    expect(values['tickets-read-available']).toBe(125);
    expect(values['tickets-read-out']).toBe(3);
    expect(values['tickets-write-available']).toBe(125);
  });

  it('reads tickets from wiredTiger.concurrentTransactions before 7.0', () => {
    const values = deriveSeries(undefined, snapshot(T0, status(1, { tickets: 'legacy' })));
    expect(values['tickets-read-available']).toBe(125);
    expect(values['tickets-write-out']).toBe(3);
  });

  it('omits tickets when neither location reports them', () => {
    const values = deriveSeries(undefined, snapshot(T0, status(1, { tickets: 'none' })));
    expect(values['tickets-read-available']).toBeUndefined();
    expect(values['tickets-write-out']).toBeUndefined();
  });

  it('reads the checkpoint count from either location and the duration only where reported', () => {
    const older = deriveSeries(snapshot(T0, status(1)), snapshot(T0 + 2000, status(3)));
    expect(older['wt-checkpoints']).toBeCloseTo(2);
    expect(older['wt-checkpoint-ms']).toBe(37);

    const eightZero = clone(status(3)) as { wiredTiger: Record<string, unknown> };
    eightZero.wiredTiger['transaction'] = {};
    eightZero.wiredTiger['checkpoint'] = { 'total succeed number of checkpoints': 9 };
    const values = deriveSeries(undefined, snapshot(T0, eightZero));
    expect(values['wt-checkpoint-ms']).toBeUndefined();
    const withPrevious = deriveSeries(snapshot(T0, eightZero), snapshot(T0 + 1000, eightZero));
    expect(withPrevious['wt-checkpoints']).toBe(0);
  });

  it('computes the cache fill percentage and leaves it out without a maximum', () => {
    const noMax = clone(status(1)) as { wiredTiger: { cache: Record<string, unknown> } };
    noMax.wiredTiger.cache['maximum bytes configured'] = 0;
    expect(deriveSeries(undefined, snapshot(T0, noMax))['wt-cache-fill']).toBeUndefined();
  });

  it('sums deadlocks across lock resources, and leaves the series out until one occurs', () => {
    const none = deriveSeries(snapshot(T0, status(1)), snapshot(T0 + 1000, status(2)));
    expect(none['deadlocks']).toBeUndefined();

    const before = clone(status(1)) as { locks: Record<string, unknown> };
    const after = clone(status(2)) as { locks: Record<string, unknown> };
    before.locks['Collection'] = { acquireCount: { r: 1 } };
    after.locks['Collection'] = { acquireCount: { r: 1 }, deadlockCount: 3 };
    after.locks['Global'] = { acquireCount: { r: 1 }, deadlockCount: 1 };
    const values = deriveSeries(snapshot(T0, before), snapshot(T0 + 1000, after));
    // Before the first deadlock, the total was missing, so there is no rate yet.
    expect(values['deadlocks']).toBeUndefined();
    // The total stays at four, so the rate over the next interval is zero.
    const later = deriveSeries(snapshot(T0 + 1000, after), snapshot(T0 + 3000, clone(after)));
    expect(later['deadlocks']).toBe(0);
  });

  it('produces one replica lag series per member, and an oplog window', () => {
    const replSetStatus = {
      set: 'rs0',
      members: [
        {
          name: 'db-1:27017',
          stateStr: 'PRIMARY',
          health: 1,
          state: 1,
          optimeDate: new Date(T0 + 10_000),
          self: true,
        },
        {
          name: 'db-2:27017',
          stateStr: 'SECONDARY',
          health: 1,
          state: 2,
          optimeDate: new Date(T0 + 7000),
          self: false,
        },
        {
          name: 'db-3:27017',
          stateStr: 'SECONDARY',
          health: 1,
          state: 2,
          optimeDate: new Date(T0 + 4000),
          self: false,
        },
      ],
    };
    const oplogFirst = { ts: { t: 1_700_000_000, i: 1 } };
    const oplogLast = { ts: { t: 1_700_003_600, i: 9 } };
    const current = snapshot(T0 + 2000, status(3), { replSetStatus, oplogFirst, oplogLast });
    const values = deriveSeries(undefined, current);
    expect(values['repl-lag@db-2:27017']).toBeCloseTo(3);
    expect(values['repl-lag@db-3:27017']).toBeCloseTo(6);
    expect(values['repl-lag@db-1:27017']).toBeUndefined();
    expect(values['oplog-window']).toBe(3600);
  });

  it('matches every catalogue series key against the schema on a full sample', () => {
    const previous = snapshot(T0, status(1));
    const current = snapshot(T0 + 2000, status(4));
    const sample = deriveSample(previous, current);
    expect(MonitorSampleSchema.safeParse(sample).success).toBe(true);
    expect(Object.keys(sample.series).length).toBeGreaterThan(20);
    for (const key of Object.keys(sample.series)) {
      const base = key.split('@')[0] ?? key;
      expect(findSeries(base), key).toBeDefined();
    }
  });

  it('uses the whole catalogue by default', () => {
    expect(CATALOG_SERIES.length).toBeGreaterThan(40);
    expect(deriveSeries(undefined, snapshot(T0, status(1)), CATALOG_SERIES)).toEqual(
      deriveSeries(undefined, snapshot(T0, status(1))),
    );
  });
});
