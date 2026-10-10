import type { z } from 'zod';
import {
  appError,
  describeConnectionUri,
  planConnectionsImport,
  type DockerMongoContainerSummary,
  type RpcCall,
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
  type ShellRuntimeState,
  type SettingsPatch,
  type UpdateState,
  type VaultStatus,
} from '@mongo-gui/core';
import type { MockReplicaSetInfo } from './mock-replication';
import {
  fixtureBuilds,
  fixtureCatalog,
  findDatabase,
  findMockCollection,
  type MockBuild,
  type MockCollection,
  type MockDatabase,
} from './mock-catalog';
import { createManagementCalls } from './mock-management';
import { createSecurityCalls, fixtureSecurity, type MockSecurity } from './mock-security';
import { createDiagnosticsCalls } from './mock-diagnostics';
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
import { createMockShell } from './mock-shell';
import { createMockPicks } from './mock-picks';
import { CONNECTIONS_EXTENSION, createMockConnectionFiles } from './mock-connection-files';
import { delay, fail, method } from './mock-support';
import { createMockMonitor } from './mock-monitor';
import {
  createMockTransfers,
  MOCK_DIALOG_PATH,
  mockImportPreview,
  mockSavePath,
} from './mock-transfer';
import { createMockProfiler } from './mock-profiler';
import { createMockChanges } from './mock-changes';
import { createMockGridFs, MOCK_FOLDER_PATH } from './mock-gridfs';
import { createShardingCalls, fixtureCluster, type MockCluster } from './mock-sharding';
import { createMockReplication } from './mock-replication';
import { createMockExplain } from './mock-explain';
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
  /** Replaces the shop profiler fixtures with this many generated rows. For performance checks. */
  readonly profilerRows?: number | undefined;
  /** `unavailable` makes every Docker call report that the engine cannot be reached. */
  readonly docker?: 'available' | 'unavailable';
  /** Scripted update states. Defaults to an idle updater on version 0.1.0. */
  readonly updates?: MockUpdatesOptions;
  /**
   * The local connection is a three-member replica set: a primary, a lagging secondary and an
   * arbiter. It also gets the replication section in monitor samples. Defaults to standalone.
   */
  readonly replication?: boolean;
  /** `viewer` signs in with no user or role rights, so the users and roles controls read disabled. */
  readonly security?: 'admin' | 'viewer';
  /** The file the mock open dialog returns. Defaults to the sample CSV. */
  readonly dialogPath?: string;
  /** `cluster` makes the local connection report a sharded topology with a seeded two-shard cluster. */
  readonly sharding?: 'cluster' | 'standalone';
  /** The local connection is a standalone started with --replSet and not yet initiated. */
  readonly replSetUninitiated?: boolean;
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
  /** Layout values by key. Stored as-is, like the encrypted store keeps them. */
  layout: Map<string, unknown>;
  /** Databases and collections per connection id. Mutated by the management calls. */
  catalogs: Map<string, MockDatabase[]>;
  builds: Map<string, MockBuild[]>;
  /** Users and custom roles per connection id. Created on first use. */
  security: Map<string, MockSecurity>;
  /** Sharded clusters per connection id, created on first use by the sharding calls. */
  clusters: Map<string, MockCluster>;
  dockerAvailable: boolean;
  dockerContainers: DockerMongoContainerSummary[];
  updateStates: readonly UpdateState[];
  updateIndex: number;
}

const DOCKER_UNREACHABLE_REASON = 'Docker is not reachable at /var/run/docker.sock (ENOENT).';
const DOCKER_ENGINE_VERSION = '29.8.2';
const MOCK_DOCKER_PASSWORD = 'secret';

const SERVER_VERSION = '8.0.4';

/** Version strings the mock reports for the About panel. */
const MOCK_VERSIONS = { app: '0.1.0', electron: '44.0.0', chrome: '152.0.0', node: '24.0.0' };
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
    layout: new Map(),
    catalogs: new Map(),
    builds: new Map(),
    security: new Map(),
    clusters: new Map(),
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
    statuses: new Map([[DOCKER_PROFILE_ID, connectedStatus('standalone', true)]]),
    history: fixtureHistory(),
    favourites: fixtureFavourites(),
    layout: new Map(),
  };
}

type ProfilePatch = { [K in keyof ConnectionProfileInput]?: ConnectionProfileInput[K] | undefined };

/** Applies only the fields the patch sets. Optional fields keep their current value. */
/** The patch that makes a stored connection match an imported one. Absent optional fields are cleared. */
function replacementPatch(input: ConnectionProfileInput): ProfilePatch {
  return {
    name: input.name,
    uri: input.uri,
    color: input.color,
    tls: input.tls,
    readPreference: input.readPreference,
    connectTimeoutMs: input.connectTimeoutMs,
    source: input.source,
    dockerContainerId: input.dockerContainerId,
  };
}

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
    treeDensity: patch.treeDensity ?? current.treeDensity,
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

