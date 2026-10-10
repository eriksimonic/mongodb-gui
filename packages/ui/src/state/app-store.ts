import {
  defaultDashboardLayout,
  dashboardLayoutKey,
  toAppError,
  type AppError,
  type CollectionInfo,
  type StartExportInput,
  type StartImportInput,
  type ConnectionProfile,
  type ConnectionProfileInput,
  type ConnectionProfileSummary,
  type ConnectionStatus,
  type ConnectionTestResult,
  type DatabaseInfo,
  type DockerMongoContainerSummary,
  type DockerStatus,
  type GridFsBucket,
  type GridFsStartDownloadCall,
  type GridFsStartUploadCall,
  type PanelSpec,
  type RpcEvent,
  type Settings,
  type SettingsPatch,
  type UpdateState,
  type VaultStatus,
  type ReplicaSetStatus,
} from '@mongo-gui/core';
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { UiApi } from '../api/ui-api';
import {
  addPanel,
  DASHBOARD_SAVE_DELAY_MS,
  EMPTY_DASHBOARD_VIEW,
  RESET_NOTICE,
  readStoredLayout,
  type LayoutChange,
  movePanel,
  removePanel,
  resetLayout,
  resizePanel,
  type DashboardHeight,
  type DashboardView,
  type DashboardWidth,
} from './dashboard-state';
import {
  applyError,
  applyIntervalChange,
  applySample,
  applyStarted,
  applyStopped,
  EMPTY_MONITOR_VIEW,
  type MonitorView,
} from './monitor-state';
import { createExplainActions, type ExplainActions } from '../explain/explain-actions';
import type { ExplainPanelState } from '../explain/explain-model';
import { catalogKey, connectionNodeId } from './node-ids';
import { useDockerCredentialsStore } from '../components/connections/docker-credentials-store';
import type { ThemeSetting } from '../theme/color-scheme';
import { readCachedPreferences, writeCachedPreferences } from '../theme/preferences-cache';

/** The layout key the dockview layout is stored under. */
export const DOCK_LAYOUT_KEY = 'dockview:main';

/** Why the vault last locked. The unlock screen explains an idle lock. */
export type LockReason = 'manual' | 'idle';
import { EMPTY_EDITORS, savedTabsOf, type EditorsState } from './editors';
import { createEditorActions, type EditorActions } from './editor-actions';
import {
  applyTransferProgress,
  registerTransfer,
  transfersFromList,
  type TransfersState,
} from './transfer-state';

export type VaultState = VaultStatus['state'];

/** `loading` before the vault has been read. `failed` when the backend cannot be reached. */
export type VaultView = VaultState | 'loading' | 'failed';

export type Loadable<T> =
  | { readonly state: 'loading' }
  | { readonly state: 'ready'; readonly data: T }
  | { readonly state: 'error'; readonly error: AppError };

export interface Selection {
  readonly connectionId: string;
  readonly database?: string | undefined;
  readonly collection?: string | undefined;
}

/**
 * The import wizard and the export dialog. An import without a collection creates one from the
 * name the user types in the wizard.
 */
export type TransferDialogState =
  | { readonly kind: 'closed' }
  | {
      readonly kind: 'import';
      readonly connectionId: string;
      readonly database: string;
      readonly collection: string | undefined;
    }
  | {
      readonly kind: 'export';
      readonly connectionId: string;
      readonly database: string;
      readonly collection: string;
    };

export type DialogState =
  | { readonly kind: 'closed' }
  | { readonly kind: 'create' }
  | { readonly kind: 'edit'; readonly connectionId: string };

/** A management dialog opened from the tree. Each names the target it acts on. */
export type ManagementDialog =
  | { readonly kind: 'createDatabase'; readonly connectionId: string }
  | { readonly kind: 'createCollection'; readonly connectionId: string; readonly database: string }
  | {
      readonly kind: 'renameCollection';
      readonly connectionId: string;
      readonly database: string;
      readonly collection: string;
    }
  | {
      readonly kind: 'clearCollection';
      readonly connectionId: string;
      readonly database: string;
      readonly collection: string;
    }
  | {
      readonly kind: 'dropCollection';
      readonly connectionId: string;
      readonly database: string;
      readonly collection: string;
    }
  | { readonly kind: 'dropDatabase'; readonly connectionId: string; readonly database: string }
  | {
      readonly kind: 'shardCollection';
      readonly connectionId: string;
      readonly database: string;
      readonly collection: string;
    }
  | {
      readonly kind: 'createIndex';
      readonly connectionId: string;
      readonly database: string;
      readonly collection: string;
      /** A field to index first. The dialog starts with it in the key builder. */
      readonly field?: string | undefined;
    };

/**
 * A field the validation panel should add a rule for. The panel applies it to its draft when the
 * target collection matches, then the store clears it.
 */
export interface ValidationFieldRequest {
  readonly connectionId: string;
  readonly database: string;
  readonly collection: string;
  readonly path: string;
  /** BSON type names the schema report saw at the path. */
  readonly types: readonly string[];
}

/** A request to show a collection panel. The shell opens or focuses it, then clears the request. */
export interface PanelRequest {
  readonly panel: 'indexes' | 'validation' | 'documents' | 'schema';
  readonly connectionId: string;
  readonly database: string;
  readonly collection: string;
}

/**
 * The bucket dialogs of the tree. A new bucket takes its name here and then asks for the first
 * file. A drop asks for the typed bucket name.
 */
export type GridFsDialogState =
  | { readonly kind: 'newBucket'; readonly connectionId: string; readonly database: string }
  | {
      readonly kind: 'dropBucket';
      readonly connectionId: string;
      readonly database: string;
      readonly bucket: string;
    };

