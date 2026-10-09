import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  AppErrorException,
  ConnectionProfileSummarySchema,
  appError,
  groupByShape,
  redactUri,
  rpcContract,
  toAppError,
  type AppError,
  type CallInput,
  type ConnectionProfile,
  type ConnectionProfileInput,
  type ProfileCollectionInfo,
  type ProfileEntry,
  type ProfileFilter,
  type ProfilingLevel,
  type RpcCall,
  type RpcEvent,
  type RpcResult,
  type SetProfilingLevelInput,
  type TailProfileOptions,
  type UpdateState,
} from '@mongo-gui/core';
import {
  ConnectionManager,
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
  dropCollection,
  dropDatabase,
  dropIndex,
  findDocumentById,
  getValidation,
  insertDocument,
  getProfilingLevel,
  listCollections,
  listDatabases,
  listIndexBuilds,
  listIndexes,
  listProfileEntries,
  mapDriverError,
  renameCollection,
  replaceDocument,
  sampleDocuments,
  setIndexHidden,
  setValidation,
  updateDocumentFields,
  profileCollectionInfo,
  setProfilingLevel,
  tailProfileEntries,
  toCanonicalEjson,
  type ProfileTail,
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
} from '@mongo-gui/storage';
import { createDockerRuntime, type DockerRuntime } from '../docker/runtime';
import { log, type Logger } from '../log';
import { redactText } from '../redact';
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
  /** The profiler reads and writes. Defaults to the adapter functions; tests pass a fake. */
  readonly profiler?: ProfilerPort;
  /** Local Docker discovery and forwarders. Calls to the docker namespace fail without it. */
  readonly docker?: DockerRuntime;
  /** The in-app updater. Without it, the updates calls fail with INTERNAL. */
  readonly updates?: UpdatesService;
  /** Opens a link in the user's browser. The caller checks the link before it gets here. */
  readonly openExternal?: (url: string) => Promise<void>;
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
  /** Engine socket for docker support. Tests point it at a missing socket to stay off the host engine. */
  readonly dockerSocketPath?: string;
  readonly updates?: UpdatesRuntime;
}

export type AppServices = Omit<RouterDeps, 'onEvent' | 'docker' | 'updates'> & {
  readonly docker: DockerRuntime;
  readonly updates: UpdatesService;
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

export function createRouter(deps: RouterDeps): Router {
  let active: StoreHandles = { store: deps.store, repos: deps.repos };
  const repos = (): RouterRepos => active.repos;
  const profiler = deps.profiler ?? adapterProfilerPort;
  // At most one tail per connection and database, keyed by both.
  const tails = new Map<string, ActiveTail>();
  // Per-renderer cleanups. Tails register first; other services join the same registry.
  const rendererResets = new Set<() => void>();
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

  const updatesService = (): UpdatesService => {
    if (deps.updates === undefined) {
      throw new AppErrorException(appError('INTERNAL', 'Updates are not available.'));
    }
    return deps.updates;
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

    ...managementOperations(),

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
  ]);

  const monitor = createMonitorService({
    getClient: (connectionId) => deps.connections.getClient(connectionId),
    createSampler: deps.createSampler ?? defaultSamplerFactory,
    emit: deps.onEvent,
  });

  // A reload or a closed window must not leave samplers running for a page that is gone.
  rendererResets.add(() => {
    monitor.stopAll();
  });

  deps.connections.onStatusChange((connectionId, status) => {
    if (status.state !== 'connected') {
      stopTails((active) => active.connectionId === connectionId);
    }
    deps.onEvent({ type: 'connection:status', connectionId, status });
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
    monitor.stopAll();
    void deps.connections.disconnectAll();
    deps.docker?.suspend();
    void deps.docker?.cleanupAll();
    deps.updates?.refreshSchedule();
    deps.onEvent({ type: 'vault:locked' });
  });
  deps.updates?.subscribe((state) => {
    deps.onEvent({ type: 'updates:state', state });
  });

  return {
    resetRenderer() {
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
  const vaultOptions: VaultOptions = {
    dir: options.userDataDir,
    kdf: options.kdf ?? DEFAULT_KDF_PARAMS,
    ...(options.failureDelayMs === undefined ? {} : { failureDelayMs: options.failureDelayMs }),
    onLocked: () => {
      for (const listener of [...lockListeners]) {
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
    docker,
    log,
    reopenStore: () => {
      handles = openStore();
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
    updates,
    async dispose() {
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

function tailKey(connectionId: string, database: string): string {
  return `${connectionId}\u0000${database}`;
}

/**
 * Profile entries carry BSON values in command, locks, storage and raw. They are sent in
 * canonical extended JSON, so the renderer gets plain data with $oid and $date markers.
 */
function canonicalEntry(entry: ProfileEntry): ProfileEntry {
  return {
    ...entry,
    raw: toCanonicalEjson(entry.raw),
    ...(entry.command === undefined ? {} : { command: toCanonicalEjson(entry.command) }),
    ...(entry.locks === undefined ? {} : { locks: toCanonicalEjson(entry.locks) }),
    ...(entry.storage === undefined ? {} : { storage: toCanonicalEjson(entry.storage) }),
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
