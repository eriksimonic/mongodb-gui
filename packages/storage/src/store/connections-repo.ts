import {
  AppErrorException,
  ConnectionProfileInputSchema,
  ConnectionProfileSchema,
  appError,
  newId,
  type ConnectionProfile,
  type ConnectionProfileInput,
} from '@mongo-gui/core';
import type { EncryptedStore } from './encrypted-store';
import { blobColumn, textColumn } from './columns';
import { parseInput } from './validation';

export class ConnectionsRepository {
  readonly #store: EncryptedStore;

  constructor(store: EncryptedStore) {
    this.#store = store;
  }

  list(): ConnectionProfile[] {
    this.#store.assertUnlocked();
    const rows = this.#store.db
      .prepare('SELECT id, payload FROM connections ORDER BY created_at ASC, id ASC')
      .all();
    return rows.map((row) => this.#decode(row));
  }

  get(id: string): ConnectionProfile {
    this.#store.assertUnlocked();
    return this.#load(id);
  }

  create(input: ConnectionProfileInput): ConnectionProfile {
    this.#store.assertUnlocked();
    const data = parseInput(ConnectionProfileInputSchema, input, 'connection');
    const now = new Date().toISOString();
    const profile: ConnectionProfile = { ...data, id: newId(), createdAt: now, updatedAt: now };
    this.#store.db
      .prepare('INSERT INTO connections (id, created_at, updated_at, payload) VALUES (?, ?, ?, ?)')
      .run(profile.id, now, now, this.#store.encryptPayload('connections', profile.id, profile));
    return profile;
  }

  update(id: string, patch: Partial<ConnectionProfileInput>): ConnectionProfile {
    this.#store.assertUnlocked();
    const existing = this.#load(id);
    const changes = parseInput(ConnectionProfileInputSchema.partial(), patch, 'connection patch');
    const now = new Date().toISOString();
    const updated = parseInput(
      ConnectionProfileSchema,
      { ...existing, ...changes, updatedAt: now },
      'connection',
    );
    this.#store.db
      .prepare('UPDATE connections SET updated_at = ?, payload = ? WHERE id = ?')
      .run(now, this.#store.encryptPayload('connections', id, updated), id);
    return updated;
  }

  remove(id: string): void {
    this.#store.assertUnlocked();
    const result = this.#store.db.prepare('DELETE FROM connections WHERE id = ?').run(id);
    if (result.changes === 0) {
      throw connectionNotFound();
    }
  }

  #load(id: string): ConnectionProfile {
    const row = this.#store.db.prepare('SELECT id, payload FROM connections WHERE id = ?').get(id);
    if (row === undefined) {
      throw connectionNotFound();
    }
    return this.#decode(row);
  }

  #decode(row: Readonly<Record<string, unknown>>): ConnectionProfile {
    const id = textColumn(row, 'id');
    return this.#store.decryptPayload<ConnectionProfile>(
      'connections',
      id,
      blobColumn(row, 'payload'),
      ConnectionProfileSchema,
    );
  }
}

function connectionNotFound(): AppErrorException {
  return new AppErrorException(appError('CONNECTION_NOT_FOUND', 'The connection was not found.'));
}
