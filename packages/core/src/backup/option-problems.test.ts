import { describe, expect, it } from 'vitest';
import {
  dumpOptionProblems,
  normaliseRestoreOptions,
  restoreOptionProblems,
} from './option-problems';
import {
  BackupStartInputSchema,
  DumpOptionsSchema,
  RestoreOptionsSchema,
  type BackupScope,
  type DumpOptions,
  type RestoreOptions,
} from './options';

const SERVER: BackupScope = { kind: 'server' };
const DATABASE: BackupScope = { kind: 'database', database: 'shop' };
const DATABASES: BackupScope = { kind: 'databases', databases: ['shop', 'blog'] };
const COLLECTION: BackupScope = { kind: 'collection', database: 'shop', collection: 'orders' };

function dump(input: Partial<DumpOptions>): DumpOptions {
  return DumpOptionsSchema.parse(input);
}

function fields(problems: readonly { field: string }[]): string[] {
  return problems.map((problem) => problem.field);
}

describe('dumpOptionProblems', () => {
  it('accepts the defaults for every scope', () => {
    for (const scope of [SERVER, DATABASE, COLLECTION]) {
      expect(dumpOptionProblems(scope, dump({}))).toEqual([]);
    }
    expect(dumpOptionProblems(DATABASES, dump({ output: 'directory' }))).toEqual([]);
  });

  it('refuses several databases in one archive', () => {
    expect(dumpOptionProblems(DATABASES, dump({}))).toEqual([
      { field: 'output', message: 'Several databases need the folder format.' },
    ]);
  });

  it('allows a query only for a collection, as a JSON object', () => {
    expect(dumpOptionProblems(COLLECTION, dump({ query: '{"a":{"$gt":1}}' }))).toEqual([]);
    expect(fields(dumpOptionProblems(DATABASE, dump({ query: '{}' })))).toEqual(['query']);
    for (const query of ['[1]', 'null', '{a:1}', '']) {
      expect(fields(dumpOptionProblems(COLLECTION, dump({ query })))).toEqual(['query']);
    }
  });

  it('allows excluding collections only for databases', () => {
    const options = dump({ excludeCollections: ['logs'], excludeCollectionsWithPrefix: ['tmp_'] });
    expect(dumpOptionProblems(DATABASE, options)).toEqual([]);
    expect(dumpOptionProblems(DATABASES, { ...options, output: 'directory' })).toEqual([]);
    expect(fields(dumpOptionProblems(SERVER, options))).toEqual([
      'excludeCollections',
      'excludeCollectionsWithPrefix',
    ]);
    expect(fields(dumpOptionProblems(COLLECTION, options))).toHaveLength(2);
  });

  it('allows the oplog only for a whole replica set', () => {
    const options = dump({ oplog: true });
    expect(dumpOptionProblems(SERVER, options)).toEqual([]);
    expect(dumpOptionProblems(SERVER, options, { topology: 'replicaSet' })).toEqual([]);
    for (const topology of ['standalone', 'sharded'] as const) {
      expect(fields(dumpOptionProblems(SERVER, options, { topology }))).toEqual(['oplog']);
    }
    expect(fields(dumpOptionProblems(DATABASE, options))).toEqual(['oplog']);
  });

  it('allows users and roles only for databases other than admin', () => {
    const options = dump({ dumpDbUsersAndRoles: true, output: 'directory' });
    expect(dumpOptionProblems(DATABASE, options)).toEqual([]);
    expect(dumpOptionProblems(DATABASES, options)).toEqual([]);
    expect(fields(dumpOptionProblems(SERVER, options))).toEqual(['dumpDbUsersAndRoles']);
    expect(fields(dumpOptionProblems(COLLECTION, options))).toEqual(['dumpDbUsersAndRoles']);
    expect(fields(dumpOptionProblems({ kind: 'database', database: 'admin' }, options))).toEqual([
      'dumpDbUsersAndRoles',
    ]);
    expect(
      fields(dumpOptionProblems({ kind: 'databases', databases: ['shop', 'admin'] }, options)),
    ).toEqual(['dumpDbUsersAndRoles']);
  });

  it('runs in the start input schema', () => {
    const result = BackupStartInputSchema.safeParse({
      connectionId: '6f1c1e0e-4f5b-4a53-9a39-1f2a3b4c5d6e',
      scope: DATABASES,
      options: { oplog: true },
      folder: '/backups',
      name: 'shop',
      toolsVersion: '100.19.1',
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join('.'))).toEqual([
      'options.output',
      'options.oplog',
    ]);
  });
});

const INSPECTION = {
  namespaces: [
    { database: 'shop', collection: 'orders', type: 'collection' as const },
    { database: 'shop', collection: 'users', type: 'collection' as const },
    { database: 'blog', collection: 'posts', type: 'collection' as const },
  ],
  hasOplog: true,
  hasUsersAndRoles: true,
};

