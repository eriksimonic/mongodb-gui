import { describe, expect, it } from 'vitest';
import { deriveSample } from './derive';
import { MonitorSampleSchema } from './schemas';
import type { RawServerSnapshot } from './types';

const T0 = Date.UTC(2026, 0, 1, 12, 0, 0);

interface Counters {
  insert: number;
  query: number;
  update: number;
  delete: number;
  getmore: number;
  command: number;
  bytesIn: number;
  bytesOut: number;
  numRequests: number;
}

function standaloneStatus(counters: Counters, uptime: number, withWiredTiger = true): unknown {
  return {
    host: 'fixture-standalone',
    version: '8.0.17',
    uptime,
    opcounters: {
      insert: counters.insert,
      query: counters.query,
      update: counters.update,
      delete: counters.delete,
      getmore: counters.getmore,
      command: counters.command,
    },
    connections: { current: 7, available: 51193, active: 3, totalCreated: 40 },
    network: {
      bytesIn: counters.bytesIn,
      bytesOut: counters.bytesOut,
      numRequests: counters.numRequests,
    },
    mem: { bits: 64, resident: 512, virtual: 2048, supported: true },
    globalLock: {
      totalTime: 1000,
      currentQueue: { total: 2, readers: 1, writers: 1 },
      activeClients: { total: 5, readers: 3, writers: 2 },
    },
    extra_info: { page_faults: 100 },
    ...(withWiredTiger ? { wiredTiger: wiredTigerCache() } : {}),
  };
}

function wiredTigerCache(): unknown {
  return {
    cache: {
      'bytes currently in the cache': 268_435_456,
      'maximum bytes configured': 536_870_912,
      'tracked dirty bytes in the cache': 1_048_576,
      'bytes read into cache': 10_000,
      'bytes written from cache': 20_000,
    },
  };
}

const ZERO: Counters = {
  insert: 0,
  query: 0,
  update: 0,
  delete: 0,
  getmore: 0,
  command: 0,
  bytesIn: 0,
  bytesOut: 0,
  numRequests: 0,
};

const FIRST: RawServerSnapshot = {
  at: T0,
  serverStatus: standaloneStatus({ ...ZERO, insert: 1000, query: 500, bytesIn: 4000 }, 3600),
};

