/// <reference types="vite/client" />
import {
  newId,
  normaliseExplain,
  rpcContract,
  type ExplainResult,
  type PlanVerbosity,
  type RpcCall,
  type RpcClient,
} from '@mongo-gui/core';
import type { z } from 'zod';
import { delay, fail } from './mock-support';

type Rpc = RpcClient['explain'];

/** What the explain mock needs from the mock api around it. */
export interface MockExplainDeps {
  /** Wraps a call with input and output validation and the configured latency. */
  wrap<I extends z.ZodType, O extends z.ZodType>(
    definition: RpcCall<I, O>,
    run: (input: z.output<I>) => z.output<O> | Promise<z.output<O>>,
  ): (raw: z.input<I>) => Promise<z.output<O>>;
  requireUnlocked(): void;
  requireConnected(connectionId: string): void;
}

/** A scripted wait before each explain result, so the loading state shows. */
export const MOCK_EXPLAIN_DELAY_MS = 300;

/** The server version the mock fixtures are read as. Matches the mock connection. */
const MOCK_FIXTURE_DIRECTORY = '8.0.17';

// Each fixture is a lazy loader, so a fixture reaches the browser only when a mock call reads it.
// The eager fixture helpers for stories and tests live in explain-fixture-panels.ts.
const FIXTURE_LOADERS: Readonly<Record<string, () => Promise<unknown>>> = Object.fromEntries(
  Object.entries(
    import.meta.glob<unknown>('../../../core/src/explain/fixtures/**/*.json', {
      import: 'default',
    }),
  ).map(([path, load]) => {
    const relative = path.slice(path.indexOf('/fixtures/') + '/fixtures/'.length);
    return [relative.replace(/\.json$/, ''), load];
  }),
);

/** The plan a statement or command gets in the mock. */
interface MockShape {
  readonly command: 'find' | 'aggregate' | 'update' | 'other';
  readonly sorted: boolean;
  readonly usesIndexedField: boolean;
  /** An aggregate with a $lookup, which has an inner pipeline sub-tree. */
  readonly lookup: boolean;
}

const UPDATE_STATEMENT = /\.(updateOne|updateMany|update|replaceOne|deleteOne|deleteMany|remove)\(/;

function shapeOfStatement(code: string): MockShape {
  let command: MockShape['command'] = 'other';
  if (/\.aggregate\(/.test(code)) {
    command = 'aggregate';
  } else if (UPDATE_STATEMENT.test(code)) {
    command = 'update';
  } else if (/\.find\(/.test(code)) {
    command = 'find';
  }
  return {
    command,
    sorted: /\.sort\(/.test(code),
    usesIndexedField: /customerId/.test(code),
    lookup: /\$lookup/.test(code),
  };
}

function shapeOfCommand(commandEjson: string): MockShape {
  let parsed: Record<string, unknown> = {};
  try {
    const value: unknown = JSON.parse(commandEjson);
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      parsed = value as Record<string, unknown>;
    }
  } catch {
    parsed = {};
  }
  const first = Object.keys(parsed)[0];
  const command: MockShape['command'] =
    first === 'aggregate'
      ? 'aggregate'
      : first === 'update'
        ? 'update'
        : first === 'find'
          ? 'find'
          : 'other';
  return {
    command,
    sorted: 'sort' in parsed,
    usesIndexedField: commandEjson.includes('customerId'),
    lookup: commandEjson.includes('$lookup'),
  };
}

/**
 * The fixture case that stands in for a shape. A case may not have every verbosity, so
 * resultFor falls back to the nearest one the case has.
 */
function caseFor(shape: MockShape): string {
  if (shape.command === 'aggregate') {
    return shape.lookup ? 'lookup-pipeline' : 'aggregate-group';
  }
  if (shape.command === 'update') {
    return 'update-multi';
  }
  if (shape.command === 'find' && shape.sorted) {
    return 'in-memory-sort';
  }
  if (shape.usesIndexedField) {
    return 'ixscan-sort';
  }
  return 'collscan';
}

/**
 * The explain result for one committed fixture, normalised as the router would. `fixture` is a
 * fixture directory and case, for example `8.0.17/collscan`.
 */
// The verbosities a case can fall back to, nearest first. executionStats has the most detail.
const FALLBACK_VERBOSITIES: readonly PlanVerbosity[] = [
  'executionStats',
  'allPlansExecution',
  'queryPlanner',
];

/**
 * The fixture for a case at a verbosity. When the case has no file at that verbosity (for
 * example a $lookup with an inner pipeline is captured at executionStats only), the nearest
 * verbosity the case has is used, so switching verbosity in the panel still shows a plan.
 */
function loaderFor(fixture: string, verbosity: PlanVerbosity) {
  const order = [verbosity, ...FALLBACK_VERBOSITIES.filter((other) => other !== verbosity)];
  for (const candidate of order) {
    const load = FIXTURE_LOADERS[`${fixture}.${candidate}`];
    if (load !== undefined) {
      return load;
    }
  }
  return undefined;
}

async function resultFor(fixture: string, verbosity: PlanVerbosity): Promise<ExplainResult> {
  const load = loaderFor(fixture, verbosity);
  if (load === undefined) {
    throw fail('INTERNAL', 'Explain fixture not found', `${fixture} at ${verbosity}`);
  }
  const raw = await load();
  return {
    requestId: newId(),
    tree: normaliseExplain(raw),
    rawEjson: JSON.stringify(raw, null, 2),
    elapsedMs: MOCK_EXPLAIN_DELAY_MS,
  };
}

/** The explain calls of the mock api. Each call waits the scripted delay before it answers. */
export function createMockExplain(deps: MockExplainDeps): Rpc {
  return {
    run: deps.wrap(rpcContract.explain.run, async (input) => {
      deps.requireUnlocked();
      deps.requireConnected(input.connectionId);
      await delay(MOCK_EXPLAIN_DELAY_MS);
      return resultFor(
        `${MOCK_FIXTURE_DIRECTORY}/${caseFor(shapeOfStatement(input.code))}`,
        input.verbosity,
      );
    }),
    runCommand: deps.wrap(rpcContract.explain.runCommand, async (input) => {
      deps.requireUnlocked();
      deps.requireConnected(input.connectionId);
      await delay(MOCK_EXPLAIN_DELAY_MS);
      return resultFor(
        `${MOCK_FIXTURE_DIRECTORY}/${caseFor(shapeOfCommand(input.commandEjson))}`,
        input.verbosity,
      );
    }),
  };
}
