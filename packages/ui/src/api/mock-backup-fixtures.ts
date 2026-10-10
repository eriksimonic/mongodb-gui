import type { BackupInspection, BackupNamespaceInfo, BackupSidecar } from '@mongo-gui/core';

/** The tools and server the fixture backup was made with. Older tools than the bundled ones. */
export const FIXTURE_BACKUP_TOOLS_VERSION = '100.12.1';
export const FIXTURE_BACKUP_SERVER_VERSION = '7.0.14';

const SHA = 'ab'.repeat(32);

export const FIXTURE_BACKUP_NAMESPACES: readonly BackupNamespaceInfo[] = [
  { database: 'shop', collection: 'orders', type: 'collection', documents: 1200 },
  { database: 'shop', collection: 'customers', type: 'collection', documents: 340 },
  { database: 'shop', collection: 'paid_orders', type: 'view', documents: 0 },
  { database: 'shop', collection: 'sensor_readings', type: 'timeseries', documents: 86_400 },
];

const FIXTURE_BYTES = 38_400_000;

/** True for a path that names an archive file or its sidecar. Anything else is a dump folder. */
export function isArchivePath(path: string): boolean {
  return /\.(archive|gz|json)$/i.test(path);
}

/** The sidecar a Mongo GUI backup of the shop database carries. */
export function fixtureSidecar(path: string): BackupSidecar {
  const archive = isArchivePath(path);
  const name = path.split(/[\\/]/).filter(Boolean).at(-1) ?? 'backup';
  return {
    format: 'mongo-gui.backup',
    formatVersion: 1,
    app: { name: 'Mongo GUI', version: '0.1.0' },
    startedAt: '2026-10-08T14:02:11.000Z',
    finishedAt: '2026-10-08T14:02:41.000Z',
    durationMs: 30_000,
    tools: {
      version: FIXTURE_BACKUP_TOOLS_VERSION,
      gitVersion: '0f9e8d7c6b5a',
      goVersion: 'go1.21.8',
      os: 'linux',
      arch: 'x64',
      target: 'ubuntu2204',
      source: 'downloaded',
      mongodumpSha256: SHA,
    },
    source: {
      connectionName: 'Local MongoDB',
      uri: 'mongodb://localhost:27017/?directConnection=true',
      hosts: ['localhost:27017'],
      srv: false,
      topology: 'standalone',
      directConnection: true,
      serverVersion: FIXTURE_BACKUP_SERVER_VERSION,
      fcv: '7.0',
      storageEngine: 'wiredTiger',
    },
    scope: { kind: 'database', database: 'shop' },
    options: {
      output: archive ? 'archive' : 'directory',
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
    readPreferenceUsed: 'primary',
    args: ['--db=shop', archive ? '--archive=-' : '--out=dump', '--gzip'],
    output: archive
      ? { kind: 'archive', fileName: name, gzip: true, bytes: FIXTURE_BYTES, sha256: SHA }
      : {
          kind: 'directory',
          dirName: name,
          gzip: true,
          bytes: FIXTURE_BYTES,
          files: [
            { path: 'shop/orders.bson.gz', bytes: 21_000_000, sha256: SHA },
            { path: 'shop/customers.bson.gz', bytes: 6_000_000, sha256: SHA },
          ],
        },
    databases: [
      {
        name: 'shop',
        collections: [
          { name: 'orders', type: 'collection', documents: 1200 },
          { name: 'customers', type: 'collection', documents: 340 },
          { name: 'paid_orders', type: 'view', documents: 0 },
          { name: 'sensor_readings', type: 'timeseries', documents: 86_400 },
        ],
      },
    ],
    totals: { databases: 1, collections: 4, documents: 87_940 },
    oplog: false,
    usersAndRoles: false,
    warnings: [],
  };
}

/** What inspecting a picked path returns. */
export function fixtureInspection(path: string): BackupInspection {
  const archive = isArchivePath(path);
  return {
    path: path.replace(/\.json$/i, ''),
    kind: archive ? 'archive' : 'directory',
    ...(archive ? {} : { layout: 'root' as const }),
    gzip: true,
    bytes: FIXTURE_BYTES,
    sidecar: fixtureSidecar(path),
    prelude: {
      serverVersion: FIXTURE_BACKUP_SERVER_VERSION,
      toolsVersion: FIXTURE_BACKUP_TOOLS_VERSION,
    },
    namespaces: FIXTURE_BACKUP_NAMESPACES.map((item) => ({ ...item })),
    hasOplog: false,
    hasUsersAndRoles: false,
  };
}
