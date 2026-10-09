import {
  appError,
  summarizeCanonicalSample,
  type CompletionItem,
  type RpcEvent,
  type SchemaSampleStrategy,
  type SchemaSummary,
  type ShellEvaluation,
  type ShellResult,
} from '@mongo-gui/core';
import type { MockCollection, MockDatabase } from './mock-catalog';

export type MockShellEmit = (event: RpcEvent) => void;

interface OpenCursor {
  readonly connectionId: string;
  readonly documents: readonly unknown[];
  offset: number;
}

interface EvaluationInput {
  readonly connectionId: string;
  readonly requestId: string;
  readonly database: string;
  readonly code: string;
  readonly batchSize: number;
}

// What a statement of the fake evaluator does. Anything else echoes the code as a string.
type Statement =
  | { readonly kind: 'print'; readonly args: readonly string[] }
  | { readonly kind: 'sleep'; readonly ms: number }
  | {
      readonly kind: 'documents';
      readonly collection: string;
      readonly aggregate: boolean;
      readonly limit: number | undefined;
    }
  | { readonly kind: 'count'; readonly collection: string }
  | { readonly kind: 'getName' }
  | { readonly kind: 'echo' }
  | { readonly kind: 'syntax'; readonly message: string };

const COMPLETION_METHODS = ['find', 'findOne', 'aggregate', 'countDocuments'] as const;
const IDENTIFIER = '[A-Za-z_][A-Za-z0-9_]*';

/**
 * A small stand-in for the mongosh runtime. It understands the statements the UI needs to run
 * against fixtures. It handles find and aggregate with batches, countDocuments, print, sleep and
 * getName.
 * Anything else returns the code as a string. It is not a JavaScript evaluator.
 */
export function createMockShell(
  emit: MockShellEmit,
  catalogOf: (connectionId: string) => MockDatabase[],
) {
  const cursors = new Map<string, OpenCursor>();
  const running = new Map<string, () => void>();
  const cancelled = new Set<string>();

  function collectionOf(
    connectionId: string,
    database: string,
    collection: string,
  ): MockCollection | undefined {
    return catalogOf(connectionId)
      .find((item) => item.name === database)
      ?.collections.find((item) => item.info.name === collection);
  }

  function collectionDocuments(
    connectionId: string,
    database: string,
    collection: string,
  ): readonly unknown[] {
    return (collectionOf(connectionId, database, collection)?.documents ?? []).map(toCanonical);
  }

  function runStatement(input: EvaluationInput, statement: Statement): Promise<ShellEvaluation> {
    const started = performance.now();
    const elapsed = (): number => performance.now() - started;
    const value = (result: ShellResult): ShellEvaluation => ({
      requestId: input.requestId,
      result,
      elapsedMs: elapsed(),
    });
    const failure = (code: 'VALIDATION' | 'CANCELLED', message: string): ShellEvaluation => ({
      requestId: input.requestId,
      error: appError(code, message),
      elapsedMs: elapsed(),
    });

    switch (statement.kind) {
      case 'syntax':
        return Promise.resolve(failure('VALIDATION', statement.message));
      case 'echo':
        return Promise.resolve(
          value({ type: 'string', printableEjson: JSON.stringify(input.code), hasMore: false }),
        );
      case 'getName':
        return Promise.resolve(
          value({ type: 'string', printableEjson: JSON.stringify(input.database), hasMore: false }),
        );
      case 'count': {
        const total =
          collectionOf(input.connectionId, input.database, statement.collection)?.documents
            .length ?? 0;
        return Promise.resolve(
          value({ type: 'number', printableEjson: int32Text(total), hasMore: false }),
        );
      }
      case 'print': {
        emit({
          type: 'shell:print',
          connectionId: input.connectionId,
          requestId: input.requestId,
          text: statement.args.join(' '),
        });
        return Promise.resolve(
          value({ type: 'undefined', printableEjson: 'null', hasMore: false }),
        );
      }
      case 'sleep':
        return sleepUnlessCancelled(input.requestId, statement.ms).then((finished) =>
          finished
            ? value({ type: 'undefined', printableEjson: 'null', hasMore: false })
            : failure('CANCELLED', 'The operation was cancelled'),
        );
      case 'documents': {
        const all = collectionDocuments(input.connectionId, input.database, statement.collection);
        const documents = statement.limit === undefined ? all : all.slice(0, statement.limit);
        const batch = documents.slice(0, input.batchSize);
        const hasMore = batch.length < documents.length;
        if (hasMore) {
          cursors.set(input.requestId, {
            connectionId: input.connectionId,
            documents,
            offset: batch.length,
          });
        }
        return Promise.resolve(
          value({
            type: statement.aggregate ? 'AggregationCursor' : 'Cursor',
            printableEjson: batchText(batch, hasMore),
            hasMore,
            ...(hasMore ? { cursorRequestId: input.requestId } : {}),
          }),
        );
      }
    }
  }

  // Resolves true when the sleep ends and false when cancel ends it first.
  function sleepUnlessCancelled(requestId: string, ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        running.delete(requestId);
        resolve(true);
      }, ms);
      running.set(requestId, () => {
        clearTimeout(timer);
        running.delete(requestId);
        resolve(false);
      });
    });
  }

  return {
    async evaluate(input: EvaluationInput): Promise<ShellEvaluation> {
      const statement = parseStatement(input.code);
      const outcome = await runStatement(input, statement);
      if (cancelled.delete(input.requestId)) {
        return {
          requestId: input.requestId,
          error: appError('CANCELLED', 'The operation was cancelled'),
          elapsedMs: outcome.elapsedMs,
        };
      }
      return outcome;
    },

    next(input: { connectionId: string; requestId: string; batchSize: number }): ShellEvaluation {
      const started = performance.now();
      const cursor = cursors.get(input.requestId);
      if (cursor === undefined || cursor.connectionId !== input.connectionId) {
        return {
          requestId: input.requestId,
          error: appError('VALIDATION', 'The cursor is closed. Run the query again.'),
          elapsedMs: performance.now() - started,
        };
      }
      const batch = cursor.documents.slice(cursor.offset, cursor.offset + input.batchSize);
      cursor.offset += batch.length;
      const hasMore = cursor.offset < cursor.documents.length;
      if (!hasMore) {
        cursors.delete(input.requestId);
      }
      return {
        requestId: input.requestId,
        result: {
          type: 'CursorIterationResult',
          printableEjson: batchText(batch, hasMore),
          hasMore,
          ...(hasMore ? { cursorRequestId: input.requestId } : {}),
        },
        elapsedMs: performance.now() - started,
      };
    },

    cancel(requestId: string): void {
      const stop = running.get(requestId);
      if (stop !== undefined) {
        cancelled.add(requestId);
        stop();
      }
    },

    complete(input: {
      connectionId: string;
      database: string;
      code: string;
      position: number;
    }): CompletionItem[] {
      const before = input.code.slice(0, input.position);
      if (new RegExp(`db\\.${IDENTIFIER}\\.\\w*$`).test(before)) {
        return COMPLETION_METHODS.map((text) => ({ text, kind: 'method' }));
      }
      if (/db\.\w*$/.test(before)) {
        const names =
          catalogOf(input.connectionId)
            .find((item) => item.name === input.database)
            ?.collections.map((item) => item.info.name) ?? [];
        return names.map((text) => ({ text, kind: 'collection' }));
      }
      return [];
    },

    sampleSchema(input: {
      connectionId: string;
      database: string;
      collection: string;
      size: number;
      strategy: SchemaSampleStrategy;
    }): SchemaSummary {
      const documents = collectionDocuments(input.connectionId, input.database, input.collection);
      return summarizeCanonicalSample(pickSample(documents, input.size, input.strategy));
    },

    clearConnection(connectionId: string): void {
      for (const [requestId, cursor] of cursors) {
        if (cursor.connectionId === connectionId) {
          cursors.delete(requestId);
        }
      }
    },
  };
}

