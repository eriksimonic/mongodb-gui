import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { ShellResponse } from '@mongo-gui/core';
import {
  chooseTransport,
  parentPortTransport,
  processSendTransport,
  type ParentPortLike,
} from './transport';

const done: ShellResponse = { id: '1', kind: 'done' };

// A fake forked child: process.send records what the child sent, and the test emits incoming
// IPC messages through the same EventEmitter that process.on uses.
function fakeProcess(): EventEmitter & { sent: unknown[]; send(message: unknown): boolean } {
  const emitter = new EventEmitter();
  const sent: unknown[] = [];
  return Object.assign(emitter, {
    sent,
    send(message: unknown) {
      sent.push(message);
      return true;
    },
  });
}

function fakePort(): ParentPortLike & { emit(data: unknown): void; posted: unknown[] } {
  const emitter = new EventEmitter();
  const posted: unknown[] = [];
  return {
    posted,
    on(event, listener) {
      emitter.on(event, listener);
      return this;
    },
    postMessage(message) {
      posted.push(message);
    },
    emit(data) {
      emitter.emit('message', { data });
    },
  };
}

describe('processSendTransport', () => {
  it('sends responses through process.send', () => {
    const proc = fakeProcess();
    const transport = processSendTransport(proc);
    transport.send(done);
    expect(proc.sent).toEqual([done]);
  });

  it('passes raw IPC messages to the message callback unparsed', () => {
    const proc = fakeProcess();
    const transport = processSendTransport(proc);
    const received: unknown[] = [];
    transport.onMessage((raw) => received.push(raw));
    proc.emit('message', { kind: 'disconnect', id: '9' });
    proc.emit('message', 'not even an object');
    expect(received).toEqual([{ kind: 'disconnect', id: '9' }, 'not even an object']);
  });

  it('calls the close callback when the IPC channel disconnects', () => {
    const proc = fakeProcess();
    const transport = processSendTransport(proc);
    const onClose = vi.fn();
    transport.onClose(onClose);
    proc.emit('disconnect');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('refuses a process without an IPC channel', () => {
    const proc = new EventEmitter();
    expect(() => processSendTransport(proc)).toThrow(/IPC channel/);
  });
});

describe('parentPortTransport', () => {
  it('posts responses to the port and unwraps event.data for incoming messages', () => {
    const port = fakePort();
    const transport = parentPortTransport(port);
    const received: unknown[] = [];
    transport.onMessage((raw) => received.push(raw));
    transport.send(done);
    port.emit({ kind: 'cancel', id: '2', targetId: '1' });
    expect(port.posted).toEqual([done]);
    expect(received).toEqual([{ kind: 'cancel', id: '2', targetId: '1' }]);
  });
});

describe('chooseTransport', () => {
  it('prefers the parent port when the process exposes one', () => {
    const proc = Object.assign(fakeProcess(), { parentPort: fakePort() });
    const transport = chooseTransport(proc);
    transport.send(done);
    expect(proc.sent).toEqual([]);
    expect(proc.parentPort.posted).toEqual([done]);
  });

  it('falls back to process.send when no parent port exists', () => {
    const proc = fakeProcess();
    const transport = chooseTransport(proc);
    transport.send(done);
    expect(proc.sent).toEqual([done]);
  });
});
