import { describe, expect, it, vi } from 'vitest';
import { localConnectionId } from '../api/mock-fixtures';
import { createMockUiApi } from '../api/mock-rpc-client';
import { createShardingStore } from './sharding-store';

async function clusterApi() {
  const api = createMockUiApi({ preset: 'unlocked', sharding: 'cluster' });
  await api.rpc.connections.connect({ id: localConnectionId });
  return api;
}

describe('sharding store', () => {
  it('loads the overview of a cluster', async () => {
    const api = await clusterApi();
    const store = createShardingStore(localConnectionId, api.rpc.sharding);
    await store.getState().load();

    const overview = store.getState().overview;
    expect(overview?.isSharded).toBe(true);
    expect(overview?.shards.map((shard) => shard.id)).toEqual(['shard-a', 'shard-b']);
    expect(overview?.databases.find((database) => database.name === 'shop')?.partitioned).toBe(
      true,
    );
    expect(store.getState().loadError).toBeUndefined();
  });

  it('keeps the load error text and clears it on the next good load', async () => {
    const api = createMockUiApi({ preset: 'unlocked' });
    await api.rpc.connections.connect({ id: localConnectionId });
    const store = createShardingStore(localConnectionId, api.rpc.sharding);
    await store.getState().load();
    expect(store.getState().overview?.isSharded).toBe(false);

    vi.spyOn(api.rpc.sharding, 'overview').mockRejectedValueOnce(new Error('network down'));
    await store.getState().load();
    expect(store.getState().loadError).toBe('network down');
    await store.getState().load();
    expect(store.getState().loadError).toBeUndefined();
  });

  it('reloads the overview after the balancer changes', async () => {
    const api = await clusterApi();
    const store = createShardingStore(localConnectionId, api.rpc.sharding);
    await store.getState().load();

    const status = await store.getState().setBalancer(false);
    expect(status.mode).toBe('off');
    expect(store.getState().overview?.balancer?.mode).toBe('off');
  });

  it('previews without a server write and applies only the confirmed call', async () => {
    const api = await clusterApi();
    const store = createShardingStore(localConnectionId, api.rpc.sharding);
    const target = {
      database: 'shop',
      collection: 'sensor_readings',
      keyEjson: '{"deviceId":"hashed"}',
    };

    const summary = await store.getState().previewShardCollection(target);
    expect(summary.namespace).toBe('shop.sensor_readings');
    expect(summary.keyText).toBe('{ deviceId: "hashed" }');
    await store.getState().load();
    expect(store.getState().overview?.collections.map((item) => item.ns)).not.toContain(
      'shop.sensor_readings',
    );

    const applied = await store.getState().applyShardCollection(target);
    expect(applied.applied).toBe(true);
    await store.getState().load();
    expect(store.getState().overview?.collections.map((item) => item.ns)).toContain(
      'shop.sensor_readings',
    );
  });

  it('refuses a unique hashed key before the server runs anything', async () => {
    const api = await clusterApi();
    const store = createShardingStore(localConnectionId, api.rpc.sharding);
    await expect(
      store.getState().previewShardCollection({
        database: 'shop',
        collection: 'sensor_readings',
        keyEjson: '{"deviceId":"hashed"}',
        unique: true,
      }),
    ).rejects.toThrow('A hashed shard key cannot be unique');
  });
});
