import {
  toAppError,
  type AppError,
  type CollectionInfo,
  type ConnectionProfile,
  type ConnectionProfileInput,
  type ConnectionProfileSummary,
  type ConnectionStatus,
  type ConnectionTestResult,
  type DatabaseInfo,
  type DockerMongoContainerSummary,
  type DockerStatus,
  type RpcEvent,
  type UpdateState,
  type VaultStatus,
} from '@mongo-gui/core';
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { UiApi } from '../api/ui-api';
import {
  applyError,
  applyIntervalChange,
  applySample,
  applyStarted,
  applyStopped,
  EMPTY_MONITOR_VIEW,
  type MonitorView,
} from './monitor-state';
import { catalogKey, connectionNodeId } from './node-ids';

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
  | { readonly kind: 'dropDatabase'; readonly connectionId: string; readonly database: string };

/** A request to show a collection panel. The shell opens or focuses it, then clears the request. */
export interface PanelRequest {
  readonly panel: 'indexes' | 'validation' | 'documents';
  readonly connectionId: string;
  readonly database: string;
  readonly collection: string;
}

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
  /** Monitor samples and sampler state per connection, fed by monitor events. */
  readonly monitors: Readonly<Record<string, MonitorView>>;
  readonly selection: Selection | undefined;
  readonly dialog: DialogState;
  readonly managerOpen: boolean;
  readonly managementDialog: ManagementDialog | undefined;
  readonly panelRequest: PanelRequest | undefined;
  /** Counts catalog:changed events. Panels reload when it moves. */
  readonly catalogRevision: number;
  readonly settingsOpen: boolean;
  /** The updater state, pushed by the backend and read on start. */
  readonly updates: UpdateState;
}

export interface AppActions {
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
  /** Stops the server sampler and clears the sampler state. Samples are kept for the view. */
  stopMonitor(connectionId: string): Promise<void>;
  loadDatabases(connectionId: string): Promise<void>;
  loadCollections(connectionId: string, database: string): Promise<void>;
  /** Drops the cached databases and collections of a connection. Open nodes reload them. */
  refreshConnection(id: string): void;
  select(selection: Selection | undefined): void;
  setDialog(dialog: DialogState): void;
  setManagerOpen(open: boolean): void;
  setManagementDialog(dialog: ManagementDialog | undefined): void;
  /** Asks the shell to show a collection panel. */
  requestPanel(request: PanelRequest): void;
  clearPanelRequest(): void;
  /** Drops the cached collections of one database. The open tree nodes reload them. */
  refreshDatabase(connectionId: string, database: string): void;
  loadDocker(): Promise<void>;
  refreshDockerStatus(): Promise<void>;
  /** Turns the 10 second container poll on or off in the main process. */
  watchDocker(enabled: boolean): Promise<void>;
  /** Connects a container. Rejects with the AppError the main process returned. */
  connectContainer(containerId: string): Promise<void>;
  disconnectContainer(containerId: string): Promise<void>;
  setDockerAutoConnect(enabled: boolean): Promise<void>;
  setSettingsOpen(open: boolean): void;
  refreshUpdates(): Promise<void>;
  checkForUpdates(): Promise<void>;
  downloadUpdate(): Promise<void>;
  installUpdate(): Promise<void>;
  dismissUpdate(version: string): Promise<void>;
  applyEvent(event: RpcEvent): void;
}

export type AppState = AppData & AppActions;
export type AppStore = StoreApi<AppState>;

const SESSION_RESET: Pick<
  AppData,
  | 'connections'
  | 'statuses'
  | 'docker'
  | 'expanded'
  | 'databases'
  | 'collections'
  | 'monitors'
  | 'selection'
  | 'dialog'
  | 'managerOpen'
  | 'managementDialog'
  | 'panelRequest'
  | 'settingsOpen'
> = {
  connections: { state: 'loading' },
  statuses: {},
  docker: { status: undefined, containers: { state: 'loading' }, autoConnect: false },
  expanded: {},
  databases: {},
  collections: {},
  monitors: {},
  selection: undefined,
  dialog: { kind: 'closed' },
  managerOpen: false,
  managementDialog: undefined,
  panelRequest: undefined,
  settingsOpen: false,
};

/** Replaced by the first state the backend reports. */
const NO_UPDATE_STATE: UpdateState = { phase: 'idle', current: '', canInstall: false };

const INITIAL_DATA: AppData = {
  vault: 'loading',
  catalogRevision: 0,
  ...SESSION_RESET,
  updates: NO_UPDATE_STATE,
};

/**
 * Drops the cached catalog that a change touched. Without a database the whole connection goes.
 * A database without a collection drops the database list and its collections. A collection drops
 * only that database's collections.
 */
function withoutCatalogScope(
  data: Pick<AppData, 'databases' | 'collections'>,
  scope: {
    readonly connectionId: string;
    readonly database?: string | undefined;
    readonly collection?: string | undefined;
  },
): Pick<AppData, 'databases' | 'collections'> {
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
  };
}

function withoutConnectionCatalog(
  data: Pick<AppData, 'databases' | 'collections'>,
  connectionId: string,
): Pick<AppData, 'databases' | 'collections'> {
  const prefix = `${connectionId}/`;
  return {
    databases: Object.fromEntries(
      Object.entries(data.databases).filter(([key]) => key !== connectionId),
    ),
    collections: Object.fromEntries(
      Object.entries(data.collections).filter(([key]) => !key.startsWith(prefix)),
    ),
  };
}

/**
 * Creates the app store for one backend. Plain zustand, no React, so tests can drive it
 * directly with the mock api.
 */
export function createAppStore(api: UiApi, initial: Partial<AppData> = {}): AppStore {
  const { rpc } = api;
  // Outside the state on purpose: these only matter to in-flight calls, not to rendering.
  const monitorGenerations = new Map<string, number>();

  return createStore<AppState>()((set, get) => {
    function clearSession(): void {
      set(SESSION_RESET);
    }

    function setStatus(id: string, status: ConnectionStatus): void {
      set((state) => ({ statuses: { ...state.statuses, [id]: status } }));
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

    return {
      ...INITIAL_DATA,
      ...initial,

      async refreshVault() {
        try {
          const { state } = await rpc.vault.status();
          if (state !== 'unlocked') {
            clearSession();
          }
          set({ vault: state });
          if (state === 'unlocked') {
            await get().loadConnections();
          }
        } catch {
          set({ vault: 'failed' });
        }
      },

      async initialise(password) {
        await rpc.vault.initialise({ password });
        set({ vault: 'unlocked' });
        await get().loadConnections();
      },

      async unlock(password) {
        await rpc.vault.unlock({ password });
        set({ vault: 'unlocked' });
        await get().loadConnections();
      },

      async lock() {
        await rpc.vault.lock();
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
          setStatus(id, await rpc.connections.connect({ id }));
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

      refreshDatabase(connectionId, database) {
        const key = catalogKey(connectionId, database);
        set((state) => ({
          collections: Object.fromEntries(
            Object.entries(state.collections).filter(([catalog]) => catalog !== key),
          ),
        }));
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

      applyEvent(event) {
        if (event.type === 'updates:state') {
          set({ updates: event.state });
          return;
        }
        if (event.type === 'vault:locked') {
          clearSession();
          set({ vault: 'locked' });
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
          // The server stops the sampler on disconnect. The view keeps its samples and loses config.
          if (get().monitors[event.connectionId] !== undefined) {
            updateMonitor(event.connectionId, applyStopped);
          }
        }
      },
    };
  });
}
