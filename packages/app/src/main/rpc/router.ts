import { existsSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { exportTargetProblem, replaceFile } from './export-file';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  AppErrorException,
  CHANGE_EVENT_BATCH_LIMIT,
  CONNECTIONS_FILE_MAX_BYTES,
  ConnectionProfileSummarySchema,
  describeConnectionUri,
  planConnectionsImport,
  DEFAULT_BATCH_SIZE,
  appError,
  groupByShape,
  normaliseExplain,
  rewriteForExplain,
  redactUri,
  redactUriText,
  rpcContract,
  toAppError,
  type AppError,
  type CallInput,
  type AppVersions,
  type ChangeEvent,
  type ChangeTarget,
  type ChangeWatchOptions,
  type ChangeWatchPushState,
  type ChangeWatchState,
  type ConnectionProfile,
  type ConnectionProfileInput,
  type DialogResult,
  type LogLine,
  type ServerLog,
  type ServerParameter,
  capDiagnosticText,
  redactArgv,
  redactDiagnosticRecord,
  redactDiagnosticValue,
  redactRawLine,
  isSecretKey,
  type OpenDialogInput,
  type SaveDialogInput,
  type ExplainResult,
  type ExplainRunCommandInput,
  type ExplainRunInput,
  type ProfileCollectionInfo,
  type ProfileEntry,
  type ProfileFilter,
  type ProfilingLevel,
  type RpcCall,
  type RpcEvent,
  type RpcResult,
  type SchemaReport,
  type SetProfilingLevelInput,
  type TailProfileOptions,
  privilegeActionCatalog,
  type UpdateState,
  type UserInfo,
} from '@mongo-gui/core';
import {
  ConnectionManager,
  openChangeWatch,
  type ChangeWatch,
  explainableCommand,
  parseCommandEjson,
  runExplainCommand,
  wrapWriteCommand,
  checkDocumentsAgainstValidator,
  clearCollection,
  collectionStats,
  countDocuments,
  createCollection,
  createDatabase,
  createIndex,
  databaseStats,
  deleteByFilter,
  deleteDocuments,
  deleteFiles,
  dropBucket,
  dropCollection,
  estimatedDocumentCount,
  dropDatabase,
  dropIndex,
  findDocumentById,
  getFile,
  getValidation,
  insertDocument,
  getProfilingLevel,
  listBuckets,
  listCollections,
  listDatabases,
  listFiles,
  listIndexBuilds,
  listIndexes,
  getReplicaSetConfig,
  getReplicaSetStatus,
  getSelfHost,
  applyReconfig,
  freeze,
  initiate,
  listProfileEntries,
  mapDriverError,
  previewImport,
  planReconfig,
  renameCollection,
  renameFile,
  replaceDocument,
  sampleDocuments,
  setFileMetadata,
  setIndexHidden,
  setValidation,
  stepDown,
  updateDocumentFields,
  profileCollectionInfo,
  setProfilingLevel,
  tailProfileEntries,
  toCanonicalEjson,
  type ProfileTail,
  changePassword,
  connectionStatus,
  getBuildInfo,
  getCollStats,
  getCommandLineOptions,
  getConnPoolStats,
  getDbStats,
  getHostInfo,
  getParameters,
  getServerLog,
  getServerStatusTree,
  getTop,
  killAllSessionsByUser,
  killSessions,
  listSessions,
  serverStatusDocument,
  createRole,
  createUser,
  dropRole,
  dropUser,
  grantRoles,
  listRoles,
  listUsers,
  redactPassword,
  revokeRoles,
  updateRole,
  userManagementCapabilities,
  addShardToZone,
  clearBalancerWindow,
  describeShardCollection,
  enableSharding,
  getShardDistribution,
  getShardingOverview,
  moveChunk,
  removeShardFromZone,
  removeShardStatus,
  setBalancerWindow,
  shardCollection,
  startBalancer,
  stopBalancer,
  updateZoneKeyRange,
} from '@mongo-gui/mongo-adapter';
import {
  createDockerEngineClient,
  createForwarderManager,
  defaultDockerSocket,
} from '@mongo-gui/docker';
import {
  ConnectionsRepository,
  DEFAULT_KDF_PARAMS,
  EncryptedStore,
  FavouritesRepository,
  HistoryRepository,
  LayoutRepository,
  SettingsRepository,
  Vault,
  type KdfParams,
  type VaultOptions,
  exportConnections,
  importConnections,
} from '@mongo-gui/storage';
import { createDockerRuntime, type DockerRuntime } from '../docker/runtime';
import { log, type Logger } from '../log';
import { redactText } from '../redact';
import type { ForkFunction } from '../shell/child';
import { RuntimeSupervisor } from '../shell/supervisor';
import {
  createUpdater,
  noopUpdaterBackend,
  type Updater,
  type UpdaterBackend,
} from '../updates/updater';
import {
  createMonitorService,
  defaultSamplerFactory,
  type SamplerFactory,
} from './monitor-service';
import { createTransferService, type TransferAdapter } from './transfer-service';
import { createReplicationPlans } from './replication-plans';

/** Native file dialogs and the shell reveal. The main window's dialogs live in index.ts. */
export interface NativeDialogs {
  showOpenDialog(input: OpenDialogInput): Promise<DialogResult>;
  showSaveDialog(input: SaveDialogInput): Promise<DialogResult>;
  showItemInFolder(path: string): void;
}

/** The subset of ConnectionManager that the router uses. The real class satisfies it. */
export type ConnectionRegistry = Pick<
  ConnectionManager,
  'connect' | 'disconnect' | 'disconnectAll' | 'status' | 'getClient' | 'test' | 'onStatusChange'
>;

export interface RouterRepos {
  readonly connections: ConnectionsRepository;
  readonly history: HistoryRepository;
  readonly favourites: FavouritesRepository;
  readonly settings: SettingsRepository;
  readonly layout: LayoutRepository;
}

export interface StoreHandles {
  readonly store: EncryptedStore;
  readonly repos: RouterRepos;
}

/** Notifies listeners each time the vault changes from unlocked to locked. */
export interface LockEvents {
  subscribe(listener: () => void): () => void;
}

/** The subset of RuntimeSupervisor that the router uses. The real class satisfies it. */
export type ShellRegistry = Pick<
  RuntimeSupervisor,
  | 'evaluate'
  | 'next'
  | 'cancel'
  | 'complete'
  | 'sampleSchema'
  | 'restart'
  | 'state'
  | 'stop'
  | 'stopAll'
  | 'onEvent'
>;
/** The updater plus a subscription for its state changes. */
export interface UpdatesService extends Updater {
  subscribe(listener: (state: UpdateState) => void): () => void;
}

export interface RouterDeps {
  readonly vault: Vault;
  readonly store: EncryptedStore;
  readonly repos: RouterRepos;
  readonly connections: ConnectionRegistry;
  readonly onEvent: (event: RpcEvent) => void;
  /**
   * Opens a fresh store on the same path. Required for vault.reset, which deletes the
   * store file and then needs a usable store for the next initialise.
   */
  readonly reopenStore?: () => StoreHandles;
  /** When present, a lock disconnects every connection and emits vault:locked. */
  readonly lockEvents?: LockEvents;
  /** Builds the sampler for a connection. Defaults to the adapter Sampler. Tests inject a fake. */
  readonly createSampler?: SamplerFactory;
  /** Receives failures as method, code and message. Inputs and raw driver text stay out. */
  readonly log?: Logger;
  /** One runtime process per connection. Without it every shell call fails with INTERNAL. */
  readonly shell?: ShellRegistry;
  /** The profiler reads and writes. Defaults to the adapter functions; tests pass a fake. */
  readonly profiler?: ProfilerPort;
  /** Local Docker discovery and forwarders. Calls to the docker namespace fail without it. */
  readonly docker?: DockerRuntime;
  /** The in-app updater. Without it, the updates calls fail with INTERNAL. */
  readonly updates?: UpdatesService;
  /** Opens a link in the user's browser. The caller checks the link before it gets here. */
  readonly openExternal?: (url: string) => Promise<void>;
  /** Version strings for the About panel. Defaults to what process.versions reports. */
  readonly versions?: () => AppVersions;
  /** File dialogs for import and export. Calls to them fail with INTERNAL without it. */
  readonly dialogs?: NativeDialogs;
  /** The transfer functions. Tests inject a fake. Defaults to the adapter. */
  readonly transferAdapter?: TransferAdapter;
  /** Opens a change watch. Tests inject a fake watch. Defaults to the adapter. */
  readonly openWatch?: typeof openChangeWatch;
}

/** The driver client type, named without importing the driver into the main process. */
export type DriverClient = ReturnType<ConnectionRegistry['getClient']>;

/** The adapter's profiler functions, as the router calls them. */
export interface ProfilerPort {
  level(client: DriverClient, database: string): Promise<ProfilingLevel>;
  setLevel(
    client: DriverClient,
    database: string,
    input: SetProfilingLevelInput,
  ): Promise<ProfilingLevel>;
  list(client: DriverClient, database: string, filter: ProfileFilter): Promise<ProfileEntry[]>;
  info(client: DriverClient, database: string): Promise<ProfileCollectionInfo>;
  tail(client: DriverClient, database: string, options: TailProfileOptions): ProfileTail;
}

const adapterProfilerPort: ProfilerPort = {
  level: getProfilingLevel,
  setLevel: setProfilingLevel,
  list: listProfileEntries,
  info: profileCollectionInfo,
  tail: tailProfileEntries,
};

interface ActiveTail {
  readonly connectionId: string;
  readonly database: string;
  readonly tail: ProfileTail;
}

