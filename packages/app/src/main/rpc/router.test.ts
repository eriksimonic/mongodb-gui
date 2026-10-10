import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AppErrorException,
  appError,
  dashboardLayoutKey,
  defaultSettings,
  LAYOUT_VALUE_LIMIT_BYTES,
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
import type { DockerRuntime } from '../docker/runtime';
import type { Logger } from '../log';
import {
  createAppServices,
  createRepos,
  createRouter,
  type ConnectionRegistry,
  type NativeDialogs,
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

function buildHarness(logger?: Logger, docker?: DockerRuntime, dialogs?: NativeDialogs): Harness {
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
    ...(logger === undefined ? {} : { log: logger }),
    ...(docker === undefined ? {} : { docker }),
    ...(dialogs === undefined ? {} : { dialogs }),
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

    const error = expectError(await harness.router.handle('shell.explode', {}), 'VALIDATION');

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

describe('uninitialised vault', () => {
  let harness: Harness | undefined;
  afterEach(() => {
    harness?.dispose();
    harness = undefined;
  });

  it('returns VAULT_NOT_INITIALISED for repository calls before setup', async () => {
    harness = buildHarness();
    const { router } = harness;

    expectError(await router.handle('connections.list', undefined), 'VAULT_NOT_INITIALISED');
    expectError(await router.handle('settings.get', undefined), 'VAULT_NOT_INITIALISED');
  });
});

/** Captures log records so tests can check what reached the logger. */
function captureLogger(): {
  logger: Logger;
  records: { level: string; message: string; fields: unknown }[];
} {
  const records: { level: string; message: string; fields: unknown }[] = [];
  const write =
    (level: string) =>
    (message: string, fields?: unknown): void => {
      records.push({ level, message, fields });
    };
  return {
    records,
    logger: { info: write('info'), warn: write('warn'), error: write('error') },
  };
}

/** Writes a settings value straight to the store, bypassing the router's validation. */
function writeRawIdleLock(store: EncryptedStore, idleLockMinutes: number): void {
  // 'app' is the settings row key used by SettingsRepository.
  store.db
    .prepare(
      'INSERT INTO settings (key, payload) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET payload = excluded.payload',
    )
    .run('app', store.encryptPayload('settings', 'app', { idleLockMinutes }));
}

describe('idle lock setting', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('applies idleLockMinutes to the vault on settings.update', async () => {
    vi.useFakeTimers();
    const harness = buildHarness();
    try {
      const { router, events } = harness;
      expectValue(await router.handle('vault.initialise', { password: PASSWORD }));

      expectValue(await router.handle('settings.update', { idleLockMinutes: 1 }));
      vi.advanceTimersByTime(59_000);
      expect(harness.vault.status()).toEqual({
        state: 'unlocked',
      });

      vi.advanceTimersByTime(1_000);
      expect(harness.vault.status()).toEqual({
        state: 'locked',
      });
      expect(events).toContainEqual({ type: 'vault:locked' });
    } finally {
      harness.dispose();
    }
  });

  it('accepts the 24 hour maximum and rejects anything above it', async () => {
    const harness = buildHarness();
    try {
      const { router } = harness;
      expectValue(await router.handle('vault.initialise', { password: PASSWORD }));

      expectValue(await router.handle('settings.update', { idleLockMinutes: 24 * 60 }));
      expectError(
        await router.handle('settings.update', { idleLockMinutes: 24 * 60 + 1 }),
        'VALIDATION',
      );
    } finally {
      harness.dispose();
    }
  });

  it('never stores a rejected idle lock value', async () => {
    const harness = buildHarness();
    try {
      const { router } = harness;
      expectValue(await router.handle('vault.initialise', { password: PASSWORD }));

      expectError(await router.handle('settings.update', { idleLockMinutes: 1e15 }), 'VALIDATION');

      expect(expectValue(await router.handle('settings.get', undefined))).toEqual(
        expect.objectContaining({ idleLockMinutes: 30 }),
      );
    } finally {
      harness.dispose();
    }
  });

  it('keeps the vault unlocked for browsing: successful calls touch the idle timer', async () => {
    vi.useFakeTimers();
    const harness = buildHarness();
    try {
      const { router } = harness;
      expectValue(await router.handle('vault.initialise', { password: PASSWORD }));
      expectValue(await router.handle('settings.update', { idleLockMinutes: 1 }));

      vi.advanceTimersByTime(50_000);
      expectValue(await router.handle('connections.list', undefined));
      vi.advanceTimersByTime(50_000);
      expect(harness.vault.status()).toEqual({
        state: 'unlocked',
      });

      vi.advanceTimersByTime(10_000);
      expect(harness.vault.status()).toEqual({
        state: 'locked',
      });
    } finally {
      harness.dispose();
    }
  });

  it('applies the stored idleLockMinutes when the vault is unlocked after a restart', async () => {
    vi.useFakeTimers();
    const dir = mkdtempSync(join(tmpdir(), 'idle-restart-'));
    try {
      const first = createAppServices({ userDataDir: dir, kdf: FAST_KDF, failureDelayMs: 0 });
      try {
        const firstRouter = createRouter({ ...first, onEvent: () => undefined });
        expectValue(await firstRouter.handle('vault.initialise', { password: PASSWORD }));
        expectValue(await firstRouter.handle('settings.update', { idleLockMinutes: 2 }));
        expectValue(await firstRouter.handle('vault.lock', undefined));
      } finally {
        await first.dispose();
      }

      const second = createAppServices({ userDataDir: dir, kdf: FAST_KDF, failureDelayMs: 0 });
      try {
        const secondRouter = createRouter({ ...second, onEvent: () => undefined });
        expectValue(await secondRouter.handle('vault.unlock', { password: PASSWORD }));
        vi.advanceTimersByTime(119_000);
        expect(second.vault.status()).toEqual({
          state: 'unlocked',
        });
        vi.advanceTimersByTime(1_000);
        expect(second.vault.status()).toEqual({
          state: 'locked',
        });
      } finally {
        await second.dispose();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('unlocks when the stored idle lock is out of range and keeps the 30 minute default', async () => {
    vi.useFakeTimers();
    const dir = mkdtempSync(join(tmpdir(), 'idle-bad-'));
    try {
      const first = createAppServices({ userDataDir: dir, kdf: FAST_KDF, failureDelayMs: 0 });
      try {
        const firstRouter = createRouter({ ...first, onEvent: () => undefined });
        expectValue(await firstRouter.handle('vault.initialise', { password: PASSWORD }));
        // An old store may hold a value the current schema rejects.
        writeRawIdleLock(first.store, 1e15);
        expectValue(await firstRouter.handle('vault.lock', undefined));
      } finally {
        await first.dispose();
      }

      const second = createAppServices({ userDataDir: dir, kdf: FAST_KDF, failureDelayMs: 0 });
      try {
        const secondRouter = createRouter({ ...second, onEvent: () => undefined });
        expectValue(await secondRouter.handle('vault.unlock', { password: PASSWORD }));
        // The invalid field is dropped, so the vault keeps its 30 minute default.
        vi.advanceTimersByTime(29 * 60_000);
        expect(second.vault.status()).toEqual({ state: 'unlocked' });
        vi.advanceTimersByTime(60_000);
        expect(second.vault.status()).toEqual({ state: 'locked' });
      } finally {
        await second.dispose();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('failure logging and responses', () => {
  let harness: Harness | undefined;
  afterEach(() => {
    harness?.dispose();
    harness = undefined;
  });

  it('answers an unexpected exception with a fixed message and logs the raw text', async () => {
    const captured = captureLogger();
    harness = buildHarness(captured.logger);
    const { router, handles } = harness;
    expectValue(await router.handle('vault.initialise', { password: PASSWORD }));
    vi.spyOn(handles.repos.connections, 'list').mockImplementation(() => {
      throw new Error('driver said mongodb://app:hunter2@db.internal failed');
    });

    const error = expectError(await router.handle('connections.list', undefined), 'INTERNAL');

    expect(error).toEqual({ code: 'INTERNAL', message: 'Unexpected error' });
    expect(JSON.stringify(error)).not.toContain('hunter2');
    expect(captured.records).toContainEqual(
      expect.objectContaining({
        level: 'error',
        fields: expect.objectContaining({
          method: 'connections.list',
          code: 'INTERNAL',
        }) as unknown,
      }),
    );
    expect(JSON.stringify(captured.records)).toContain('driver said');
  });

  it('logs a known AppError with its method and code, without the input', async () => {
    const captured = captureLogger();
    harness = buildHarness(captured.logger);
    const { router } = harness;
    expectValue(await router.handle('vault.initialise', { password: PASSWORD }));

    expectError(
      await router.handle('connections.get', { id: 'b8c1b2e0-0000-4000-8000-000000000001' }),
      'CONNECTION_NOT_FOUND',
    );

    expect(captured.records).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        fields: expect.objectContaining({
          method: 'connections.get',
          code: 'CONNECTION_NOT_FOUND',
        }) as unknown,
      }),
    );
    expect(JSON.stringify(captured.records)).not.toContain('b8c1b2e0');
  });
});

/** Records every docker call the router makes. The runtime itself is tested in docker/runtime.test.ts. */
function fakeDocker(): DockerRuntime & { readonly calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async status() {
      calls.push('status');
      return { available: true, engineVersion: '29.8.2' };
    },
    async list() {
      calls.push('list');
      return [];
    },
    async connect(containerId) {
      calls.push(`connect:${containerId}`);
      return { connectionId: '3f2b8c1e-5d4a-4b7e-9c1f-2a6d8e0b7f10', status: CONNECTED };
    },
    async disconnect(containerId) {
      calls.push(`disconnect:${containerId}`);
    },
    setAutoConnect(enabled) {
      calls.push(`setAutoConnect:${enabled}`);
      return { ...defaultSettings, dockerAutoConnect: enabled };
    },
    watch(enabled) {
      calls.push(`watch:${enabled}`);
    },
    suspend() {
      calls.push('suspend');
    },
    resume() {
      calls.push('resume');
    },
    async autoConnect() {
      calls.push('autoConnect');
    },
    async releaseProfile(profile) {
      calls.push(`release:${profile?.id ?? 'none'}`);
    },
    async cleanupAll() {
      calls.push('cleanupAll');
    },
    async dispose() {
      calls.push('dispose');
    },
  };
}

describe('docker calls', () => {
  let harness: Harness | undefined;
  afterEach(() => {
    harness?.dispose();
    harness = undefined;
  });

  it('reports the docker namespace as not available when no runtime is wired', async () => {
    harness = buildHarness();

    expectError(await harness.router.handle('docker.status', undefined), 'INTERNAL');
  });

  it('passes status, list, watch and auto connect through to the runtime', async () => {
    const docker = fakeDocker();
    harness = buildHarness(undefined, docker);
    const { router } = harness;
    expectValue(await router.handle('vault.initialise', { password: PASSWORD }));

    expect(expectValue(await router.handle('docker.status', undefined))).toEqual({
      available: true,
      engineVersion: '29.8.2',
    });
    expectValue(await router.handle('docker.list', undefined));
    expectValue(await router.handle('docker.watch', { enabled: true }));
    expect(expectValue(await router.handle('docker.setAutoConnect', { enabled: true }))).toEqual(
      expect.objectContaining({ dockerAutoConnect: true }),
    );
    expect(docker.calls).toEqual(['status', 'list', 'watch:true', 'setAutoConnect:true']);
  });

  it('rejects a container id that could change the request path', async () => {
    harness = buildHarness(undefined, fakeDocker());

    expectError(
      await harness.router.handle('docker.connect', { containerId: '../containers' }),
      'VALIDATION',
    );
  });

  it('rebuilds a docker profile through the runtime instead of the stored uri', async () => {
    const docker = fakeDocker();
    harness = buildHarness(undefined, docker);
    const { router, connections } = harness;
    expectValue(await router.handle('vault.initialise', { password: PASSWORD }));
    const created = expectValue(
      await router.handle('connections.create', {
        name: 'shop-db',
        uri: URI,
        source: 'docker',
        dockerContainerId: 'abc123',
      }),
    ) as { id: string };

    const status = expectValue(await router.handle('connections.connect', { id: created.id }));

    expect(status).toEqual(CONNECTED);
    expect(docker.calls).toEqual(['connect:abc123']);
    expect(connections.connectCalls).toEqual([]);
  });

  it('frees the forwarder when a docker profile disconnects or is removed', async () => {
    const docker = fakeDocker();
    harness = buildHarness(undefined, docker);
    const { router } = harness;
    expectValue(await router.handle('vault.initialise', { password: PASSWORD }));
    const created = expectValue(
      await router.handle('connections.create', {
        name: 'shop-db',
        uri: URI,
        source: 'docker',
        dockerContainerId: 'abc123',
      }),
    ) as { id: string };

    expectValue(await router.handle('connections.disconnect', { id: created.id }));
    expectValue(await router.handle('connections.remove', { id: created.id }));

    expect(docker.calls).toEqual([`release:${created.id}`, `release:${created.id}`]);
  });

  it('cleans up forwarders on lock and auto connects after unlock', async () => {
    const docker = fakeDocker();
    harness = buildHarness(undefined, docker);
    const { router } = harness;
    expectValue(await router.handle('vault.initialise', { password: PASSWORD }));

    expectValue(await router.handle('vault.lock', undefined));
    expectValue(await router.handle('vault.unlock', { password: PASSWORD }));

    expect(docker.calls).toEqual(['suspend', 'cleanupAll', 'autoConnect', 'resume']);
  });
});

describe('createAppServices', () => {
  it('builds services over a temp directory and disposes them', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'services-'));
    try {
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
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('creates the store file readable by its owner only', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'services-mode-'));
    try {
      const services = createAppServices({ userDataDir: dir, kdf: FAST_KDF, failureDelayMs: 0 });
      try {
        if (process.platform !== 'win32') {
          expect(statSync(join(dir, 'store.sqlite')).mode & 0o777).toBe(0o600);
        }
      } finally {
        await services.dispose();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('layout and app calls', () => {
  let harness: Harness | undefined;
  afterEach(() => {
    harness?.dispose();
    harness = undefined;
  });

  it('stores a JSON value per key and returns null for a missing key', async () => {
    harness = buildHarness();
    const { router } = harness;
    expectValue(await router.handle('vault.initialise', { password: PASSWORD }));
    const layout = { grid: { root: { type: 'branch', data: [] } }, activeGroup: 'main' };

    expect(expectValue(await router.handle('layout.get', { key: 'dockview:main' }))).toEqual({
      value: null,
    });
    expectValue(await router.handle('layout.set', { key: 'dockview:main', value: layout }));

    expect(expectValue(await router.handle('layout.get', { key: 'dockview:main' }))).toEqual({
      value: layout,
    });
  });

  it('overwrites the value stored under a key', async () => {
    harness = buildHarness();
    const { router } = harness;
    expectValue(await router.handle('vault.initialise', { password: PASSWORD }));
    expectValue(await router.handle('layout.set', { key: 'window:main', value: { width: 1 } }));
    expectValue(await router.handle('layout.set', { key: 'window:main', value: { width: 2 } }));

    expect(expectValue(await router.handle('layout.get', { key: 'window:main' }))).toEqual({
      value: { width: 2 },
    });
  });

  it('rejects an empty key or a key with spaces with VALIDATION', async () => {
    harness = buildHarness();
    const { router } = harness;
    expectValue(await router.handle('vault.initialise', { password: PASSWORD }));

    expectError(await router.handle('layout.get', { key: '' }), 'VALIDATION');
    expectError(await router.handle('layout.set', { key: 'has space', value: 1 }), 'VALIDATION');
  });

  it('rejects a value that is not JSON and a value over 256 KB', async () => {
    harness = buildHarness();
    const { router } = harness;
    expectValue(await router.handle('vault.initialise', { password: PASSWORD }));

    expectError(await router.handle('layout.set', { key: 'k', value: undefined }), 'VALIDATION');
    const large = 'x'.repeat(256 * 1024);
    expectError(await router.handle('layout.set', { key: 'k', value: large }), 'VALIDATION');
  });

  it('refuses layout calls while the vault is locked', async () => {
    harness = buildHarness();
    const { router } = harness;
    expectValue(await router.handle('vault.initialise', { password: PASSWORD }));
    expectValue(await router.handle('vault.lock', undefined));

    expectError(await router.handle('layout.get', { key: 'dockview:main' }), 'VAULT_LOCKED');
    expectError(
      await router.handle('layout.set', { key: 'dockview:main', value: {} }),
      'VAULT_LOCKED',
    );
  });

  it('reports the app, Electron, Chrome and Node versions', async () => {
    harness = buildHarness();
    const { router } = harness;

    expect(expectValue(await router.handle('app.versions', undefined))).toEqual({
      app: expect.any(String),
      electron: expect.any(String),
      chrome: expect.any(String),
      node: process.versions.node,
    });
  });
});

describe('layout calls', () => {
  let harness: Harness | undefined;
  afterEach(() => {
    harness?.dispose();
    harness = undefined;
  });

  it('round-trips a saved layout under its key and reads null for a key nothing saved', async () => {
    harness = buildHarness();
    const { router } = harness;
    expectValue(await router.handle('vault.initialise', { password: PASSWORD }));
    const key = dashboardLayoutKey('connection-one');
    const layout = { version: 1, panels: [{ id: 'memory', w: 2, h: 2 }] };

    expectValue(await router.handle('layout.set', { key, value: layout }));

    expect(expectValue(await router.handle('layout.get', { key }))).toEqual({ value: layout });
    const other = dashboardLayoutKey('connection-two');
    expect(expectValue(await router.handle('layout.get', { key: other }))).toEqual({ value: null });
  });

  it('refuses a layout value over the size limit before it is stored', async () => {
    harness = buildHarness();
    const { router } = harness;
    expectValue(await router.handle('vault.initialise', { password: PASSWORD }));
    const key = dashboardLayoutKey('connection-one');

    expectError(
      await router.handle('layout.set', { key, value: 'x'.repeat(LAYOUT_VALUE_LIMIT_BYTES) }),
      'VALIDATION',
    );

    expect(expectValue(await router.handle('layout.get', { key }))).toEqual({ value: null });
  });
});

describe('file picks', () => {
  let harness: Harness | undefined;
  let base = '';
  // What the mocked dialogs return next. Undefined means the user cancelled.
  const picks: { open: string | undefined; folder: string | undefined; save: string | undefined } =
    { open: undefined, folder: undefined, save: undefined };
  const IMPORT_OPTIONS = { format: 'ndjson', mode: 'insert', batchSize: 10, stopOnError: false };
  const OUTSIDE_MESSAGE = 'Choose the folder or the save location in a dialog first.';

  async function setUp(): Promise<{
    router: Router;
    connectionId: string;
    connections: Harness['connections'];
  }> {
    base = mkdtempSync(join(tmpdir(), 'picks-'));
    harness = buildHarness(undefined, undefined, {
      showOpenDialog: async (input) => {
        const path = input.directory === true ? picks.folder : picks.open;
        return path === undefined ? {} : { path };
      },
      showSaveDialog: async () => (picks.save === undefined ? {} : { path: picks.save }),
      showItemInFolder: () => undefined,
    });
    const { router, connections } = harness;
    expectValue(await router.handle('vault.initialise', { password: PASSWORD }));
    const created = expectValue(await router.handle('connections.create', profileInput)) as {
      id: string;
    };
    return { router, connectionId: created.id, connections };
  }

  /** Makes the connection usable: the fake returns a client stub, so a start succeeds. */
  function connect(connections: Harness['connections']): void {
    vi.spyOn(connections, 'getClient').mockReturnValue({} as never);
  }

  function downloadInput(connectionId: string, path: string, overwrite = false) {
    return {
      connectionId,
      database: 'shop',
      bucket: 'receipts',
      idEjson: '{"$oid":"5f2c9a1e0000000000000001"}',
      path,
      overwrite,
    };
  }

  function importInput(connectionId: string, path: string) {
    return { connectionId, database: 'shop', collection: 'copy', path, options: IMPORT_OPTIONS };
  }

  /** Cancels a transfer that a successful start returned, so no transfer outlives the test. */
  async function cancelStarted(started: Promise<RpcResult>, router: Router): Promise<void> {
    const { transferId } = expectValue(await started) as { transferId: string };
    expectValue(await router.handle('transfer.cancel', { transferId }));
    // Cancelling is cooperative, so wait for the transfer to finish before the test ends.
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const status = expectValue(await router.handle('transfer.status', { transferId })) as {
        done: boolean;
      };
      if (status.done) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  function fixture(name: string, content: string): string {
    const path = join(base, name);
    writeFileSync(path, content);
    return path;
  }

  afterEach(() => {
    harness?.dispose();
    harness = undefined;
    vi.restoreAllMocks();
    picks.open = undefined;
    picks.folder = undefined;
    picks.save = undefined;
    if (base !== '') {
      rmSync(base, { recursive: true, force: true });
      base = '';
    }
  });

  it.each([
    ['../../escape.txt', 'a path that climbs out of the picked folder'],
    ['../sibling/x.bin', 'a sibling of the picked folder'],
    ['/etc/x', 'an absolute path outside the picked folder'],
  ])('refuses a download to %s (%s), with and without overwrite', async (name) => {
    const { router, connectionId } = await setUp();
    picks.folder = join(base, 'out');
    expectValue(
      await router.handle('app.showOpenDialog', { title: 't', filters: [], directory: true }),
    );
    for (const overwrite of [false, true]) {
      const error = expectError(
        await router.handle(
          'gridfs.startDownload',
          downloadInput(connectionId, join(base, 'out', name), overwrite),
        ),
        'VALIDATION',
      );
      expect(error.message).toBe(OUTSIDE_MESSAGE);
    }
  });

  it('refuses a path with a .. segment, even one that stays inside the picked folder', async () => {
    const { router, connectionId } = await setUp();
    const folder = join(base, 'out');
    mkdirSync(folder);
    picks.folder = folder;
    expectValue(
      await router.handle('app.showOpenDialog', { title: 't', filters: [], directory: true }),
    );
    const error = expectError(
      await router.handle('gridfs.startDownload', {
        ...downloadInput(connectionId, folder),
        path: `${folder}/sub/../a.pdf`,
      }),
      'VALIDATION',
    );
    expect(error.message).toBe('A path may not contain ".." segments.');
    expectError(
      await router.handle('gridfs.startUpload', {
        connectionId,
        database: 'shop',
        bucket: 'receipts',
        path: `${folder}/../a.pdf`,
      }),
      'VALIDATION',
    );
  });

  it('refuses a folder download through a symlink that leads out of the picked folder', async () => {
    const { router, connectionId } = await setUp();
    const folder = join(base, 'out');
    const outside = join(base, 'elsewhere', 'deep');
    mkdirSync(folder);
    mkdirSync(outside, { recursive: true });
    // out/sub is a real symlink to a folder outside the pick, so out/sub/x.txt lands outside it.
    symlinkSync(outside, join(folder, 'sub'), 'dir');
    picks.folder = folder;
    expectValue(
      await router.handle('app.showOpenDialog', { title: 't', filters: [], directory: true }),
    );
    for (const overwrite of [false, true]) {
      const error = expectError(
        await router.handle(
          'gridfs.startDownload',
          downloadInput(connectionId, join(folder, 'sub', 'x.txt'), overwrite),
        ),
        'VALIDATION',
      );
      expect(error.message).toBe(OUTSIDE_MESSAGE);
    }
  });

  it('allows a picked folder that is itself a symlink to the real folder', async () => {
    const { router, connectionId } = await setUp();
    const folder = join(base, 'out');
    const link = join(base, 'link');
    mkdirSync(folder);
    symlinkSync(folder, link, 'dir');
    picks.folder = link;
    expectValue(
      await router.handle('app.showOpenDialog', { title: 't', filters: [], directory: true }),
    );
    // The pick check passes; the call then stops at the connection, which this harness never opens.
    expectError(
      await router.handle('gridfs.startDownload', downloadInput(connectionId, join(link, 'a.pdf'))),
      'NOT_CONNECTED',
    );
  });

  it('allows a download to the save path picked in the save dialog only', async () => {
    const { router, connectionId } = await setUp();
    picks.save = join(base, 'report.bin');
    expectValue(await router.handle('app.showSaveDialog', { title: 't', filters: [] }));
    expectError(
      await router.handle(
        'gridfs.startDownload',
        downloadInput(connectionId, join(base, 'report.bin'), true),
      ),
      'NOT_CONNECTED',
    );
    expectError(
      await router.handle(
        'gridfs.startDownload',
        downloadInput(connectionId, join(base, 'other.bin'), true),
      ),
      'VALIDATION',
    );
  });

  it('refuses an upload or an import of a file the open dialog did not return', async () => {
    const { router, connectionId } = await setUp();
    const file = join(base, 'secret.env');
    expectError(
      await router.handle('gridfs.startUpload', {
        connectionId,
        database: 'shop',
        bucket: 'receipts',
        path: file,
      }),
      'VALIDATION',
    );
    expectError(
      await router.handle('transfer.startImport', importInput(connectionId, file)),
      'VALIDATION',
    );
  });

  it('refuses a preview of a file the open dialog did not return', async () => {
    const { router, connectionId } = await setUp();
    const file = fixture('unpicked.ndjson', '{"sku":"a1"}\n');
    expectError(
      await router.handle('transfer.previewImport', { connectionId, path: file, sampleRows: 5 }),
      'VALIDATION',
    );
  });

  it('previews a picked file, and the preview leaves the pick for the start', async () => {
    const { router, connectionId, connections } = await setUp();
    const file = fixture('in.ndjson', '{"sku":"a1","total":3}\n');
    picks.open = file;
    expectValue(await router.handle('app.showOpenDialog', { title: 't', filters: [] }));
    const preview = expectValue(
      await router.handle('transfer.previewImport', { connectionId, path: file, sampleRows: 5 }),
    ) as { sampleRows: unknown[] };
    expect(preview.sampleRows).toHaveLength(1);
    connect(connections);
    await cancelStarted(
      router.handle('transfer.startImport', importInput(connectionId, file)),
      router,
    );
  });

  it('keeps an import pick through a failed start, and uses it up once the start succeeds', async () => {
    const { router, connectionId, connections } = await setUp();
    const file = fixture('bulk.ndjson', '{"sku":"a1"}\n');
    picks.open = file;
    expectValue(await router.handle('app.showOpenDialog', { title: 't', filters: [] }));
    expectError(
      await router.handle('transfer.startImport', importInput(connectionId, file)),
      'NOT_CONNECTED',
    );
    expectError(
      await router.handle('transfer.startImport', importInput(connectionId, file)),
      'NOT_CONNECTED',
    );
    connect(connections);
    await cancelStarted(
      router.handle('transfer.startImport', importInput(connectionId, file)),
      router,
    );
    expectError(
      await router.handle('transfer.startImport', importInput(connectionId, file)),
      'VALIDATION',
    );
  });

  it('keeps an upload pick through a failed start, and uses it up once the start succeeds', async () => {
    const { router, connectionId, connections } = await setUp();
    const file = fixture('invoice.bin', 'bytes');
    picks.open = file;
    expectValue(await router.handle('app.showOpenDialog', { title: 't', filters: [] }));
    const upload = { connectionId, database: 'shop', bucket: 'receipts', path: file };
    expectError(await router.handle('gridfs.startUpload', upload), 'NOT_CONNECTED');
    connect(connections);
    await cancelStarted(router.handle('gridfs.startUpload', upload), router);
    expectError(await router.handle('gridfs.startUpload', upload), 'VALIDATION');
  });

  it('forgets every pick when the renderer resets', async () => {
    const { router, connectionId } = await setUp();
    picks.open = join(base, 'in.ndjson');
    picks.folder = join(base, 'out');
    picks.save = join(base, 'save.bin');
    expectValue(await router.handle('app.showOpenDialog', { title: 't', filters: [] }));
    expectValue(
      await router.handle('app.showOpenDialog', { title: 't', filters: [], directory: true }),
    );
    expectValue(await router.handle('app.showSaveDialog', { title: 't', filters: [] }));

    router.resetRenderer();

    expectError(
      await router.handle(
        'transfer.startImport',
        importInput(connectionId, join(base, 'in.ndjson')),
      ),
      'VALIDATION',
    );
    expectError(
      await router.handle(
        'gridfs.startDownload',
        downloadInput(connectionId, join(base, 'out', 'a.pdf')),
      ),
      'VALIDATION',
    );
    expectError(
      await router.handle(
        'gridfs.startDownload',
        downloadInput(connectionId, join(base, 'save.bin'), true),
      ),
      'VALIDATION',
    );
  });
});

describe('connection files', () => {
  let harness: Harness | undefined;
  let base = '';
  const picks: { open: string | undefined; save: string | undefined } = {
    open: undefined,
    save: undefined,
  };
  const PASSPHRASE = 'file passphrase';

  afterEach(() => {
    harness?.dispose();
    harness = undefined;
    if (base !== '') {
      rmSync(base, { recursive: true, force: true });
      base = '';
    }
  });

  async function setUp(): Promise<{ router: Router; localId: string; remoteId: string }> {
    base = mkdtempSync(join(tmpdir(), 'conn-files-'));
    harness = buildHarness(undefined, undefined, {
      showOpenDialog: async () => (picks.open === undefined ? {} : { path: picks.open }),
      showSaveDialog: async () => (picks.save === undefined ? {} : { path: picks.save }),
      showItemInFolder: () => undefined,
    });
    const { router } = harness;
    expectValue(await router.handle('vault.initialise', { password: PASSWORD }));
    const local = expectValue(await router.handle('connections.create', profileInput)) as {
      id: string;
    };
    const remote = expectValue(
      await router.handle('connections.create', {
        name: 'Remote',
        uri: 'mongodb://remote.example.com:27017',
      }),
    ) as { id: string };
    return { router, localId: local.id, remoteId: remote.id };
  }

  /** Saves the chosen connections through the save dialog and returns the written path. */
  async function exportTo(
    router: Router,
    profileIds: string[],
    passphrase = PASSPHRASE,
  ): Promise<string> {
    const path = join(base, 'connections.mgconn');
    picks.save = path;
    expectValue(await router.handle('app.showSaveDialog', { title: 't', filters: [] }));
    expectValue(await router.handle('connections.exportToFile', { profileIds, passphrase, path }));
    return path;
  }

  /** Picks a file in the open dialog, as the import flow does before preview. */
  async function pickOpen(router: Router, path: string): Promise<void> {
    picks.open = path;
    expectValue(await router.handle('app.showOpenDialog', { title: 't', filters: [] }));
  }

  it('exports only to a path the save dialog returned, and only once', async () => {
    const { router, localId } = await setUp();
    const path = join(base, 'connections.mgconn');
    expectError(
      await router.handle('connections.exportToFile', {
        profileIds: [localId],
        passphrase: PASSPHRASE,
        path,
      }),
      'VALIDATION',
    );

    const written = await exportTo(router, [localId]);
    expect(existsSync(written)).toBe(true);

    const again = expectError(
      await router.handle('connections.exportToFile', {
        profileIds: [localId],
        passphrase: PASSPHRASE,
        path: written,
      }),
      'VALIDATION',
    );
    expect(again.message).toBe('Choose the file with Save as first.');
  });

  it('never replaces an existing file the user did not pick', async () => {
    const { router, localId } = await setUp();
    const existing = join(base, 'keep.mgconn');
    writeFileSync(existing, 'keep me');
    picks.save = join(base, 'other.mgconn');
    expectValue(await router.handle('app.showSaveDialog', { title: 't', filters: [] }));

    expectError(
      await router.handle('connections.exportToFile', {
        profileIds: [localId],
        passphrase: PASSPHRASE,
        path: existing,
      }),
      'VALIDATION',
    );
    expect(readFileSync(existing, 'utf8')).toBe('keep me');
  });

  it('refuses a passphrase under ten characters without echoing it', async () => {
    const { router, localId } = await setUp();
    const path = join(base, 'short.mgconn');
    picks.save = path;
    expectValue(await router.handle('app.showSaveDialog', { title: 't', filters: [] }));

    const failed = expectError(
      await router.handle('connections.exportToFile', {
        profileIds: [localId],
        passphrase: 'tiny pass',
        path,
      }),
      'VALIDATION',
    );
    expect(failed.message).toBe('The input is invalid.');
    expect(JSON.stringify(failed)).not.toContain('tiny pass');
    expect(existsSync(path)).toBe(false);
  });

  it('previews a picked file without using up the pick, and never returns a secret', async () => {
    const { router, localId } = await setUp();
    const written = await exportTo(router, [localId]);
    await pickOpen(router, written);

    const first = expectValue(
      await router.handle('connections.previewImport', { path: written, passphrase: PASSPHRASE }),
    ) as { profiles: { name: string; host: string; authKind: string; collides: boolean }[] };
    const second = expectValue(
      await router.handle('connections.previewImport', { path: written, passphrase: PASSPHRASE }),
    );
    expect(second).toEqual(first);
    expect(first.profiles).toEqual([
      { name: 'Local', host: 'localhost:27017', authKind: 'password', collides: true },
    ]);
    expect(JSON.stringify(first)).not.toContain('hunter2');
  });

  it('refuses a preview of a file the open dialog did not return', async () => {
    const { router, localId } = await setUp();
    const written = await exportTo(router, [localId]);

    expectError(
      await router.handle('connections.previewImport', { path: written, passphrase: PASSPHRASE }),
      'VALIDATION',
    );
  });

  it('refuses a wrong passphrase with the damaged-file message, without echoing it', async () => {
    const { router, localId } = await setUp();
    const written = await exportTo(router, [localId]);
    await pickOpen(router, written);

    const failed = expectError(
      await router.handle('connections.previewImport', {
        path: written,
        passphrase: 'a wrong passphrase',
      }),
      'VALIDATION',
    );
    expect(failed.message).toBe('Wrong passphrase or damaged file.');
    expect(JSON.stringify(failed)).not.toContain('a wrong passphrase');
  });

  it('imports as copies, creates the connections and uses up the pick', async () => {
    const { router, localId } = await setUp();
    const written = await exportTo(router, [localId]);
    await pickOpen(router, written);

    const result = expectValue(
      await router.handle('connections.importFromFile', {
        path: written,
        passphrase: PASSPHRASE,
        mode: 'rename',
      }),
    );
    expect(result).toEqual({ imported: 1, skipped: 0, renamed: 1, replaced: 0 });
    const names = (
      expectValue(await router.handle('connections.list', undefined)) as {
        name: string;
      }[]
    ).map((item) => item.name);
    // Connections created in the same millisecond sort by id, so the order is compared sorted.
    expect([...names].sort()).toEqual(['Local', 'Local (2)', 'Remote']);

    expectError(
      await router.handle('connections.importFromFile', {
        path: written,
        passphrase: PASSPHRASE,
        mode: 'rename',
      }),
      'VALIDATION',
    );
  });

  it('keeps the pick after a failed passphrase so the import can be retried', async () => {
    const { router, localId } = await setUp();
    const written = await exportTo(router, [localId]);
    await pickOpen(router, written);

    expectError(
      await router.handle('connections.importFromFile', {
        path: written,
        passphrase: 'a wrong passphrase',
        mode: 'skip',
      }),
      'VALIDATION',
    );
    expect(
      expectValue(
        await router.handle('connections.importFromFile', {
          path: written,
          passphrase: PASSPHRASE,
          mode: 'skip',
        }),
      ),
    ).toEqual({ imported: 0, skipped: 1, renamed: 0, replaced: 0 });
  });

  it('replaces a colliding connection and clears the options the file leaves out', async () => {
    const { router, remoteId } = await setUp();
    const written = await exportTo(router, [remoteId]);
    await pickOpen(router, written);
    // Rename the source so the name is free again, then give the target the same name with TLS.
    expectValue(
      await router.handle('connections.update', { id: remoteId, patch: { name: 'Other' } }),
    );
    const target = expectValue(
      await router.handle('connections.create', {
        name: 'Remote',
        uri: 'mongodb://old.example.com:27017',
        tls: { enabled: true },
      }),
    ) as { id: string };

    const result = expectValue(
      await router.handle('connections.importFromFile', {
        path: written,
        passphrase: PASSPHRASE,
        mode: 'replace',
      }),
    );
    expect(result).toEqual({ imported: 0, skipped: 0, renamed: 0, replaced: 1 });
    const replaced = expectValue(
      await router.handle('connections.get', { id: target.id }),
    ) as ConnectionProfile;
    expect(replaced.uri).toBe('mongodb://remote.example.com:27017');
    expect(replaced.tls).toBeUndefined();
  });
});
