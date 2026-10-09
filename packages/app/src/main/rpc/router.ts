import { existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  AppErrorException,
  ConnectionProfileSummarySchema,
  appError,
  redactUri,
  rpcContract,
  toAppError,
  type AppError,
  type CallInput,
  type ConnectionProfile,
  type ConnectionProfileInput,
  type DialogResult,
  type OpenDialogInput,
  type SaveDialogInput,
  type RpcCall,
  type RpcEvent,
  type RpcResult,
  type UpdateState,
} from '@mongo-gui/core';
import {
  ConnectionManager,
  collectionStats,
  databaseStats,
  listCollections,
  listDatabases,
  listIndexes,
  mapDriverError,
  previewImport,
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
import type { RendererResetRegistry } from './renderer-reset';
import { createTransferService, type TransferAdapter } from './transfer-service';

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
  /** Local Docker discovery and forwarders. Calls to the docker namespace fail without it. */
  readonly docker?: DockerRuntime;
  /** The in-app updater. Without it, the updates calls fail with INTERNAL. */
  readonly updates?: UpdatesService;
  /** Opens a link in the user's browser. The caller checks the link before it gets here. */
  readonly openExternal?: (url: string) => Promise<void>;
  /** File dialogs for import and export. Calls to them fail with INTERNAL without it. */
  readonly dialogs?: NativeDialogs;
  /** Stops the work the renderer started when its page goes away. */
  readonly rendererReset?: RendererResetRegistry;
  /** The transfer functions. Tests inject a fake. Defaults to the adapter. */
  readonly transferAdapter?: TransferAdapter;
}

export interface Router {
  handle(method: string, input: unknown): Promise<RpcResult>;
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

const KEYRING_DIR_MODE = 0o700;
const MS_PER_MINUTE = 60_000;
const STORE_FILE_NAME = 'store.sqlite';

export function createRouter(deps: RouterDeps): Router {
  let active: StoreHandles = { store: deps.store, repos: deps.repos };
  const repos = (): RouterRepos => active.repos;

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

  // Paths the user picked in a save dialog this session. An export may replace only these.
  const savePaths = new Set<string>();

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
      return previewImport(request);
    }),
    entry('transfer.startImport', rpcContract.transfer.startImport, (input) => {
      const { connectionId, ...request } = input;
      requireConnectionProfile(connectionId);
      return { transferId: transfers.startImport(connectionId, request) };
    }),
    entry('transfer.startExport', rpcContract.transfer.startExport, (input) => {
      const { connectionId, ...request } = input;
      requireConnectionProfile(connectionId);
      refuseMissingFolder(request.path);
      refuseUnpickedFile(request.path, savePaths);
      return { transferId: transfers.startExport(connectionId, request) };
    }),
    entry('transfer.cancel', rpcContract.transfer.cancel, (input) => {
      transfers.cancel(input.transferId);
    }),
    entry('transfer.status', rpcContract.transfer.status, (input) =>
      transfers.status(input.transferId),
    ),
    entry('transfer.list', rpcContract.transfer.list, () => transfers.list()),
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
    entry('app.showOpenDialog', rpcContract.app.showOpenDialog, (input) =>
      dialogs().showOpenDialog(input),
    ),
    entry('app.showSaveDialog', rpcContract.app.showSaveDialog, async (input) => {
      const picked = await dialogs().showSaveDialog(input);
      if (picked.path !== undefined) {
        savePaths.add(picked.path);
      }
      return picked;
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

  deps.connections.onStatusChange((connectionId, status) => {
    deps.onEvent({ type: 'connection:status', connectionId, status });
    // A transfer reads or writes through the client of its connection, so it ends with the connection.
    if (status.state !== 'connected') {
      transfers.cancelConnection(connectionId);
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
    monitor.stopAll();
    transfers.cancelAll();
    void deps.connections.disconnectAll();
    deps.docker?.suspend();
    void deps.docker?.cleanupAll();
    deps.updates?.refreshSchedule();
    deps.onEvent({ type: 'vault:locked' });
  });
  deps.updates?.subscribe((state) => {
    deps.onEvent({ type: 'updates:state', state });
  });
  deps.rendererReset?.register(() => {
    transfers.cancelAll();
  });

  return {
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

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
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
