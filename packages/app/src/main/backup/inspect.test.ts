import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { DumpOptionsSchema } from '@mongo-gui/core';
import type { ArchivePrelude } from '@mongo-gui/mongo-adapter';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { inspectBackup } from './inspect';
import { buildSidecar } from './sidecar-writer';

const MAGIC = Buffer.from([0x6d, 0xe2, 0x99, 0x81]);
const TERMINATOR = Buffer.from([0xff, 0xff, 0xff, 0xff]);

// Stands in for the BSON reader: the archive body is JSON lines, so the test controls the content.
function fakeReadPrelude(bytes: Uint8Array): ArchivePrelude {
  const buffer = Buffer.from(bytes);
  if (!buffer.subarray(0, 4).equals(MAGIC)) throw new Error('bad magic');
  const end = buffer.indexOf(TERMINATOR, 4);
  const body = JSON.parse(buffer.subarray(4, end < 0 ? buffer.length : end).toString('utf8')) as {
    serverVersion: string;
    namespaces: ArchivePrelude['namespaces'];
    oplog?: boolean;
  };
  return {
    serverVersion: body.serverVersion,
    toolsVersion: '100.10.0',
    namespaces: body.namespaces,
    oplog: body.oplog ?? false,
    truncated: end < 0,
  };
}

function archiveBytes(extra: { oplog?: boolean; namespaces?: unknown[] } = {}): Buffer {
  const body = {
    serverVersion: '8.0.1',
    namespaces: [
      { database: 'shop', collection: 'orders', type: 'collection' },
      { database: 'admin', collection: 'system.users', type: 'collection' },
      ...(extra.namespaces ?? []),
    ],
    ...(extra.oplog === undefined ? {} : { oplog: extra.oplog }),
  };
  return Buffer.concat([
    MAGIC,
    Buffer.from(JSON.stringify(body)),
    TERMINATOR,
    Buffer.from('rest of the archive'),
  ]);
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'inspect-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const deps = { readPrelude: fakeReadPrelude };

function sidecar() {
  return buildSidecar({
    appVersion: '0.2.0',
    startedAt: '2026-10-10T18:42:00.000Z',
    finishedAt: '2026-10-10T18:42:01.000Z',
    tools: {
      version: '100.19.1',
      os: 'linux',
      arch: 'x64',
      source: 'bundled',
      mongodumpSha256: 'a'.repeat(64),
    },
    source: {
      connectionName: 'Local',
      uri: 'mongodb://localhost:27017',
      hosts: ['localhost:27017'],
      srv: false,
      topology: 'standalone',
      directConnection: false,
      serverVersion: '8.0.1',
    },
    scope: { kind: 'server' },
    options: DumpOptionsSchema.parse({ output: 'archive' }),
    readPreferenceUsed: 'primary',
    args: [],
    output: {
      kind: 'archive',
      fileName: 'a.archive',
      gzip: false,
      bytes: 1,
      sha256: 'b'.repeat(64),
    },
    databases: [
      { name: 'shop', collections: [{ name: 'orders', type: 'collection', documents: 42 }] },
    ],
    oplog: true,
    usersAndRoles: false,
    warnings: [],
  });
}

describe('inspectBackup, archives', () => {
  it('reads a plain archive prelude', async () => {
    const path = join(dir, 'a.archive');
    writeFileSync(path, archiveBytes());
    const result = await inspectBackup(path, deps);
    expect(result).toMatchObject({
      kind: 'archive',
      gzip: false,
      prelude: { serverVersion: '8.0.1', toolsVersion: '100.10.0' },
      hasOplog: false,
      hasUsersAndRoles: true,
      namespaces: [
        { database: 'shop', collection: 'orders', type: 'collection' },
        { database: 'admin', collection: 'system.users', type: 'collection' },
      ],
    });
    expect(result.sidecar).toBeUndefined();
  });

  it('reads the oplog from the prelude of an archive without a sidecar', async () => {
    const path = join(dir, 'a.archive');
    writeFileSync(
      path,
      archiveBytes({
        oplog: true,
        namespaces: [{ database: '', collection: 'stray', type: 'collection' }],
      }),
    );
    const result = await inspectBackup(path, deps);
    expect(result.sidecar).toBeUndefined();
    expect(result.hasOplog).toBe(true);
    expect(result.namespaces.map((n) => n.database)).toEqual(['shop', 'admin']);
  });

  it('inflates a gzip archive before reading', async () => {
    const path = join(dir, 'a.archive.gz');
    writeFileSync(path, gzipSync(archiveBytes()));
    const result = await inspectBackup(path, deps);
    expect(result.gzip).toBe(true);
    expect(result.prelude?.serverVersion).toBe('8.0.1');
  });

  it('takes namespaces and counts from the sidecar, and follows a picked .json', async () => {
    const path = join(dir, 'a.archive');
    writeFileSync(path, archiveBytes());
    writeFileSync(`${path}.json`, JSON.stringify(sidecar()));
    const result = await inspectBackup(`${path}.json`, deps);
    expect(result.path).toBe(path);
    expect(result.sidecar?.app.version).toBe('0.2.0');
    expect(result.namespaces).toEqual([
      { database: 'shop', collection: 'orders', type: 'collection', documents: 42 },
    ]);
    expect(result.hasOplog).toBe(true);
  });

  it('reports a damaged sidecar and falls back to the prelude', async () => {
    const path = join(dir, 'a.archive');
    writeFileSync(path, archiveBytes());
    writeFileSync(`${path}.json`, '{ nope');
    const result = await inspectBackup(path, deps);
    expect(result.sidecarProblem).toMatch(/JSON/);
    expect(result.namespaces).toHaveLength(2);
  });

  it('reports a sidecar from a newer version', async () => {
    const path = join(dir, 'a.archive');
    writeFileSync(path, archiveBytes());
    writeFileSync(`${path}.json`, JSON.stringify({ format: 'mongo-gui.backup', formatVersion: 2 }));
    expect((await inspectBackup(path, deps)).sidecarProblem).toBe('Made by a newer Mongo GUI');
  });

  it('refuses a file that is not an archive', async () => {
    const path = join(dir, 'x.txt');
    writeFileSync(path, 'hello world');
    await expect(inspectBackup(path, deps)).rejects.toMatchObject({
      error: { code: 'VALIDATION' },
    });
  });

  it('refuses a missing path', async () => {
    await expect(inspectBackup(join(dir, 'none'), deps)).rejects.toMatchObject({
      error: { code: 'NOT_FOUND' },
    });
  });
});

function touch(path: string, content = 'x'): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
}

