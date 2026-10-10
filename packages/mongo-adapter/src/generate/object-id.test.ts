import { describe, expect, it } from 'vitest';
import { objectIdFromHex } from './object-id';

describe('objectIdFromHex', () => {
  it('returns an ObjectId with the same hex string', () => {
    const hex = '65a1b2c3d4e5f60718293a4b';
    expect(objectIdFromHex(hex).toHexString()).toBe(hex);
  });
});
