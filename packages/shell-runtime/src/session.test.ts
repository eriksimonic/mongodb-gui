import { describe, expect, it } from 'vitest';
import type { ShellResponse } from '@mongo-gui/core';
import { ShellSession } from './session';

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