/** A change watch held by the router. `flush` sends the batch that is waiting to go out. */
interface ActiveChangeWatch {
  readonly connectionId: string;
  readonly watchId: string;
  readonly watch: ChangeWatch;
  readonly flush: () => void;
  /** Sends a 'resuming' phase before the watch resumes and reports 'live' itself. */
  resuming(): void;
}

/** A watch state with its error redacted, so no URI reaches the page. */
function sanitizedWatchState(state: ChangeWatchState): ChangeWatchState {
  const { error, ...rest } = state;
  return error === undefined ? rest : { ...rest, error: sanitize(error) };
}

/** The state the renderer sees. Errors are redacted, so no URI reaches the page. */
function pushStateOf(state: ChangeWatchState): ChangeWatchPushState {
  return {
    phase: state.phase,
    eventsSeen: state.eventsSeen,
    eventsDropped: state.eventsDropped,
    ...(state.error === undefined ? {} : { error: sanitize(state.error) }),
  };
}

export interface Router {
  handle(method: string, input: unknown): Promise<RpcResult>;
  /**
   * Drops every subscription held for the renderer: profiler tails now, and whatever services
   * register with onRendererReset later. Called when the page reloads, its process dies or the
   * window closes while the app stays alive.
   */
  resetRenderer(): void;
  /** Registers a cleanup that runs on resetRenderer. Returns the unregister function. */
  onRendererReset(listener: () => void): () => void;
}

/** What the updater needs from Electron. Omitted in tests, where the updater stays inert. */
export interface UpdatesRuntime {
  readonly autoUpdater: UpdaterBackend;
  readonly platform: string;
  readonly isPackaged: boolean;
  readonly appVersion: string;
}

export interface AppServicesOptions {
  readonly userDataDir: string;
  readonly kdf?: KdfParams;
  readonly failureDelayMs?: number;
  /**
   * How the shell runtime processes start. The app passes the built bundle and a utility process
   * fork. Without it the shell refuses to start.
   */
  readonly shell?: {
    readonly entryPath: string;
    readonly fork: ForkFunction;
  };
  /** Engine socket for docker support. Tests point it at a missing socket to stay off the host engine. */
  readonly dockerSocketPath?: string;
  readonly updates?: UpdatesRuntime;
}

export type AppServices = Omit<RouterDeps, 'onEvent' | 'docker' | 'updates'> & {
  readonly docker: DockerRuntime;
  readonly updates: UpdatesService;
  /** Fires after the vault unlocks. The main process restores the window bounds here. */
  readonly unlockEvents: LockEvents;
  /** The repositories of the open store. Repository calls throw VAULT_LOCKED while the vault is locked. */
  readonly currentRepos: () => RouterRepos;
  dispose(): Promise<void>;
};

interface Operation {
  readonly call: RpcCall;
  run(input: unknown): Promise<unknown>;
}

/** The client a connection holds. The router takes it from the registry for each call. */
type ClientOf = ReturnType<ConnectionRegistry['getClient']>;

/** Every management input names the connection it runs against. */
interface ConnectionScoped {
  readonly connectionId: string;
}

/** The part of the catalog a mutation touched. Sent with catalog:changed. */
type CatalogScope = Omit<Extract<RpcEvent, { type: 'catalog:changed' }>, 'type' | 'connectionId'>;

const KEYRING_DIR_MODE = 0o700;
const MS_PER_MINUTE = 60_000;
const STORE_FILE_NAME = 'store.sqlite';
// The server's default secondary catch-up period, in seconds.
const DEFAULT_CATCH_UP_SECONDS = 10;

