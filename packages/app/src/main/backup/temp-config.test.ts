import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sweepTempConfigs, writeTempConfig } from './temp-config';

const posix = process.platform !== 'win32';
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'temp-config-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('writeTempConfig', () => {
  it('writes config.yaml into a fresh tools-<uuid> folder', async () => {
    const tmpRoot = join(root, 'tmp');
    const config = await writeTempConfig(tmpRoot, 'uri: "mongodb://u:p@h/"\n');
    expect(dirname(config.dir)).toBe(tmpRoot);
    expect(basename(config.dir)).toMatch(/^tools-[0-9a-f-]{36}$/);
    expect(config.path).toBe(join(config.dir, 'config.yaml'));
    expect(readFileSync(config.path, 'utf8')).toBe('uri: "mongodb://u:p@h/"\n');
    await config.dispose();
  });

  it.runIf(posix)('makes the folder 0700 and the file 0600', async () => {
    const config = await writeTempConfig(root, 'uri: "x"\n');
    expect(statSync(config.dir).mode & 0o777).toBe(0o700);
    expect(statSync(config.path).mode & 0o777).toBe(0o600);
    await config.dispose();
  });

  it('gives every call its own folder', async () => {
    const a = await writeTempConfig(root, 'a');
    const b = await writeTempConfig(root, 'b');
    expect(a.dir).not.toBe(b.dir);
    await Promise.all([a.dispose(), b.dispose()]);
  });

  it('removes the folder on dispose and does not throw on a second call', async () => {
    const config = await writeTempConfig(root, 'uri: "x"\n');
    await config.dispose();
    expect(existsSync(config.dir)).toBe(false);
    await expect(config.dispose()).resolves.toBeUndefined();
  });

  it('does not throw when the folder is already gone', async () => {
    const config = await writeTempConfig(root, 'uri: "x"\n');
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