/** The Docker node of the tree. `status` is undefined until the first read. */
export interface DockerView {
  readonly status: DockerStatus | undefined;
  readonly containers: Loadable<readonly DockerMongoContainerSummary[]>;
  readonly autoConnect: boolean;
}

/** Everything the screens read. Kept apart from the actions so tests can seed it. */
export interface AppData {
  readonly vault: VaultView;
  readonly connections: Loadable<readonly ConnectionProfileSummary[]>;
  readonly statuses: Readonly<Record<string, ConnectionStatus>>;
  readonly docker: DockerView;
  /** Tree nodes that are open, keyed by node id from `node-ids.ts`. */
  readonly expanded: Readonly<Record<string, boolean>>;
  readonly databases: Readonly<Record<string, Loadable<readonly DatabaseInfo[]>>>;
  readonly collections: Readonly<Record<string, Loadable<readonly CollectionInfo[]>>>;
  /** Replica set status per connection, for the member rows of the tree. Loaded when the connection opens. */
  readonly replicaSets: Readonly<Record<string, Loadable<ReplicaSetStatus>>>;
  /** Monitor samples and sampler state per connection, fed by monitor events. */
  readonly monitors: Readonly<Record<string, MonitorView>>;
  /** Dashboard layout per connection. A connection without an entry shows the default layout. */
  readonly dashboards: Readonly<Record<string, DashboardView>>;
  readonly selection: Selection | undefined;
  readonly dialog: DialogState;
  readonly managerOpen: boolean;
  readonly managementDialog: ManagementDialog | undefined;
  readonly panelRequest: PanelRequest | undefined;
  readonly validationField: ValidationFieldRequest | undefined;
  /** Counts catalog:changed events. Panels reload when it moves. */
  readonly catalogRevision: number;
  /** GridFS buckets per database, keyed by `catalogKey`. Loaded when the GridFS node opens. */
  readonly gridfsBuckets: Readonly<Record<string, Loadable<readonly GridFsBucket[]>>>;
  readonly gridfsDialog: GridFsDialogState | undefined;
  /** Counts finished GridFS jobs and changes. GridFS panels reload their files when it moves. */
  readonly gridfsRevision: number;
  readonly settingsOpen: boolean;
  readonly shortcutsOpen: boolean;
  /** The saved settings, read after unlock. Undefined while the vault is locked. */
  readonly settings: Settings | undefined;
  /** The theme in effect. Read from the cache until the saved settings load after unlock. */
  readonly theme: ThemeSetting;
  /** Idle lock minutes for the unlock screen. Read from the cache until the settings load. */
  readonly idleLockMinutes: number;
  readonly lockReason: LockReason | undefined;
  /** Moves when the layout is reset. The shell rebuilds the default panels then. */
  readonly layoutRevision: number;
  /** The updater state, pushed by the backend and read on start. */
  readonly updates: UpdateState;
  /** Editor tabs, their results and output, and the shell runtime state of each connection. */
  readonly editors: EditorsState;
  /** Imports and exports this session started, with their latest progress. */
  readonly transfers: TransfersState;
  readonly transferDialog: TransferDialogState;
  /** Explain panels by panel id. A panel is removed when its tab closes. */
  readonly explainPanels: Readonly<Record<string, ExplainPanelState>>;
  /** The explain panel the shell should show. `serial` moves on each request, so a repeat counts. */
  readonly explainFocus: { readonly id: string; readonly serial: number } | undefined;
}

