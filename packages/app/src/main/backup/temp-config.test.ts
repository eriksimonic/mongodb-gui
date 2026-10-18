import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openConfigPipe, sweepTempConfigs } from './temp-config';

const posix = process.platform !== 'win32';
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'temp-config-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('openConfigPipe', () => {
  it('serves the config through a pipe in a fresh tools-<uuid> folder', async () => {
    const tmpRoot = join(root, 'tmp');
    const config = await openConfigPipe(tmpRoot, 'uri: "mongodb://u:p@h/"\n');
    expect(dirname(config.dir)).toBe(tmpRoot);
    expect(basename(config.dir)).toMatch(/^tools-[0-9a-f-]{36}$/);
    expect(await readFile(config.path, 'utf8')).toBe('uri: "mongodb://u:p@h/"\n');
    await config.dispose();
  });

  it.runIf(posix)('uses a FIFO, so the config text is never in a file', async () => {
    const config = await openConfigPipe(root, 'uri: "mongodb://u:s3cret@h/"\n');
    expect(statSync(config.path).isFIFO()).toBe(true);
    expect(statSync(config.dir).mode & 0o777).toBe(0o700);
    expect(statSync(config.path).mode & 0o777).toBe(0o600);
    expect(await readFile(config.path, 'utf8')).toContain('s3cret');
    await config.dispose();
  });

  it('gives every call its own folder and its own pipe', async () => {
    const a = await openConfigPipe(root, 'a');
    const b = await openConfigPipe(root, 'b');
    expect(a.dir).not.toBe(b.dir);
    expect(a.path).not.toBe(b.path);
    expect(await readFile(a.path, 'utf8')).toBe('a');
    expect(await readFile(b.path, 'utf8')).toBe('b');
    await Promise.all([a.dispose(), b.dispose()]);
  });

  it('removes the folder on dispose when no tool read the pipe, and a second call is safe', async () => {
    const config = await openConfigPipe(root, 'uri: "x"\n');
    await config.dispose();
    expect(existsSync(config.dir)).toBe(false);
    await expect(config.dispose()).resolves.toBeUndefined();
  });

  it('does not throw when the folder is already gone', async () => {
    const config = await openConfigPipe(root, 'uri: "x"\n');
    rmSync(config.dir, { recursive: true, force: true });
    await expect(config.dispose()).resolves.toBeUndefined();
  });
});

describe('sweepTempConfigs', () => {
  it('removes leftover tools-* folders and keeps everything else', async () => {
    mkdirSync(join(root, 'tools-old'));
    writeFileSync(join(root, 'tools-old', 'config.yaml'), 'uri: "x"\n');
    mkdirSync(join(root, 'other'));
    writeFileSync(join(root, 'tools-file'), 'not a folder');
    expect(await sweepTempConfigs(root)).toBe(1);
    expect(existsSync(join(root, 'tools-old'))).toBe(false);
    expect(existsSync(join(root, 'other'))).toBe(true);
    expect(existsSync(join(root, 'tools-file'))).toBe(true);
  });

  it('returns 0 when the temp root does not exist', async () => {
    expect(await sweepTempConfigs(join(root, 'missing'))).toBe(0);
  });
});
