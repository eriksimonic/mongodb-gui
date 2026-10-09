import { describe, expect, it } from 'vitest';
import {
  ProfileEntrySchema,
  ProfileFilterSchema,
  ProfilingLevelSchema,
  QueryShapeSchema,
  SetProfilingLevelInputSchema,
  TailProfileOptionsSchema,
} from './types';

const entry = {
  id: '0123456789abcdef',
  ts: '2026-10-05T08:15:00.000Z',
  ns: 'shop.orders',
  op: 'query',
  millis: 12,
  raw: {},
};

describe('ProfilingLevelSchema', () => {
  it('accepts levels 0, 1 and 2 with a slow threshold', () => {
    for (const level of [0, 1, 2]) {
      expect(ProfilingLevelSchema.safeParse({ level, slowMs: 100 }).success).toBe(true);
    }
  });

  it('rejects a level outside 0..2 and a negative threshold', () => {
    expect(ProfilingLevelSchema.safeParse({ level: 3, slowMs: 100 }).success).toBe(false);
    expect(ProfilingLevelSchema.safeParse({ level: 1, slowMs: -1 }).success).toBe(false);
  });

  it('keeps the optional sample rate within 0..1', () => {
    expect(ProfilingLevelSchema.safeParse({ level: 1, slowMs: 0, sampleRate: 1.5 }).success).toBe(
      false,
    );
  });
});

describe('SetProfilingLevelInputSchema', () => {
  it('makes the slow threshold optional', () => {
    expect(SetProfilingLevelInputSchema.safeParse({ level: 0 }).success).toBe(true);
  });
});

describe('ProfileEntrySchema', () => {
  it('accepts a minimal entry carrying only required fields', () => {
    expect(ProfileEntrySchema.safeParse(entry).success).toBe(true);
  });

  it('accepts a full entry with every optional field', () => {
    const full = {
      ...entry,
      op: 'update',
      command: { q: {}, u: {} },
      planSummary: 'IXSCAN { status: 1 }',
      keysExamined: 1,
      docsExamined: 2,
      nreturned: 3,
      nMatched: 4,
      nModified: 5,
      hasSortStage: false,
      usedDisk: false,
      queryHash: 'ABC123',
      planCacheKey: 'DEF456',
      client: '127.0.0.1',
      appName: 'mongosh',
      user: 'root@admin',
      locks: {},
      storage: {},
      responseLength: 100,
      errMsg: 'boom',
    };
    expect(ProfileEntrySchema.safeParse(full).success).toBe(true);
  });

  it('rejects an unknown op and a timestamp that is not ISO', () => {
    expect(ProfileEntrySchema.safeParse({ ...entry, op: 'aggregate' }).success).toBe(false);
    expect(ProfileEntrySchema.safeParse({ ...entry, ts: 'yesterday' }).success).toBe(false);
  });
});

describe('ProfileFilterSchema', () => {
  it('accepts an empty filter', () => {
    expect(ProfileFilterSchema.safeParse({}).success).toBe(true);
  });

  it('caps the limit at 5000', () => {
    expect(ProfileFilterSchema.safeParse({ limit: 5000 }).success).toBe(true);
    expect(ProfileFilterSchema.safeParse({ limit: 5001 }).success).toBe(false);
    expect(ProfileFilterSchema.safeParse({ limit: 0 }).success).toBe(false);
  });

  it('rejects an empty text search', () => {
    expect(ProfileFilterSchema.safeParse({ textSearch: '' }).success).toBe(false);
  });
});

describe('TailProfileOptionsSchema', () => {
  it('requires an ISO start time and a poll interval of at least 50 ms', () => {
    const valid = { since: '2026-10-05T08:15:00.000Z', pollMs: 100 };
    expect(TailProfileOptionsSchema.safeParse(valid).success).toBe(true);
    expect(TailProfileOptionsSchema.safeParse({ ...valid, pollMs: 10 }).success).toBe(false);
    expect(TailProfileOptionsSchema.safeParse({ ...valid, since: 'now' }).success).toBe(false);
  });
});

describe('QueryShapeSchema', () => {
  it('accepts a shape with its example entry', () => {
    const shape = {
      key: 'abc',
      ns: 'shop.orders',
      op: 'query',
      count: 2,
      totalMillis: 30,
      avgMillis: 15,
      maxMillis: 20,
      p95Millis: 20,
      example: entry,
      planSummaries: ['COLLSCAN'],
    };
    expect(QueryShapeSchema.safeParse(shape).success).toBe(true);
    expect(QueryShapeSchema.safeParse({ ...shape, count: 0 }).success).toBe(false);
  });
});
