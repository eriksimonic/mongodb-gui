import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { AppErrorException, appError, type VaultMode } from '@mongo-gui/core';
import { SCRYPT_MAX_MEMORY } from '../crypto/kdf';

const SALT_BYTES = 32;
const WRAPPED_DEK_BYTES = 12 + 32 + 16;
const MAX_SCRYPT_N = 2 ** 30;
// The safeStorage output length varies by platform, so the device field is bounded, not fixed.
const MAX_DEVICE_WRAPPED_BYTES = 4096;

/** Accepts only the canonical base64 form of between `minBytes` and `maxBytes` bytes. */
function canonicalBase64(minBytes: number, maxBytes = minBytes): z.ZodString {
  return z.string().refine((text) => {
    const decoded = Buffer.from(text, 'base64');
    return (
      decoded.length >= minBytes &&
      decoded.length <= maxBytes &&
      decoded.toString('base64') === text
    );
  });
}

const KdfSchema = z
  .object({
    salt: canonicalBase64(SALT_BYTES),
    N: z
      .number()
      .int()
      .min(2)
      .max(MAX_SCRYPT_N)
      .refine((n) => (n & (n - 1)) === 0),
    r: z.number().int().positive(),
    p: z.number().int().positive(),
  })
  .strict()
  // OpenSSL allocates 128 * r * (N + 2 + p) bytes, so this is the exact bound.
  .refine((kdf) => 128 * kdf.r * (kdf.N + 2 + kdf.p) <= SCRYPT_MAX_MEMORY);

/** Version 1: the DEK is wrapped by a scrypt key from the master password. */
const PasswordKeyringSchema = z
  .object({
    version: z.literal(1),
    kdf: KdfSchema,
    wrappedDek: canonicalBase64(WRAPPED_DEK_BYTES),
  })
  .strict();

/** Version 2: the DEK is wrapped by safeStorage for the current OS user. */
const DeviceKeyringSchema = z
  .object({
    version: z.literal(2),
    mode: z.literal('device'),
    wrappedDek: canonicalBase64(1, MAX_DEVICE_WRAPPED_BYTES),
  })
  .strict();

export const KeyringFileSchema = z.discriminatedUnion('version', [
  PasswordKeyringSchema,
  DeviceKeyringSchema,
]);

/** The on-disk keyring. The wrapped DEK doubles as the password verifier in version 1. */
export type PasswordKeyring = z.infer<typeof PasswordKeyringSchema>;
export type DeviceKeyring = z.infer<typeof DeviceKeyringSchema>;
export type KeyringFile = PasswordKeyring | DeviceKeyring;

export function keyringMode(keyring: KeyringFile): VaultMode {
  return keyring.version === 1 ? 'password' : 'device';
}

/**
 * Validates an unknown value as a keyring file. Throws INTERNAL with one fixed message,
 * so zod issue text and file contents never reach the caller.
 */
export function parseKeyringFile(value: unknown): KeyringFile {
  const result = KeyringFileSchema.safeParse(value);
  if (!result.success) {
    throw malformed();
  }
  return result.data;
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

/**
 * Writes the keyring to a temporary file, flushes it, renames it over the target, and
 * flushes the directory so the rename survives a crash.
 */
export function writeKeyringFile(path: string, keyring: KeyringFile): void {
  const temporary = `${path}.tmp`;
  rmSync(temporary, { force: true });
  const fd = openSync(temporary, 'w', 0o600);
  try {
    writeFileSync(fd, JSON.stringify(keyring, null, 2));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
  fsyncDirectory(dirname(path));
}

/** Deletes the keyring and any leftover temporary file from an interrupted write. */
export function removeKeyringFile(path: string): void {
  rmSync(path, { force: true });
  rmSync(`${path}.tmp`, { force: true });
}

function fsyncDirectory(dir: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(dir, 'r');
    fsyncSync(fd);
  } catch {
    // Directory fsync is not supported on every platform (for example Windows).
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
    }
  }
}

function malformed(): AppErrorException {
  return new AppErrorException(appError('INTERNAL', 'malformed keyring'));
}
