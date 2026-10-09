import { describe, expect, it } from 'vitest';
import {
  BalancerWindowInputSchema,
  EnableShardingInputSchema,
  MoveChunkInputSchema,
  RemoveShardInputSchema,
  ShardCollectionInputSchema,
  ShardNamespaceSchema,
  ShardingOverviewSchema,
  UpdateZoneKeyRangeInputSchema,
} from './types';

describe('ShardNamespaceSchema', () => {
  it.each(['shop.orders', 'shop.orders.archive', 'shop.with space'])('accepts %s', (ns) => {
    expect(ShardNamespaceSchema.safeParse(ns).success).toBe(true);
  });

  it.each(['orders', '.orders', 'shop.', 'shop.a$b', 'shop.system.views', 'sh op.x'])(
    'rejects %s',
    (ns) => {
      expect(ShardNamespaceSchema.safeParse(ns).success).toBe(false);
    },
  );
});

describe('ShardNamespaceSchema messages', () => {
  it('names system collections in its own message', () => {
    const result = ShardNamespaceSchema.safeParse('shop.system.views');
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe('System collections cannot be sharded or moved');
  });
});

describe('ShardingOverviewSchema', () => {
  it('accepts a non-sharded overview with empty lists', () => {
    const result = ShardingOverviewSchema.safeParse({
      isSharded: false,
      shards: [],
      databases: [],
      collections: [],
      zones: [],
    });
    expect(result.success).toBe(true);
  });

  it('rejects a balancer mode other than full or off', () => {
    const result = ShardingOverviewSchema.safeParse({
      isSharded: true,
      shards: [],
      databases: [],
      collections: [],
      zones: [],
      balancer: { mode: 'on', inBalancerRound: false },
    });
    expect(result.success).toBe(false);
  });
});

describe('BalancerWindowInputSchema', () => {
  it.each([
    ['00:00', '23:59'],
    ['01:30', '05:00'],
  ])('accepts %s to %s', (start, stop) => {
    expect(BalancerWindowInputSchema.safeParse({ start, stop }).success).toBe(true);
  });

  it.each(['24:00', '1:30', '12:60', '12-30', '', '12:3'])('rejects %s', (time) => {
    expect(BalancerWindowInputSchema.safeParse({ start: time, stop: '05:00' }).success).toBe(false);
    expect(BalancerWindowInputSchema.safeParse({ start: '01:00', stop: time }).success).toBe(false);
  });
});

describe('input schemas', () => {
  it('enables sharding on a plain database name with an optional primary shard', () => {
    expect(EnableShardingInputSchema.safeParse({ database: 'shop' }).success).toBe(true);
    expect(
      EnableShardingInputSchema.safeParse({ database: 'shop', primaryShard: 'sh1' }).success,
    ).toBe(true);
    expect(EnableShardingInputSchema.safeParse({ database: 'a.b' }).success).toBe(false);
  });

  it('shards a collection with a key and optional presplit settings', () => {
    const result = ShardCollectionInputSchema.safeParse({
      database: 'shop',
      collection: 'orders',
      keyEjson: '{"customerId":"hashed"}',
      numInitialChunks: 4,
    });
    expect(result.success).toBe(true);
    expect(
      ShardCollectionInputSchema.safeParse({
        database: 'shop',
        collection: 'orders',
        keyEjson: '{}',
        numInitialChunks: 0,
      }).success,
    ).toBe(false);
  });

  it('requires a valid namespace for a chunk move', () => {
    expect(
      MoveChunkInputSchema.safeParse({ ns: 'shop.orders', findEjson: '{}', toShard: 'sh0' })
        .success,
    ).toBe(true);
    expect(
      MoveChunkInputSchema.safeParse({ ns: 'orders', findEjson: '{}', toShard: 'sh0' }).success,
    ).toBe(false);
  });

  it('accepts a null zone to remove a key range', () => {
    const result = UpdateZoneKeyRangeInputSchema.safeParse({
      ns: 'shop.orders',
      minEjson: '{"customerId":0}',
      maxEjson: '{"customerId":10}',
      zone: null,
    });
    expect(result.success).toBe(true);
  });

  it('leaves confirmDraining unset, so removeShard is a dry run by default', () => {
    const result = RemoveShardInputSchema.safeParse({ shard: 'sh1' });
    expect(result.success).toBe(true);
    expect(result.success && result.data.confirmDraining).toBeUndefined();
  });
});