export interface AppActions extends EditorActions, ExplainActions {
  refreshVault(): Promise<void>;
  initialise(password: string): Promise<void>;
  unlock(password: string): Promise<void>;
  lock(): Promise<void>;
  reset(): Promise<void>;
  loadConnections(): Promise<void>;
  createConnection(input: ConnectionProfileInput): Promise<ConnectionProfile>;
  updateConnection(id: string, input: ConnectionProfileInput): Promise<ConnectionProfile>;
  removeConnection(id: string): Promise<void>;
  testConnection(input: ConnectionProfileInput): Promise<ConnectionTestResult>;
  connect(id: string): Promise<void>;
  disconnect(id: string): Promise<void>;
  /** Opens a connection node in the tree and connects it if needed. */
  expandConnection(id: string): Promise<void>;
  setNodeExpanded(nodeId: string, open: boolean): void;
  /** Starts the server sampler if needed and loads the samples it already holds. */
  startMonitor(connectionId: string, intervalMs?: number): Promise<void>;
  setMonitorInterval(connectionId: string, intervalMs: number): Promise<void>;
  /** Restarts the sampler after an error. Failures show in the monitor view, not as a throw. */
  retryMonitor(connectionId: string): Promise<void>;
  /** Reads the saved dashboard layout. A failed read keeps the default and blocks saves. */
  loadDashboard(connectionId: string): Promise<void>;
  addDashboardPanel(connectionId: string, panel: PanelSpec): void;
  removeDashboardPanel(connectionId: string, id: string): void;
  moveDashboardPanel(connectionId: string, fromId: string, toId: string): void;
  resizeDashboardPanel(
    connectionId: string,
    id: string,
    size: { readonly w?: DashboardWidth; readonly h?: DashboardHeight },
  ): void;
  resetDashboard(connectionId: string): void;
  /** Stops the server sampler and clears the sampler state. Samples are kept for the view. */
  stopMonitor(connectionId: string): Promise<void>;
  loadDatabases(connectionId: string): Promise<void>;
  loadCollections(connectionId: string, database: string): Promise<void>;
  /** Reads the replica set status once per connection. A reload happens after `refreshConnection`. */
  loadReplicaSet(connectionId: string): Promise<void>;
  /** Creates a profile that connects to one member only, connects it and opens it in the tree. */
  connectDirectly(connectionId: string, host: string): Promise<void>;
  /** Drops the cached databases and collections of a connection. Open nodes reload them. */
  refreshConnection(id: string): void;
  select(selection: Selection | undefined): void;
  setDialog(dialog: DialogState): void;
  setManagerOpen(open: boolean): void;
  setManagementDialog(dialog: ManagementDialog | undefined): void;
  /** Asks the shell to show a collection panel. */
  requestPanel(request: PanelRequest): void;
  clearPanelRequest(): void;
  /** Asks the validation panel of a collection to add a rule for a field. */
  requestValidationField(request: ValidationFieldRequest): void;
  clearValidationField(): void;
  /** Drops the cached collections of one database. The open tree nodes reload them. */
  refreshDatabase(connectionId: string, database: string): void;
  /** Loads the buckets of a database. A list that is loading or ready is kept. */
  loadGridFsBuckets(connectionId: string, database: string): Promise<void>;
  /** Reloads the buckets of a database and tells the open GridFS panels to reload their files. */
  refreshGridFs(connectionId: string, database: string): Promise<void>;
  setGridFsDialog(dialog: GridFsDialogState | undefined): void;
  /** Starts an upload of a file the user chose and records it. Resolves with the transfer id. */
  startGridFsUpload(input: GridFsStartUploadCall): Promise<string>;
  startGridFsDownload(input: GridFsStartDownloadCall): Promise<string>;
  /** Shows the open dialog for one file and starts its upload. Resolves undefined on cancel. */
  uploadGridFsFile(
    connectionId: string,
    database: string,
    bucket: string,
  ): Promise<string | undefined>;
  loadDocker(): Promise<void>;
  refreshDockerStatus(): Promise<void>;
  /** Turns the 10 second container poll on or off in the main process. */
  watchDocker(enabled: boolean): Promise<void>;
  /** Connects a container. Rejects with the AppError the main process returned. */
  connectContainer(containerId: string): Promise<void>;
  /** Tests the typed credentials, saves them on the container's profile and connects. Throws on a failed test. */
  connectContainerWithCredentials(input: {
    readonly containerId: string;
    readonly username: string;
    readonly password: string;
    readonly authSource: string;
  }): Promise<void>;
  disconnectContainer(containerId: string): Promise<void>;
  setDockerAutoConnect(enabled: boolean): Promise<void>;
  setSettingsOpen(open: boolean): void;
  setShortcutsOpen(open: boolean): void;
  /** Reads the saved settings and refreshes the cached theme and idle lock minutes. */
  loadSettings(): Promise<void>;
  /** Saves a settings patch. The theme and idle lock follow the saved values. */
  updateSettings(patch: SettingsPatch): Promise<Settings>;
  /** Clears the saved dockview layout. The shell rebuilds the default panels. */
  resetLayout(): Promise<void>;
  /** Deletes every saved history entry. */
  clearHistory(): Promise<void>;
  refreshUpdates(): Promise<void>;
  checkForUpdates(): Promise<void>;
  downloadUpdate(): Promise<void>;
  installUpdate(): Promise<void>;
  dismissUpdate(version: string): Promise<void>;
  applyEvent(event: RpcEvent): void;
  setTransferDialog(dialog: TransferDialogState): void;
  /** Starts an import and records it. Resolves with the transfer id. */
  startTransferImport(input: StartImportInput): Promise<string>;
  startTransferExport(input: StartExportInput): Promise<string>;
  cancelTransfer(transferId: string): Promise<void>;
  /** Replaces the transfers with the list the backend holds, for example after a reload. */
  refreshTransfers(): Promise<void>;
}

export type AppState = AppData & AppActions;
export type AppStore = StoreApi<AppState>;

const SESSION_RESET: Pick<
  AppData,
  | 'replicaSets'
  | 'connections'
  | 'statuses'
  | 'docker'
  | 'expanded'
  | 'databases'
  | 'collections'
  | 'monitors'
  | 'dashboards'
  | 'selection'
  | 'dialog'
  | 'managerOpen'
  | 'managementDialog'
  | 'panelRequest'
  | 'validationField'
  | 'settingsOpen'
  | 'settings'
  | 'editors'
  | 'transfers'
  | 'transferDialog'
  | 'gridfsBuckets'
  | 'gridfsDialog'
  | 'explainPanels'
  | 'explainFocus'
> = {
  connections: { state: 'loading' },
  statuses: {},
  docker: { status: undefined, containers: { state: 'loading' }, autoConnect: false },
  expanded: {},
  databases: {},
  replicaSets: {},
  collections: {},
  monitors: {},
  dashboards: {},
  selection: undefined,
  dialog: { kind: 'closed' },
  managerOpen: false,
  managementDialog: undefined,
  panelRequest: undefined,
  validationField: undefined,
  settingsOpen: false,
  settings: undefined,
  editors: EMPTY_EDITORS,
  transfers: {},
  transferDialog: { kind: 'closed' },
  gridfsBuckets: {},
  gridfsDialog: undefined,
  explainPanels: {},
  explainFocus: undefined,
};

/** Replaced by the first state the backend reports. */
const NO_UPDATE_STATE: UpdateState = { phase: 'idle', current: '', canInstall: false };

const INITIAL_DATA: AppData = {
  vault: 'loading',
  catalogRevision: 0,
  gridfsRevision: 0,
  ...SESSION_RESET,
  shortcutsOpen: false,
  lockReason: undefined,
  theme: 'dark',
  idleLockMinutes: 30,
  layoutRevision: 0,
  updates: NO_UPDATE_STATE,
};