export function createRouter(deps: RouterDeps): Router {
  let active: StoreHandles = { store: deps.store, repos: deps.repos };
  const repos = (): RouterRepos => active.repos;
  const profiler = deps.profiler ?? adapterProfilerPort;
  const replicationPlans = createReplicationPlans();
  // At most one tail per connection and database, keyed by both.
  const tails = new Map<string, ActiveTail>();
  // Per-renderer cleanups. Tails register first; other services join the same registry.
  const rendererResets = new Set<() => void>();
  // Change watches by connection, then by watch id. A watch ends with its connection or the page.
  const changeWatches = new Map<string, Map<string, ActiveChangeWatch>>();
  // Plans belong to the page that made them. A reset drops them, so a reloaded page cannot apply one.
  rendererResets.add(() => {
    replicationPlans.clear();
  });
  const profilerClient = (connectionId: string): DriverClient =>
    deps.connections.getClient(connectionId);

  /** Stops and forgets every tail that matches. */
  const stopTails = (matches: (active: ActiveTail) => boolean): void => {
    for (const [key, candidate] of [...tails]) {
      if (matches(candidate)) {
        candidate.tail.stop();
        tails.delete(key);
      }
    }
  };

  rendererResets.add(() => {
    stopTails(() => true);
  });
  rendererResets.add(() => {
    stopChangeWatches(() => true);
  });

  const startTail = (
    connectionId: string,
    database: string,
    pollMs: number,
    filter: ProfileFilter | undefined,
  ): void => {
    const client = profilerClient(connectionId);
    const options: TailProfileOptions = {
      since: new Date().toISOString(),
      pollMs,
      ...(filter === undefined ? {} : { filter }),
    };
    const tail = profiler.tail(client, database, options);
    tail.onEntries((entries) => {
      deps.onEvent({
        type: 'profiler:entries',
        connectionId,
        database,
        entries: entries.map(canonicalEntry),
      });
    });
    tail.onError((error) => {
      deps.onEvent({ type: 'profiler:error', connectionId, database, error });
    });
    tails.set(tailKey(connectionId, database), { connectionId, database, tail });
  };

  const stopTail = (connectionId: string, database: string): void => {
    stopTails((active) => active.connectionId === connectionId && active.database === database);
  };

  /** Stops the watches that match, and forgets them. Each watch closes in the background. */
  const stopChangeWatches = (matches: (active: ActiveChangeWatch) => boolean): void => {
    for (const [connectionId, watches] of [...changeWatches]) {
      for (const [watchId, active] of [...watches]) {
        if (matches(active)) {
          watches.delete(watchId);
          active.flush();
          void active.watch.close().catch(() => undefined);
        }
      }
      if (watches.size === 0) {
        changeWatches.delete(connectionId);
      }
    }
  };

  /** Opens a watch on the connection and returns its id. Events are batched into changes:event. */
  const startChangeWatch = (
    connectionId: string,
    target: ChangeTarget,
    options: ChangeWatchOptions,
  ): string => {
    const client = deps.connections.getClient(connectionId);
    const watchId = randomUUID();
    const pending: ChangeEvent[] = [];
    let flushTimer: ReturnType<typeof setImmediate> | undefined;
    const flush = (): void => {
      if (flushTimer !== undefined) {
        clearImmediate(flushTimer);
        flushTimer = undefined;
      }
      if (pending.length > 0) {
        const events = pending.splice(0, pending.length);
        deps.onEvent({ type: 'changes:event', watchId, events });
      }
    };
    const open = deps.openWatch ?? openChangeWatch;
    const watch = open(client, target, options, {
      onEvent(event) {
        pending.push(event);
        if (pending.length >= CHANGE_EVENT_BATCH_LIMIT) {
          flush();
        } else if (flushTimer === undefined) {
          flushTimer = setImmediate(flush);
        }
      },
      onState(state) {
        flush();
        deps.onEvent({ type: 'changes:state', watchId, state: pushStateOf(state) });
      },
    });
    const active: ActiveChangeWatch = {
      connectionId,
      watchId,
      watch,
      flush,
      resuming() {
        deps.onEvent({
          type: 'changes:state',
          watchId,
          state: { ...pushStateOf(watch.state()), phase: 'resuming' },
        });
      },
    };
    const watches = changeWatches.get(connectionId) ?? new Map<string, ActiveChangeWatch>();
    watches.set(watchId, active);
    changeWatches.set(connectionId, watches);
    return watchId;
  };

  const changeWatchOf = (watchId: string): ActiveChangeWatch => {
    for (const watches of changeWatches.values()) {
      const active = watches.get(watchId);
      if (active !== undefined) {
        return active;
      }
    }
    throw new AppErrorException(appError('NOT_FOUND', 'The change watch is not open.'));
  };

  const updatesService = (): UpdatesService => {
    if (deps.updates === undefined) {
      throw new AppErrorException(appError('INTERNAL', 'Updates are not available.'));
    }
    return deps.updates;
  };

  const appVersions = (): AppVersions => {
    if (deps.versions !== undefined) {
      return deps.versions();
    }
    return {
      app: '0.0.0',
      electron: process.versions['electron'] ?? 'not running in Electron',
      chrome: process.versions['chrome'] ?? 'unknown',
      node: process.versions.node,
    };
  };

  const resetVault = async (): Promise<void> => {
    if (deps.reopenStore === undefined) {
      throw new AppErrorException(appError('INTERNAL', 'The store cannot be reopened.'));
    }
    deps.vault.reset();
    await deps.connections.disconnectAll();
    await deps.docker?.cleanupAll();
    active.store.deleteFile();
    active = deps.reopenStore();
  };

  /**
   * A management call that changes the server. It runs against the connection's client and,
   * after success, tells the UI which database or collection changed.
   */
  function managed<C extends RpcCall>(
    method: string,
    call: C,
    run: (client: ClientOf, input: CallInput<C>) => Promise<unknown>,
    scope: (input: CallInput<C>) => CatalogScope,
  ): [string, Operation] {
    return entry(method, call, async (input) => {
      const { connectionId } = input as ConnectionScoped;
      const value = await driverCall(() => run(deps.connections.getClient(connectionId), input));
      deps.onEvent({ type: 'catalog:changed', connectionId, ...scope(input) });
      return value;
    });
  }

  /** A management call that only reads. It reports no change. */
  function readOnly<C extends RpcCall>(
    method: string,
    call: C,
    run: (client: ClientOf, input: CallInput<C>) => Promise<unknown>,
  ): [string, Operation] {
    return entry(method, call, (input) =>
      driverCall(() =>
        run(deps.connections.getClient((input as ConnectionScoped).connectionId), input),
      ),
    );
  }

  function managementOperations(): [string, Operation][] {
    const m = rpcContract.management;
    return [
      managed(
        'management.createCollection',
        m.createCollection,
        (client, input) => createCollection(client, input),
        (input) => ({ database: input.database, collection: input.name }),
      ),
      managed(
        'management.renameCollection',
        m.renameCollection,
        (client, input) => renameCollection(client, input),
        (input) => ({ database: input.database, collection: input.name }),
      ),
      managed(
        'management.dropCollection',
        m.dropCollection,
        (client, input) => dropCollection(client, input),
        (input) => ({ database: input.database, collection: input.name }),
      ),
      managed(
        'management.clearCollection',
        m.clearCollection,
        (client, input) => clearCollection(client, input),
        (input) => ({ database: input.database, collection: input.name }),
      ),
      managed(
        'management.createDatabase',
        m.createDatabase,
        (client, input) => createDatabase(client, input),
        (input) => ({ database: input.database }),
      ),
      managed(
        'management.dropDatabase',
        m.dropDatabase,
        (client, input) => dropDatabase(client, input),
        (input) => ({ database: input.database }),
      ),
      managed(
        'management.createIndex',
        m.createIndex,
        (client, input) => createIndex(client, input),
        (input) => ({ database: input.database, collection: input.collection }),
      ),
      managed(
        'management.dropIndex',
        m.dropIndex,
        (client, input) => dropIndex(client, input),
        (input) => ({ database: input.database, collection: input.collection }),
      ),
      managed(
        'management.setIndexHidden',
        m.setIndexHidden,
        (client, input) => setIndexHidden(client, input),
        (input) => ({ database: input.database, collection: input.collection }),
      ),
      readOnly('management.listIndexBuilds', m.listIndexBuilds, (client, input) =>
        listIndexBuilds(client, input.database),
      ),
      readOnly('management.getValidation', m.getValidation, (client, input) =>
        getValidation(client, input.database, input.collection),
      ),
      managed(
        'management.setValidation',
        m.setValidation,
        (client, input) => setValidation(client, input),
        (input) => ({ database: input.database, collection: input.collection }),
      ),
      readOnly('management.checkValidation', m.checkValidation, (client, input) =>
        checkDocumentsAgainstValidator(
          client,
          input.database,
          input.collection,
          input.sampleSize,
          input.validatorEjson,
        ),
      ),
      managed(
        'management.insertDocument',
        m.insertDocument,
        (client, input) => insertDocument(client, input),
        (input) => ({ database: input.database, collection: input.collection }),
      ),
      managed(
        'management.replaceDocument',
        m.replaceDocument,
        (client, input) => replaceDocument(client, input),
        (input) => ({ database: input.database, collection: input.collection }),
      ),
      managed(
        'management.updateDocumentFields',
        m.updateDocumentFields,
        (client, input) => updateDocumentFields(client, input),
        (input) => ({ database: input.database, collection: input.collection }),
      ),
      managed(
        'management.deleteDocuments',
        m.deleteDocuments,
        (client, input) => deleteDocuments(client, input),
        (input) => ({ database: input.database, collection: input.collection }),
      ),
      managed(
        'management.deleteByFilter',
        m.deleteByFilter,
        (client, input) => deleteByFilter(client, input),
        (input) => ({ database: input.database, collection: input.collection }),
      ),
      readOnly('management.countDocuments', m.countDocuments, (client, input) =>
        countDocuments(client, input),
      ),
      readOnly('management.findDocumentById', m.findDocumentById, (client, input) =>
        findDocumentById(client, input),
      ),
      readOnly('management.sampleDocuments', m.sampleDocuments, (client, input) =>
        sampleDocuments(client, input),
      ),
    ];
  }

  /**
   * A users and roles call. Passwords come in through the input and are masked in any error text
   * before the response leaves. Nothing else from the input reaches the response or the log.
   */
  function secured<C extends RpcCall>(
    method: string,
    call: C,
    run: (client: ClientOf, input: CallInput<C>) => Promise<unknown>,
    secretsOf: (input: CallInput<C>) => readonly string[] = () => [],
  ): [string, Operation] {
    return entry(method, call, (input) => {
      const { connectionId } = input as ConnectionScoped;
      return maskedCall(secretsOf(input), () =>
        driverCall(() => run(deps.connections.getClient(connectionId), input)),
      );
    });
  }

  /**
   * A sharding call that changes server settings but not the database or collection tree. It
   * reports no catalog change.
   */
  function serverOp<C extends RpcCall>(
    method: string,
    call: C,
    run: (client: ClientOf, input: CallInput<C>) => Promise<unknown>,
  ): [string, Operation] {
    return entry(method, call, (input) =>
      driverCall(() =>
        run(deps.connections.getClient((input as ConnectionScoped).connectionId), input),
      ),
    );
  }

  /**
   * Sharding calls. Each one runs against the connection's mongos. The adapter validates the
   * input and the server refuses what it must. Enabling sharding and sharding a collection
   * report a catalog change, so the tree refreshes.
   */
  function shardingOperations(): [string, Operation][] {
    const s = rpcContract.sharding;
    return [
      readOnly('sharding.overview', s.overview, (client) => getShardingOverview(client)),
      readOnly('sharding.collectionDistribution', s.collectionDistribution, (client, input) =>
        getShardDistribution(client, input.namespace),
      ),
      serverOp('sharding.setBalancer', s.setBalancer, (client, input) =>
        input.enabled ? startBalancer(client) : stopBalancer(client),
      ),
      serverOp('sharding.setBalancerWindow', s.setBalancerWindow, (client, input) =>
        setBalancerWindow(client, input),
      ),
      serverOp('sharding.clearBalancerWindow', s.clearBalancerWindow, (client) =>
        clearBalancerWindow(client),
      ),
      managed(
        'sharding.enableSharding',
        s.enableSharding,
        (client, input) => enableSharding(client, input),
        (input) => ({ database: input.database }),
      ),
      entry('sharding.shardCollection', s.shardCollection, (input) =>
        driverCall(async () => {
          const client = deps.connections.getClient(input.connectionId);
          const summary = await describeShardCollection(client, input);
          if (!input.confirmed) {
            return { applied: false, summary };
          }
          await shardCollection(client, input);
          deps.onEvent({
            type: 'catalog:changed',
            connectionId: input.connectionId,
            database: input.database,
            collection: input.collection,
          });
          return { applied: true, summary };
        }),
      ),
      serverOp('sharding.moveChunk', s.moveChunk, (client, input) => moveChunk(client, input)),
      serverOp('sharding.addShardToZone', s.addShardToZone, (client, input) =>
        addShardToZone(client, input),
      ),
      serverOp('sharding.removeShardFromZone', s.removeShardFromZone, (client, input) =>
        removeShardFromZone(client, input),
      ),
      serverOp('sharding.updateZoneKeyRange', s.updateZoneKeyRange, (client, input) =>
        updateZoneKeyRange(client, input),
      ),
      serverOp('sharding.removeShard', s.removeShard, (client, input) =>
        removeShardStatus(client, input),
      ),
    ];
  }

  function securityOperations(): [string, Operation][] {
    const s = rpcContract.security;
    return [
      secured('security.listUsers', s.listUsers, async (client, input) =>
        (await listUsers(client, input.database)).map(withEjsonCustomData),
      ),
      secured(
        'security.createUser',
        s.createUser,
        async (client, input) => withEjsonCustomData(await createUser(client, input)),
        (input) => (input.password === undefined ? [] : [input.password]),
      ),
      secured(
        'security.changePassword',
        s.changePassword,
        (client, input) => changePassword(client, input),
        (input) => [input.password],
      ),
      secured('security.grantRoles', s.grantRoles, (client, input) => grantRoles(client, input)),
      secured('security.revokeRoles', s.revokeRoles, (client, input) => revokeRoles(client, input)),
      secured('security.dropUser', s.dropUser, (client, input) => dropUser(client, input)),
      secured('security.listRoles', s.listRoles, (client, input) =>
        listRoles(client, input.database),
      ),
      secured('security.createRole', s.createRole, (client, input) => createRole(client, input)),
      secured('security.updateRole', s.updateRole, (client, input) => updateRole(client, input)),
      secured('security.dropRole', s.dropRole, (client, input) => dropRole(client, input)),
      secured('security.session', s.session, (client) => connectionStatus(client)),
      secured('security.capabilities', s.capabilities, (client, input) =>
        userManagementCapabilities(client, input.database),
      ),
      entry('security.privilegeActions', s.privilegeActions, () => privilegeActionCatalog()),
    ];
  }

  /**
   * Server logs, parameters, host and build facts, sessions and the other diagnostics. Secret fields
   * are masked and URIs redacted before a reply leaves. The kill calls report no catalog change.
   */
  function diagnosticsOperations(): [string, Operation][] {
    const d = rpcContract.diagnostics;
    return [
      readOnly('diagnostics.getLog', d.getLog, async (client, input) =>
        redactLog(await getServerLog(client, input.kind)),
      ),
      readOnly('diagnostics.cmdLineOpts', d.cmdLineOpts, async (client) => {
        const options = await getCommandLineOptions(client);
        return {
          argv: redactArgv(options.argv),
          parsed: toCanonicalEjson(redactDiagnosticValue(options.parsed)),
        };
      }),
      readOnly('diagnostics.parameters', d.parameters, async (client) =>
        (await getParameters(client)).map(redactParameter),
      ),
      readOnly('diagnostics.hostInfo', d.hostInfo, (client) => getHostInfo(client)),
      readOnly('diagnostics.buildInfo', d.buildInfo, (client) => getBuildInfo(client)),
      readOnly('diagnostics.serverStatus', d.serverStatus, async (client) => {
        const tree = await getServerStatusTree(client);
        return {
          at: tree.at,
          stripped: tree.stripped,
          document: redactDiagnosticRecord(serverStatusDocument(tree)),
        };
      }),
      readOnly('diagnostics.top', d.top, (client) => getTop(client)),
      readOnly('diagnostics.dbStats', d.dbStats, (client, input) =>
        getDbStats(client, input.database),
      ),
      readOnly('diagnostics.collStats', d.collStats, (client, input) =>
        getCollStats(client, input.database, input.collection),
      ),
      readOnly('diagnostics.connPoolStats', d.connPoolStats, (client) => getConnPoolStats(client)),
      readOnly('diagnostics.listSessions', d.listSessions, (client, input) =>
        listSessions(client, { allUsers: input.allUsers === true }),
      ),
      readOnly('diagnostics.killSessions', d.killSessions, (client, input) =>
        killSessions(client, input.ids),
      ),
      readOnly('diagnostics.killAllSessionsByUser', d.killAllSessionsByUser, (client, input) =>
        killAllSessionsByUser(client, input.users),
      ),
    ];
  }

  const docker = (): DockerRuntime => {
    if (deps.docker === undefined) {
      throw new AppErrorException(appError('INTERNAL', 'Docker support is not available.'));
    }
    return deps.docker;
  };

  /** Reads a profile without failing. A locked vault or a missing id gives undefined. */
  const profileById = (id: string): ConnectionProfile | undefined => {
    try {
      return repos()
        .connections.list()
        .find((profile) => profile.id === id);
    } catch {
      return undefined;
    }
  };

  /** Disconnects a connection, then frees the forwarder when the connection was a docker profile. */
  const disconnectConnection = async (
    connectionId: string,
    profile: ConnectionProfile | undefined,
  ): Promise<void> => {
    await deps.connections.disconnect(connectionId);
    await deps.docker?.releaseProfile(profile);
  };

  /** Frees the forwarder of a docker profile. Locked vault or unknown profile means nothing to do. */
  async function releaseDockerForwarder(connectionId: string): Promise<void> {
    const profile = profileById(connectionId);
    if (profile?.source === 'docker') {
      await deps.docker?.releaseProfile(profile);
    }
  }

  // Absolute paths the user picked this session. Cleared on a renderer reset.
  // Save paths: an export may replace only these, and a download may write only to these.
  const savePaths = new Set<string>();
  // Folders picked in a folder dialog: a download may write only directly inside these.
  const folderPicks = new Set<string>();
  // Files picked in an open dialog: an upload or an import reads only these, one use each.
  const openedFiles = new Set<string>();

  const dialogs = (): NativeDialogs => {
    if (deps.dialogs === undefined) {
      throw new AppErrorException(appError('INTERNAL', 'File dialogs are not available.'));
    }
    return deps.dialogs;
  };

  /** Checks that a connection profile exists. A locked vault reports VAULT_LOCKED from the store. */
  const requireConnectionProfile = (connectionId: string): void => {
    repos().connections.get(connectionId);
  };

  const operations = new Map<string, Operation>([
    entry('vault.status', rpcContract.vault.status, () => deps.vault.status()),
    entry('vault.initialise', rpcContract.vault.initialise, (input) => {
      deps.vault.initialise(input.password);
      applyStoredIdleLock();
      deps.updates?.refreshSchedule();
    }),
    entry('vault.unlock', rpcContract.vault.unlock, async (input) => {
      await deps.vault.unlock(input.password);
      applyStoredIdleLock();
      void deps.docker?.autoConnect();
      deps.docker?.resume();
      deps.updates?.refreshSchedule();
    }),
    entry('vault.lock', rpcContract.vault.lock, () => {
      deps.vault.lock();
    }),
    entry('vault.changePassword', rpcContract.vault.changePassword, async (input) => {
      await deps.vault.changePassword(input.current, input.next);
    }),
    entry('vault.reset', rpcContract.vault.reset, resetVault),

    entry('connections.list', rpcContract.connections.list, () =>
      repos()
        .connections.list()
        .map((profile) => toSummary(profile)),
    ),
    entry('connections.get', rpcContract.connections.get, (input) =>
      repos().connections.get(input.id),
    ),
    entry('connections.create', rpcContract.connections.create, (input) =>
      repos().connections.create(input),
    ),
    entry('connections.update', rpcContract.connections.update, (input) =>
      repos().connections.update(input.id, definedFields(input.patch)),
    ),
    entry('connections.remove', rpcContract.connections.remove, async (input) => {
      const profile = profileById(input.id);
      repos().connections.remove(input.id);
      await disconnectConnection(input.id, profile);
    }),
    entry('connections.test', rpcContract.connections.test, (input) =>
      deps.connections.test(input),
    ),
    entry('connections.connect', rpcContract.connections.connect, async (input) => {
      const profile = repos().connections.get(input.id);
      // A docker profile is rebuilt from its container, because its forwarder port changes.
      if (profile.source === 'docker' && profile.dockerContainerId !== undefined) {
        return (await docker().connect(profile.dockerContainerId)).status;
      }
      return deps.connections.connect(profile);
    }),
    entry('connections.disconnect', rpcContract.connections.disconnect, (input) =>
      disconnectConnection(input.id, profileById(input.id)),
    ),
    entry('connections.status', rpcContract.connections.status, (input) =>
      deps.connections.status(input.id),
    ),
    entry('connections.exportToFile', rpcContract.connections.exportToFile, (input) => {
      const path = resolveRequestPath(input.path);
      refuseUnpickedSave(path, savePaths);
      refuseMissingFolder(path);
      const problem = exportTargetProblem(path);
      if (problem !== undefined) {
        throw new AppErrorException(appError('VALIDATION', problem));
      }
      const profiles = [...new Set(input.profileIds)].map((id) => repos().connections.get(id));
      // The pick is good for one write. It is used up only after the file is in place.
      replaceFile(path, exportConnections(profiles, input.passphrase));
      savePaths.delete(path);
    }),
    entry('connections.previewImport', rpcContract.connections.previewImport, (input) => {
      const existing = repos().connections.list();
      // A preview reads the file, so it reads only a picked file. It does not use up the pick.
      const incoming = readConnectionsFile(pickedFile(input.path, openedFiles), input.passphrase);
      const names = new Set(existing.map((connection) => connection.name));
      return {
        profiles: incoming.map((profile) => ({
          name: profile.name,
          ...describeConnectionUri(profile.uri),
          collides: names.has(profile.name),
        })),
      };
    }),
    entry('connections.importFromFile', rpcContract.connections.importFromFile, async (input) => {
      const existing = repos().connections.list();
      const path = pickedFile(input.path, openedFiles);
      const incoming = readConnectionsFile(path, input.passphrase);
      const result = { imported: 0, skipped: 0, renamed: 0, replaced: 0 };
      for (const action of planConnectionsImport(incoming, existing, input.mode)) {
        if (action.kind === 'skip') {
          result.skipped += 1;
        } else if (action.kind === 'create') {
          repos().connections.create(action.input);
          result.imported += 1;
          result.renamed += action.renamed ? 1 : 0;
        } else {
          const current = existing.find((connection) => connection.id === action.targetId);
          await disconnectConnection(action.targetId, current);
          repos().connections.update(action.targetId, replacementPatch(action.input));
          result.replaced += 1;
        }
      }
      // The pick is good for one import. A failed import keeps it, so the passphrase can be retried.
      openedFiles.delete(path);
      return result;
    }),

    entry('databases.list', rpcContract.databases.list, (input) =>
      driverCall(() => listDatabases(deps.connections.getClient(input.connectionId))),
    ),
    entry('databases.stats', rpcContract.databases.stats, (input) =>
      driverCall(() =>
        databaseStats(deps.connections.getClient(input.connectionId), input.database),
      ),
    ),

    entry('collections.list', rpcContract.collections.list, (input) =>
      driverCall(() =>
        listCollections(deps.connections.getClient(input.connectionId), input.database),
      ),
    ),
    entry('collections.stats', rpcContract.collections.stats, (input) =>
      driverCall(() =>
        collectionStats(
          deps.connections.getClient(input.connectionId),
          input.database,
          input.collection,
        ),
      ),
    ),
    entry('collections.indexes', rpcContract.collections.indexes, (input) =>
      driverCall(() =>
        listIndexes(
          deps.connections.getClient(input.connectionId),
          input.database,
          input.collection,
        ),
      ),
    ),

    entry('shell.evaluate', rpcContract.shell.evaluate, (input) =>
      shellCall(input.connectionId, (shell) => shell.evaluate(input)),
    ),
    entry('shell.next', rpcContract.shell.next, (input) =>
      shellCall(input.connectionId, (shell) => shell.next(input)),
    ),
    entry('shell.cancel', rpcContract.shell.cancel, async (input) => {
      // Nothing runs on a connection that is not open, so cancel needs no connection check.
      await deps.shell?.cancel(input.connectionId, input.requestId);
    }),
    entry('shell.complete', rpcContract.shell.complete, (input) =>
      shellCall(input.connectionId, (shell) => shell.complete(input)),
    ),
    entry('shell.sampleSchema', rpcContract.shell.sampleSchema, (input) =>
      shellCall(input.connectionId, (shell) => shell.sampleSchema(input)),
    ),
    // The sample comes from the shell runtime. The total comes from the server's metadata.
    entry('schema.analyse', rpcContract.schema.analyse, async (input): Promise<SchemaReport> => {
      const sample = await shellCall(input.connectionId, (shell) =>
        shell.sampleSchema({
          connectionId: input.connectionId,
          database: input.database,
          collection: input.collection,
          size: input.size,
          strategy: input.strategy,
        }),
      );
      const total = await driverCall(() =>
        estimatedDocumentCount(
          deps.connections.getClient(input.connectionId),
          input.database,
          input.collection,
        ),
      );
      return {
        database: input.database,
        collection: input.collection,
        sampled: sample.sampled,
        total,
        fields: sample.fields,
        at: new Date().toISOString(),
      };
    }),
    entry('shell.restart', rpcContract.shell.restart, (input) =>
      shellCall(input.connectionId, (shell) => shell.restart(input.connectionId)),
    ),
    entry('shell.state', rpcContract.shell.state, (input) => ({
      state: deps.shell?.state(input.connectionId) ?? 'stopped',
    })),
    entry('explain.run', rpcContract.explain.run, (input) => explainStatement(input)),
    entry('explain.runCommand', rpcContract.explain.runCommand, (input) => explainCommand(input)),
    ...managementOperations(),
    ...securityOperations(),
    ...shardingOperations(),
    ...diagnosticsOperations(),

    entry('monitor.start', rpcContract.monitor.start, (input) =>
      monitor.start(input.connectionId, input.intervalMs),
    ),
    entry('monitor.stop', rpcContract.monitor.stop, (input) => {
      monitor.stop(input.connectionId);
    }),
    entry('monitor.samples', rpcContract.monitor.samples, (input) =>
      monitor.samples(input.connectionId, input.sinceIso),
    ),
    entry('monitor.operations', rpcContract.monitor.operations, (input) =>
      monitor.operations(input.connectionId, {
        includeIdle: input.includeIdle === true,
        includeSystem: input.includeSystem === true,
      }),
    ),
    entry('monitor.killOperation', rpcContract.monitor.killOperation, (input) =>
      monitor.killOperation(input.connectionId, input.opid),
    ),
    entry('monitor.setInterval', rpcContract.monitor.setInterval, (input) =>
      monitor.setInterval(input.connectionId, input.intervalMs),
    ),

    entry('replication.getStatus', rpcContract.replication.getStatus, (input) =>
      driverCall(() => getReplicaSetStatus(deps.connections.getClient(input.connectionId))),
    ),
    entry('replication.getConfig', rpcContract.replication.getConfig, (input) =>
      driverCall(() => getReplicaSetConfig(deps.connections.getClient(input.connectionId))),
    ),
    entry('replication.selfHost', rpcContract.replication.selfHost, (input) =>
      driverCall(async () => ({
        host: (await getSelfHost(deps.connections.getClient(input.connectionId))) ?? null,
      })),
    ),
    entry('replication.planReconfig', rpcContract.replication.planReconfig, (input) =>
      driverCall(async () => {
        const client = deps.connections.getClient(input.connectionId);
        const status = await getReplicaSetStatus(client);
        const config = await getReplicaSetConfig(client);
        const plan = planReconfig(config, input.change, status);
        return { planId: replicationPlans.store(input.connectionId, plan), plan };
      }),
    ),
    entry('replication.applyReconfig', rpcContract.replication.applyReconfig, (input) =>
      driverCall(async () => {
        const plan = replicationPlans.take(input.connectionId, input.planId, input.expectedVersion);
        await applyReconfig(deps.connections.getClient(input.connectionId), plan);
      }),
    ),
    entry('replication.stepDown', rpcContract.replication.stepDown, (input) =>
      driverCall(async () => ({
        // The server needs the step-down longer than the catch-up period. The UI's minimum leaves
        // room for the default 10 seconds of catch-up.
        primary: await stepDown(deps.connections.getClient(input.connectionId), {
          stepDownSeconds: input.stepDownSeconds,
          secondaryCatchUpSeconds: Math.min(DEFAULT_CATCH_UP_SECONDS, input.stepDownSeconds - 1),
        }),
      })),
    ),
    entry('replication.freeze', rpcContract.replication.freeze, (input) =>
      driverCall(() => freeze(deps.connections.getClient(input.connectionId), input.seconds)),
    ),
    entry('replication.initiate', rpcContract.replication.initiate, (input) =>
      driverCall(() =>
        initiate(deps.connections.getClient(input.connectionId), {
          setName: input.setName,
          members: input.members,
        }),
      ),
    ),
    entry('layout.get', rpcContract.layout.get, (input) => ({
      value: repos().layout.get(input.key) ?? null,
    })),
    entry('layout.set', rpcContract.layout.set, (input) => {
      repos().layout.set(input.key, input.value);
    }),

    entry('settings.get', rpcContract.settings.get, () => repos().settings.get()),
    entry('settings.update', rpcContract.settings.update, (input) => {
      // The timeout is applied before the value is stored, so a value the vault rejects is never saved.
      if (input.idleLockMinutes !== undefined) {
        applyIdleLock(input.idleLockMinutes);
      }
      const saved = repos().settings.update(input);
      if (input.checkForUpdates !== undefined) {
        deps.updates?.refreshSchedule();
      }
      return saved;
    }),

    entry('history.list', rpcContract.history.list, (input) => repos().history.list(input)),
    entry('history.append', rpcContract.history.append, (input) => repos().history.append(input)),
    entry('history.clear', rpcContract.history.clear, () => {
      repos().history.clear();
    }),

    entry('favourites.list', rpcContract.favourites.list, () => repos().favourites.list()),
    entry('favourites.save', rpcContract.favourites.save, (input) =>
      repos().favourites.save(input),
    ),
    entry('favourites.remove', rpcContract.favourites.remove, (input) => {
      repos().favourites.remove(input.id);
    }),

    entry('profiler.level', rpcContract.profiler.level, (input) =>
      driverCall(() => profiler.level(profilerClient(input.connectionId), input.database)),
    ),
    entry('profiler.setLevel', rpcContract.profiler.setLevel, (input) =>
      driverCall(() =>
        profiler.setLevel(profilerClient(input.connectionId), input.database, {
          level: input.level,
          ...(input.slowMs === undefined ? {} : { slowMs: input.slowMs }),
          ...(input.sampleRate === undefined ? {} : { sampleRate: input.sampleRate }),
        }),
      ),
    ),
    entry('profiler.list', rpcContract.profiler.list, (input) =>
      driverCall(async () =>
        (await profiler.list(profilerClient(input.connectionId), input.database, input.filter)).map(
          canonicalEntry,
        ),
      ),
    ),
    entry('profiler.shapes', rpcContract.profiler.shapes, (input) =>
      driverCall(async () => {
        const entries = await profiler.list(
          profilerClient(input.connectionId),
          input.database,
          input.filter,
        );
        return groupByShape(entries.map(canonicalEntry));
      }),
    ),
    entry('profiler.info', rpcContract.profiler.info, (input) =>
      driverCall(() => profiler.info(profilerClient(input.connectionId), input.database)),
    ),
    entry('profiler.tail', rpcContract.profiler.tail, (input) => {
      stopTail(input.connectionId, input.database);
      if (input.enabled) {
        startTail(input.connectionId, input.database, input.pollMs, input.filter);
      }
    }),
    entry('changes.start', rpcContract.changes.start, (input) =>
      driverCall(async () => ({
        watchId: startChangeWatch(input.connectionId, input.target, input.options),
      })),
    ),
    entry('changes.pause', rpcContract.changes.pause, (input) => {
      changeWatchOf(input.watchId).watch.pause();
    }),
    entry('changes.resume', rpcContract.changes.resume, (input) => {
      const active = changeWatchOf(input.watchId);
      // The watch reports 'live' from inside resume, once its buffered events are delivered.
      active.resuming();
      active.watch.resume();
    }),
    entry('changes.stop', rpcContract.changes.stop, async (input) => {
      const active = changeWatchOf(input.watchId);
      const watches = changeWatches.get(active.connectionId);
      watches?.delete(input.watchId);
      if (watches?.size === 0) {
        changeWatches.delete(active.connectionId);
      }
      active.flush();
      await active.watch.close();
    }),
    entry('changes.state', rpcContract.changes.state, (input) =>
      sanitizedWatchState(changeWatchOf(input.watchId).watch.state()),
    ),
    entry('docker.status', rpcContract.docker.status, () => docker().status()),
    entry('docker.list', rpcContract.docker.list, () => docker().list()),
    entry('docker.connect', rpcContract.docker.connect, (input) =>
      docker().connect(input.containerId),
    ),
    entry('docker.disconnect', rpcContract.docker.disconnect, (input) =>
      docker().disconnect(input.containerId),
    ),
    entry('docker.setAutoConnect', rpcContract.docker.setAutoConnect, (input) =>
      docker().setAutoConnect(input.enabled),
    ),
    entry('docker.watch', rpcContract.docker.watch, (input) => {
      docker().watch(input.enabled, deps.onEvent);
    }),
    entry('transfer.previewImport', rpcContract.transfer.previewImport, async (input) => {
      const { connectionId, ...request } = input;
      requireConnectionProfile(connectionId);
      // A preview reads sample rows, so it reads only a picked file. It does not use up the pick.
      return previewImport({ ...request, path: pickedFile(request.path, openedFiles) });
    }),
    entry('transfer.startImport', rpcContract.transfer.startImport, (input) => {
      const { connectionId, ...request } = input;
      requireConnectionProfile(connectionId);
      const path = pickedFile(request.path, openedFiles);
      const transferId = transfers.startImport(connectionId, { ...request, path });
      // Used up only once the transfer has started, so a failed start leaves the pick usable.
      openedFiles.delete(path);
      return { transferId };
    }),
    entry('transfer.startExport', rpcContract.transfer.startExport, (input) => {
      const { connectionId, ...request } = input;
      requireConnectionProfile(connectionId);
      const path = resolveRequestPath(request.path);
      refuseMissingFolder(path);
      refuseUnpickedFile(path, savePaths);
      return { transferId: transfers.startExport(connectionId, { ...request, path }) };
    }),
    entry('transfer.cancel', rpcContract.transfer.cancel, (input) => {
      transfers.cancel(input.transferId);
    }),
    entry('transfer.status', rpcContract.transfer.status, (input) =>
      transfers.status(input.transferId),
    ),
    entry('transfer.list', rpcContract.transfer.list, () => transfers.list()),

    entry('gridfs.listBuckets', rpcContract.gridfs.listBuckets, (input) =>
      driverCall(() => listBuckets(deps.connections.getClient(input.connectionId), input)),
    ),
    entry('gridfs.listFiles', rpcContract.gridfs.listFiles, (input) =>
      driverCall(() => listFiles(deps.connections.getClient(input.connectionId), input)),
    ),
    entry('gridfs.getFile', rpcContract.gridfs.getFile, (input) =>
      driverCall(() => getFile(deps.connections.getClient(input.connectionId), input)),
    ),
    entry('gridfs.startUpload', rpcContract.gridfs.startUpload, (input) => {
      const { connectionId, ...request } = input;
      requireConnectionProfile(connectionId);
      const path = pickedFile(request.path, openedFiles);
      const transferId = transfers.startGridFsUpload(connectionId, { ...request, path });
      // Used up only once the transfer has started, so a failed start leaves the pick usable.
      openedFiles.delete(path);
      return { transferId };
    }),
    entry('gridfs.startDownload', rpcContract.gridfs.startDownload, (input) => {
      const { connectionId, ...request } = input;
      requireConnectionProfile(connectionId);
      const path = resolveRequestPath(request.path);
      refuseUnpickedDownload(path, savePaths, folderPicks);
      if (request.overwrite !== true) {
        // Checked before the transfer starts, so the caller gets the refusal as the call's error.
        refuseExistingFile(path);
      }
      return { transferId: transfers.startGridFsDownload(connectionId, { ...request, path }) };
    }),
    entry('gridfs.deleteFiles', rpcContract.gridfs.deleteFiles, (input) =>
      driverCall(() => deleteFiles(deps.connections.getClient(input.connectionId), input)),
    ),
    entry('gridfs.renameFile', rpcContract.gridfs.renameFile, (input) =>
      driverCall(() => renameFile(deps.connections.getClient(input.connectionId), input)),
    ),
    entry('gridfs.setMetadata', rpcContract.gridfs.setMetadata, (input) =>
      driverCall(() => setFileMetadata(deps.connections.getClient(input.connectionId), input)),
    ),
    entry('gridfs.dropBucket', rpcContract.gridfs.dropBucket, (input) =>
      driverCall(() =>
        dropBucket(deps.connections.getClient(input.connectionId), input.database, input.bucket),
      ),
    ),
    entry('updates.state', rpcContract.updates.state, () => updatesService().state()),
    entry('updates.check', rpcContract.updates.check, () => updatesService().check()),
    entry('updates.download', rpcContract.updates.download, () => updatesService().download()),
    entry('updates.install', rpcContract.updates.install, () => {
      updatesService().install();
    }),
    entry('updates.dismiss', rpcContract.updates.dismiss, (input) =>
      updatesService().dismiss(input.version),
    ),

    entry('app.openExternal', rpcContract.app.openExternal, async (input) => {
      if (deps.openExternal === undefined) {
        throw new AppErrorException(appError('INTERNAL', 'Links cannot be opened.'));
      }
      await deps.openExternal(new URL(input.url).href);
    }),
    entry('app.versions', rpcContract.app.versions, () => appVersions()),
    entry('app.showOpenDialog', rpcContract.app.showOpenDialog, async (input) => {
      const picked = await dialogs().showOpenDialog(input);
      if (picked.path !== undefined) {
        if (input.directory === true) {
          // The real location is recorded at pick time, so a later symlink change cannot widen it.
          folderPicks.add(realFolder(picked.path) ?? resolve(picked.path));
        } else {
          openedFiles.add(resolve(picked.path));
        }
      }
      return picked;
    }),
    entry('app.showSaveDialog', rpcContract.app.showSaveDialog, async (input) => {
      const picked = await dialogs().showSaveDialog(input);
      if (picked.path !== undefined) {
        savePaths.add(resolve(picked.path));
      }
      return picked;
    }),
    entry('app.writeExport', rpcContract.app.writeExport, (input) => {
      // Only a path the user picked in this session is written, so the renderer cannot pick one.
      if (!savePaths.has(input.path)) {
        throw new AppErrorException(appError('VALIDATION', 'Choose the file with Save as first.'));
      }
      // The pick is good for one write. A refused write needs a new pick.
      savePaths.delete(input.path);
      const problem = exportTargetProblem(input.path);
      if (problem !== undefined) {
        throw new AppErrorException(appError('VALIDATION', problem));
      }
      replaceFile(input.path, input.content);
    }),
    entry('app.showItemInFolder', rpcContract.app.showItemInFolder, (input) => {
      // Only a file this session exported is revealed, so the renderer cannot open arbitrary paths.
      if (!transfers.wroteFile(input.path)) {
        throw new AppErrorException(
          appError('VALIDATION', 'Only a file exported in this session can be shown.'),
        );
      }
      dialogs().showItemInFolder(input.path);
    }),
  ]);

  const transfers = createTransferService({
    ...(deps.transferAdapter === undefined ? {} : { adapter: deps.transferAdapter }),
    getClient: (connectionId) => deps.connections.getClient(connectionId),
    emit: deps.onEvent,
  });

  const monitor = createMonitorService({
    getClient: (connectionId) => deps.connections.getClient(connectionId),
    createSampler: deps.createSampler ?? defaultSamplerFactory,
    emit: deps.onEvent,
  });

  // A reload or a closed window must not leave samplers running for a page that is gone.
  rendererResets.add(() => {
    monitor.stopAll();
  });
  // Transfers belong to the page that started them, so a reload or a closed window ends them.
  rendererResets.add(() => {
    transfers.cancelAll();
  });

  // A reload or a closed window ends the runtime processes too. The next page starts them again.
  rendererResets.add(() => {
    void deps.shell?.stopAll();
  });

  deps.connections.onStatusChange((connectionId, status) => {
    if (status.state !== 'connected') {
      stopTails((active) => active.connectionId === connectionId);
      stopChangeWatches((active) => active.connectionId === connectionId);
    }
    deps.onEvent({ type: 'connection:status', connectionId, status });
    // A transfer reads or writes through the client of its connection, so it ends with the connection.
    if (status.state !== 'connected') {
      transfers.cancelConnection(connectionId);
    }
    // A runtime serves only an open connection, so any other state ends its process.
    if (status.state !== 'connected') {
      void deps.shell?.stop(connectionId);
    }
    // A docker connection that errors (for example, the socket closed) gives its forwarder back.
    // A disconnect is not handled here, because a superseded attempt also reports disconnected
    // while the next attempt may be using the same forwarder.
    if (status.state === 'error') {
      void releaseDockerForwarder(connectionId);
    }
    // A sampler holds the client it started with, so any drop ends monitoring for that connection.
    if (status.state !== 'connected') {
      monitor.stop(connectionId);
    }
  });
  deps.lockEvents?.subscribe(() => {
    stopTails(() => true);
    stopChangeWatches(() => true);
    monitor.stopAll();
    transfers.cancelAll();
    void deps.connections.disconnectAll();
    void deps.shell?.stopAll();
    deps.docker?.suspend();
    void deps.docker?.cleanupAll();
    deps.updates?.refreshSchedule();
    deps.onEvent({ type: 'vault:locked' });
  });
  deps.shell?.onEvent((event) => {
    deps.onEvent(event);
  });
  deps.updates?.subscribe((state) => {
    deps.onEvent({ type: 'updates:state', state });
  });

  return {
    resetRenderer() {
      savePaths.clear();
      folderPicks.clear();
      openedFiles.clear();
      for (const listener of [...rendererResets]) {
        try {
          listener();
        } catch (error) {
          deps.log?.error('renderer reset failed', {
            error: toAppError(error).message,
          });
        }
      }
    },
    onRendererReset(listener) {
      rendererResets.add(listener);
      return () => {
        rendererResets.delete(listener);
      };
    },
    async handle(method, input) {
      const op = operations.get(method);
      if (op === undefined) {
        return failure(appError('VALIDATION', 'The method is not known.', method));
      }
      try {
        const parsedInput = op.call.input.safeParse(input);
        if (!parsedInput.success) {
          return failure(appError('VALIDATION', 'The input is invalid.', method));
        }
        const value = await op.run(parsedInput.data);
        const parsedOutput = op.call.output.safeParse(value);
        if (!parsedOutput.success) {
          return failure(appError('INTERNAL', 'The handler returned an unexpected value.', method));
        }
        // Browsing keeps the vault unlocked. A locked vault ignores the touch.
        deps.vault.touch();
        return { ok: true, value: parsedOutput.data };
      } catch (error) {
        return failure(describeFailure(method, error));
      }
    },
  };

  /**
   * Explains the single collection query in a statement. The rewritten statement runs on the
   * connection's runtime, and the server returns the plan without running the query.
   */
  async function explainStatement(input: ExplainRunInput): Promise<ExplainResult> {
    const rewrite = rewriteForExplain(input.code, input.verbosity);
    if (!rewrite.ok) {
      throw new AppErrorException(appError('VALIDATION', rewrite.message));
    }
    const requestId = randomUUID();
    const evaluation = await shellCall(input.connectionId, (shell) =>
      shell.evaluate({
        connectionId: input.connectionId,
        requestId,
        database: input.database,
        code: rewrite.code,
        batchSize: DEFAULT_BATCH_SIZE,
      }),
    );
    if (evaluation.error !== undefined) {
      throw new AppErrorException(evaluation.error);
    }
    if (evaluation.result === undefined) {
      throw new AppErrorException(appError('INTERNAL', 'The explain returned no result.'));
    }
    return explainResult(requestId, evaluation.result.printableEjson, evaluation.elapsedMs);
  }

  /** Explains a captured command, such as a profiler entry, through the connection's driver. */
  async function explainCommand(input: ExplainRunCommandInput): Promise<ExplainResult> {
    if (deps.connections.status(input.connectionId).state !== 'connected') {
      throw new AppErrorException(appError('NOT_CONNECTED', 'Connect to the server first.'));
    }
    const parsed = parseCommandEjson(input.commandEjson);
    const command =
      parsed !== undefined && input.profileOp !== undefined && input.collection !== undefined
        ? wrapWriteCommand(parsed, input.profileOp, input.collection)
        : parsed;
    if (command === undefined || explainableCommand(command) === undefined) {
      throw new AppErrorException(appError('VALIDATION', 'This command cannot be explained.'));
    }
    const result = await driverCall(() =>
      runExplainCommand(deps.connections.getClient(input.connectionId), {
        database: input.database,
        command,
        verbosity: input.verbosity,
      }),
    );
    if (result === undefined) {
      throw new AppErrorException(appError('VALIDATION', 'This command cannot be explained.'));
    }
    return explainResult(randomUUID(), JSON.stringify(result.raw), result.elapsedMs);
  }

  /**
   * Runs a shell call for an open connection. A connection that is not open is refused before
   * any runtime process starts.
   */
  async function shellCall<T>(
    connectionId: string,
    action: (shell: ShellRegistry) => Promise<T>,
  ): Promise<T> {
    const shell = deps.shell;
    if (shell === undefined) {
      throw new AppErrorException(appError('INTERNAL', 'The shell is not available.'));
    }
    if (deps.connections.status(connectionId).state !== 'connected') {
      throw new AppErrorException(appError('NOT_CONNECTED', 'Connect to the server first.'));
    }
    return action(shell);
  }

  /** Pushes an idle timeout (in minutes) from settings into the vault. */
  function applyIdleLock(minutes: number): void {
    deps.vault.setIdleLockMs(minutes * MS_PER_MINUTE);
  }

  /**
   * Applies the stored timeout after unlock or setup. A stored value the router cannot apply
   * must not turn a successful unlock into an error, so the default stays and the failure is logged.
   */
  function applyStoredIdleLock(): void {
    try {
      applyIdleLock(repos().settings.get().idleLockMinutes);
    } catch (error) {
      const mapped = toAppError(error);
      deps.log?.warn('stored idle lock not applied, keeping the default', {
        code: mapped.code,
        error: mapped.message,
      });
    }
  }

  /**
   * Maps a thrown error to the response. Known AppErrors keep their code. Repository calls
   * report VAULT_LOCKED whether the vault is locked or was never set up, so a missing keyring
   * gets the setup message. Anything else becomes INTERNAL with a fixed message, and the raw
   * text goes to the log only.
   */
  function describeFailure(method: string, error: unknown): AppError {
    if (error instanceof AppErrorException) {
      const known = sanitize(error.error);
      const response =
        known.code === 'VAULT_LOCKED' && deps.vault.status().state === 'uninitialised'
          ? appError('VAULT_NOT_INITIALISED', 'The vault has not been set up yet.')
          : known;
      deps.log?.warn('rpc call failed', { method, code: response.code, error: response.message });
      return response;
    }
    const raw = toAppError(error);
    deps.log?.error('rpc call failed unexpectedly', {
      method,
      code: 'INTERNAL',
      error: raw.message,
    });
    return appError('INTERNAL', 'Unexpected error');
  }
}

