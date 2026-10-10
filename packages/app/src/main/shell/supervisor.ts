import { randomUUID } from 'node:crypto';
import { buildClientOptions } from '@mongo-gui/mongo-adapter';
import {
  AppErrorException,
  PROCESS_MESSAGE_ID,
  ShellResponseSchema,
  appError,
  toAppError,
  type AppError,
  type CompletionItem,
  type ConnectionProfile,
  type ResultResponse,
  type RpcEvent,
  type SchemaField,
  type SchemaSampleStrategy,
  type ShellEvaluation,
  type ShellRequest,
  type ShellResponse,
  type ShellResult,
  type ShellRuntimeState,
} from '@mongo-gui/core';
import { log as defaultLog, type Logger } from '../log';
import { minimalEnv, type ForkFunction, type RuntimeChild } from './child';

export const SHELL_SERVICE_NAME = 'mongo-gui-shell';
export const SHELL_EXEC_ARGV: readonly string[] = ['--max-old-space-size=512'];

export interface SupervisorTimings {
  // How long a fresh process may take to report ready.
  readonly readyTimeoutMs: number;
  // How long the driver may take to connect and read the server information.
  readonly connectTimeoutMs: number;
  // Deadline for work that has no caller timeout, such as a result page or a schema sample.
  readonly defaultRequestTimeoutMs: number;
  readonly completeTimeoutMs: number;
  // Extra time past an evaluation timeout before the watchdog starts. The runtime's own timer
  // usually settles the request first.
  readonly timeoutGraceMs: number;
  // Each watchdog step waits this long for a done message before it escalates.
  readonly watchdogStepMs: number;
  // How long a disconnected process may take to exit on its own before it is killed.
  readonly stopGraceMs: number;
  readonly crashWindowMs: number;
  readonly maxCrashRestarts: number;
  // Print lines that arrive within this window go out as one shell:print event.
  readonly printFlushMs: number;
  // Lines one evaluation may print. The next line says the output was truncated.
  readonly maxPrintLines: number;
}

export const DEFAULT_TIMINGS: SupervisorTimings = {
  readyTimeoutMs: 10_000,
  connectTimeoutMs: 30_000,
  defaultRequestTimeoutMs: 30_000,
  completeTimeoutMs: 10_000,
  timeoutGraceMs: 250,
  watchdogStepMs: 2_000,
  stopGraceMs: 1_000,
  crashWindowMs: 60_000,
  maxCrashRestarts: 3,
  printFlushMs: 50,
  maxPrintLines: 10_000,
};

// Responses kept for one request. A script can send more messages than a request needs, so the
// rest are dropped.
const MAX_RESPONSES_PER_REQUEST = 100;

