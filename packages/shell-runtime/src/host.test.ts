import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { EvaluateRequest, ShellResponse } from '@mongo-gui/core';
import { EXIT_FLUSH_MS, installFatalHandlers, startHost, type HostSession } from './host';
import type { Transport } from './transport';

interface FakeTransport extends Transport {
  readonly sent: ShellResponse[];
  deliver(raw: unknown): void;
  closeChannel(): void;
}

function fakeTransport(): FakeTransport {
  const sent: ShellResponse[] = [];
  let messageListener: (raw: unknown) => void = () => undefined;
  let closeListener: () => void = () => undefined;
  return {
    sent,
    send(message) {
      sent.push(message);
    },
    onMessage(listener) {
      messageListener = listener;
    },
    onClose(listener) {
      closeListener = listener;
    },
    deliver(raw) {
      messageListener(raw);
    },
    closeChannel() {
      closeListener();
    },
  };
}

interface FakeSession {
  readonly log: string[];
  readonly session: HostSession;
  // Lets the evaluation with this id finish, so the next queued request can start.
  finish(id: string): void;
}

// The evaluate calls stay open until the test finishes them. Every call is logged in order.
function fakeSession(): FakeSession {
  const log: string[] = [];
  const finishers = new Map<string, () => void>();
  const session: HostSession = {
    connect: async () => undefined,
    next: async () => undefined,
    complete: async () => undefined,
    sampleSchema: async () => undefined,
    disconnect: async () => {
      log.push('disconnect');
    },
    cancel: async (targetId) => {
      log.push(`cancel:${targetId}`);
    },
    evaluate: (request: EvaluateRequest) =>
      new Promise<void>((resolve) => {
        log.push(`start:${request.id}`);
        finishers.set(request.id, () => {
          log.push(`end:${request.id}`);
          resolve();
        });
      }),
  };
  return {
    log,
    session,
    finish(id) {
      finishers.get(id)?.();
    },
  };
}

function flush(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

function evaluateRequest(id: string): unknown {
  return { id, kind: 'evaluate', code: '1', batchSize: 10 };
}

describe('startHost', () => {
  it('reports ready before any request arrives', () => {
    const transport = fakeTransport();
    startHost(transport, fakeSession().session, () => undefined);
    expect(transport.sent).toEqual([{ id: 'process', kind: 'ready' }]);
  });

  it('runs one request at a time in arrival order', async () => {
    const transport = fakeTransport();
    const fake = fakeSession();
    startHost(transport, fake.session, () => undefined);
    transport.deliver(evaluateRequest('a'));
    transport.deliver(evaluateRequest('b'));
    await flush();
    expect(fake.log).toEqual(['start:a']);
    fake.finish('a');
    await flush();
    expect(fake.log).toEqual(['start:a', 'end:a', 'start:b']);
    fake.finish('b');
    await flush();
    expect(transport.sent.filter((message) => message.kind === 'done').map((m) => m.id)).toEqual([
      'a',
      'b',
    ]);
  });

  it('handles a cancel at once, even while another request runs', async () => {
    const transport = fakeTransport();
    const fake = fakeSession();
    startHost(transport, fake.session, () => undefined);
    transport.deliver(evaluateRequest('a'));
    await flush();
    transport.deliver({ id: 'c1', kind: 'cancel', targetId: 'a' });
    await flush();
    expect(fake.log).toEqual(['start:a', 'cancel:a']);
    expect(transport.sent).toContainEqual({ id: 'c1', kind: 'done' });
  });

  it('answers a request cancelled while still queued with CANCELLED and never starts it', async () => {
    const transport = fakeTransport();
    const fake = fakeSession();
    startHost(transport, fake.session, () => undefined);
    transport.deliver(evaluateRequest('a'));
    transport.deliver(evaluateRequest('b'));
    transport.deliver({ id: 'c1', kind: 'cancel', targetId: 'b' });
    await flush();
    fake.finish('a');
    await flush();
    expect(fake.log).not.toContain('start:b');
    expect(transport.sent).toContainEqual({
      id: 'b',
      kind: 'error',
      error: { code: 'CANCELLED', message: 'The operation was cancelled before it started' },
    });
    expect(transport.sent).toContainEqual({ id: 'b', kind: 'done' });
  });

  it('answers an invalid request with VALIDATION and its id, then done', () => {
    const transport = fakeTransport();
    startHost(transport, fakeSession().session, () => undefined);
    transport.deliver({ id: 'bad', kind: 'evaluate' });
    const [, error, done] = transport.sent;
    expect(error?.kind).toBe('error');
    expect(error?.id).toBe('bad');
    expect(done).toEqual({ id: 'bad', kind: 'done' });
    expect(error?.kind === 'error' && error.error.code).toBe('VALIDATION');
  });

  it('uses the process id when an invalid message has no usable id', () => {
    const transport = fakeTransport();
    startHost(transport, fakeSession().session, () => undefined);
    transport.deliver('not an object');
    transport.deliver({ id: '', kind: 'next' });
    const ids = transport.sent.slice(1).map((message) => message.id);
    expect(ids).toEqual(['process', 'process', 'process', 'process']);
  });

  it('disconnects and exits with code 0 when the parent closes the channel', async () => {
    const transport = fakeTransport();
    const fake = fakeSession();
    const exits: number[] = [];
    startHost(transport, fake.session, (code) => {
      exits.push(code);
    });
    transport.closeChannel();
    await flush();
    expect(fake.log).toEqual(['disconnect']);
    expect(exits).toEqual([0]);
  });

  it('answers a disconnect request, then exits with code 0 after the flush delay', async () => {
    const transport = fakeTransport();
    const exits: number[] = [];
    startHost(transport, fakeSession().session, (code) => {
      exits.push(code);
    });
    transport.deliver({ id: 'bye', kind: 'disconnect' });
    await new Promise((resolve) => setTimeout(resolve, EXIT_FLUSH_MS * 3));
    expect(transport.sent).toContainEqual({ id: 'bye', kind: 'done' });
    expect(exits).toEqual([0]);
  });
});

describe('installFatalHandlers', () => {
  it('reports an unhandled rejection with the process id and keeps running', async () => {
    const transport = fakeTransport();
    const events = new EventEmitter();
    const exits: number[] = [];
    installFatalHandlers(transport, (code) => exits.push(code), events);
    events.emit('unhandledRejection', new Error('monitor failed'));
    await new Promise((resolve) => setTimeout(resolve, EXIT_FLUSH_MS * 3));
    expect(transport.sent).toEqual([
      {
        id: 'process',
        kind: 'error',
        error: { code: 'INTERNAL', message: 'monitor failed' },
      },
    ]);
    expect(exits).toEqual([]);
  });

  it('reports an uncaught exception and exits with code 1', async () => {
    const transport = fakeTransport();
    const events = new EventEmitter();
    const exits: number[] = [];
    installFatalHandlers(transport, (code) => exits.push(code), events);
    events.emit('uncaughtException', new Error('boom'));
    await new Promise((resolve) => setTimeout(resolve, EXIT_FLUSH_MS * 3));
    expect(transport.sent[0]).toMatchObject({ id: 'process', kind: 'error' });
    expect(exits).toEqual([1]);
  });
});
