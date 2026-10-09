import type { DatabaseSync } from 'node:sqlite';
import { AppErrorException, appError } from '@mongo-gui/core';

export interface Migration {
  readonly version: number;
  readonly sql: string;
}

/**
 * Schema versions in order. Payload columns hold ciphertext. Structural columns
 * (ids, timestamps, foreign keys) stay in clear text so the store can index and join.
 */
export const migrations: readonly Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE connections (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        payload BLOB NOT NULL
      );
      CREATE TABLE history (
        id TEXT PRIMARY KEY,
        connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
        started_at TEXT NOT NULL,
        payload BLOB NOT NULL
      );
      CREATE INDEX history_connection_started ON history (connection_id, started_at);
      CREATE TABLE favourites (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        payload BLOB NOT NULL
      );
      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        payload BLOB NOT NULL
      );
      CREATE TABLE layout (
        key TEXT PRIMARY KEY,
        payload BLOB NOT NULL
      );
    `,
  },
];

/**
 * Applies each migration whose version is above the stored schema version. Each migration
 * runs in its own transaction, so a failed migration leaves the previous version intact.
 */
export function applyMigrations(
  db: DatabaseSync,
  available: readonly Migration[] = migrations,
): void {
  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)',
  );
  for (const migration of available) {
    db.exec('BEGIN IMMEDIATE');
    try {
      if (migration.version > currentSchemaVersion(db)) {
        db.exec(migration.sql);
        db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(
          migration.version,
          new Date().toISOString(),
        );
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw new AppErrorException(
        appError(
          'INTERNAL',
          `The store migration to version ${migration.version} failed.`,
          error instanceof Error ? error.message : undefined,
        ),
      );
    }
  }
}

function currentSchemaVersion(db: DatabaseSync): number {
  const row = db.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_version').get();
  const version = row?.['version'];
  return typeof version === 'number' ? version : 0;
}
