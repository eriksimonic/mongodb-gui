import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PREFERENCES,
  parseCachedPreferences,
  readCachedPreferences,
  writeCachedPreferences,
} from './preferences-cache';

/** A Storage stand-in with an in-memory map. */
function memoryStorage(initial: Record<string, string> = {}): Storage {
  const values = new Map(Object.entries(initial));
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    key: (index: number) => [...values.keys()][index] ?? null,
    removeItem: (key: string) => {
      values.delete(key);
    },
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}

describe('preferences cache', () => {
  it('returns the defaults when nothing is cached', () => {
    expect(readCachedPreferences(memoryStorage())).toEqual(DEFAULT_PREFERENCES);
  });

  it('writes and reads back the theme and idle lock minutes', () => {
    const storage = memoryStorage();
    writeCachedPreferences({ theme: 'light', idleLockMinutes: 5 }, storage);
    expect(readCachedPreferences(storage)).toEqual({ theme: 'light', idleLockMinutes: 5 });
  });

  it('returns the defaults for corrupt JSON', () => {
    expect(readCachedPreferences(memoryStorage({ 'mongo-gui:preferences': '{not json' }))).toEqual(
      DEFAULT_PREFERENCES,
    );
  });

  it('keeps usable fields and fills the others from the defaults', () => {
    expect(parseCachedPreferences({ theme: 'neon', idleLockMinutes: 5 })).toEqual({
      theme: 'dark',
      idleLockMinutes: 5,
    });
    expect(parseCachedPreferences({ theme: 'system', idleLockMinutes: 99999 })).toEqual({
      theme: 'system',
      idleLockMinutes: DEFAULT_PREFERENCES.idleLockMinutes,
    });
    expect(parseCachedPreferences('not an object')).toEqual(DEFAULT_PREFERENCES);
  });

  it('does not throw when storage is missing or blocked', () => {
    const blocked = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    } as unknown as Storage;
    expect(readCachedPreferences(blocked)).toEqual(DEFAULT_PREFERENCES);
    expect(() => {
      writeCachedPreferences(DEFAULT_PREFERENCES, blocked);
    }).not.toThrow();
    expect(readCachedPreferences(undefined)).toEqual(DEFAULT_PREFERENCES);
  });
});
