import {
  SettingsPatchSchema,
  SettingsSchema,
  defaultSettings,
  type Settings,
  type SettingsPatch,
} from '@mongo-gui/core';
import type { EncryptedStore } from './encrypted-store';
import { blobColumn } from './columns';
import { parseInput, parseStored, type PayloadSchema } from './validation';

const SETTINGS_KEY = 'app';

/**
 * Stores only the fields the user changed. Unset fields come from defaultSettings, so a
 * change to a default reaches users who never touched that field.
 */
export class SettingsRepository {
  readonly #store: EncryptedStore;

  constructor(store: EncryptedStore) {
    this.#store = store;
  }

  get(): Settings {
    this.#store.assertUnlocked();
    return parseStored(SettingsSchema, { ...defaultSettings, ...this.#readPatch() }, 'settings');
  }

  update(patch: SettingsPatch): Settings {
    this.#store.assertUnlocked();
    const changes = parseInput(SettingsPatchSchema, patch, 'settings patch');
    const merged = { ...this.#readPatch(), ...changes };
    this.#store.db
      .prepare(
        'INSERT INTO settings (key, payload) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET payload = excluded.payload',
      )
      .run(SETTINGS_KEY, this.#store.encryptPayload('settings', SETTINGS_KEY, merged));
    return this.get();
  }

  #readPatch(): SettingsPatch {
    const row = this.#store.db
      .prepare('SELECT payload FROM settings WHERE key = ?')
      .get(SETTINGS_KEY);
    if (row === undefined) {
      return {};
    }
    const stored = this.#store.decryptPayload(
      'settings',
      SETTINGS_KEY,
      blobColumn(row, 'payload'),
      ANY_OBJECT,
    );
    return keepValidFields(stored);
  }
}

const ANY_OBJECT: PayloadSchema<Record<string, unknown>> = {
  safeParse: (data) =>
    typeof data === 'object' && data !== null && !Array.isArray(data)
      ? { success: true, data: data as Record<string, unknown> }
      : { success: false },
};

const PATCH_KEYS = Object.keys(SettingsPatchSchema.shape) as (keyof SettingsPatch)[];

/**
 * Keeps each stored field that still passes the current schema and drops the rest. The
 * dropped fields fall back to defaultSettings, so a schema change can never make settings
 * unreadable.
 */
function keepValidFields(stored: Record<string, unknown>): SettingsPatch {
  const kept: Record<string, unknown> = {};
  for (const key of PATCH_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(stored, key)) {
      continue;
    }
    const result = SettingsPatchSchema.shape[key].safeParse(stored[key]);
    if (result.success) {
      kept[key] = result.data;
    }
  }
  return kept as SettingsPatch;
}
