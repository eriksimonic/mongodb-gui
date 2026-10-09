import { describe, expect, it } from 'vitest';
import { RpcEventSchema } from './events';

describe('RpcEventSchema', () => {
  it('accepts a connection status event', () => {
    const event = {
      type: 'connection:status',
      connectionId: '3f2b8c1e-5d4a-4b7e-9c1f-2a6d8e0b7f10',
      status: { state: 'disconnected' },
    };
    expect(RpcEventSchema.safeParse(event).success).toBe(true);
  });

  it('accepts a vault locked event', () => {
    expect(RpcEventSchema.safeParse({ type: 'vault:locked' }).success).toBe(true);
  });

  it('accepts profiler entries and profiler errors', () => {
    const connectionId = '3f2b8c1e-5d4a-4b7e-9c1f-2a6d8e0b7f10';
    const entry = {
      id: '2026-10-09T10:00:00.000Z|opid:1',
      ts: '2026-10-09T10:00:00.000Z',
      ns: 'shop.orders',
      op: 'query',
      millis: 120,
      raw: { op: 'query' },
    };
    expect(
      RpcEventSchema.safeParse({
        type: 'profiler:entries',
        connectionId,
        database: 'shop',
        entries: [entry],
      }).success,
    ).toBe(true);
    expect(
      RpcEventSchema.safeParse({
        type: 'profiler:error',
        connectionId,
        database: 'shop',
        error: { code: 'COMMAND_FAILED', message: 'The server refused the profiler command' },
      }).success,
    ).toBe(true);
    expect(
      RpcEventSchema.safeParse({
        type: 'profiler:entries',
        connectionId,
        database: 'shop',
        entries: [{}],
      }).success,
    ).toBe(false);
  });

  it('accepts a monitor sample event and rejects a sample with a bad time', () => {
    const connectionId = '3f2b8c1e-5d4a-4b7e-9c1f-2a6d8e0b7f10';
    const sample = {
      at: '2026-10-09T10:00:00.000Z',
      uptimeSeconds: 120,
      opcounters: { insert: 1, query: 2, update: 0, delete: 0, getmore: 0, command: 5 },
      connections: { current: 4, available: 900 },
      network: { bytesInPerSec: 10, bytesOutPerSec: 20, requestsPerSec: 3 },
      memory: { residentMb: 80, virtualMb: 1200 },
    };
    expect(RpcEventSchema.safeParse({ type: 'monitor:sample', connectionId, sample }).success).toBe(
      true,
    );
    expect(
      RpcEventSchema.safeParse({
        type: 'monitor:sample',
        connectionId,
        sample: { ...sample, at: 'now' },
      }).success,
    ).toBe(false);
  });

  it('accepts a monitor error event carrying an AppError', () => {
    const event = {
      type: 'monitor:error',
      connectionId: '3f2b8c1e-5d4a-4b7e-9c1f-2a6d8e0b7f10',
      error: { code: 'COMMAND_FAILED', message: 'Command failed' },
    };
    expect(RpcEventSchema.safeParse(event).success).toBe(true);
  });

  it('rejects an unknown event type', () => {
    expect(RpcEventSchema.safeParse({ type: 'vault:opened' }).success).toBe(false);
  });
});
