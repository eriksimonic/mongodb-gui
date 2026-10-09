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

/** Writes a payload straight to the settings row, bypassing the repository's validation. */
function writeRawSettings(payload: unknown): void {
  test.store.db
    .prepare(
      'INSERT INTO settings (key, payload) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET payload = excluded.payload',
    )
    .run('app', test.store.encryptPayload('settings', 'app', payload));
}

describe('SettingsRepository.get with invalid stored fields', () => {
  it('falls back to the default for an out-of-range stored idle lock and keeps valid fields', () => {
    test = openTestStore();
    writeRawSettings({ idleLockMinutes: 1e15, theme: 'light' });
    expect(test.settings.get()).toEqual({ ...defaultSettings, theme: 'light' });
  });

  it('falls back to the default for a field with the wrong type', () => {
    test = openTestStore();
    writeRawSettings({ sampleSize: 'many' });
    expect(test.settings.get()).toEqual(defaultSettings);
  });

  it('drops the invalid field on the next update, so the stored row heals', () => {
    test = openTestStore();
    writeRawSettings({ idleLockMinutes: 1e15, theme: 'light' });
    expect(test.settings.update({ sampleSize: 250 })).toEqual({
      ...defaultSettings,
      theme: 'light',
      sampleSize: 250,
    });
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