/**
 * Drops the cached catalog that a change touched. Without a database the whole connection goes.
 * A database without a collection drops the database list and its collections. A collection drops
 * only that database's collections.
 */
function withoutCatalogScope(
  data: Pick<AppData, 'databases' | 'collections' | 'replicaSets'>,
  scope: {
    readonly connectionId: string;
    readonly database?: string | undefined;
    readonly collection?: string | undefined;
  },
): Pick<AppData, 'databases' | 'collections' | 'replicaSets'> {
  if (scope.database === undefined) {
    return withoutConnectionCatalog(data, scope.connectionId);
  }
  const key = catalogKey(scope.connectionId, scope.database);
  const databases =
    scope.collection === undefined
      ? Object.fromEntries(
          Object.entries(data.databases).filter(([id]) => id !== scope.connectionId),
        )
      : data.databases;
  return {
    databases,
    collections: Object.fromEntries(
      Object.entries(data.collections).filter(([catalog]) => catalog !== key),
    ),
    replicaSets: data.replicaSets,
  };
}

function withoutConnectionCatalog(
  data: Pick<AppData, 'databases' | 'collections' | 'replicaSets'>,
  connectionId: string,
): Pick<AppData, 'databases' | 'collections' | 'replicaSets'> {
  const prefix = `${connectionId}/`;
  return {
    databases: Object.fromEntries(
      Object.entries(data.databases).filter(([key]) => key !== connectionId),
    ),
    collections: Object.fromEntries(
      Object.entries(data.collections).filter(([key]) => !key.startsWith(prefix)),
    ),
    replicaSets: Object.fromEntries(
      Object.entries(data.replicaSets).filter(([key]) => key !== connectionId),
    ),
  };
}

/**
 * Creates the app store for one backend. Plain zustand, no React, so tests can drive it
 * directly with the mock api.
 */