/**
 * Opens the vault, the encrypted store and the connection manager under userDataDir.
 * The returned services plug into createRouter with an onEvent callback.
 */
export function createAppServices(options: AppServicesOptions): AppServices {
  mkdirSync(options.userDataDir, { recursive: true, mode: KEYRING_DIR_MODE });
  const lockListeners = new Set<() => void>();
  const unlockListeners = new Set<() => void>();
  const vaultOptions: VaultOptions = {
    dir: options.userDataDir,
    kdf: options.kdf ?? DEFAULT_KDF_PARAMS,
    ...(options.failureDelayMs === undefined ? {} : { failureDelayMs: options.failureDelayMs }),
    onLocked: () => {
      for (const listener of [...lockListeners]) {
        listener();
      }
    },
    onUnlocked: () => {
      for (const listener of [...unlockListeners]) {
        listener();
      }
    },
  };
  const vault = new Vault(vaultOptions);
  const storePath = join(options.userDataDir, STORE_FILE_NAME);
  const openStore = (): StoreHandles => {
    const store = new EncryptedStore({ path: storePath, vault });
    return { store, repos: createRepos(store) };
  };
  let handles = openStore();
  const connections = new ConnectionManager();
  const shell = new RuntimeSupervisor({
    entryPath: options.shell?.entryPath ?? '',
    fork: options.shell?.fork ?? refuseFork,
    profileOf: (connectionId) => handles.repos.connections.get(connectionId),
    isConnected: (connectionId) => connections.status(connectionId).state === 'connected',
  });
  const socketPath = options.dockerSocketPath ?? defaultDockerSocket(process.env, process.platform);
  const engine = createDockerEngineClient({ socketPath });
  const docker = createDockerRuntime({
    engine,
    socketPath,
    forwarders: createForwarderManager({ client: engine }),
    connections,
    repos: () => handles.repos,
    isUnlocked: () => vault.status().state === 'unlocked',
    log,
  });
  const updates = createUpdatesService(options.updates, () => handles);

  return {
    vault,
    store: handles.store,
    repos: handles.repos,
    connections,
    shell,
    docker,
    log,
    reopenStore: () => {
      handles = openStore();
      return handles;
    },
    // The store is reopened on vault reset, so callers read the repos through this function.
    currentRepos: () => handles.repos,
    lockEvents: {
      subscribe(listener) {
        lockListeners.add(listener);
        return () => {
          lockListeners.delete(listener);
        };
      },
    },
    unlockEvents: {
      subscribe(listener) {
        unlockListeners.add(listener);
        return () => {
          unlockListeners.delete(listener);
        };
      },
    },
    updates,
    async dispose() {
      shell.dispose();
      updates.stop();
      await connections.disconnectAll();
      await docker.dispose();
      handles.store.close();
    },
  };
}

