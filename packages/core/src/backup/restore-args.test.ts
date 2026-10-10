import { describe, expect, it } from 'vitest';
import { RestoreOptionsSchema } from './options';
import { applyRenames, escapeNamespacePart, restoreArgs } from './restore-args';

const CONFIG = '/data/tmp/tools-1/config.yaml';
const ARCHIVE = { kind: 'archive', gzip: true } as const;
const TAIL = ['--numParallelCollections=4', '--numInsertionWorkersPerCollection=1'];

describe('restoreArgs', () => {
  it('reads an archive from stdin', () => {
    expect(
      restoreArgs({
        configPath: CONFIG,
        source: '/backups/shop.archive.gz',
        inspection: ARCHIVE,
        options: RestoreOptionsSchema.parse({}),
      }),
    ).toEqual([`--config=${CONFIG}`, '--archive', '--gzip', ...TAIL]);
  });

  it('restores a dump root folder', () => {
    expect(
      restoreArgs({
        configPath: CONFIG,
        source: '/backups/my dump',
        inspection: { kind: 'directory', layout: 'root', gzip: false },
        options: RestoreOptionsSchema.parse({}),
      }),
    ).toEqual([`--config=${CONFIG}`, '--dir=/backups/my dump', ...TAIL]);
  });

  it('restores a database folder through its parent and never passes --db', () => {
    const args = restoreArgs({
      configPath: CONFIG,
      source: '/backups/dump/sh*p/',
      inspection: { kind: 'directory', layout: 'database', gzip: true },
      options: RestoreOptionsSchema.parse({}),
    });
    expect(args).toEqual([
      `--config=${CONFIG}`,
      '--dir=/backups/dump',
      '--nsInclude=sh\\*p.*',
      '--gzip',
      ...TAIL,
    ]);
    expect(args.some((arg) => arg.startsWith('--db'))).toBe(false);
  });

  it('splits a Windows database folder', () => {
    const args = restoreArgs({
      configPath: CONFIG,
      source: 'C:\\backups\\shop',
      inspection: { kind: 'directory', layout: 'database', gzip: false },
      options: RestoreOptionsSchema.parse({}),
    });
    expect(args.slice(1, 3)).toEqual(['--dir=C:\\backups', '--nsInclude=shop.*']);
  });

  it('uses the selectors instead of the database folder when include is set', () => {
    const args = restoreArgs({
      configPath: CONFIG,
      source: '/backups/dump/shop',
      inspection: { kind: 'directory', layout: 'database', gzip: false },
      options: RestoreOptionsSchema.parse({ include: ['shop.orders'] }),
    });
    expect(args.filter((arg) => arg.startsWith('--nsInclude'))).toEqual([
      '--nsInclude=shop.orders',
    ]);
  });

  it('passes every flag, escapes names and skips no-op renames', () => {
    const options = RestoreOptionsSchema.parse({
      include: ['sh*p.*', 'blog.a.b*c', 'blog.x$y\\z'],
      renames: [
        { from: 'sh*p', to: 'shop_copy' },
        { from: 'blog', to: 'blog' },
      ],
      drop: true,
      dryRun: true,
      oplogReplay: true,
      oplogLimit: '1700000000:1',
      restoreDbUsersAndRoles: true,
      preserveUUID: true,
      noIndexRestore: true,
      noOptionsRestore: true,
      convertLegacyIndexes: true,
      maintainInsertionOrder: true,
      stopOnError: true,
      bypassDocumentValidation: true,
      objcheck: true,
      writeConcern: '1',
      numParallelCollections: 2,
      numInsertionWorkersPerCollection: 3,
    });
    expect(
      restoreArgs({ configPath: CONFIG, source: '/b.archive', inspection: ARCHIVE, options }),
    ).toEqual([
      `--config=${CONFIG}`,
      '--archive',
      '--gzip',
      '--nsInclude=sh\\*p.*',
      '--nsInclude=blog.a.b\\*c',
      '--nsInclude=blog.x\\$y\\\\z',
      '--nsFrom=sh\\*p.*',
      '--nsTo=shop_copy.*',
      '--drop',
      '--dryRun',
      '-v',
      '--oplogReplay',
      '--oplogLimit=1700000000:1',
      '--restoreDbUsersAndRoles',
      '--preserveUUID',
      '--noIndexRestore',
      '--noOptionsRestore',
      '--convertLegacyIndexes',
      '--maintainInsertionOrder',
      '--stopOnError',
      '--bypassDocumentValidation',
      '--objcheck',
      '--writeConcern=1',
      '--numParallelCollections=2',
      '--numInsertionWorkersPerCollection=3',
    ]);
  });

  it('omits writeConcern for majority', () => {
    const args = restoreArgs({
      configPath: CONFIG,
      source: '/b.archive',
      inspection: ARCHIVE,
      options: RestoreOptionsSchema.parse({ writeConcern: 'majority' }),
    });
    expect(args.some((arg) => arg.startsWith('--writeConcern'))).toBe(false);
  });
});

describe('escapeNamespacePart', () => {
  it('escapes backslash, star and dollar', () => {
    expect(escapeNamespacePart('a\\b*c$d')).toBe('a\\\\b\\*c\\$d');
    expect(escapeNamespacePart('plain')).toBe('plain');
  });
});

describe('applyRenames', () => {
  const renames = [{ from: 'shop', to: 'shop_copy' }];

  it('renames the database of a namespace', () => {
    expect(applyRenames('shop.orders.archive', renames)).toBe('shop_copy.orders.archive');
  });

  it('leaves other databases alone', () => {
    expect(applyRenames('shopping.orders', renames)).toBe('shopping.orders');
    expect(applyRenames('blog.posts', [])).toBe('blog.posts');
  });
});
