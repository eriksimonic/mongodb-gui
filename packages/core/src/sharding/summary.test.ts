import { describe, expect, it } from 'vitest';
import { AppErrorException } from '../domain/errors';
import { shardKeyText, summarizeShardCollection } from './summary';

const base = { database: 'shop', collection: 'orders' };

describe('shardKeyText', () => {
  it('shows ranged and hashed fields the way mongosh does', () => {
    expect(shardKeyText({ region: 1, orderId: -1, customerId: 'hashed' })).toBe(
      '{ region: 1, orderId: -1, customerId: "hashed" }',
    );
  });
});

describe('summarizeShardCollection', () => {
  it('names the namespace and key and states the ranged behaviour', () => {
    const summary = summarizeShardCollection({ ...base, key: { region: 1 } });
    expect(summary.namespace).toBe('shop.orders');
    expect(summary.keyText).toBe('{ region: 1 }');
    expect(summary.unique).toBe(false);
    expect(summary.presplitHashedZones).toBe(false);
    expect(summary.steps[0]).toBe('Shards shop.orders on the key { region: 1 }.');
    expect(summary.steps.join(' ')).toContain('A ranged key keeps nearby values together');
  });

  it('describes a hashed key, presplit zones and initial chunks', () => {
    const summary = summarizeShardCollection({
      ...base,
      key: { customerId: 'hashed' },
      presplitHashedZones: true,
      numInitialChunks: 4,
    });
    expect(summary.presplitHashedZones).toBe(true);
    expect(summary.numInitialChunks).toBe(4);
    expect(summary.steps.join(' ')).toContain('Range queries on the key reach every shard');
    expect(summary.steps.join(' ')).toContain('MongoDB creates 4 initial chunks.');
  });

  it('refuses a unique hashed key', () => {
    expect(() =>
      summarizeShardCollection({ ...base, key: { customerId: 'hashed' }, unique: true }),
    ).toThrow(AppErrorException);
  });

  it('refuses presplit or initial chunks on a ranged key', () => {
    expect(() =>
      summarizeShardCollection({ ...base, key: { region: 1 }, presplitHashedZones: true }),
    ).toThrow('Presplitting zones applies only to a hashed shard key.');
    expect(() =>
      summarizeShardCollection({ ...base, key: { region: 1 }, numInitialChunks: 2 }),
    ).toThrow('The number of initial chunks applies only to a hashed shard key.');
  });
});
