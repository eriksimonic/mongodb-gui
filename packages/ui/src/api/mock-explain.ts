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
import type { ExplainPanelState } from '../explain/explain-model';
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

// Raw explain documents from the committed fixtures, keyed by `<directory>/<case>.<verbosity>`.
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

/** The plan a statement or command gets in the mock. */
interface MockShape {
  readonly command: 'find' | 'aggregate' | 'update' | 'other';
  readonly sorted: boolean;
  readonly usesIndexedField: boolean;
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
  };
}

/** The fixture case that stands in for a shape. Every case exists at every verbosity. */
function caseFor(shape: MockShape): string {
  if (shape.command === 'aggregate') {
    return 'aggregate-group';
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
 * fixture directory and case, for example `sharded/find-sort` or `6.0-sbe/aggregate-group`.
 */
export function explainResultFor(
  fixture: string,
  verbosity: PlanVerbosity,
  elapsedMs: number = MOCK_EXPLAIN_DELAY_MS,
): ExplainResult {
  const raw = RAW_FIXTURES[`${fixture}.${verbosity}`];
  if (raw === undefined) {
    throw fail('INTERNAL', 'Explain fixture not found', `${fixture} at ${verbosity}`);
  }
  return {
    requestId: newId(),
    tree: normaliseExplain(raw),
    rawEjson: JSON.stringify(raw, null, 2),
    elapsedMs,
  };
}

/** A panel that already holds a finished explain of a statement, for stories and tests. */
export function mockExplainPanel(options: {
  readonly id: string;
  readonly connectionId: string;
  readonly database: string;
  readonly code: string;
  readonly fixture: string;
  readonly verbosity?: PlanVerbosity;
  readonly collection?: string;
}): ExplainPanelState {
  const verbosity = options.verbosity ?? 'executionStats';
  return {
    id: options.id,
    title: options.collection === undefined ? 'Explain' : `Explain · ${options.collection}`,
    collection: options.collection,
    request: {
      connectionId: options.connectionId,
      database: options.database,
      source: { kind: 'statement', code: options.code },
      verbosity,
    },
    outcome: {
      state: 'ready',
      result: explainResultFor(options.fixture, verbosity),
    },
  };
}

/** The explain calls of the mock api. Each call waits the scripted delay before it answers. */
export function createMockExplain(deps: MockExplainDeps): Rpc {
  const answer = (fixture: string, verbosity: PlanVerbosity): ExplainResult => {
    return explainResultFor(`${MOCK_FIXTURE_DIRECTORY}/${fixture}`, verbosity);
  };
  return {
    run: deps.wrap(rpcContract.explain.run, async (input) => {
      deps.requireUnlocked();
      deps.requireConnected(input.connectionId);
      await delay(MOCK_EXPLAIN_DELAY_MS);
      return answer(caseFor(shapeOfStatement(input.code)), input.verbosity);
    }),
    runCommand: deps.wrap(rpcContract.explain.runCommand, async (input) => {
      deps.requireUnlocked();
      deps.requireConnected(input.connectionId);
      await delay(MOCK_EXPLAIN_DELAY_MS);
      return answer(caseFor(shapeOfCommand(input.commandEjson)), input.verbosity);
    }),
  };
}
