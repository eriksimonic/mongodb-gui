import { appendFileSync, statSync } from 'node:fs';
import { ExportWriter } from './export-file';
import { dirname } from 'node:path';
import {
  AppErrorException,
  appError,
  toAppError,
  type AppError,
  type AppVersions,
  type StartupSettings,
  type ConnectionProfile,
  type DialogResult,
  type OpenDialogInput,
  type SaveDialogInput,
  type RpcEvent,
  type RpcResult,
  type UpdateState,
  type BackupInspection,
  type BackupScope,
  type BackupServerInfo,
} from '@mongo-gui/core';
import { ConnectionManager, objectIdFromHex } from '@mongo-gui/mongo-adapter';
import {
  ConnectionsRepository,
  EncryptedStore,
  FavouritesRepository,
  SavedRestoresRepository,
  HistoryRepository,
  LayoutRepository,
  SavedBackupsRepository,
  SettingsRepository,
  Vault,
} from '@mongo-gui/storage';
import { type DockerRuntime } from '../docker/runtime';
import { type Logger } from '../log';
import { redactText } from '../redact';
import { type SpillRoot } from '../spill/spill-root';
import { type Updater } from '../updates/updater';
import { createMonitorService, defaultSamplerFactory, type SamplerFactory } from './monitor';
import { diagnosticsOperations } from './diagnostics';
import type { Operation } from './operation';
import { managementOperations } from './management';
import { schemaOperations } from './schema';
import { createChangesService, type OpenChangeWatch } from './changes';
import { createBackupRpcService } from './backup';
import { toolsOperations } from './tools';
import { gridfsOperations } from './gridfs';
import { appOperations } from './app';
import { connectionsOperations } from './connections';
import { dockerOperations } from './docker';
import { settingsOperations } from './settings';
import { updatesOperations } from './updates';
import { vaultOperations } from './vault';
import { createShellService, type ShellRegistry } from './shell';
import { explainOperations } from './explain';
import { pickedFile, realFolder, resolveRequestPath } from './picked-paths';
import { adapterProfilerPort, createProfilerService, type ProfilerPort } from './profiler';
import { createTransferService, type TransferAdapter } from './transfer';
import { createGenerateService } from './generate';
import { createReplicationService } from './replication';
import { securityOperations } from './security';
import { shardingOperations } from './sharding';
import { type BackupService } from '../backup/backup-service';
import { type ToolsDownloads } from '../tools/download-service';
import { type FeedClient } from '../tools/feed-client';
import { type ToolsRegistry } from '../tools/registry';

/** The start-up options file and the app restart. The Electron wiring lives in index.ts. */
export interface StartupControl {
  readonly read: () => StartupSettings;
  readonly write: (settings: StartupSettings) => void;
  readonly restart: () => void;
}

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
  readonly savedBackups: SavedBackupsRepository;
  readonly savedRestores: SavedRestoresRepository;
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
  /** One runtime process per connection. Without it every shell call fails with INTERNAL. */
  readonly shell?: ShellRegistry;
  /** Where the shell's encrypted spill files are read and freed. Without it a spilled document is not found. */
  readonly spill?: Pick<SpillRoot, 'read' | 'release'>;
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
  /** Reads and writes the start-up options and restarts the app. Without it these calls fail with INTERNAL. */
  readonly startup?: StartupControl;
  /** File dialogs for import and export. Calls to them fail with INTERNAL without it. */
  readonly dialogs?: NativeDialogs;
  /** The transfer functions. Tests inject a fake. Defaults to the adapter. */
  readonly transferAdapter?: TransferAdapter;
  /** Opens a change watch. Tests inject a fake watch. Defaults to the adapter. */
  readonly openWatch?: OpenChangeWatch;
  /**
   * Builds the backup and tools services for this router. Without it the backup and tools calls
   * fail with INTERNAL. Tests pass fakes.
   */
  readonly backupTools?: (wiring: BackupToolsWiring) => BackupTools;
  /**
   * Appends one JSON line per handle call to this file, so the e2e tests can see which calls
   * reached the router. index.ts sets it from MONGO_GUI_RPC_TRACE, and never in a packaged app.
   */
  readonly rpcTracePath?: string;
}

/** What the router gives the backup services: its event sink and its folder pick check. */
export interface BackupToolsWiring {
  readonly emit: (event: RpcEvent) => void;
  /** True when the folder, by its real location, was picked in a folder dialog this session. */
  readonly isPickedFolder: (folder: string) => boolean;
}

/** The backup and tools services the router calls. */
export interface BackupTools {
  readonly registry: Pick<ToolsRegistry, 'list' | 'remove' | 'licence'>;
  readonly feed: Pick<FeedClient, 'available'>;
  readonly downloads: ToolsDownloads;
  readonly backups: BackupService;
  /** Reads the server facts the backup dialog shows. */
  readonly describeServer: (client: DriverClient, scope?: BackupScope) => Promise<BackupServerInfo>;
  /** Describes an archive or a dump folder. */
  readonly inspect: (path: string) => Promise<BackupInspection>;
}

