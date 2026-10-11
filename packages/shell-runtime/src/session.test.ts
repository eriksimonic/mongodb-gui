import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { EJSON } from 'bson';
import { afterEach, describe, expect, it } from 'vitest';
import { previewInfo, type ShellResponse } from '@mongo-gui/core';
import { createSpillContext, readSpillFile, type SpillContext } from '@mongo-gui/storage/spill';
import { serializePrintable } from './results';
import { ShellSession, type ShellSessionOptions } from './session';

interface FakeOptions {
  readonly collections: readonly string[];
  readonly runtimeTexts: readonly string[];
}

// A session whose connection is a fake runtime and driver provider. The runtime returns the given
// completion texts, and the provider lists the given collections of the database "shop".
function sessionWith({ collections, runtimeTexts }: FakeOptions): ShellSession {
  const session = new ShellSession();
  const connection = {
    runtime: {
      getCompletions: async () => runtimeTexts.map((completion) => ({ completion })),
      evaluate: async () => ({ printable: 'shop' }),
    },
    provider: {
      listCollections: async () => collections.map((name) => ({ name })),
    },
  };
  // ensureConnection is private. The test replaces it so no driver or runtime is created.
  (session as unknown as { ensureConnection: () => Promise<unknown> }).ensureConnection =
    async () => connection;
  return session;
}

async function complete(session: ShellSession, code: string): Promise<ShellResponse[]> {
  const messages: ShellResponse[] = [];
  await session.complete({ id: 'r1', kind: 'complete', code, position: code.length }, (message) =>
    messages.push(message),
  );
  return messages;
}

describe('ShellSession.complete', () => {
  it('adds one collection item per collection after db. and keeps the runtime methods', async () => {
    const session = sessionWith({
      collections: ['users', 'orders'],
      runtimeTexts: ['db.find', 'db.users'],
    });
    const [message] = await complete(session, 'db.');
    expect(message).toEqual({
      id: 'r1',
      kind: 'completions',
      items: [
        { text: 'db.find', kind: 'other' },
        { text: 'db.users', kind: 'collection' },
        { text: 'db.orders', kind: 'collection' },
      ],
    });
  });

  it('lists every collection even when the runtime returns none', async () => {
    const session = sessionWith({ collections: ['users', 'orders'], runtimeTexts: [] });
    const [message] = await complete(session, 'db.us');
    expect(message).toEqual({
      id: 'r1',
      kind: 'completions',
      items: [
        { text: 'db.users', kind: 'collection' },
        { text: 'db.orders', kind: 'collection' },
      ],
    });
  });

  it('keeps the text before db. so the editor can match it', async () => {
    const session = sessionWith({ collections: ['users'], runtimeTexts: [] });
    const [message] = await complete(session, 'count = db.');
    expect(message).toMatchObject({ items: [{ text: 'count = db.users', kind: 'collection' }] });
  });

  it('drops runtime texts with an invalid db member and offers db.getCollection instead', async () => {
    const session = sessionWith({
      collections: ['my-coll'],
      runtimeTexts: ['db.my-coll', 'db.find'],
    });
    const [message] = await complete(session, 'db.');
    const texts = message?.kind === 'completions' ? message.items.map((item) => item.text) : [];
    expect(texts).toContain('db.getCollection("my-coll")');
    expect(texts).toContain('db.find');
    expect(texts).not.toContain('db.my-coll');
  });

  it('uses db.getCollection for names that are not identifiers', async () => {
    const session = sessionWith({ collections: ['my-logs', '2024'], runtimeTexts: [] });
    const [message] = await complete(session, 'db.');
    expect(message).toMatchObject({
      items: [
        { text: 'db.getCollection("my-logs")', kind: 'collection' },
        { text: 'db.getCollection("2024")', kind: 'collection' },
      ],
    });
  });

  it('does not add collection items to a line that is not a db member', async () => {
    const session = sessionWith({ collections: ['users'], runtimeTexts: ['db.find'] });
    const [message] = await complete(session, 'db.users.fi');
    expect(message).toEqual({
      id: 'r1',
      kind: 'completions',
      items: [{ text: 'db.find', kind: 'other' }],
    });
  });
});

