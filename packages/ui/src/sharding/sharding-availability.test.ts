import { describe, expect, it } from 'vitest';
import { shardingAvailability } from './sharding-availability';

describe('shardingAvailability', () => {
  it('is available on a connected sharded topology', () => {
    expect(
      shardingAvailability({
        state: 'connected',
        serverVersion: '8.0.4',
        topology: 'sharded',
        hosts: ['localhost:27017'],
      }),
    ).toEqual({ available: true });
  });

  it('says why it is off on a standalone or when not connected', () => {
    expect(
      shardingAvailability({
        state: 'connected',
        serverVersion: '8.0.4',
        topology: 'standalone',
        hosts: ['localhost:27017'],
      }),
    ).toEqual({ available: false, reason: 'Not a sharded cluster' });
    expect(shardingAvailability({ state: 'disconnected' })).toEqual({
      available: false,
      reason: 'Connect first',
    });
    expect(shardingAvailability(undefined)).toEqual({ available: false, reason: 'Connect first' });
  });
});
