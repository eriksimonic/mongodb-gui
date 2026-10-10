import { describe, expect, it } from 'vitest';
import { DumpOptionsSchema } from './options';
import { BackupSidecarSchema, parseSidecar, type BackupSidecar } from './sidecar';

const sha = 'a'.repeat(64);

function fixture(): BackupSidecar {
  return {
    format: 'mongo-gui.backup',
    formatVersion: 1,
    app: { name: 'Mongo GUI', version: '0.2.0' },
    startedAt: '2026-10-10T18:42:00.000Z',
    finishedAt: '2026-10-10T18:42:09.000Z',
    durationMs: 9000,
    tools: {
      version: '100.19.1',
      gitVersion: 'abc123',
      goVersion: 'go1.23',
      os: 'linux',
      arch: 'x64',
      target: 'ubuntu2204',
      source: 'bundled',
      mongodumpSha256: sha,
    },
    source: {
      connectionName: 'Local',
      uri: 'mongodb://localhost:27017/?replicaSet=rs0',
      hosts: ['localhost:27017'],
      srv: false,
      docker: { containerName: 'mongo', image: 'mongo:8' },
      topology: 'replicaSet',
      setName: 'rs0',
      directConnection: false,
      serverVersion: '8.0.1',
      fcv: '8.0',
      storageEngine: 'wiredTiger',
    },
    scope: { kind: 'databases', databases: ['shop', 'blog'] },
    options: DumpOptionsSchema.parse({ output: 'directory' }),
    readPreferenceUsed: 'secondaryPreferred',
    args: ['--db=shop', '--gzip'],
    output: {
      kind: 'directory',
      dirName: 'shop-dump',
      gzip: true,
      bytes: 1234,
      files: [{ path: 'shop/orders.bson.gz', bytes: 1000, sha256: sha }],
    },
    databases: [
      {
        name: 'shop',
        collections: [{ name: 'orders', type: 'collection', documents: 10, capped: false }],
      },
      { name: 'blog', collections: [] },
    ],
    totals: { databases: 2, collections: 1, documents: 10 },
    oplog: false,
    usersAndRoles: false,
    warnings: ['WARNING: something'],
  };
}

describe('parseSidecar', () => {
  it('round trips a full fixture through JSON', () => {
    const parsed = parseSidecar(JSON.parse(JSON.stringify(fixture())));
    expect(parsed).toEqual({ sidecar: fixture() });
  });

  it('refuses an unknown top-level key', () => {
    expect(BackupSidecarSchema.safeParse({ ...fixture(), extra: 1 }).success).toBe(false);
    expect('problem' in parseSidecar({ ...fixture(), extra: 1 })).toBe(true);
  });

  it('reports a newer format version', () => {
    expect(parseSidecar({ format: 'mongo-gui.backup', formatVersion: 2, anything: true })).toEqual({
      problem: 'Made by a newer Mongo GUI',
    });
  });

  it('reports a file that is not a backup description', () => {
    expect('problem' in parseSidecar({ hello: 'world' })).toBe(true);
    expect('problem' in parseSidecar(null)).toBe(true);
  });

  it('names the field that is invalid', () => {
    const bad = { ...fixture(), durationMs: -1 };
    const parsed = parseSidecar(bad);
    expect('problem' in parsed && parsed.problem).toContain('durationMs');
  });
});