describe('ShellSession cursor results', () => {
  const dirs: string[] = [];

  afterEach(() => {
    dirs.splice(0).forEach((dir) => {
      rmSync(dir, { recursive: true, force: true });
    });
  });

  function spillContext(): SpillContext {
    const dir = mkdtempSync(join(tmpdir(), 'mg-session-'));
    dirs.push(dir);
    return createSpillContext(dir);
  }

  // A session whose evaluation returns one cursor batch.
  function cursorSession(documents: unknown[], options: ShellSessionOptions): ShellSession {
    const session = new ShellSession(options);
    const printable = { documents, cursorHasMore: true };
    const connection = {
      generation: 1,
      runtime: { evaluate: async () => ({ type: 'Cursor', printable }) },
      provider: { baseCmdOptions: {} },
      pendingWork: null,
    };
    (session as unknown as { ensureConnection: () => Promise<unknown> }).ensureConnection =
      async () => connection;
    return session;
  }

  async function evaluate(session: ShellSession): Promise<string> {
    const messages: ShellResponse[] = [];
    await session.evaluate(
      { id: randomUUID(), kind: 'evaluate', code: 'db.c.find()', batchSize: 50 },
      (message) => messages.push(message),
    );
    const result = messages.find((message) => message.kind === 'result');
    if (result?.kind !== 'result') {
      throw new Error('no result');
    }
    return result.printableEjson;
  }

  const big = { _id: 2, text: 'x'.repeat(100_000) };

  it('previews an oversized document and stores its full text in the spill', async () => {
    const spill = spillContext();
    const text = await evaluate(cursorSession([{ _id: 1 }, big], { spill }));
    const page = JSON.parse(text) as { documents: unknown[] };
    const info = previewInfo(page.documents[1]);
    expect(previewInfo(page.documents[0])).toBeUndefined();
    expect(info?.ref).toBeDefined();
    expect(readSpillFile(spill, info?.ref ?? '')).toBe(EJSON.stringify(big, { relaxed: false }));
  });

  // A session whose evaluation returns a plain value, such as the array toArray() gives.
  function valueSession(printable: unknown, options: ShellSessionOptions): ShellSession {
    const session = new ShellSession(options);
    const connection = {
      generation: 1,
      runtime: { evaluate: async () => ({ type: 'Document', printable }) },
      provider: { baseCmdOptions: {} },
      pendingWork: null,
    };
    (session as unknown as { ensureConnection: () => Promise<unknown> }).ensureConnection =
      async () => connection;
    return session;
  }

  it('previews and spills a toArray() list and a findOne() document', async () => {
    const spill = spillContext();
    const list = Array.from({ length: 200 }, (_, i) => ({ _id: i, text: 'x'.repeat(100_000) }));
    const listText = await evaluate(valueSession(list, { spill }));
    expect(listText.length).toBeLessThan(2.5 * 1024 * 1024);
    const items = JSON.parse(listText) as unknown[];
    expect(items).toHaveLength(200);
    const info = previewInfo(items[199]);
    expect(readSpillFile(spill, info?.ref ?? '')).toBe(
      EJSON.stringify(list[199], { relaxed: false }),
    );

    const oneText = await evaluate(valueSession(big, { spill }));
    expect(oneText.length).toBeLessThan(20_000);
    expect(previewInfo(JSON.parse(oneText))?.ref).toBeDefined();
  });

  it('sends a non-cursor value whole without a spill context', async () => {
    const text = await evaluate(valueSession([big], {}));
    expect(text).toBe(serializePrintable([big]));
  });

  it('sends the legacy string without a spill context', async () => {
    const printable = { documents: [{ _id: 1 }, big], cursorHasMore: true };
    const text = await evaluate(cursorSession(printable.documents, {}));
    expect(text).toBe(serializePrintable(printable));
  });

  it('stops storing documents once the run limit is reached', async () => {
    const spill = spillContext();
    const second = { _id: 3, text: 'y'.repeat(100_000) };
    const session = cursorSession([big, second], { spill, spillRunLimitBytes: 150_000 });
    const page = JSON.parse(await evaluate(session)) as { documents: unknown[] };
    expect(previewInfo(page.documents[0])?.ref).toBeDefined();
    expect(previewInfo(page.documents[1])).toMatchObject({ chars: expect.any(Number) });
    expect(previewInfo(page.documents[1])?.ref).toBeUndefined();
  });
});