function connectedStatus(
  topology: 'standalone' | 'sharded' = 'standalone',
  directConnection = false,
): ConnectionStatus {
  return {
    state: 'connected',
    serverVersion: SERVER_VERSION,
    topology,
    hosts: ['localhost:27017'],
    ...(directConnection ? { directConnection: true } : {}),
  };
}

/** The status a connection reports once connected. A replica set reports its name and members. */
function connectedStatusFor(info: MockReplicaSetInfo): ConnectionStatus {
  return {
    state: 'connected',
    serverVersion: SERVER_VERSION,
    topology: info.topology,
    hosts: [...info.hosts],
    ...(info.setName === undefined ? {} : { setName: info.setName }),
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

  const shell = createMockShell(emit, (connectionId) => catalogOf(connectionId));
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
  // The picks the mock dialogs register. The mock transfer calls check them as the router does.
  const picks = createMockPicks();
  const connectionFiles = createMockConnectionFiles();
  const dialogPath = options.dialogPath ?? MOCK_DIALOG_PATH;
  const transfers = createMockTransfers(
    emit,
    (database, collection) =>
      fixtureCatalog(localConnectionId)
        .find((item) => item.name === database)
        ?.collections.find((item) => item.info.name === collection)?.documents.length,
  );

  function statusOf(connectionId: string): ConnectionStatus {
    return state.statuses.get(connectionId) ?? { state: 'disconnected' };
  }

  function setStatus(connectionId: string, status: ConnectionStatus): void {
    state.statuses.set(connectionId, status);
    if (status.state !== 'connected') {
      monitor.stopConnection(connectionId);
      changes.stopConnection(connectionId);
      shell.clearConnection(connectionId);
    }
    emit({ type: 'connection:status', connectionId, status });
    // The runtime process follows the connection: it is ready when connected and stopped otherwise.
    if (status.state === 'connected') {
      emit({ type: 'shell:state', connectionId, state: 'ready' });
    } else if (status.state !== 'connecting') {
      emit({ type: 'shell:state', connectionId, state: 'stopped' });
    }
  }

  // Runs one shell call with the busy state around it, as the supervisor reports it.
  async function whileBusy<T>(connectionId: string, run: () => Promise<T>): Promise<T> {
    emit({ type: 'shell:state', connectionId, state: 'busy' });
    try {
      return await run();
    } finally {
      emit({ type: 'shell:state', connectionId, state: 'ready' });
    }
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

  function securityOf(connectionId: string): MockSecurity {
    const key = catalogSource(connectionId);
    let security = state.security.get(key);
    if (security === undefined) {
      security = fixtureSecurity();
      state.security.set(key, security);
    }
    return security;
  }

  const security = createSecurityCalls({
    latencyMs,
    guard,
    securityOf,
    viewer: options.security === 'viewer',
  });

  const diagnostics = createDiagnosticsCalls({
    latencyMs,
    guard,
    now: () => Date.now(),
    dbStats: (connectionId, database) => databaseStats(findDatabaseOrFail(connectionId, database)),
    collStats: (connectionId, database, collection) => {
      const found = requireCollectionFor(findDatabaseOrFail(connectionId, database), collection);
      if (found.info.type === 'view') {
        throw fail('COMMAND_FAILED', 'Views have no storage statistics', collection);
      }
      return collectionStats(database, found);
    },
  });

  const management = createManagementCalls({
    latencyMs,
    guard,
    catalogOf,
    buildsOf,
    emit,
    now: () => Date.now(),
  });

  // A cluster exists only while the connection reports a sharded topology.
  function clusterOf(connectionId: string): MockCluster | undefined {
    const status = statusOf(connectionId);
    if (status.state !== 'connected' || status.topology !== 'sharded') {
      return undefined;
    }
    let cluster = state.clusters.get(connectionId);
    if (cluster === undefined) {
      cluster = fixtureCluster();
      state.clusters.set(connectionId, cluster);
    }
    return cluster;
  }

  const sharding = createShardingCalls({
    latencyMs,
    guard,
    clusterOf,
    catalogOf,
    emit,
  });

  const gridfs = createMockGridFs({
    latencyMs,
    guard,
    picks,
    startTransfer: (kind, database, bucket, path, onDone) =>
      transfers.startGridFs(kind, database, bucket, path, onDone),
  });

  function wrapCall<I extends z.ZodType, O extends z.ZodType>(
    definition: RpcCall<I, O>,
    run: (input: z.output<I>) => z.output<O> | Promise<z.output<O>>,
  ): (raw: z.input<I>) => Promise<z.output<O>> {
    return method(definition, latencyMs, run);
  }

  const profiler = createMockProfiler({
    bulkRows: options.profilerRows,
    wrap: wrapCall,
    requireUnlocked,
    requireConnected,
    isAvailable: (connectionId) =>
      state.vault === 'unlocked' && statusOf(connectionId).state === 'connected',
    emit,
  });

  const explain = createMockExplain({ wrap: wrapCall, requireUnlocked, requireConnected });

  const changes = createMockChanges({
    latencyMs,
    requireUnlocked,
    requireConnected,
    catalogOf,
    emit,
  });

  const replication = createMockReplication({
    latencyMs,
    guard,
    onChange(connectionId) {
      if (statusOf(connectionId).state === 'connected') {
        setStatus(connectionId, connectedStatusOf(connectionId));
      }
    },
  });
  if (options.replication === true) {
    replication.setMode(localConnectionId, 'member');
  }

  // A replica set reports its own topology. Otherwise the local connection reports sharded when the
  // sharding option is on, and every other connection is standalone.
  function connectedStatusOf(connectionId: string): ConnectionStatus {
    const info = replication.infoFor(connectionId);
    if (info.topology !== 'standalone') {
      return connectedStatusFor(info);
    }
    if (connectionId === localConnectionId && options.sharding === 'cluster') {
      return connectedStatus('sharded');
    }
    return connectedStatusFor(info);
  }
  if (options.replSetUninitiated === true) {
    replication.setMode(localConnectionId, 'uninitiated');
  }

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
    layout: {
      get: method(rpcContract.layout.get, latencyMs, ({ key }) => {
        requireUnlocked();
        return { value: state.layout.get(key) ?? null };
      }),
      set: method(rpcContract.layout.set, latencyMs, ({ key, value }) => {
        requireUnlocked();
        state.layout.set(key, value);
      }),
    },
    app: {
      openExternal: method(rpcContract.app.openExternal, latencyMs, () => undefined),
      versions: method(rpcContract.app.versions, latencyMs, () => ({ ...MOCK_VERSIONS })),
      showOpenDialog: method(
        rpcContract.app.showOpenDialog,
        latencyMs,
        ({ directory, filters }) => {
          if (directory === true) {
            picks.folder(MOCK_FOLDER_PATH);
            return { path: MOCK_FOLDER_PATH };
          }
          // A connections dialog gets the file the last export wrote, so the import opens it.
          const connectionsDialog = filters.some((filter) =>
            filter.extensions.includes(CONNECTIONS_EXTENSION),
          );
          const last = connectionFiles.lastPath();
          const path = connectionsDialog && last !== undefined ? last : dialogPath;
          picks.opened(path);
          return { path };
        },
      ),
      showSaveDialog: method(rpcContract.app.showSaveDialog, latencyMs, ({ filters }) => {
        const path = mockSavePath(filters[0]?.extensions[0] ?? 'csv');
        picks.saved(path);
        return { path };
      }),
      showItemInFolder: method(rpcContract.app.showItemInFolder, latencyMs, ({ path }) => {
        if (!transfers.wroteFile(path)) {
          throw fail('VALIDATION', 'Only a file exported in this session can be shown.');
        }
      }),
      // The mock has no disk. The export is accepted and nothing is written.
      writeExport: method(rpcContract.app.writeExport, latencyMs, () => undefined),
    },
    transfer: {
      previewImport: method(rpcContract.transfer.previewImport, latencyMs, (input) => {
        requireUnlocked();
        findConnection(input.connectionId);
        // A preview reads sample rows, so only a file the open dialog returned is read.
        picks.requireOpened(input.path);
        return mockImportPreview();
      }),
      startImport: method(rpcContract.transfer.startImport, latencyMs, (input) => {
        requireUnlocked();
        requireConnected(input.connectionId);
        const { connectionId, ...request } = input;
        picks.requireOpened(request.path);
        const transferId = transfers.startImport(connectionId, request);
        picks.useOpened(request.path);
        return { transferId };
      }),
      startExport: method(rpcContract.transfer.startExport, latencyMs, (input) => {
        requireUnlocked();
        requireConnected(input.connectionId);
        const { connectionId, ...request } = input;
        return { transferId: transfers.startExport(connectionId, request) };
      }),
      cancel: method(rpcContract.transfer.cancel, latencyMs, ({ transferId }) => {
        requireUnlocked();
        transfers.cancel(transferId);
      }),
      status: method(rpcContract.transfer.status, latencyMs, ({ transferId }) => {
        requireUnlocked();
        const progress = transfers.status(transferId);
        if (progress === undefined) {
          throw fail('VALIDATION', 'The transfer was not found.');
        }
        return progress;
      }),
      list: method(rpcContract.transfer.list, latencyMs, () => {
        requireUnlocked();
        return transfers.list();
      }),
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
          changes.stopAll();
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
        state.layout.clear();
        state.catalogs.clear();
        state.builds.clear();
      }),
    },
    connections: {
      exportToFile: method(rpcContract.connections.exportToFile, latencyMs, (input) => {
        requireUnlocked();
        picks.requireSaved(input.path);
        const profiles = [...new Set(input.profileIds)].map((id) => findConnection(id));
        connectionFiles.save(input.path, input.passphrase, profiles);
        picks.consumeSaved(input.path);
      }),
      previewImport: method(rpcContract.connections.previewImport, latencyMs, (input) => {
        requireUnlocked();
        picks.requireOpened(input.path);
        const incoming = connectionFiles.read(input.path, input.passphrase);
        const names = new Set(state.connections.map((connection) => connection.name));
        return {
          profiles: incoming.map((profile) => ({
            name: profile.name,
            ...describeConnectionUri(profile.uri),
            collides: names.has(profile.name),
          })),
        };
      }),
      importFromFile: method(rpcContract.connections.importFromFile, latencyMs, (input) => {
        requireUnlocked();
        picks.requireOpened(input.path);
        const incoming = connectionFiles.read(input.path, input.passphrase);
        const result = { imported: 0, skipped: 0, renamed: 0, replaced: 0 };
        for (const action of planConnectionsImport(incoming, state.connections, input.mode)) {
          if (action.kind === 'skip') {
            result.skipped += 1;
          } else if (action.kind === 'create') {
            const now = new Date().toISOString();
            state.connections.push({
              ...action.input,
              id: newId(),
              createdAt: now,
              updatedAt: now,
            });
            result.imported += 1;
            result.renamed += action.renamed ? 1 : 0;
          } else {
            const current = findConnection(action.targetId);
            setStatus(action.targetId, { state: 'disconnected' });
            const next = applyPatch(
              current,
              replacementPatch(action.input),
              new Date().toISOString(),
            );
            state.connections = state.connections.map((item) =>
              item.id === action.targetId ? next : item,
            );
            result.replaced += 1;
          }
        }
        picks.useOpened(input.path);
        return result;
      }),
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
          ? connectedStatusOf(id)
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
    shell: {
      evaluate: method(rpcContract.shell.evaluate, latencyMs, (input) => {
        requireUnlocked();
        requireConnected(input.connectionId);
        return whileBusy(input.connectionId, () =>
          shell.evaluate({
            connectionId: input.connectionId,
            requestId: input.requestId ?? newId(),
            database: input.database,
            code: input.code,
            batchSize: input.batchSize,
          }),
        );
      }),
      next: method(rpcContract.shell.next, latencyMs, (input) => {
        requireUnlocked();
        requireConnected(input.connectionId);
        return whileBusy(input.connectionId, async () => shell.next(input));
      }),
      cancel: method(rpcContract.shell.cancel, latencyMs, ({ requestId }) => {
        requireUnlocked();
        shell.cancel(requestId);
      }),
      complete: method(rpcContract.shell.complete, latencyMs, (input) => {
        requireUnlocked();
        requireConnected(input.connectionId);
        return { items: shell.complete(input) };
      }),
      sampleSchema: method(rpcContract.shell.sampleSchema, latencyMs, (input) => {
        requireUnlocked();
        requireConnected(input.connectionId);
        return shell.sampleSchema(input);
      }),
      restart: method(rpcContract.shell.restart, latencyMs, ({ connectionId }) => {
        requireUnlocked();
        requireConnected(connectionId);
        shell.clearConnection(connectionId);
      }),
      state: method(rpcContract.shell.state, latencyMs, ({ connectionId }) => {
        requireUnlocked();
        const ready: ShellRuntimeState =
          statusOf(connectionId).state === 'connected' ? 'ready' : 'stopped';
        return { state: ready };
      }),
    },
    management,
    security,
    sharding,
    gridfs,
    diagnostics,
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
    schema: {
      analyse: method(rpcContract.schema.analyse, latencyMs, (input) => {
        requireUnlocked();
        requireConnected(input.connectionId);
        const found = findMockCollection(
          catalogOf(input.connectionId),
          input.database,
          input.collection,
        );
        if (found === undefined) {
          throw fail(
            'COMMAND_FAILED',
            'Collection not found',
            `${input.database}.${input.collection}`,
          );
        }
        const sample = shell.sampleSchema(input);
        return {
          database: input.database,
          collection: input.collection,
          sampled: sample.sampled,
          total: found.documents.length,
          fields: sample.fields,
          at: new Date().toISOString(),
        };
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
      append: method(rpcContract.history.append, latencyMs, (input) => {
        requireUnlocked();
        const entry: HistoryEntry = { ...input, id: newId() };
        state.history = [entry, ...state.history];
        return entry;
      }),
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
    profiler,
    changes,
    explain,
    replication: replication.rpc,
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
