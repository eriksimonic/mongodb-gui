import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
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
  type RpcCall,
  type RpcEvent,
  type RpcResult,
} from '@mongo-gui/core';
import {
  ConnectionManager,
  collectionStats,
  databaseStats,
  listCollections,
  listDatabases,
  listIndexes,
  mapDriverError,
} from '@mongo-gui/mongo-adapter';
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
import { log, type Logger } from '../log';
import { redactText } from '../redact';
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
}

export interface Router {
  handle(method: string, input: unknown): Promise<RpcResult>;
}

export interface AppServicesOptions {
  readonly userDataDir: string;
  readonly kdf?: KdfParams;
  readonly failureDelayMs?: number;
}

export type AppServices = Omit<RouterDeps, 'onEvent'> & { dispose(): Promise<void> };

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

  const resetVault = async (): Promise<void> => {
    if (deps.reopenStore === undefined) {
      throw new AppErrorException(appError('INTERNAL', 'The store cannot be reopened.'));
    }
    deps.vault.reset();
    await deps.connections.disconnectAll();
    active.store.deleteFile();
    active = deps.reopenStore();
  };

  const operations = new Map<string, Operation>([
    entry('vault.status', rpcContract.vault.status, () => deps.vault.status()),
    entry('vault.initialise', rpcContract.vault.initialise, (input) => {
      deps.vault.initialise(input.password);
      applyStoredIdleLock();
    }),
    entry('vault.unlock', rpcContract.vault.unlock, async (input) => {
      await deps.vault.unlock(input.password);
      applyStoredIdleLock();
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
      repos().connections.remove(input.id);
      await deps.connections.disconnect(input.id);
    }),
    entry('connections.test', rpcContract.connections.test, (input) =>
      deps.connections.test(input),
    ),
    entry('connections.connect', rpcContract.connections.connect, async (input) => {
      const profile = repos().connections.get(input.id);
      return deps.connections.connect(profile);
    }),
    entry('connections.disconnect', rpcContract.connections.disconnect, (input) =>
      deps.connections.disconnect(input.id),
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
      return repos().settings.update(input);
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
  ]);

  const monitor = createMonitorService({
    getClient: (connectionId) => deps.connections.getClient(connectionId),
    createSampler: deps.createSampler ?? defaultSamplerFactory,
    emit: deps.onEvent,
  });

  deps.connections.onStatusChange((connectionId, status) => {
    deps.onEvent({ type: 'connection:status', connectionId, status });
    // A sampler holds the client it started with, so any drop ends monitoring for that connection.
    if (status.state !== 'connected') {
      monitor.stop(connectionId);
    }
  });
  deps.lockEvents?.subscribe(() => {
    monitor.stopAll();
    void deps.connections.disconnectAll();
    deps.onEvent({ type: 'vault:locked' });
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

  return {
    vault,
    store: handles.store,
    repos: handles.repos,
    connections,
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
    async dispose() {
      await connections.disconnectAll();
      handles.store.close();
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
