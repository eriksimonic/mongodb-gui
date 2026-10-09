import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { ShellRequest, ShellResponse } from '@mongo-gui/core';
import { ShellProcessClient, type ShellChild } from './client';

type Script = (request: ShellRequest, child: FakeChild) => void;

// A fake child process. Each request it receives is handed to a script, which emits scripted
// responses on a later tick, the way a real child answers over IPC.
class FakeChild extends EventEmitter implements ShellChild {
  readonly sent: ShellRequest[] = [];
  killed = false;
  private readonly script: Script;

  constructor(script: Script) {
    super();
    this.script = script;
  }

  send(message: unknown): boolean {
    const request = message as ShellRequest;
    this.sent.push(request);
    setImmediate(() => {
      this.script(request, this);
    });
    return true;
  }

  kill(): boolean {
    this.killed = true;
    this.emit('exit', null, 'SIGTERM');
    return true;
  }

  respond(response: ShellResponse): void {
    this.emit('message', response);
  }
}

function readyChild(script: Script): FakeChild {
  const child = new FakeChild(script);
  setImmediate(() => {
    child.respond({ id: 'process', kind: 'ready' });
  });
  return child;
}

async function collect(iterable: AsyncIterable<ShellResponse>): Promise<ShellResponse[]> {
  const messages: ShellResponse[] = [];
  for await (const message of iterable) {
    messages.push(message);
  }
  return messages;
}

const echoScript: Script = (request, child) => {
  if (request.kind === 'evaluate') {
    child.respond({ id: request.id, kind: 'print', text: 'hi' });
    child.respond({
      id: request.id,
      kind: 'result',
      type: 'number',
      printableEjson: '2',
      hasMore: false,
      elapsedMs: 1,
    });
    child.respond({ id: request.id, kind: 'done' });
  }
};

describe('ShellProcessClient', () => {
  it('resolves spawn once the child reports ready', async () => {
    const client = new ShellProcessClient();
    await client.spawn(() => readyChild(echoScript));
    client.dispose();
  });

  it('yields the responses for one request up to and including done', async () => {
    const client = new ShellProcessClient();
    await client.spawn(() => readyChild(echoScript));
    const messages = await collect(
      client.request({ id: 'e1', kind: 'evaluate', code: '2', batchSize: 10 }),
    );
    expect(messages.map((message) => message.kind)).toEqual(['print', 'result', 'done']);
    expect(messages.every((message) => message.id === 'e1')).toBe(true);
    client.dispose();
  });

  it('keeps concurrent requests apart by id', async () => {
    const script: Script = (request, child) => {
      // Answer "slow" after "fast" to show that routing is by id, not by arrival order.
      const delay = request.id === 'slow' ? 5 : 0;
      setTimeout(() => {
        child.respond({ id: request.id, kind: 'print', text: request.id });
        child.respond({ id: request.id, kind: 'done' });
      }, delay);
    };
    const client = new ShellProcessClient();
    await client.spawn(() => readyChild(script));
    const slow = collect(client.request({ id: 'slow', kind: 'next', batchSize: 1 }));
    const fast = collect(client.request({ id: 'fast', kind: 'next', batchSize: 1 }));
    const [slowMessages, fastMessages] = await Promise.all([slow, fast]);
    expect(slowMessages.map((message) => message.id)).toEqual(['slow', 'slow']);
    expect(fastMessages.map((message) => message.id)).toEqual(['fast', 'fast']);
    expect(fastMessages[0]).toEqual({ id: 'fast', kind: 'print', text: 'fast' });
    client.dispose();
  });

  it('ignores responses whose id has no pending request and malformed messages', async () => {
    const script: Script = (request, child) => {
      child.respond({ id: 'nobody', kind: 'done' });
      child.respond({ id: request.id, kind: 'bogus' } as unknown as ShellResponse);
      child.respond({ id: request.id, kind: 'done' });
    };
    const client = new ShellProcessClient();
    await client.spawn(() => readyChild(script));
    const messages = await collect(client.request({ id: 'x', kind: 'next', batchSize: 1 }));
    expect(messages).toEqual([{ id: 'x', kind: 'done' }]);
    client.dispose();
  });

  it('sends a cancel request for the target and waits for its done', async () => {
    const child = readyChild((request, fake) => {
      if (request.kind === 'cancel') {
        fake.respond({ id: request.id, kind: 'done' });
      }
    });
    const client = new ShellProcessClient();
    await client.spawn(() => child);
    await client.cancel('e1');
    expect(child.sent).toHaveLength(1);
    expect(child.sent[0]).toMatchObject({ kind: 'cancel', targetId: 'e1' });
    client.dispose();
  });

  it('ends pending requests with an error and done when the child exits', async () => {
    const child = readyChild((request, fake) => {
      if (request.kind === 'evaluate') {
        fake.emit('exit', 1, null);
      }
    });
    const client = new ShellProcessClient();
    await client.spawn(() => child);
    const messages = await collect(
      client.request({ id: 'e1', kind: 'evaluate', code: 'x', batchSize: 1 }),
    );
    expect(messages.map((message) => message.kind)).toEqual(['error', 'done']);
    const [first] = messages;
    expect(first?.kind === 'error' && first.error.code).toBe('INTERNAL');
  });

  it('ends pending requests when the channel disconnects or closes without an exit', async () => {
    for (const event of ['disconnect', 'close']) {
      const child = readyChild((request, fake) => {
        if (request.kind === 'evaluate') {
          fake.emit(event);
        }
      });
      const client = new ShellProcessClient();
      await client.spawn(() => child);
      const messages = await collect(
        client.request({ id: `e-${event}`, kind: 'evaluate', code: 'x', batchSize: 1 }),
      );
      expect(messages.map((message) => message.kind)).toEqual(['error', 'done']);
      client.dispose();
    }
  });

  it('answers a request sent after the child exited with an error', async () => {
    const child = readyChild(() => undefined);
    const client = new ShellProcessClient();
    await client.spawn(() => child);
    client.dispose();
    const messages = await collect(client.request({ id: 'late', kind: 'disconnect' }));
    expect(messages.map((message) => message.kind)).toEqual(['error', 'done']);
  });

  it('rejects spawn when the child exits before it is ready', async () => {
    const child = new FakeChild(() => undefined);
    const client = new ShellProcessClient();
    const spawned = client.spawn(() => child);
    child.emit('exit', 1, null);
    await expect(spawned).rejects.toThrow(/exited/);
  });

  it('kills the child on dispose', async () => {
    const child = readyChild(() => undefined);
    const client = new ShellProcessClient();
    await client.spawn(() => child);
    client.dispose();
    expect(child.killed).toBe(true);
  });
});
