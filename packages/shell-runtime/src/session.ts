import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { Collection } from 'mongodb';
import { ElectronRuntime } from '@mongosh/browser-runtime-electron';
import { NodeDriverServiceProvider } from '@mongosh/service-provider-node-driver';
import {
  AppErrorException,
  appError,
  toShellResultType,
  type AppError,
  type CompleteRequest,
  type ConnectRequest,
  type EvaluateRequest,
  type NextRequest,
  type SampleSchemaRequest,
  type ShellResponse,
} from '@mongo-gui/core';
import { buildClientOptions, readServerInfo } from '@mongo-gui/mongo-adapter';
import {
  classifyCompletion,
  collectionMemberItems,
  databaseMemberName,
  hasInvalidDatabaseMember,
  isDatabaseMemberLine,
  lineBeforeCursor,
} from './completion-kind';
import { toConnectError, toEvaluationError } from './errors';
import { readString } from './fields';
import { findHostListProblem } from './host-list';
import { formatPrintText, hasMoreResults, isCursorResult, serializePrintable } from './results';
import { summarizeDocuments } from './schema-sampler';

export const DEFAULT_TIMEOUT_MS = 30_000;

// How long an aborted evaluation may keep running after its server operations are killed. Past
// this point the runtime is retired, because the mongosh evaluation cannot be interrupted.
const SETTLE_GRACE_MS = 200;
const PRODUCT_NAME = 'mongo-gui';
const PRODUCT_DOCS_LINK = 'https://www.mongodb.com/docs/mongosh/';
// Keeps BSON wrapper types (Int32, Double, Long) in the sample so the walker can name them.
const SAMPLE_OPTIONS = { promoteValues: false, promoteLongs: false };
const CURSOR_NEXT_CODE = 'it';

export type Emit = (message: ShellResponse) => void;

/**
 * Reads the documents a schema sample holds. Random uses $sample. First and last read the start or
 * the end of the _id order, which costs an index scan instead of a random pick.
 */
function readSample(collection: Collection, request: SampleSchemaRequest): Promise<unknown> {
  if (request.strategy === 'random') {
    return collection.aggregate([{ $sample: { size: request.size } }], SAMPLE_OPTIONS).toArray();
  }
  const direction = request.strategy === 'first' ? 1 : -1;
  return collection
    .find({}, { ...SAMPLE_OPTIONS, sort: { _id: direction }, limit: request.size })
    .toArray();
}

type RuntimeListener = Parameters<ElectronRuntime['setEvaluationListener']>[0];
type RuntimeResult = Awaited<ReturnType<ElectronRuntime['evaluate']>>;

interface OpenConnection {
  readonly generation: number;
  readonly provider: NodeDriverServiceProvider;
  readonly runtime: ElectronRuntime;
  // Settles when the most recent evaluation settles. Null when nothing is pending.
  pendingWork: Promise<void> | null;
}

interface ActiveRun {
  readonly id: string;
  readonly token: string;
  readonly batchSize: number;
  readonly emit: Emit;
  readonly connection: OpenConnection;
  abort(error: AppErrorException): void;
}

interface RunOptions {
  id: string;
  code: string;
  batchSize: number;
  timeoutMs: number;
  emit: Emit;
  connection: OpenConnection;
}

// One session owns one driver connection and one mongosh runtime. Requests are serialised by the
// caller, except cancel, which may arrive while an evaluation runs.
export class ShellSession {
  private connectRequest: ConnectRequest | null = null;
  private connection: OpenConnection | null = null;
  private active: ActiveRun | null = null;
  // Set while an aborted evaluation is being settled or its runtime retired. Requests wait on it.
  private pendingAbort: Promise<void> | null = null;
  // Database to reopen with after a retired runtime. Undefined when the runtime was never retired.
  private resumeDatabase: string | undefined = undefined;
  // The request whose evaluation opened the current cursor. "next" continues that cursor.
  private cursorOwner: string | null = null;
  private generation = 0;
  private readonly bus = new EventEmitter();

