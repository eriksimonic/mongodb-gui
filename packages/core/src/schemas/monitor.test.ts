import { describe, expect, it } from 'vitest';
import {
  MonitorKillInputSchema,
  MonitorOperationsInputSchema,
  MonitorSamplesInputSchema,
  MonitorSetIntervalInputSchema,
  MonitorStartInputSchema,
} from './monitor';

const CONNECTION_ID = '3f2b8c1e-5d4a-4b7e-9c1f-2a6d8e0b7f10';

describe('monitor input schemas', () => {
  it('accepts a start with and without an interval inside the allowed range', () => {
    expect(MonitorStartInputSchema.safeParse({ connectionId: CONNECTION_ID }).success).toBe(true);
    expect(
      MonitorStartInputSchema.safeParse({ connectionId: CONNECTION_ID, intervalMs: 5000 }).success,
    ).toBe(true);
  });

  it('rejects intervals outside one to ten seconds', () => {
    for (const intervalMs of [999, 10_001, 2.5]) {
      expect(
        MonitorStartInputSchema.safeParse({ connectionId: CONNECTION_ID, intervalMs }).success,
        String(intervalMs),
      ).toBe(false);
      expect(
        MonitorSetIntervalInputSchema.safeParse({ connectionId: CONNECTION_ID, intervalMs })
          .success,
        String(intervalMs),
      ).toBe(false);
    }
  });

  it('requires a uuid connection id', () => {
    expect(MonitorSamplesInputSchema.safeParse({ connectionId: 'local' }).success).toBe(false);
  });

  it('accepts an ISO time for sinceIso and rejects other text', () => {
    expect(
      MonitorSamplesInputSchema.safeParse({
        connectionId: CONNECTION_ID,
        sinceIso: '2026-10-09T10:00:00.000Z',
      }).success,
    ).toBe(true);
    expect(
      MonitorSamplesInputSchema.safeParse({ connectionId: CONNECTION_ID, sinceIso: 'yesterday' })
        .success,
    ).toBe(false);
  });

  it('accepts optional operation filters', () => {
    expect(
      MonitorOperationsInputSchema.safeParse({
        connectionId: CONNECTION_ID,
        includeIdle: true,
        includeSystem: false,
      }).success,
    ).toBe(true);
  });

  it('accepts numeric and real string opids for kill', () => {
    expect(
      MonitorKillInputSchema.safeParse({ connectionId: CONNECTION_ID, opid: 1234 }).success,
    ).toBe(true);
    expect(
      MonitorKillInputSchema.safeParse({ connectionId: CONNECTION_ID, opid: 'shard01:99' }).success,
    ).toBe(true);
  });

  it('rejects synthetic idle opids and negative numbers for kill', () => {
    expect(
      MonitorKillInputSchema.safeParse({ connectionId: CONNECTION_ID, opid: 'conn:7' }).success,
    ).toBe(false);
    expect(
      MonitorKillInputSchema.safeParse({ connectionId: CONNECTION_ID, opid: -1 }).success,
    ).toBe(false);
  });
});
