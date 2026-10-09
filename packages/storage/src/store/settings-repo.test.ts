import { AppErrorException, defaultSettings, type AppErrorCode } from '@mongo-gui/core';
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

describe('SettingsRepository.get', () => {
  it('returns the defaults when nothing is stored', () => {
    test = openTestStore();
    expect(test.settings.get()).toEqual(defaultSettings);
  });
});

describe('SettingsRepository.update', () => {
  it('merges the patch over the stored settings and returns the result', () => {
    test = openTestStore();
    const first = test.settings.update({ theme: 'light' });
    expect(first).toEqual({ ...defaultSettings, theme: 'light' });
    const second = test.settings.update({ sampleSize: 250 });
    expect(second).toEqual({ ...defaultSettings, theme: 'light', sampleSize: 250 });
    expect(test.settings.get()).toEqual(second);
  });

  it('rejects a patch that fails the schema with VALIDATION', () => {
    test = openTestStore();
    expect(codeOf(() => test.settings.update({ theme: 'neon' as unknown as 'dark' }))).toBe(
      'VALIDATION',
    );
    expect(test.settings.get()).toEqual(defaultSettings);
  });
});
