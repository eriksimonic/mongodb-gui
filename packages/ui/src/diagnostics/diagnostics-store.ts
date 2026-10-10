import type {
  CommandLineReply,
  BuildInfo,
  ConnPoolStats,
  HostInfo,
  RpcClient,
  ServerLogKind,
  ServerParameter,
  ServerStatusReply,
  SessionList,
  SessionUserInput,
  TopEntry,
} from '@mongo-gui/core';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { errorText } from '../components/notify-error';
import { mergeLogWindow, type LogWindow } from './log-window';

/** The connection the panel reads from. */
export interface DiagnosticsTarget {
  readonly connectionId: string;
}

/** The part of the RPC client the panel uses. */
export type DiagnosticsClient = RpcClient['diagnostics'];

/** One read of the server. `data` keeps the last good answer while a reload runs. */
export interface Loadable<T> {
  readonly data: T | undefined;
  readonly loading: boolean;
  /** The text of the last failed read. Cleared by the next successful read. */
  readonly error: string | undefined;
}

export interface HostAndBuild {
  readonly host: HostInfo;
  readonly build: BuildInfo;
  readonly cmdLine: CommandLineReply;
}

const EMPTY: Loadable<never> = { data: undefined, loading: false, error: undefined };

export interface DiagnosticsState {
  readonly logs: Readonly<Record<ServerLogKind, Loadable<LogWindow>>>;
  readonly parameters: Loadable<ServerParameter[]>;
  readonly serverStatus: Loadable<ServerStatusReply>;
  readonly hostAndBuild: Loadable<HostAndBuild>;
  readonly top: Loadable<TopEntry[]>;
  readonly pools: Loadable<ConnPoolStats>;
  readonly sessions: Loadable<SessionList>;
  /** True when the session list covers every node of the cluster. */
  readonly allUsers: boolean;
  /** Session ids the user ticked. Cleared by a reload of the list. */
  readonly selected: readonly string[];
  loadLog(kind: ServerLogKind): Promise<void>;
  loadParameters(): Promise<void>;
  loadServerStatus(): Promise<void>;
  loadHostAndBuild(): Promise<void>;
  loadTop(): Promise<void>;
  loadPools(): Promise<void>;
  loadSessions(allUsers?: boolean): Promise<void>;
  toggleSelected(id: string): void;
  /** Kills the ticked sessions. A failure throws the server text, and the selection stays. */
  killSelected(): Promise<void>;
  /** Kills every session of one user. A failure throws the server text. */
  killUserSessions(user: SessionUserInput): Promise<void>;
}

export type DiagnosticsStore = StoreApi<DiagnosticsState>;

/**
 * The state of one diagnostics panel. Each read stores its own answer or error, so one failing
 * tab does not hide the others. A kill sends the ids or users to the server first, then reloads.
 */
export function createDiagnosticsStore(
  target: DiagnosticsTarget,
  client: DiagnosticsClient,
): DiagnosticsStore {
  const { connectionId } = target;

  return createStore<DiagnosticsState>()((set, get) => {
    /** Runs one read and stores the outcome under the key. Never rejects. */
    async function read<K extends ReadKey>(key: K, fetch: () => Promise<ReadValue<K>>) {
      set({ [key]: { ...get()[key], loading: true } } as Partial<DiagnosticsState>);
      try {
        const data = await fetch();
        set({ [key]: { data, loading: false, error: undefined } } as Partial<DiagnosticsState>);
      } catch (failure) {
        set({
          [key]: { ...get()[key], loading: false, error: errorText(failure) },
        } as Partial<DiagnosticsState>);
      }
    }

    async function reloadSessions(allUsers: boolean): Promise<void> {
      await read('sessions', () => client.listSessions({ connectionId, allUsers }));
    }

    return {
      logs: { global: EMPTY, startupWarnings: EMPTY },
      parameters: EMPTY,
      serverStatus: EMPTY,
      hostAndBuild: EMPTY,
      top: EMPTY,
      pools: EMPTY,
      sessions: EMPTY,
      allUsers: false,
      selected: [],

      async loadLog(kind) {
        set((state) => ({
          logs: { ...state.logs, [kind]: { ...state.logs[kind], loading: true } },
        }));
        try {
          const reply = await client.getLog({ connectionId, kind });
          set((state) => ({
            logs: {
              ...state.logs,
              // A refresh keeps the lines already read and appends the new ones.
              [kind]: {
                data: mergeLogWindow(state.logs[kind].data, reply),
                loading: false,
                error: undefined,
              },
            },
          }));
        } catch (failure) {
          set((state) => ({
            logs: {
              ...state.logs,
              [kind]: { ...state.logs[kind], loading: false, error: errorText(failure) },
            },
          }));
        }
      },

      async loadParameters() {
        await read('parameters', () => client.parameters({ connectionId }));
      },

      async loadServerStatus() {
        await read('serverStatus', () => client.serverStatus({ connectionId }));
      },

      async loadHostAndBuild() {
        await read('hostAndBuild', async () => {
          const [host, build, cmdLine] = await Promise.all([
            client.hostInfo({ connectionId }),
            client.buildInfo({ connectionId }),
            client.cmdLineOpts({ connectionId }),
          ]);
          return { host, build, cmdLine };
        });
      },

      async loadTop() {
        await read('top', () => client.top({ connectionId }));
      },

      async loadPools() {
        await read('pools', () => client.connPoolStats({ connectionId }));
      },

      async loadSessions(allUsers) {
        const scope = allUsers ?? get().allUsers;
        set({ allUsers: scope, selected: [] });
        await reloadSessions(scope);
      },

      toggleSelected(id) {
        const current = get().selected;
        set({
          selected: current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
        });
      },

      async killSelected() {
        const ids = get().selected;
        await client.killSessions({ connectionId, ids: [...ids] });
        set({ selected: [] });
        await reloadSessions(get().allUsers);
      },

      async killUserSessions(user) {
        await client.killAllSessionsByUser({ connectionId, users: [user] });
        await reloadSessions(get().allUsers);
      },
    };
  });
}

type ReadKey = 'parameters' | 'serverStatus' | 'hostAndBuild' | 'top' | 'pools' | 'sessions';

type ReadValue<K extends ReadKey> = DiagnosticsState[K] extends Loadable<infer T> ? T : never;
