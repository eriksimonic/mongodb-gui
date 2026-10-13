import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';
import { type ConnectionProfile, type BackupInspection, type ToolsPlatform } from '@mongo-gui/core';
import {
  ConnectionManager,
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
} from '@mongo-gui/storage';
import { createDockerRuntime, type DockerRuntime } from '../docker/runtime';
import { log } from '../log';
import type { ForkFunction } from '../shell/child';
import { RuntimeSupervisor } from '../shell/supervisor';
import { spillEnv } from '@mongo-gui/storage/spill';
import { createSpillRoot, type SpillRoot } from '../spill/spill-root';
import { type UpdaterBackend } from '../updates/updater';
import { createUpdatesService } from './updates';
import { refuseFork } from './shell';
import { createBackupService } from '../backup/backup-service';
import { resolveToolsEndpoint, type ToolsEndpointDocker } from '../backup/endpoint';
import { inspectBackup } from '../backup/inspect';
import { sweepTempConfigs } from '../backup/temp-config';
import { createToolsDownloads } from '../tools/download-service';
import { createFeedClient } from '../tools/feed-client';
import { toolsRoots } from '../tools/paths';
import type { SpawnFn } from '../tools/probe';
import { createToolsRegistry } from '../tools/registry';
import type {
  BackupTools,
  BackupToolsWiring,
  LockEvents,
  RouterDeps,
  RouterRepos,
  StoreHandles,
  UpdatesService,
} from './router';

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
const STORE_FILE_NAME = 'store.sqlite';

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
