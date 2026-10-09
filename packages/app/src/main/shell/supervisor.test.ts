import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AppErrorException,
  type ConnectionProfile,
  type RpcEvent,
  type ShellRequest,
} from '@mongo-gui/core';
import type { Logger } from '../log';
import { minimalEnv, type ForkRequest, type RuntimeChild } from './child';
import {
  RuntimeSupervisor,
  SHELL_EXEC_ARGV,
  SHELL_SERVICE_NAME,
  type RuntimeEvent,
  type SupervisorTimings,
} from './supervisor';

const CONNECTION_ID = '3f2b8c1e-5d4a-4b7e-9c1f-2a6d8e0b7f10';
const URI = 'mongodb://app:hunter2@127.0.0.1:27017/?directConnection=true';
const PROFILE: ConnectionProfile = {
  id: CONNECTION_ID,
  name: 'local',
  uri: URI,
  createdAt: '2026-10-01T10:00:00.000Z',
  updatedAt: '2026-10-01T10:00:00.000Z',
};
const SECRET_RESULT = 'SECRET-RESULT-VALUE';

const TIMINGS: SupervisorTimings = {
  readyTimeoutMs: 80,
  connectTimeoutMs: 200,
  defaultRequestTimeoutMs: 200,
  completeTimeoutMs: 200,
  timeoutGraceMs: 0,
  watchdogStepMs: 40,
  stopGraceMs: 20,
  crashWindowMs: 60_000,
  maxCrashRestarts: 3,
  printFlushMs: 20,
  maxPrintLines: 10_000,
};

// Decides how a fake process answers one request. The default answers the protocol normally.
type Responder = (child: FakeChild, request: ShellRequest) => void;

interface FakeOptions {
  readonly ready?: boolean;
  readonly respond?: Responder;
  readonly onInterrupt?: (child: FakeChild) => void;
}

// An EventEmitter standing in for a runtime process. It records what the supervisor did to it.
class FakeChild extends EventEmitter implements RuntimeChild {
  readonly sent: ShellRequest[] = [];
  readonly order: string[] = [];
  exited = false;
  private readonly respond: Responder;
  private readonly onInterruptHook: ((child: FakeChild) => void) | undefined;

  constructor(options: FakeOptions) {
    super();
    this.respond = options.respond ?? answerProtocol;
    this.onInterruptHook = options.onInterrupt;
    if (options.ready !== false) {
      setImmediate(() => {
        this.reply({ id: 'process', kind: 'ready' });
      });
    }
  }

  send(message: ShellRequest): void {
    this.sent.push(message);
    if (message.kind === 'cancel') {
      this.order.push('cancel');
    }
    this.respond(this, message);
  }

  onMessage(listener: (raw: unknown) => void): void {
    this.on('message', listener);
  }

  onExit(listener: (exitCode: number | null) => void): void {
    this.on('exit', listener);
  }

  kill(): void {
    this.order.push('kill');
    if (this.exited) {
      return;
    }
    this.exited = true;
    setImmediate(() => {
      this.emit('exit', null);
    });
  }

  interrupt(): void {
    this.order.push('interrupt');
    this.onInterruptHook?.(this);
  }

  reply(message: unknown): void {
    this.emit('message', message);
  }

  // Ends the process the way a crash does, with an exit code.
  crash(exitCode: number): void {
    this.exited = true;
    this.emit('exit', exitCode);
  }
}

// Answers each request the way the real runtime does. It sends a response, then done.
function answerProtocol(child: FakeChild, request: ShellRequest): void {
  setImmediate(() => {
    switch (request.kind) {
      case 'connect':
        child.reply({
          id: request.id,
          kind: 'connected',
          serverVersion: '8.0.17',
          topology: 'standalone',
        });
        break;
      case 'evaluate':
        child.reply({
          id: request.id,
          kind: 'result',
          type: 'string',
          printableEjson: SECRET_RESULT,
          hasMore: false,
          elapsedMs: 1,
        });
        break;
      case 'next':
        child.reply({
          id: request.id,
          kind: 'result',
          type: 'Cursor',
          printableEjson: '[]',
          hasMore: false,
          cursorRequestId: request.id,
          elapsedMs: 1,
        });
        break;
      case 'complete':
        child.reply({
          id: request.id,
          kind: 'completions',
          items: [{ text: 'find', kind: 'method' }],
        });
        break;
      case 'sampleSchema':
        child.reply({ id: request.id, kind: 'schema', fields: [], sampled: 0 });
        break;
      case 'cancel':
        child.reply({
          id: request.targetId,
          kind: 'error',
          error: { code: 'CANCELLED', message: 'The operation was cancelled' },
        });
        child.reply({ id: request.targetId, kind: 'done' });
        break;
      default:
        break;
    }
    child.reply({ id: request.id, kind: 'done' });
  });
}

