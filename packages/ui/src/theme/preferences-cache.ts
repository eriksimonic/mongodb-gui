import type { ThemeSetting } from './color-scheme';

/**
 * Per-viewer copy of the two settings the locked screens need: the theme and the idle lock
 * minutes. The encrypted settings cannot be read before unlock, so this copy keeps the unlock
 * screen in the chosen theme. Browser storage can be missing or blocked, so every access is guarded.
 */
export interface CachedPreferences {
  readonly theme: ThemeSetting;
  readonly idleLockMinutes: number;
}

export const DEFAULT_PREFERENCES: CachedPreferences = { theme: 'dark', idleLockMinutes: 30 };

const CACHE_KEY = 'mongo-gui:preferences';
const THEMES: readonly ThemeSetting[] = ['dark', 'light', 'system'];

export function readCachedPreferences(
  storage: Storage | undefined = defaultStorage(),
): CachedPreferences {
  try {
    const raw = storage?.getItem(CACHE_KEY);
    if (raw === null || raw === undefined || raw === '') {
      return DEFAULT_PREFERENCES;
    }
    return parseCachedPreferences(JSON.parse(raw) as unknown);
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

export function writeCachedPreferences(
  preferences: CachedPreferences,
  storage: Storage | undefined = defaultStorage(),
): void {
  try {
    storage?.setItem(CACHE_KEY, JSON.stringify(preferences));
  } catch {
    // Storage is full or blocked. The app works without the copy.
  }
}

/** Keeps the fields that have a usable value and fills the rest from the defaults. */
export function parseCachedPreferences(value: unknown): CachedPreferences {
  if (typeof value !== 'object' || value === null) {
    return DEFAULT_PREFERENCES;
  }
  const record = value as Record<string, unknown>;
  const theme = THEMES.find((candidate) => candidate === record['theme']);
  const minutes = record['idleLockMinutes'];
  return {
    theme: theme ?? DEFAULT_PREFERENCES.theme,
    idleLockMinutes:
      typeof minutes === 'number' && Number.isInteger(minutes) && minutes >= 1 && minutes <= 1440
        ? minutes
        : DEFAULT_PREFERENCES.idleLockMinutes,
  };
}

function defaultStorage(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
}
