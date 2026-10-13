import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { ExportWriter, exportTargetProblem, replaceFile } from './export-file';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn as nodeSpawn } from 'node:child_process';
import {
  AppErrorException,
  CONNECTIONS_FILE_MAX_BYTES,
  ConnectionProfileSummarySchema,
  describeConnectionUri,
  planConnectionsImport,
  type ConnectionImportAction,
  type ConnectionsImportResult,
  DEFAULT_BATCH_SIZE,
  appError,
  normaliseExplain,
  rewriteForExplain,
  redactUri,
  rpcContract,
  toAppError,
  type AppError,
  type AppVersions,
  type StartupSettings,
  type ConnectionProfile,
  type ConnectionProfileInput,
  type ConnectionStatus,
  type DialogResult,
  type OpenDialogInput,
  type SaveDialogInput,
  type ExplainResult,
  type ExplainRunCommandInput,
  type ExplainRunInput,
  type RpcEvent,
  type RpcResult,
  type UpdateState,
  directConnectionName,
  directUriFor,
  type BackupInspection,
  type BackupScope,
  type BackupServerInfo,
  type ToolsPlatform,
} from '@mongo-gui/core';
import {
  ConnectionManager,
  explainableCommand,
  parseCommandEjson,
  runExplainCommand,
  wrapWriteCommand,
  objectIdFromHex,
  readArchivePrelude,
  readBackupServerInfo,
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
  SavedRestoresRepository,
  HistoryRepository,
  LayoutRepository,
  SavedBackupsRepository,
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
import { SpillError, spillEnv } from '@mongo-gui/storage/spill';
import { createSpillRoot, type SpillRoot } from '../spill/spill-root';
import {
  createUpdater,
  noopUpdaterBackend,
  type Updater,
  type UpdaterBackend,
} from '../updates/updater';
import { createMonitorService, defaultSamplerFactory, type SamplerFactory } from './monitor';
import { diagnosticsOperations } from './diagnostics';
import { driverCall, entry, type Operation } from './operation';
import { managementOperations } from './management';
import { schemaOperations } from './schema';
import { createChangesService, type OpenChangeWatch } from './changes';
import { createBackupRpcService } from './backup';
import { toolsOperations } from './tools';
import { gridfsOperations } from './gridfs';
import { pickedFile, realFolder, resolveRequestPath } from './picked-paths';
import { adapterProfilerPort, createProfilerService, type ProfilerPort } from './profiler';
import { createTransferService, type TransferAdapter } from './transfer';
import { createGenerateService } from './generate';
import { createReplicationService } from './replication';
import { securityOperations } from './security';
import { shardingOperations } from './sharding';
import { createBackupService, type BackupService } from '../backup/backup-service';
import { resolveToolsEndpoint, type ToolsEndpointDocker } from '../backup/endpoint';
import { inspectBackup } from '../backup/inspect';
import { sweepTempConfigs } from '../backup/temp-config';
import { createToolsDownloads, type ToolsDownloads } from '../tools/download-service';
import { createFeedClient, type FeedClient } from '../tools/feed-client';
import { toolsRoots } from '../tools/paths';
import type { SpawnFn } from '../tools/probe';
import { createToolsRegistry, type ToolsRegistry } from '../tools/registry';

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
  /** Where the MongoDB tools live and how they run. Without it the backup and tools calls fail. */
  readonly tools?: ToolsRuntime;
  /**
   * Candidate folders for the encrypted result spill, in order of preference. Without it the
   * shell keeps large results in memory.
   */
  readonly spillBases?: readonly string[];
}

/** What the backup and tools services need from Electron. The tools folders sit under userDataDir. */
export interface ToolsRuntime {
  readonly isPackaged: boolean;
  /** process.resourcesPath, which holds the bundled tools in a packaged app. */
  readonly resourcesPath: string;
  /** The packages/app folder, which holds the bundled tools in development. */
  readonly appRoot: string;
  /** Recorded in each backup's sidecar. */
  readonly appVersion: string;
  /** Electron net.fetch, so the system proxy applies to feed and tools downloads. */
  readonly fetchImpl: typeof fetch;
  /** Defaults to child_process.spawn. */
  readonly spawn?: SpawnFn;
}

export type AppServices = Omit<RouterDeps, 'onEvent' | 'docker' | 'updates' | 'spill'> & {
  /** The spill folder of this run. Absent when no folder was usable or none was asked for. */
  readonly spill?: SpillRoot;
  readonly docker: DockerRuntime;
  readonly updates: UpdatesService;
  /** Fires after the vault unlocks. The main process restores the window bounds here. */
  readonly unlockEvents: LockEvents;
  /** The repositories of the open store. Repository calls throw VAULT_LOCKED while the vault is locked. */
  readonly currentRepos: () => RouterRepos;
  dispose(): Promise<void>;
};