// A use() call or the `use <db>` shell command in submitted code. Either changes the database
// without the supervisor's knowledge.
const USE_CALL = /(^|[^\w$.])use(\s*\(|\s+[\w$"'])/;

export interface RuntimeSupervisorOptions {
  // The built shell runtime bundle that each process runs.
  readonly entryPath: string;
  readonly fork: ForkFunction;
  // Reads the stored profile, which holds the URI. Throws AppErrorException when it is missing.
  readonly profileOf: (connectionId: string) => ConnectionProfile;
  // Reports whether the connection manager holds the connection open.
  readonly isConnected: (connectionId: string) => boolean;
  readonly log?: Logger;
  readonly timings?: Partial<SupervisorTimings>;
  // Source of the variables the runtime may read. Defaults to the process environment.
  readonly env?: NodeJS.ProcessEnv;
}

export type RuntimeEvent = Extract<RpcEvent, { type: 'shell:print' | 'shell:state' }>;

export interface EvaluateRequest {
  readonly connectionId: string;
  readonly requestId?: string | undefined;
  readonly database: string;
  readonly code: string;
  readonly batchSize: number;
  readonly timeoutMs?: number | undefined;
}

export interface NextRequest {
  readonly connectionId: string;
  readonly requestId: string;
  readonly batchSize: number;
}

export interface CompleteRequest {
  readonly connectionId: string;
  readonly database: string;
  readonly code: string;
  readonly position: number;
}

export interface SampleRequest {
  readonly connectionId: string;
  readonly database: string;
  readonly collection: string;
  readonly size: number;
  readonly strategy: SchemaSampleStrategy;
}

// What a request produced. It holds the messages before done, and the abort reason when the
// supervisor stopped the request.
interface Outcome {
  readonly responses: readonly ShellResponse[];
  readonly abort: AppError | undefined;
}

interface ExchangeOptions {
  readonly deadlineMs: number;
  readonly abortError: AppError;
  readonly forwardPrints: boolean;
}

// Print lines waiting for their flush.
interface PrintBuffer {
  readonly lines: string[];
  count: number;
  truncated: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
}

// One request sent to a runtime process and not yet answered with done.
interface Exchange {
  readonly id: string;
  readonly forwardPrints: boolean;
  readonly prints: PrintBuffer;
  readonly responses: ShellResponse[];
  abort: AppError | undefined;
  deadline: ReturnType<typeof setTimeout> | undefined;
  escalation: ReturnType<typeof setTimeout> | undefined;
  settle: (outcome: Outcome) => void;
  readonly done: Promise<Outcome>;
}

interface ReadyWaiter {
  resolve(): void;
  reject(error: AppErrorException): void;
}

// The state of one connection's runtime process and the requests that run on it.
interface Slot {
  readonly connectionId: string;
  state: ShellRuntimeState;
  child: RuntimeChild | null;
  ready: boolean;
  readyWaiter: ReadyWaiter | undefined;
  startup: Promise<void> | undefined;
  readonly exchanges: Map<string, Exchange>;
  // Work requests run one at a time, in arrival order, like the runtime serialises them.
  tail: Promise<void>;
  queued: number;
  readonly queuedIds: Set<string>;
  // Ids of work requests whose task runs now, including the spawn, connect and database switch.
  readonly activeIds: Set<string>;
  readonly cancelledQueued: Set<string>;
  // Id of the request whose evaluation opened the current cursor. "next" is valid only for it.
  cursorOwner: string | undefined;
  // Database the runtime's `db` points at, as far as this supervisor knows. A `use` clears the
  // runtime's cursor, so the switch is skipped when the database is already the one asked for.
  database: string | undefined;
  // Times of crash restarts inside the crash window.
  restarts: number[];
}

const CONNECT_FAILED_MESSAGE = 'The shell could not connect to the server.';

export class RuntimeSupervisor {
  private readonly slots = new Map<string, Slot>();
  private readonly listeners = new Set<(event: RuntimeEvent) => void>();
  private readonly timings: SupervisorTimings;
  private readonly log: Logger;
  private readonly env: Record<string, string>;
  private disposed = false;

  constructor(private readonly options: RuntimeSupervisorOptions) {
    this.timings = { ...DEFAULT_TIMINGS, ...options.timings };
    this.log = options.log ?? defaultLog;
    this.env = minimalEnv(options.env ?? process.env);
  }

  onEvent(listener: (event: RuntimeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  state(connectionId: string): ShellRuntimeState {
    return this.slots.get(connectionId)?.state ?? 'stopped';
  }

  async evaluate(input: EvaluateRequest): Promise<ShellEvaluation> {
    const slot = this.slotFor(input.connectionId);
    const requestId = input.requestId ?? randomUUID();
    if (input.requestId !== undefined && this.isInUse(slot, input.requestId)) {
      return failed(
        requestId,
        appError('VALIDATION', 'The request id is already in use.'),
        performance.now(),
      );
    }
    const timeoutMs = input.timeoutMs ?? this.timings.defaultRequestTimeoutMs;
    return this.enqueue(slot, requestId, async () => {
      const started = performance.now();
      if (this.isCancelled(slot, requestId)) {
        return failed(requestId, cancelledError(), started);
      }
      await this.ensureReady(slot);
      this.markBusy(slot);
      if (this.isCancelled(slot, requestId)) {
        return failed(requestId, cancelledError(), started);
      }
      const switched = await this.useDatabase(slot, input.database);
      if (switched !== undefined) {
        return failed(requestId, switched, started);
      }
      // A cancel that arrived while the process started or switched database is honoured here,
      // before the evaluation is sent.
      if (this.isCancelled(slot, requestId)) {
        return failed(requestId, cancelledError(), started);
      }
      slot.cursorOwner = undefined;
      // A script may call use() itself, which the supervisor cannot see. Forget the database, so
      // the next request switches explicitly.
      if (USE_CALL.test(input.code)) {
        slot.database = undefined;
      }
      const outcome = await this.exchange(
        slot,
        {
          id: requestId,
          kind: 'evaluate',
          code: input.code,
          batchSize: input.batchSize,
          timeoutMs,
        },
        {
          deadlineMs: timeoutMs + this.timings.timeoutGraceMs,
          abortError: timeoutError(timeoutMs),
          forwardPrints: true,
        },
      );
      const evaluation = toEvaluation(requestId, outcome, started);
      slot.cursorOwner = evaluation.result?.cursorRequestId;
      return evaluation;
    });
  }

  async next(input: NextRequest): Promise<ShellEvaluation> {
    const slot = this.slotFor(input.connectionId);
    const requestId = input.requestId;
    return this.enqueue(slot, requestId, async () => {
      const started = performance.now();
      if (this.isCancelled(slot, requestId)) {
        return failed(requestId, cancelledError(), started);
      }
      if (slot.cursorOwner !== requestId) {
        return failed(
          requestId,
          appError('VALIDATION', 'The cursor is closed. Run the query again.'),
          started,
        );
      }
      await this.ensureReady(slot);
      this.markBusy(slot);
      if (this.isCancelled(slot, requestId)) {
        return failed(requestId, cancelledError(), started);
      }
      const outcome = await this.exchange(
        slot,
        { id: requestId, kind: 'next', batchSize: input.batchSize },
        {
          deadlineMs: this.timings.defaultRequestTimeoutMs,
          abortError: timeoutError(this.timings.defaultRequestTimeoutMs),
          forwardPrints: true,
        },
      );
      const evaluation = toEvaluation(requestId, outcome, started);
      slot.cursorOwner = evaluation.result?.cursorRequestId;
      return evaluation;
    });
  }

  // Cancels the request with this id. A request that is queued or still starting never sends its
  // evaluation. A running one is aborted through the watchdog, and the call returns once it has
  // settled.
  async cancel(connectionId: string, requestId: string): Promise<void> {
    const slot = this.slots.get(connectionId);
    if (slot === undefined) {
      return;
    }
    const exchange = slot.exchanges.get(requestId);
    if (exchange !== undefined) {
      this.abortExchange(slot, exchange, cancelledError());
      await exchange.done;
      return;
    }
    if (slot.queuedIds.has(requestId) || slot.activeIds.has(requestId)) {
      slot.cancelledQueued.add(requestId);
    }
  }

  async complete(input: CompleteRequest): Promise<{ items: CompletionItem[] }> {
    const slot = this.slotFor(input.connectionId);
    return this.enqueue(slot, undefined, async () => {
      await this.ensureReady(slot);
      this.markBusy(slot);
      const switched = await this.useDatabase(slot, input.database);
      if (switched !== undefined) {
        throw new AppErrorException(switched);
      }
      const outcome = await this.exchange(
        slot,
        { id: randomUUID(), kind: 'complete', code: input.code, position: input.position },
        {
          deadlineMs: this.timings.completeTimeoutMs,
          abortError: timeoutError(this.timings.completeTimeoutMs),
          forwardPrints: false,
        },
      );
      if (outcome.abort !== undefined) {
        throw new AppErrorException(outcome.abort);
      }
      const completions = find(outcome.responses, 'completions');
      if (completions !== undefined) {
        return { items: completions.items };
      }
      throw new AppErrorException(errorOf(outcome.responses, 'The shell gave no completions.'));
    });
  }

  async sampleSchema(input: SampleRequest): Promise<{ fields: SchemaField[]; sampled: number }> {
    const slot = this.slotFor(input.connectionId);
    return this.enqueue(slot, undefined, async () => {
      await this.ensureReady(slot);
      this.markBusy(slot);
      const outcome = await this.exchange(
        slot,
        {
          id: randomUUID(),
          kind: 'sampleSchema',
          database: input.database,
          collection: input.collection,
          size: input.size,
          strategy: input.strategy,
        },
        {
          deadlineMs: this.timings.defaultRequestTimeoutMs,
          abortError: timeoutError(this.timings.defaultRequestTimeoutMs),
          forwardPrints: false,
        },
      );
      if (outcome.abort !== undefined) {
        throw new AppErrorException(outcome.abort);
      }
      const schema = find(outcome.responses, 'schema');
      if (schema !== undefined) {
        return { fields: schema.fields, sampled: schema.sampled };
      }
      throw new AppErrorException(errorOf(outcome.responses, 'The shell gave no schema.'));
    });
  }

  // Replaces the process for a connection and clears its crash history.
  async restart(connectionId: string): Promise<void> {
    const slot = this.slotFor(connectionId);
    slot.restarts = [];
    const child = this.unlink(slot, cancelledError());
    if (child !== null) {
      this.killNow(child, connectionId);
    }
    this.setState(slot, 'stopped');
    await this.ensureReady(slot);
  }

  // Ends the process for a connection. The process gets a disconnect message first, and it is
  // killed if it does not exit within the grace period.
  async stop(connectionId: string): Promise<void> {
    const slot = this.slots.get(connectionId);
    if (slot === undefined) {
      return;
    }
    const child = this.unlink(
      slot,
      appError('CANCELLED', 'The connection closed before the operation finished'),
    );
    this.setState(slot, 'stopped');
    if (child !== null) {
      this.disconnectGracefully(child, connectionId);
    }
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.slots.keys()].map((id) => this.stop(id)));
  }

  // Kills every process at once and settles their requests. Used when the app quits.
  dispose(): void {
    this.disposed = true;
    for (const slot of this.slots.values()) {
      const child = this.unlink(slot, appError('INTERNAL', 'The shell was shut down.'));
      if (child !== null) {
        this.killNow(child, slot.connectionId);
      }
      this.setState(slot, 'stopped');
    }
    this.slots.clear();
  }

  // True when the id names a request that is queued, running, or owns the open cursor.
  private isInUse(slot: Slot, requestId: string): boolean {
    return (
      slot.queuedIds.has(requestId) ||
      slot.activeIds.has(requestId) ||
      slot.exchanges.has(requestId) ||
      slot.cursorOwner === requestId
    );
  }

  private isCancelled(slot: Slot, requestId: string): boolean {
    return slot.cancelledQueued.has(requestId);
  }

  private slotFor(connectionId: string): Slot {
    if (this.disposed) {
      throw new AppErrorException(appError('INTERNAL', 'The shell is shut down.'));
    }
    const existing = this.slots.get(connectionId);
    if (existing !== undefined) {
      return existing;
    }
    const slot: Slot = {
      connectionId,
      state: 'stopped',
      child: null,
      ready: false,
      readyWaiter: undefined,
      startup: undefined,
      exchanges: new Map(),
      tail: Promise.resolve(),
      queued: 0,
      queuedIds: new Set(),
      activeIds: new Set(),
      cancelledQueued: new Set(),
      cursorOwner: undefined,
      database: undefined,
      restarts: [],
    };
    this.slots.set(connectionId, slot);
    return slot;
  }

  // Runs one work request after the requests queued before it. The id, when given, lets cancel
  // find the request while it waits.
  private enqueue<T>(slot: Slot, id: string | undefined, task: () => Promise<T>): Promise<T> {
    slot.queued += 1;
    if (id !== undefined) {
      slot.queuedIds.add(id);
    }
    const run = slot.tail.then(async () => {
      if (id !== undefined) {
        slot.queuedIds.delete(id);
        slot.activeIds.add(id);
      }
      try {
        return await task();
      } finally {
        if (id !== undefined) {
          slot.activeIds.delete(id);
          slot.cancelledQueued.delete(id);
        }
        slot.queued -= 1;
        if (slot.queued === 0 && slot.state === 'busy') {
          this.setState(slot, slot.ready ? 'ready' : 'stopped');
        }
      }
    });
    slot.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private markBusy(slot: Slot): void {
    if (slot.state === 'ready') {
      this.setState(slot, 'busy');
    }
  }

  // Starts the process when none is running. Concurrent callers share one startup.
  private ensureReady(slot: Slot): Promise<void> {
    if (slot.ready && slot.child !== null) {
      return Promise.resolve();
    }
    if (slot.startup !== undefined) {
      return slot.startup;
    }
    if (slot.state === 'crashed') {
      return Promise.reject(
        new AppErrorException(
          appError('NOT_CONNECTED', 'The shell process crashed. Restart it to continue.'),
        ),
      );
    }
    if (!this.options.isConnected(slot.connectionId)) {
      return Promise.reject(new AppErrorException(appError('NOT_CONNECTED', 'Connect first.')));
    }
    const startup = this.start(slot).finally(() => {
      slot.startup = undefined;
    });
    slot.startup = startup;
    return startup;
  }

  private async start(slot: Slot): Promise<void> {
    const profile = this.options.profileOf(slot.connectionId);
    const child = this.forkChild(slot);
    slot.child = child;
    slot.ready = false;
    this.setState(slot, 'starting');
    await this.waitForReady(slot, child);
    const { options } = buildClientOptions(profile);
    const outcome = await this.exchange(
      slot,
      { id: randomUUID(), kind: 'connect', uri: profile.uri, driverOptions: { ...options } },
      {
        deadlineMs: this.timings.connectTimeoutMs,
        abortError: appError('CONNECTION_TIMEOUT', 'The connection attempt timed out.'),
        forwardPrints: false,
      },
    );
    if (outcome.abort !== undefined || find(outcome.responses, 'connected') === undefined) {
      const error = outcome.abort ?? errorOf(outcome.responses, CONNECT_FAILED_MESSAGE);
      const failedChild = this.unlink(slot, error);
      if (failedChild !== null) {
        this.killNow(failedChild, slot.connectionId);
      }
      this.setState(slot, 'stopped');
      throw new AppErrorException(error);
    }
    slot.ready = true;
    this.setState(slot, 'ready');
  }

  private forkChild(slot: Slot): RuntimeChild {
    let child: RuntimeChild;
    try {
      child = this.options.fork({
        entryPath: this.options.entryPath,
        execArgv: SHELL_EXEC_ARGV,
        env: this.env,
        serviceName: SHELL_SERVICE_NAME,
      });
    } catch (error) {
      this.log.error('shell process could not be forked', {
        connectionId: slot.connectionId,
        code: toAppError(error).code,
      });
      throw new AppErrorException(appError('INTERNAL', 'The shell process could not start.'));
    }
    child.onMessage((raw) => {
      this.onRaw(slot, child, raw);
    });
    child.onExit((exitCode) => {
      this.onExit(slot, child, exitCode);
    });
    return child;
  }

  private waitForReady(slot: Slot, child: RuntimeChild): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new AppErrorException(appError('INTERNAL', 'The shell process did not start in time.')),
        );
        this.lose(slot, child, 'crash', null);
      }, this.timings.readyTimeoutMs);
      slot.readyWaiter = {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
    });
  }

  private onRaw(slot: Slot, child: RuntimeChild, raw: unknown): void {
    if (slot.child !== child) {
      return;
    }
    const parsed = ShellResponseSchema.safeParse(raw);
    if (!parsed.success) {
      this.log.warn('shell process sent a message that failed validation', {
        connectionId: slot.connectionId,
      });
      return;
    }
    const message = parsed.data;
    if (message.id === PROCESS_MESSAGE_ID) {
      this.onProcessMessage(slot, message);
      return;
    }
    const exchange = slot.exchanges.get(message.id);
    if (exchange === undefined) {
      return;
    }
    if (message.kind === 'print') {
      if (exchange.forwardPrints) {
        this.bufferPrint(slot, exchange, message.text);
      }
      return;
    }
    if (message.kind === 'done') {
      this.finish(slot, exchange, undefined);
      return;
    }
    if (exchange.responses.length < MAX_RESPONSES_PER_REQUEST) {
      exchange.responses.push(message);
    }
  }

  private onProcessMessage(slot: Slot, message: ShellResponse): void {
    if (message.kind === 'ready') {
      const waiter = slot.readyWaiter;
      slot.readyWaiter = undefined;
      waiter?.resolve();
      return;
    }
    if (message.kind === 'error') {
      this.log.warn('shell process reported an error', {
        connectionId: slot.connectionId,
        code: message.error.code,
      });
    }
  }

  private onExit(slot: Slot, child: RuntimeChild, exitCode: number | null): void {
    if (slot.child !== child) {
      return;
    }
    this.log.warn('shell process exited', { connectionId: slot.connectionId, exitCode });
    this.lose(slot, child, 'crash', exitCode);
  }

  // Handles a process that ended without being asked to. A crash is restarted while the restart
  // budget lasts. A watchdog kill restarts without using the budget.
  private lose(
    slot: Slot,
    child: RuntimeChild,
    cause: 'crash' | 'watchdog',
    exitCode: number | null,
  ): void {
    if (slot.child !== child) {
      return;
    }
    const unlinked = this.unlink(
      slot,
      appError('INTERNAL', 'The shell process stopped unexpectedly.'),
    );
    if (unlinked !== null) {
      this.killNow(unlinked, slot.connectionId);
    }
    if (cause === 'crash') {
      const now = Date.now();
      const recent = slot.restarts.filter((time) => now - time < this.timings.crashWindowMs);
      slot.restarts = recent;
      if (recent.length >= this.timings.maxCrashRestarts) {
        this.log.error('shell process restart limit reached', {
          connectionId: slot.connectionId,
          exitCode,
        });
        this.setState(slot, 'crashed');
        return;
      }
      recent.push(now);
      this.log.warn('restarting shell process after a crash', {
        connectionId: slot.connectionId,
        exitCode,
        attempt: recent.length,
      });
    } else {
      this.log.warn('restarting shell process after the watchdog killed it', {
        connectionId: slot.connectionId,
      });
    }
    this.setState(slot, 'stopped');
    // A request that is starting the process reports the failure to its caller instead.
    if (slot.startup === undefined) {
      this.ensureReady(slot).catch((error: unknown) => {
        this.log.warn('shell process restart failed', {
          connectionId: slot.connectionId,
          code: toAppError(error).code,
        });
      });
    }
  }

  // Sends one request and resolves with what the process answers before done. The deadline starts
  // the watchdog. It cancels first, then sends SIGINT, then kills the process. The outcome always
  // settles.
  private exchange(slot: Slot, request: ShellRequest, options: ExchangeOptions): Promise<Outcome> {
    const child = slot.child;
    if (child === null) {
      return Promise.resolve({
        responses: [],
        abort: appError('INTERNAL', 'The shell process is not running.'),
      });
    }
    let settle: (outcome: Outcome) => void = () => undefined;
    const done = new Promise<Outcome>((resolve) => {
      settle = resolve;
    });
    const exchange: Exchange = {
      id: request.id,
      forwardPrints: options.forwardPrints,
      responses: [],
      abort: undefined,
      deadline: undefined,
      escalation: undefined,
      prints: { lines: [], count: 0, truncated: false, timer: undefined },
      settle,
      done,
    };
    slot.exchanges.set(request.id, exchange);
    exchange.deadline = setTimeout(() => {
      this.abortExchange(slot, exchange, options.abortError);
    }, options.deadlineMs);
    try {
      child.send(request);
    } catch {
      this.lose(slot, child, 'crash', null);
    }
    return done;
  }

  // Marks the request aborted and asks the process to cancel it. If no done arrives within a step,
  // SIGINT interrupts a synchronous loop. If that also fails, the process is killed.
  private abortExchange(slot: Slot, exchange: Exchange, error: AppError): void {
    if (exchange.abort !== undefined || slot.exchanges.get(exchange.id) !== exchange) {
      return;
    }
    exchange.abort = error;
    clearTimeout(exchange.deadline);
    const child = slot.child;
    if (child === null) {
      this.finish(slot, exchange, undefined);
      return;
    }
    try {
      child.send({ id: randomUUID(), kind: 'cancel', targetId: exchange.id });
    } catch {
      this.lose(slot, child, 'watchdog', null);
      return;
    }
    exchange.escalation = setTimeout(() => {
      this.interrupt(slot, exchange, child);
    }, this.timings.watchdogStepMs);
  }

  private interrupt(slot: Slot, exchange: Exchange, child: RuntimeChild): void {
    if (slot.exchanges.get(exchange.id) !== exchange || slot.child !== child) {
      return;
    }
    this.log.warn('shell request did not stop after cancel, sending SIGINT', {
      connectionId: slot.connectionId,
    });
    child.interrupt();
    exchange.escalation = setTimeout(() => {
      if (slot.exchanges.get(exchange.id) !== exchange || slot.child !== child) {
        return;
      }
      this.log.warn('shell request did not stop after SIGINT, killing the process', {
        connectionId: slot.connectionId,
      });
      this.lose(slot, child, 'watchdog', null);
    }, this.timings.watchdogStepMs);
  }

  // Adds one print line to the buffer. Lines past the cap are dropped, and one line says so.
  private bufferPrint(slot: Slot, exchange: Exchange, text: string): void {
    const buffer = exchange.prints;
    if (buffer.truncated) {
      return;
    }
    if (buffer.count >= this.timings.maxPrintLines) {
      buffer.truncated = true;
      buffer.lines.push('output truncated');
    } else {
      buffer.count += 1;
      buffer.lines.push(text);
    }
    buffer.timer ??= setTimeout(() => {
      this.flushPrints(slot, exchange);
    }, this.timings.printFlushMs);
  }

  // Sends the buffered lines as one event. Lines of one window keep their order.
  private flushPrints(slot: Slot, exchange: Exchange): void {
    const buffer = exchange.prints;
    clearTimeout(buffer.timer);
    buffer.timer = undefined;
    if (buffer.lines.length === 0) {
      return;
    }
    const text = buffer.lines.join('\n');
    buffer.lines.length = 0;
    this.emit({
      type: 'shell:print',
      connectionId: slot.connectionId,
      requestId: exchange.id,
      text,
    });
  }

  private finish(slot: Slot, exchange: Exchange, fallback: AppError | undefined): void {
    clearTimeout(exchange.deadline);
    clearTimeout(exchange.escalation);
    this.flushPrints(slot, exchange);
    slot.exchanges.delete(exchange.id);
    exchange.settle({ responses: exchange.responses, abort: exchange.abort ?? fallback });
  }

  // Detaches the current process from the slot without killing it. Pending requests and a
  // waiting startup settle with the error. The caller decides how the process ends.
  private unlink(slot: Slot, error: AppError): RuntimeChild | null {
    const child = slot.child;
    slot.child = null;
    slot.ready = false;
    slot.cursorOwner = undefined;
    slot.database = undefined;
    const waiter = slot.readyWaiter;
    slot.readyWaiter = undefined;
    waiter?.reject(new AppErrorException(error));
    for (const exchange of [...slot.exchanges.values()]) {
      this.finish(slot, exchange, error);
    }
    return child;
  }

  private killNow(child: RuntimeChild, connectionId: string): void {
    try {
      child.kill();
    } catch (error) {
      this.log.warn('shell process could not be killed', {
        connectionId,
        code: toAppError(error).code,
      });
    }
  }

  private disconnectGracefully(child: RuntimeChild, connectionId: string): void {
    try {
      child.send({ id: randomUUID(), kind: 'disconnect' });
    } catch {
      this.killNow(child, connectionId);
      return;
    }
    setTimeout(() => {
      this.killNow(child, connectionId);
    }, this.timings.stopGraceMs);
  }

  // Switches the runtime to the requested database before a request that depends on it. A switch
  // that is not needed is skipped, because the switch clears the runtime's open cursor.
  private async useDatabase(slot: Slot, database: string): Promise<AppError | undefined> {
    if (slot.database === database) {
      return undefined;
    }
    const outcome = await this.exchange(
      slot,
      {
        id: randomUUID(),
        kind: 'evaluate',
        code: `use(${JSON.stringify(database)})`,
        batchSize: 1,
      },
      {
        deadlineMs: this.timings.defaultRequestTimeoutMs,
        abortError: timeoutError(this.timings.defaultRequestTimeoutMs),
        forwardPrints: false,
      },
    );
    if (outcome.abort !== undefined) {
      return outcome.abort;
    }
    const failure = find(outcome.responses, 'error');
    if (outcome.abort !== undefined || failure !== undefined) {
      slot.database = undefined;
      return outcome.abort ?? failure?.error;
    }
    slot.database = database;
    return undefined;
  }

  private setState(slot: Slot, state: ShellRuntimeState): void {
    if (slot.state === state) {
      return;
    }
    slot.state = state;
    const detail = state === 'busy' || state === 'ready';
    if (detail) {
      this.log.debug?.('shell state changed', { connectionId: slot.connectionId, state });
    } else {
      this.log.info('shell state changed', { connectionId: slot.connectionId, state });
    }
    this.emit({ type: 'shell:state', connectionId: slot.connectionId, state });
  }

  private emit(event: RuntimeEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

function cancelledError(): AppError {
  return appError('CANCELLED', 'The operation was cancelled');
}

function timeoutError(timeoutMs: number): AppError {
  return appError('CANCELLED', `The operation timed out after ${timeoutMs} ms`);
}

function failed(requestId: string, error: AppError, started: number): ShellEvaluation {
  return { requestId, error, elapsedMs: performance.now() - started };
}

function find<K extends ShellResponse['kind']>(
  responses: readonly ShellResponse[],
  kind: K,
): Extract<ShellResponse, { kind: K }> | undefined {
  return responses.find(
    (message): message is Extract<ShellResponse, { kind: K }> => message.kind === kind,
  );
}

function errorOf(responses: readonly ShellResponse[], fallback: string): AppError {
  return find(responses, 'error')?.error ?? appError('INTERNAL', fallback);
}

function toEvaluation(requestId: string, outcome: Outcome, started: number): ShellEvaluation {
  if (outcome.abort !== undefined) {
    return failed(requestId, outcome.abort, started);
  }
  const result = find(outcome.responses, 'result');
  if (result !== undefined) {
    return { requestId, result: toShellResult(result), elapsedMs: result.elapsedMs };
  }
  return failed(requestId, errorOf(outcome.responses, 'The shell gave no result.'), started);
}

function toShellResult(message: ResultResponse): ShellResult {
  return {
    type: message.type,
    printableEjson: message.printableEjson,
    hasMore: message.hasMore,
    ...(message.cursorRequestId === undefined ? {} : { cursorRequestId: message.cursorRequestId }),
  };
}
