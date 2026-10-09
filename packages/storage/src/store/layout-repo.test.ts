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

describe('LayoutRepository.get', () => {
  it('returns undefined for an unknown key', () => {
    test = openTestStore();
    expect(test.layout.get('main')).toBeUndefined();
  });
});

describe('LayoutRepository.set', () => {
  it('stores a nested JSON value and returns it on get', () => {
    test = openTestStore();
    const value = { panels: [{ id: 'sidebar', size: 0.25 }], open: true };
    test.layout.set('main', value);
    expect(test.layout.get('main')).toEqual(value);
  });

  it('replaces the value for an existing key', () => {
    test = openTestStore();
    test.layout.set('main', { v: 1 });
    test.layout.set('main', { v: 2 });
    expect(test.layout.get('main')).toEqual({ v: 2 });
  });

  it('rejects an empty key and an undefined value with VALIDATION', () => {
    test = openTestStore();
    expect(codeOf(() => test.layout.set('', { v: 1 }))).toBe('VALIDATION');
    expect(codeOf(() => test.layout.set('main', undefined))).toBe('VALIDATION');
  });
});
