import { describe, expect, it } from 'vitest';
import { AppErrorException } from '@mongo-gui/core';
import { describeShardCollection } from './operations';

describe('describeShardCollection', () => {
  it('parses the Extended JSON key and returns the dry run summary', () => {
    const summary = describeShardCollection({
      database: 'shop',
      collection: 'orders',
      keyEjson: '{"customerId": "hashed"}',
      presplitHashedZones: true,
    });
    expect(summary.namespace).toBe('shop.orders');
    expect(summary.key).toEqual({ customerId: 'hashed' });
    expect(summary.presplitHashedZones).toBe(true);
  });

  it('refuses a system database before it reads the key', () => {
    expect(() =>
      describeShardCollection({ database: 'admin', collection: 'x', keyEjson: '{"a": 1}' }),
    ).toThrow(AppErrorException);
  });

  it('refuses an unsupported key value with a validation error', () => {
    expect(() =>
      describeShardCollection({
        database: 'shop',
        collection: 'orders',
        keyEjson: '{"a": "text"}',
      }),
    ).toThrow('The shard key value for a must be 1, -1 or "hashed"');
  });
});
