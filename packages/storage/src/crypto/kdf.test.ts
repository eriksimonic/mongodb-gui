import { describe, expect, it } from 'vitest';
import { deriveKek } from './kdf';

const FAST = { N: 2 ** 10, r: 8, p: 1 };
const SALT_A = Buffer.alloc(32, 1);
const SALT_B = Buffer.alloc(32, 2);

describe('deriveKek', () => {
  it('returns the same key for the same password and salt', () => {
    const first = deriveKek('correct horse', SALT_A, FAST);
    const second = deriveKek('correct horse', SALT_A, FAST);
    expect(first.equals(second)).toBe(true);
  });

  it('returns a different key for a different salt', () => {
    const first = deriveKek('correct horse', SALT_A, FAST);
    const second = deriveKek('correct horse', SALT_B, FAST);
    expect(first.equals(second)).toBe(false);
  });

  it('returns a different key for a different password', () => {
    const first = deriveKek('correct horse', SALT_A, FAST);
    const second = deriveKek('wrong horse!', SALT_A, FAST);
    expect(first.equals(second)).toBe(false);
  });

  it('treats canonically equal passwords as the same password', () => {
    const composed = 'café battery';
    const decomposed = 'café battery';
    const first = deriveKek(composed, SALT_A, FAST);
    const second = deriveKek(decomposed, SALT_A, FAST);
    expect(first.equals(second)).toBe(true);
  });

  it('returns a 32 byte key', () => {
    expect(deriveKek('correct horse', SALT_A, FAST)).toHaveLength(32);
  });
});
