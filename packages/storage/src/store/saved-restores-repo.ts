import {
  AppErrorException,
  SavedRestoreInputSchema,
  SavedRestoreNameSchema,
  SavedRestoreSchema,
  appError,
  newId,
  type SavedRestore,
  type SavedRestoreInput,
} from '@mongo-gui/core';
import type { EncryptedStore } from './encrypted-store';
import { blobColumn, textColumn } from './columns';
import { parseInput } from './validation';

/** Restore configurations saved to run again. The payload is encrypted like every other row. */
export class SavedRestoresRepository {
  readonly #store: EncryptedStore;

  constructor(store: EncryptedStore) {
    this.#store = store;
  }

  list(): SavedRestore[] {
    this.#store.assertUnlocked();
    return this.#store.db
      .prepare('SELECT id, payload FROM saved_restores ORDER BY created_at ASC, rowid ASC')
      .all()
      .map((row) => this.#decrypt(row));
  }

  save(input: SavedRestoreInput): SavedRestore {
    this.#store.assertUnlocked();
    const data = parseInput(SavedRestoreInputSchema, input, 'saved restore');
    const connectionExists =
      this.#store.db.prepare('SELECT 1 FROM connections WHERE id = ?').get(data.connectionId) !==
      undefined;
    if (!connectionExists) {
      throw new AppErrorException(
        appError('CONNECTION_NOT_FOUND', 'The connection was not found.'),
      );
    }
    const saved: SavedRestore = { ...data, id: newId(), createdAt: new Date().toISOString() };
    this.#store.db
      .prepare(
        'INSERT INTO saved_restores (id, connection_id, created_at, payload) VALUES (?, ?, ?, ?)',
      )
      .run(
        saved.id,
        saved.connectionId,
        saved.createdAt,
        this.#store.encryptPayload('saved_restores', saved.id, saved),
      );
    return saved;
  }

  rename(id: string, name: string): SavedRestore {
    this.#store.assertUnlocked();
    const row = this.#store.db
      .prepare('SELECT id, payload FROM saved_restores WHERE id = ?')
      .get(id);
    if (row === undefined) {
      throw new AppErrorException(appError('NOT_FOUND', 'The saved restore was not found.'));
    }
    const renamed: SavedRestore = {
      ...this.#decrypt(row),
      name: parseInput(SavedRestoreNameSchema, name, 'saved restore name'),
    };
    this.#store.db
      .prepare('UPDATE saved_restores SET payload = ? WHERE id = ?')
      .run(this.#store.encryptPayload('saved_restores', id, renamed), id);
    return renamed;
  }

  /** Removing an id that does not exist is not an error. */
  remove(id: string): void {
    this.#store.assertUnlocked();
    this.#store.db.prepare('DELETE FROM saved_restores WHERE id = ?').run(id);
  }

  #decrypt(row: Readonly<Record<string, unknown>>): SavedRestore {
    return this.#store.decryptPayload<SavedRestore>(
      'saved_restores',
      textColumn(row, 'id'),
      blobColumn(row, 'payload'),
      SavedRestoreSchema,
    );
  }
}
