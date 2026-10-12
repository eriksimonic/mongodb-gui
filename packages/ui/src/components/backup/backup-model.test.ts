import { describe, expect, it } from 'vitest';
import {
  backupProblemsOf,
  backupStartInput,
  DEFAULT_BACKUP_DRAFT,
  defaultReadPreference,
  draftForTarget,
  draftFromSaved,
  outputPreview,
  savedBackupInput,
  scopeOf,
  type BackupDraft,
} from './backup-model';

const NOW = new Date(2026, 9, 10, 18, 42, 0);
const ID = '3f2b8c1e-6a4d-4f0e-9d57-0a1b2c3d4e5f';
const READY: BackupDraft = {
  ...DEFAULT_BACKUP_DRAFT,
  folder: '/backups',
  name: 'shop',
  toolsVersion: '100.9.4',
};

describe('backup model', () => {
  it('builds a draft for each entry point', () => {
    const server = draftForTarget({ connectionName: 'Local', now: NOW });
    expect(server.name).toBe('Local-all-20261010-184200');
    expect(scopeOf(server)).toEqual({ kind: 'server' });

    const database = draftForTarget({ connectionName: 'Local', database: 'shop', now: NOW });
    expect(database.name).toBe('Local-shop-20261010-184200');
    expect(scopeOf(database)).toEqual({ kind: 'database', database: 'shop' });

    const collection = draftForTarget({
      connectionName: 'Local',
      database: 'shop',
      collection: 'orders',
      now: NOW,
    });
    expect(collection.name).toBe('Local-shop-orders-20261010-184200');
    expect(scopeOf(collection)).toEqual({
      kind: 'collection',
      database: 'shop',
      collection: 'orders',
    });
  });

  it('maps the picked databases to a scope', () => {
    expect(scopeOf({ ...READY, databases: ['a', 'b'] })).toEqual({
      kind: 'databases',
      databases: ['a', 'b'],
    });
    expect(scopeOf({ ...READY, target: 'collection' })).toBeUndefined();
    expect(scopeOf({ ...READY, target: 'collection', databases: ['a'] })).toBeUndefined();
  });

  it('picks the default read preference', () => {
    const connected = {
      state: 'connected' as const,
      serverVersion: '7.0.0',
      topology: 'standalone' as const,
      hosts: [],
    };
    expect(defaultReadPreference(connected, 'nearest')).toBe('nearest');
    expect(defaultReadPreference({ ...connected, directConnection: true }, undefined)).toBe(
      'primaryPreferred',
    );
    expect(defaultReadPreference(connected, undefined)).toBe('primary');
    expect(defaultReadPreference(undefined, undefined)).toBe('primary');
    expect(defaultReadPreference({ state: 'disconnected' }, undefined)).toBe('primary');
  });

  it('accepts a complete draft', () => {
    expect(backupProblemsOf(READY)).toEqual([]);
  });

  it('asks for a folder and a name', () => {
    const problems = backupProblemsOf({ ...READY, folder: ' ', name: '' });
    expect(problems.map((problem) => problem.field)).toEqual(['folder', 'name']);
  });

  it('refuses a name that is not one path segment', () => {
    expect(backupProblemsOf({ ...READY, name: 'a/b' })[0]?.field).toBe('name');
    expect(backupProblemsOf({ ...READY, name: 'dump.' })[0]?.field).toBe('name');
  });

  it('needs a database and a collection for the collection target', () => {
    const problems = backupProblemsOf({ ...READY, target: 'collection', query: '{"a": 1}' });
    expect(problems).toEqual([
      { field: 'scope', message: 'Choose the database of the collection' },
    ]);
    const noCollection = backupProblemsOf({ ...READY, target: 'collection', databases: ['shop'] });
    expect(noCollection[0]?.message).toBe('Choose the collection to back up');
  });

  it('checks the query once', () => {
    const collection: BackupDraft = {
      ...READY,
      target: 'collection',
      databases: ['shop'],
      collection: 'orders',
    };
    expect(backupProblemsOf({ ...collection, query: '{"paid": true}' })).toEqual([]);
    const bad = backupProblemsOf({ ...collection, query: 'ObjectId(1)' });
    expect(bad).toHaveLength(1);
    expect(bad[0]?.field).toBe('query');
    expect(backupProblemsOf({ ...collection, query: '[1]' })[0]?.message).toBe(
      'The query must be a JSON object',
    );
    expect(backupProblemsOf({ ...READY, query: '{"a": 1}' })[0]?.field).toBe('query');
  });

  it('applies the core option checks', () => {
    const several = backupProblemsOf({ ...READY, databases: ['a', 'b'] });
    expect(several).toEqual([
      { field: 'output', message: 'Several databases need the folder format.' },
    ]);
    expect(backupProblemsOf({ ...READY, databases: ['a', 'b'], output: 'directory' })).toEqual([]);

    expect(backupProblemsOf({ ...READY, oplog: true }, { topology: 'standalone' })[0]?.field).toBe(
      'oplog',
    );
    expect(backupProblemsOf({ ...READY, oplog: true }, { topology: 'replicaSet' })).toEqual([]);
    expect(backupProblemsOf({ ...READY, excludePrefixes: ['tmp_'] })[0]?.field).toBe(
      'excludeCollectionsWithPrefix',
    );
    expect(
      backupProblemsOf({ ...READY, databases: ['admin'], dumpDbUsersAndRoles: true })[0]?.field,
    ).toBe('dumpDbUsersAndRoles');
  });

  it('refuses parallel collections outside 1 to 16', () => {
    expect(backupProblemsOf({ ...READY, numParallelCollections: 0 })[0]?.field).toBe(
      'numParallelCollections',
    );
    expect(backupProblemsOf({ ...READY, numParallelCollections: 17 })).toHaveLength(1);
  });

  it('builds the start input and leaves empty options out', () => {
    expect(backupStartInput(READY, ID)).toEqual({
      connectionId: ID,
      scope: { kind: 'server' },
      options: {
        output: 'archive',
        gzip: true,
        excludeCollections: [],
        excludeCollectionsWithPrefix: [],
        oplog: false,
        dumpDbUsersAndRoles: false,
        viewsAsCollections: false,
        forceTableScan: false,
        numParallelCollections: 4,
        compressors: [],
      },
      folder: '/backups',
      name: 'shop',
      toolsVersion: '100.9.4',
      acknowledged: [],
    });
  });

  it('passes the scope, read preference, query and acknowledgements', () => {
    const input = backupStartInput(
      {
        ...READY,
        target: 'collection',
        databases: ['shop'],
        collection: 'orders',
        query: ' {"a": 1} ',
        readPreference: 'secondary',
        compressors: ['zstd'],
        folder: ' /backups ',
      },
      ID,
      ['tools-patch-differs'],
    );
    expect(input.scope).toEqual({ kind: 'collection', database: 'shop', collection: 'orders' });
    expect(input.options.query).toBe('{"a": 1}');
    expect(input.options.readPreference).toBe('secondary');
    expect(input.options.compressors).toEqual(['zstd']);
    expect(input.folder).toBe('/backups');
    expect(input.acknowledged).toEqual(['tools-patch-differs']);
  });

  it('previews the output and sidecar paths', () => {
    expect(outputPreview(READY)).toEqual({
      outputPath: '/backups/shop.archive.gz',
      sidecarPath: '/backups/shop.archive.gz.json',
    });
    expect(outputPreview({ ...READY, gzip: false })?.outputPath).toBe('/backups/shop.archive');
    expect(outputPreview({ ...READY, output: 'directory', folder: '/backups/' })).toEqual({
      outputPath: '/backups/shop',
      sidecarPath: '/backups/shop/mongo-gui-backup.json',
    });
    expect(outputPreview({ ...READY, folder: 'C:\\Backups' })?.outputPath).toBe(
      'C:\\Backups\\shop.archive.gz',
    );
    expect(outputPreview({ ...READY, folder: '' })).toBeUndefined();
  });
});

