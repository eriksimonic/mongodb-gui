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

  it('rejects an unknown event type', () => {
    expect(RpcEventSchema.safeParse({ type: 'vault:opened' }).success).toBe(false);
  });
});
