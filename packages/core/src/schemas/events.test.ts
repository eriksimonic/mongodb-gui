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

  it('rejects an unknown event type', () => {
    expect(RpcEventSchema.safeParse({ type: 'vault:opened' }).success).toBe(false);
  });
});