  async connect(request: ConnectRequest, emit: Emit): Promise<void> {
    // Checked before any state changes, so a malformed host list leaves the current connection.
    const problem = findHostListProblem(request.uri);
    if (problem !== undefined) {
      throw new AppErrorException(appError('CONNECTION_FAILED', problem));
    }
    await this.closeConnection();
    this.connectRequest = request;
    try {
      const connection = await this.open(request.uri, request.driverOptions, request.database);
      const info = await readServerInfo(connection.provider.getRawClient());
      emit({
        id: request.id,
        kind: 'connected',
        serverVersion: info.serverVersion,
        topology: info.topology,
      });
    } catch (error) {
      await this.closeConnection();
      this.connectRequest = null;
      throw new AppErrorException(toConnectError(error));
    }
  }

  async evaluate(request: EvaluateRequest, emit: Emit): Promise<void> {
    await this.runCode(
      request.id,
      request.code,
      request.batchSize,
      request.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      emit,
      false,
    );
  }

  // Continues the cursor opened by the request named in cursorRequestId of earlier results.
  async next(request: NextRequest, emit: Emit): Promise<void> {
    await this.runCode(
      request.id,
      CURSOR_NEXT_CODE,
      request.batchSize,
      DEFAULT_TIMEOUT_MS,
      emit,
      true,
    );
  }

  // Cancels the running evaluation with the given request id. Other ids are ignored.
  async cancel(targetId: string): Promise<void> {
    const run = this.active;
    if (run === null || run.id !== targetId) {
      return;
    }
    await this.abortRun(run, appError('CANCELLED', 'The operation was cancelled'));
  }

  async complete(request: CompleteRequest, emit: Emit): Promise<void> {
    try {
      const connection = await this.ensureConnection();
      const line = lineBeforeCursor(request.code, request.position);
      const completions = await connection.runtime.getCompletions(line);
      const texts = completions
        .map((completion) => completion.completion)
        .filter((text) => !hasInvalidDatabaseMember(text));
      const memberLine = isDatabaseMemberLine(line);
      const names =
        memberLine || texts.some((text) => databaseMemberName(text) !== undefined)
          ? await this.collectionNames(connection)
          : [];
      const collections = new Set(names);
      const items = texts.map((text) => ({ text, kind: classifyCompletion(text, collections) }));
      const members = collectionMemberItems(line, names, new Set(texts));
      emit({
        id: request.id,
        kind: 'completions',
        items: [...items, ...members],
      });
    } catch (error) {
      throw toFailure(error);
    }
  }

  async sampleSchema(request: SampleSchemaRequest, emit: Emit): Promise<void> {
    try {
      const connection = await this.ensureConnection();
      const collection = connection.provider
        .getRawClient()
        .db(request.database)
        .collection(request.collection);
      const rows: unknown = await readSample(collection, request);
      const summary = summarizeDocuments(Array.isArray(rows) ? rows : []);
      emit({
        id: request.id,
        kind: 'schema',
        fields: summary.fields,
        sampled: summary.sampled,
      });
    } catch (error) {
      throw toFailure(error);
    }
  }

  async disconnect(): Promise<void> {
    this.connectRequest = null;
    await this.closeConnection();
  }

  private async runCode(
    id: string,
    code: string,
    batchSize: number,
    timeoutMs: number,
    emit: Emit,
    continuation: boolean,
  ): Promise<void> {
    try {
      const connection = await this.ensureConnection();
      const started = performance.now();
      const result = await this.run({ id, code, batchSize, timeoutMs, emit, connection });
      const cursor = isCursorResult(result.printable);
      if (cursor && !continuation) {
        this.cursorOwner = id;
      }
      emit({
        id,
        kind: 'result',
        type: toShellResultType(result.type, result.printable),
        printableEjson: serializePrintable(result.printable),
        hasMore: hasMoreResults(result.printable),
        ...(cursor && this.cursorOwner !== null ? { cursorRequestId: this.cursorOwner } : {}),
        elapsedMs: performance.now() - started,
      });
    } catch (error) {
      throw toFailure(error);
    }
  }

