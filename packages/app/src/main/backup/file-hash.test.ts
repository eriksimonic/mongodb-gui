import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hashDirectory, hashFile } from './file-hash';

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hash-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('hashFile', () => {
  it('hashes the content and reports every byte', async () => {
    writeFileSync(join(dir, 'a.txt'), 'hello');
    let seen = 0;
    expect(await hashFile(join(dir, 'a.txt'), (n) => (seen += n))).toBe(sha('hello'));
    expect(seen).toBe(5);
  });

  it('stops with CANCELLED when the signal is aborted', async () => {
    writeFileSync(join(dir, 'a.txt'), 'hello');
    const controller = new AbortController();
    controller.abort();
    await expect(hashFile(join(dir, 'a.txt'), () => {}, controller.signal)).rejects.toMatchObject({
      error: { code: 'CANCELLED' },
    });
  });
});

describe('hashDirectory', () => {
  it('lists files sorted with posix paths and totals the bytes', async () => {
    mkdirSync(join(dir, 'shop'));
    writeFileSync(join(dir, 'shop', 'b.bson'), 'bb');
    writeFileSync(join(dir, 'shop', 'a.bson'), 'a');
    writeFileSync(join(dir, 'prelude.json'), '{}');
    let seen = 0;
    const result = await hashDirectory(dir, (n) => (seen += n));
    expect(result.files).toEqual([
      { path: 'prelude.json', bytes: 2, sha256: sha('{}') },
      { path: 'shop/a.bson', bytes: 1, sha256: sha('a') },
      { path: 'shop/b.bson', bytes: 2, sha256: sha('bb') },
    ]);
    expect(result.bytes).toBe(5);
    expect(seen).toBe(5);
  });

  it('returns nothing for an empty folder', async () => {
    expect(await hashDirectory(dir, () => {})).toEqual({ files: [], bytes: 0 });
  });
});
