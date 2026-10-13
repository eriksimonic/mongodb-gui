import { randomUUID } from 'node:crypto';
import {
  AppErrorException,
  DEFAULT_BATCH_SIZE,
  appError,
  normaliseExplain,
  rewriteForExplain,
  rpcContract,
  type ExplainResult,
  type ExplainRunCommandInput,
  type ExplainRunInput,
} from '@mongo-gui/core';
import {
  explainableCommand,
  parseCommandEjson,
  runExplainCommand,
  wrapWriteCommand,
} from '@mongo-gui/mongo-adapter';
import { driverCall, entry, type Operation } from './operation';
import type { ShellRegistry } from './shell';

/** The client an explain command runs against. */
type ExplainClient = Parameters<typeof runExplainCommand>[0];

/** The shell runtime call the explain statement uses. */
type ExplainShell = Pick<ShellRegistry, 'evaluate'>;

/** What the explain calls need from the router. */
export interface ExplainDeps {
  readonly getClient: (connectionId: string) => ExplainClient;
  /** Whether the connection is open. An explain command on any other connection is refused. */
  readonly isConnected: (connectionId: string) => boolean;
  /** Runs the action on the connection's shell. The shell service checks the connection first. */
  readonly shellCall: <T>(
    connectionId: string,
    action: (shell: ExplainShell) => Promise<T>,
  ) => Promise<T>;
}

/** Explain for a statement and for a captured command. Both return the same result shape. */
export function explainOperations(deps: ExplainDeps): [string, Operation][] {
  /**
   * Explains the single collection query in a statement. The rewritten statement runs on the
   * connection's runtime, and the server returns the plan without running the query.
   */
  async function explainStatement(input: ExplainRunInput): Promise<ExplainResult> {
    const rewrite = rewriteForExplain(input.code, input.verbosity);
    if (!rewrite.ok) {
      throw new AppErrorException(appError('VALIDATION', rewrite.message));
    }
    const requestId = randomUUID();
    const evaluation = await deps.shellCall(input.connectionId, (shell) =>
      shell.evaluate({
        connectionId: input.connectionId,
        requestId,
        database: input.database,
        code: rewrite.code,
        batchSize: DEFAULT_BATCH_SIZE,
      }),
    );
    if (evaluation.error !== undefined) {
      throw new AppErrorException(evaluation.error);
    }
    if (evaluation.result === undefined) {
      throw new AppErrorException(appError('INTERNAL', 'The explain returned no result.'));
    }
    return explainResult(requestId, evaluation.result.printableEjson, evaluation.elapsedMs);
  }

  /** Explains a captured command, such as a profiler entry, through the connection's driver. */
  async function explainCommand(input: ExplainRunCommandInput): Promise<ExplainResult> {
    if (!deps.isConnected(input.connectionId)) {
      throw new AppErrorException(appError('NOT_CONNECTED', 'Connect to the server first.'));
    }
    const parsed = parseCommandEjson(input.commandEjson);
    const command =
      parsed !== undefined && input.profileOp !== undefined && input.collection !== undefined
        ? wrapWriteCommand(parsed, input.profileOp, input.collection)
        : parsed;
    if (command === undefined || explainableCommand(command) === undefined) {
      throw new AppErrorException(appError('VALIDATION', 'This command cannot be explained.'));
    }
    const result = await driverCall(() =>
      runExplainCommand(deps.getClient(input.connectionId), {
        database: input.database,
        command,
        verbosity: input.verbosity,
      }),
    );
    if (result === undefined) {
      throw new AppErrorException(appError('VALIDATION', 'This command cannot be explained.'));
    }
    return explainResult(randomUUID(), JSON.stringify(result.raw), result.elapsedMs);
  }

  return [
    entry('explain.run', rpcContract.explain.run, (input) => explainStatement(input)),
    entry('explain.runCommand', rpcContract.explain.runCommand, (input) => explainCommand(input)),
  ];
}

/**
 * Builds the explain result from a server explain document. The text is canonical EJSON, which
 * the normaliser reads. The raw text is pretty printed for the raw tab.
 */
function explainResult(requestId: string, printable: string, elapsedMs: number): ExplainResult {
  let raw: unknown;
  try {
    raw = JSON.parse(printable);
  } catch {
    throw new AppErrorException(appError('INTERNAL', 'The explain output is not JSON.'));
  }
  return {
    requestId,
    tree: normaliseExplain(raw),
    rawEjson: JSON.stringify(raw, null, 2),
    // Whole milliseconds, so the header and the result do not show sub-millisecond noise.
    elapsedMs: Math.round(elapsedMs),
  };
}
