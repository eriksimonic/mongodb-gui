import { rewriteForExplain, toAppError, type PlanVerbosity, type RpcClient } from '@mongo-gui/core';
import type { AppStore } from '../state/app-store';
import {
  commandCollection,
  explainTitle,
  type ExplainPanelState,
  type ExplainRequest,
} from './explain-model';

/** The explain actions the app store adds. Each opens or re-runs one explain panel. */
export interface ExplainActions {
  /** Opens the explain of a statement, or focuses its panel. Resolves to the panel id. */
  openExplain(input: {
    readonly connectionId: string;
    readonly database: string;
    readonly code: string;
  }): Promise<string>;
  /** Opens the explain of a captured command, or focuses its panel. Resolves to the panel id. */
  openExplainCommand(input: {
    readonly connectionId: string;
    readonly database: string;
    readonly commandEjson: string;
    // Set for a profiler update or remove entry, with the collection it names.
    readonly profileOp?: 'update' | 'remove';
    readonly collection?: string;
  }): Promise<string>;
  /** Runs the panel's request again. A verbosity replaces the last one and the rest stays. */
  rerunExplain(panelId: string, verbosity?: PlanVerbosity): Promise<void>;
  /** Forgets a panel after its tab closes. */
  closeExplainPanel(panelId: string): void;
}

/**
 * The explain state and actions. Kept apart from the app store so the store file only adds the
 * spread. Panels live in `explainPanels`, and `explainFocus` asks the shell to show one.
 */
export function createExplainActions(
  rpc: RpcClient,
  set: AppStore['setState'],
  get: AppStore['getState'],
): ExplainActions {
  let serial = 0;
  // A run that finishes after a newer run of the same panel, or after the panel closed, is dropped.
  const generations = new Map<string, number>();

  function patchPanel(id: string, patch: Partial<Omit<ExplainPanelState, 'id'>>): void {
    set((state) => {
      const panel = state.explainPanels[id];
      if (panel === undefined) {
        return {};
      }
      return { explainPanels: { ...state.explainPanels, [id]: { ...panel, ...patch } } };
    });
  }

  function focusPanel(id: string): void {
    set((state) => ({
      explainFocus: { id, serial: (state.explainFocus?.serial ?? 0) + 1 },
    }));
  }

  function addPanel(panel: ExplainPanelState): void {
    set((state) => ({
      explainPanels: { ...state.explainPanels, [panel.id]: panel },
      explainFocus: { id: panel.id, serial: (state.explainFocus?.serial ?? 0) + 1 },
    }));
  }

  async function run(id: string): Promise<void> {
    const panel = get().explainPanels[id];
    if (panel === undefined || panel.outcome.state === 'refused') {
      return;
    }
    const generation = (generations.get(id) ?? 0) + 1;
    generations.set(id, generation);
    patchPanel(id, { outcome: { state: 'loading' } });
    const { request } = panel;
    const { connectionId, database, verbosity, source } = request;
    try {
      const result =
        source.kind === 'statement'
          ? await rpc.explain.run({ connectionId, database, code: source.code, verbosity })
          : await rpc.explain.runCommand({
              connectionId,
              database,
              commandEjson: source.commandEjson,
              verbosity,
              ...(source.profileOp === undefined ? {} : { profileOp: source.profileOp }),
              ...(source.collection === undefined ? {} : { collection: source.collection }),
            });
      if (generations.get(id) === generation) {
        patchPanel(id, { outcome: { state: 'ready', result } });
      }
    } catch (error) {
      if (generations.get(id) === generation) {
        patchPanel(id, { outcome: { state: 'error', error: toAppError(error) } });
      }
    }
  }

  function nextId(): string {
    serial += 1;
    return `explain:${serial}`;
  }

  function findPanel(
    connectionId: string,
    database: string,
    matches: (request: ExplainRequest) => boolean,
  ): ExplainPanelState | undefined {
    return Object.values(get().explainPanels).find(
      (panel) =>
        panel.request.connectionId === connectionId &&
        panel.request.database === database &&
        matches(panel.request),
    );
  }

  return {
    async openExplain({ connectionId, database, code }) {
      const existing = findPanel(
        connectionId,
        database,
        (request) => request.source.kind === 'statement' && request.source.code === code,
      );
      if (existing !== undefined) {
        focusPanel(existing.id);
        return existing.id;
      }
      const rewrite = rewriteForExplain(code, 'executionStats');
      const id = nextId();
      const collection = rewrite.ok ? rewrite.collection : undefined;
      addPanel({
        id,
        title: explainTitle(collection),
        collection,
        request: {
          connectionId,
          database,
          source: { kind: 'statement', code },
          verbosity: 'executionStats',
        },
        outcome: rewrite.ok ? { state: 'loading' } : { state: 'refused', message: rewrite.message },
      });
      await run(id);
      return id;
    },

    async openExplainCommand({
      connectionId,
      database,
      commandEjson,
      profileOp,
      collection: named,
    }) {
      const existing = findPanel(
        connectionId,
        database,
        (request) =>
          request.source.kind === 'command' && request.source.commandEjson === commandEjson,
      );
      if (existing !== undefined) {
        focusPanel(existing.id);
        return existing.id;
      }
      const id = nextId();
      const collection = named ?? commandCollection(commandEjson);
      addPanel({
        id,
        title: explainTitle(collection),
        collection,
        request: {
          connectionId,
          database,
          source: {
            kind: 'command',
            commandEjson,
            ...(profileOp === undefined ? {} : { profileOp }),
            ...(named === undefined ? {} : { collection: named }),
          },
          verbosity: 'executionStats',
        },
        outcome: { state: 'loading' },
      });
      await run(id);
      return id;
    },

    async rerunExplain(panelId, verbosity) {
      const panel = get().explainPanels[panelId];
      if (panel === undefined) {
        return;
      }
      if (verbosity !== undefined && verbosity !== panel.request.verbosity) {
        patchPanel(panelId, { request: { ...panel.request, verbosity } });
      }
      await run(panelId);
    },

    closeExplainPanel(panelId) {
      generations.delete(panelId);
      set((state) => ({
        explainPanels: Object.fromEntries(
          Object.entries(state.explainPanels).filter(([id]) => id !== panelId),
        ),
      }));
    },
  };
}
