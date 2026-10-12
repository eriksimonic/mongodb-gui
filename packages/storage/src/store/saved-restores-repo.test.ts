import {
  AppErrorException,
  RestoreOptionsSchema,
  type AppErrorCode,
  type SavedRestoreInput,
} from '@mongo-gui/core';
import { afterEach, describe, expect, it } from 'vitest';
import { connectionInput, openTestStore, type TestStore } from './fixtures';

let test: TestStore;

afterEach(() => {
  test.dispose();
});

function codeOf(action: () => unknown): AppErrorCode | undefined {
  try {
    action();
    return undefined;
  } catch (error) {
    return error instanceof AppErrorException ? error.error.code : undefined;
  }
}

function input(connectionId: string, name = 'Nightly'): SavedRestoreInput {
  return {
    name,
    connectionId,
    source: '/backups/shop.archive',
    toolsVersion: '100.9.4',
    options: RestoreOptionsSchema.parse({
      include: ['shop.orders'],
      renames: [{ from: 'shop', to: 'shop_copy' }],
      drop: true,
    }),
  };
}

const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000';

describe('SavedRestoresRepository', () => {
  it('saves a restore and lists it in order', () => {
    test = openTestStore();
    const connection = test.connections.create(connectionInput());
    const first = test.savedRestores.save(input(connection.id, 'a'));
    const second = test.savedRestores.save(input(connection.id, 'b'));
    expect(first.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(test.savedRestores.list()).toEqual([first, second]);
  });

  it('keeps the options and no credentials', () => {
    test = openTestStore();
    const connection = test.connections.create(
      connectionInput({ uri: 'mongodb://user:hunter2@localhost:27017' }),
    );
    const saved = test.savedRestores.save(input(connection.id));
    expect(saved.options.renames).toEqual([{ from: 'shop', to: 'shop_copy' }]);
    expect(JSON.stringify(test.savedRestores.list())).not.toContain('hunter2');
  });

  it('renames and keeps everything else', () => {
    test = openTestStore();
    const connection = test.connections.create(connectionInput());
    const saved = test.savedRestores.save(input(connection.id));
    const renamed = test.savedRestores.rename(saved.id, '  Weekly  ');
    expect(renamed).toEqual({ ...saved, name: 'Weekly' });
    expect(test.savedRestores.list()).toEqual([renamed]);
  });

  it('refuses a blank name and an unknown id', () => {
    test = openTestStore();
    const connection = test.connections.create(connectionInput());
    const saved = test.savedRestores.save(input(connection.id));
    expect(codeOf(() => test.savedRestores.rename(saved.id, '  '))).toBe('VALIDATION');
    expect(codeOf(() => test.savedRestores.rename(UNKNOWN_ID, 'x'))).toBe('NOT_FOUND');
  });

  it('refuses an unknown connection and invalid input', () => {
    test = openTestStore();
    expect(codeOf(() => test.savedRestores.save(input(UNKNOWN_ID)))).toBe('CONNECTION_NOT_FOUND');
    const connection = test.connections.create(connectionInput());
    expect(codeOf(() => test.savedRestores.save(input(connection.id, '')))).toBe('VALIDATION');
  });

  it('removes one, ignores an unknown id and goes with its connection', () => {
    test = openTestStore();
    const connection = test.connections.create(connectionInput());
    const first = test.savedRestores.save(input(connection.id, 'a'));
    test.savedRestores.save(input(connection.id, 'b'));
    test.savedRestores.remove(first.id);
    test.savedRestores.remove(first.id);
    expect(test.savedRestores.list().map((item) => item.name)).toEqual(['b']);
    test.connections.remove(connection.id);
    expect(test.savedRestores.list()).toEqual([]);
  });
});
