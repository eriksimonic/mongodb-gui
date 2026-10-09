import { DatabaseSync } from 'node:sqlite';
import { AppErrorException } from '@mongo-gui/core';
import { describe, expect, it } from 'vitest';
import { applyMigrations, migrations } from './migrations';

function versions(db: DatabaseSync): number[] {
  return db
    .prepare('SELECT version FROM schema_version ORDER BY version')
    .all()
    .map((row) => Number(row['version']));
}

describe('applyMigrations', () => {
  it('applies every migration to an empty database', () => {
    const db = new DatabaseSync(':memory:');
    applyMigrations(db);
    expect(versions(db)).toEqual(migrations.map((migration) => migration.version));
    db.close();
  });

  it('applies only the migrations above the stored version', () => {
    const db = new DatabaseSync(':memory:');
    applyMigrations(db, [{ version: 1, sql: 'CREATE TABLE one (id INTEGER)' }]);
    applyMigrations(db, [
      { version: 1, sql: 'CREATE TABLE one (id INTEGER)' },
      { version: 2, sql: 'CREATE TABLE two (id INTEGER)' },
    ]);
    expect(versions(db)).toEqual([1, 2]);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'two'").get()).toBeDefined();
    db.close();
  });

  it('rolls back a failed migration and reports INTERNAL', () => {
    const db = new DatabaseSync(':memory:');
    applyMigrations(db, [{ version: 1, sql: 'CREATE TABLE one (id INTEGER)' }]);
    let caught: unknown;
    try {
      applyMigrations(db, [
        { version: 1, sql: 'CREATE TABLE one (id INTEGER)' },
        { version: 2, sql: 'CREATE TABLE two (id INTEGER); THIS IS NOT SQL;' },
      ]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AppErrorException);
    expect(caught).toMatchObject({ error: { code: 'INTERNAL' } });
    expect(versions(db)).toEqual([1]);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'two'").get()).toBeUndefined();
    db.close();
  });
});
