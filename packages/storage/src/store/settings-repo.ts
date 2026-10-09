import {
  SettingsPatchSchema,
  SettingsSchema,
  defaultSettings,
  type Settings,
  type SettingsPatch,
} from '@mongo-gui/core';
import type { EncryptedStore } from './encrypted-store';
import { blobColumn } from './columns';
import { parseInput, parseStored } from './validation';

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
    return this.#store.decryptPayload<SettingsPatch>(
      'settings',
      SETTINGS_KEY,
      blobColumn(row, 'payload'),
      SettingsPatchSchema,
    );
  }
}
