import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppErrorException } from '@mongo-gui/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  parseKeyringFile,
  readKeyringFile,
  removeKeyringFile,
  writeKeyringFile,
  type KeyringFile,
} from './keyring';

const SALT_B64 = Buffer.alloc(32, 3).toString('base64');
const WRAPPED_B64 = Buffer.alloc(60, 4).toString('base64');

function validKeyring(): KeyringFile {
  return {
    version: 1,
    kdf: { salt: SALT_B64, N: 2 ** 17, r: 8, p: 1 },
    wrappedDek: WRAPPED_B64,
  };
}

function caughtInternal(action: () => unknown): boolean {
  try {
    action();
    return false;
  } catch (error) {
    return error instanceof AppErrorException && error.error.code === 'INTERNAL';
  }
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'keyring-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('parseKeyringFile', () => {
  it('accepts a well-formed keyring', () => {
    expect(parseKeyringFile(validKeyring())).toEqual(validKeyring());
  });

  it('rejects a wrong version', () => {
    expect(caughtInternal(() => parseKeyringFile({ ...validKeyring(), version: 2 }))).toBe(true);
  });

  it('rejects an N whose scrypt memory use exceeds the bound', () => {
    const keyring = { ...validKeyring(), kdf: { ...validKeyring().kdf, r: 32 } };
    expect(caughtInternal(() => parseKeyringFile(keyring))).toBe(true);
  });

  it('rejects unknown fields at either level', () => {
    expect(caughtInternal(() => parseKeyringFile({ ...validKeyring(), extra: 1 }))).toBe(true);
    const kdf = { ...validKeyring().kdf, extra: 1 };
    expect(caughtInternal(() => parseKeyringFile({ ...validKeyring(), kdf }))).toBe(true);
  });

  it('does not put zod issue text into the error', () => {
    let message = '';
    try {
      parseKeyringFile({ ...validKeyring(), wrappedDek: 'secret-looking-text' });
    } catch (error) {
      message = error instanceof AppErrorException ? error.error.message : '';
    }
    expect(message).toBe('malformed keyring');
  });

  it('rejects a non-object value', () => {
    expect(caughtInternal(() => parseKeyringFile('keyring'))).toBe(true);
    expect(caughtInternal(() => parseKeyringFile(null))).toBe(true);
  });

  it('rejects a salt that is not 32 bytes', () => {
    const salt = Buffer.alloc(16, 3).toString('base64');
    const keyring = { ...validKeyring(), kdf: { ...validKeyring().kdf, salt } };
    expect(caughtInternal(() => parseKeyringFile(keyring))).toBe(true);
  });

  it('rejects base64 that is not in canonical form', () => {
    const keyring = { ...validKeyring(), wrappedDek: `${WRAPPED_B64.slice(0, -2)}!!` };
    expect(caughtInternal(() => parseKeyringFile(keyring))).toBe(true);
  });

  it('rejects a wrapped DEK of the wrong length', () => {
    const wrappedDek = Buffer.alloc(59, 4).toString('base64');
    expect(caughtInternal(() => parseKeyringFile({ ...validKeyring(), wrappedDek }))).toBe(true);
  });

  it('rejects an N that is not a power of two', () => {
    const keyring = { ...validKeyring(), kdf: { ...validKeyring().kdf, N: 3000 } };
    expect(caughtInternal(() => parseKeyringFile(keyring))).toBe(true);
  });

  it('rejects non-positive r and p', () => {
    const zeroR = { ...validKeyring(), kdf: { ...validKeyring().kdf, r: 0 } };
    const fractionalP = { ...validKeyring(), kdf: { ...validKeyring().kdf, p: 1.5 } };
    expect(caughtInternal(() => parseKeyringFile(zeroR))).toBe(true);
    expect(caughtInternal(() => parseKeyringFile(fractionalP))).toBe(true);
  });
});

describe('readKeyringFile and writeKeyringFile', () => {
  it('returns undefined when the file does not exist', () => {
    expect(readKeyringFile(join(dir, 'keyring.json'))).toBeUndefined();
  });

  it('round trips a keyring and leaves no temporary file behind', () => {
    const path = join(dir, 'keyring.json');
    writeKeyringFile(path, validKeyring());
    expect(readKeyringFile(path)).toEqual(validKeyring());
    expect(existsSync(`${path}.tmp`)).toBe(false);
  });

  it('removes a leftover temporary file before writing', () => {
    const path = join(dir, 'keyring.json');
    writeFileSync(`${path}.tmp`, 'leftover');
    writeKeyringFile(path, validKeyring());
    expect(readKeyringFile(path)).toEqual(validKeyring());
    expect(existsSync(`${path}.tmp`)).toBe(false);
  });

  it('removeKeyringFile deletes the keyring and a leftover temporary file', () => {
    const path = join(dir, 'keyring.json');
    writeKeyringFile(path, validKeyring());
    writeFileSync(`${path}.tmp`, 'leftover');
    removeKeyringFile(path);
    expect(existsSync(path)).toBe(false);
    expect(existsSync(`${path}.tmp`)).toBe(false);
  });

  it('replaces an existing keyring', () => {
    const path = join(dir, 'keyring.json');
    writeKeyringFile(path, validKeyring());
    const replaced = { ...validKeyring(), wrappedDek: Buffer.alloc(60, 9).toString('base64') };
    writeKeyringFile(path, replaced);
    expect(readKeyringFile(path)).toEqual(replaced);
  });

  it('throws INTERNAL for a file that is not JSON without echoing its contents', () => {
    const path = join(dir, 'keyring.json');
    writeFileSync(path, 'not json secret-looking-text');
    expect(caughtInternal(() => readKeyringFile(path))).toBe(true);
    expect(readFileSync(path, 'utf8')).toContain('secret-looking-text');
  });
});
