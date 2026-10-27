import { describe, expect, it } from 'vitest';
import { DeviceKeyAvailabilitySchema, VaultStatusSchema } from './vault';

describe('VaultStatusSchema', () => {
  it('accepts each vault state', () => {
    for (const state of ['uninitialised', 'locked', 'unlocked']) {
      expect(VaultStatusSchema.safeParse({ state }).success).toBe(true);
    }
  });

  it('rejects an unknown state', () => {
    expect(VaultStatusSchema.safeParse({ state: 'open' }).success).toBe(false);
  });

  it('accepts each mode and accepts a missing mode', () => {
    expect(VaultStatusSchema.safeParse({ state: 'locked' }).success).toBe(true);
    for (const mode of ['password', 'device']) {
      expect(VaultStatusSchema.safeParse({ state: 'unlocked', mode }).success).toBe(true);
    }
  });

  it('rejects an unknown mode', () => {
    expect(VaultStatusSchema.safeParse({ state: 'locked', mode: 'card' }).success).toBe(false);
  });
});

describe('DeviceKeyAvailabilitySchema', () => {
  it('accepts availability with and without a reason', () => {
    expect(DeviceKeyAvailabilitySchema.safeParse({ available: true }).success).toBe(true);
    for (const reason of ['no-encryption', 'basic-text', 'unknown-backend']) {
      expect(DeviceKeyAvailabilitySchema.safeParse({ available: false, reason }).success).toBe(
        true,
      );
    }
  });

  it('rejects an unknown reason', () => {
    expect(
      DeviceKeyAvailabilitySchema.safeParse({ available: false, reason: 'locked' }).success,
    ).toBe(false);
  });
});
