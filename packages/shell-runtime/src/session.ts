import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
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
import { buildClientOptions } from '@mongo-gui/mongo-adapter';
import { classifyCompletion, databaseMemberName, lineBeforeCursor } from './completion-kind';
import { toConnectError, toEvaluationError } from './errors';
import { readString } from './fields';
import { formatPrintText, hasMoreResults, serializePrintable } from './results';
import { readServerInfo } from './server-info';
import { summarizeDocuments } from './schema-sampler';

export const DEFAULT_TIMEOUT_MS = 30_000;

// After an abandoned evaluation, the runtime is replaced unless the evaluation settles in this
// time. A server operation killed by cancel settles within it, so the runtime is kept.
const SETTLE_GRACE_MS = 200;
const PRODUCT_NAME = 'mongo-gui';
const PRODUCT_DOCS_LINK = 'https://www.mongodb.com/docs/mongosh/';
// Keeps BSON wrapper types (Int32, Double, Long) in the sample so the walker can name them.
const SAMPLE_OPTIONS = { promoteValues: false, promoteLongs: false };
const CURSOR_NEXT_CODE = 'it';

export type Emit = (message: ShellResponse) => void;

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

// One session owns one driver connection and one mongosh runtime. Requests are serialised by the
// caller, except cancel, which may arrive while an evaluation runs.
export class ShellSession {
  private connectRequest: ConnectRequest | null = null;
  private connection: OpenConnection | null = null;
  private active: ActiveRun | null = null;
  private generation = 0;
  private readonly bus = new EventEmitter();

  async connect(request: ConnectRequest, emit: Emit): Promise<void> {
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
    );
  }

  // Continues the cursor from the most recent result by evaluating the mongosh "it" command.
  async next(request: NextRequest, emit: Emit): Promise<void> {
    await this.runCode(request.id, CURSOR_NEXT_CODE, request.batchSize, DEFAULT_TIMEOUT_MS, emit);
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
      const texts = completions.map((completion) => completion.completion);
      const collections = texts.some((text) => databaseMemberName(text) !== undefined)
        ? await this.collectionNames(connection)
        : new Set<string>();
      emit({
        id: request.id,
        kind: 'completions',
        items: texts.map((text) => ({ text, kind: classifyCompletion(text, collections) })),
      });
    } catch (error) {
      throw toFailure(error);
    }
  }

  async sampleSchema(request: SampleSchemaRequest, emit: Emit): Promise<void> {
    try {
      const connection = await this.ensureConnection();
      const rows: unknown = await connection.provider
        .getRawClient()
        .db(request.database)
        .collection(request.collection)
        .aggregate([{ $sample: { size: request.size } }], SAMPLE_OPTIONS)
        .toArray();
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
  ): Promise<void> {
    try {
      const connection = await this.ensureConnection();
      const started = performance.now();
      const result = await this.run({ id, code, batchSize, timeoutMs, emit, connection });
      emit({
        id,
        kind: 'result',
        type: toShellResultType(result.type, result.printable),
        printableEjson: serializePrintable(result.printable),
        hasMore: hasMoreResults(result.printable),
        elapsedMs: performance.now() - started,
      });
    } catch (error) {
      throw toFailure(error);
    }
  }

  private async run(options: {
    id: string;
    code: string;
    batchSize: number;
    timeoutMs: number;
    emit: Emit;
    connection: OpenConnection;
  }): Promise<RuntimeResult> {
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

  // Stops listening to the run, rejects its promise, and kills the server operations it started.
  // The mongosh evaluation itself cannot be interrupted, so its runtime is replaced later if it
  // is still running (see ensureConnection).
  private async abortRun(run: ActiveRun, error: AppError): Promise<void> {
    if (this.active !== run) {
      return;
    }
    this.active = null;
    run.abort(new AppErrorException(error));
    await killServerOperations(run.connection.provider, run.token);
  }

  private async ensureConnection(): Promise<OpenConnection> {
    const request = this.connectRequest;
    if (request === null) {
      throw new AppErrorException(appError('NOT_CONNECTED', 'Connect to a server first'));
    }
    const current = this.connection;
    if (current === null) {
      return this.open(request.uri, request.driverOptions, request.database);
    }
    const pending = current.pendingWork;
    if (pending === null || (await settlesWithin(pending, SETTLE_GRACE_MS))) {
      current.pendingWork = null;
      return current;
    }
    // An abandoned evaluation still runs in this runtime. Replace the runtime so its cursor and
    // shell state do not leak into the next request. The database is kept when it can be read.
    const database = await this.currentDatabase(current);
    await this.closeConnection();
    return this.open(request.uri, request.driverOptions, database ?? request.database);
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
    if (database !== undefined) {
      await connection.runtime.evaluate(`use(${JSON.stringify(database)})`);
    }
    return connection;
  }

  private async closeConnection(): Promise<void> {
    const connection = this.connection;
    this.connection = null;
    if (connection === null) {
      return;
    }
    try {
      await connection.provider.close();
    } catch {
      // The client may already be closed. Nothing else needs releasing.
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

  private async collectionNames(connection: OpenConnection): Promise<Set<string>> {
    const database = await this.currentDatabase(connection);
    if (database === undefined) {
      return new Set();
    }
    const rows: unknown = await connection.provider.listCollections(database);
    const names = Array.isArray(rows) ? rows.map((row: unknown) => readString(row, 'name')) : [];
    return new Set(names.filter((name): name is string => name !== undefined));
  }
}

function toFailure(error: unknown): AppErrorException {
  return error instanceof AppErrorException
    ? error
    : new AppErrorException(toEvaluationError(error));
}

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
