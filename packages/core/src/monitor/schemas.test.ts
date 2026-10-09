import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MONITOR_RETENTION_MS,
  MonitorConfigSchema,
  MonitorSampleSchema,
  RunningOperationSchema,
} from './schemas';

const sample = {
  at: '2026-01-01T12:00:00.000Z',
  uptimeSeconds: 10,
  opcounters: { insert: 0, query: 0, update: 0, delete: 0, getmore: 0, command: 0 },
  connections: { current: 1, available: 100 },
  network: { bytesInPerSec: 0, bytesOutPerSec: 0, requestsPerSec: 0 },
  memory: { residentMb: 64, virtualMb: 1024 },
};

describe('MonitorSampleSchema', () => {
  it('accepts a minimal sample without optional sections', () => {
    expect(MonitorSampleSchema.safeParse(sample).success).toBe(true);
  });

  it('accepts every optional section', () => {
    const full = {
      ...sample,
      connections: { current: 1, available: 100, active: 1 },
      wiredTiger: {
        cacheUsedMb: 1,
        cacheMaxMb: 2,
        cacheDirtyMb: 0,
        readIntoCachePerSec: 0,
        writtenFromCachePerSec: 0,
      },
      globalLock: {
        currentQueueReaders: 0,
        currentQueueWriters: 0,
        activeReaders: 1,
        activeWriters: 0,
      },
      replication: {
        setName: 'rs0',
        members: [{ name: 'a:27017', state: 'PRIMARY', health: 1, lagSeconds: 0, self: true }],
      },
      pageFaultsPerSec: 0,
    };
    expect(MonitorSampleSchema.safeParse(full).success).toBe(true);
  });

  it('rejects a timestamp that is not ISO 8601', () => {
    expect(MonitorSampleSchema.safeParse({ ...sample, at: 'yesterday' }).success).toBe(false);
  });

  it('rejects a negative rate', () => {
    const negative = { ...sample, opcounters: { ...sample.opcounters, insert: -1 } };
    expect(MonitorSampleSchema.safeParse(negative).success).toBe(false);
  });

  it('rejects a replica member without a name', () => {
    const bad = {
      ...sample,
      replication: {
        setName: 'rs0',
        members: [{ name: '', state: 'PRIMARY', health: 1, self: true }],
      },
    };
    expect(MonitorSampleSchema.safeParse(bad).success).toBe(false);
  });
});

describe('MonitorConfigSchema', () => {
  it('defaults retention to one hour', () => {
    const parsed = MonitorConfigSchema.parse({ intervalMs: 1000 });
    expect(parsed.retentionMs).toBe(DEFAULT_MONITOR_RETENTION_MS);
    expect(DEFAULT_MONITOR_RETENTION_MS).toBe(3_600_000);
  });

  it('accepts the interval bounds', () => {
    expect(MonitorConfigSchema.safeParse({ intervalMs: 1000 }).success).toBe(true);
    expect(MonitorConfigSchema.safeParse({ intervalMs: 10_000 }).success).toBe(true);
  });

  it('rejects an interval outside 1 to 10 seconds', () => {
    expect(MonitorConfigSchema.safeParse({ intervalMs: 999 }).success).toBe(false);
    expect(MonitorConfigSchema.safeParse({ intervalMs: 10_001 }).success).toBe(false);
  });

  it('rejects a fractional interval', () => {
    expect(MonitorConfigSchema.safeParse({ intervalMs: 1500.5 }).success).toBe(false);
  });
});

describe('RunningOperationSchema', () => {
  it('accepts a numeric or string opid', () => {
    const base = { active: true, op: 'query', ns: 'shop.orders' };
    expect(RunningOperationSchema.safeParse({ ...base, opid: 42 }).success).toBe(true);
    expect(RunningOperationSchema.safeParse({ ...base, opid: 'shard01:42' }).success).toBe(true);
  });

  it('rejects an operation without an ns', () => {
    expect(RunningOperationSchema.safeParse({ opid: 1, active: true, op: 'query' }).success).toBe(
      false,
    );
  });
});
