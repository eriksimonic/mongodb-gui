import {
  appError,
  type DockerMongoContainerSummary,
  type DockerStatus,
  defaultSettings,
  newId,
  redactUri,
  rpcContract,
  type AppError,
  type CollectionInfo,
  type CollectionStats,
  type ConnectionProfile,
  type ConnectionProfileInput,
  type ConnectionProfileSummary,
  type ConnectionStatus,
  type ConnectionTestResult,
  type DatabaseInfo,
  type DatabaseStats,
  type Favourite,
  type HistoryEntry,
  type IndexInfo,
  type RpcClient,
  type RpcEvent,
  type Settings,
  type SettingsPatch,
  type UpdateState,
  type VaultStatus,
} from '@mongo-gui/core';
import {
  fixtureBuilds,
  fixtureCatalog,
  findDatabase,
  type MockBuild,
  type MockCollection,
  type MockDatabase,
} from './mock-catalog';
import { createManagementCalls } from './mock-management';
import {
  fixtureConnections,
  DOCKER_PROFILE_ID,
  fixtureDockerContainers,
  fixtureDockerProfile,
  fixtureFavourites,
  fixtureHistory,
  localConnectionId,
  mockMasterPassword,
} from './mock-fixtures';
import { delay, fail, method } from './mock-support';
import { createMockMonitor } from './mock-monitor';
import type { UiApi } from './ui-api';

export type MockPreset = 'fresh' | 'unlocked';

/**
 * A scripted sequence of update states. The first state is the starting state. Each check,
 * download or dismiss moves to the next state, and the last state then stays put.
 */
export interface MockUpdatesOptions {
  readonly states: readonly UpdateState[];
}

export interface MockUiApiOptions {
  /** `fresh` starts uninitialised with no connections. `unlocked` starts unlocked with fixtures. */
  readonly preset?: MockPreset;
  /** Delay added to every call, in milliseconds. Defaults to 0. */
  readonly latencyMs?: number;
  /** `unavailable` makes every Docker call report that the engine cannot be reached. */
  readonly docker?: 'available' | 'unavailable';
  /** Scripted update states. Defaults to an idle updater on version 0.1.0. */
  readonly updates?: MockUpdatesOptions;
  /** Adds replica set members and lag to the monitor samples. Defaults to standalone. */
  readonly replication?: boolean;
}

const DEFAULT_UPDATE_STATE: UpdateState = { phase: 'idle', current: '0.1.0', canInstall: true };

type VaultState = VaultStatus['state'];

interface MockState {
  vault: VaultState;
  password: string | undefined;
  connections: ConnectionProfile[];
  statuses: Map<string, ConnectionStatus>;
  settings: Settings;
  history: HistoryEntry[];
  favourites: Favourite[];
  /** Databases and collections per connection id. Mutated by the management calls. */
  catalogs: Map<string, MockDatabase[]>;
  builds: Map<string, MockBuild[]>;
  dockerAvailable: boolean;
  dockerContainers: DockerMongoContainerSummary[];
  updateStates: readonly UpdateState[];
  updateIndex: number;
}

const DOCKER_UNREACHABLE_REASON = 'Docker is not reachable at /var/run/docker.sock (ENOENT).';
const DOCKER_ENGINE_VERSION = '29.8.2';
const MOCK_DOCKER_PASSWORD = 'secret';

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
    catalogs: new Map(),
    builds: new Map(),
    dockerAvailable: true,
    dockerContainers: fixtureDockerContainers(),
    updateStates: [DEFAULT_UPDATE_STATE],
    updateIndex: 0,
  };
  if (preset === 'fresh') {
    return base;
  }
  const now = Date.now();
  const connections = fixtureConnections();
  for (const connection of connections) {
    base.catalogs.set(connection.id, fixtureCatalog(connection.id));
    base.builds.set(connection.id, fixtureBuilds(connection.id, now));
  }
  return {
    ...base,
    vault: 'unlocked',
    password: mockMasterPassword,
    connections: [...connections, fixtureDockerProfile()],
    statuses: new Map([[DOCKER_PROFILE_ID, connectedStatus()]]),
    history: fixtureHistory(),
    favourites: fixtureFavourites(),
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
    ...(current.source === undefined ? {} : { source: current.source }),
    ...(current.dockerContainerId === undefined
      ? {}
      : { dockerContainerId: current.dockerContainerId }),
  };
}