  private async run(options: RunOptions): Promise<RuntimeResult> {
    const { id, code, batchSize, timeoutMs, emit, connection } = options;
    // Every server operation issued while this evaluation runs carries a unique comment, so cancel
    // can find and kill those operations on the server.
    const token = randomUUID();
    const commentedOptions = { ...connection.provider.baseCmdOptions, comment: token };
    connection.provider.baseCmdOptions = commentedOptions;

    let rejectRun: (reason: unknown) => void = () => undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectRun = reject;
    });
    const run: ActiveRun = {
      id,
      token,
      batchSize,
      emit,
      connection,
      abort: (error) => {
        rejectRun(error);
      },
    };
    // The run must be registered before evaluation starts. Some shell commands, such as "it",
    // read displayBatchSize synchronously inside evaluate, before its first await.
    this.active = run;
    const work = connection.runtime.evaluate(code);
    connection.pendingWork = work.then(
      () => undefined,
      () => undefined,
    );
    const timer = setTimeout(() => {
      void this.abortRun(
        run,
        appError('CANCELLED', `The operation timed out after ${timeoutMs} ms`),
      );
    }, timeoutMs);
    try {
      return await Promise.race([work, aborted]);
    } finally {
      clearTimeout(timer);
      if (this.active === run) {
        this.active = null;
      }
    }
  }

  // Rejects the run at once. The returned promise resolves after its server operations are killed
  // and, if the evaluation is still running, its runtime is retired. Requests made meanwhile wait.
  private abortRun(run: ActiveRun, error: AppError): Promise<void> {
    if (this.active !== run) {
      return Promise.resolve();
    }
    this.active = null;
    run.abort(new AppErrorException(error));
    const settled = this.settleAbort(run);
    this.pendingAbort = settled;
    return settled;
  }

  private async settleAbort(run: ActiveRun): Promise<void> {
    await killServerOperations(run.connection.provider, run.token);
    if (this.connection !== run.connection) {
      return;
    }
    const pending = run.connection.pendingWork;
    if (pending === null || (await settlesWithin(pending, SETTLE_GRACE_MS))) {
      return;
    }
    await this.retireConnection(run.connection);
  }

  // Closes the runtime whose evaluation keeps running. The next request opens a new runtime with
  // the same database, so writes from the abandoned evaluation cannot land on the new one.
  private async retireConnection(connection: OpenConnection): Promise<void> {
    this.resumeDatabase = (await this.currentDatabase(connection)) ?? this.connectRequest?.database;
    if (this.connection === connection) {
      this.connection = null;
    }
    await closeProvider(connection.provider);
  }

  private async awaitAbort(): Promise<void> {
    const abort = this.pendingAbort;
    if (abort !== null) {
      this.pendingAbort = null;
      await abort;
    }
  }

  private async ensureConnection(): Promise<OpenConnection> {
    await this.awaitAbort();
    const request = this.connectRequest;
    if (request === null) {
      throw new AppErrorException(appError('NOT_CONNECTED', 'Connect to a server first'));
    }
    const current = this.connection;
    if (current !== null) {
      return current;
    }
    const database = this.resumeDatabase ?? request.database;
    this.resumeDatabase = undefined;
    return this.open(request.uri, request.driverOptions, database);
  }

  private async open(
    uri: string,
    driverOptions: Record<string, unknown> | undefined,
    database: string | undefined,
  ): Promise<OpenConnection> {
    const config = buildClientOptions({ name: 'shell', uri });
    const options = {
      ...config.options,
      ...driverOptions,
      productName: PRODUCT_NAME,
      productDocsLink: PRODUCT_DOCS_LINK,
    };
    const provider = await NodeDriverServiceProvider.connect(config.uri, options, {}, this.bus);
    this.generation += 1;
    const connection: OpenConnection = {
      generation: this.generation,
      provider,
      runtime: new ElectronRuntime(provider, this.bus),
      pendingWork: null,
    };
    connection.runtime.setEvaluationListener(this.listenerFor(connection.generation));
    this.connection = connection;
    this.cursorOwner = null;
    if (database !== undefined) {
      await connection.runtime.evaluate(`use(${JSON.stringify(database)})`);
    }
    return connection;
  }

  private async closeConnection(): Promise<void> {
    await this.awaitAbort();
    const connection = this.connection;
    this.connection = null;
    this.resumeDatabase = undefined;
    if (connection !== null) {
      await closeProvider(connection.provider);
    }
  }

  // Listener for one runtime generation. Output from a replaced runtime is dropped, so a late
  // print cannot reach the request that replaced it.
  private listenerFor(generation: number): RuntimeListener {
    return {
      onPrint: (values) => {
        const run = this.active;
        if (run === null || run.connection.generation !== generation) {
          return;
        }
        run.emit({
          id: run.id,
          kind: 'print',
          text: formatPrintText(values.map((value) => value.printable)),
        });
      },
      // The cursor batch size of the current request. "it" and the first cursor page read it here.
      // The mongosh types map each key to its own value type. displayBatchSize is a number, and
      // the cast is needed because the typed signature is generic over the key.
      getConfig: ((key: string) => {
        const run = this.active;
        if (
          key !== 'displayBatchSize' ||
          run === null ||
          run.connection.generation !== generation
        ) {
          return undefined;
        }
        return run.batchSize;
      }) as NonNullable<RuntimeListener['getConfig']>,
    };
  }

  private async currentDatabase(connection: OpenConnection): Promise<string | undefined> {
    try {
      const result = await connection.runtime.evaluate('db.getName()');
      return typeof result.printable === 'string' ? result.printable : undefined;
    } catch {
      return undefined;
    }
  }

  // The collection names of the current database, in the order the server lists them.
  private async collectionNames(connection: OpenConnection): Promise<string[]> {
    const database = await this.currentDatabase(connection);
    if (database === undefined) {
      return [];
    }
    const rows: unknown = await connection.provider.listCollections(database);
    const names = Array.isArray(rows) ? rows.map((row: unknown) => readString(row, 'name')) : [];
    return names.filter((name): name is string => name !== undefined);
  }
}

