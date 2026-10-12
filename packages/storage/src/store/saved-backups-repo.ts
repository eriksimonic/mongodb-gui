import {
  AppErrorException,
  SavedBackupInputSchema,
  SavedBackupSchema,
  appError,
  newId,
  type SavedBackup,
  type SavedBackupInput,
} from '@mongo-gui/core';
import type { EncryptedStore } from './encrypted-store';
import { blobColumn, textColumn } from './columns';
import { parseInput } from './validation';

/** Backup configurations kept to run again. Deleting a connection deletes its rows. */
export class SavedBackupsRepository {
  readonly #store: EncryptedStore;

  constructor(store: EncryptedStore) {
    this.#store = store;
  }

  list(): SavedBackup[] {
    this.#store.assertUnlocked();
    return this.#store.db
      .prepare('SELECT id, payload FROM saved_backups ORDER BY created_at ASC, rowid ASC')
      .all()
      .map((row) =>
        this.#store.decryptPayload<SavedBackup>(
          'saved_backups',
          textColumn(row, 'id'),
          blobColumn(row, 'payload'),
          SavedBackupSchema,
        ),
      );
  }

  save(input: SavedBackupInput): SavedBackup {
    this.#store.assertUnlocked();
    const data = parseInput(SavedBackupInputSchema, input, 'saved backup');
    const connection = this.#store.db
      .prepare('SELECT 1 FROM connections WHERE id = ?')
      .get(data.connectionId);
    if (connection === undefined) {
      throw new AppErrorException(
        appError('CONNECTION_NOT_FOUND', 'The connection was not found.'),
      );
    }
    const saved: SavedBackup = { ...data, id: newId(), createdAt: new Date().toISOString() };
    this.#store.db
      .prepare(
        'INSERT INTO saved_backups (id, connection_id, created_at, payload) VALUES (?, ?, ?, ?)',
      )
      .run(
        saved.id,
        saved.connectionId,
        saved.createdAt,
        this.#store.encryptPayload('saved_backups', saved.id, saved),
      );
    return saved;
  }

  rename(id: string, label: string): SavedBackup {
    this.#store.assertUnlocked();
    const row = this.#store.db
      .prepare('SELECT id, payload FROM saved_backups WHERE id = ?')
      .get(id);
    if (row === undefined) {
      throw new AppErrorException(appError('VALIDATION', 'The saved backup was not found.'));
    }
    const existing = this.#store.decryptPayload<SavedBackup>(
      'saved_backups',
      id,
      blobColumn(row, 'payload'),
      SavedBackupSchema,
    );
    const renamed = parseInput(SavedBackupSchema, { ...existing, label }, 'saved backup');
    this.#store.db
      .prepare('UPDATE saved_backups SET payload = ? WHERE id = ?')
      .run(this.#store.encryptPayload('saved_backups', id, renamed), id);
    return renamed;
  }

  /** Removing an id that does not exist is not an error. */
  remove(id: string): void {
    this.#store.assertUnlocked();
    this.#store.db.prepare('DELETE FROM saved_backups WHERE id = ?').run(id);
  }
}
