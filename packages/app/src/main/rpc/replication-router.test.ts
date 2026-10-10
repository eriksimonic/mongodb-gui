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
  type ReconfigPlan,
  type ReplicaSetConfig,
  type ReplicaSetStatus,
  type RpcResult,
} from '@mongo-gui/core';
import {
  createAppServices,
  createRouter,
  type AppServices,
  type ConnectionRegistry,
  type Router,
} from './router';

// Only the replication functions are replaced. The rest of the adapter keeps its behaviour.
vi.mock('@mongo-gui/mongo-adapter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mongo-gui/mongo-adapter')>();
  return {
    ...actual,
    getReplicaSetStatus: vi.fn(),
    getReplicaSetConfig: vi.fn(),
    getSelfHost: vi.fn(),
    planReconfig: vi.fn(),
    applyReconfig: vi.fn(),
    stepDown: vi.fn(),
  };
});

type Client = ReturnType<ConnectionRegistry['getClient']>;

const CONNECTION_ID = '3f2b8c1e-5d4a-4b7e-9c1f-2a6d8e0b7f10';
const FAST_KDF = { N: 2 ** 10, r: 8, p: 1 };
const CLIENT = { marker: 'fake client' } as unknown as Client;

const CONFIG: ReplicaSetConfig = {
  id: 'rs0',
  version: 4,
  members: [],
  settingsEjson: '{}',
  extraEjson: '{}',
};
const STATUS = { setName: 'rs0', myState: 1, members: [] } as unknown as ReplicaSetStatus;
const PLAN: ReconfigPlan = {
  current: CONFIG,
  next: { ...CONFIG, version: 5 },
  changes: ['Remove a:1 (member 1).'],
  warnings: [],
};

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
      return { ok: true, serverVersion: '8.0.17', topology: 'replicaSet' } as const;
    },
    onStatusChange() {
      return () => undefined;
    },
  } as unknown as ConnectionRegistry;
}

describe('replication calls through the router', () => {
  let services: AppServices;
  let router: Router;
  let dir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(adapter.getReplicaSetStatus).mockResolvedValue(STATUS);
    vi.mocked(adapter.getReplicaSetConfig).mockResolvedValue(CONFIG);
    vi.mocked(adapter.planReconfig).mockReturnValue(PLAN);
    vi.mocked(adapter.applyReconfig).mockResolvedValue(undefined);
    dir = mkdtempSync(join(tmpdir(), 'replication-router-'));
    services = createAppServices({ userDataDir: dir, kdf: FAST_KDF, failureDelayMs: 0 });
    router = createRouter({ ...services, connections: fakeRegistry(), onEvent: () => undefined });
  });

  afterEach(async () => {
    await services.dispose();
    rmSync(dir, { recursive: true, force: true });
  });

  it('applies a plan the page made', async () => {
    const planned = value(
      await router.handle('replication.planReconfig', {
        connectionId: CONNECTION_ID,
        change: { kind: 'remove', memberId: 1 },
      }),
    ) as { planId: string };

    value(
      await router.handle('replication.applyReconfig', {
        connectionId: CONNECTION_ID,
        planId: planned.planId,
        expectedVersion: 4,
      }),
    );
    expect(adapter.applyReconfig).toHaveBeenCalledWith(CLIENT, PLAN);
  });

  it('refuses to apply a plan made before the renderer reset', async () => {
    const planned = value(
      await router.handle('replication.planReconfig', {
        connectionId: CONNECTION_ID,
        change: { kind: 'remove', memberId: 1 },
      }),
    ) as { planId: string };

    router.resetRenderer();

    const refused = failure(
      await router.handle('replication.applyReconfig', {
        connectionId: CONNECTION_ID,
        planId: planned.planId,
        expectedVersion: 4,
      }),
    );
    expect(refused.code).toBe('VALIDATION');
    expect(refused.message).toMatch(/no longer available/);
    expect(adapter.applyReconfig).not.toHaveBeenCalled();
  });

  it('passes a catch-up period below the step-down so the server accepts it', async () => {
    vi.mocked(adapter.stepDown).mockResolvedValue('localhost:27018');

    const result = value(
      await router.handle('replication.stepDown', {
        connectionId: CONNECTION_ID,
        stepDownSeconds: 60,
      }),
    );
    expect(result).toEqual({ primary: 'localhost:27018' });
    expect(adapter.stepDown).toHaveBeenCalledWith(CLIENT, {
      stepDownSeconds: 60,
      secondaryCatchUpSeconds: 10,
    });
  });

  it('refuses a step-down of 10 seconds before it reaches the server', async () => {
    const refused = await router.handle('replication.stepDown', {
      connectionId: CONNECTION_ID,
      stepDownSeconds: 10,
    });
    expect(failure(refused).code).toBe('VALIDATION');
    expect(adapter.stepDown).not.toHaveBeenCalled();
  });

  it('returns the host the node names itself by, or null when it names none', async () => {
    vi.mocked(adapter.getSelfHost).mockResolvedValueOnce('db4.example.net:27017');
    expect(
      value(await router.handle('replication.selfHost', { connectionId: CONNECTION_ID })),
    ).toEqual({ host: 'db4.example.net:27017' });

    vi.mocked(adapter.getSelfHost).mockResolvedValueOnce(undefined);
    expect(
      value(await router.handle('replication.selfHost', { connectionId: CONNECTION_ID })),
    ).toEqual({ host: null });
  });
});
