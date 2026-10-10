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
  type RpcResult,
} from '@mongo-gui/core';
import {
  createAppServices,
  createRouter,
  type AppServices,
  type ConnectionRegistry,
  type Router,
} from './router';

// The adapter's security functions are replaced, so the router is tested without a driver.
vi.mock('@mongo-gui/mongo-adapter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mongo-gui/mongo-adapter')>();
  return {
    ...actual,
    listUsers: vi.fn(),
    createUser: vi.fn(),
    changePassword: vi.fn(),
    grantRoles: vi.fn(),
    revokeRoles: vi.fn(),
    dropUser: vi.fn(),
    listRoles: vi.fn(),
    createRole: vi.fn(),
    updateRole: vi.fn(),
    dropRole: vi.fn(),
    userManagementCapabilities: vi.fn(),
  };
});

type Client = ReturnType<ConnectionRegistry['getClient']>;

const CONNECTION_ID = '3f2b8c1e-5d4a-4b7e-9c1f-2a6d8e0b7f10';
const FAST_KDF = { N: 2 ** 10, r: 8, p: 1 };
const CLIENT = { marker: 'fake client' } as unknown as Client;
const PASSWORD = 'correct horse battery';

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
  return {
    async connect(profile: ConnectionProfile): Promise<ConnectionStatus> {
      return { state: 'disconnected', id: profile.id } as unknown as ConnectionStatus;
    },
    async disconnect() {
      return undefined;
    },
    async disconnectAll() {
      return undefined;
    },
    status() {
      return { state: 'disconnected' } as ConnectionStatus;
    },
    getClient(connectionId: string): Client {
      if (connectionId !== CONNECTION_ID) {
        throw new AppErrorException(appError('NOT_CONNECTED', 'Not connected'));
      }
      return CLIENT;
    },
    async test() {
      return { ok: true, serverVersion: '8.0.17', topology: 'standalone' } as const;
    },
    onStatusChange() {
      return () => undefined;
    },
  } as unknown as ConnectionRegistry;
}

describe('users and roles calls through the router', () => {
  let services: AppServices;
  let router: Router;
  let dir: string;
  let events: unknown[];

  beforeEach(() => {
    vi.clearAllMocks();
    dir = mkdtempSync(join(tmpdir(), 'security-router-'));
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

  it('sends custom data to the renderer as canonical EJSON', async () => {
    vi.mocked(adapter.listUsers).mockResolvedValue([
      {
        id: 'shop.reporter',
        user: 'reporter',
        db: 'shop',
        roles: [],
        mechanisms: ['SCRAM-SHA-256'],
        authenticationRestrictions: [],
        customData: { since: new Date(0) },
      },
    ]);

    const result = await router.handle('security.listUsers', {
      connectionId: CONNECTION_ID,
      database: 'shop',
    });

    expect(value(result)).toMatchObject([
      { user: 'reporter', customData: { since: { $date: { $numberLong: '0' } } } },
    ]);
  });

  it('masks a password that the server error text carries', async () => {
    vi.mocked(adapter.createUser).mockRejectedValue(
      new AppErrorException(
        appError('COMMAND_FAILED', 'The server rejected the command', `refused for ${PASSWORD}`),
      ),
    );

    const result = await router.handle('security.createUser', {
      connectionId: CONNECTION_ID,
      db: 'shop',
      user: 'etl',
      password: PASSWORD,
      roles: [],
    });

    const error = failure(result);
    expect(error.detail).toBe('refused for ***');
    expect(JSON.stringify(result)).not.toContain(PASSWORD);
    expect(JSON.stringify(events)).not.toContain(PASSWORD);
  });

  it('keeps the password out of the change password response and events', async () => {
    vi.mocked(adapter.changePassword).mockResolvedValue(undefined);

    const result = await router.handle('security.changePassword', {
      connectionId: CONNECTION_ID,
      db: 'shop',
      user: 'reporter',
      password: PASSWORD,
    });

    expect(value(result)).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(PASSWORD);
    expect(JSON.stringify(events)).not.toContain(PASSWORD);
  });

  it('lists the privilege actions by category without a connection', async () => {
    const result = await router.handle('security.privilegeActions', undefined);

    expect(value(result)).toMatchObject({ queryAndWrite: expect.arrayContaining(['find']) });
  });
});