/**
 * Builds the updater. The saved setting is encrypted, so it reads as undefined while the
 * vault is locked, and the updater waits for the next refreshSchedule call.
 */
function createUpdatesService(
  runtime: UpdatesRuntime | undefined,
  currentHandles: () => StoreHandles,
): UpdatesService {
  const listeners = new Set<(state: UpdateState) => void>();
  const updater = createUpdater({
    log,
    settings: {
      readCheckForUpdates: () => {
        try {
          return currentHandles().repos.settings.get().checkForUpdates;
        } catch {
          return undefined;
        }
      },
    },
    onState: (state) => {
      for (const listener of [...listeners]) {
        listener(state);
      }
    },
    autoUpdater: runtime?.autoUpdater ?? noopUpdaterBackend,
    platform: runtime?.platform ?? process.platform,
    isPackaged: runtime?.isPackaged ?? false,
    appVersion: runtime?.appVersion ?? '0.0.0',
  });
  return {
    ...updater,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export function createRepos(store: EncryptedStore): RouterRepos {
  const settings = new SettingsRepository(store);
  return {
    connections: new ConnectionsRepository(store),
    history: new HistoryRepository(store, settings),
    favourites: new FavouritesRepository(store),
    settings,
    layout: new LayoutRepository(store),
  };
}

const refuseFork: ForkFunction = () => {
  throw new Error('no shell runtime is configured');
};
function tailKey(connectionId: string, database: string): string {
  return `${connectionId}\u0000${database}`;
}

/**
 * Profile entries carry BSON values in command, locks, storage and raw. They are sent in
 * canonical extended JSON, so the renderer gets plain data with $oid and $date markers.
 */
/** The text the log viewer shows: secrets masked, URIs redacted, attributes in canonical EJSON. */
function redactLog(log: ServerLog): ServerLog {
  return { ...log, lines: log.lines.map(redactLogLine) };
}

function redactLogLine(line: LogLine): LogLine {
  const { attributes, ...rest } = line;
  return {
    ...rest,
    message: redactUriText(line.message),
    raw: redactRawLine(line.raw),
    ...(attributes === undefined
      ? {}
      : { attributes: toCanonicalEjson(redactDiagnosticValue(attributes)) }),
  };
}

const PARAMETER_MASK = '***';

/**
 * A parameter with secrets masked. Strings and object or array values are redacted recursively,
 * and a structured value longer than the cap is cut short with truncated set.
 */
function redactParameter(parameter: ServerParameter): ServerParameter {
  if (isSecretKey(parameter.name)) {
    return {
      name: parameter.name,
      value: PARAMETER_MASK,
      valueEjson: JSON.stringify(PARAMETER_MASK),
    };
  }
  if (parameter.value !== undefined) {
    if (typeof parameter.value !== 'string') {
      return parameter;
    }
    const value = redactUriText(parameter.value);
    return { name: parameter.name, value, valueEjson: JSON.stringify(value) };
  }
  // An object or array has no scalar value. Its canonical text is redacted as a parsed document.
  let redacted: unknown;
  try {
    redacted = redactDiagnosticValue(JSON.parse(parameter.valueEjson) as unknown);
  } catch {
    const text = capDiagnosticText(redactUriText(parameter.valueEjson));
    return {
      name: parameter.name,
      value: text.text,
      valueEjson: text.text,
      truncated: text.truncated,
    };
  }
  const text = capDiagnosticText(JSON.stringify(redacted));
  if (text.truncated) {
    return { name: parameter.name, value: text.text, valueEjson: text.text, truncated: true };
  }
  return { name: parameter.name, value: redacted, valueEjson: text.text };
}

function canonicalEntry(entry: ProfileEntry): ProfileEntry {
  return {
    ...entry,
    raw: toCanonicalEjson(entry.raw),
    ...(entry.command === undefined ? {} : { command: toCanonicalEjson(entry.command) }),
    ...(entry.locks === undefined ? {} : { locks: toCanonicalEjson(entry.locks) }),
    ...(entry.storage === undefined ? {} : { storage: toCanonicalEjson(entry.storage) }),
  };
}

/**
 * Builds the explain result from a server explain document. The text is canonical EJSON, which
 * the normaliser reads. The raw text is pretty printed for the raw tab.
 */
function explainResult(requestId: string, printable: string, elapsedMs: number): ExplainResult {
  let raw: unknown;
  try {
    raw = JSON.parse(printable);
  } catch {
    throw new AppErrorException(appError('INTERNAL', 'The explain output is not JSON.'));
  }
  return {
    requestId,
    tree: normaliseExplain(raw),
    rawEjson: JSON.stringify(raw, null, 2),
    // Whole milliseconds, so the header and the result do not show sub-millisecond noise.
    elapsedMs: Math.round(elapsedMs),
  };
}

function entry<C extends RpcCall>(
  method: string,
  call: C,
  run: (input: CallInput<C>) => unknown,
): [string, Operation] {
  return [
    method,
    {
      call,
      // The router parses the input with this call's schema before it calls run.
      run: async (input) => run(input as CallInput<C>),
    },
  ];
}

/** Runs a driver call. Driver failures become AppErrors. AppErrors pass through unchanged. */
async function driverCall<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof AppErrorException) {
      throw error;
    }
    throw new AppErrorException(mapDriverError(error));
  }
}

