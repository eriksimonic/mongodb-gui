import { mkdir, mkdtemp, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ToolsInstallManifest } from '@mongo-gui/core';
import { toolsRoots, type ToolsRoots } from './paths';
import { fakeSpawn, versionBanner, type FakeRun } from './probe.test';
import { createToolsRegistry } from './registry';

const SHA = 'a'.repeat(64);

function manifest(version: string, source: 'bundled' | 'downloaded'): ToolsInstallManifest {
  return {
    format: 'mongo-gui.tools',
    formatVersion: 1,
    source,
    version,
    target: 'ubuntu2004',
    os: 'linux',
    arch: 'x64',
    archiveUrl: `https://fastdl.mongodb.org/tools/db/mongodb-database-tools-ubuntu2004-x86_64-${version}.tgz`,
    archiveSha256: SHA,
    binaries: { mongodump: SHA, mongorestore: SHA },
    gitVersion: 'abc123',
    installedAt: '2026-10-01T10:00:00.000Z',
  };
}

async function makeInstall(
  dir: string,
  version: string,
  source: 'bundled' | 'downloaded',
  options: { manifest?: unknown } = {},
): Promise<void> {
  await mkdir(join(dir, 'bin'), { recursive: true });
  await writeFile(join(dir, 'bin', 'mongodump'), 'dump-binary');
  await writeFile(join(dir, 'bin', 'mongorestore'), 'restore-binary');
  await writeFile(join(dir, 'LICENSE.md'), `Licence ${version}`);
  await writeFile(join(dir, 'THIRD-PARTY-NOTICES'), 'Notices');
  const content = 'manifest' in options ? options.manifest : manifest(version, source);
  await writeFile(
    join(dir, 'install.json'),
    typeof content === 'string' ? content : JSON.stringify(content),
  );
}

let base: string;
let roots: ToolsRoots;
// The version each folder's mongodump reports, or a failure. Keyed by install folder.
let runs: Map<string, FakeRun>;

function registry(arch = 'x64', platform: NodeJS.Platform = 'linux') {
  const fake = fakeSpawn((file) => {
    const dir = join(file, '..', '..');
    return runs.get(dir) ?? { errno: 'ENOENT' };
  });
  return {
    registry: createToolsRegistry({ roots, spawn: fake.spawn, platform, arch, env: {} }),
    fake,
  };
}

