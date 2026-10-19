import type { RpcClient, StorageCollections, StorageDatabases } from '@mongo-gui/core';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { errorText } from '../kit/notify-error';

/** The connection the panel reads from. */
export interface StorageTarget {
  readonly connectionId: string;
}

/** The part of the RPC client the panel uses. */
export type StorageClient = RpcClient['diagnostics'];

/** One read. `data` keeps the last good answer while a reload runs. `loadedAt` is a Date.now() stamp. */
export interface StorageRead<T> {
  readonly data: T | undefined;
  readonly loading: boolean;
  /** The text of the last failed read. Cleared by the next successful read. */
  readonly error: string | undefined;
  readonly loadedAt: number | undefined;
}

const EMPTY: StorageRead<never> = {
  data: undefined,
  loading: false,
  error: undefined,
  loadedAt: undefined,
};

export interface StorageState {
  readonly databases: StorageRead<StorageDatabases>;
  /** Keyed by database name. Filled when a database is opened. */
  readonly collections: Readonly<Record<string, StorageRead<StorageCollections>>>;
  /** Reads the database list once. A loaded list is kept until refresh. */
  loadDatabases(): Promise<void>;
  /** Reads the collections of one database once. A loaded database is kept until refresh. */
  loadCollections(database: string): Promise<void>;
  /** Drops the cache, reads the database list again, and reads one database if given. */
  refresh(database?: string): Promise<void>;
}

export type StorageStore = StoreApi<StorageState>;

/**
 * The cache of one storage panel. Each read stores its own answer or error, so a failing
 * database does not hide the others. Reads never reject.
 */
export function createStorageStore(target: StorageTarget, client: StorageClient): StorageStore {
  const { connectionId } = target;

  return createStore<StorageState>()((set, get) => {
    async function readDatabases(): Promise<void> {
      set((state) => ({ databases: { ...state.databases, loading: true } }));
      try {
        const data = await client.storageDatabases({ connectionId });
        set({ databases: { data, loading: false, error: undefined, loadedAt: Date.now() } });
      } catch (failure) {
        set((state) => ({
          databases: { ...state.databases, loading: false, error: errorText(failure) },
        }));
      }
    }

    async function readCollections(database: string): Promise<void> {
      set((state) => ({
        collections: {
          ...state.collections,
          [database]: { ...(state.collections[database] ?? EMPTY), loading: true },
        },
      }));
      try {
        const data = await client.storageCollections({ connectionId, database });
        set((state) => ({
          collections: {
            ...state.collections,
            [database]: { data, loading: false, error: undefined, loadedAt: Date.now() },
          },
        }));
      } catch (failure) {
        set((state) => ({
          collections: {
            ...state.collections,
            [database]: {
              ...(state.collections[database] ?? EMPTY),
              loading: false,
              error: errorText(failure),
            },
          },
        }));
      }
    }

    return {
      databases: EMPTY,
      collections: {},

      async loadDatabases() {
        const current = get().databases;
        if (current.data !== undefined || current.loading) {
          return;
        }
        await readDatabases();
      },

      async loadCollections(database) {
        const current = get().collections[database];
        if (current?.data !== undefined || current?.loading) {
          return;
        }
        await readCollections(database);
      },

      async refresh(database) {
        // The open database keeps its old answer while it reloads, so the view stays on its level.
        const open = database === undefined ? undefined : get().collections[database];
        set({
          collections: database !== undefined && open !== undefined ? { [database]: open } : {},
        });
        await readDatabases();
        if (database !== undefined) {
          await readCollections(database);
        }
      },
    };
  });
}
