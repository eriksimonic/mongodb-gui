import { describe, expect, it } from 'vitest';
import { VaultStatusSchema } from './vault';

describe('VaultStatusSchema', () => {
  it('accepts each vault state', () => {
    for (const state of ['uninitialised', 'locked', 'unlocked']) {
      expect(VaultStatusSchema.safeParse({ state }).success).toBe(true);
    }
  });

  it('rejects an unknown state', () => {
    expect(VaultStatusSchema.safeParse({ state: 'open' }).success).toBe(false);
  });
});