/** The driver client type, named without importing the driver into the main process. */
export type DriverClient = ReturnType<ConnectionRegistry['getClient']>;

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

export function createRouter(deps: RouterDeps): Router {
  let active: StoreHandles = { store: deps.store, repos: deps.repos };
  const repos = (): RouterRepos => active.repos;

  const profiler = createProfilerService({
    port: deps.profiler ?? adapterProfilerPort,
    getClient: (connectionId) => deps.connections.getClient(connectionId),
    emit: deps.onEvent,
  });
  const monitor = createMonitorService({
    getClient: (connectionId) => deps.connections.getClient(connectionId),
    createSampler: deps.createSampler ?? defaultSamplerFactory,
    emit: deps.onEvent,
  });
  const replication = createReplicationService({
    getClient: (connectionId) => deps.connections.getClient(connectionId),
  });
  // Per-renderer cleanups. Tails register first; other services join the same registry.
  const rendererResets = new Set<() => void>();
  // Plans belong to the page that made them. A reset drops them, so a reloaded page cannot apply one.
  rendererResets.add(() => {
    replication.clear();
  });
  rendererResets.add(() => {
    profiler.stopAll();
  });
  rendererResets.add(() => {
    changes.stopAll();
  });

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
  // Exports written in parts, by target path. A failed part, a reset or a quit removes the file.
  const activeExports = new Map<string, ExportWriter>();
  function abortExport(path: string): void {
    const writer = activeExports.get(path);
    activeExports.delete(path);
    writer?.abort();
  }
  // Folders picked in a folder dialog: a download may write only directly inside these.
  const folderPicks = new Set<string>();
  // Files picked in an open dialog: an upload or an import reads only these, one use each.
  const openedFiles = new Set<string>();

  /** The real location of a folder picked this session, or undefined when it was not picked. */
  const pickedFolder = (folder: string): string | undefined => {
    const real = realFolder(resolveRequestPath(folder));
    return real !== undefined && folderPicks.has(real) ? real : undefined;
  };

  const backupTools = deps.backupTools?.({
    emit: deps.onEvent,
    isPickedFolder: (folder) => pickedFolder(folder) !== undefined,
  });
  const tools = (): BackupTools => {
    if (backupTools === undefined) {
      throw new AppErrorException(appError('INTERNAL', 'Backup and restore are not available.'));
    }
    return backupTools;
  };

  /** Checks that a connection profile exists. A locked vault reports VAULT_LOCKED from the store. */
  const requireConnectionProfile = (connectionId: string): void => {
    repos().connections.get(connectionId);
  };

  const transfers = createTransferService({
    ...(deps.transferAdapter === undefined ? {} : { adapter: deps.transferAdapter }),
    getClient: (connectionId) => deps.connections.getClient(connectionId),
    emit: deps.onEvent,
  });

  const generate = createGenerateService({
    getClient: (connectionId) => deps.connections.getClient(connectionId),
    emit: deps.onEvent,
    toObjectId: objectIdFromHex,
  });

  const changes = createChangesService({
    getClient: (connectionId) => deps.connections.getClient(connectionId),
    emit: deps.onEvent,
    ...(deps.openWatch === undefined ? {} : { openWatch: deps.openWatch }),
    sanitize,
  });
  const backup = createBackupRpcService({
    tools,
    getClient: (connectionId) => deps.connections.getClient(connectionId),
    repos,
    requireConnectionProfile,
    pickedFolder,
    isOpenedFile: (file) => openedFiles.has(file),
    resolveRequestPath,
    isDirectory,
  });

  const shell = createShellService({
    ...(deps.shell === undefined ? {} : { shell: deps.shell }),
    ...(deps.spill === undefined ? {} : { spill: deps.spill }),
    isConnected: (connectionId) => deps.connections.status(connectionId).state === 'connected',
  });
  // On vault reset the store file is deleted and the router reads from a fresh store.
  const reopenStore = deps.reopenStore;
  const resetStore =
    reopenStore === undefined
      ? undefined
      : (): void => {
          active.store.deleteFile();
          active = reopenStore();
        };
  const operations = new Map<string, Operation>([
    ...vaultOperations({
      vault: deps.vault,
      connections: deps.connections,
      docker: deps.docker,
      updates: deps.updates,
      repos,
      log: deps.log,
      resetStore,
    }),
    ...connectionsOperations({
      connections: deps.connections,
      repos,
      profileById,
      docker: deps.docker,
      savePaths,
      openedFiles,
      refuseMissingFolder,
    }),
    ...shell.operations(),
    ...explainOperations({
      getClient: (connectionId) => deps.connections.getClient(connectionId),
      isConnected: (connectionId) => deps.connections.status(connectionId).state === 'connected',
      shellCall: shell.shellCall,
    }),
    ...managementOperations({
      getClient: (connectionId) => deps.connections.getClient(connectionId),
      emit: deps.onEvent,
    }),
    ...securityOperations({
      getClient: (connectionId) => deps.connections.getClient(connectionId),
    }),
    ...shardingOperations({
      getClient: (connectionId) => deps.connections.getClient(connectionId),
      emit: deps.onEvent,
    }),
    ...diagnosticsOperations({
      getClient: (connectionId) => deps.connections.getClient(connectionId),
      emit: deps.onEvent,
    }),

    ...monitor.rpcOperations(),

    ...replication.operations(),
    ...settingsOperations({ repos, vault: deps.vault, updates: deps.updates }),
    ...profiler.operations(),
    ...changes.operations(),
    ...dockerOperations({ docker: deps.docker, emit: deps.onEvent }),
    ...transfers.operations({
      requireConnectionProfile,
      pickedFile: (path) => pickedFile(path, openedFiles),
      releasePick: (path) => {
        openedFiles.delete(path);
      },
      resolveRequestPath,
      refuseMissingFolder,
      savePaths,
    }),
    ...generate.operations(),

    ...backup.operations(),
    ...toolsOperations({ tools, repos }),
    ...gridfsOperations({
      getClient: (connectionId) => deps.connections.getClient(connectionId),
      transfers,
      requireConnectionProfile,
      openedFiles,
      savePaths,
      folderPicks,
    }),
    ...schemaOperations({
      getClient: (connectionId) => deps.connections.getClient(connectionId),
      shellCall: shell.shellCall,
    }),
    ...updatesOperations({ updates: deps.updates }),
    ...appOperations({
      openExternal: deps.openExternal,
      versions: deps.versions,
      startup: deps.startup,
      dialogs: deps.dialogs,
      transfers,
      backups: backupTools?.backups,
      savePaths,
      folderPicks,
      openedFiles,
      activeExports,
      abortExport,
    }),
  ]);

  // Generate jobs end with the page that started them, as transfers do.
  rendererResets.add(() => {
    generate.cancelAll();
  });
  // Backups, restores and tools downloads end with the page too, and a new page inspects again.
  rendererResets.add(() => {
    backup.clearInspected();
    backupTools?.backups.cancelAll();
    backupTools?.downloads.cancelAll();
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
      profiler.stopConnection(connectionId);
      changes.stopConnection(connectionId);
    }
    deps.onEvent({ type: 'connection:status', connectionId, status });
    // A transfer reads or writes through the client of its connection, so it ends with the connection.
    if (status.state !== 'connected') {
      transfers.cancelConnection(connectionId);
      generate.cancelConnection(connectionId);
      backupTools?.backups.cancelConnection(connectionId);
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
    profiler.stopAll();
    changes.stopAll();
    monitor.stopAll();
    transfers.cancelAll();
    // A job reads its connection profile from the store, so a lock ends it. Downloads go on.
    backupTools?.backups.cancelAll();
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
      // The quit path calls this before the services dispose, so no half-written export stays.
      for (const path of [...activeExports.keys()]) {
        abortExport(path);
      }
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
      const result = await dispatch(method, input);
      if (deps.rpcTracePath !== undefined) {
        const outcome = result.ok ? 'ok' : result.error.code;
        appendFileSync(deps.rpcTracePath, `${JSON.stringify({ method, outcome })}\n`);
      }
      return result;
    },
  };

  /** Runs one call. handle wraps it so every outcome reaches the trace. */
  async function dispatch(method: string, input: unknown): Promise<RpcResult> {
    const op = operations.get(method);
    if (op === undefined) {
      deps.log?.warn('rpc method unknown', { method });
      return failure(appError('VALIDATION', 'The method is not known.', method));
    }
    try {
      const parsedInput = op.call.input.safeParse(input);
      if (!parsedInput.success) {
        deps.log?.warn('rpc input rejected', { method });
        return failure(appError('VALIDATION', 'The input is invalid.', method));
      }
      const value = await op.run(parsedInput.data);
      const parsedOutput = op.call.output.safeParse(value);
      if (!parsedOutput.success) {
        deps.log?.error('rpc output rejected', { method });
        return failure(appError('INTERNAL', 'The handler returned an unexpected value.', method));
      }
      // Browsing keeps the vault unlocked. A locked vault ignores the touch.
      deps.vault.touch();
      return { ok: true, value: parsedOutput.data };
    } catch (error) {
      return failure(describeFailure(method, error));
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

/** Refuses an export whose folder is missing, before any file is created. */
function refuseMissingFolder(path: string): void {
  const folder = dirname(path);
  if (!isDirectory(folder)) {
    throw new AppErrorException(appError('VALIDATION', 'The folder does not exist.', folder));
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
