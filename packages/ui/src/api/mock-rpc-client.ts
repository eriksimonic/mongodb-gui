import {
  AppErrorException,
  appError,
  type AppError,
  defaultSettings,
  newId,
  redactUri,
  rpcContract,
  type AppErrorCode,
  type CollectionStats,
  type ConnectionProfile,
  type ConnectionProfileInput,
  type ConnectionProfileSummary,
  type ConnectionStatus,
  type ConnectionTestResult,
  type DatabaseStats,
  type Favourite,
  type HistoryEntry,
  type RpcCall,
  type RpcClient,
  type RpcEvent,
  type Settings,
  type SettingsPatch,
  type VaultStatus,
} from '@mongo-gui/core';
import type { z } from 'zod';
import {
  databaseInfos,
  fixtureConnections,
  fixtureDatabases,
  fixtureFavourites,
  fixtureHistory,
  fixtureIndexes,
  mockMasterPassword,
  type CollectionFixture,
  type DatabaseFixture,
} from './mock-fixtures';
import type { UiApi } from './ui-api';

export type MockPreset = 'fresh' | 'unlocked';

export interface MockUiApiOptions {
  /** `fresh` starts uninitialised with no connections. `unlocked` starts unlocked with fixtures. */
  readonly preset?: MockPreset;
  /** Delay added to every call, in milliseconds. Defaults to 0. */
  readonly latencyMs?: number;
}

type VaultState = VaultStatus['state'];

interface MockState {
  vault: VaultState;
  password: string | undefined;
  connections: ConnectionProfile[];
  statuses: Map<string, ConnectionStatus>;
  settings: Settings;
  history: HistoryEntry[];
  favourites: Favourite[];
}

const SERVER_VERSION = '8.0.4';
const AVERAGE_OBJECT_SIZE = 420;
const STORAGE_OVERHEAD = 4096;

function initialState(preset: MockPreset): MockState {
  const base: MockState = {
    vault: 'uninitialised',
    password: undefined,
    connections: [],
    statuses: new Map(),
    settings: { ...defaultSettings },
    history: [],
    favourites: [],
  };
  if (preset === 'fresh') {
    return base;
  }
  return {
    ...base,
    vault: 'unlocked',
    password: mockMasterPassword,
    connections: fixtureConnections(),
    history: fixtureHistory(),
    favourites: fixtureFavourites(),
  };
}

function fail(code: AppErrorCode, message: string, detail?: string): AppErrorException {
  return new AppErrorException(appError(code, message, detail));
}

function delay(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

/** Validates a value against a contract schema and maps failures to AppError codes. */
function parseWith<T>(schema: z.ZodType, value: unknown, code: AppErrorCode): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    const message = result.error.issues[0]?.message ?? 'Invalid input';
    throw fail(code, message);
  }
  return result.data as T;
}

/**
 * Wraps one contract call. Input is validated before the call runs, the output is validated
 * before it is returned, and every call waits for the configured latency first.
 */
function method<I extends z.ZodType, O extends z.ZodType>(
  definition: RpcCall<I, O>,
  latencyMs: number,
  run: (input: z.output<I>) => z.output<O> | Promise<z.output<O>>,
): (raw: z.input<I>) => Promise<z.output<O>> {
  return async (raw) => {
    const input = parseWith<z.output<I>>(definition.input, raw, 'VALIDATION');
    await delay(latencyMs);
    const output = await run(input);
    return parseWith<z.output<O>>(definition.output, output, 'INTERNAL');
  };
}

type ProfilePatch = { [K in keyof ConnectionProfileInput]?: ConnectionProfileInput[K] | undefined };

/** Applies only the fields the patch sets. Optional fields keep their current value. */
function applyPatch(
  current: ConnectionProfile,
  patch: ProfilePatch,
  updatedAt: string,
): ConnectionProfile {
  return {
    id: current.id,
    createdAt: current.createdAt,
    updatedAt,
    name: patch.name ?? current.name,
    uri: patch.uri ?? current.uri,
    color: 'color' in patch ? patch.color : current.color,
    tls: 'tls' in patch ? patch.tls : current.tls,
    readPreference: 'readPreference' in patch ? patch.readPreference : current.readPreference,
    connectTimeoutMs:
      'connectTimeoutMs' in patch ? patch.connectTimeoutMs : current.connectTimeoutMs,
  };
}

