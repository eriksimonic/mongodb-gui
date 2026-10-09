import {
  toAppError,
  groupByShape,
  type AppError,
  type ProfileCollectionInfo,
  type ProfileEntry,
  type ProfilingLevel,
  type QueryShape,
  type RpcEvent,
} from '@mongo-gui/core';
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { UiApi } from '../api/ui-api';
import {
  DEFAULT_FILTERS,
  DEFAULT_LEVEL_DRAFT,
  DEFAULT_SORT,
  draftFromLevel,
  filtersToQuery,
  mergeTailEntries,
  setLevelInput,
  tailFilterFor,
  toggleSort,
  type EntrySort,
  type LevelDraft,
  type ProfilerFilters,
  type SortKey,
} from './profiler-model';

export type ProfilerTab = 'slow' | 'shapes';

/** How long a row that arrived through the tail stays highlighted. */
export const HIGHLIGHT_MS = 1500;
export const DEFAULT_POLL_MS = 2000;

/** Startup values a panel may set when it opens. Stories and tests use them. */
export interface ProfilerSeed {
  readonly tab?: ProfilerTab;
  readonly tailEnabled?: boolean;
  readonly pollMs?: number;
  readonly filters?: Partial<ProfilerFilters>;
}

/** The state of one profiler panel, keyed by panel id in the store. */
export interface ProfilerPanelState {
  readonly connectionId: string;
  readonly database: string;
  readonly level: ProfilingLevel | undefined;
  readonly levelDraft: LevelDraft;
  readonly info: ProfileCollectionInfo | undefined;
  readonly filters: ProfilerFilters;
  readonly entries: readonly ProfileEntry[];
  readonly shapes: readonly QueryShape[];
  readonly loading: boolean;
  readonly error: AppError | undefined;
  readonly tailEnabled: boolean;
  readonly pollMs: number;
  readonly tailError: AppError | undefined;
  readonly highlighted: readonly string[];
  readonly selectedId: string | undefined;
  readonly sort: EntrySort;
  readonly tab: ProfilerTab;
  /** Shape key of the shape the table is filtered to. The filter runs in the renderer. */
  readonly shapeFilter: string | undefined;
  readonly detailWidth: number;
}

export interface ProfilerState {
  readonly panels: Readonly<Record<string, ProfilerPanelState>>;
}

export interface ProfilerActions {
  open(panelId: string, connectionId: string, database: string, seed?: ProfilerSeed): Promise<void>;
  close(panelId: string): Promise<void>;
  refresh(panelId: string): Promise<void>;
  setLevelDraft(panelId: string, patch: Partial<LevelDraft>): void;
  applyLevel(panelId: string): Promise<void>;
  setFilters(panelId: string, patch: Partial<ProfilerFilters>): void;
  setTailEnabled(panelId: string, enabled: boolean): Promise<void>;
  setPollMs(panelId: string, pollMs: number): Promise<void>;
  select(panelId: string, id: string | undefined): void;
  sortBy(panelId: string, key: SortKey): void;
  setTab(panelId: string, tab: ProfilerTab): void;
  setShapeFilter(panelId: string, key: string | undefined): void;
  setDetailWidth(panelId: string, width: number): void;
  applyEvent(event: RpcEvent): void;
}

export type ProfilerStoreState = ProfilerState & ProfilerActions;
export type ProfilerStore = StoreApi<ProfilerStoreState>;

const DEFAULT_DETAIL_WIDTH = 380;

function initialPanel(
  connectionId: string,
  database: string,
  seed: ProfilerSeed | undefined,
): ProfilerPanelState {
  return {
    connectionId,
    database,
    level: undefined,
    levelDraft: DEFAULT_LEVEL_DRAFT,
    info: undefined,
    filters: { ...DEFAULT_FILTERS, ...seed?.filters },
    entries: [],
    shapes: [],
    loading: false,
    error: undefined,
    tailEnabled: seed?.tailEnabled ?? false,
    pollMs: seed?.pollMs ?? DEFAULT_POLL_MS,
    tailError: undefined,
    highlighted: [],
    selectedId: undefined,
    sort: DEFAULT_SORT,
    tab: seed?.tab ?? 'slow',
    shapeFilter: undefined,
    detailWidth: DEFAULT_DETAIL_WIDTH,
  };
}

/**
 * The profiler state for every open panel. Plain zustand, no React, so tests can drive it with
 * the mock api. Each panel has its own slice, keyed by its dockview panel id.
 */
