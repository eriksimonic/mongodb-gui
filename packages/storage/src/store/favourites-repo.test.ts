import { AppErrorException, type AppErrorCode } from '@mongo-gui/core';
import { afterEach, describe, expect, it } from 'vitest';
import { openTestStore, type TestStore } from './fixtures';

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

describe('FavouritesRepository', () => {
  it('saves a favourite with an id and creation time and lists it', () => {
    test = openTestStore();
    const saved = test.favourites.save({
      name: 'Paid orders',
      folder: 'reports',
      code: 'db.orders.find({status: "paid"})',
      database: 'shop',
    });
    expect(saved.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(new Date(saved.createdAt).toISOString()).toBe(saved.createdAt);
    expect(test.favourites.list()).toEqual([saved]);
  });

  it('rejects input that fails the schema with VALIDATION', () => {
    test = openTestStore();
    expect(codeOf(() => test.favourites.save({ name: '', code: 'x' }))).toBe('VALIDATION');
  });

  it('removes a favourite by id', () => {
    test = openTestStore();
    const first = test.favourites.save({ name: 'a', code: 'x' });
    const second = test.favourites.save({ name: 'b', code: 'y' });
    test.favourites.remove(first.id);
    expect(test.favourites.list()).toEqual([second]);
  });

  it('treats removing an unknown id as a no-op', () => {
    test = openTestStore();
    expect(() => {
      test.favourites.remove('00000000-0000-4000-8000-000000000000');
    }).not.toThrow();
  });

  it('returns an empty list when nothing is saved', () => {
    test = openTestStore();
    expect(test.favourites.list()).toEqual([]);
  });
});
