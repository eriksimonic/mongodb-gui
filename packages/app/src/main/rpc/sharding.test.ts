import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as adapter from '@mongo-gui/mongo-adapter';
import {
  AppErrorException,
  appError,
  type AppError,
  type ConnectionProfile,
  type ConnectionStatus,
  type RpcEvent,
  type RpcResult,
} from '@mongo-gui/core';
import {
  createAppServices,
  createRouter,
  type AppServices,
  type ConnectionRegistry,
  type Router,
} from './router';

// The adapter's writes are replaced. The dry run builder is real, so the summary is checked.
vi.mock('@mongo-gui/mongo-adapter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mongo-gui/mongo-adapter')>();
  return {
    ...actual,
    getShardingOverview: vi.fn(),
    shardCollection: vi.fn(),
    enableSharding: vi.fn(),
    startBalancer: vi.fn(),
    stopBalancer: vi.fn(),
  };
});

type Client = ReturnType<ConnectionRegistry['getClient']>;

const CONNECTION_ID = '3f2b8c1e-5d4a-4b7e-9c1f-2a6d8e0b7f10';
const UNKNOWN_CONNECTION_ID = '7d1e9f04-2b3c-4d5e-8f60-a1b2c3d4e5f6';
const FAST_KDF = { N: 2 ** 10, r: 8, p: 1 };
const CLIENT = { marker: 'fake client' } as unknown as Client;

function value(result: RpcResult): unknown {
  if (!result.ok) {
    throw new Error(`expected ok, got ${JSON.stringify(result.error)}`);
  }
  return result.value;
}

function failure(result: RpcResult): AppError {
  if (result.ok) {
    throw new Error('expected a failure');
  }
  return result.error;
}

function fakeRegistry(): ConnectionRegistry {
  const statuses = new Map<string, ConnectionStatus>();
  return {
    async connect(profile: ConnectionProfile): Promise<ConnectionStatus> {
      statuses.set(profile.id, { state: 'disconnected' });
      return { state: 'disconnected' };
    },
    async disconnect(connectionId: string) {
      statuses.delete(connectionId);
    },
    async disconnectAll() {
      statuses.clear();
    },
    status(connectionId: string) {
      return statuses.get(connectionId) ?? { state: 'disconnected' };
    },
    getClient(connectionId: string): Client {
      if (connectionId !== CONNECTION_ID) {
        throw new AppErrorException(appError('NOT_CONNECTED', 'Not connected'));
      }
      return CLIENT;
    },
    async test() {
      return { ok: true, serverVersion: '8.0.17', topology: 'sharded' } as const;
    },
    onStatusChange() {
      return () => undefined;
    },
  };
}

const SHARD_INPUT = {
  connectionId: CONNECTION_ID,
  database: 'shop',
  collection: 'orders',
  keyEjson: '{"region": 1, "orderId": 1}',
};

describe('sharding calls through the router', () => {
  let services: AppServices;
  let router: Router;
  let dir: string;
  let events: RpcEvent[];

  beforeEach(() => {
    vi.clearAllMocks();
    dir = mkdtempSync(join(tmpdir(), 'sharding-router-'));
    services = createAppServices({ userDataDir: dir, kdf: FAST_KDF, failureDelayMs: 0 });
    events = [];
    router = createRouter({
      ...services,
      connections: fakeRegistry(),
      onEvent: (event) => {
        events.push(event);
      },
    });
  });

  afterEach(async () => {
    await services.dispose();
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns the dry run summary and writes nothing when not confirmed', async () => {
    const result = await router.handle('sharding.shardCollection', {
      ...SHARD_INPUT,
      confirmed: false,
    });

    const output = value(result) as { applied: boolean; summary: { namespace: string } };
    expect(output.applied).toBe(false);
    expect(output.summary.namespace).toBe('shop.orders');
    expect(adapter.shardCollection).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it('applies the confirmed call and reports the catalog change', async () => {
    vi.mocked(adapter.shardCollection).mockResolvedValue(undefined);

    const result = await router.handle('sharding.shardCollection', {
      ...SHARD_INPUT,
      confirmed: true,
    });

    expect((value(result) as { applied: boolean }).applied).toBe(true);
    expect(adapter.shardCollection).toHaveBeenCalledWith(
      CLIENT,
      expect.objectContaining({ collection: 'orders' }),
    );
    expect(events).toEqual([
      {
        type: 'catalog:changed',
        connectionId: CONNECTION_ID,
        database: 'shop',
        collection: 'orders',
      },
    ]);
  });

  it('refuses a unique hashed key before any server call', async () => {
    const result = await router.handle('sharding.shardCollection', {
      ...SHARD_INPUT,
      keyEjson: '{"region": "hashed"}',
      unique: true,
      confirmed: true,
    });

    expect(failure(result).code).toBe('VALIDATION');
    expect(adapter.shardCollection).not.toHaveBeenCalled();
  });

  it('starts and stops the balancer and returns the status', async () => {
    const running = { mode: 'full', inBalancerRound: false } as const;
    const stopped = { mode: 'off', inBalancerRound: false } as const;
    vi.mocked(adapter.startBalancer).mockResolvedValue(running);
    vi.mocked(adapter.stopBalancer).mockResolvedValue(stopped);

    expect(
      value(
        await router.handle('sharding.setBalancer', { connectionId: CONNECTION_ID, enabled: true }),
      ),
    ).toEqual(running);
    expect(
      value(
        await router.handle('sharding.setBalancer', {
          connectionId: CONNECTION_ID,
          enabled: false,
        }),
      ),
    ).toEqual(stopped);
    expect(adapter.startBalancer).toHaveBeenCalledWith(CLIENT);
    expect(adapter.stopBalancer).toHaveBeenCalledWith(CLIENT);
    expect(events).toEqual([]);
  });

  it('reports enabling sharding on a database as a catalog change', async () => {
    vi.mocked(adapter.enableSharding).mockResolvedValue(undefined);

    const result = await router.handle('sharding.enableSharding', {
      connectionId: CONNECTION_ID,
      database: 'analytics',
    });

    expect(value(result)).toBeUndefined();
    expect(events).toEqual([
      { type: 'catalog:changed', connectionId: CONNECTION_ID, database: 'analytics' },
    ]);
  });

  it('requires a connected connection', async () => {
    const result = await router.handle('sharding.overview', {
      connectionId: UNKNOWN_CONNECTION_ID,
    });

    expect(failure(result).code).toBe('NOT_CONNECTED');
    expect(adapter.getShardingOverview).not.toHaveBeenCalled();
  });
});
