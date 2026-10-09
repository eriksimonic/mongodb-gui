import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AppErrorException,
  appError,
  rpcContract,
  type AppError,
  type ConnectionProfile,
  type ConnectionStatus,
  type ConnectionTestResult,
  type RpcEvent,
  type RpcResult,
  type Settings,
} from '@mongo-gui/core';
import { EncryptedStore, Vault } from '@mongo-gui/storage';
import {
  createAppServices,
  createRepos,
  createRouter,
  type ConnectionRegistry,
  type Router,
  type StoreHandles,
} from './router';

const FAST_KDF = { N: 2 ** 10, r: 8, p: 1 };
const PASSWORD = 'correct horse battery';
const NEW_PASSWORD = 'staple battery horse';
const CONNECTED: ConnectionStatus = {
  state: 'connected',
  serverVersion: '8.0.17',
  topology: 'standalone',
  hosts: ['localhost:27017'],
};
const URI = 'mongodb://app:hunter2@localhost:27017/?authSource=admin';

interface FakeConnections extends ConnectionRegistry {
  readonly connectCalls: ConnectionProfile[];
  readonly disconnectCalls: string[];
  disconnectAllCalls: number;
  emitStatus(connectionId: string, status: ConnectionStatus): void;
}

/** A ConnectionManager stand-in. Every connect succeeds unless the test changes it. */
function fakeConnections(): FakeConnections {
  const statuses = new Map<string, ConnectionStatus>();
  const listeners = new Set<(connectionId: string, status: ConnectionStatus) => void>();
  const emit = (connectionId: string, status: ConnectionStatus): void => {
    for (const listener of listeners) {
      listener(connectionId, status);
    }
  };
  const fake: FakeConnections = {
    connectCalls: [],
    disconnectCalls: [],
    disconnectAllCalls: 0,
    async connect(profile) {
      fake.connectCalls.push(profile);
      statuses.set(profile.id, CONNECTED);
      emit(profile.id, CONNECTED);
      return CONNECTED;
    },
    async disconnect(connectionId) {
      fake.disconnectCalls.push(connectionId);
      statuses.delete(connectionId);
      emit(connectionId, { state: 'disconnected' });
    },
    async disconnectAll() {
      fake.disconnectAllCalls += 1;
    },
    status(connectionId) {
      return statuses.get(connectionId) ?? { state: 'disconnected' };
    },
    // Catalog calls need a live MongoClient, which these tests never have.
    getClient(connectionId): never {
      throw new AppErrorException(appError('NOT_CONNECTED', `Not connected: ${connectionId}`));
    },
    async test(): Promise<ConnectionTestResult> {
      return { ok: true, serverVersion: '8.0.17', topology: 'standalone' };
    },
    onStatusChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    emitStatus: emit,
  };
  return fake;
}

interface Harness {
  readonly router: Router;
  readonly vault: Vault;
  readonly connections: FakeConnections;
  readonly events: RpcEvent[];
  readonly handles: StoreHandles;
  dispose(): void;
}

function buildHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'router-'));
  const lockListeners = new Set<() => void>();
  const vault = new Vault({
    dir,
    kdf: FAST_KDF,
    failureDelayMs: 0,
    onLocked: () => {
      for (const listener of lockListeners) {
        listener();
      }
    },
  });
  const path = join(dir, 'store.sqlite');
  const open = (): StoreHandles => {
    const store = new EncryptedStore({ path, vault });
    return { store, repos: createRepos(store) };
  };
  let handles = open();
  const connections = fakeConnections();
  const events: RpcEvent[] = [];
  const router = createRouter({
    vault,
    store: handles.store,
    repos: handles.repos,
    connections,
    onEvent: (event) => {
      events.push(event);
    },
    reopenStore: () => {
      handles = open();
      return handles;
    },
    lockEvents: {
      subscribe(listener) {
        lockListeners.add(listener);
        return () => {
          lockListeners.delete(listener);
        };
      },
    },
  });
  return {
    router,
    vault,
    connections,
    events,
    get handles() {
      return handles;
    },
    dispose() {
      handles.store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function expectError(result: RpcResult, code: AppError['code']): AppError {
  if (result.ok) {
    throw new Error(`expected ${code}, got ok with ${JSON.stringify(result.value)}`);
  }
  expect(result.error.code).toBe(code);
  return result.error;
}

function expectValue(result: RpcResult): unknown {
  if (!result.ok) {
    throw new Error(`expected ok, got ${JSON.stringify(result.error)}`);
  }
  return result.value;
}

const profileInput = { name: 'Local', uri: URI };

describe('vault calls', () => {
  let harness: Harness | undefined;
  afterEach(() => {
    harness?.dispose();
    harness = undefined;
  });

  it('walks the lifecycle: initialise, lock, bad unlock, unlock, change password', async () => {
    harness = buildHarness();
    const { router } = harness;

    expect(expectValue(await router.handle('vault.status', undefined))).toEqual({
      state: 'uninitialised',
    });
    expectValue(await router.handle('vault.initialise', { password: PASSWORD }));
    expect(expectValue(await router.handle('vault.status', undefined))).toEqual({
      state: 'unlocked',
    });

    expectValue(await router.handle('vault.lock', undefined));
    expect(expectValue(await router.handle('vault.status', undefined))).toEqual({
      state: 'locked',
    });

    expectError(
      await router.handle('vault.unlock', { password: 'wrong password!!' }),
      'VAULT_BAD_PASSWORD',
    );
    expectValue(await router.handle('vault.unlock', { password: PASSWORD }));

    expectValue(
      await router.handle('vault.changePassword', { current: PASSWORD, next: NEW_PASSWORD }),
    );
    expectValue(await router.handle('vault.lock', undefined));
    expectError(await router.handle('vault.unlock', { password: PASSWORD }), 'VAULT_BAD_PASSWORD');
    expectValue(await router.handle('vault.unlock', { password: NEW_PASSWORD }));
  });

  it('emits vault:locked and disconnects every connection when the vault locks', async () => {
    harness = buildHarness();
    const { router, connections, events } = harness;
    expectValue(await router.handle('vault.initialise', { password: PASSWORD }));

    expectValue(await router.handle('vault.lock', undefined));

    expect(connections.disconnectAllCalls).toBeGreaterThan(0);
    expect(events).toContainEqual({ type: 'vault:locked' });
  });

  it('resets the vault and store, then initialises again on a fresh store', async () => {
    harness = buildHarness();
    const { router } = harness;
    expectValue(await router.handle('vault.initialise', { password: PASSWORD }));
    expectValue(await router.handle('connections.create', profileInput));

    expectValue(await router.handle('vault.reset', { confirmation: 'DELETE' }));
    expect(expectValue(await router.handle('vault.status', undefined))).toEqual({
      state: 'uninitialised',
    });

    expectValue(await router.handle('vault.initialise', { password: NEW_PASSWORD }));
    expect(expectValue(await router.handle('connections.list', undefined))).toEqual([]);
  });

  it('rejects a short password and a wrong reset confirmation with VALIDATION', async () => {
    harness = buildHarness();
    const { router } = harness;

    const shortPassword = expectError(
      await router.handle('vault.initialise', { password: 'short' }),
      'VALIDATION',
    );
    expect(shortPassword.message).not.toContain('short');
    expectError(await router.handle('vault.reset', { confirmation: 'YES' }), 'VALIDATION');
  });
});

describe('input and output checks', () => {
  let harness: Harness | undefined;
  afterEach(() => {
    harness?.dispose();
    harness = undefined;
  });

  it('returns VALIDATION for a malformed id and does not echo the input', async () => {
    harness = buildHarness();
    expectValue(await harness.router.handle('vault.initialise', { password: PASSWORD }));

    const error = expectError(
      await harness.router.handle('connections.get', { id: 'not-a-uuid-secret' }),
      'VALIDATION',
    );

    expect(JSON.stringify(error)).not.toContain('not-a-uuid-secret');
  });

  it('returns VALIDATION for an unknown method', async () => {
    harness = buildHarness();

    const error = expectError(await harness.router.handle('shell.evaluate', {}), 'VALIDATION');

    expect(error.message).toBe('The method is not known.');
  });

  it('answers every contract method without treating it as unknown', async () => {
    harness = buildHarness();
    for (const [namespace, calls] of Object.entries(rpcContract)) {
      for (const name of Object.keys(calls)) {
        const result = await harness.router.handle(`${namespace}.${name}`, {});
        expect(result.ok === false ? result.error.message : '').not.toBe(
          'The method is not known.',
        );
      }
    }
  });

  it('returns INTERNAL with the method name when a repository returns a bad value', async () => {
    harness = buildHarness();
    const { router, handles } = harness;
    expectValue(await router.handle('vault.initialise', { password: PASSWORD }));
    vi.spyOn(handles.repos.settings, 'get').mockReturnValue({
      theme: 'neon',
    } as unknown as Settings);

    const error = expectError(await router.handle('settings.get', undefined), 'INTERNAL');

    expect(error).toEqual({
      code: 'INTERNAL',
      message: 'The handler returned an unexpected value.',
      detail: 'settings.get',
    });
  });

  it('maps a driver call made without a live client to NOT_CONNECTED', async () => {
    harness = buildHarness();
    const { router } = harness;
    expectValue(await router.handle('vault.initialise', { password: PASSWORD }));

    const error = expectError(
      await router.handle('databases.list', {
        connectionId: '3f2b8c1e-5d4a-4b7e-9c1f-2a6d8e0b7f10',
      }),
      'NOT_CONNECTED',
    );

    expect(error.code).toBe('NOT_CONNECTED');
  });
});

describe('locked vault', () => {
  let harness: Harness | undefined;
  afterEach(() => {
    harness?.dispose();
    harness = undefined;
  });

  it('returns VAULT_LOCKED for repository calls while locked', async () => {
    harness = buildHarness();
    const { router } = harness;
    expectValue(await router.handle('vault.initialise', { password: PASSWORD }));
    expectValue(await router.handle('vault.lock', undefined));

    expectError(await router.handle('connections.list', undefined), 'VAULT_LOCKED');
    expectError(await router.handle('settings.get', undefined), 'VAULT_LOCKED');
    expectError(await router.handle('favourites.list', undefined), 'VAULT_LOCKED');
  });
});

describe('connections', () => {
  let harness: Harness | undefined;
  afterEach(() => {
    harness?.dispose();
    harness = undefined;
  });

  it('lists summaries with a redacted uri and no uri field', async () => {
    harness = buildHarness();
    const { router } = harness;
    expectValue(await router.handle('vault.initialise', { password: PASSWORD }));
    const created = expectValue(await router.handle('connections.create', profileInput));
    expect(created).toHaveProperty('uri', URI);

    const list = expectValue(await router.handle('connections.list', undefined));

    expect(list).toEqual([
      expect.objectContaining({
        name: 'Local',
        uriRedacted: 'mongodb://app:***@localhost:27017/?authSource=admin',
      }),
    ]);
    expect(Object.keys((list as object[])[0] ?? {})).not.toContain('uri');
    expect(JSON.stringify(list)).not.toContain('hunter2');
  });

  it('connects with the stored profile and reports the status', async () => {
    harness = buildHarness();
    const { router, connections, events } = harness;
    expectValue(await router.handle('vault.initialise', { password: PASSWORD }));
    const created = expectValue(await router.handle('connections.create', profileInput)) as {
      id: string;
    };

    const status = expectValue(await router.handle('connections.connect', { id: created.id }));

    expect(status).toEqual(CONNECTED);
    expect(connections.connectCalls).toEqual([
      expect.objectContaining({ id: created.id, uri: URI }),
    ]);
    expect(events).toContainEqual({
      type: 'connection:status',
      connectionId: created.id,
      status: CONNECTED,
    });
  });

  it('disconnects and removes a connection', async () => {
    harness = buildHarness();
    const { router, connections } = harness;
    expectValue(await router.handle('vault.initialise', { password: PASSWORD }));
    const created = expectValue(await router.handle('connections.create', profileInput)) as {
      id: string;
    };
    await router.handle('connections.connect', { id: created.id });

    expectValue(await router.handle('connections.remove', { id: created.id }));

    expect(connections.disconnectCalls).toContain(created.id);
    expectError(await router.handle('connections.get', { id: created.id }), 'CONNECTION_NOT_FOUND');
  });

  it('updates a profile and returns the full profile', async () => {
    harness = buildHarness();
    const { router } = harness;
    expectValue(await router.handle('vault.initialise', { password: PASSWORD }));
    const created = expectValue(await router.handle('connections.create', profileInput)) as {
      id: string;
    };

    const updated = expectValue(
      await router.handle('connections.update', { id: created.id, patch: { name: 'Renamed' } }),
    );

    expect(updated).toEqual(expect.objectContaining({ id: created.id, name: 'Renamed', uri: URI }));
  });

  it('runs connection tests through the manager', async () => {
    harness = buildHarness();
    const { router } = harness;

    const result = expectValue(await router.handle('connections.test', profileInput));

    expect(result).toEqual({ ok: true, serverVersion: '8.0.17', topology: 'standalone' });
  });

  it('forwards status changes from the manager as events', async () => {
    harness = buildHarness();
    const { connections, events } = harness;

    connections.emitStatus('3f2b8c1e-5d4a-4b7e-9c1f-2a6d8e0b7f10', { state: 'disconnected' });

    expect(events).toEqual([
      {
        type: 'connection:status',
        connectionId: '3f2b8c1e-5d4a-4b7e-9c1f-2a6d8e0b7f10',
        status: { state: 'disconnected' },
      },
    ]);
  });
});

describe('settings, history and favourites', () => {
  let harness: Harness | undefined;
  afterEach(() => {
    harness?.dispose();
    harness = undefined;
  });

  it('merges settings updates and reads them back', async () => {
    harness = buildHarness();
    const { router } = harness;
    expectValue(await router.handle('vault.initialise', { password: PASSWORD }));

    const updated = expectValue(
      await router.handle('settings.update', { idleLockMinutes: 5 }),
    ) as Settings;

    expect(updated.idleLockMinutes).toBe(5);
    expect(expectValue(await router.handle('settings.get', undefined))).toEqual(updated);
  });

  it('saves, lists and removes favourites', async () => {
    harness = buildHarness();
    const { router } = harness;
    expectValue(await router.handle('vault.initialise', { password: PASSWORD }));

    const saved = expectValue(
      await router.handle('favourites.save', { name: 'Paid orders', code: 'db.orders.find()' }),
    ) as { id: string };
    expect(expectValue(await router.handle('favourites.list', undefined))).toEqual([
      expect.objectContaining({ id: saved.id, name: 'Paid orders' }),
    ]);

    expectValue(await router.handle('favourites.remove', { id: saved.id }));
    expect(expectValue(await router.handle('favourites.list', undefined))).toEqual([]);
  });

  it('lists and clears history', async () => {
    harness = buildHarness();
    const { router } = harness;
    expectValue(await router.handle('vault.initialise', { password: PASSWORD }));

    expect(expectValue(await router.handle('history.list', {}))).toEqual([]);
    expectValue(await router.handle('history.clear', undefined));
  });
});

describe('createAppServices', () => {
  it('builds services over a temp directory and disposes them', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'services-'));
    const services = createAppServices({
      userDataDir: dir,
      kdf: FAST_KDF,
      failureDelayMs: 0,
    });
    const events: RpcEvent[] = [];
    const router = createRouter({
      ...services,
      onEvent: (event) => {
        events.push(event);
      },
    });
    try {
      expectValue(await router.handle('vault.initialise', { password: PASSWORD }));
      expectValue(await router.handle('vault.lock', undefined));

      expect(events).toContainEqual({ type: 'vault:locked' });
      expect(expectValue(await router.handle('vault.status', undefined))).toEqual({
        state: 'locked',
      });
    } finally {
      await services.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