const KEYRING_DIR_MODE = 0o700;
const MS_PER_MINUTE = 60_000;
/** The most text one part of a streamed export may carry. */
const EXPORT_PART_MAX_CHARS = 2 * 1024 * 1024;
const STORE_FILE_NAME = 'store.sqlite';
export function createRouter(deps: RouterDeps): Router {
  let active: StoreHandles = { store: deps.store, repos: deps.repos };
  const repos = (): RouterRepos => active.repos;

  /** Records the time of a successful connect on the profile, then returns the status unchanged. */
  const stamped = (id: string, status: ConnectionStatus): ConnectionStatus => {
    if (status.state === 'connected') {
      repos().connections.markAccessed(id);
    }
    return status;
  };
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

  const updatesService = (): UpdatesService => {
    if (deps.updates === undefined) {
      throw new AppErrorException(appError('INTERNAL', 'Updates are not available.'));
    }
    return deps.updates;
  };

  const startup = (): StartupControl => {
    if (deps.startup === undefined) {
      throw new AppErrorException(appError('INTERNAL', 'Start-up options are not available.'));
    }
    return deps.startup;
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
  // Exports written in parts, by target path. A failed part, a reset or a quit removes the file.
  const activeExports = new Map<string, ExportWriter>();
  function abortExport(path: string): void {
    const writer = activeExports.get(path);
    activeExports.delete(path);
    writer?.abort();
  }
  function appendExport(path: string, writer: ExportWriter, content: string): void {
    try {
      writer.append(content);
    } catch (error) {
      abortExport(path);
      throw error;
    }
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
    entry('connections.createDirect', rpcContract.connections.createDirect, (input) => {
      const parent = repos().connections.get(input.id);
      return repos().connections.create({
        ...(parent.color === undefined ? {} : { color: parent.color }),
        ...(parent.tls === undefined ? {} : { tls: parent.tls }),
        ...(parent.readPreference === undefined ? {} : { readPreference: parent.readPreference }),
        ...(parent.connectTimeoutMs === undefined
          ? {}
          : { connectTimeoutMs: parent.connectTimeoutMs }),
        name: directConnectionName(parent.name, input.host),
        uri: directUriFor(parent.uri, input.host),
        source: 'manual',
        dockerContainerId: undefined,
      });
    }),
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
        const result = await docker().connect(profile.dockerContainerId);
        // The tree reads a status here. The dialog opens from docker.connect, so this reports the error.
        if ('kind' in result) {
          return {
            state: 'error',
            error: appError('AUTH_FAILED', 'The server needs a user name and password.'),
          };
        }
        return stamped(input.id, result.status);
      }
      return stamped(input.id, await deps.connections.connect(profile));
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
      const plan = planConnectionsImport(incoming, existing, input.mode);
      // A transaction cannot wait, so each replaced connection disconnects before the writes start.
      for (const action of plan) {
        if (action.kind === 'replace') {
          const current = existing.find((connection) => connection.id === action.targetId);
          await disconnectConnection(action.targetId, current);
        }
      }
      // One transaction holds every write. A failed write rolls back the others, and the pick stays
      // usable, so the same file can be imported again.
      repos().connections.transaction(() => {
        for (const action of plan) {
          if (action.kind === 'create') {
            repos().connections.create(action.input);
          } else if (action.kind === 'replace') {
            repos().connections.update(action.targetId, replacementPatch(action.input));
          }
        }
      });
      openedFiles.delete(path);
      return summariseImportPlan(plan);
    }),

    entry('shell.evaluate', rpcContract.shell.evaluate, (input) =>
      shellCall(input.connectionId, (shell) => shell.evaluate(input)),
    ),
    entry('shell.next', rpcContract.shell.next, (input) =>
      shellCall(input.connectionId, (shell) => shell.next(input)),
    ),
    entry('shell.readDocument', rpcContract.shell.readDocument, (input) => {
      try {
        if (deps.spill !== undefined) {
          return deps.spill.read(input.ref);
        }
      } catch (error) {
        if (!(error instanceof SpillError)) {
          throw error;
        }
      }
      throw new AppErrorException(
        appError('NOT_FOUND', 'The full document is no longer available. Run the query again.'),
      );
    }),
    entry('shell.releaseResult', rpcContract.shell.releaseResult, (input) => {
      deps.spill?.release(input.requestId);
    }),
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
    entry('shell.restart', rpcContract.shell.restart, (input) =>
      shellCall(input.connectionId, (shell) => shell.restart(input.connectionId)),
    ),
    entry('shell.state', rpcContract.shell.state, (input) => ({
      state: deps.shell?.state(input.connectionId) ?? 'stopped',
    })),
    entry('explain.run', rpcContract.explain.run, (input) => explainStatement(input)),
    entry('explain.runCommand', rpcContract.explain.runCommand, (input) => explainCommand(input)),
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

    ...profiler.operations(),
    ...changes.operations(),
    entry('docker.status', rpcContract.docker.status, () => docker().status()),
    entry('docker.list', rpcContract.docker.list, () => docker().list()),
    entry('docker.connect', rpcContract.docker.connect, (input) =>
      docker().connect(input.containerId),
    ),
    entry('docker.connectWithCredentials', rpcContract.docker.connectWithCredentials, (input) =>
      docker().connectWithCredentials(input),
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
      shellCall,
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
    entry('app.versions', rpcContract.app.versions, () => appVersions()),
    entry('app.getStartupSettings', rpcContract.app.getStartupSettings, () => startup().read()),
    entry('app.setStartupSettings', rpcContract.app.setStartupSettings, (input) => {
      startup().write(input);
      return input;
    }),
    entry('app.restart', rpcContract.app.restart, () => {
      startup().restart();
    }),
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
      const { path, content, part } = input;
      if (part === 'only') {
        // Only a path the user picked in this session is written, so the renderer cannot pick one.
        if (!savePaths.has(path)) {
          throw new AppErrorException(
            appError('VALIDATION', 'Choose the file with Save as first.'),
          );
        }
        // The pick is good for one write. A refused write needs a new pick.
        savePaths.delete(path);
        const problem = exportTargetProblem(path);
        if (problem !== undefined) {
          throw new AppErrorException(appError('VALIDATION', problem));
        }
        replaceFile(path, content);
        return;
      }
      if (part === 'abort') {
        abortExport(path);
        return;
      }
      if (content.length > EXPORT_PART_MAX_CHARS) {
        throw new AppErrorException(appError('VALIDATION', 'The export part is too large.'));
      }
      if (part === 'first') {
        if (activeExports.has(path)) {
          throw new AppErrorException(appError('VALIDATION', 'This export has already started.'));
        }
        if (!savePaths.has(path)) {
          throw new AppErrorException(
            appError('VALIDATION', 'Choose the file with Save as first.'),
          );
        }
        // The pick is good for one export, parts included.
        savePaths.delete(path);
        const problem = exportTargetProblem(path);
        if (problem !== undefined) {
          throw new AppErrorException(appError('VALIDATION', problem));
        }
        const writer = new ExportWriter(path);
        activeExports.set(path, writer);
        appendExport(path, writer, content);
        return;
      }
      const writer = activeExports.get(path);
      if (writer === undefined) {
        throw new AppErrorException(appError('VALIDATION', 'This export has not started.'));
      }
      appendExport(path, writer, content);
      if (part === 'last') {
        activeExports.delete(path);
        writer.commit();
      }
    }),
    entry('app.showItemInFolder', rpcContract.app.showItemInFolder, (input) => {
      // Only a file this session exported or backed up is revealed, so the renderer cannot open
      // arbitrary paths.
      if (!transfers.wroteFile(input.path) && backupTools?.backups.wroteFile(input.path) !== true) {
        throw new AppErrorException(
          appError('VALIDATION', 'Only a file exported in this session can be shown.'),
        );
      }
      dialogs().showItemInFolder(input.path);
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
  // Created here so the sweep of dead instances runs at startup, before any connection.
  const spill =
    options.spillBases === undefined ? undefined : createSpillRoot({ bases: options.spillBases });
  const shell = new RuntimeSupervisor({
    ...(spill === undefined ? {} : { spillEnv: spillEnv(spill.ctx) }),
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
  const backupTools =
    options.tools === undefined
      ? undefined
      : createBackupToolsFactory(options.tools, {
          userDataDir: options.userDataDir,
          connections,
          repos: () => handles.repos,
          docker,
        });

  return {
    vault,
    store: handles.store,
    repos: handles.repos,
    connections,
    shell,
    ...(spill === undefined ? {} : { spill }),
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
    ...(backupTools === undefined ? {} : { backupTools: backupTools.build }),
    async dispose() {
      // Wait for the runtime to exit, so nothing writes to the spill after the wipe.
      await shell.dispose();
      spill?.dispose();
      updates.stop();
      // The tools run against open connections, so they stop before the disconnect.
      await backupTools?.dispose();
      await connections.disconnectAll();
      await docker.dispose();
      handles.store.close();
    },
  };
}

/** The backup services builder for createRouter, and the cleanup for what it built. */
interface BackupToolsFactory {
  readonly build: (wiring: BackupToolsWiring) => BackupTools;
  dispose(): Promise<void>;
}

/**
 * Builds the tools registry and the feed client now, and removes what an earlier run left behind.
 * The downloads and the backup service need the router's event sink, so `build` makes them.
 */
function createBackupToolsFactory(
  runtime: ToolsRuntime,
  deps: {
    readonly userDataDir: string;
    readonly connections: ConnectionManager;
    readonly repos: () => RouterRepos;
    readonly docker: DockerRuntime;
  },
): BackupToolsFactory {
  const { platform, arch } = process;
  const roots = toolsRoots({
    isPackaged: runtime.isPackaged,
    resourcesPath: runtime.resourcesPath,
    appRoot: runtime.appRoot,
    userDataDir: deps.userDataDir,
    platform,
    arch,
  });
  const spawn = runtime.spawn ?? nodeSpawn;
  const toolsPlatform: ToolsPlatform = {
    os: platform === 'win32' || platform === 'darwin' ? platform : 'linux',
    arch: arch === 'arm64' ? 'arm64' : 'x64',
  };
  const now = (): Date => new Date();
  const registry = createToolsRegistry({ roots, spawn, platform, arch });
  const feed = createFeedClient({ fetchImpl: runtime.fetchImpl, now, platform: toolsPlatform });
  // No job can start before the vault unlocks, so every leftover found here is stale.
  void registry.sweep().catch((error: unknown) => {
    log.warn('tools sweep failed', { error: error instanceof Error ? error.message : 'unknown' });
  });
  void sweepTempConfigs(roots.tmp);

  const dockerSummary = async (
    profile: ConnectionProfile,
  ): Promise<ToolsEndpointDocker | undefined> => {
    const container = (await deps.docker.list()).find(
      (candidate) => candidate.id === profile.dockerContainerId,
    );
    return container === undefined
      ? undefined
      : { containerName: container.name, image: container.image };
  };
  const inspect = (path: string): Promise<BackupInspection> =>
    inspectBackup(path, { readPrelude: readArchivePrelude });
  const built: BackupTools[] = [];

  return {
    build(wiring) {
      const downloads = createToolsDownloads({
        feed,
        registry,
        fetchImpl: runtime.fetchImpl,
        emit: wiring.emit,
        roots,
        platform: toolsPlatform,
        now,
        spawn,
      });
      const backups = createBackupService({
        registry,
        getClient: (connectionId) => deps.connections.getClient(connectionId),
        endpoint: (connectionId, overrides) =>
          resolveToolsEndpoint(
            {
              status: (id) => deps.connections.status(id),
              getProfile: (id) => deps.repos().connections.get(id),
              dockerSummary,
            },
            connectionId,
            overrides,
          ),
        readServerInfo: readBackupServerInfo,
        inspect,
        spawn,
        emit: wiring.emit,
        now: () => Date.now(),
        tmpRoot: roots.tmp,
        appVersion: runtime.appVersion,
        platform,
        arch,
        isPickedFolder: wiring.isPickedFolder,
        log,
      });
      const services: BackupTools = {
        registry,
        feed,
        downloads,
        backups,
        describeServer: readBackupServerInfo,
        inspect,
      };
      built.push(services);
      return services;
    },
    async dispose() {
      for (const services of built) {
        services.downloads.cancelAll();
      }
      await Promise.all(built.map((services) => services.backups.dispose()));
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
    savedBackups: new SavedBackupsRepository(store),
    savedRestores: new SavedRestoresRepository(store),
    settings,
    layout: new LayoutRepository(store),
  };
}

const refuseFork: ForkFunction = () => {
  throw new Error('no shell runtime is configured');
};

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

/** Counts what an import plan did. A renamed entry also counts as imported. */
function summariseImportPlan(plan: readonly ConnectionImportAction[]): ConnectionsImportResult {
  const result = { imported: 0, skipped: 0, renamed: 0, replaced: 0 };
  for (const action of plan) {
    if (action.kind === 'skip') {
      result.skipped += 1;
    } else if (action.kind === 'create') {
      result.imported += 1;
      result.renamed += action.renamed ? 1 : 0;
    } else {
      result.replaced += 1;
    }
  }
  return result;
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
