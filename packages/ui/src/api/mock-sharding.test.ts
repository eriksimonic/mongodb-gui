import { describe, expect, it } from 'vitest';
import { localConnectionId } from './mock-fixtures';
import { createMockUiApi } from './mock-rpc-client';

async function clusterApi() {
  const api = createMockUiApi({ preset: 'unlocked', sharding: 'cluster' });
  await api.rpc.connections.connect({ id: localConnectionId });
  return api;
}

const TARGET = { connectionId: localConnectionId, database: 'shop', collection: 'sensor_readings' };

describe('mock sharding key rules', () => {
  it('refuses a $-prefixed field the way the adapter does', async () => {
    const api = await clusterApi();
    await expect(
      api.rpc.sharding.shardCollection({
        ...TARGET,
        keyEjson: '{"$deviceId": 1}',
        confirmed: false,
      }),
    ).rejects.toThrow('The shard key field name "$deviceId" is not allowed');
  });

  it('refuses more than one hashed field', async () => {
    const api = await clusterApi();
    await expect(
      api.rpc.sharding.shardCollection({
        ...TARGET,
        keyEjson: '{"deviceId": "hashed", "sensorId": "hashed"}',
        confirmed: false,
      }),
    ).rejects.toThrow('The shard key can contain at most one hashed field.');
  });

  it('returns a summary with no warnings for a valid key', async () => {
    const api = await clusterApi();
    const output = await api.rpc.sharding.shardCollection({
      ...TARGET,
      keyEjson: '{"deviceId": 1}',
      confirmed: false,
    });
    expect(output.applied).toBe(false);
    expect(output.summary.warnings).toEqual([]);
  });
});