function mergeSettings(current: Settings, patch: SettingsPatch): Settings {
  return {
    theme: patch.theme ?? current.theme,
    idleLockMinutes: patch.idleLockMinutes ?? current.idleLockMinutes,
    historyLimit: patch.historyLimit ?? current.historyLimit,
    editorFontSize: patch.editorFontSize ?? current.editorFontSize,
    sampleSize: patch.sampleSize ?? current.sampleSize,
  };
}

function summarise(profile: ConnectionProfile): ConnectionProfileSummary {
  return { ...profile, uriRedacted: redactUri(profile.uri) };
}

function connectedStatus(): ConnectionStatus {
  return {
    state: 'connected',
    serverVersion: SERVER_VERSION,
    topology: 'standalone',
    hosts: ['localhost:27017'],
  };
}

function authError(): AppError {
  return appError('AUTH_FAILED', 'Authentication failed', 'Check the user name and password');
}

/** Only URIs that name localhost reach a server in the mock. Everything else fails auth. */
function isReachable(uri: string): boolean {
  return uri.includes('localhost');
}

function findCollection(
  databases: readonly DatabaseFixture[],
  database: string,
  collection: string,
): CollectionFixture {
  const found = databases
    .find((candidate) => candidate.name === database)
    ?.collections.find((candidate) => candidate.info.name === collection);
  if (found === undefined) {
    throw fail('COMMAND_FAILED', 'Collection not found', `${database}.${collection}`);
  }
  return found;
}

function collectionStats(database: string, fixture: CollectionFixture): CollectionStats {
  const name = fixture.info.name;
  const indexes = fixtureIndexes(name);
  const indexSizes = Object.fromEntries(indexes.map((index) => [index.name, index.size ?? 0]));
  const size = fixture.count * AVERAGE_OBJECT_SIZE;
  return {
    ns: `${database}.${name}`,
    count: fixture.count,
    size,
    storageSize: size + STORAGE_OVERHEAD,
    avgObjSize: fixture.count > 0 ? AVERAGE_OBJECT_SIZE : 0,
    nindexes: indexes.length,
    totalIndexSize: Object.values(indexSizes).reduce((sum, value) => sum + value, 0),
    capped: false,
    indexSizes,
  };
}

function databaseStats(database: DatabaseFixture): DatabaseStats {
  const objects = database.collections.reduce((sum, item) => sum + item.count, 0);
  const indexes = database.collections.flatMap((item) => fixtureIndexes(item.info.name));
  return {
    db: database.name,
    collections: database.collections.filter((item) => item.info.type !== 'view').length,
    views: database.collections.filter((item) => item.info.type === 'view').length,
    objects,
    dataSize: objects * AVERAGE_OBJECT_SIZE,
    storageSize: database.sizeOnDisk,
    indexes: indexes.length,
    indexSize: indexes.reduce((sum, index) => sum + (index.size ?? 0), 0),
  };
}

/**
 * In-memory backend with the same contract as the real router. Inputs and outputs are checked
 * against the core zod schemas, so the UI sees the same errors it would see from Electron.
 */