function reports(dir: string, version: string): void {
  runs.set(dir, { stdout: versionBanner(version) });
}

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'tools-registry-'));
  roots = toolsRoots({
    isPackaged: true,
    resourcesPath: join(base, 'resources'),
    appRoot: base,
    userDataDir: join(base, 'user'),
    platform: 'linux',
    arch: 'x64',
  });
  runs = new Map();
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('list', () => {
  it('lists bundled and downloaded installs newest first, bundled first on a tie', async () => {
    await makeInstall(roots.bundled, '100.19.1', 'bundled');
    reports(roots.bundled, '100.19.1');
    for (const version of ['100.12.1', '100.19.1', '100.20.0']) {
      const dir = join(roots.downloaded, `${version}-ubuntu2004`);
      await makeInstall(dir, version, 'downloaded');
      reports(dir, version);
    }
    const output = await registry().registry.list('auto');
    expect(output.platform).toEqual({ os: 'linux', arch: 'x64' });
    expect(output.bundledSupported).toBe(true);
    expect(output.installs.map((install) => install.id)).toEqual([
      'downloaded:100.20.0',
      'bundled',
      'downloaded:100.19.1',
      'downloaded:100.12.1',
    ]);
    expect(output.resolved).toBe('100.19.1');
    expect(output.installs[1]).toMatchObject({
      source: 'bundled',
      version: '100.19.1',
      target: 'ubuntu2004',
      gitVersion: 'abc123',
      location: roots.bundled,
      installedAt: '2026-10-01T10:00:00.000Z',
      health: { state: 'ok' },
      inUse: false,
    });
    expect(output.installs[1]?.sizeBytes).toBeGreaterThan(0);
  });

  it('reports bundled tools as unsupported on macOS and Linux arm64', async () => {
    expect((await registry('arm64').registry.list('auto')).bundledSupported).toBe(false);
    const mac = await registry('x64', 'darwin').registry.list('auto');
    expect(mac.bundledSupported).toBe(false);
    expect(mac.platform.os).toBe('darwin');
    expect(mac.installs).toEqual([]);
    expect(mac.resolved).toBeUndefined();
  });

  it('marks a folder without a valid manifest as broken', async () => {
    const dir = join(roots.downloaded, '100.18.0-ubuntu2004');
    await makeInstall(dir, '100.18.0', 'downloaded', { manifest: '{ not json' });
    reports(dir, '100.18.0');
    const [install] = (await registry().registry.list('auto')).installs;
    expect(install).toMatchObject({
      id: 'downloaded:100.18.0',
      health: { state: 'broken', error: { code: 'VALIDATION' } },
    });
  });

  it('marks a probe that disagrees with the manifest as broken', async () => {
    await makeInstall(roots.bundled, '100.19.1', 'bundled');
    reports(roots.bundled, '100.18.0');
    const output = await registry().registry.list('auto');
    expect(output.installs[0]?.health).toEqual({
      state: 'broken',
      error: {
        code: 'VALIDATION',
        message: 'mongodump reports 100.18.0, but install.json says 100.19.1.',
      },
    });
    expect(output.resolved).toBeUndefined();
  });

  it('marks tools older than 100.3.0 as broken because they lack --config', async () => {
    const dir = join(roots.downloaded, '100.2.1-ubuntu2004');
    await makeInstall(dir, '100.2.1', 'downloaded');
    reports(dir, '100.2.1');
    const tools = registry().registry;
    const output = await tools.list('100.2.1');
    expect(output.installs[0]?.health).toEqual({
      state: 'broken',
      error: {
        code: 'VALIDATION',
        message: 'MongoDB Database Tools older than 100.3.0 do not support --config.',
      },
    });
    expect(output.resolved).toBeUndefined();
    await expect(tools.resolve('100.2.1')).rejects.toMatchObject({
      error: { code: 'NOT_FOUND' },
    });
  });

  it('carries the missing library message of a failed probe', async () => {
    await makeInstall(roots.bundled, '100.19.1', 'bundled');
    runs.set(roots.bundled, {
      code: 127,
      stderr:
        'mongodump: error while loading shared libraries: libgssapi_krb5.so.2: cannot open shared object file\n',
    });
    const [install] = (await registry().registry.list('auto')).installs;
    expect(install?.health).toMatchObject({
      state: 'broken',
      error: {
        code: 'NOT_FOUND',
        message: expect.stringContaining('mongodump needs libgssapi_krb5.so.2.'),
      },
    });
  });

  it('probes each folder once until its binary changes', async () => {
    await makeInstall(roots.bundled, '100.19.1', 'bundled');
    reports(roots.bundled, '100.19.1');
    const { registry: tools, fake } = registry();
    await tools.list('auto');
    await tools.list('auto');
    expect(fake.calls).toHaveLength(1);
    await utimes(join(roots.bundled, 'bin', 'mongodump'), new Date(), new Date(Date.now() + 5000));
    await tools.list('auto');
    expect(fake.calls).toHaveLength(2);
  });

  it('keeps the healthy folder when two downloaded folders share a version', async () => {
    const bad = join(roots.downloaded, '100.19.1-rhel70');
    const good = join(roots.downloaded, '100.19.1-ubuntu2004');
    await makeInstall(bad, '100.19.1', 'downloaded');
    await makeInstall(good, '100.19.1', 'downloaded');
    runs.set(bad, { code: 1 });
    reports(good, '100.19.1');
    const { installs } = await registry().registry.list('auto');
    expect(installs).toHaveLength(1);
    expect(installs[0]).toMatchObject({ location: good, health: { state: 'ok' } });
  });
});

describe('resolve', () => {
  beforeEach(async () => {
    await makeInstall(roots.bundled, '100.19.1', 'bundled');
    reports(roots.bundled, '100.19.1');
    for (const version of ['100.19.1', '100.20.0']) {
      const dir = join(roots.downloaded, `${version}-ubuntu2004`);
      await makeInstall(dir, version, 'downloaded');
      reports(dir, version);
    }
  });

  it('prefers the bundled install for a version and gives the binary paths', async () => {
    const resolved = await registry().registry.resolve('100.19.1');
    expect(resolved.install.id).toBe('bundled');
    expect(resolved.mongodump).toBe(join(roots.bundled, 'bin', 'mongodump'));
    expect(resolved.mongorestore).toBe(join(roots.bundled, 'bin', 'mongorestore'));
  });

  it('gives .exe paths on Windows', async () => {
    const dir = join(roots.downloaded, '100.20.0-ubuntu2004');
    const { registry: tools, fake } = registry('x64', 'win32');
    const resolved = await tools.resolve('100.20.0');
    expect(resolved.mongodump).toBe(join(dir, 'bin', 'mongodump.exe'));
    expect(resolved.mongorestore).toBe(join(dir, 'bin', 'mongorestore.exe'));
    expect(fake.calls.every((call) => call.file.endsWith('mongodump.exe'))).toBe(true);
  });

  it('throws NOT_FOUND for a version that is not installed', async () => {
    await expect(registry().registry.resolve('100.5.0')).rejects.toMatchObject({
      error: { code: 'NOT_FOUND', message: 'MongoDB Database Tools 100.5.0 are not installed.' },
    });
  });

  it('resolves auto to bundled, a pin to that version, and a missing pin like auto', async () => {
    const tools = registry().registry;
    expect((await tools.resolvePreferred('auto')).install.id).toBe('bundled');
    expect((await tools.resolvePreferred('100.20.0')).install.id).toBe('downloaded:100.20.0');
    expect((await tools.resolvePreferred('100.5.0')).install.id).toBe('bundled');
    expect((await tools.list('100.20.0')).resolved).toBe('100.20.0');
  });

  it('falls back to the newest healthy downloaded install when bundled is broken', async () => {
    runs.set(roots.bundled, { code: 1 });
    expect((await registry().registry.resolvePreferred('auto')).install.id).toBe(
      'downloaded:100.20.0',
    );
  });

  it('throws NOT_FOUND when nothing is installed', async () => {
    await rm(base, { recursive: true, force: true });
    await expect(registry().registry.resolvePreferred('auto')).rejects.toMatchObject({
      error: { code: 'NOT_FOUND' },
    });
  });
});