describe('inspectBackup, directories', () => {
  it('lists a root layout with views, time series, oplog and users', async () => {
    touch(join(dir, 'shop', 'orders.bson'));
    touch(join(dir, 'shop', 'orders.metadata.json'));
    touch(join(dir, 'shop', 'recent.metadata.json'));
    touch(join(dir, 'shop', 'system.buckets.cpu.bson'));
    touch(join(dir, 'shop', 'system.buckets.cpu.metadata.json'));
    touch(join(dir, 'admin', 'system.users.bson'));
    touch(join(dir, 'oplog.bson'));
    const result = await inspectBackup(dir, deps);
    expect(result.layout).toBe('root');
    expect(result.gzip).toBe(false);
    expect(result.hasOplog).toBe(true);
    expect(result.hasUsersAndRoles).toBe(true);
    expect(result.namespaces).toEqual([
      { database: 'admin', collection: 'system.users', type: 'collection' },
      { database: 'shop', collection: 'orders', type: 'collection' },
      { database: 'shop', collection: 'recent', type: 'view' },
      { database: 'shop', collection: 'cpu', type: 'timeseries' },
    ]);
    expect(result.bytes).toBe(7);
  });

  it('detects a database folder, gzip, the users file and the prelude', async () => {
    const db = join(dir, 'shop');
    touch(join(db, 'orders.bson.gz'));
    touch(join(db, 'orders.metadata.json.gz'));
    touch(join(db, '$admin.system.users.bson.gz'));
    touch(
      join(db, 'prelude.json'),
      JSON.stringify({ Header: { ServerVersion: '7.0.2', ToolVersion: '100.9.0' } }),
    );
    const result = await inspectBackup(db, deps);
    expect(result.layout).toBe('database');
    expect(result.gzip).toBe(true);
    expect(result.hasUsersAndRoles).toBe(true);
    expect(result.prelude).toEqual({ serverVersion: '7.0.2', toolsVersion: '100.9.0' });
    expect(result.namespaces).toEqual([
      { database: 'shop', collection: 'orders', type: 'collection' },
    ]);
  });

  it('decodes percent-escaped collection names', async () => {
    touch(join(dir, 'shop', 'a%24b.bson'));
    expect((await inspectBackup(dir, deps)).namespaces[0]?.collection).toBe('a$b');
  });

  it('prefers the sidecar inside the folder', async () => {
    touch(join(dir, 'shop', 'orders.bson'));
    writeFileSync(join(dir, 'mongo-gui-backup.json'), JSON.stringify(sidecar()));
    const result = await inspectBackup(dir, deps);
    expect(result.sidecar).toBeDefined();
    expect(result.namespaces[0]?.documents).toBe(42);
  });
});