export function createAppStore(api: UiApi, initial: Partial<AppData> = {}): AppStore {
  const { rpc } = api;
  // The cache lets the locked screens use the chosen theme before the settings can be read.
  const cached = readCachedPreferences();
  // Outside the state on purpose: these only matter to in-flight calls, not to rendering.
  const monitorGenerations = new Map<string, number>();
  // Pending saves and in-flight reads per connection. Like the generations, they stay out of state.
  const dashboardSaves = new Map<string, ReturnType<typeof setTimeout>>();
  const dashboardReads = new Set<string>();
  // Changes made before the saved layout was read. They replay on top of it once it loads.
  const pendingDashboardChanges = new Map<string, LayoutChange[]>();

  const store = createStore<AppState>()((set, get) => {
    const editorActions = createEditorActions({
      rpc,
      get: () => get(),
      update: (update) => set((state) => ({ editors: update(state.editors) })),
    });
    function clearSession(): void {
      set(SESSION_RESET);
      editorActions.forgetRestored();
    }

    /** Stores the settings the UI reads and keeps the cached copy for the locked screens. */
    function applySettings(settings: Settings): void {
      set({
        settings,
        theme: settings.theme,
        idleLockMinutes: settings.idleLockMinutes,
      });
      writeCachedPreferences({ theme: settings.theme, idleLockMinutes: settings.idleLockMinutes });
    }

    function setStatus(id: string, status: ConnectionStatus): void {
      set((state) => ({ statuses: { ...state.statuses, [id]: status } }));
    }

    /**
     * A saved Docker connection whose server rejected the stored credentials gets the same
     * credentials dialog as a container row, so the user can fix them in place.
     */
    function offerDockerCredentials(connectionId: string, status: ConnectionStatus): void {
      if (status.state !== 'error' || status.error.code !== 'AUTH_FAILED') {
        return;
      }
      const connections = get().connections;
      const profile =
        connections.state === 'ready'
          ? connections.data.find((item) => item.id === connectionId)
          : undefined;
      if (profile?.source !== 'docker' || profile.dockerContainerId === undefined) {
        return;
      }
      const containers = get().docker.containers;
      const container =
        containers.state === 'ready'
          ? containers.data.find((item) => item.id === profile.dockerContainerId)
          : undefined;
      useDockerCredentialsStore.getState().open({
        containerId: profile.dockerContainerId,
        containerName: container?.name ?? profile.name,
        hint: container?.hasCredentials === true ? 'envFound' : 'noEnv',
      });
    }

    /**
     * Each start and stop takes a new number. A start that resolves after a later number has been
     * issued does not apply its result, so a late start cannot resurrect a stopped sampler.
     */
    function bumpMonitorGeneration(connectionId: string): number {
      const next = (monitorGenerations.get(connectionId) ?? 0) + 1;
      monitorGenerations.set(connectionId, next);
      return next;
    }

    function updateMonitor(connectionId: string, update: (view: MonitorView) => MonitorView): void {
      set((state) => ({
        monitors: {
          ...state.monitors,
          [connectionId]: update(state.monitors[connectionId] ?? EMPTY_MONITOR_VIEW),
        },
      }));
    }

    function updateDashboardView(
      connectionId: string,
      update: (view: DashboardView) => DashboardView,
    ): void {
      set((state) => ({
        dashboards: {
          ...state.dashboards,
          [connectionId]: update(state.dashboards[connectionId] ?? EMPTY_DASHBOARD_VIEW),
        },
      }));
    }

    /**
     * Applies a layout change to what the user sees now. Once the saved layout is read, the change
     * saves after a quiet period. Before that, the change waits and replays on the saved layout.
     */
    function changeDashboard(connectionId: string, change: LayoutChange): void {
      const view = get().dashboards[connectionId] ?? EMPTY_DASHBOARD_VIEW;
      const layout = change(view.layout);
      if (layout === view.layout) {
        return;
      }
      updateDashboardView(connectionId, (current) => ({ ...current, layout, notice: undefined }));
      if (view.loaded) {
        scheduleDashboardSave(connectionId);
      } else {
        pendingDashboardChanges.set(connectionId, [
          ...(pendingDashboardChanges.get(connectionId) ?? []),
          change,
        ]);
      }
    }

    function scheduleDashboardSave(connectionId: string): void {
      const pending = dashboardSaves.get(connectionId);
      if (pending !== undefined) {
        clearTimeout(pending);
      }
      dashboardSaves.set(
        connectionId,
        setTimeout(() => {
          dashboardSaves.delete(connectionId);
          void saveDashboard(connectionId);
        }, DASHBOARD_SAVE_DELAY_MS),
      );
    }

    async function saveDashboard(connectionId: string): Promise<void> {
      const view = get().dashboards[connectionId];
      if (view === undefined || !view.loaded) {
        return;
      }
      try {
        await rpc.layout.set({ key: dashboardLayoutKey(connectionId), value: view.layout });
        updateDashboardView(connectionId, (current) => ({ ...current, error: undefined }));
      } catch (error) {
        updateDashboardView(connectionId, (current) => ({
          ...current,
          error: toAppError(error),
        }));
      }
    }

    return {
      ...INITIAL_DATA,
      theme: cached.theme,
      idleLockMinutes: cached.idleLockMinutes,
      ...initial,
      ...editorActions,
      ...createExplainActions(rpc, set, get),

      async refreshVault() {
        try {
          const { state } = await rpc.vault.status();
          if (state !== 'unlocked') {
            clearSession();
          }
          set({ vault: state });
          if (state === 'unlocked') {
            // Settings load in the background, so the connection list is not held back.
            void get().loadSettings();
            await get().loadConnections();
          }
        } catch {
          set({ vault: 'failed' });
        }
      },

      async initialise(password) {
        await rpc.vault.initialise({ password });
        set({ vault: 'unlocked', lockReason: undefined });
        void get().loadSettings();
        await get().loadConnections();
      },

      async unlock(password) {
        await rpc.vault.unlock({ password });
        set({ vault: 'unlocked', lockReason: undefined });
        void get().loadSettings();
        await get().loadConnections();
      },

      async lock() {
        // Marked before the call, so the vault:locked event that follows reads as a manual lock.
        set({ lockReason: 'manual' });
        try {
          await rpc.vault.lock();
        } catch (error) {
          set({ lockReason: undefined });
          throw error;
        }
        clearSession();
        set({ vault: 'locked' });
      },

      async reset() {
        await rpc.vault.reset({ confirmation: 'DELETE' });
        clearSession();
        await get().refreshVault();
      },

      async loadConnections() {
        if (get().connections.state !== 'ready') {
          set({ connections: { state: 'loading' } });
        }
        try {
          const data = await rpc.connections.list();
          set({ connections: { state: 'ready', data } });
          for (const connection of data) {
            void editorActions.restoreEditors(connection.id);
          }
        } catch (error) {
          set({ connections: { state: 'error', error: toAppError(error) } });
        }
      },

      async createConnection(input) {
        const profile = await rpc.connections.create(input);
        await get().loadConnections();
        return profile;
      },

      async updateConnection(id, input) {
        const profile = await rpc.connections.update({
          id,
          patch: {
            ...input,
            color: input.color,
            tls: input.tls,
            readPreference: input.readPreference,
            connectTimeoutMs: input.connectTimeoutMs,
          },
        });
        get().refreshConnection(id);
        await get().loadConnections();
        return profile;
      },

      async removeConnection(id) {
        await rpc.connections.remove({ id });
        set((state) => ({
          statuses: Object.fromEntries(
            Object.entries(state.statuses).filter(([key]) => key !== id),
          ),
          ...withoutConnectionCatalog(state, id),
        }));
        await get().loadConnections();
      },

      testConnection(input) {
        return rpc.connections.test(input);
      },

      async connect(id) {
        if (get().statuses[id]?.state === 'connected') {
          return;
        }
        setStatus(id, { state: 'connecting' });
        try {
          const status = await rpc.connections.connect({ id });
          setStatus(id, status);
          offerDockerCredentials(id, status);
        } catch (error) {
          setStatus(id, { state: 'error', error: toAppError(error) });
        }
      },

      async disconnect(id) {
        await rpc.connections.disconnect({ id });
        setStatus(id, { state: 'disconnected' });
        set((state) => withoutConnectionCatalog(state, id));
      },

      async expandConnection(id) {
        get().setNodeExpanded(connectionNodeId(id), true);
        await get().connect(id);
      },

      setNodeExpanded(nodeId, open) {
        set((state) => ({ expanded: { ...state.expanded, [nodeId]: open } }));
      },

      async startMonitor(connectionId, intervalMs) {
        const generation = bumpMonitorGeneration(connectionId);
        const requested = intervalMs ?? get().monitors[connectionId]?.preferredIntervalMs;
        const config = await rpc.monitor.start({ connectionId, intervalMs: requested });
        const history = await rpc.monitor.samples({ connectionId });
        // A stop, a disconnect or a newer start that happened meanwhile wins over this result.
        if (generation !== monitorGenerations.get(connectionId)) {
          return;
        }
        if (get().statuses[connectionId]?.state !== 'connected') {
          return;
        }
        updateMonitor(connectionId, (view) => applyStarted(view, config, history));
      },

      async setMonitorInterval(connectionId, intervalMs) {
        const config = await rpc.monitor.setInterval({ connectionId, intervalMs });
        updateMonitor(connectionId, (view) => applyIntervalChange(view, config));
      },

      async loadDashboard(connectionId) {
        if (get().dashboards[connectionId]?.loaded === true || dashboardReads.has(connectionId)) {
          return;
        }
        dashboardReads.add(connectionId);
        try {
          const key = dashboardLayoutKey(connectionId);
          const { value } = await rpc.layout.get({ key });
          const stored = readStoredLayout(value);
          if (stored.state === 'invalid') {
            console.warn(`Dashboard layout ${key} is not valid and was reset: ${stored.summary}`);
          }
          // Edits made before the read finished replay on top of the stored layout, in order.
          const replay = pendingDashboardChanges.get(connectionId) ?? [];
          pendingDashboardChanges.delete(connectionId);
          const base = stored.state === 'valid' ? stored.layout : defaultDashboardLayout();
          const layout = replay.reduce((current, change) => change(current), base);
          updateDashboardView(connectionId, (view) => ({
            ...view,
            layout,
            loaded: true,
            error: undefined,
            notice: stored.state === 'invalid' ? RESET_NOTICE : undefined,
          }));
          if (replay.length > 0) {
            scheduleDashboardSave(connectionId);
          }
        } catch (error) {
          updateDashboardView(connectionId, (view) => ({ ...view, error: toAppError(error) }));
        } finally {
          dashboardReads.delete(connectionId);
        }
      },

      addDashboardPanel(connectionId, panel) {
        changeDashboard(connectionId, (layout) => addPanel(layout, panel));
      },

      removeDashboardPanel(connectionId, id) {
        changeDashboard(connectionId, (layout) => removePanel(layout, id));
      },

      moveDashboardPanel(connectionId, fromId, toId) {
        changeDashboard(connectionId, (layout) => movePanel(layout, fromId, toId));
      },

      resizeDashboardPanel(connectionId, id, size) {
        changeDashboard(connectionId, (layout) => resizePanel(layout, id, size));
      },

      resetDashboard(connectionId) {
        changeDashboard(connectionId, () => resetLayout());
      },

      async stopMonitor(connectionId) {
        bumpMonitorGeneration(connectionId);
        await rpc.monitor.stop({ connectionId });
        updateMonitor(connectionId, applyStopped);
      },

      async retryMonitor(connectionId) {
        try {
          await rpc.monitor.stop({ connectionId });
          await get().startMonitor(connectionId);
        } catch (error) {
          updateMonitor(connectionId, (view) => applyError(view, toAppError(error)));
        }
      },

      async loadDatabases(connectionId) {
        const current = get().databases[connectionId];
        if (current?.state === 'loading' || current?.state === 'ready') {
          return;
        }
        set((state) => ({
          databases: { ...state.databases, [connectionId]: { state: 'loading' } },
        }));
        try {
          const data = await rpc.databases.list({ connectionId });
          set((state) => ({
            databases: { ...state.databases, [connectionId]: { state: 'ready', data } },
          }));
        } catch (error) {
          set((state) => ({
            databases: {
              ...state.databases,
              [connectionId]: { state: 'error', error: toAppError(error) },
            },
          }));
        }
      },

      async loadReplicaSet(connectionId) {
        const current = get().replicaSets[connectionId];
        if (current?.state === 'loading' || current?.state === 'ready') {
          return;
        }
        set((state) => ({
          replicaSets: { ...state.replicaSets, [connectionId]: { state: 'loading' } },
        }));
        try {
          const data = await rpc.replication.getStatus({ connectionId });
          set((state) => ({
            replicaSets: { ...state.replicaSets, [connectionId]: { state: 'ready', data } },
          }));
        } catch (error) {
          set((state) => ({
            replicaSets: {
              ...state.replicaSets,
              [connectionId]: { state: 'error', error: toAppError(error) },
            },
          }));
        }
      },

      async connectDirectly(connectionId, host) {
        const profile = await rpc.connections.createDirect({ id: connectionId, host });
        await get().loadConnections();
        await get().expandConnection(profile.id);
      },

      async loadCollections(connectionId, database) {
        const key = catalogKey(connectionId, database);
        const current = get().collections[key];
        if (current?.state === 'loading' || current?.state === 'ready') {
          return;
        }
        set((state) => ({ collections: { ...state.collections, [key]: { state: 'loading' } } }));
        try {
          const data = await rpc.collections.list({ connectionId, database });
          set((state) => ({
            collections: { ...state.collections, [key]: { state: 'ready', data } },
          }));
        } catch (error) {
          set((state) => ({
            collections: {
              ...state.collections,
              [key]: { state: 'error', error: toAppError(error) },
            },
          }));
        }
      },

      refreshConnection(id) {
        set((state) => withoutConnectionCatalog(state, id));
      },

      select(selection) {
        set({ selection });
      },

      setDialog(dialog) {
        set({ dialog });
      },

      setManagerOpen(open) {
        set({ managerOpen: open });
      },

      setManagementDialog(dialog) {
        set({ managementDialog: dialog });
      },

      requestPanel(request) {
        set({ panelRequest: request });
      },

      clearPanelRequest() {
        set({ panelRequest: undefined });
      },

      requestValidationField(request) {
        set({ validationField: request });
      },

      clearValidationField() {
        set({ validationField: undefined });
      },

      refreshDatabase(connectionId, database) {
        const key = catalogKey(connectionId, database);
        set((state) => ({
          collections: Object.fromEntries(
            Object.entries(state.collections).filter(([catalog]) => catalog !== key),
          ),
        }));
      },

      async loadGridFsBuckets(connectionId, database) {
        const key = catalogKey(connectionId, database);
        const current = get().gridfsBuckets[key];
        if (current?.state === 'loading' || current?.state === 'ready') {
          return;
        }
        set((state) => ({
          gridfsBuckets: { ...state.gridfsBuckets, [key]: { state: 'loading' } },
        }));
        try {
          const data = await rpc.gridfs.listBuckets({ connectionId, database });
          set((state) => ({
            gridfsBuckets: { ...state.gridfsBuckets, [key]: { state: 'ready', data } },
          }));
        } catch (error) {
          set((state) => ({
            gridfsBuckets: {
              ...state.gridfsBuckets,
              [key]: { state: 'error', error: toAppError(error) },
            },
          }));
        }
      },

      async refreshGridFs(connectionId, database) {
        const key = catalogKey(connectionId, database);
        set((state) => ({
          gridfsBuckets: Object.fromEntries(
            Object.entries(state.gridfsBuckets).filter(([bucketKey]) => bucketKey !== key),
          ),
          gridfsRevision: state.gridfsRevision + 1,
        }));
        await get().loadGridFsBuckets(connectionId, database);
      },

      setGridFsDialog(dialog) {
        set({ gridfsDialog: dialog });
      },

      async startGridFsUpload(input) {
        const { transferId } = await rpc.gridfs.startUpload(input);
        set((state) => ({
          transfers: registerTransfer(state.transfers, {
            transferId,
            kind: 'gridfs-upload',
            connectionId: input.connectionId,
            database: input.database,
            collection: input.bucket,
            path: input.path,
          }),
        }));
        return transferId;
      },

      async startGridFsDownload(input) {
        const { transferId } = await rpc.gridfs.startDownload(input);
        set((state) => ({
          transfers: registerTransfer(state.transfers, {
            transferId,
            kind: 'gridfs-download',
            connectionId: input.connectionId,
            database: input.database,
            collection: input.bucket,
            path: input.path,
          }),
        }));
        return transferId;
      },

      async uploadGridFsFile(connectionId, database, bucket) {
        const picked = await rpc.app.showOpenDialog({ title: `Upload to ${bucket}`, filters: [] });
        if (picked.path === undefined) {
          return undefined;
        }
        return get().startGridFsUpload({ connectionId, database, bucket, path: picked.path });
      },

      async loadDocker() {
        try {
          const status = await rpc.docker.status();
          const containers = status.available ? await rpc.docker.list() : [];
          const settings = await rpc.settings.get();
          set({
            docker: {
              status,
              containers: { state: 'ready', data: containers },
              autoConnect: settings.dockerAutoConnect,
            },
          });
          // Docker profiles show their live state, so their status is read on each load.
          const connections = get().connections;
          if (connections.state === 'ready') {
            for (const profile of connections.data) {
              if (profile.source === 'docker') {
                try {
                  setStatus(profile.id, await rpc.connections.status({ id: profile.id }));
                } catch {
                  // The row keeps its previous status. A failed read must not hide the containers.
                }
              }
            }
          }
        } catch (error) {
          set((state) => ({
            docker: { ...state.docker, containers: { state: 'error', error: toAppError(error) } },
          }));
        }
      },

      async refreshDockerStatus() {
        try {
          const status = await rpc.docker.status();
          set((state) => ({ docker: { ...state.docker, status } }));
        } catch {
          // The tree keeps its last status. The next poll or load asks again.
        }
      },

      async watchDocker(enabled) {
        try {
          await rpc.docker.watch({ enabled });
        } catch {
          // Without the poll the list only refreshes on load. Nothing else depends on it.
        }
      },

      async connectContainer(containerId) {
        const result = await rpc.docker.connect({ containerId });
        if ('kind' in result) {
          // The server wants a user name and password. The dialog takes them and connects.
          const containers = get().docker.containers;
          const name =
            containers.state === 'ready'
              ? (containers.data.find((item) => item.id === containerId)?.name ?? containerId)
              : containerId;
          useDockerCredentialsStore
            .getState()
            .open({ containerId, containerName: name, hint: result.hint });
          return;
        }
        setStatus(result.connectionId, result.status);
        await get().loadConnections();
      },

      async connectContainerWithCredentials(input) {
        const result = await rpc.docker.connectWithCredentials(input);
        setStatus(result.connectionId, result.status);
        await get().loadConnections();
      },

      async disconnectContainer(containerId) {
        await rpc.docker.disconnect({ containerId });
      },

      async setDockerAutoConnect(enabled) {
        const settings = await rpc.docker.setAutoConnect({ enabled });
        set((state) => ({
          docker: { ...state.docker, autoConnect: settings.dockerAutoConnect },
        }));
      },

      setSettingsOpen(open) {
        set({ settingsOpen: open });
      },

      setShortcutsOpen(open) {
        set({ shortcutsOpen: open });
      },

      async loadSettings() {
        try {
          const settings = await rpc.settings.get();
          applySettings(settings);
        } catch {
          // The cached theme stays in effect. The next load or save reads the settings again.
        }
      },

      async updateSettings(patch) {
        const saved = await rpc.settings.update(patch);
        applySettings(saved);
        return saved;
      },

      async resetLayout() {
        await rpc.layout.set({ key: DOCK_LAYOUT_KEY, value: null });
        set((state) => ({ layoutRevision: state.layoutRevision + 1 }));
      },

      async clearHistory() {
        await rpc.history.clear();
      },

      async refreshUpdates() {
        set({ updates: await rpc.updates.state() });
      },

      async checkForUpdates() {
        set({ updates: await rpc.updates.check() });
      },

      async downloadUpdate() {
        set({ updates: await rpc.updates.download() });
      },

      async installUpdate() {
        await rpc.updates.install();
      },

      async dismissUpdate(version) {
        set({ updates: await rpc.updates.dismiss({ version }) });
      },

      setTransferDialog(dialog) {
        set({ transferDialog: dialog });
      },

      async startTransferImport(input) {
        const { transferId } = await rpc.transfer.startImport(input);
        set((state) => ({
          transfers: registerTransfer(state.transfers, {
            transferId,
            kind: 'import',
            database: input.database,
            collection: input.collection,
            path: input.path,
          }),
        }));
        return transferId;
      },

      async startTransferExport(input) {
        const { transferId } = await rpc.transfer.startExport(input);
        set((state) => ({
          transfers: registerTransfer(state.transfers, {
            transferId,
            kind: 'export',
            database: input.database,
            collection: input.collection,
            path: input.path,
          }),
        }));
        return transferId;
      },

      async cancelTransfer(transferId) {
        await rpc.transfer.cancel({ transferId });
      },

      async refreshTransfers() {
        const list = await rpc.transfer.list();
        set((state) => ({ transfers: transfersFromList(list, state.transfers) }));
      },

      applyEvent(event) {
        if (event.type === 'shell:print') {
          editorActions.printLine(event.requestId, event.text);
          return;
        }
        if (event.type === 'shell:state') {
          editorActions.setRuntimeState(event.connectionId, event.state);
          return;
        }
        if (event.type === 'updates:state') {
          set({ updates: event.state });
          return;
        }
        if (event.type === 'vault:locked') {
          // A lock the user asked for is already marked. Any other lock came from the idle timer.
          set((state) => ({
            ...SESSION_RESET,
            vault: 'locked',
            lockReason: state.lockReason === 'manual' ? 'manual' : 'idle',
          }));
          return;
        }
        if (event.type === 'transfer:progress') {
          // Events after the vault locked belong to transfers that the lock has already cancelled.
          if (get().vault === 'unlocked') {
            set((state) => ({
              transfers: applyTransferProgress(state.transfers, event),
            }));
            // A finished GridFS job changed a bucket: its counts and its files are reloaded.
            const view = get().transfers[event.transferId];
            if (event.kind.startsWith('gridfs-') && event.progress.done) {
              set((state) => ({ gridfsRevision: state.gridfsRevision + 1 }));
              if (view?.connectionId !== undefined) {
                void get().refreshGridFs(view.connectionId, view.database);
              }
            }
          }
          return;
        }
        if (event.type === 'catalog:changed') {
          set((state) => ({
            ...withoutCatalogScope(state, event),
            catalogRevision: state.catalogRevision + 1,
          }));
          return;
        }
        if (event.type === 'docker:containers') {
          set((state) => ({
            docker: { ...state.docker, containers: { state: 'ready', data: event.containers } },
          }));
          void get().refreshDockerStatus();
          return;
        }
        // Change events belong to the change streams store.
        if (event.type === 'changes:event' || event.type === 'changes:state') {
          return;
        }
        // Auto connect creates profiles without a call from the UI, so the list is refreshed here.
        const connections = get().connections;
        const known =
          connections.state === 'ready' &&
          connections.data.some((connection) => connection.id === event.connectionId);
        if (!known) {
          void get().loadConnections();
        }
        if (event.type === 'monitor:sample') {
          updateMonitor(event.connectionId, (view) => applySample(view, event.sample));
          return;
        }
        if (event.type === 'monitor:error') {
          updateMonitor(event.connectionId, (view) => applyError(view, event.error));
        }
        // Profiler events belong to the profiler store.
        if (event.type !== 'connection:status') {
          return;
        }
        setStatus(event.connectionId, event.status);
        if (event.status.state !== 'connected') {
          bumpMonitorGeneration(event.connectionId);
          set((state) => withoutConnectionCatalog(state, event.connectionId));
          set((state) => ({
            gridfsBuckets: Object.fromEntries(
              Object.entries(state.gridfsBuckets).filter(
                ([key]) => !key.startsWith(`${event.connectionId}/`),
              ),
            ),
          }));
          // The server stops the sampler on disconnect. The view keeps its samples and loses config.
          if (get().monitors[event.connectionId] !== undefined) {
            updateMonitor(event.connectionId, applyStopped);
          }
        }
      },
    };
  });
  persistEditorTabs(store);
  return store;
}

const PERSIST_DELAY_MS = 500;

/**
 * Saves the tabs of each connection whose saved part changed. Saves wait a short time, so typing
 * sends one write per pause rather than one per key.
 */
function persistEditorTabs(store: AppStore): void {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  store.subscribe((state, previous) => {
    if (state.editors === previous.editors) {
      return;
    }
    const connectionIds = new Set([
      ...Object.values(state.editors.tabs).map((tab) => tab.connectionId),
      ...Object.values(previous.editors.tabs).map((tab) => tab.connectionId),
    ]);
    for (const connectionId of connectionIds) {
      const now = JSON.stringify(savedTabsOf(state.editors, connectionId));
      const before = JSON.stringify(savedTabsOf(previous.editors, connectionId));
      if (now === before) {
        continue;
      }
      clearTimeout(timers.get(connectionId));
      timers.set(
        connectionId,
        setTimeout(() => {
          timers.delete(connectionId);
          void store.getState().persistEditors(connectionId);
        }, PERSIST_DELAY_MS),
      );
    }
  });
}