function toFailure(error: unknown): AppErrorException {
  return error instanceof AppErrorException
    ? error
    : new AppErrorException(toEvaluationError(error));
}

async function closeProvider(provider: NodeDriverServiceProvider): Promise<void> {
  try {
    await provider.close();
  } catch {
    // The client may already be closed. Nothing else needs releasing.
  }
}

// Kills the server operations that carry the run's comment token. The token is the baseCmdOptions
// comment, which the driver layers under the per-call options. A comment set on a query by the user
// replaces the token, so such an operation is not found here and runs until it finishes.
async function killServerOperations(
  provider: NodeDriverServiceProvider,
  token: string,
): Promise<void> {
  const admin = provider.getRawClient().db('admin');
  try {
    const rows: unknown = await admin
      .aggregate([
        { $currentOp: { allUsers: false, idleCursors: false } },
        { $match: { 'command.comment': token } },
        { $project: { opid: 1 } },
      ])
      .toArray();
    for (const opid of operationIds(rows)) {
      await admin.command({ killOp: 1, op: opid });
    }
  } catch {
    // Best effort. The client-side evaluation is already rejected, and the server operation ends
    // when it finishes or when the connection closes.
  }
}

function operationIds(rows: unknown): (number | string)[] {
  if (!Array.isArray(rows)) {
    return [];
  }
  return rows.flatMap((row: unknown) => {
    if (typeof row !== 'object' || row === null || !('opid' in row)) {
      return [];
    }
    const opid: unknown = row.opid;
    return typeof opid === 'number' || typeof opid === 'string' ? [opid] : [];
  });
}

async function settlesWithin(promise: Promise<void>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => {
      resolve(false);
    }, ms);
  });
  try {
    return await Promise.race([promise.then(() => true), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