function restore(input: Partial<RestoreOptions>): RestoreOptions {
  return RestoreOptionsSchema.parse(input);
}

describe('restoreOptionProblems', () => {
  it('accepts the defaults', () => {
    expect(restoreOptionProblems(restore({}), INSPECTION)).toEqual([]);
  });

  it('needs an oplog in the backup for an oplog replay', () => {
    const options = restore({ oplogReplay: true });
    expect(restoreOptionProblems(options, INSPECTION)).toEqual([]);
    expect(fields(restoreOptionProblems(options, { ...INSPECTION, hasOplog: false }))).toEqual([
      'oplogReplay',
    ]);
  });

  it('refuses an oplog replay with renames or a partial include', () => {
    expect(
      fields(
        restoreOptionProblems(
          restore({ oplogReplay: true, renames: [{ from: 'shop', to: 'shop2' }] }),
          INSPECTION,
        ),
      ),
    ).toEqual(['oplogReplay']);
    expect(
      fields(
        restoreOptionProblems(restore({ oplogReplay: true, include: ['shop.*'] }), INSPECTION),
      ),
    ).toEqual(['oplogReplay']);
    expect(
      restoreOptionProblems(
        restore({ oplogReplay: true, include: ['shop.*', 'blog.posts'] }),
        INSPECTION,
      ),
    ).toEqual([]);
  });

  it('needs an oplog replay for an oplog limit', () => {
    expect(fields(restoreOptionProblems(restore({ oplogLimit: '10' }), INSPECTION))).toEqual([
      'oplogLimit',
    ]);
  });

  it('needs drop for preserveUUID', () => {
    expect(fields(restoreOptionProblems(restore({ preserveUUID: true }), INSPECTION))).toEqual([
      'preserveUUID',
    ]);
    expect(restoreOptionProblems(restore({ preserveUUID: true, drop: true }), INSPECTION)).toEqual(
      [],
    );
  });

  it('needs users and roles in the backup and no renames to restore them', () => {
    const options = restore({ restoreDbUsersAndRoles: true });
    expect(restoreOptionProblems(options, INSPECTION)).toEqual([]);
    expect(
      fields(restoreOptionProblems(options, { ...INSPECTION, hasUsersAndRoles: false })),
    ).toEqual(['restoreDbUsersAndRoles']);
    expect(
      fields(
        restoreOptionProblems({ ...options, renames: [{ from: 'shop', to: 'shop2' }] }, INSPECTION),
      ),
    ).toEqual(['restoreDbUsersAndRoles']);
  });

  it.each([
    [[{ from: 'admin', to: 'admin2' }], 'The admin database cannot be renamed.'],
    [[{ from: 'shop', to: 'config' }], 'A database cannot be renamed to config.'],
    [[{ from: 'shop', to: 'a/b' }], 'a/b is not a valid database name.'],
    [
      [
        { from: 'shop', to: 'x' },
        { from: 'blog', to: 'x' },
      ],
      'Two databases are renamed to x.',
    ],
    [
      [
        { from: 'shop', to: 'x' },
        { from: 'shop', to: 'y' },
      ],
      'shop is renamed twice.',
    ],
    [[{ from: 'shop', to: 'blog' }], 'blog is also restored under its own name.'],
  ])('refuses the renames %j', (renames, message) => {
    // The schema already refuses invalid names, so the problems check them on unparsed input too.
    const options = { ...restore({}), renames };
    expect(restoreOptionProblems(options, INSPECTION)).toEqual([{ field: 'renames', message }]);
  });

  it('allows renaming onto a database that is itself renamed or not selected', () => {
    expect(
      restoreOptionProblems(
        restore({
          renames: [
            { from: 'shop', to: 'blog' },
            { from: 'blog', to: 'blog_old' },
          ],
        }),
        INSPECTION,
      ),
    ).toEqual([]);
    expect(
      restoreOptionProblems(
        restore({ include: ['shop.*'], renames: [{ from: 'shop', to: 'blog' }] }),
        INSPECTION,
      ),
    ).toEqual([]);
  });
});

describe('normaliseRestoreOptions', () => {
  it('forces stopOnError and one worker for insertion order', () => {
    const options = normaliseRestoreOptions(
      restore({ maintainInsertionOrder: true, numInsertionWorkersPerCollection: 4 }),
    );
    expect(options.stopOnError).toBe(true);
    expect(options.numInsertionWorkersPerCollection).toBe(1);
  });

  it('leaves other options alone', () => {
    const options = restore({ numInsertionWorkersPerCollection: 4 });
    expect(normaliseRestoreOptions(options)).toBe(options);
  });
});
