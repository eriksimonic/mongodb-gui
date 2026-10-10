import { describe, expect, it } from 'vitest';
import type { MongoClient } from 'mongodb';
import { AppErrorException } from '@mongo-gui/core';
import { describeShardCollection } from './operations';

// A fake client with one collection. The dry run reads only the count and the indexes.
function fakeClient(documents: number, indexes: { key: Record<string, unknown> }[]): MongoClient {
  const collection = {
    estimatedDocumentCount: async () => documents,
    indexes: async () => indexes,
  };
  return { db: () => ({ collection: () => collection }) } as unknown as MongoClient;
}

const ORDERS = { database: 'shop', collection: 'orders', keyEjson: '{"region": 1, "orderId": 1}' };

describe('describeShardCollection', () => {
  it('warns when a non-empty collection has no index that starts with the key', async () => {
    const summary = await describeShardCollection(fakeClient(10, [{ key: { _id: 1 } }]), ORDERS);
    expect(summary.warnings).toHaveLength(1);
    expect(summary.warnings[0]).toContain('needs an index that starts with the shard key');
    expect(summary.warnings[0]).toContain('createIndex({ region: 1, orderId: 1 })');
  });

  it('does not warn for an empty collection', async () => {
    const summary = await describeShardCollection(fakeClient(0, []), ORDERS);
    expect(summary.warnings).toEqual([]);
  });

  it('accepts an index that starts with the key fields in order', async () => {
    const indexes = [{ key: { _id: 1 } }, { key: { region: 1, orderId: 1, total: -1 } }];
    const summary = await describeShardCollection(fakeClient(10, indexes), ORDERS);
    expect(summary.warnings).toEqual([]);
  });

  it('warns when the index fields are in another order', async () => {
    const summary = await describeShardCollection(
      fakeClient(10, [{ key: { orderId: 1, region: 1 } }]),
      ORDERS,
    );
    expect(summary.warnings).toHaveLength(1);
  });

  it('parses the Extended JSON key and returns the dry run summary', async () => {
    const summary = await describeShardCollection(fakeClient(0, []), {
      database: 'shop',
      collection: 'orders',
      keyEjson: '{"customerId": "hashed"}',
      presplitHashedZones: true,
    });
    expect(summary.namespace).toBe('shop.orders');
    expect(summary.key).toEqual({ customerId: 'hashed' });
    expect(summary.presplitHashedZones).toBe(true);
  });

  it('refuses a system database before it reads the key', async () => {
    await expect(
      describeShardCollection(fakeClient(0, []), {
        database: 'admin',
        collection: 'x',
        keyEjson: '{"a": 1}',
      }),
    ).rejects.toThrow(AppErrorException);
  });

  it('refuses an unsupported key value with a validation error', async () => {
    await expect(
      describeShardCollection(fakeClient(0, []), {
        database: 'shop',
        collection: 'orders',
        keyEjson: '{"a": "text"}',
      }),
    ).rejects.toThrow('The shard key value for a must be 1, -1 or "hashed"');
  });

  it('refuses more than one hashed field', async () => {
    await expect(
      describeShardCollection(fakeClient(0, []), {
        database: 'shop',
        collection: 'orders',
        keyEjson: '{"a":"hashed","b":"hashed"}',
      }),
    ).rejects.toThrow('The shard key can contain at most one hashed field.');
  });
});