/** Reads one statement of the fake language. Parentheses must balance. */
export function parseStatement(code: string): Statement {
  const text = code.trim();
  let depth = 0;
  let quote: string | undefined;
  for (const char of text) {
    if (quote !== undefined) {
      if (char === quote) {
        quote = undefined;
      }
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '(') {
      depth += 1;
    } else if (char === ')') {
      depth -= 1;
    }
  }
  if (depth !== 0 || quote !== undefined) {
    return { kind: 'syntax', message: 'Unexpected end of input' };
  }
  const print = /^(?:print|console\.log)\((.*)\)$/s.exec(text);
  if (print !== null) {
    const args = (print[1] ?? '')
      .split(',')
      .map((arg) => arg.trim())
      .filter((arg) => arg !== '');
    return { kind: 'print', args: args.map(unquote) };
  }
  const sleep = /^sleep\((\d+)\)$/.exec(text);
  if (sleep !== null) {
    return { kind: 'sleep', ms: Number(sleep[1]) };
  }
  const query = new RegExp(`^db\\.(${IDENTIFIER})\\.(find|aggregate)\\(`).exec(text);
  if (query !== null) {
    const limit = /\.limit\((\d+)\)/.exec(text);
    return {
      kind: 'documents',
      collection: query[1] ?? '',
      aggregate: query[2] === 'aggregate',
      limit: limit === null ? undefined : Number(limit[1]),
    };
  }
  const count = new RegExp(`^db\\.(${IDENTIFIER})\\.countDocuments\\(`).exec(text);
  if (count !== null) {
    return { kind: 'count', collection: count[1] ?? '' };
  }
  if (text === 'db.getName()') {
    return { kind: 'getName' };
  }
  return { kind: 'echo' };
}

// Numbers are written the way canonical EJSON writes them: int32 values with $numberInt, the rest
// with $numberDouble. Nested values convert too.
export function toCanonical(value: unknown): unknown {
  if (typeof value === 'number') {
    return Number.isInteger(value) && Math.abs(value) <= 2_147_483_647
      ? { $numberInt: String(value) }
      : { $numberDouble: String(value) };
  }
  if (Array.isArray(value)) {
    return value.map(toCanonical);
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, toCanonical(item)]));
  }
  return value;
}

// Canonical EJSON writes an int32 with its wrapper, as the runtime does.
function int32Text(value: number): string {
  return JSON.stringify({ $numberInt: String(value) });
}

// A cursor batch has the same shape the runtime prints. It holds the documents and whether more
// follow.
function batchText(documents: readonly unknown[], hasMore: boolean): string {
  return JSON.stringify({ cursorHasMore: hasMore, documents });
}

function unquote(arg: string): string {
  const quoted = /^(["'])(.*)\1$/s.exec(arg);
  return quoted === null ? arg : (quoted[2] ?? '');
}

/**
 * The documents a schema sample reads. The mock holds its documents in insertion order, so random
 * takes the first documents too. That keeps the mock deterministic.
 */
export function pickSample(
  documents: readonly unknown[],
  size: number,
  strategy: SchemaSampleStrategy,
): readonly unknown[] {
  if (strategy === 'last') {
    return documents.slice(Math.max(0, documents.length - size));
  }
  return documents.slice(0, size);
}
