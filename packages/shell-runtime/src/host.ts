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

type WorkRequest = Exclude<ShellRequest, CancelRequest>;

// Connects the transport to the session. Requests run one at a time in arrival order. A cancel is
// handled at once, so it can stop the evaluation that is running.
export function startHost(
  transport: Transport,
  session: ShellSession,
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

// Reports errors that escape every handler. The process exits with code 1 after the report.
export function installFatalHandlers(transport: Transport, exit: (code: number) => void): void {
  const fatal = (error: unknown): void => {
    transport.send({
      id: PROCESS_MESSAGE_ID,
      kind: 'error',
      error: redactAppError(toAppError(error)),
    });
    setTimeout(() => {
      exit(1);
    }, EXIT_FLUSH_MS);
  };
  process.on('uncaughtException', fatal);
  process.on('unhandledRejection', fatal);
}

async function dispatch(
  session: ShellSession,
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