export function createMockUiApi(options: MockUiApiOptions = {}): UiApi {
  const latencyMs = options.latencyMs ?? 0;
  const state = initialState(options.preset ?? 'fresh');
  const listeners = new Set<(event: RpcEvent) => void>();

  function emit(event: RpcEvent): void {
    for (const listener of listeners) {
      listener(event);
    }
  }

  function statusOf(connectionId: string): ConnectionStatus {
    return state.statuses.get(connectionId) ?? { state: 'disconnected' };
  }

  function setStatus(connectionId: string, status: ConnectionStatus): void {
    state.statuses.set(connectionId, status);
    emit({ type: 'connection:status', connectionId, status });
  }

  function disconnectAll(): void {
    for (const connection of state.connections) {
      if (statusOf(connection.id).state !== 'disconnected') {
        setStatus(connection.id, { state: 'disconnected' });
      }
    }
  }

  function requireInitialised(): void {
    if (state.vault === 'uninitialised') {
      throw fail('VAULT_NOT_INITIALISED', 'Create a master password first');
    }
  }

  function requireUnlocked(): void {
    requireInitialised();
    if (state.vault === 'locked') {
      throw fail('VAULT_LOCKED', 'The vault is locked');
    }
  }

  function requireConnected(connectionId: string): void {
    if (statusOf(connectionId).state !== 'connected') {
      throw fail('NOT_CONNECTED', 'Connect to the server first');
    }
  }

  function findConnection(connectionId: string): ConnectionProfile {
    const found = state.connections.find((connection) => connection.id === connectionId);
    if (found === undefined) {
      throw fail('CONNECTION_NOT_FOUND', 'Connection not found', connectionId);
    }
    return found;
  }

  function findDatabase(connectionId: string, database: string): DatabaseFixture {
    const found = fixtureDatabases(connectionId).find((item) => item.name === database);
    if (found === undefined) {
      throw fail('COMMAND_FAILED', 'Database not found', database);
    }
    return found;
  }

  const rpc: RpcClient = {
    vault: {
      status: method(rpcContract.vault.status, latencyMs, () => ({ state: state.vault })),
      initialise: method(rpcContract.vault.initialise, latencyMs, ({ password }) => {
        if (state.vault !== 'uninitialised') {
          throw fail('VALIDATION', 'The vault already exists');
        }
        state.password = password;
        state.vault = 'unlocked';
      }),
      unlock: method(rpcContract.vault.unlock, latencyMs, ({ password }) => {
        requireInitialised();
        if (password !== state.password) {
          throw fail('VAULT_BAD_PASSWORD', 'Wrong master password');
        }
        state.vault = 'unlocked';
      }),
      lock: method(rpcContract.vault.lock, latencyMs, () => {
        requireInitialised();
        if (state.vault === 'unlocked') {
          state.vault = 'locked';
          disconnectAll();
          emit({ type: 'vault:locked' });
        }
      }),
      changePassword: method(rpcContract.vault.changePassword, latencyMs, ({ current, next }) => {
        requireUnlocked();
        if (current !== state.password) {
          throw fail('VAULT_BAD_PASSWORD', 'Wrong master password');
        }
        state.password = next;
      }),
      reset: method(rpcContract.vault.reset, latencyMs, () => {
        disconnectAll();
        state.vault = 'uninitialised';
        state.password = undefined;
        state.connections = [];
        state.statuses.clear();
        state.settings = { ...defaultSettings };
        state.history = [];
        state.favourites = [];
      }),
    },
    connections: {
      list: method(rpcContract.connections.list, latencyMs, () => {
        requireUnlocked();
        return state.connections.map(summarise);
      }),
      get: method(rpcContract.connections.get, latencyMs, ({ id }) => {
        requireUnlocked();
        return findConnection(id);
      }),
      create: method(rpcContract.connections.create, latencyMs, (input) => {
        requireUnlocked();
        const now = new Date().toISOString();
        const profile: ConnectionProfile = {
          ...input,
          id: newId(),
          createdAt: now,
          updatedAt: now,
        };
        state.connections.push(profile);
        return profile;
      }),
      update: method(rpcContract.connections.update, latencyMs, ({ id, patch }) => {
        requireUnlocked();
        const current = findConnection(id);
        const next = applyPatch(current, patch, new Date().toISOString());
        state.connections = state.connections.map((item) => (item.id === id ? next : item));
        return next;
      }),
      remove: method(rpcContract.connections.remove, latencyMs, ({ id }) => {
        requireUnlocked();
        findConnection(id);
        state.connections = state.connections.filter((item) => item.id !== id);
        state.statuses.delete(id);
      }),
      test: method(rpcContract.connections.test, latencyMs, (input): ConnectionTestResult => {
        requireUnlocked();
        if (!isReachable(input.uri)) {
          return { ok: false, error: authError() };
        }
        return { ok: true, serverVersion: SERVER_VERSION, topology: 'standalone' };
      }),
      connect: method(rpcContract.connections.connect, latencyMs, async ({ id }) => {
        requireUnlocked();
        const profile = findConnection(id);
        if (statusOf(id).state === 'connected') {
          return statusOf(id);
        }
        setStatus(id, { state: 'connecting' });
        await delay(latencyMs);
        const status: ConnectionStatus = isReachable(profile.uri)
          ? connectedStatus()
          : { state: 'error', error: authError() };
        setStatus(id, status);
        return status;
      }),
      disconnect: method(rpcContract.connections.disconnect, latencyMs, ({ id }) => {
        requireUnlocked();
        findConnection(id);
        setStatus(id, { state: 'disconnected' });
      }),
      status: method(rpcContract.connections.status, latencyMs, ({ id }) => {
        requireUnlocked();
        findConnection(id);
        return statusOf(id);
      }),
    },
    databases: {
      list: method(rpcContract.databases.list, latencyMs, ({ connectionId }) => {
        requireUnlocked();
        requireConnected(connectionId);
        return databaseInfos(connectionId);
      }),
      stats: method(rpcContract.databases.stats, latencyMs, ({ connectionId, database }) => {
        requireUnlocked();
        requireConnected(connectionId);
        return databaseStats(findDatabase(connectionId, database));
      }),
    },
    collections: {
      list: method(rpcContract.collections.list, latencyMs, ({ connectionId, database }) => {
        requireUnlocked();
        requireConnected(connectionId);
        const found = fixtureDatabases(connectionId).find((item) => item.name === database);
        return found?.collections.map((item) => item.info) ?? [];
      }),
      stats: method(
        rpcContract.collections.stats,
        latencyMs,
        ({ connectionId, database, collection }) => {
          requireUnlocked();
          requireConnected(connectionId);
          const fixture = findCollection(fixtureDatabases(connectionId), database, collection);
          if (fixture.info.type === 'view') {
            throw fail('COMMAND_FAILED', 'Views have no storage statistics', collection);
          }
          return collectionStats(database, fixture);
        },
      ),
      indexes: method(
        rpcContract.collections.indexes,
        latencyMs,
        ({ connectionId, database, collection }) => {
          requireUnlocked();
          requireConnected(connectionId);
          findCollection(fixtureDatabases(connectionId), database, collection);
          return fixtureIndexes(collection);
        },
      ),
    },
    settings: {
      get: method(rpcContract.settings.get, latencyMs, () => {
        requireUnlocked();
        return { ...state.settings };
      }),
      update: method(rpcContract.settings.update, latencyMs, (patch) => {
        requireUnlocked();
        state.settings = mergeSettings(state.settings, patch);
        return { ...state.settings };
      }),
    },
    history: {
      list: method(rpcContract.history.list, latencyMs, ({ connectionId, search, limit }) => {
        requireUnlocked();
        const needle = search?.toLowerCase();
        const rows = state.history
          .filter((entry) => connectionId === undefined || entry.connectionId === connectionId)
          .filter(
            (entry) =>
              needle === undefined ||
              entry.code.toLowerCase().includes(needle) ||
              entry.database.toLowerCase().includes(needle),
          )
          .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
        return limit === undefined ? rows : rows.slice(0, limit);
      }),
      clear: method(rpcContract.history.clear, latencyMs, () => {
        requireUnlocked();
        state.history = [];
      }),
    },
    favourites: {
      list: method(rpcContract.favourites.list, latencyMs, () => {
        requireUnlocked();
        return [...state.favourites];
      }),
      save: method(rpcContract.favourites.save, latencyMs, (input) => {
        requireUnlocked();
        const favourite: Favourite = { ...input, id: newId(), createdAt: new Date().toISOString() };
        state.favourites.push(favourite);
        return favourite;
      }),
      remove: method(rpcContract.favourites.remove, latencyMs, ({ id }) => {
        requireUnlocked();
        if (!state.favourites.some((item) => item.id === id)) {
          throw fail('VALIDATION', 'Favourite not found');
        }
        state.favourites = state.favourites.filter((item) => item.id !== id);
      }),
    },
  };

  return {
    rpc,
    onEvent(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