describe('remove', () => {
  it('deletes a downloaded install and refuses bundled, unknown and in-use ones', async () => {
    await makeInstall(roots.bundled, '100.19.1', 'bundled');
    reports(roots.bundled, '100.19.1');
    const dir = join(roots.downloaded, '100.20.0-ubuntu2004');
    await makeInstall(dir, '100.20.0', 'downloaded');
    reports(dir, '100.20.0');
    const tools = registry().registry;

    await expect(tools.remove('bundled')).rejects.toMatchObject({ error: { code: 'VALIDATION' } });
    await expect(tools.remove('downloaded:100.5.0')).rejects.toMatchObject({
      error: { code: 'NOT_FOUND' },
    });

    const release = tools.markInUse('100.20.0');
    expect((await tools.list('auto')).installs.find((i) => i.version === '100.20.0')?.inUse).toBe(
      true,
    );
    await expect(tools.remove('downloaded:100.20.0')).rejects.toMatchObject({
      error: { code: 'VALIDATION' },
    });
    release();
    release();
    expect((await tools.list('auto')).installs.find((i) => i.version === '100.20.0')?.inUse).toBe(
      false,
    );

    await tools.remove('downloaded:100.20.0');
    expect(await readdir(roots.downloaded)).toEqual([]);
  });

  it('keeps a version in use until every job releases it', async () => {
    const tools = registry().registry;
    const first = tools.markInUse('100.19.1');
    const second = tools.markInUse('100.19.1');
    first();
    await makeInstall(roots.bundled, '100.19.1', 'bundled');
    reports(roots.bundled, '100.19.1');
    expect((await tools.list('auto')).installs[0]?.inUse).toBe(true);
    second();
    expect((await tools.list('auto')).installs[0]?.inUse).toBe(false);
  });

  it('ignores a symbolic link in the downloaded root', async () => {
    const outside = join(base, 'outside', '100.20.0-ubuntu2004');
    await makeInstall(outside, '100.20.0', 'downloaded');
    reports(outside, '100.20.0');
    await mkdir(roots.downloaded, { recursive: true });
    await symlink(outside, join(roots.downloaded, '100.20.0-ubuntu2004'), 'dir');
    const tools = registry().registry;
    expect((await tools.list('auto')).installs).toEqual([]);
    await expect(tools.remove('downloaded:100.20.0')).rejects.toMatchObject({
      error: { code: 'NOT_FOUND' },
    });
    expect(await readdir(outside)).toContain('bin');
  });
});

describe('licence', () => {
  it('reads the licence and the third-party notices', async () => {
    await makeInstall(roots.bundled, '100.19.1', 'bundled');
    reports(roots.bundled, '100.19.1');
    expect(await registry().registry.licence('bundled')).toEqual({
      version: '100.19.1',
      licence: 'Licence 100.19.1',
      thirdPartyNotices: 'Notices',
    });
  });

  it('caps a large notices file and throws NOT_FOUND without a licence', async () => {
    await makeInstall(roots.bundled, '100.19.1', 'bundled');
    reports(roots.bundled, '100.19.1');
    await writeFile(join(roots.bundled, 'THIRD-PARTY-NOTICES'), 'x'.repeat(3 * 1024 * 1024));
    const tools = registry().registry;
    expect((await tools.licence('bundled')).thirdPartyNotices).toHaveLength(2 * 1024 * 1024);
    await rm(join(roots.bundled, 'LICENSE.md'));
    await expect(tools.licence('bundled')).rejects.toMatchObject({ error: { code: 'NOT_FOUND' } });
    await expect(tools.licence('downloaded:100.1.0')).rejects.toMatchObject({
      error: { code: 'NOT_FOUND' },
    });
  });
});

describe('sweep', () => {
  it('removes staging folders, partial downloads and temp config folders only', async () => {
    const keep = join(roots.downloaded, '100.20.0-ubuntu2004');
    await mkdir(keep, { recursive: true });
    await mkdir(join(roots.downloaded, '.staging-1234', 'bin'), { recursive: true });
    await writeFile(join(roots.downloaded, 'abcd.partial'), 'x');
    await mkdir(join(roots.tmp, 'tools-5678'), { recursive: true });
    await writeFile(join(roots.tmp, 'tools-5678', 'config.yaml'), 'uri: x');
    await mkdir(join(roots.tmp, 'other'), { recursive: true });

    await registry().registry.sweep();

    expect(await readdir(roots.downloaded)).toEqual(['100.20.0-ubuntu2004']);
    expect(await readdir(roots.tmp)).toEqual(['other']);
  });

  it('does nothing when the folders do not exist', async () => {
    await expect(registry().registry.sweep()).resolves.toBeUndefined();
  });
});
