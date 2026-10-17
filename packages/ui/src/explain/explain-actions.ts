import {
  appError,
  AppErrorException,
  newId,
  rewriteForExplain,
  toAppError,
  type PlanStage,
  type PlanVerbosity,
  type RpcClient,
} from '@mongo-gui/core';
import type { AppStore } from '../state/app-store';
import {
  commandCollection,
  explainTitle,
  lookupRuns,
  stageEntries,
  type LookupMeasure,
  type ExplainPanelState,
  type ExplainRestore,
  type ExplainRequest,
} from './explain-model';
import {
  echoedAggregate,
  lookupPosition,
  lookupSpec,
  measuredCommand,
  parseSample,
  sampleCode,
} from './lookup-measure';

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
    /** Shown above the plan. */
    readonly note?: string;
  }): Promise<string>;
  /**
   * Explains the inner pipeline of a $lookup on its own, for one document that reaches the
   * $lookup, and keeps the result on the panel. The plan then shows the inner stages with the
   * counters of one document times the number of runs. Every finished aggregate explain does this
   * for each of its $lookup stages, so this is for a retry. Rejects when the plan has no echoed
   * aggregate, the $lookup is nested, or no document reaches it.
   */
  measureLookup(panelId: string, stageId: string, stage: PlanStage): Promise<void>;
  /**
   * Runs the panel's request again. A verbosity replaces the last one and the rest stays. Text
   * replaces the statement or command, as edited in the panel.
   */
  rerunExplain(panelId: string, verbosity?: PlanVerbosity, text?: string): Promise<void>;
  /**
   * Puts back a panel the saved layout restored, from its dock params. It does not run: the
   * explain may execute the query, so it waits for Re-run.
   */
  restoreExplain(panelId: string, restore: ExplainRestore): void;
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
    // A new run gives a new plan, so the measures of the old one no longer fit its stage ids.
    patchPanel(id, { outcome: { state: 'loading' }, lookupMeasures: undefined });
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
        void measureAll(id);
      }
    } catch (error) {
      if (generations.get(id) === generation) {
        patchPanel(id, { outcome: { state: 'error', error: toAppError(error) } });
      }
    }
  }

  // The measure of one $lookup stage. A result of a run that was replaced meanwhile is dropped, because
  // the stage ids belong to the plan of the run that started it.
  function setMeasure(
    panelId: string,
    generation: number | undefined,
    stageId: string,
    measure: LookupMeasure,
  ): void {
    if (generations.get(panelId) !== generation) {
      return;
    }
    const panel = get().explainPanels[panelId];
    if (panel !== undefined) {
      patchPanel(panelId, { lookupMeasures: { ...panel.lookupMeasures, [stageId]: measure } });
    }
  }

  async function sampleAndExplain(
    panel: ExplainPanelState,
    stage: PlanStage,
  ): Promise<{ inner: PlanStage; runs: number }> {
    const spec = lookupSpec(stage.raw);
    if (panel.outcome.state !== 'ready' || spec === undefined) {
      throw new AppErrorException(appError('VALIDATION', 'This stage is not a $lookup.'));
    }
    const echo = echoedAggregate(panel.outcome.result.rawEjson);
    if (echo === undefined) {
      throw new AppErrorException(
        appError(
          'VALIDATION',
          'The explain output does not echo the aggregate. Servers from 6.0 on echo it.',
        ),
      );
    }
    const position = lookupPosition(echo.pipeline, spec);
    if (position < 0) {
      throw new AppErrorException(
        appError(
          'VALIDATION',
          'Only a $lookup at the top of the pipeline is measured. This one sits inside another stage, such as $facet or $unionWith.',
        ),
      );
    }
    const { connectionId, database } = panel.request;
    const evaluation = await rpc.shell.evaluate({
      connectionId,
      database,
      code: sampleCode(echo.collection, echo.pipeline.slice(0, position), spec),
    });
    if (evaluation.error !== undefined) {
      throw new AppErrorException(evaluation.error);
    }
    const sample =
      evaluation.result === undefined ? undefined : parseSample(evaluation.result.printableEjson);
    if (sample === undefined) {
      throw new AppErrorException(
        appError('NOT_FOUND', 'No document reaches the $lookup, so there is nothing to measure.'),
      );
    }
    const measured = await rpc.explain.runCommand({
      connectionId,
      database,
      commandEjson: measuredCommand(spec, sample),
      verbosity: 'executionStats',
    });
    if (measured.tree.command === 'unknown') {
      throw new AppErrorException(
        appError('COMMAND_FAILED', 'The server returned no plan for the inner pipeline.'),
      );
    }
    return { inner: measured.tree.winning, runs: lookupRuns(stage) };
  }

  /**
   * Explains the inner pipeline of one $lookup for one sampled document and keeps the result on
   * the panel. A failure is kept as the reason too, and thrown so a click can tell the user.
   */
  async function measureOne(panelId: string, stageId: string, stage: PlanStage): Promise<void> {
    const generation = generations.get(panelId);
    const panel = get().explainPanels[panelId];
    if (panel === undefined) {
      return;
    }
    setMeasure(panelId, generation, stageId, { state: 'measuring' });
    try {
      const { inner, runs } = await sampleAndExplain(panel, stage);
      setMeasure(panelId, generation, stageId, { state: 'measured', inner, runs });
    } catch (error) {
      setMeasure(panelId, generation, stageId, {
        state: 'failed',
        reason: toAppError(error).message,
      });
      throw error;
    }
  }

  /** Measures every $lookup of a finished explain, one after the other. Failures stay on the cards. */
  async function measureAll(panelId: string): Promise<void> {
    const panel = get().explainPanels[panelId];
    if (panel === undefined || panel.outcome.state !== 'ready') {
      return;
    }
    const { tree } = panel.outcome.result;
    if (tree.command !== 'aggregate' || panel.request.verbosity === 'queryPlanner') {
      return;
    }
    for (const { id, stage } of stageEntries(tree.winning)) {
      if (stage.name === '$lookup') {
        await measureOne(panelId, id, stage).catch(() => undefined);
      }
    }
  }

  // Unique across sessions, so a new panel never takes the id of one the saved layout restored.
  function nextId(): string {
    return `explain:${newId()}`;
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
      note,
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
        ...(note === undefined ? {} : { note }),
        outcome: { state: 'loading' },
      });
      await run(id);
      return id;
    },

    measureLookup: measureOne,

    async rerunExplain(panelId, verbosity, text) {
      const panel = get().explainPanels[panelId];
      if (panel === undefined) {
        return;
      }
      if (text !== undefined) {
        const { source } = panel.request;
        const current = source.kind === 'statement' ? source.code : source.commandEjson;
        if (text !== current) {
          if (source.kind === 'statement') {
            const rewrite = rewriteForExplain(text, verbosity ?? panel.request.verbosity);
            const collection = rewrite.ok ? rewrite.collection : undefined;
            patchPanel(panelId, {
              title: explainTitle(collection),
              collection,
              request: { ...panel.request, source: { kind: 'statement', code: text } },
              outcome: rewrite.ok
                ? { state: 'loading' }
                : { state: 'refused', message: rewrite.message },
            });
          } else {
            const collection = commandCollection(text) ?? panel.collection;
            patchPanel(panelId, {
              title: explainTitle(collection),
              collection,
              request: { ...panel.request, source: { ...source, commandEjson: text } },
              outcome: { state: 'loading' },
            });
          }
        } else if (panel.outcome.state === 'refused') {
          patchPanel(panelId, { outcome: { state: 'loading' } });
        }
      }
      if (verbosity !== undefined && verbosity !== panel.request.verbosity) {
        patchPanel(panelId, { request: { ...panel.request, verbosity } });
      }
      await run(panelId);
    },

    restoreExplain(panelId, restore) {
      if (get().explainPanels[panelId] !== undefined) {
        return;
      }
      set((state) => ({
        explainPanels: {
          ...state.explainPanels,
          [panelId]: { id: panelId, ...restore, outcome: { state: 'idle' } },
        },
      }));
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
