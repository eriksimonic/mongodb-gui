import {
  AppErrorException,
  appError,
  toAppError,
  type AppError,
  type InitiateInput,
  type ReconfigChange,
  type ReconfigPlan,
  type ReplicaSetConfig,
  type ReplicaSetStatus,
} from '@mongo-gui/core';
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { UiApi } from '../api/ui-api';

/** A reconfiguration the dialog has planned and may apply. */
export interface PendingPlan {
  readonly planId: string;
  readonly plan: ReconfigPlan;
}

export interface ReplicationState {
  readonly connectionId: string;
  readonly status: ReplicaSetStatus | undefined;
  readonly config: ReplicaSetConfig | undefined;
  /** True while a read is in flight. */
  readonly loading: boolean;
  /** The last read error. The previous status stays on screen beneath it. */
  readonly error: AppError | undefined;
  readonly autoRefresh: boolean;
  readonly pending: PendingPlan | undefined;
  /** Set when an apply failed because the configuration moved after the plan was made. */
  readonly stale: boolean;
}

export interface ReplicationActions {
  refresh(): Promise<void>;
  setAutoRefresh(enabled: boolean): void;
  /** Steps the connected primary down. Resolves with the member that took over. */
  stepDown(seconds: number): Promise<string>;
  freeze(seconds: number): Promise<void>;
  /** Plans a change and keeps the plan for apply. Throws when the planner cannot run. */
  planChange(change: ReconfigChange): Promise<ReconfigPlan>;
  /** Applies the pending plan. A stale plan is refused and the store notes the version moved. */
  applyPlan(): Promise<void>;
  clearPlan(): void;
  initiate(input: InitiateInput): Promise<void>;
}

export type ReplicationStore = StoreApi<ReplicationState & ReplicationActions>;

export const AUTO_REFRESH_MS = 5000;

/**
 * The state of one replication panel. The panel calls the replication namespace through the api.
 * Every action that changes the set refreshes the reads afterwards.
 */
export function createReplicationStore(api: UiApi, connectionId: string): ReplicationStore {
  const { rpc } = api;

  return createStore<ReplicationState & ReplicationActions>()((set, get) => {
    async function readSet(): Promise<void> {
      const [status, config] = await Promise.all([
        rpc.replication.getStatus({ connectionId }),
        rpc.replication.getConfig({ connectionId }),
      ]);
      set({ status, config, error: undefined });
    }

    return {
      connectionId,
      status: undefined,
      config: undefined,
      loading: false,
      error: undefined,
      autoRefresh: false,
      pending: undefined,
      stale: false,

      async refresh() {
        set({ loading: true });
        try {
          await readSet();
        } catch (failure) {
          set({ error: toAppError(failure) });
        } finally {
          set({ loading: false });
        }
      },

      setAutoRefresh(enabled) {
        set({ autoRefresh: enabled });
      },

      async stepDown(seconds) {
        const { primary } = await rpc.replication.stepDown({
          connectionId,
          stepDownSeconds: seconds,
        });
        await get().refresh();
        return primary;
      },

      async freeze(seconds) {
        await rpc.replication.freeze({ connectionId, seconds });
        await get().refresh();
      },

      async planChange(change) {
        const { planId, plan } = await rpc.replication.planReconfig({ connectionId, change });
        set({ pending: { planId, plan }, stale: false });
        return plan;
      },

      async applyPlan() {
        const pending = get().pending;
        if (pending === undefined) {
          throw new AppErrorException(appError('VALIDATION', 'Plan the change before applying it'));
        }
        try {
          await rpc.replication.applyReconfig({
            connectionId,
            planId: pending.planId,
            expectedVersion: pending.plan.current.version,
          });
        } catch (failure) {
          // The adapter names the version it found. The store also checks it, so the dialog can
          // offer a refresh whatever the wording of the error.
          const stale = await configMoved(pending.plan.current.version);
          set({ pending: undefined, stale });
          throw failure;
        }
        set({ pending: undefined, stale: false });
        await get().refresh();
      },

      clearPlan() {
        set({ pending: undefined, stale: false });
      },

      async initiate(input) {
        await rpc.replication.initiate({ connectionId, ...input });
        await get().refresh();
      },
    };

    async function configMoved(version: number): Promise<boolean> {
      try {
        const live = await rpc.replication.getConfig({ connectionId });
        return live.version !== version;
      } catch {
        return false;
      }
    }
  });
}
