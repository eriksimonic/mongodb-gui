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
  type VaultStatus,
} from '@mongo-gui/core';
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { UiApi } from '../api/ui-api';
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
  readonly selection: Selection | undefined;
  readonly dialog: DialogState;
  readonly managerOpen: boolean;
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
  loadDatabases(connectionId: string): Promise<void>;
  loadCollections(connectionId: string, database: string): Promise<void>;
  /** Drops the cached databases and collections of a connection. Open nodes reload them. */
  refreshConnection(id: string): void;
  select(selection: Selection | undefined): void;
  setDialog(dialog: DialogState): void;
  setManagerOpen(open: boolean): void;
  loadDocker(): Promise<void>;
  refreshDockerStatus(): Promise<void>;
  /** Turns the 10 second container poll on or off in the main process. */
  watchDocker(enabled: boolean): Promise<void>;
  /** Connects a container. Rejects with the AppError the main process returned. */
  connectContainer(containerId: string): Promise<void>;
  disconnectContainer(containerId: string): Promise<void>;
  setDockerAutoConnect(enabled: boolean): Promise<void>;
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
  | 'selection'
  | 'dialog'
  | 'managerOpen'
> = {
  connections: { state: 'loading' },
  statuses: {},
  docker: { status: undefined, containers: { state: 'loading' }, autoConnect: false },
  expanded: {},
  databases: {},
  collections: {},
  selection: undefined,
  dialog: { kind: 'closed' },
  managerOpen: false,
};

const INITIAL_DATA: AppData = { vault: 'loading', ...SESSION_RESET };

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

  return createStore<AppState>()((set, get) => {
    function clearSession(): void {
      set(SESSION_RESET);
    }

    function setStatus(id: string, status: ConnectionStatus): void {
      set((state) => ({ statuses: { ...state.statuses, [id]: status } }));
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

      applyEvent(event) {
        if (event.type === 'vault:locked') {
          clearSession();
          set({ vault: 'locked' });
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
        setStatus(event.connectionId, event.status);
        if (event.status.state !== 'connected') {
          set((state) => withoutConnectionCatalog(state, event.connectionId));
        }
      },
    };
  });
}
