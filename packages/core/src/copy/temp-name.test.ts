import { describe, expect, it } from 'vitest';
import { tempCollectionName } from './temp-name';

const JOB = '6f1c2b1e-8a2d-4c3b-9e1f-0a1b2c3d4e5f';
const PREFIX = `__copy_${JOB}_`;

describe('tempCollectionName', () => {
  it('keeps the job id and a short target name', () => {
    expect(tempCollectionName('shop', 'orders', JOB)).toBe(`${PREFIX}orders`);
  });

  it('cuts a long target so the namespace stays within 255 bytes', () => {
    const name = tempCollectionName('shop', 'a'.repeat(300), JOB);
    expect(`shop.${name}`.length).toBeLessThanOrEqual(255);
    expect(name.startsWith(PREFIX)).toBe(true);
  });

  it('cuts a multi-byte target on a character boundary', () => {
    // 255 - 4 (shop) - 1 (dot) - 44 (prefix) = 206 bytes left. Each euro sign is 3 bytes.
    expect(tempCollectionName('shop', '€'.repeat(100), JOB)).toBe(`${PREFIX}${'€'.repeat(68)}`);
  });
});
