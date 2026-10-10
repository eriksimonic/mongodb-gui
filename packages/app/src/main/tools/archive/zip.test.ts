import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { readZip } from './zip';

interface ZipFile {
  name: string;
  data: string;
  method?: 0 | 8;
  flags?: number;
  sizeOverride?: number;
}

// Local headers carry zero sizes (bit 3 set); the real sizes live only in the central directory.
function buildZip(files: ZipFile[], zip64 = false): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const raw = Buffer.from(file.data);
    const method = file.method ?? 8;
    const body = method === 8 ? deflateRawSync(raw) : raw;
    const name = Buffer.from(file.name);
    const flags = (file.flags ?? 0) | 0x08;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(zip64 ? 0xffffffff : body.length, 20);
    central.writeUInt32LE(file.sizeOverride ?? raw.length, 24);
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

describe('readZip', () => {
  it('reads deflated and stored entries whose sizes sit only in the central directory', () => {
    const entries = readZip(
      buildZip([
        { name: 'top/', data: '', method: 0 },
        { name: 'top/bin/mongodump.exe', data: 'x'.repeat(5000) },
        { name: 'top/README.md', data: 'hello', method: 0 },
      ]),
    );

    expect(entries.map((entry) => entry.name)).toEqual(['top/bin/mongodump.exe', 'top/README.md']);
    expect(entries[0]?.data.length).toBe(5000);
    expect(entries[1]?.data.toString()).toBe('hello');
  });

  it('refuses zip64 markers', () => {
    expect(() => readZip(buildZip([{ name: 'a', data: 'a' }], true))).toThrow(/Zip64/);
  });

  it('refuses encrypted entries', () => {
    expect(() => readZip(buildZip([{ name: 'a', data: 'a', flags: 1 }]))).toThrow(/encrypted/);
  });

  it('refuses a size mismatch', () => {
    expect(() => readZip(buildZip([{ name: 'a', data: 'abc', sizeOverride: 9 }]))).toThrow(/size/);
  });

  it('refuses a buffer with no end record', () => {
    expect(() => readZip(Buffer.alloc(100))).toThrow(/end-of-central-directory/);
  });
});
