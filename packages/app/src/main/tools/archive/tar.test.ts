import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { readTarGz } from './tar';

export function tarHeader(name: string, size: number, type: string, prefix = ''): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 'utf8');
  header.write('0000755\0', 100, 'ascii');
  header.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 'ascii');
  header.write(type, 156, 'ascii');
  header.write('ustar\0', 257, 'ascii');
  header.write(prefix, 345, 'utf8');
  return header;
}

export function buildTgz(
  files: { name: string; data?: string; type?: string; prefix?: string }[],
): Buffer {
  const parts: Buffer[] = [];
  for (const file of files) {
    const data = Buffer.from(file.data ?? '');
    parts.push(tarHeader(file.name, data.length, file.type ?? '0', file.prefix));
    if (data.length > 0) {
      parts.push(data, Buffer.alloc(Math.ceil(data.length / 512) * 512 - data.length));
    }
  }
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts));
}

describe('readTarGz', () => {
  it('reads regular files, joins the prefix and skips directories', () => {
    const entries = readTarGz(
      buildTgz([
        { name: 'top/', type: '5' },
        { name: 'bin/mongodump', data: 'binary', prefix: 'top/very/long' },
        { name: 'NUL-type', data: 'x', type: '\0' },
      ]),
    );

    expect(entries.map((entry) => entry.name)).toEqual(['top/very/long/bin/mongodump', 'NUL-type']);
    expect(entries[0]?.data.toString()).toBe('binary');
    expect(entries[0]?.mode).toBe(0o755);
  });

  it('refuses hard links and symlinks', () => {
    expect(() => readTarGz(buildTgz([{ name: 'a', type: '1' }]))).toThrow(/link/);
    expect(() => readTarGz(buildTgz([{ name: 'a', type: '2' }]))).toThrow(/link/);
  });

  it('refuses a truncated archive', () => {
    const header = tarHeader('a', 2000, '0');
    expect(() => readTarGz(gzipSync(header))).toThrow(/truncated/);
  });
});
