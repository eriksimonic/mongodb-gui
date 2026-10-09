import { AppErrorException, type AppErrorCode, type ConnectionProfileInput } from '@mongo-gui/core';
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

describe('ConnectionsRepository.create', () => {
  it('assigns an id and timestamps and returns the profile', () => {
    test = openTestStore();
    const created = test.connections.create(connectionInput({ name: 'Orders' }));
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(created.name).toBe('Orders');
    expect(created.createdAt).toBe(created.updatedAt);
    expect(new Date(created.createdAt).toISOString()).toBe(created.createdAt);
  });

  it('keeps the uri exactly as given', () => {
    test = openTestStore();
    const uri = 'mongodb+srv://app:p%40ss@cluster.example.net/app?retryWrites=true';
    expect(test.connections.create(connectionInput({ uri })).uri).toBe(uri);
  });

  it('rejects input that fails the core schema with VALIDATION', () => {
    test = openTestStore();
    expect(codeOf(() => test.connections.create(connectionInput({ uri: 'http://nope' })))).toBe(
      'VALIDATION',
    );
    expect(codeOf(() => test.connections.create({ name: '', uri: 'mongodb://h' }))).toBe(
      'VALIDATION',
    );
  });
});

describe('ConnectionsRepository.get and list', () => {
  it('returns the stored profile by id and lists every profile', () => {
    test = openTestStore();
    const first = test.connections.create(connectionInput({ name: 'A' }));
    const second = test.connections.create(connectionInput({ name: 'B' }));
    expect(test.connections.get(first.id)).toEqual(first);
    expect(
      test.connections
        .list()
        .map((profile) => profile.id)
        .sort(),
    ).toEqual([first.id, second.id].sort());
  });

  it('returns an empty list when nothing is stored', () => {
    test = openTestStore();
    expect(test.connections.list()).toEqual([]);
  });

  it('throws CONNECTION_NOT_FOUND for an unknown id', () => {
    test = openTestStore();
    expect(codeOf(() => test.connections.get('00000000-0000-4000-8000-000000000000'))).toBe(
      'CONNECTION_NOT_FOUND',
    );
  });
});

describe('ConnectionsRepository.update', () => {
  it('changes the given fields, keeps createdAt and the other fields', () => {
    test = openTestStore();
    const created = test.connections.create(connectionInput({ name: 'Old', color: 'red' }));
    const updated = test.connections.update(created.id, { name: 'New' });
    expect(updated.name).toBe('New');
    expect(updated.color).toBe('red');
    expect(updated.uri).toBe(created.uri);
    expect(updated.createdAt).toBe(created.createdAt);
    expect(test.connections.get(created.id)).toEqual(updated);
  });

  it('rejects a patch that would leave the profile invalid', () => {
    test = openTestStore();
    const created = test.connections.create(connectionInput());
    expect(codeOf(() => test.connections.update(created.id, { uri: 'ftp://x' }))).toBe(
      'VALIDATION',
    );
    const clearedName = { name: undefined } as unknown as Partial<ConnectionProfileInput>;
    expect(codeOf(() => test.connections.update(created.id, clearedName))).toBe('VALIDATION');
    expect(test.connections.get(created.id)).toEqual(created);
  });

  it('throws CONNECTION_NOT_FOUND for an unknown id', () => {
    test = openTestStore();
    expect(
      codeOf(() => test.connections.update('00000000-0000-4000-8000-000000000000', { name: 'x' })),
    ).toBe('CONNECTION_NOT_FOUND');
  });
});

describe('ConnectionsRepository.remove', () => {
  it('removes the profile', () => {
    test = openTestStore();
    const created = test.connections.create(connectionInput());
    test.connections.remove(created.id);
    expect(codeOf(() => test.connections.get(created.id))).toBe('CONNECTION_NOT_FOUND');
  });

  it('throws CONNECTION_NOT_FOUND when the id is unknown', () => {
    test = openTestStore();
    expect(codeOf(() => test.connections.remove('00000000-0000-4000-8000-000000000000'))).toBe(
      'CONNECTION_NOT_FOUND',
    );
  });
});
