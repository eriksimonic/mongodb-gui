import {
  toAppError,
  type AppError,
  type ChangeTarget,
  type ChangeWatchOptions,
  type ChangeWatchPushPhase,
  type RpcEvent,
} from '@mongo-gui/core';
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { UiApi } from '../api/ui-api';
import {
  appendRows,
  pipelineProblem,
  resumeTokenProblem,
  rowKeyOf,
  rowsThrough,
  type ChangeOrder,
  type ChangeRow,
  type FullDocumentBeforeMode,
  type FullDocumentMode,
} from './changes-model';

/** Startup values a panel may set when it opens. Stories and tests use them. */
export interface ChangesSeed {
  readonly pipelineText?: string;
  readonly fullDocument?: FullDocumentMode;
}

/** The state of one change stream panel, keyed by panel id in the store. */
export interface ChangesPanelState {
  readonly connectionId: string;
  readonly target: ChangeTarget;
  readonly pipelineText: string;
  readonly pipelineError: string | undefined;
  readonly fullDocument: FullDocumentMode;
  readonly fullDocumentBeforeChange: FullDocumentBeforeMode;
  readonly resumeToken: string;
  readonly resumeTokenError: string | undefined;
  /** The watch the panel started. It stays set after the watch ends, until the next start. */
  readonly watchId: string | undefined;
  /** The phase of the current watch. Undefined before the first start. */
  readonly phase: ChangeWatchPushPhase | undefined;
  readonly eventsSeen: number;
  readonly eventsDropped: number;
  readonly error: AppError | undefined;
  readonly rows: readonly ChangeRow[];
  /** Rows that left the list because the cap was reached. */
  readonly trimmed: number;
  readonly order: ChangeOrder;
  readonly filter: string;
  readonly selectedKey: string | undefined;
}

export interface ChangesState {
  readonly panels: Readonly<Record<string, ChangesPanelState>>;
}

export interface ChangesActions {
  open(panelId: string, connectionId: string, target: ChangeTarget, seed?: ChangesSeed): void;
  close(panelId: string): Promise<void>;
  setPipeline(panelId: string, text: string): void;
  setFullDocument(panelId: string, mode: FullDocumentMode): void;
  setFullDocumentBeforeChange(panelId: string, mode: FullDocumentBeforeMode): void;
  setResumeToken(panelId: string, text: string): void;
  start(panelId: string): Promise<void>;
  pause(panelId: string): Promise<void>;
  resume(panelId: string): Promise<void>;
  stop(panelId: string): Promise<void>;
  /** Restarts the watch after the row with the key. Rows after it are dropped, because they come again. */
  resumeFrom(panelId: string, key: string): Promise<void>;
  clear(panelId: string): void;
  setOrder(panelId: string, order: ChangeOrder): void;
  setFilter(panelId: string, text: string): void;
  select(panelId: string, key: string | undefined): void;
  applyEvent(event: RpcEvent): void;
}

export type ChangesStoreState = ChangesState & ChangesActions;
export type ChangesStore = StoreApi<ChangesStoreState>;

const DEFAULT_PIPELINE = '[]';

function initialPanel(
  connectionId: string,
  target: ChangeTarget,
  seed: ChangesSeed | undefined,
): ChangesPanelState {
  return {
    connectionId,
    target,
    pipelineText: seed?.pipelineText ?? DEFAULT_PIPELINE,
    pipelineError: undefined,
    fullDocument: seed?.fullDocument ?? 'updateLookup',
    fullDocumentBeforeChange: 'off',
    resumeToken: '',
    resumeTokenError: undefined,
    watchId: undefined,
    phase: undefined,
    eventsSeen: 0,
    eventsDropped: 0,
    error: undefined,
    rows: [],
    trimmed: 0,
    order: 'newest',
    filter: '',
    selectedKey: undefined,
  };
}

/** The options the start call sends for a panel. Blank text means the server default. */
export function optionsOf(panel: ChangesPanelState): ChangeWatchOptions {
  const pipeline = panel.pipelineText.trim();
  const token = panel.resumeToken.trim();
  return {
    ...(pipeline === '' ? {} : { pipelineEjson: pipeline }),
    fullDocument: panel.fullDocument,
    fullDocumentBeforeChange: panel.fullDocumentBeforeChange,
    ...(token === '' ? {} : { resumeAfterEjson: token }),
  };
}

/**
 * The change stream state of every open panel. Plain zustand, no React, so tests can drive it
 * with a fake api. Each panel has its own slice, keyed by its dockview panel id.
 */
