import type { SQLInputValue } from 'node:sqlite';
import {
  AppErrorException,
  HistoryEntrySchema,
  appError,
  newId,
  type HistoryEntry,
} from '@mongo-gui/core';
import type { EncryptedStore } from './encrypted-store';
import type { SettingsRepository } from './settings-repo';
import { blobColumn, textColumn } from './columns';
import { parseInput } from './validation';

export type HistoryAppendInput = Omit<HistoryEntry, 'id'>;

export interface HistoryListQuery {
  readonly connectionId?: string | undefined;
  /** Case-insensitive substring matched against the decrypted code. */
  readonly search?: string | undefined;
  readonly limit?: number | undefined;
}

const HistoryAppendSchema = HistoryEntrySchema.omit({ id: true });

export class HistoryRepository {
  readonly #store: EncryptedStore;
  readonly #settings: SettingsRepository;

  constructor(store: EncryptedStore, settings: SettingsRepository) {
    this.#store = store;
    this.#settings = settings;
  }

  /** Stores an entry and prunes the oldest rows beyond the historyLimit setting. */
  append(input: HistoryAppendInput): HistoryEntry {
    this.#store.assertUnlocked();
    const data = parseInput(HistoryAppendSchema, input, 'history entry');
    const connectionExists =
      this.#store.db.prepare('SELECT 1 FROM connections WHERE id = ?').get(data.connectionId) !==
      undefined;
    if (!connectionExists) {
      throw new AppErrorException(
        appError('CONNECTION_NOT_FOUND', 'The connection was not found.'),
      );
    }
    const entry: HistoryEntry = {
      ...data,
      id: newId(),
      startedAt: new Date(data.startedAt).toISOString(),
    };
    this.#store.db
      .prepare('INSERT INTO history (id, connection_id, started_at, payload) VALUES (?, ?, ?, ?)')
      .run(
        entry.id,
        entry.connectionId,
        entry.startedAt,
        this.#store.encryptPayload('history', entry.id, entry),
      );
    const limit = this.#settings.get().historyLimit;
    if (this.#count() > limit) {
      this.prune(limit);
    }
    return entry;
  }

  /** Newest first. The search filter runs in memory after decryption. */
  list(query: HistoryListQuery = {}): HistoryEntry[] {
    this.#store.assertUnlocked();
    const { connectionId, search, limit } = query;
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) {
      throw new AppErrorException(appError('VALIDATION', 'The history limit must be positive.'));
    }
    const params: SQLInputValue[] = [];
    let sql = 'SELECT id, payload FROM history';
    if (connectionId !== undefined) {
      sql += ' WHERE connection_id = ?';
      params.push(connectionId);
    }
    sql += ' ORDER BY started_at DESC, rowid DESC';
    if (search === undefined && limit !== undefined) {
      sql += ' LIMIT ?';
      params.push(limit);
    }
    let entries = this.#store.db
      .prepare(sql)
      .all(...params)
      .map((row) => this.#decode(row));
    if (search !== undefined) {
      const needle = search.toLowerCase();
      entries = entries.filter((entry) => entry.code.toLowerCase().includes(needle));
    }
    return limit === undefined ? entries : entries.slice(0, limit);
  }

  clear(): void {
    this.#store.assertUnlocked();
    this.#store.db.exec('DELETE FROM history');
  }

  /** Deletes the oldest rows so that at most `limit` remain. Returns the number deleted. */
  prune(limit: number): number {
    this.#store.assertUnlocked();
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new AppErrorException(appError('VALIDATION', 'The history limit must be positive.'));
    }
    const result = this.#store.db
      .prepare(
        'DELETE FROM history WHERE rowid NOT IN (SELECT rowid FROM history ORDER BY started_at DESC, rowid DESC LIMIT ?)',
      )
      .run(limit);
    return Number(result.changes);
  }

  #count(): number {
    const row = this.#store.db.prepare('SELECT count(*) AS count FROM history').get();
    const count = row?.['count'];
    return typeof count === 'number' ? count : 0;
  }

  #decode(row: Readonly<Record<string, unknown>>): HistoryEntry {
    return this.#store.decryptPayload<HistoryEntry>(
      'history',
      textColumn(row, 'id'),
      blobColumn(row, 'payload'),
      HistoryEntrySchema,
    );
  }
}
