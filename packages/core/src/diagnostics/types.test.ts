import { describe, expect, it } from 'vitest';
import {
  BuildInfoSchema,
  ConnPoolStatsSchema,
  HostInfoSchema,
  LogLineSchema,
  ServerLogSchema,
  ServerStatusTreeSchema,
  SessionListSchema,
  TopEntrySchema,
} from './types';

const opStat = { time: 0, count: 0 };

describe('LogLineSchema', () => {
  it('accepts a structured JSON line', () => {
    const line = {
      ts: '2026-01-01T00:00:00.000+00:00',
      severity: 'I',
      component: 'NETWORK',
      id: 22943,
      context: 'listener',
      message: 'Connection accepted',
      attributes: { remote: '127.0.0.1:50000' },
      raw: '{"t":{"$date":"2026-01-01T00:00:00.000Z"}}',
    };
    expect(LogLineSchema.safeParse(line).success).toBe(true);
  });

  it('accepts a fallback line with only a message and raw text', () => {
    expect(LogLineSchema.safeParse({ message: 'plain text', raw: 'plain text' }).success).toBe(
      true,
    );
  });

  it('rejects a line without a message', () => {
    expect(LogLineSchema.safeParse({ raw: 'x' }).success).toBe(false);
  });
});

describe('ServerLogSchema', () => {
  it('accepts only the global and startupWarnings kinds', () => {
    expect(ServerLogSchema.safeParse({ kind: 'global', total: 0, lines: [] }).success).toBe(true);
    expect(ServerLogSchema.safeParse({ kind: 'other', total: 0, lines: [] }).success).toBe(false);
  });
});

describe('HostInfoSchema and BuildInfoSchema', () => {
  it('accepts a host with only the raw EJSON payload', () => {
    expect(HostInfoSchema.safeParse({ rawJson: '{}' }).success).toBe(true);
  });

  it('requires a version and module lists for build info', () => {
    expect(BuildInfoSchema.safeParse({ version: '8.0.17', rawJson: '{}' }).success).toBe(false);
    expect(
      BuildInfoSchema.safeParse({
        version: '8.0.17',
        modules: [],
        storageEngines: ['wiredTiger'],
        rawJson: '{}',
      }).success,
    ).toBe(true);
  });
});

describe('TopEntrySchema', () => {
  it('requires every operation counter', () => {
    const complete = {
      ns: 'shop.orders',
      total: opStat,
      readLock: opStat,
      writeLock: opStat,
      queries: opStat,
      getmore: opStat,
      insert: opStat,
      update: opStat,
      remove: opStat,
      commands: opStat,
    };
    expect(TopEntrySchema.safeParse(complete).success).toBe(true);
    expect(TopEntrySchema.safeParse({ ...complete, remove: undefined }).success).toBe(false);
  });
});

describe('ConnPoolStatsSchema', () => {
  it('accepts per-host counters', () => {
    const stats = {
      totalInUse: 1,
      totalAvailable: 2,
      totalCreated: 3,
      hosts: { 'localhost:27017': { inUse: 1, available: 2, created: 3 } },
      rawJson: '{}',
    };
    expect(ConnPoolStatsSchema.safeParse(stats).success).toBe(true);
  });
});

describe('SessionListSchema', () => {
  it('limits the scope to local or all', () => {
    expect(SessionListSchema.safeParse({ scope: 'local', sessions: [] }).success).toBe(true);
    expect(SessionListSchema.safeParse({ scope: 'global', sessions: [] }).success).toBe(false);
  });

  it('accepts a fallback reason only from the known set', () => {
    const fallback = { scope: 'local', sessions: [], fallbackReason: 'unauthorized' };
    expect(SessionListSchema.safeParse(fallback).success).toBe(true);
    expect(SessionListSchema.safeParse({ ...fallback, fallbackReason: 'timeout' }).success).toBe(
      false,
    );
  });
});

describe('ServerStatusTreeSchema', () => {
  it('keeps the list of stripped sections', () => {
    const tree = {
      at: '2026-01-01T00:00:00.000Z',
      rawJson: '{"host":"h"}',
      stripped: ['tcmalloc'],
    };
    expect(ServerStatusTreeSchema.safeParse(tree).success).toBe(true);
    expect(ServerStatusTreeSchema.safeParse({ at: 'x', rawJson: '{}' }).success).toBe(false);
  });
});