interface LogLine {
  readonly level: 'info' | 'warn' | 'error';
  readonly message: string;
  readonly fields: Record<string, unknown> | undefined;
}

function recordingLog(): { logger: Logger; lines: LogLine[] } {
  const lines: LogLine[] = [];
  const write =
    (level: LogLine['level']) =>
    (message: string, fields?: Record<string, unknown>): void => {
      lines.push({ level, message, fields });
    };
  return {
    lines,
    logger: { info: write('info'), warn: write('warn'), error: write('error') },
  };
}

interface Harness {
  readonly supervisor: RuntimeSupervisor;
  readonly children: FakeChild[];
  readonly forks: ForkRequest[];
  readonly events: RpcEvent[];
  readonly logs: LogLine[];
  setConnected(value: boolean): void;
}

function harness(options: {
  readonly next?: (index: number) => FakeOptions;
  readonly env?: NodeJS.ProcessEnv;
  readonly timings?: Partial<SupervisorTimings>;
}): Harness {
  const children: FakeChild[] = [];
  const forks: ForkRequest[] = [];
  const logs = recordingLog();
  const events: RpcEvent[] = [];
  let connected = true;
  const supervisor = new RuntimeSupervisor({
    entryPath: '/bundle/shell-runtime.cjs',
    fork: (request) => {
      forks.push(request);
      const child = new FakeChild(options.next?.(children.length) ?? {});
      children.push(child);
      return child;
    },
    profileOf: () => PROFILE,
    isConnected: () => connected,
    log: logs.logger,
    timings: { ...TIMINGS, ...options.timings },
    env: options.env ?? { PATH: '/usr/bin', HOME: '/home/u', USE_NEW_AUTOCOMPLETE: '1' },
  });
  supervisor.onEvent((event: RuntimeEvent) => {
    events.push(event);
  });
  return {
    supervisor,
    children,
    forks,
    events,
    logs: logs.lines,
    setConnected(value) {
      connected = value;
    },
  };
}

