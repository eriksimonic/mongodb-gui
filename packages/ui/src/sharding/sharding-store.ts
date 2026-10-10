import type {
  BalancerStatus,
  RpcClient,
  ShardCollectionOutput,
  ShardCollectionSummary,
  ShardDistribution,
  ShardingOverview,
} from '@mongo-gui/core';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { errorText } from '../components/notify-error';

/** The sharding part of the RPC client. */
export type ShardingClient = RpcClient['sharding'];

/** One collection and the key the user built for it. The key is Extended JSON text. */
export interface ShardCollectionTarget {
  readonly database: string;
  readonly collection: string;
  readonly keyEjson: string;
  readonly unique?: boolean | undefined;
  readonly presplitHashedZones?: boolean | undefined;
}

export interface ShardingState {
  /** The last overview. Undefined until the first load answers. */
  readonly overview: ShardingOverview | undefined;
  readonly loading: boolean;
  /** The text of the last failed load. Cleared by the next successful load. */
  readonly loadError: string | undefined;
  load(): Promise<void>;
  /** Starts or stops the balancer, then reloads the overview. Resolves with the new status. */
  setBalancer(enabled: boolean): Promise<BalancerStatus>;
  enableSharding(database: string): Promise<void>;
  /** The dry run. The server runs nothing. */
  previewShardCollection(target: ShardCollectionTarget): Promise<ShardCollectionSummary>;
  /** Shards the collection. The server runs only the confirmed call. */
  applyShardCollection(target: ShardCollectionTarget): Promise<ShardCollectionOutput>;
  distribution(namespace: string): Promise<ShardDistribution>;
}

export type ShardingStore = StoreApi<ShardingState>;

/**
 * The state of one sharding panel. Each change goes to the server first, and a change that the
 * server accepts reloads the overview. A failed change throws its text to the caller.
 */
export function createShardingStore(connectionId: string, client: ShardingClient): ShardingStore {
  return createStore<ShardingState>()((set, get) => {
    async function reload(): Promise<void> {
      await get().load();
    }

    return {
      overview: undefined,
      loading: false,
      loadError: undefined,

      async load() {
        set({ loading: true });
        try {
          const overview = await client.overview({ connectionId });
          set({ overview, loadError: undefined });
        } catch (failure) {
          set({ loadError: errorText(failure) });
        } finally {
          set({ loading: false });
        }
      },

      async setBalancer(enabled) {
        const status = await client.setBalancer({ connectionId, enabled });
        await reload();
        return status;
      },

      async enableSharding(database) {
        await client.enableSharding({ connectionId, database });
        await reload();
      },

      async previewShardCollection(target) {
        const { summary } = await client.shardCollection({
          connectionId,
          ...target,
          confirmed: false,
        });
        return summary;
      },

      async applyShardCollection(target) {
        return client.shardCollection({ connectionId, ...target, confirmed: true });
      },

      async distribution(namespace) {
        return client.collectionDistribution({ connectionId, namespace });
      },
    };
  });
}
