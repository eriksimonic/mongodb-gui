import { AppErrorException, appError } from '@mongo-gui/core';
import type { EncryptedStore } from './encrypted-store';
import { blobColumn } from './columns';
import type { PayloadSchema } from './validation';

/** Layout values have no core schema, so any JSON value is accepted on read. */
const anyJson: PayloadSchema<unknown> = {
  safeParse: (data) => ({ success: true, data }),
};

export class LayoutRepository {
  readonly #store: EncryptedStore;

  constructor(store: EncryptedStore) {
    this.#store = store;
  }

  get(key: string): unknown | undefined {
    this.#store.assertUnlocked();
    const row = this.#store.db.prepare('SELECT payload FROM layout WHERE key = ?').get(key);
    if (row === undefined) {
      return undefined;
    }
    return this.#store.decryptPayload('layout', key, blobColumn(row, 'payload'), anyJson);
  }

  set(key: string, value: unknown): void {
    this.#store.assertUnlocked();
    if (key.length === 0) {
      throw new AppErrorException(appError('VALIDATION', 'The layout key must not be empty.'));
    }
    if (value === undefined) {
      throw new AppErrorException(
        appError('VALIDATION', 'The layout value must not be undefined.'),
      );
    }
    this.#store.db
      .prepare(
        'INSERT INTO layout (key, payload) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET payload = excluded.payload',
      )
      .run(key, this.#store.encryptPayload('layout', key, value));
  }
}
