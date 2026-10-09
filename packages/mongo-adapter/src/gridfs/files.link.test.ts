import { link, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { linkExclusive } from './files';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, link: vi.fn(actual.link) };
});

function withCode(code: string): Error {
  return Object.assign(new Error(`${code}: operation not permitted`), { code });
}

let dir = '';

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gridfs-link-'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('linkExclusive', () => {
  it.each(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS'])(
    'falls back to a rename when hard links fail with %s',
    async (code) => {
      const source = join(dir, `${code}-source.part`);
      const target = join(dir, `${code}-target.bin`);
      await writeFile(source, 'payload bytes');
      vi.mocked(link).mockRejectedValueOnce(withCode(code));

      await linkExclusive(source, target);

      expect(await readFile(target, 'utf8')).toBe('payload bytes');
      await expect(readFile(source)).rejects.toThrow();
    },
  );

  it('refuses the fallback when the target already exists', async () => {
    const source = join(dir, 'fallback-source.part');
    const target = join(dir, 'fallback-existing.bin');
    await writeFile(source, 'new bytes');
    await writeFile(target, 'old bytes');
    vi.mocked(link).mockRejectedValueOnce(withCode('EPERM'));

    await expect(linkExclusive(source, target)).rejects.toMatchObject({
      error: { code: 'VALIDATION' },
    });
    expect(await readFile(target, 'utf8')).toBe('old bytes');
  });

  it('reports EEXIST from the hard link as an existing target', async () => {
    const source = join(dir, 'eexist-source.part');
    const target = join(dir, 'eexist-target.bin');
    await writeFile(source, 'bytes');
    vi.mocked(link).mockRejectedValueOnce(withCode('EEXIST'));

    await expect(linkExclusive(source, target)).rejects.toMatchObject({
      error: { code: 'VALIDATION', message: 'The target file already exists' },
    });
  });
});
