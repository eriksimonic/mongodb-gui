import { describe, expect, it } from 'vitest';
import {
  BackupNameSchema,
  BackupScopeSchema,
  BackupStartInputSchema,
  DumpOptionsSchema,
  NamespaceSelectorSchema,
  RestoreOptionsSchema,
} from './options';

describe('BackupNameSchema', () => {
  it('accepts a plain name', () => {
    expect(BackupNameSchema.safeParse('shop-20261010-184200').success).toBe(true);
  });

  it.each([
    '',
    '.',
    '..',
    'a/b',
    'a\\b',
    'a:b',
    'a*b',
    'a?b',
    'a"b',
    'a<b',
    'a|b',
    'x.',
    'x ',
    'a\u0001b',
  ])('refuses %j', (name) => {
    expect(BackupNameSchema.safeParse(name).success).toBe(false);
  });

  it('refuses a name over 200 characters', () => {
    expect(BackupNameSchema.safeParse('a'.repeat(201)).success).toBe(false);
  });
});

describe('BackupScopeSchema', () => {
  it('accepts the four kinds', () => {
    expect(BackupScopeSchema.safeParse({ kind: 'server' }).success).toBe(true);
    expect(BackupScopeSchema.safeParse({ kind: 'database', database: 'shop' }).success).toBe(true);
    expect(
      BackupScopeSchema.safeParse({ kind: 'databases', databases: ['shop', 'blog'] }).success,
    ).toBe(true);
    expect(
      BackupScopeSchema.safeParse({ kind: 'collection', database: 'shop', collection: 'orders' })
        .success,
    ).toBe(true);
  });

  it('needs two databases for the databases kind', () => {
    expect(BackupScopeSchema.safeParse({ kind: 'databases', databases: ['shop'] }).success).toBe(
      false,
    );
  });
});

describe('DumpOptionsSchema', () => {
  it('fills the defaults', () => {
    expect(DumpOptionsSchema.parse({})).toEqual({
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
    });
  });

  it('refuses a parallel count of 0 or 17', () => {
    expect(DumpOptionsSchema.safeParse({ numParallelCollections: 0 }).success).toBe(false);
    expect(DumpOptionsSchema.safeParse({ numParallelCollections: 17 }).success).toBe(false);
  });
});

describe('BackupStartInputSchema', () => {
  const input = {
    connectionId: '6f1c1e0e-4f5b-4a53-9a39-1f2a3b4c5d6e',
    scope: { kind: 'server' },
    options: {},
    folder: '/backups',
    name: 'shop',
    toolsVersion: '100.19.1',
  };

  it('parses and defaults acknowledged', () => {
    const parsed = BackupStartInputSchema.parse(input);
    expect(parsed.acknowledged).toEqual([]);
    expect(parsed.options.output).toBe('archive');
  });

  it('refuses a relative folder', () => {
    expect(BackupStartInputSchema.safeParse({ ...input, folder: 'backups' }).success).toBe(false);
  });
});

describe('RestoreOptionsSchema', () => {
  it('fills the defaults', () => {
    const options = RestoreOptionsSchema.parse({});
    expect(options.writeConcern).toBe('majority');
    expect(options.verifyChecksum).toBe(true);
    expect(options.renames).toEqual([]);
    expect(options.include).toBeUndefined();
  });

  it('checks the oplog limit format', () => {
    expect(RestoreOptionsSchema.safeParse({ oplogLimit: '1700000000:1' }).success).toBe(true);
    expect(RestoreOptionsSchema.safeParse({ oplogLimit: 'soon' }).success).toBe(false);
  });
});

describe('NamespaceSelectorSchema', () => {
  it('accepts db.* and db.coll', () => {
    expect(NamespaceSelectorSchema.safeParse('shop.*').success).toBe(true);
    expect(NamespaceSelectorSchema.safeParse('shop.orders').success).toBe(true);
    expect(NamespaceSelectorSchema.safeParse('shop.system.views').success).toBe(true);
  });

  it('refuses a bare name', () => {
    expect(NamespaceSelectorSchema.safeParse('shop').success).toBe(false);
  });
});