describe('saved backups', () => {
  it('round trips a draft through a saved configuration and keeps the folder and name', () => {
    const draft: BackupDraft = {
      ...READY,
      databases: ['shop', 'blog'],
      excludeCollections: ['logs'],
      excludePrefixes: ['tmp_'],
      output: 'directory',
      gzip: false,
      readPreference: 'secondary',
      numParallelCollections: 2,
      compressors: ['zstd'],
    };
    const input = savedBackupInput(draft, ID, '  Nightly ');
    expect(input).toMatchObject({
      label: 'Nightly',
      connectionId: ID,
      scope: { kind: 'databases', databases: ['shop', 'blog'] },
      toolsVersion: '100.9.4',
    });
    const saved = { ...input, id: ID, createdAt: '2026-10-10T18:42:00.000Z' };
    const other: BackupDraft = { ...DEFAULT_BACKUP_DRAFT, folder: '/elsewhere', name: 'other' };
    expect(draftFromSaved(other, saved)).toEqual({
      ...draft,
      folder: '/elsewhere',
      name: 'other',
    });
  });

  it('round trips a collection target with a query', () => {
    const draft: BackupDraft = {
      ...READY,
      target: 'collection',
      databases: ['shop'],
      collection: 'orders',
      query: '{"status":"paid"}',
    };
    const input = savedBackupInput(draft, ID, 'Paid');
    expect(input.scope).toEqual({ kind: 'collection', database: 'shop', collection: 'orders' });
    expect(
      draftFromSaved(READY, { ...input, id: ID, createdAt: '2026-10-10T18:42:00.000Z' }),
    ).toEqual(draft);
  });

  it('leaves out an unset tools version and keeps the current one on load', () => {
    const input = savedBackupInput({ ...READY, toolsVersion: '' }, ID, 'x');
    expect(input.toolsVersion).toBeUndefined();
    const saved = { ...input, id: ID, createdAt: '2026-10-10T18:42:00.000Z' };
    expect(draftFromSaved(READY, saved).toolsVersion).toBe('100.9.4');
  });
});
