import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { AppErrorException, appError } from '@mongo-gui/core';

const SALT_BYTES = 32;
const WRAPPED_DEK_BYTES = 12 + 32 + 16;
const MAX_SCRYPT_N = 2 ** 30;

/** The on-disk keyring. The wrapped DEK doubles as the password verifier. */
export interface KeyringFile {
  readonly version: 1;
  readonly kdf: {
    readonly salt: string;
    readonly N: number;
    readonly r: number;
    readonly p: number;
  };
  readonly wrappedDek: string;
}

/**
 * Validates an unknown value as a keyring file. Throws INTERNAL when the shape is wrong.
 * The message never echoes file contents.
 */
export function parseKeyringFile(value: unknown): KeyringFile {
  if (!isRecord(value) || value['version'] !== 1) {
    throw malformed();
  }
  const kdf = value['kdf'];
  if (!isRecord(kdf)) {
    throw malformed();
  }
  const salt = decodeBase64(kdf['salt'], SALT_BYTES);
  const wrappedDek = decodeBase64(value['wrappedDek'], WRAPPED_DEK_BYTES);
  const N = kdf['N'];
  const r = kdf['r'];
  const p = kdf['p'];
  if (
    salt === undefined ||
    wrappedDek === undefined ||
    !isPowerOfTwo(N) ||
    !isPositiveInteger(r) ||
    !isPositiveInteger(p)
  ) {
    throw malformed();
  }
  return {
    version: 1,
    kdf: { salt: salt.toString('base64'), N, r, p },
    wrappedDek: wrappedDek.toString('base64'),
  };
}

/** Reads and validates the keyring. Returns undefined when the file does not exist. */
export function readKeyringFile(path: string): KeyringFile | undefined {
  if (!existsSync(path)) {
    return undefined;
  }
  const text = readFileSync(path, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw malformed();
  }
  return parseKeyringFile(parsed);
}

/** Writes the keyring to a temporary file, flushes it, then renames it over the target. */
export function writeKeyringFile(path: string, keyring: KeyringFile): void {
  const temporary = `${path}.tmp`;
  const fd = openSync(temporary, 'w', 0o600);
  try {
    writeFileSync(fd, JSON.stringify(keyring, null, 2));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
}

function malformed(): AppErrorException {
  return new AppErrorException(appError('INTERNAL', 'The vault keyring file is malformed.'));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isPowerOfTwo(value: unknown): value is number {
  return (
    isPositiveInteger(value) && value >= 2 && value <= MAX_SCRYPT_N && (value & (value - 1)) === 0
  );
}

function decodeBase64(value: unknown, byteLength: number): Buffer | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length !== byteLength || decoded.toString('base64') !== value) {
    return undefined;
  }
  return decoded;
}
