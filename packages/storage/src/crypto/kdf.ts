import { scryptSync } from 'node:crypto';

export interface KdfParams {
  readonly N: number;
  readonly r: number;
  readonly p: number;
}

export const DEFAULT_KDF_PARAMS: KdfParams = { N: 2 ** 17, r: 8, p: 1 };

const KEK_BYTES = 32;
const SCRYPT_MAX_MEMORY = 256 * 1024 * 1024;

/**
 * Derives a 32-byte key-encryption key from the master password.
 * The password is NFC-normalised so the same text typed on different platforms
 * yields the same key.
 */
export function deriveKek(password: string, salt: Buffer, params: KdfParams): Buffer {
  return scryptSync(password.normalize('NFC'), salt, KEK_BYTES, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: SCRYPT_MAX_MEMORY,
  });
}
