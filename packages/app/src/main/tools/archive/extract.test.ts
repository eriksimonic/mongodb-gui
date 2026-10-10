import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { extractToolsArchive } from './extract';
import { buildTgz } from './tar.test';

function simpleZip(files: { name: string; data: string }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const raw = Buffer.from(file.data);
    const body = deflateRawSync(raw);
    const name = Buffer.from(file.name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + body.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

describe('extractToolsArchive', () => {
  let dir = '';
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'extract-test-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('keeps only the wanted files from a tgz, strips the top folder and marks binaries executable', async () => {
    const archive = buildTgz([
      { name: 'tools-1/bin/mongodump', data: 'dump' },
      { name: 'tools-1/bin/mongorestore', data: 'restore' },
      { name: 'tools-1/bin/bsondump', data: 'skip' },
      { name: 'tools-1/LICENSE.md', data: 'license' },
      { name: 'tools-1/other.json', data: '{}' },
    ]);

    const written = await extractToolsArchive(archive, 'tgz', dir, 'linux');

    expect(written).toEqual(['bin/mongodump', 'bin/mongorestore', 'LICENSE.md']);
    expect(await readFile(join(dir, 'bin/mongodump'), 'utf8')).toBe('dump');
    // Windows keeps no execute bit, so the mode check runs only where POSIX modes exist.
    if (process.platform !== 'win32') {
      expect((await stat(join(dir, 'bin/mongodump'))).mode & 0o777).toBe(0o755);
    }
    await expect(stat(join(dir, 'bin/bsondump'))).rejects.toThrow();
  });

  it('extracts the windows binaries from a zip', async () => {
    const archive = simpleZip([
      { name: 'tools/bin/mongodump.exe', data: 'dump' },
      { name: 'tools/bin/mongorestore.exe', data: 'restore' },
      { name: 'tools/THIRD-PARTY-NOTICES', data: 'n' },
    ]);

    const written = await extractToolsArchive(archive, 'zip', dir, 'win32');

    expect(written).toEqual(['bin/mongodump.exe', 'bin/mongorestore.exe', 'THIRD-PARTY-NOTICES']);
  });

  it('refuses absolute paths, parent segments and backslashes in tar names', async () => {
    for (const name of ['/abs/bin/mongodump', 'top/../../evil', 'top\\bin\\mongodump']) {
      await expect(
        extractToolsArchive(buildTgz([{ name, data: 'x' }]), 'tgz', dir, 'linux'),
      ).rejects.toThrow(/Unsafe path/);
    }
  });

  it('refuses parent segments in zip names', async () => {
    await expect(
      extractToolsArchive(simpleZip([{ name: 'top/../x', data: 'x' }]), 'zip', dir, 'win32'),
    ).rejects.toThrow(/Unsafe path/);
  });
});
