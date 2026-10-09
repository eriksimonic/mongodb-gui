import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const MIN_SEALED_BYTES = NONCE_BYTES + TAG_BYTES;

export type DecryptFailure = 'truncated' | 'authentication';

export class DecryptError extends Error {
  readonly reason: DecryptFailure;

  constructor(reason: DecryptFailure) {
    super(
      reason === 'truncated'
        ? 'ciphertext is shorter than the nonce and tag'
        : 'ciphertext failed authentication',
    );
    this.name = 'DecryptError';
    this.reason = reason;
  }
}

/** Encrypts with AES-256-GCM and returns nonce(12) || ciphertext || tag(16). */
export function seal(key: Buffer, plaintext: Buffer, aad: Buffer): Buffer {
  assertKey(key);
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(aad);
  let head: Buffer | undefined;
  let tail: Buffer | undefined;
  try {
    head = cipher.update(plaintext);
    tail = cipher.final();
    return Buffer.concat([nonce, head, tail, cipher.getAuthTag()]);
  } finally {
    head?.fill(0);
    tail?.fill(0);
  }
}

/** Decrypts the output of seal. Throws DecryptError when the input is short or fails authentication. */
export function open(key: Buffer, sealed: Buffer, aad: Buffer): Buffer {
  assertKey(key);
  if (sealed.length < MIN_SEALED_BYTES) {
    throw new DecryptError('truncated');
  }
  const nonce = sealed.subarray(0, NONCE_BYTES);
  const ciphertext = sealed.subarray(NONCE_BYTES, sealed.length - TAG_BYTES);
  const tag = sealed.subarray(sealed.length - TAG_BYTES);
  const decipher = createDecipheriv(ALGORITHM, key, nonce, { authTagLength: TAG_BYTES });
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  let head: Buffer | undefined;
  let tail: Buffer | undefined;
  try {
    head = decipher.update(ciphertext);
    tail = decipher.final();
    return Buffer.concat([head, tail]);
  } catch {
    throw new DecryptError('authentication');
  } finally {
    head?.fill(0);
    tail?.fill(0);
  }
}

function assertKey(key: Buffer): void {
  if (key.length !== KEY_BYTES) {
    throw new RangeError(`AES-256 key must be ${KEY_BYTES} bytes`);
  }
}