/**
 * Drops keys whose value is undefined. Zod's partial output marks absent keys as optional
 * with an explicit undefined type, which exactOptionalPropertyTypes rejects in the repository.
 */
function definedFields(
  patch: Partial<Record<keyof ConnectionProfileInput, unknown>>,
): Partial<ConnectionProfileInput> {
  const entries = Object.entries(patch).filter(([, value]) => value !== undefined);
  return Object.fromEntries(entries) as Partial<ConnectionProfileInput>;
}

function toSummary(profile: ConnectionProfile): unknown {
  return ConnectionProfileSummarySchema.parse({
    ...profile,
    uriRedacted: redactUri(profile.uri),
  });
}

/** Refuses an export whose folder is missing, before any file is created. */
function refuseMissingFolder(path: string): void {
  const folder = dirname(path);
  if (!isDirectory(folder)) {
    throw new AppErrorException(appError('VALIDATION', 'The folder does not exist.', folder));
  }
}

/**
 * A connections export writes only to a path the save dialog returned this session. The path must
 * already be a pick, so an existing file is replaced only when the user picked it.
 */
function refuseUnpickedSave(path: string, picked: ReadonlySet<string>): void {
  if (!picked.has(path)) {
    throw new AppErrorException(appError('VALIDATION', 'Choose the file with Save as first.'));
  }
}

