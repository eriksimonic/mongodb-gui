import { describe, expect, it } from 'vitest';
import { defaultSettings } from '../domain/settings';
import { SettingsPatchSchema, SettingsSchema } from './settings';

describe('SettingsSchema', () => {
  it('accepts the default settings', () => {
    expect(SettingsSchema.safeParse(defaultSettings).success).toBe(true);
  });

  it('rejects an unknown theme', () => {
    expect(SettingsSchema.safeParse({ ...defaultSettings, theme: 'blue' }).success).toBe(false);
  });

  it('rejects a zero idle lock timeout', () => {
    expect(SettingsSchema.safeParse({ ...defaultSettings, idleLockMinutes: 0 }).success).toBe(
      false,
    );
  });
});

describe('SettingsPatchSchema', () => {
  it('accepts a partial patch', () => {
    expect(SettingsPatchSchema.safeParse({ theme: 'light' }).success).toBe(true);
  });

  it('rejects a patch with an invalid value', () => {
    expect(SettingsPatchSchema.safeParse({ sampleSize: -5 }).success).toBe(false);
  });
});
