import { describe, expect, it } from 'vitest';
import { DecryptError, open, seal } from './aead';

const KEY = Buffer.alloc(32, 7);
const OTHER_KEY = Buffer.alloc(32, 8);
const AAD = Buffer.from('connections:abc', 'utf8');
const PLAIN = Buffer.from('mongodb://user:secret@host', 'utf8');

function flipByte(buffer: Buffer, index: number): Buffer {
  const copy = Buffer.from(buffer);
  copy[index] = (copy[index] ?? 0) ^ 0xff;
  return copy;
}

function caughtError(action: () => unknown): unknown {
  try {
    action();
    return undefined;
  } catch (error) {
    return error;
  }
}

describe('seal and open', () => {
  it('round trips plaintext with the same key and AAD', () => {
    expect(open(KEY, seal(KEY, PLAIN, AAD), AAD).equals(PLAIN)).toBe(true);
  });

  it('lays out the output as nonce, ciphertext and tag', () => {
    expect(seal(KEY, PLAIN, AAD)).toHaveLength(12 + PLAIN.length + 16);
  });

  it('uses a fresh nonce for each call', () => {
    const first = seal(KEY, PLAIN, AAD).subarray(0, 12);
    const second = seal(KEY, PLAIN, AAD).subarray(0, 12);
    expect(first.equals(second)).toBe(false);
  });

  it('round trips an empty plaintext', () => {
    expect(open(KEY, seal(KEY, Buffer.alloc(0), AAD), AAD)).toHaveLength(0);
  });

  it('rejects a wrong key with DecryptError', () => {
    const sealed = seal(KEY, PLAIN, AAD);
    expect(caughtError(() => open(OTHER_KEY, sealed, AAD))).toMatchObject({
      reason: 'authentication',
    });
    expect(caughtError(() => open(OTHER_KEY, sealed, AAD))).toBeInstanceOf(DecryptError);
  });

  it('rejects a wrong AAD with DecryptError', () => {
    const sealed = seal(KEY, PLAIN, AAD);
    expect(caughtError(() => open(KEY, sealed, Buffer.from('favourites:abc')))).toBeInstanceOf(
      DecryptError,
    );
  });

  it('rejects a flipped byte in the ciphertext with DecryptError', () => {
    const sealed = seal(KEY, PLAIN, AAD);
    expect(caughtError(() => open(KEY, flipByte(sealed, 12), AAD))).toBeInstanceOf(DecryptError);
  });

  it('rejects a flipped byte in the tag with DecryptError', () => {
    const sealed = seal(KEY, PLAIN, AAD);
    const flipped = flipByte(sealed, sealed.length - 1);
    expect(caughtError(() => open(KEY, flipped, AAD))).toBeInstanceOf(DecryptError);
  });

  it('rejects input shorter than 28 bytes as truncated', () => {
    expect(caughtError(() => open(KEY, Buffer.alloc(27), AAD))).toMatchObject({
      reason: 'truncated',
    });
  });

  it('rejects a key that is not 32 bytes', () => {
    expect(() => seal(Buffer.alloc(16), PLAIN, AAD)).toThrow(RangeError);
  });
});
