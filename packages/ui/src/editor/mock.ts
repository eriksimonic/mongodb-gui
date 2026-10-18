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
import type { MockCollection, MockDatabase } from '../api/mock-catalog';
import { parsePipeline, runPipeline } from './mock-aggregate';

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

// What a statement of the fake evaluator does. The $lookup sampling code of the explain panel gets a
// fixed sample document. Anything else echoes the code as a string.
type Statement =
  | { readonly kind: 'print'; readonly args: readonly string[] }
  | { readonly kind: 'sleep'; readonly ms: number }
  | {
      readonly kind: 'documents';
      readonly collection: string;
      readonly aggregate: boolean;
      readonly limit: number | undefined;
      /** The text of an aggregate's pipeline, in mongosh notation. */
      readonly pipelineText?: string;
    }
  | { readonly kind: 'count'; readonly collection: string }
  | { readonly kind: 'getName' }
  | { readonly kind: 'lookupSample' }
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
      case 'lookupSample':
        return Promise.resolve(
          value({
            type: 'string',
            printableEjson: JSON.stringify(JSON.stringify({ vars: {}, local: [1] })),
            hasMore: false,
          }),
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
        const all = documentsOf(input, statement);
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

  // The documents a find or aggregate reads. An aggregate runs its pipeline when every stage is one
  // the mock understands, and otherwise reads the whole collection.
  function documentsOf(
    input: EvaluationInput,
    statement: Extract<Statement, { kind: 'documents' }>,
  ): readonly unknown[] {
    const pipeline =
      statement.pipelineText === undefined ? undefined : parsePipeline(statement.pipelineText);
    if (pipeline !== undefined) {
      const raw = (name: string): readonly Record<string, unknown>[] =>
        collectionOf(input.connectionId, input.database, name)?.documents ?? [];
      const result = runPipeline(pipeline, raw(statement.collection), raw);
      if (result !== undefined) {
        return result.map(toCanonical);
      }
    }
    return collectionDocuments(input.connectionId, input.database, statement.collection);
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
      // Like the runtime, each text is the whole line before the cursor with the completion
      // applied, not just the completion.
      const line = lineBefore(input.code, input.position);
      const head = line.slice(0, line.length - (/\w*$/.exec(line)?.[0].length ?? 0));
      if (new RegExp(`db\\.${IDENTIFIER}\\.$`).test(head)) {
        return COMPLETION_METHODS.map((method) => ({ text: `${head}${method}`, kind: 'method' }));
      }
      if (/db\.$/.test(head)) {
        const names =
          catalogOf(input.connectionId)
            .find((item) => item.name === input.database)
            ?.collections.map((item) => item.info.name) ?? [];
        return names.map((name) => ({ text: `${head}${name}`, kind: 'collection' }));
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
    const pipelineText =
      query[2] === 'aggregate' ? argumentOf(text, query[0].length - 1) : undefined;
    return {
      kind: 'documents',
      collection: query[1] ?? '',
      aggregate: query[2] === 'aggregate',
      limit: limit === null ? undefined : Number(limit[1]),
      ...(pipelineText === undefined ? {} : { pipelineText }),
    };
  }
  const count = new RegExp(`^db\\.(${IDENTIFIER})\\.countDocuments\\(`).exec(text);
  if (count !== null) {
    return { kind: 'count', collection: count[1] ?? '' };
  }
  if (text.startsWith('(() => {') && text.includes('EJSON.parse(')) {
    return { kind: 'lookupSample' };
  }
  if (text === 'db.getName()') {
    return { kind: 'getName' };
  }
  return { kind: 'echo' };
}

/** The text between the parenthesis at `open` and its closing one, skipping quoted text. */
function argumentOf(text: string, open: number): string | undefined {
  let depth = 0;
  let quote: string | undefined;
  for (let index = open; index < text.length; index += 1) {
    const char = text.charAt(index);
    if (quote !== undefined) {
      quote = char === quote ? undefined : quote;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '(') {
      depth += 1;
    } else if (char === ')') {
      depth -= 1;
      if (depth === 0) {
        return text.slice(open + 1, index);
      }
    }
  }
  return undefined;
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

function lineBefore(code: string, position: number): string {
  const before = code.slice(0, position);
  return before.slice(before.lastIndexOf('\n') + 1);
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