/** Reads and decrypts a connections file the open dialog returned. The size is checked before the read. */
function readConnectionsFile(path: string, passphrase: string): ConnectionProfile[] {
  let bytes: Buffer;
  try {
    if (statSync(path).size > CONNECTIONS_FILE_MAX_BYTES) {
      throw new AppErrorException(
        appError('VALIDATION', 'The file is too large to be a connections file.'),
      );
    }
    bytes = readFileSync(path);
  } catch (error) {
    if (error instanceof AppErrorException) {
      throw error;
    }
    throw new AppErrorException(appError('VALIDATION', 'The file could not be read.'));
  }
  return importConnections(bytes, passphrase);
}

/**
 * The patch that makes a stored connection match an imported one. Each optional field the file
 * leaves out is set to undefined, so the store drops it and the old value does not survive.
 */
function replacementPatch(input: ConnectionProfileInput): Partial<ConnectionProfileInput> {
  return {
    name: input.name,
    uri: input.uri,
    color: input.color,
    tls: input.tls,
    readPreference: input.readPreference,
    connectTimeoutMs: input.connectTimeoutMs,
    source: input.source,
    dockerContainerId: input.dockerContainerId,
  } as Partial<ConnectionProfileInput>;
}

/**
 * An export never replaces a file the user did not pick in a save dialog this session. A file the
 * user did pick is replaced only when the export succeeds.
 */