export function createProfilerStore(api: UiApi): ProfilerStore {
  const { rpc } = api;

  return createStore<ProfilerStoreState>()((set, get) => {
    function patch(panelId: string, change: Partial<ProfilerPanelState>): void {
      set((state) => {
        const panel = state.panels[panelId];
        if (panel === undefined) {
          return state;
        }
        return { panels: { ...state.panels, [panelId]: { ...panel, ...change } } };
      });
    }

    function panelOf(panelId: string): ProfilerPanelState | undefined {
      return get().panels[panelId];
    }

    async function startTail(panelId: string): Promise<void> {
      const panel = panelOf(panelId);
      if (panel === undefined) {
        return;
      }
      try {
        await rpc.profiler.tail({
          connectionId: panel.connectionId,
          database: panel.database,
          enabled: true,
          pollMs: panel.pollMs,
          filter: tailFilterFor(panel.filters, new Date()),
        });
      } catch (error) {
        patch(panelId, { tailEnabled: false, tailError: toAppError(error) });
      }
    }

    async function stopTail(panelId: string): Promise<void> {
      const panel = panelOf(panelId);
      if (panel === undefined) {
        return;
      }
      try {
        await rpc.profiler.tail({
          connectionId: panel.connectionId,
          database: panel.database,
          enabled: false,
        });
      } catch {
        // A stop that fails leaves nothing running on the server. The panel has already let go.
      }
    }

    function highlight(panelId: string, ids: readonly string[]): void {
      if (ids.length === 0) {
        return;
      }
      setTimeout(() => {
        const panel = panelOf(panelId);
        if (panel === undefined) {
          return;
        }
        patch(panelId, {
          highlighted: panel.highlighted.filter((id) => !ids.includes(id)),
        });
      }, HIGHLIGHT_MS);
    }

    return {
      panels: {},

      async open(panelId, connectionId, database, seed) {
        if (get().panels[panelId] !== undefined) {
          return;
        }
        set((state) => ({
          panels: { ...state.panels, [panelId]: initialPanel(connectionId, database, seed) },
        }));
        if (seed?.tailEnabled === true) {
          // The tail starts with the panel, so its filter is the filter the panel was opened with.
          await startTail(panelId);
        }
        try {
          const [level, info] = await Promise.all([
            rpc.profiler.level({ connectionId, database }),
            rpc.profiler.info({ connectionId, database }),
          ]);
          patch(panelId, { level, levelDraft: draftFromLevel(level), info });
        } catch (error) {
          patch(panelId, { error: toAppError(error) });
        }
        await get().refresh(panelId);
      },

      async close(panelId) {
        const panel = panelOf(panelId);
        if (panel === undefined) {
          return;
        }
        set((state) => ({
          panels: Object.fromEntries(
            Object.entries(state.panels).filter(([key]) => key !== panelId),
          ),
        }));
        if (panel.tailEnabled) {
          await stopTail(panelId);
        }
      },

      async refresh(panelId) {
        const panel = panelOf(panelId);
        if (panel === undefined) {
          return;
        }
        patch(panelId, { loading: true, error: undefined });
        const target = { connectionId: panel.connectionId, database: panel.database };
        const filter = filtersToQuery(panel.filters, new Date());
        try {
          const [entries, shapes] = await Promise.all([
            rpc.profiler.list({ ...target, filter }),
            rpc.profiler.shapes({ ...target, filter }),
          ]);
          const selected = entries.some((entry) => entry.id === panel.selectedId)
            ? panel.selectedId
            : undefined;
          patch(panelId, {
            entries,
            shapes,
            loading: false,
            highlighted: [],
            selectedId: selected,
          });
        } catch (error) {
          patch(panelId, { loading: false, error: toAppError(error) });
        }
        if (panelOf(panelId)?.tailEnabled === true) {
          await startTail(panelId);
        }
      },

      setLevelDraft(panelId, change) {
        const panel = panelOf(panelId);
        if (panel === undefined) {
          return;
        }
        patch(panelId, { levelDraft: { ...panel.levelDraft, ...change } });
      },

      async applyLevel(panelId) {
        const panel = panelOf(panelId);
        if (panel === undefined) {
          return;
        }
        try {
          const level = await rpc.profiler.setLevel({
            connectionId: panel.connectionId,
            database: panel.database,
            ...setLevelInput(panel.levelDraft),
          });
          patch(panelId, { level, levelDraft: draftFromLevel(level), error: undefined });
        } catch (error) {
          patch(panelId, { error: toAppError(error) });
        }
      },

      setFilters(panelId, change) {
        const panel = panelOf(panelId);
        if (panel === undefined) {
          return;
        }
        patch(panelId, { filters: { ...panel.filters, ...change } });
      },

      async setTailEnabled(panelId, enabled) {
        patch(panelId, { tailEnabled: enabled, tailError: undefined });
        if (enabled) {
          await startTail(panelId);
        } else {
          await stopTail(panelId);
        }
      },

      async setPollMs(panelId, pollMs) {
        patch(panelId, { pollMs });
        if (panelOf(panelId)?.tailEnabled === true) {
          await startTail(panelId);
        }
      },

      select(panelId, id) {
        patch(panelId, { selectedId: id });
      },

      sortBy(panelId, key) {
        const panel = panelOf(panelId);
        if (panel === undefined) {
          return;
        }
        patch(panelId, { sort: toggleSort(panel.sort, key) });
      },

      setTab(panelId, tab) {
        patch(panelId, { tab });
      },

      setShapeFilter(panelId, key) {
        // Filtering to a shape shows its rows in the slow query table.
        patch(
          panelId,
          key === undefined ? { shapeFilter: undefined } : { shapeFilter: key, tab: 'slow' },
        );
      },

      setDetailWidth(panelId, width) {
        patch(panelId, { detailWidth: width });
      },

      applyEvent(event) {
        if (event.type === 'profiler:entries') {
          for (const [panelId, panel] of Object.entries(get().panels)) {
            if (panel.connectionId !== event.connectionId || panel.database !== event.database) {
              continue;
            }
            const merged = mergeTailEntries(panel.entries, event.entries, panel.filters.limit);
            patch(panelId, {
              entries: merged.entries,
              shapes: groupByShape(merged.entries),
              highlighted: [...panel.highlighted, ...merged.added],
            });
            highlight(panelId, merged.added);
          }
          return;
        }
        if (event.type === 'profiler:error') {
          for (const [panelId, panel] of Object.entries(get().panels)) {
            if (panel.connectionId === event.connectionId && panel.database === event.database) {
              patch(panelId, { tailError: event.error });
            }
          }
        }
      },
    };
  });
}