export function createChangesStore(api: UiApi): ChangesStore {
  const { rpc } = api;

  return createStore<ChangesStoreState>()((set, get) => {
    function patch(panelId: string, change: Partial<ChangesPanelState>): void {
      set((state) => {
        const panel = state.panels[panelId];
        if (panel === undefined) {
          return state;
        }
        return { panels: { ...state.panels, [panelId]: { ...panel, ...change } } };
      });
    }

    function panelOf(panelId: string): ChangesPanelState | undefined {
      return get().panels[panelId];
    }

    /** Ends the watch of a panel on the server. The panel forgets the id before the call. */
    async function stopWatch(panelId: string): Promise<void> {
      const watchId = panelOf(panelId)?.watchId;
      if (watchId === undefined) {
        return;
      }
      patch(panelId, { watchId: undefined, phase: 'closed' });
      try {
        await rpc.changes.stop({ watchId });
      } catch {
        // A stop that fails leaves the watch to the server's own cleanup. The panel has let go.
      }
    }

    async function syncState(panelId: string, watchId: string): Promise<void> {
      try {
        const state = await rpc.changes.state({ watchId });
        if (panelOf(panelId)?.watchId === watchId) {
          patch(panelId, {
            phase: state.phase,
            eventsSeen: state.eventsSeen,
            eventsDropped: state.eventsDropped,
          });
        }
      } catch (error) {
        patch(panelId, { error: toAppError(error) });
      }
    }

    return {
      panels: {},

      open(panelId, connectionId, target, seed) {
        if (get().panels[panelId] !== undefined) {
          return;
        }
        set((state) => ({
          panels: { ...state.panels, [panelId]: initialPanel(connectionId, target, seed) },
        }));
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
        if (panel.watchId !== undefined) {
          try {
            await rpc.changes.stop({ watchId: panel.watchId });
          } catch {
            // The panel is gone. The server ends the watch with its connection or the page.
          }
        }
      },

      setPipeline(panelId, text) {
        patch(panelId, { pipelineText: text, pipelineError: undefined });
      },

      setFullDocument(panelId, mode) {
        patch(panelId, { fullDocument: mode });
      },

      setFullDocumentBeforeChange(panelId, mode) {
        patch(panelId, { fullDocumentBeforeChange: mode });
      },

      setResumeToken(panelId, text) {
        patch(panelId, { resumeToken: text, resumeTokenError: undefined });
      },

      async start(panelId) {
        const panel = panelOf(panelId);
        if (panel === undefined) {
          return;
        }
        const pipelineError = pipelineProblem(panel.pipelineText);
        const resumeTokenError = resumeTokenProblem(panel.resumeToken);
        if (pipelineError !== undefined || resumeTokenError !== undefined) {
          patch(panelId, { pipelineError, resumeTokenError });
          return;
        }
        await stopWatch(panelId);
        patch(panelId, {
          pipelineError: undefined,
          resumeTokenError: undefined,
          error: undefined,
          phase: 'opening',
          eventsSeen: 0,
          eventsDropped: 0,
        });
        try {
          const { watchId } = await rpc.changes.start({
            connectionId: panel.connectionId,
            target: panel.target,
            options: optionsOf(panel),
          });
          if (get().panels[panelId] === undefined) {
            // The panel closed while the start was in flight, so the new watch has no owner.
            await rpc.changes.stop({ watchId }).catch(() => undefined);
            return;
          }
          patch(panelId, { watchId });
          await syncState(panelId, watchId);
        } catch (error) {
          patch(panelId, { phase: 'error', error: toAppError(error) });
        }
      },

      async pause(panelId) {
        const watchId = panelOf(panelId)?.watchId;
        if (watchId === undefined) {
          return;
        }
        try {
          await rpc.changes.pause({ watchId });
          await syncState(panelId, watchId);
        } catch (error) {
          patch(panelId, { error: toAppError(error) });
        }
      },

      async resume(panelId) {
        const watchId = panelOf(panelId)?.watchId;
        if (watchId === undefined) {
          return;
        }
        try {
          await rpc.changes.resume({ watchId });
          await syncState(panelId, watchId);
        } catch (error) {
          patch(panelId, { error: toAppError(error) });
        }
      },

      async stop(panelId) {
        await stopWatch(panelId);
      },

      async resumeFrom(panelId, key) {
        const panel = panelOf(panelId);
        const kept = panel === undefined ? undefined : rowsThrough(panel.rows, key);
        const row = kept?.[kept.length - 1];
        if (panel === undefined || kept === undefined || row === undefined) {
          return;
        }
        patch(panelId, {
          rows: kept,
          selectedKey: key,
          resumeToken: row.event.resumeTokenEjson,
          resumeTokenError: undefined,
        });
        await get().start(panelId);
      },

      clear(panelId) {
        patch(panelId, { rows: [], trimmed: 0, selectedKey: undefined });
      },

      setOrder(panelId, order) {
        patch(panelId, { order });
      },

      setFilter(panelId, text) {
        patch(panelId, { filter: text });
      },

      select(panelId, key) {
        patch(panelId, { selectedKey: key });
      },

      applyEvent(event) {
        if (event.type === 'changes:event') {
          for (const [panelId, panel] of Object.entries(get().panels)) {
            if (panel.watchId !== event.watchId) {
              continue;
            }
            const incoming = event.events.map((item) => ({
              key: rowKeyOf(event.watchId, item),
              event: item,
            }));
            const next = appendRows(panel.rows, incoming);
            // The server pushes its count only on a phase change, so each delivered event counts here.
            patch(panelId, {
              rows: next.rows,
              trimmed: panel.trimmed + next.trimmed,
              eventsSeen: panel.eventsSeen + event.events.length,
            });
          }
          return;
        }
        if (event.type === 'changes:state') {
          for (const [panelId, panel] of Object.entries(get().panels)) {
            if (panel.watchId !== event.watchId) {
              continue;
            }
            patch(panelId, {
              phase: event.state.phase,
              eventsSeen: event.state.eventsSeen,
              eventsDropped: event.state.eventsDropped,
              error: event.state.error,
            });
          }
        }
      },
    };
  });
}