function refuseUnpickedFile(path: string, picked: ReadonlySet<string>): void {
  if (existsSync(path) && !picked.has(path)) {
    throw new AppErrorException(
      appError('VALIDATION', 'The file exists. Choose it with Save as to replace it.'),
    );
  }
}

/**
 * Refuses a `..` segment and returns the absolute path. The transfer receives this resolved path,
 * never the request's text, so the kernel writes where the check looked.
 */
function resolveRequestPath(path: string): string {
  if (path.split(/[\\/]/).includes('..')) {
    throw new AppErrorException(appError('VALIDATION', 'A path may not contain ".." segments.'));
  }
  return resolve(path);
}

/**
 * The real location of a folder, or undefined when it cannot be read. A folder that is a symlink
 * is compared by where it points, so a link inside a picked folder cannot lead out of it.
 */
function realFolder(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

/**
 * A download writes only to a save path picked this session, or directly inside a folder picked
 * this session. The folder is compared by its real location, so a symlink inside it is refused.
 */
function refuseUnpickedDownload(
  target: string,
  savedFiles: ReadonlySet<string>,
  pickedFolders: ReadonlySet<string>,
): void {
  const folder = realFolder(dirname(target));
  if (savedFiles.has(target) || (folder !== undefined && pickedFolders.has(folder))) {
    return;
  }
  throw new AppErrorException(
    appError('VALIDATION', 'Choose the folder or the save location in a dialog first.'),
  );
}

/**
 * The resolved path of a file the open dialog returned this session. Checking does not use the pick
 * up, so the caller uses it only when the transfer starts.
 */
function pickedFile(path: string, openedFiles: ReadonlySet<string>): string {
  const file = resolveRequestPath(path);
  if (!openedFiles.has(file)) {
    throw new AppErrorException(appError('VALIDATION', 'Choose the file in a dialog first.'));
  }
  return file;
}

/** A download without overwrite refuses an existing file, so the renderer can offer a replace. */
function refuseExistingFile(path: string): void {
  if (existsSync(path)) {
    throw new AppErrorException(
      appError('ALREADY_EXISTS', 'The file exists. Replace it to overwrite.'),
    );
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Runs a call whose error text may carry secrets. AppErrors are masked, others pass through. */
async function maskedCall<T>(secrets: readonly string[], action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof AppErrorException) {
      throw new AppErrorException(maskError(error.error, secrets));
    }
    throw error;
  }
}

function maskError(error: AppError, secrets: readonly string[]): AppError {
  const mask = (text: string): string =>
    secrets.reduce((value, secret) => redactPassword(value, secret), redactPassword(text));
  const { detail, cause, ...rest } = error;
  return {
    ...rest,
    message: mask(rest.message),
    ...(detail === undefined ? {} : { detail: mask(detail) }),
    ...(cause === undefined ? {} : { cause: mask(cause) }),
  };
}

/** Custom data leaves the main process as canonical EJSON, so BSON types survive the IPC hop. */
function withEjsonCustomData(user: UserInfo): UserInfo {
  if (user.customData === undefined) {
    return user;
  }
  const { customData, ...rest } = user;
  const canonical = toCanonicalEjson(customData);
  return canonical === undefined ? rest : { ...rest, customData: canonical };
}

function failure(error: AppError): RpcResult {
  return { ok: false, error };
}

function sanitize(error: AppError): AppError {
  const { detail, cause, ...rest } = error;
  return {
    ...rest,
    message: redactText(rest.message),
    ...(detail === undefined ? {} : { detail: redactText(detail) }),
    ...(cause === undefined ? {} : { cause: redactText(cause) }),
  };
}