async function until(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error('condition was not met in time');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function evaluateInput(overrides: { requestId?: string; timeoutMs?: number } = {}) {
  return {
    connectionId: CONNECTION_ID,
    database: 'shop',
    code: 'db.orders.find()',
    batchSize: 50,
    ...overrides,
  };
}

describe('RuntimeSupervisor', () => {
  const open: RuntimeSupervisor[] = [];

  afterEach(() => {
    for (const supervisor of open.splice(0)) {
      supervisor.dispose();
    }
  });

  function track(h: Harness): Harness {
    open.push(h.supervisor);
    return h;
  }

  it('starts no process until the first request, then reports ready', async () => {
    const h = track(harness({}));
    expect(h.supervisor.state(CONNECTION_ID)).toBe('stopped');
    expect(h.forks).toHaveLength(0);

    const evaluation = await h.supervisor.evaluate(evaluateInput());
    expect(evaluation.result?.printableEjson).toBe(SECRET_RESULT);
    expect(h.forks).toHaveLength(1);
    expect(h.supervisor.state(CONNECTION_ID)).toBe('ready');
  });

  it('forks with the heap cap, the service name and only the minimal environment', async () => {
    const h = track(
      harness({
        env: {
          PATH: '/usr/bin',
          HOME: '/home/u',
          TMPDIR: '/tmp',
          LANG: 'en_US.UTF-8',
          LC_ALL: 'C',
          MONGO_URI: 'mongodb://secret',
          ELECTRON_SECRET: 'nope',
        },
      }),
    );
    await h.supervisor.evaluate(evaluateInput());
    const fork = h.forks[0];
    expect(fork?.execArgv).toEqual(SHELL_EXEC_ARGV);
    expect(fork?.execArgv).toEqual(['--max-old-space-size=512']);
    expect(fork?.serviceName).toBe(SHELL_SERVICE_NAME);
    expect(fork?.entryPath).toBe('/bundle/shell-runtime.cjs');
    expect(fork?.env).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/u',
      TMPDIR: '/tmp',
      LANG: 'en_US.UTF-8',
      LC_ALL: 'C',
      USE_NEW_AUTOCOMPLETE: '0',
    });
  });

  it('sends the profile URI and driver options in connect, never to the renderer', async () => {
    const h = track(harness({}));
    await h.supervisor.evaluate(evaluateInput());
    const connect = h.children[0]?.sent.find((request) => request.kind === 'connect');
    expect(connect).toMatchObject({ kind: 'connect', uri: URI });
    expect(connect && 'driverOptions' in connect ? connect.driverOptions : undefined).toEqual(
      expect.objectContaining({ appName: 'mongo-gui' }),
    );
  });

  it('fails the start and kills the process when ready does not arrive in time', async () => {
    const h = track(harness({ next: () => ({ ready: false }) }));
    await expect(h.supervisor.evaluate(evaluateInput())).rejects.toBeInstanceOf(AppErrorException);
    expect(h.children[0]?.exited).toBe(true);
    expect(h.supervisor.state(CONNECTION_ID)).toBe('stopped');
    expect(h.logs.some((line) => line.level === 'warn')).toBe(true);
  });

  it('reports a connect failure with its code and leaves no process behind', async () => {
    const h = track(
      harness({
        next: () => ({
          respond: (child, request) => {
            if (request.kind === 'connect') {
              setImmediate(() => {
                child.reply({
                  id: request.id,
                  kind: 'error',
                  error: { code: 'AUTH_FAILED', message: 'Authentication failed' },
                });
                child.reply({ id: request.id, kind: 'done' });
              });
              return;
            }
            answerProtocol(child, request);
          },
        }),
      }),
    );
    await expect(h.supervisor.evaluate(evaluateInput())).rejects.toMatchObject({
      error: { code: 'AUTH_FAILED' },
    });
    expect(h.children[0]?.exited).toBe(true);
    expect(h.supervisor.state(CONNECTION_ID)).toBe('stopped');
  });

  it('counts crashes and stops restarting after three restarts in a minute', async () => {
    const h = track(harness({}));
    await h.supervisor.evaluate(evaluateInput());
    for (let crash = 1; crash <= 3; crash += 1) {
      h.children[crash - 1]?.crash(1);
      await until(() => h.forks.length === crash + 1);
      await until(() => h.supervisor.state(CONNECTION_ID) === 'ready');
    }
    expect(h.forks).toHaveLength(4);

    h.children[3]?.crash(1);
    await until(() => h.supervisor.state(CONNECTION_ID) === 'crashed');
    expect(h.forks).toHaveLength(4);
    await expect(h.supervisor.evaluate(evaluateInput())).rejects.toMatchObject({
      error: { code: 'NOT_CONNECTED' },
    });
    expect(h.logs.some((line) => line.level === 'error')).toBe(true);
  });

  it('restart clears a crashed state and starts a process again', async () => {
    const h = track(harness({ timings: { maxCrashRestarts: 0 } }));
    await h.supervisor.evaluate(evaluateInput());
    h.children[0]?.crash(1);
    await until(() => h.supervisor.state(CONNECTION_ID) === 'crashed');

    await h.supervisor.restart(CONNECTION_ID);
    expect(h.supervisor.state(CONNECTION_ID)).toBe('ready');
    const evaluation = await h.supervisor.evaluate(evaluateInput());
    expect(evaluation.result).toBeDefined();
  });

  it('drops a response that fails validation without changing the request', async () => {
    const h = track(
      harness({
        next: () => ({
          respond: (child, request) => {
            if (request.kind === 'evaluate' && request.code === 'db.orders.find()') {
              setImmediate(() => {
                child.reply({ id: request.id, kind: 'bogus', detail: 'x' });
                child.reply({ kind: 'result' });
                child.reply({
                  id: request.id,
                  kind: 'result',
                  type: 'number',
                  printableEjson: '2',
                  hasMore: false,
                  elapsedMs: 1,
                });
                child.reply({ id: request.id, kind: 'done' });
              });
              return;
            }
            answerProtocol(child, request);
          },
        }),
      }),
    );
    const evaluation = await h.supervisor.evaluate(evaluateInput());
    expect(evaluation.result?.printableEjson).toBe('2');
    expect(h.logs.some((line) => line.message.includes('failed validation'))).toBe(true);
  });

  it('ignores a response that carries an id of no pending request', async () => {
    const h = track(
      harness({
        next: () => ({
          respond: (child, request) => {
            if (request.kind === 'evaluate') {
              setImmediate(() => {
                child.reply({
                  id: randomUUID(),
                  kind: 'result',
                  type: 'number',
                  printableEjson: 'forged',
                  hasMore: false,
                  elapsedMs: 1,
                });
                child.reply({ id: randomUUID(), kind: 'done' });
                child.reply({
                  id: request.id,
                  kind: 'result',
                  type: 'number',
                  printableEjson: '7',
                  hasMore: false,
                  elapsedMs: 1,
                });
                child.reply({ id: request.id, kind: 'done' });
              });
              return;
            }
            answerProtocol(child, request);
          },
        }),
      }),
    );
    const evaluation = await h.supervisor.evaluate(evaluateInput());
    expect(evaluation.result?.printableEjson).toBe('7');
  });

  it('forwards print output only for the request that owns it', async () => {
    const h = track(
      harness({
        next: () => ({
          respond: (child, request) => {
            if (request.kind === 'evaluate') {
              setImmediate(() => {
                child.reply({ id: request.id, kind: 'print', text: 'hello' });
                child.reply({ id: randomUUID(), kind: 'print', text: 'forged' });
                child.reply({
                  id: request.id,
                  kind: 'result',
                  type: 'undefined',
                  printableEjson: 'null',
                  hasMore: false,
                  elapsedMs: 1,
                });
                child.reply({ id: request.id, kind: 'done' });
              });
              return;
            }
            answerProtocol(child, request);
          },
        }),
      }),
    );
    const requestId = randomUUID();
    await h.supervisor.evaluate(evaluateInput({ requestId }));
    const prints = h.events.filter((event) => event.type === 'shell:print');
    expect(prints).toEqual([
      { type: 'shell:print', connectionId: CONNECTION_ID, requestId, text: 'hello' },
    ]);
  });

  it('cancels a running request and resolves it with CANCELLED', async () => {
    const h = track(
      harness({
        next: () => ({
          respond: (child, request) => {
            if (request.kind === 'evaluate' && request.code === 'sleep(5000)') {
              return;
            }
            answerProtocol(child, request);
          },
        }),
      }),
    );
    const requestId = randomUUID();
    const running = h.supervisor.evaluate({ ...evaluateInput({ requestId }), code: 'sleep(5000)' });
    await until(() => h.children[0]?.sent.some((request) => request.id === requestId) === true);
    await h.supervisor.cancel(CONNECTION_ID, requestId);
    const evaluation = await running;
    expect(evaluation.error?.code).toBe('CANCELLED');
    expect(h.children[0]?.exited).toBe(false);
    expect(h.supervisor.state(CONNECTION_ID)).toBe('ready');
  });

  it('escalates a request that ignores cancel: cancel, then SIGINT, then kill and respawn', async () => {
    const h = track(
      harness({
        next: (index) =>
          index === 0
            ? {
                respond: (child, request) => {
                  if (request.kind === 'cancel') {
                    return;
                  }
                  if (request.kind === 'evaluate' && request.code === 'while(true){}') {
                    return;
                  }
                  answerProtocol(child, request);
                },
              }
            : {},
        timings: { timeoutGraceMs: 0 },
      }),
    );
    const evaluation = await h.supervisor.evaluate({
      ...evaluateInput({ timeoutMs: 50 }),
      code: 'while(true){}',
    });
    const first = h.children[0];
    expect(first?.order).toEqual(['cancel', 'interrupt', 'kill']);
    expect(evaluation.error).toMatchObject({
      code: 'CANCELLED',
      message: 'The operation timed out after 50 ms',
    });
    await until(() => h.forks.length === 2);
    await until(() => h.supervisor.state(CONNECTION_ID) === 'ready');
  });

  it('stops at SIGINT when the interrupted script answers, without killing it', async () => {
    const h = track(
      harness({
        next: () => ({
          respond: (child, request) => {
            if (request.kind === 'evaluate' && request.code === 'while(true){}') {
              return;
            }
            if (request.kind === 'cancel') {
              return;
            }
            answerProtocol(child, request);
          },
          onInterrupt: (child) => {
            const pending = child.sent.find(
              (request) => request.kind === 'evaluate' && request.code === 'while(true){}',
            );
            if (pending !== undefined) {
              setImmediate(() => {
                child.reply({
                  id: pending.id,
                  kind: 'error',
                  error: { code: 'CANCELLED', message: 'The operation was cancelled' },
                });
                child.reply({ id: pending.id, kind: 'done' });
              });
            }
          },
        }),
        timings: { timeoutGraceMs: 0 },
      }),
    );
    const evaluation = await h.supervisor.evaluate({
      ...evaluateInput({ timeoutMs: 50 }),
      code: 'while(true){}',
    });
    expect(h.children[0]?.order).toEqual(['cancel', 'interrupt']);
    expect(evaluation.error?.code).toBe('CANCELLED');
    expect(h.forks).toHaveLength(1);
  });

  it('rejects next when no cursor is open for the request id', async () => {
    const h = track(harness({}));
    const evaluation = await h.supervisor.next({
      connectionId: CONNECTION_ID,
      requestId: randomUUID(),
      batchSize: 25,
    });
    expect(evaluation.error?.code).toBe('VALIDATION');
  });

  it('continues the cursor of the evaluate that opened it', async () => {
    const h = track(
      harness({
        next: () => ({
          respond: (child, request) => {
            if (request.kind === 'evaluate') {
              setImmediate(() => {
                child.reply({
                  id: request.id,
                  kind: 'result',
                  type: 'Cursor',
                  printableEjson: '[]',
                  hasMore: true,
                  cursorRequestId: request.id,
                  elapsedMs: 1,
                });
                child.reply({ id: request.id, kind: 'done' });
              });
              return;
            }
            answerProtocol(child, request);
          },
        }),
      }),
    );
    const requestId = randomUUID();
    const started = await h.supervisor.evaluate({ ...evaluateInput({ requestId }) });
    expect(started.result?.hasMore).toBe(true);
    const continued = await h.supervisor.next({
      connectionId: CONNECTION_ID,
      requestId,
      batchSize: 25,
    });
    expect(continued.result?.cursorRequestId).toBe(requestId);
  });

  it('returns a script error in the error field instead of throwing', async () => {
    const h = track(
      harness({
        next: () => ({
          respond: (child, request) => {
            if (request.kind === 'evaluate') {
              setImmediate(() => {
                child.reply({
                  id: request.id,
                  kind: 'error',
                  error: { code: 'VALIDATION', message: 'Unexpected token' },
                });
                child.reply({ id: request.id, kind: 'done' });
              });
              return;
            }
            answerProtocol(child, request);
          },
        }),
      }),
    );
    const evaluation = await h.supervisor.evaluate(evaluateInput());
    expect(evaluation.error).toMatchObject({ code: 'VALIDATION', message: 'Unexpected token' });
    expect(evaluation.result).toBeUndefined();
  });

  it('returns completions and a schema sample', async () => {
    const h = track(harness({}));
    const completions = await h.supervisor.complete({
      connectionId: CONNECTION_ID,
      database: 'shop',
      code: 'db.',
      position: 3,
    });
    expect(completions.items).toEqual([{ text: 'find', kind: 'method' }]);
    const schema = await h.supervisor.sampleSchema({
      connectionId: CONNECTION_ID,
      database: 'shop',
      collection: 'orders',
      size: 100,
    });
    expect(schema).toEqual({ fields: [], sampled: 0 });
  });

  it('reports state transitions as events without the result payload', async () => {
    const h = track(harness({}));
    await h.supervisor.evaluate(evaluateInput());
    const states = h.events
      .filter((event) => event.type === 'shell:state')
      .map((event) => (event.type === 'shell:state' ? event.state : undefined));
    expect(states).toEqual(['starting', 'ready', 'busy', 'ready']);
    expect(JSON.stringify(h.logs)).not.toContain(SECRET_RESULT);
  });

  it('refuses to start when the connection is not open', async () => {
    const h = track(harness({}));
    h.setConnected(false);
    await expect(h.supervisor.evaluate(evaluateInput())).rejects.toMatchObject({
      error: { code: 'NOT_CONNECTED' },
    });
    expect(h.forks).toHaveLength(0);
  });

  it('sends disconnect on stop and kills the process after the grace period', async () => {
    const h = track(harness({}));
    await h.supervisor.evaluate(evaluateInput());
    await h.supervisor.stop(CONNECTION_ID);
    expect(h.children[0]?.sent.at(-1)).toMatchObject({ kind: 'disconnect' });
    expect(h.supervisor.state(CONNECTION_ID)).toBe('stopped');
    await until(() => h.children[0]?.exited === true);
  });

  it('kills every process and refuses further requests after dispose', async () => {
    const h = track(harness({}));
    await h.supervisor.evaluate(evaluateInput());
    h.supervisor.dispose();
    expect(h.children[0]?.exited).toBe(true);
    await expect(h.supervisor.evaluate(evaluateInput())).rejects.toBeInstanceOf(AppErrorException);
  });

  it('honours a cancel that arrives while the process is still connecting', async () => {
    const held: ShellRequest[] = [];
    const h = track(
      harness({
        next: () => ({
          respond: (child, request) => {
            if (request.kind === 'connect') {
              held.push(request);
              return;
            }
            answerProtocol(child, request);
          },
        }),
      }),
    );
    const requestId = randomUUID();
    const running = h.supervisor.evaluate({ ...evaluateInput({ requestId }) });
    await until(() => held.length === 1);
    await h.supervisor.cancel(CONNECTION_ID, requestId);
    const connect = held[0];
    h.children[0]?.reply({
      id: connect?.id,
      kind: 'connected',
      serverVersion: '8.0.17',
      topology: 'standalone',
    });
    h.children[0]?.reply({ id: connect?.id, kind: 'done' });
    const evaluation = await running;
    expect(evaluation.error?.code).toBe('CANCELLED');
    expect(h.children[0]?.sent.some((request) => request.id === requestId)).toBe(false);
  });

  it('rejects a caller request id that is already running', async () => {
    const h = track(
      harness({
        next: () => ({
          respond: (child, request) => {
            if (request.kind === 'evaluate' && request.code === 'sleep(5000)') {
              return;
            }
            answerProtocol(child, request);
          },
        }),
      }),
    );
    const requestId = randomUUID();
    const running = h.supervisor.evaluate({
      ...evaluateInput({ requestId }),
      code: 'sleep(5000)',
    });
    await until(() => h.children[0]?.sent.some((request) => request.id === requestId) === true);
    const second = await h.supervisor.evaluate(evaluateInput({ requestId }));
    expect(second.error?.code).toBe('VALIDATION');
    await h.supervisor.cancel(CONNECTION_ID, requestId);
    await running;
  });

  it('sends print lines of one window as one event and caps the lines of an evaluation', async () => {
    const h = track(
      harness({
        timings: { printFlushMs: 20, maxPrintLines: 3 },
        next: () => ({
          respond: (child, request) => {
            if (request.kind === 'evaluate') {
              setImmediate(() => {
                for (const text of ['a', 'b', 'c', 'd', 'e']) {
                  child.reply({ id: request.id, kind: 'print', text });
                }
                child.reply({
                  id: request.id,
                  kind: 'result',
                  type: 'undefined',
                  printableEjson: 'null',
                  hasMore: false,
                  elapsedMs: 1,
                });
                child.reply({ id: request.id, kind: 'done' });
              });
              return;
            }
            answerProtocol(child, request);
          },
        }),
      }),
    );
    const requestId = randomUUID();
    await h.supervisor.evaluate(evaluateInput({ requestId }));
    const prints = h.events.filter((event) => event.type === 'shell:print');
    expect(prints).toEqual([
      {
        type: 'shell:print',
        connectionId: CONNECTION_ID,
        requestId,
        text: 'a\nb\nc\noutput truncated',
      },
    ]);
  });

  it('keeps the minimal environment helper strict about names', () => {
    expect(minimalEnv({ PATH: '/bin', LC_CTYPE: 'UTF-8', AWS_SECRET_ACCESS_KEY: 'x' })).toEqual({
      PATH: '/bin',
      LC_CTYPE: 'UTF-8',
      USE_NEW_AUTOCOMPLETE: '0',
    });
  });
});