function mergeSettings(current: Settings, patch: SettingsPatch): Settings {
  return {
    theme: patch.theme ?? current.theme,
    idleLockMinutes: patch.idleLockMinutes ?? current.idleLockMinutes,
    historyLimit: patch.historyLimit ?? current.historyLimit,
    editorFontSize: patch.editorFontSize ?? current.editorFontSize,
    sampleSize: patch.sampleSize ?? current.sampleSize,
    dockerAutoConnect: patch.dockerAutoConnect ?? current.dockerAutoConnect,
    checkForUpdates: patch.checkForUpdates ?? current.checkForUpdates,
  };
}

/** The URI the mock builds for a container. Only localhost reaches the mock server. */
function mockContainerUri(container: DockerMongoContainerSummary): string {
  const auth = container.hasCredentials
    ? `${container.env.username ?? 'root'}:${MOCK_DOCKER_PASSWORD}@`
    : '';
  return `mongodb://${auth}localhost:27017/?directConnection=true`;
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

function databaseInfo(database: MockDatabase): DatabaseInfo {
  return {
    name: database.name,
    sizeOnDisk: database.sizeOnDisk,
    empty: database.collections.length === 0,
  };
}

function requireCollectionFor(
  database: MockDatabase | undefined,
  collection: string,
): MockCollection {
  const found = database?.collections.find((item) => item.info.name === collection);
  if (found === undefined) {
    throw fail('COMMAND_FAILED', 'Collection not found', collection);
  }
  return found;
}

function collectionStats(database: string, collection: MockCollection): CollectionStats {
  const name = collection.info.name;
  const count = collection.documents.length;
  const indexes = collection.indexes;
  const indexSizes = Object.fromEntries(indexes.map((index) => [index.name, index.size ?? 0]));
  const size = count * AVERAGE_OBJECT_SIZE;
  return {
    ns: `${database}.${name}`,
    count,
    size,
    storageSize: size + STORAGE_OVERHEAD,
    avgObjSize: count > 0 ? AVERAGE_OBJECT_SIZE : 0,
    nindexes: indexes.length,
    totalIndexSize: Object.values(indexSizes).reduce((sum, value) => sum + value, 0),
    capped: collection.info.options?.capped === true,
    indexSizes,
  };
}

function databaseStats(database: MockDatabase): DatabaseStats {
  const objects = database.collections.reduce((sum, item) => sum + item.documents.length, 0);
  const indexes: IndexInfo[] = database.collections.flatMap((item) => item.indexes);
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
  state.dockerAvailable = options.docker !== 'unavailable';
  const listeners = new Set<(event: RpcEvent) => void>();
  if (options.updates !== undefined && options.updates.states.length > 0) {
    state.updateStates = options.updates.states;
  }

  function emit(event: RpcEvent): void {
    for (const listener of listeners) {
      listener(event);
    }
  }

  function currentUpdate(): UpdateState {
    return state.updateStates[state.updateIndex] ?? DEFAULT_UPDATE_STATE;
  }

  /** Moves to the next scripted state and tells the listeners. */
  function advanceUpdate(): UpdateState {
    state.updateIndex = Math.min(state.updateIndex + 1, state.updateStates.length - 1);
    const next = currentUpdate();
    emit({ type: 'updates:state', state: next });
    return next;
  }
  const monitor = createMockMonitor({
    emit,
    hasReplication: () => options.replication === true,
  });

  function statusOf(connectionId: string): ConnectionStatus {
    return state.statuses.get(connectionId) ?? { state: 'disconnected' };
  }

  function setStatus(connectionId: string, status: ConnectionStatus): void {
    state.statuses.set(connectionId, status);
    if (status.state !== 'connected') {
      monitor.stopConnection(connectionId);
    }
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

  /** Docker profiles reuse the local fixture catalog, so their trees look like the other connections. */
  function catalogSource(connectionId: string): string {
    return state.connections.find((item) => item.id === connectionId)?.source === 'docker'
      ? localConnectionId
      : connectionId;
  }

  function requireDockerAvailable(): void {
    if (!state.dockerAvailable) {
      throw fail('INTERNAL', 'Docker is not reachable.', 'ENOENT');
    }
  }

  /** Each connection's catalog. A connection without fixtures starts with none. */
  function catalogOf(connectionId: string): MockDatabase[] {
    const key = catalogSource(connectionId);
    let catalog = state.catalogs.get(key);
    if (catalog === undefined) {
      catalog = [];
      state.catalogs.set(key, catalog);
    }
    return catalog;
  }

  function buildsOf(connectionId: string): MockBuild[] {
    const key = catalogSource(connectionId);
    let builds = state.builds.get(key);
    if (builds === undefined) {
      builds = [];
      state.builds.set(key, builds);
    }
    return builds;
  }

  function findDatabaseOrFail(connectionId: string, database: string): MockDatabase {
    const found = findDatabase(catalogOf(connectionId), database);
    if (found === undefined) {
      throw fail('COMMAND_FAILED', 'Database not found', database);
    }
    return found;
  }

  /** Mutating and reading management calls need an unlocked vault and a connected server. */
  function guard(connectionId: string): void {
    requireUnlocked();
    requireConnected(connectionId);
  }

  const management = createManagementCalls({
    latencyMs,
    guard,
    catalogOf,
    buildsOf,
    emit,
    now: () => Date.now(),
  });

  const rpc: RpcClient = {
    updates: {
      state: method(rpcContract.updates.state, latencyMs, () => currentUpdate()),
      check: method(rpcContract.updates.check, latencyMs, () => advanceUpdate()),
      download: method(rpcContract.updates.download, latencyMs, () => advanceUpdate()),
      install: method(rpcContract.updates.install, latencyMs, () => undefined),
      dismiss: method(rpcContract.updates.dismiss, latencyMs, ({ version }) => {
        const current = currentUpdate();
        if (current.available?.version !== version) {
          return current;
        }
        const next: UpdateState = {
          phase: 'idle',
          current: current.current,
          canInstall: current.canInstall,
          ...(current.lastCheckedAt === undefined ? {} : { lastCheckedAt: current.lastCheckedAt }),
        };
        state.updateStates = [next];
        state.updateIndex = 0;
        emit({ type: 'updates:state', state: next });
        return next;
      }),
    },
    app: {
      openExternal: method(rpcContract.app.openExternal, latencyMs, () => undefined),
    },
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
          monitor.stopAll();
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
        state.catalogs.clear();
        state.builds.clear();
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
        state.catalogs.delete(id);
        state.builds.delete(id);
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
        return catalogOf(connectionId).map(databaseInfo);
      }),
      stats: method(rpcContract.databases.stats, latencyMs, ({ connectionId, database }) => {
        requireUnlocked();
        requireConnected(connectionId);
        return databaseStats(findDatabaseOrFail(connectionId, database));
      }),
    },
    collections: {
      list: method(rpcContract.collections.list, latencyMs, ({ connectionId, database }) => {
        requireUnlocked();
        requireConnected(connectionId);
        const found = findDatabase(catalogOf(connectionId), database);
        return found?.collections.map((item): CollectionInfo => item.info) ?? [];
      }),
      stats: method(
        rpcContract.collections.stats,
        latencyMs,
        ({ connectionId, database, collection }) => {
          requireUnlocked();
          requireConnected(connectionId);
          const found = requireCollectionFor(
            findDatabaseOrFail(connectionId, database),
            collection,
          );
          if (found.info.type === 'view') {
            throw fail('COMMAND_FAILED', 'Views have no storage statistics', collection);
          }
          return collectionStats(database, found);
        },
      ),
      indexes: method(
        rpcContract.collections.indexes,
        latencyMs,
        ({ connectionId, database, collection }) => {
          requireUnlocked();
          requireConnected(connectionId);
          const found = requireCollectionFor(
            findDatabaseOrFail(connectionId, database),
            collection,
          );
          return found.indexes.map((index) => ({ ...index }));
        },
      ),
    },
    management,
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
    monitor: {
      start: method(rpcContract.monitor.start, latencyMs, ({ connectionId, intervalMs }) => {
        requireUnlocked();
        requireConnected(connectionId);
        return monitor.start(connectionId, intervalMs);
      }),
      stop: method(rpcContract.monitor.stop, latencyMs, ({ connectionId }) => {
        requireUnlocked();
        monitor.stop(connectionId);
      }),
      samples: method(rpcContract.monitor.samples, latencyMs, ({ connectionId, sinceIso }) => {
        requireUnlocked();
        return monitor.samples(connectionId, sinceIso);
      }),
      operations: method(
        rpcContract.monitor.operations,
        latencyMs,
        ({ connectionId, includeIdle, includeSystem }) => {
          requireUnlocked();
          requireConnected(connectionId);
          return monitor.operations(connectionId, {
            includeIdle: includeIdle === true,
            includeSystem: includeSystem === true,
          });
        },
      ),
      killOperation: method(
        rpcContract.monitor.killOperation,
        latencyMs,
        ({ connectionId, opid }) => {
          requireUnlocked();
          requireConnected(connectionId);
          monitor.killOperation(connectionId, opid);
        },
      ),
      setInterval: method(
        rpcContract.monitor.setInterval,
        latencyMs,
        ({ connectionId, intervalMs }) => {
          requireUnlocked();
          requireConnected(connectionId);
          return monitor.setInterval(connectionId, intervalMs);
        },
      ),
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
    docker: {
      status: method(rpcContract.docker.status, latencyMs, (): DockerStatus => {
        return state.dockerAvailable
          ? { available: true, engineVersion: DOCKER_ENGINE_VERSION }
          : { available: false, reason: DOCKER_UNREACHABLE_REASON };
      }),
      list: method(rpcContract.docker.list, latencyMs, () => {
        requireUnlocked();
        requireDockerAvailable();
        return state.dockerContainers.map((container) => ({ ...container }));
      }),
      connect: method(rpcContract.docker.connect, latencyMs, async ({ containerId }) => {
        requireUnlocked();
        requireDockerAvailable();
        const container = state.dockerContainers.find((item) => item.id === containerId);
        if (container === undefined) {
          throw fail('VALIDATION', 'The container was not found.');
        }
        const uri = mockContainerUri(container);
        const existing = state.connections.find((item) => item.dockerContainerId === containerId);
        const now = new Date().toISOString();
        const profile: ConnectionProfile =
          existing === undefined
            ? {
                id: newId(),
                name: container.name,
                uri,
                source: 'docker',
                dockerContainerId: containerId,
                createdAt: now,
                updatedAt: now,
              }
            : { ...existing, name: container.name, uri, updatedAt: now };
        state.connections =
          existing === undefined
            ? [...state.connections, profile]
            : state.connections.map((item) => (item.id === profile.id ? profile : item));
        const status = await rpc.connections.connect({ id: profile.id });
        return { connectionId: profile.id, status };
      }),
      disconnect: method(rpcContract.docker.disconnect, latencyMs, ({ containerId }) => {
        requireUnlocked();
        const profile = state.connections.find((item) => item.dockerContainerId === containerId);
        if (profile !== undefined) {
          setStatus(profile.id, { state: 'disconnected' });
        }
      }),
      setAutoConnect: method(rpcContract.docker.setAutoConnect, latencyMs, ({ enabled }) => {
        requireUnlocked();
        state.settings = { ...state.settings, dockerAutoConnect: enabled };
        return { ...state.settings };
      }),
      watch: method(rpcContract.docker.watch, latencyMs, () => {
        // The mock never changes, so polling has nothing to push.
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
