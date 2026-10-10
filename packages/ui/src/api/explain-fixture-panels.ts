/// <reference types="vite/client" />
import {
  newId,
  normaliseExplain,
  type AppError,
  type ExplainResult,
  type PlanVerbosity,
} from '@mongo-gui/core';
import type { ExplainPanelState } from '../explain/explain-model';

// Story and test helpers. They read every fixture eagerly, so this module must stay out of the
// production renderer. The mock api loads fixtures lazily from mock-explain.ts instead.
const RAW_FIXTURES: Readonly<Record<string, unknown>> = Object.fromEntries(
  Object.entries(
    import.meta.glob<unknown>('../../../core/src/explain/fixtures/**/*.json', {
      eager: true,
      import: 'default',
    }),
  ).map(([path, raw]) => {
    const relative = path.slice(path.indexOf('/fixtures/') + '/fixtures/'.length);
    return [relative.replace(/\.json$/, ''), raw];
  }),
);

/** The mock's scripted delay, as the elapsed time of a fixture result. */
const FIXTURE_ELAPSED_MS = 300;

/**
 * The explain result for one committed fixture, normalised as the router would. `fixture` is a
 * fixture directory and case, for example `sharded/find-sort` or `6.0-sbe/aggregate-group`.
 */
export function explainResultFor(
  fixture: string,
  verbosity: PlanVerbosity,
  elapsedMs: number = FIXTURE_ELAPSED_MS,
): ExplainResult {
  const raw = RAW_FIXTURES[`${fixture}.${verbosity}`];
  if (raw === undefined) {
    throw new Error(`Explain fixture not found: ${fixture} at ${verbosity}`);
  }
  return {
    requestId: newId(),
    tree: normaliseExplain(raw),
    rawEjson: JSON.stringify(raw, null, 2),
    elapsedMs,
  };
}

/** The raw explain document of a fixture, as the server returned it. */
export function rawFixture(fixture: string, verbosity: PlanVerbosity): unknown {
  const raw = RAW_FIXTURES[`${fixture}.${verbosity}`];
  if (raw === undefined) {
    throw new Error(`Explain fixture not found: ${fixture} at ${verbosity}`);
  }
  return raw;
}

interface FixturePanelOptions {
  readonly id: string;
  readonly connectionId: string;
  readonly database: string;
  readonly code: string;
  readonly collection?: string;
  readonly verbosity?: PlanVerbosity;
}

function panelBase(options: FixturePanelOptions): Omit<ExplainPanelState, 'outcome'> {
  return {
    id: options.id,
    title: options.collection === undefined ? 'Explain' : `Explain · ${options.collection}`,
    collection: options.collection,
    request: {
      connectionId: options.connectionId,
      database: options.database,
      source: { kind: 'statement', code: options.code },
      verbosity: options.verbosity ?? 'executionStats',
    },
  };
}

/** A panel that already holds a finished explain of a statement, for stories and tests. */
export function mockExplainPanel(
  options: FixturePanelOptions & { readonly fixture: string },
): ExplainPanelState {
  const verbosity = options.verbosity ?? 'executionStats';
  return {
    ...panelBase(options),
    outcome: { state: 'ready', result: explainResultFor(options.fixture, verbosity) },
  };
}

/** A panel that holds a finished explain of a raw server document, for shapes no fixture has. */
export function mockExplainPanelFromRaw(
  options: FixturePanelOptions & { readonly raw: unknown },
): ExplainPanelState {
  return {
    ...panelBase(options),
    outcome: {
      state: 'ready',
      result: {
        requestId: newId(),
        tree: normaliseExplain(options.raw),
        rawEjson: JSON.stringify(options.raw, null, 2),
        elapsedMs: FIXTURE_ELAPSED_MS,
      },
    },
  };
}

/**
 * A copy of a sharded fixture in which the second shard failed. The planner and execution sides
 * both report the error, as mongos does.
 */
export function withFailedShard(raw: unknown, message: string): unknown {
  const copy = structuredClone(raw) as Json;
  const failed = { shardName: 'shard02', error: { code: 96, errmsg: message } };
  const planner = objectAt(objectAt(copy['queryPlanner'])?.['winningPlan'])?.['shards'];
  if (Array.isArray(planner) && planner.length > 1) {
    planner[1] = failed;
  }
  const exec = objectAt(objectAt(copy['executionStats'])?.['executionStages'])?.['shards'];
  if (Array.isArray(exec) && exec.length > 1) {
    exec[1] = failed;
  }
  return copy;
}

type Json = Record<string, unknown>;

function objectAt(value: unknown): Json | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Json)
    : undefined;
}

/** A panel that is waiting for its explain, for the loading state. */
export function loadingExplainPanel(options: FixturePanelOptions): ExplainPanelState {
  return { ...panelBase(options), outcome: { state: 'loading' } };
}

/** A panel whose explain failed, for the error state. */
export function errorExplainPanel(
  options: FixturePanelOptions & { readonly error: AppError },
): ExplainPanelState {
  return { ...panelBase(options), outcome: { state: 'error', error: options.error } };
}

/** A panel for a statement the explain refuses, for the "no plan" state. */
export function refusedExplainPanel(
  options: FixturePanelOptions & { readonly message: string },
): ExplainPanelState {
  return { ...panelBase(options), outcome: { state: 'refused', message: options.message } };
}
