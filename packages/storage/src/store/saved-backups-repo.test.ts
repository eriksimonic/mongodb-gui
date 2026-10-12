import { AppErrorException, type AppErrorCode, type SavedBackupInput } from '@mongo-gui/core';
import { afterEach, describe, expect, it } from 'vitest';
import { connectionInput, openTestStore, type TestStore } from './fixtures';

let test: TestStore;

afterEach(() => {
  test.dispose();
});

const UNKNOWN = '00000000-0000-4000-8000-000000000000';

function codeOf(action: () => unknown): AppErrorCode | undefined {
  try {
    action();
    return undefined;
  } catch (error) {
    return error instanceof AppErrorException ? error.error.code : undefined;
  }
}

function input(connectionId: string, label = 'Nightly shop'): SavedBackupInput {
  return {
    label,
    connectionId,
    scope: { kind: 'database', database: 'shop' },
    options: {
      output: 'archive',
      gzip: true,
      excludeCollections: ['logs'],
      excludeCollectionsWithPrefix: [],
      oplog: false,
      dumpDbUsersAndRoles: false,
      viewsAsCollections: false,
      forceTableScan: false,
      numParallelCollections: 4,
      compressors: [],
    },
    toolsVersion: '100.9.4',
  };
}

describe('SavedBackupsRepository', () => {
  it('saves a configuration and lists it', () => {
    test = openTestStore();
    const connection = test.connections.create(connectionInput());
    const saved = test.savedBackups.save(input(connection.id));
    expect(saved.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(test.savedBackups.list()).toEqual([saved]);
  });

  it('keeps the label out of the file in plain text', () => {
    test = openTestStore();
    const connection = test.connections.create(connectionInput());
    test.savedBackups.save(input(connection.id, 'marker-saved-backup'));
    const row = test.store.db.prepare('SELECT payload FROM saved_backups').get();
    expect(Buffer.from(row?.['payload'] as Uint8Array).includes('marker-saved-backup')).toBe(false);
  });

  it('rejects an invalid input and an unknown connection', () => {
    test = openTestStore();
    const connection = test.connections.create(connectionInput());
    expect(codeOf(() => test.savedBackups.save(input(connection.id, '  ')))).toBe('VALIDATION');
    expect(codeOf(() => test.savedBackups.save(input(UNKNOWN)))).toBe('CONNECTION_NOT_FOUND');
  });

  it('renames a configuration and rejects an unknown id', () => {
    test = openTestStore();
    const connection = test.connections.create(connectionInput());
    const saved = test.savedBackups.save(input(connection.id));
    const renamed = test.savedBackups.rename(saved.id, 'Weekly shop');
    expect(renamed).toEqual({ ...saved, label: 'Weekly shop' });
    expect(test.savedBackups.list()).toEqual([renamed]);
    expect(codeOf(() => test.savedBackups.rename(saved.id, ''))).toBe('VALIDATION');
    expect(codeOf(() => test.savedBackups.rename(UNKNOWN, 'x'))).toBe('VALIDATION');
  });

  it('removes a configuration, and an unknown id is a no-op', () => {
    test = openTestStore();
    const connection = test.connections.create(connectionInput());
    const first = test.savedBackups.save(input(connection.id, 'a'));
    const second = test.savedBackups.save(input(connection.id, 'b'));
    test.savedBackups.remove(first.id);
    test.savedBackups.remove(UNKNOWN);
    expect(test.savedBackups.list()).toEqual([second]);
  });

  it('deletes the configurations of a removed connection', () => {
    test = openTestStore();
    const connection = test.connections.create(connectionInput());
    test.savedBackups.save(input(connection.id));
    test.connections.remove(connection.id);
    expect(test.savedBackups.list()).toEqual([]);
  });
});
