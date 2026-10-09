import { existsSync, readFileSync } from 'node:fs';
import { AppErrorException, type AppErrorCode } from '@mongo-gui/core';
import { afterEach, describe, expect, it } from 'vitest';
import { EncryptedStore } from './encrypted-store';
import {
  FAST_KDF,
  TEST_PASSWORD,
  connectionInput,
  openTestStore,
  type TestStore,
} from './fixtures';
import { Vault } from '../vault/vault';

const SECRET = 'hunter2secret';
const PROFILE_NAME = 'Orders Production Cluster';
const SECRET_URI = `mongodb://app:${SECRET}@db.internal.example:27017/shop?authSource=admin`;

let test: TestStore;

afterEach(() => {
  test.dispose();
});

function storeFileBytes(path: string): Buffer {
  const parts = ['', '-wal', '-shm']
    .map((suffix) => `${path}${suffix}`)
    .filter((file) => existsSync(file))
    .map((file) => readFileSync(file));
  return Buffer.concat(parts);
}

function codeOf(action: () => unknown): AppErrorCode | undefined {
  try {
    action();
    return undefined;
  } catch (error) {
    return error instanceof AppErrorException ? error.error.code : undefined;
  }
}

describe('store file on disk', () => {
  it('contains no plaintext password, uri or profile name', () => {
    test = openTestStore();
    test.connections.create(connectionInput({ name: PROFILE_NAME, uri: SECRET_URI }));
    const bytes = storeFileBytes(test.storePath);
    expect(bytes.includes(SECRET)).toBe(false);
    expect(bytes.includes(SECRET_URI)).toBe(false);
    expect(bytes.includes(PROFILE_NAME)).toBe(false);
  });

  it('contains no plaintext after a WAL checkpoint', () => {
    test = openTestStore();
    test.connections.create(connectionInput({ name: PROFILE_NAME, uri: SECRET_URI }));
    test.store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const bytes = storeFileBytes(test.storePath);
    expect(bytes.includes(SECRET)).toBe(false);
    expect(bytes.includes(SECRET_URI)).toBe(false);
    expect(bytes.includes(PROFILE_NAME)).toBe(false);
  });

  it('contains no plaintext history code, favourite text or settings', () => {
    test = openTestStore();
    const connection = test.connections.create(connectionInput({ uri: SECRET_URI }));
    test.history.append({
      connectionId: connection.id,
      database: 'shop',
      code: 'db.customers.find({ ssn: "123-45-6789" })',
      startedAt: '2026-02-01T10:00:00.000Z',
      durationMs: 3,
    });
    test.favourites.save({ name: 'marker-favourite', code: 'db.marker.find()' });
    test.settings.update({ sampleSize: 4242 });
    test.store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const bytes = storeFileBytes(test.storePath);
    expect(bytes.includes('123-45-6789')).toBe(false);
    expect(bytes.includes('marker-favourite')).toBe(false);
    expect(bytes.includes('db.marker.find()')).toBe(false);
  });
});

describe('second vault with a different password', () => {
  it('fails to unlock, so the store stays unreadable', async () => {
    test = openTestStore();
    test.connections.create(connectionInput({ uri: SECRET_URI }));
    test.store.close();

    const intruder = new Vault({ dir: test.dir, kdf: FAST_KDF, failureDelayMs: 0 });
    let caught: unknown;
    try {
      await intruder.unlock(`${TEST_PASSWORD}-wrong`);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AppErrorException);
    expect(caught).toMatchObject({ error: { code: 'VAULT_BAD_PASSWORD' } });

    const reopened = new EncryptedStore({ path: test.storePath, vault: intruder });
    expect(codeOf(() => reopened.assertUnlocked())).toBe('VAULT_LOCKED');
    reopened.close();
  });
});

describe('AAD binding', () => {
  it('rejects a connection payload copied into another connection row', () => {
    test = openTestStore();
    const source = test.connections.create(connectionInput({ name: 'source', uri: SECRET_URI }));
    const target = test.connections.create(connectionInput({ name: 'target' }));
    test.store.db
      .prepare(
        'UPDATE connections SET payload = (SELECT payload FROM connections WHERE id = ?) WHERE id = ?',
      )
      .run(source.id, target.id);
    expect(codeOf(() => test.connections.get(target.id))).toBe('INTERNAL');
    expect(test.connections.get(source.id).uri).toBe(SECRET_URI);
  });

  it('rejects a connection payload copied into the favourites table', () => {
    test = openTestStore();
    const connection = test.connections.create(connectionInput({ uri: SECRET_URI }));
    test.store.db
      .prepare(
        'INSERT INTO favourites (id, created_at, payload) SELECT id, created_at, payload FROM connections WHERE id = ?',
      )
      .run(connection.id);
    expect(codeOf(() => test.favourites.list())).toBe('INTERNAL');
  });

  it('rejects a payload with a flipped ciphertext byte', () => {
    test = openTestStore();
    const connection = test.connections.create(connectionInput({ uri: SECRET_URI }));
    test.store.db
      .prepare('UPDATE connections SET payload = ? WHERE id = ?')
      .run(
        tamper(test.store.encryptPayload('connections', connection.id, { id: connection.id })),
        connection.id,
      );
    expect(codeOf(() => test.connections.get(connection.id))).toBe('INTERNAL');
  });
});

describe('locked vault', () => {
  it('makes every repository call throw VAULT_LOCKED after lock', () => {
    test = openTestStore();
    const connection = test.connections.create(connectionInput());
    test.history.append({
      connectionId: connection.id,
      database: 'shop',
      code: 'db.a.find()',
      startedAt: '2026-02-01T10:00:00.000Z',
      durationMs: 1,
    });
    const favourite = test.favourites.save({ name: 'f', code: 'x' });
    test.settings.update({ theme: 'light' });
    test.layout.set('main', { a: 1 });

    test.vault.lock();

    const calls: Array<[string, () => unknown]> = [
      ['connections.list', () => test.connections.list()],
      ['connections.get', () => test.connections.get(connection.id)],
      ['connections.create', () => test.connections.create(connectionInput())],
      ['connections.update', () => test.connections.update(connection.id, { name: 'x' })],
      ['connections.remove', () => test.connections.remove(connection.id)],
      [
        'history.append',
        () =>
          test.history.append({
            connectionId: connection.id,
            database: 'x',
            code: 'y',
            startedAt: '2026-02-01T10:00:00.000Z',
            durationMs: 1,
          }),
      ],
      ['history.list', () => test.history.list()],
      ['history.clear', () => test.history.clear()],
      ['history.prune', () => test.history.prune(1)],
      ['favourites.list', () => test.favourites.list()],
      ['favourites.save', () => test.favourites.save({ name: 'x', code: 'y' })],
      ['favourites.remove', () => test.favourites.remove(favourite.id)],
      ['settings.get', () => test.settings.get()],
      ['settings.update', () => test.settings.update({ theme: 'dark' })],
      ['layout.get', () => test.layout.get('main')],
      ['layout.set', () => test.layout.set('main', { a: 2 })],
    ];
    for (const [name, call] of calls) {
      expect(codeOf(call), name).toBe('VAULT_LOCKED');
    }
  });
});

function tamper(blob: Buffer): Buffer {
  const copy = Buffer.from(blob);
  copy[copy.length - 20] = (copy[copy.length - 20] ?? 0) ^ 0x01;
  return copy;
}
