import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DumpOptionsSchema, parseSidecar } from '@mongo-gui/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildSidecar, writeSidecar, type SidecarFacts } from './sidecar-writer';

const sha = 'a'.repeat(64);

function facts(): SidecarFacts {
  return {
    appVersion: '0.2.0',
    startedAt: '2026-10-10T18:42:00.000Z',
    finishedAt: '2026-10-10T18:42:09.000Z',
    tools: {
      version: '100.19.1',
      os: 'linux',
      arch: 'x64',
      source: 'bundled',
      mongodumpSha256: sha,
    },
    source: {
      connectionName: 'Local',
      uri: 'mongodb://localhost:27017/?replicaSet=rs0',
      hosts: ['localhost:27017'],
      srv: false,
      topology: 'replicaSet',
      directConnection: false,
      serverVersion: '8.0.1',
    },
    scope: { kind: 'databases', databases: ['shop', 'blog'] },
    options: DumpOptionsSchema.parse({ output: 'directory' }),
    readPreferenceUsed: 'secondaryPreferred',
    args: ['--db=shop'],
    output: { kind: 'directory', dirName: 'dump', gzip: false, bytes: 3, files: [] },
    databases: [
      {
        name: 'shop',
        collections: [
          { name: 'orders', type: 'collection', documents: 10 },
          { name: 'v', type: 'view', documents: 0 },
        ],
      },
      { name: 'blog', collections: [{ name: 'posts', type: 'collection', documents: 5 }] },
    ],
    oplog: false,
    usersAndRoles: false,
    warnings: [],
  };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sidecar-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('buildSidecar', () => {
  it('derives the duration and the totals', () => {
    const sidecar = buildSidecar(facts());
    expect(sidecar.durationMs).toBe(9000);
    expect(sidecar.totals).toEqual({ databases: 2, collections: 3, documents: 15 });
    expect(sidecar.app).toEqual({ name: 'Mongo GUI', version: '0.2.0' });
  });

  it('rejects facts the schema refuses', () => {
    expect(() => buildSidecar({ ...facts(), startedAt: 'yesterday' })).toThrow();
  });
});

describe('writeSidecar', () => {
  it('writes JSON that parses back', () => {
    const path = join(dir, 'x.archive.json');
    const sidecar = buildSidecar(facts());
    writeSidecar(path, sidecar, ['hunter2']);
    expect(parseSidecar(JSON.parse(readFileSync(path, 'utf8')))).toEqual({ sidecar });
    expect(readdirSync(dir)).toEqual(['x.archive.json']);
  });

  it('refuses and writes nothing when a secret is present', () => {
    const path = join(dir, 'x.json');
    const sidecar = buildSidecar({ ...facts(), warnings: ['uri had pa%24%24 in it'] });
    expect(() => writeSidecar(path, sidecar, ['pa%24%24'])).toThrow(/credential/);
    expect(existsSync(path)).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('writes when a short password only shows up by chance', () => {
    const path = join(dir, 'x.json');
    const sidecar = buildSidecar({
      ...facts(),
      source: { ...facts().source, uri: 'mongodb://127.0.0.1:27017/?authSource=admin' },
      output: {
        kind: 'directory',
        dirName: 'dump',
        gzip: false,
        bytes: 3,
        files: [{ path: 'shop/orders.bson', bytes: 3, sha256: `1234${'b'.repeat(60)}` }],
      },
    });
    writeSidecar(path, sidecar, ['admin', 'mongo', 'mongodb', '1234']);
    expect(existsSync(path)).toBe(true);
  });

  it('refuses a short password written as user info', () => {
    const path = join(dir, 'x.json');
    const sidecar = buildSidecar({ ...facts(), warnings: ['failed for root:admin@host'] });
    expect(() => writeSidecar(path, sidecar, ['admin'])).toThrow(/credential/);
    expect(existsSync(path)).toBe(false);
  });

  it('writes when the raw profile URI has no credentials and equals the sidecar URI', () => {
    const path = join(dir, 'x.json');
    const uri = 'mongodb://127.0.0.1:27017/?directConnection=true';
    const sidecar = buildSidecar({ ...facts(), source: { ...facts().source, uri } });
    writeSidecar(path, sidecar, [uri, 'mongodb://127.0.0.1:27017']);
    expect(existsSync(path)).toBe(true);
  });

  it('ignores empty secrets', () => {
    writeSidecar(join(dir, 'x.json'), buildSidecar(facts()), ['']);
    expect(existsSync(join(dir, 'x.json'))).toBe(true);
  });
});
