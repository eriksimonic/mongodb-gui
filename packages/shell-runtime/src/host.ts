import {
  appError,
  PROCESS_MESSAGE_ID,
  ShellRequestSchema,
  toAppError,
  type CancelRequest,
  type ShellRequest,
  type ShellResponse,
} from '@mongo-gui/core';
import { redactAppError } from './errors';
import type { ShellSession } from './session';
import type { Transport } from './transport';

// Gives the transport time to deliver the last message before the process exits.
export const EXIT_FLUSH_MS = 50;

// The session methods the host calls. Tests pass a fake that implements only these.
export type HostSession = Pick<
  ShellSession,
  'connect' | 'evaluate' | 'next' | 'complete' | 'sampleSchema' | 'disconnect' | 'cancel'
>;

// The process events the fatal handlers listen to.
export interface ProcessEvents {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
}

type WorkRequest = Exclude<ShellRequest, CancelRequest>;

// Connects the transport to the session. Requests run one at a time in arrival order. A cancel is
// handled at once, so it can stop the evaluation that is running.
export function startHost(
  transport: Transport,
  session: HostSession,
  exit: (code: number) => void,
): void {
  const queued = new Set<string>();
  const cancelledWhileQueued = new Set<string>();
  let chain: Promise<void> = Promise.resolve();

  const send = (message: ShellResponse): void => {
    transport.send(message);
  };
  const finish = (id: string): void => {
    send({ id, kind: 'done' });
  };

  async function execute(request: WorkRequest): Promise<void> {
    queued.delete(request.id);
    if (cancelledWhileQueued.delete(request.id)) {
      send({
        id: request.id,
        kind: 'error',
        error: appError('CANCELLED', 'The operation was cancelled before it started'),
      });
    } else {
      try {
        await dispatch(session, request, send);
      } catch (error) {
        send({ id: request.id, kind: 'error', error: redactAppError(toAppError(error)) });
      }
    }
    finish(request.id);
    if (request.kind === 'disconnect') {
      setTimeout(() => {
        exit(0);
      }, EXIT_FLUSH_MS);
    }
  }

  async function cancel(request: CancelRequest): Promise<void> {
    if (queued.has(request.targetId)) {
      cancelledWhileQueued.add(request.targetId);
    }
    await session.cancel(request.targetId).catch(() => undefined);
    finish(request.id);
  }

  transport.onMessage((raw) => {
    const parsed = ShellRequestSchema.safeParse(raw);
    if (!parsed.success) {
      const id = requestIdOf(raw);
      const issue = parsed.error.issues[0];
      const detail = issue === undefined ? undefined : `${issue.path.join('.')}: ${issue.message}`;
      send({ id, kind: 'error', error: appError('VALIDATION', 'Invalid request', detail) });
      finish(id);
      return;
    }
    const request = parsed.data;
    if (request.kind === 'cancel') {
      void cancel(request);
      return;
    }
    queued.add(request.id);
    chain = chain.then(() => execute(request));
  });

  // The parent closed the channel. Stop the connection so a running evaluation ends, then exit.
  transport.onClose(() => {
    void session
      .disconnect()
      .catch(() => undefined)
      .then(() => {
        exit(0);
      });
  });

  send({ id: PROCESS_MESSAGE_ID, kind: 'ready' });
}

// Reports errors that escape every handler. An uncaught exception leaves the process in an unknown
// state, so it exits with code 1 after the report. An unhandled rejection is reported and the
// process keeps running. The driver's background monitors can reject without a caller to blame.
export function installFatalHandlers(
  transport: Transport,
  exit: (code: number) => void,
  events: ProcessEvents = process,
): void {
  const report = (error: unknown): void => {
    transport.send({
      id: PROCESS_MESSAGE_ID,
      kind: 'error',
      error: redactAppError(toAppError(error)),
    });
  };
  events.on('uncaughtException', (error) => {
    report(error);
    setTimeout(() => {
      exit(1);
    }, EXIT_FLUSH_MS);
  });
  events.on('unhandledRejection', (reason) => {
    report(reason);
  });
}

async function dispatch(
  session: HostSession,
  request: WorkRequest,
  send: (message: ShellResponse) => void,
): Promise<void> {
  switch (request.kind) {
    case 'connect':
      return session.connect(request, send);
    case 'evaluate':
      return session.evaluate(request, send);
    case 'next':
      return session.next(request, send);
    case 'complete':
      return session.complete(request, send);
    case 'sampleSchema':
      return session.sampleSchema(request, send);
    case 'disconnect':
      return session.disconnect();
  }
}

function requestIdOf(raw: unknown): string {
  if (typeof raw !== 'object' || raw === null || !('id' in raw)) {
    return PROCESS_MESSAGE_ID;
  }
  const id: unknown = raw.id;
  return typeof id === 'string' && id !== '' ? id : PROCESS_MESSAGE_ID;
}
