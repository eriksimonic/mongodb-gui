import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppErrorException, type AppErrorCode } from '@mongo-gui/core';
import { afterEach, describe, expect, it } from 'vitest';
import { seal } from '../crypto/aead';
import { Vault } from '../vault/vault';
import { EncryptedStore } from './encrypted-store';
import { FAST_KDF, TEST_PASSWORD, openTestStore, type TestStore } from './fixtures';

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
});

function track(test: TestStore): TestStore {
  cleanups.push(() => test.dispose());
  return test;
}

function caughtCode(action: () => unknown): AppErrorCode | undefined {
  try {
    action();
    return undefined;
  } catch (error) {
    return error instanceof AppErrorException ? error.error.code : undefined;
  }
}

describe('EncryptedStore setup', () => {
  it('enables WAL and foreign keys and applies schema version 1', () => {
    const test = track(openTestStore());
    const journal = test.store.db.prepare('PRAGMA journal_mode').get();
    const foreignKeys = test.store.db.prepare('PRAGMA foreign_keys').get();
    const version = test.store.db
      .prepare('SELECT MAX(version) AS version FROM schema_version')
      .get();
    expect(journal?.['journal_mode']).toBe('wal');
    expect(foreignKeys?.['foreign_keys']).toBe(1);
    expect(version?.['version']).toBe(1);
  });

  it('does not rerun migrations when an existing file is reopened', () => {
    const test = track(openTestStore());
    test.store.close();
    const reopened = new EncryptedStore({ path: test.storePath, vault: test.vault });
    cleanups.push(() => reopened.close());
    const count = reopened.db.prepare('SELECT COUNT(*) AS count FROM schema_version').get();
    expect(count?.['count']).toBe(1);
  });

  it('creates the five content tables and the history index', () => {
    const test = track(openTestStore());
    const names = test.store.db
      .prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'index') ORDER BY name")
      .all()
      .map((row) => row['name']);
    for (const name of [
      'connections',
      'history',
      'favourites',
      'settings',
      'layout',
      'history_connection_started',
    ]) {
      expect(names).toContain(name);
    }
  });
});

describe('EncryptedStore payloads', () => {
  it('round trips a value through encryptPayload and decryptPayload', () => {
    const test = track(openTestStore());
    const blob = test.store.encryptPayload('layout', 'main', { panes: [1, 2] });
    const value = test.store.decryptPayload('layout', 'main', blob, {
      safeParse: (data) => ({ success: true, data }),
    });
    expect(value).toEqual({ panes: [1, 2] });
  });

  it('does not store plaintext in the payload', () => {
    const test = track(openTestStore());
    const blob = test.store.encryptPayload('layout', 'main', { marker: 'visible-text' });
    expect(blob.includes('visible-text')).toBe(false);
  });

  it('throws VALIDATION when the value has no JSON form', () => {
    const test = track(openTestStore());
    expect(caughtCode(() => test.store.encryptPayload('layout', 'main', undefined))).toBe(
      'VALIDATION',
    );
  });

  it('throws INTERNAL when the payload is opened under another table or id', () => {
    const test = track(openTestStore());
    const blob = test.store.encryptPayload('layout', 'main', { a: 1 });
    const anyJson = { safeParse: (data: unknown) => ({ success: true as const, data }) };
    expect(caughtCode(() => test.store.decryptPayload('layout', 'other', blob, anyJson))).toBe(
      'INTERNAL',
    );
    expect(caughtCode(() => test.store.decryptPayload('settings', 'main', blob, anyJson))).toBe(
      'INTERNAL',
    );
  });

  it('throws INTERNAL when the decrypted value fails the schema', () => {
    const test = track(openTestStore());
    const blob = test.store.encryptPayload('layout', 'main', { a: 1 });
    const rejecting = { safeParse: () => ({ success: false as const }) };
    expect(caughtCode(() => test.store.decryptPayload('layout', 'main', blob, rejecting))).toBe(
      'INTERNAL',
    );
  });

  it('throws INTERNAL when the authenticated plaintext is not JSON', () => {
    const test = track(openTestStore());
    const blob = test.vault.withDek((dek) =>
      seal(dek, Buffer.from('not json', 'utf8'), Buffer.from('layout:main', 'utf8')),
    );
    const anyJson = { safeParse: (data: unknown) => ({ success: true as const, data }) };
    expect(caughtCode(() => test.store.decryptPayload('layout', 'main', blob, anyJson))).toBe(
      'INTERNAL',
    );
  });

  it('throws VAULT_LOCKED from encryptPayload and decryptPayload while locked', () => {
    const test = track(openTestStore());
    const blob = test.store.encryptPayload('layout', 'main', { a: 1 });
    test.vault.lock();
    const anyJson = { safeParse: (data: unknown) => ({ success: true as const, data }) };
    expect(caughtCode(() => test.store.encryptPayload('layout', 'main', { a: 1 }))).toBe(
      'VAULT_LOCKED',
    );
    expect(caughtCode(() => test.store.decryptPayload('layout', 'main', blob, anyJson))).toBe(
      'VAULT_LOCKED',
    );
  });
});

describe('EncryptedStore lifecycle', () => {
  it('assertUnlocked throws VAULT_LOCKED only while the vault is locked', () => {
    const test = track(openTestStore());
    expect(() => {
      test.store.assertUnlocked();
    }).not.toThrow();
    test.vault.lock();
    expect(caughtCode(() => test.store.assertUnlocked())).toBe('VAULT_LOCKED');
  });

  it('close is idempotent', () => {
    const test = track(openTestStore());
    test.store.close();
    expect(() => {
      test.store.close();
    }).not.toThrow();
  });

  it('deleteFile removes the database, the WAL and the shared-memory file', () => {
    const test = openTestStore();
    cleanups.push(() => rmSync(test.dir, { recursive: true, force: true }));
    test.connections.create({ name: 'a', uri: 'mongodb://h' });
    test.store.close();
    writeFileSync(`${test.storePath}-wal`, '');
    writeFileSync(`${test.storePath}-shm`, '');
    test.store.deleteFile();
    expect(existsSync(test.storePath)).toBe(false);
    expect(existsSync(`${test.storePath}-wal`)).toBe(false);
    expect(existsSync(`${test.storePath}-shm`)).toBe(false);
  });

  it('deleteFile on an in-memory store only closes it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'store-mem-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const vault = new Vault({ dir, kdf: FAST_KDF, failureDelayMs: 0 });
    vault.initialise(TEST_PASSWORD);
    const store = new EncryptedStore({ path: ':memory:', vault });
    expect(() => {
      store.deleteFile();
    }).not.toThrow();
  });

  it('opens a database that is not a store file as a sqlite error', () => {
    const dir = mkdtempSync(join(tmpdir(), 'store-bad-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'bad.sqlite');
    writeFileSync(path, 'plain text, not sqlite at all, padded to one page of bytes '.repeat(100));
    const vault = new Vault({ dir, kdf: FAST_KDF, failureDelayMs: 0 });
    vault.initialise(TEST_PASSWORD);
    expect(() => new EncryptedStore({ path, vault })).toThrow();
  });
});

describe('EncryptedStore after close', () => {
  it('makes repository calls throw INTERNAL "store is closed"', () => {
    const test = track(openTestStore());
    test.store.close();
    let caught: unknown;
    try {
      test.connections.list();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AppErrorException);
    expect(caught).toMatchObject({ error: { code: 'INTERNAL', message: 'store is closed' } });
  });
});