describe('deriveSample', () => {
  it('reports zero rates on the first sample and keeps the absolute gauges', () => {
    const sample = deriveSample(undefined, FIRST);

    expect(sample.at).toBe('2026-01-01T12:00:00.000Z');
    expect(sample.uptimeSeconds).toBe(3600);
    expect(sample.opcounters).toEqual({
      insert: 0,
      query: 0,
      update: 0,
      delete: 0,
      getmore: 0,
      command: 0,
    });
    expect(sample.network).toEqual({ bytesInPerSec: 0, bytesOutPerSec: 0, requestsPerSec: 0 });
    expect(sample.pageFaultsPerSec).toBe(0);
    expect(sample.connections).toEqual({ current: 7, available: 51193, active: 3 });
    expect(sample.memory).toEqual({ residentMb: 512, virtualMb: 2048 });
    expect(sample.globalLock).toEqual({
      currentQueueReaders: 1,
      currentQueueWriters: 1,
      activeReaders: 3,
      activeWriters: 2,
    });
    expect(sample.wiredTiger).toEqual({
      cacheUsedMb: 256,
      cacheMaxMb: 512,
      cacheDirtyMb: 1,
      readIntoCachePerSec: 0,
      writtenFromCachePerSec: 0,
    });
    expect(sample.replication).toBeUndefined();
    expect(MonitorSampleSchema.safeParse(sample).success).toBe(true);
  });

  it('divides counter deltas by the elapsed seconds', () => {
    const current: RawServerSnapshot = {
      at: T0 + 2000,
      serverStatus: standaloneStatus(
        {
          insert: 1200,
          query: 900,
          update: 60,
          delete: 4,
          getmore: 10,
          command: 300,
          bytesIn: 24_000,
          bytesOut: 8000,
          numRequests: 120,
        },
        3602,
      ),
    };

    const sample = deriveSample(FIRST, current);

    expect(sample.opcounters).toEqual({
      insert: 100,
      query: 200,
      update: 30,
      delete: 2,
      getmore: 5,
      command: 150,
    });
    expect(sample.network).toEqual({
      bytesInPerSec: 10_000,
      bytesOutPerSec: 4000,
      requestsPerSec: 60,
    });
    expect(sample.uptimeSeconds).toBe(3602);
    expect(sample.wiredTiger?.readIntoCachePerSec).toBe(0);
    expect(MonitorSampleSchema.safeParse(sample).success).toBe(true);
  });

  it('reports zero rates for a counter that went backwards after a restart', () => {
    const restarted: RawServerSnapshot = {
      at: T0 + 5000,
      serverStatus: standaloneStatus({ ...ZERO, insert: 10, query: 700, bytesIn: 9000 }, 4),
    };

    const sample = deriveSample(FIRST, restarted);

    expect(sample.opcounters.insert).toBe(0);
    expect(sample.opcounters.query).toBe(40);
    expect(sample.network.bytesInPerSec).toBe(1000);
    expect(sample.uptimeSeconds).toBe(4);
  });

  it('reports zero rates when the snapshot time does not advance', () => {
    const sample = deriveSample(FIRST, {
      at: T0,
      serverStatus: standaloneStatus({ ...ZERO, insert: 2000 }, 3600),
    });

    expect(sample.opcounters.insert).toBe(0);
    expect(sample.replication).toBeUndefined();
  });

  it('describes a standalone server without replication', () => {
    const sample = deriveSample(undefined, {
      at: T0,
      serverStatus: { uptime: 10, opcounters: {}, connections: { current: 1, available: 2 } },
      replSetStatus: undefined,
    });

    expect(sample.replication).toBeUndefined();
    expect(sample.connections).toEqual({ current: 1, available: 2 });
    expect(sample.memory).toEqual({ residentMb: 0, virtualMb: 0 });
    expect(MonitorSampleSchema.safeParse(sample).success).toBe(true);
  });

  it('computes replica lag per member against the primary optime', () => {
    const primaryOptime = new Date(T0);
    const replSetStatus = {
      set: 'rs0',
      myState: 2,
      members: [
        {
          _id: 0,
          name: 'mongo-a:27017',
          health: 1,
          state: 1,
          stateStr: 'PRIMARY',
          optimeDate: primaryOptime,
        },
        {
          _id: 1,
          name: 'mongo-b:27017',
          health: 1,
          state: 2,
          stateStr: 'SECONDARY',
          optimeDate: new Date(T0 - 5000),
          self: true,
        },
        {
          _id: 2,
          name: 'mongo-c:27017',
          health: 0,
          state: 8,
          stateStr: '(not reachable/healthy)',
        },
      ],
    };

    const sample = deriveSample(undefined, {
      at: T0,
      serverStatus: standaloneStatus(ZERO, 100),
      replSetStatus,
    });

    expect(sample.replication).toEqual({
      setName: 'rs0',
      members: [
        { name: 'mongo-a:27017', state: 'PRIMARY', health: 1, self: false },
        {
          name: 'mongo-b:27017',
          state: 'SECONDARY',
          health: 1,
          lagSeconds: 5,
          self: true,
        },
        { name: 'mongo-c:27017', state: '(not reachable/healthy)', health: 0, self: false },
      ],
    });
    expect(MonitorSampleSchema.safeParse(sample).success).toBe(true);
  });

  it('leaves lag undefined for the primary, for an unreachable member and for a member with a zero optime', () => {
    const sample = deriveSample(undefined, {
      at: T0,
      serverStatus: standaloneStatus(ZERO, 100),
      replSetStatus: {
        set: 'rs0',
        members: [
          {
            name: 'mongo-a:27017',
            health: 1,
            state: 1,
            stateStr: 'PRIMARY',
            optimeDate: new Date(T0),
            self: true,
          },
          {
            name: 'mongo-b:27017',
            health: 0,
            state: 8,
            stateStr: '(not reachable/healthy)',
            optimeDate: new Date(0),
            self: false,
          },
          {
            name: 'mongo-c:27017',
            health: 1,
            state: 2,
            stateStr: 'SECONDARY',
            optimeDate: new Date(0),
            self: false,
          },
        ],
      },
    });

    const members = sample.replication?.members ?? [];
    expect(members.map((member) => member.lagSeconds)).toEqual([undefined, undefined, undefined]);
    expect(members[0]).not.toHaveProperty('lagSeconds');
    expect(members[1]).not.toHaveProperty('lagSeconds');
    expect(MonitorSampleSchema.safeParse(sample).success).toBe(true);
  });

  it('computes the oplog window from the first and last oplog entries', () => {
    const sample = deriveSample(undefined, {
      at: T0,
      serverStatus: standaloneStatus(ZERO, 100),
      replSetStatus: { set: 'rs0', members: [] },
      oplogFirst: { ts: { t: 2_200_000_000, i: 1 } },
      oplogLast: { ts: { t: 2_200_003_600, i: 7 } },
    });

    expect(sample.replication?.oplogWindowSeconds).toBe(3600);
    expect(MonitorSampleSchema.safeParse(sample).success).toBe(true);
  });

  it('reads the high bits as unsigned seconds past 2038', () => {
    const sample = deriveSample(undefined, {
      at: T0,
      serverStatus: standaloneStatus(ZERO, 100),
      replSetStatus: { set: 'rs0', members: [] },
      oplogFirst: { ts: { high: 2_200_000_000, low: 1 } },
      oplogLast: { ts: { high: 2_200_000_060, low: 2 } },
    });

    expect(sample.replication?.oplogWindowSeconds).toBe(60);
  });

  it('leaves the oplog window undefined when an oplog entry is missing', () => {
    const sample = deriveSample(undefined, {
      at: T0,
      serverStatus: standaloneStatus(ZERO, 100),
      replSetStatus: { set: 'rs0', members: [] },
      oplogFirst: { ts: { high: 1_767_225_600, low: 1 } },
    });

    expect(sample.replication).not.toHaveProperty('oplogWindowSeconds');
  });

  it('leaves lag undefined when the set has no primary', () => {
    const sample = deriveSample(undefined, {
      at: T0,
      serverStatus: standaloneStatus(ZERO, 100),
      replSetStatus: {
        set: 'rs1',
        members: [
          {
            name: 'mongo-a:27017',
            health: 1,
            state: 2,
            stateStr: 'SECONDARY',
            optimeDate: new Date(T0),
            self: true,
          },
        ],
      },
    });

    expect(sample.replication?.members).toEqual([
      { name: 'mongo-a:27017', state: 'SECONDARY', health: 1, self: true },
    ]);
  });

  it('omits the wiredTiger section for an in-memory engine', () => {
    const sample = deriveSample(undefined, {
      at: T0,
      serverStatus: standaloneStatus(ZERO, 100, false),
    });

    expect(sample).not.toHaveProperty('wiredTiger');
    expect(MonitorSampleSchema.safeParse(sample).success).toBe(true);
  });

  it('tolerates a server reply that is not an object', () => {
    const sample = deriveSample(undefined, { at: T0, serverStatus: undefined });

    expect(sample.opcounters.insert).toBe(0);
    expect(sample.uptimeSeconds).toBe(0);
    expect(sample).not.toHaveProperty('globalLock');
    expect(sample).not.toHaveProperty('pageFaultsPerSec');
  });
});
