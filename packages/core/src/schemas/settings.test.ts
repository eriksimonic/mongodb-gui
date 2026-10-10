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

  it('accepts an idle lock of up to 24 hours and rejects more', () => {
    const idle = (idleLockMinutes: number) =>
      SettingsSchema.safeParse({ ...defaultSettings, idleLockMinutes }).success;
    expect(idle(24 * 60)).toBe(true);
    expect(idle(24 * 60 + 1)).toBe(false);
    expect(idle(1e15)).toBe(false);
  });

  it('rejects a zero idle lock timeout', () => {
    expect(SettingsSchema.safeParse({ ...defaultSettings, idleLockMinutes: 0 }).success).toBe(
      false,
    );
  });

  it('defaults the editor language to mongosh', () => {
    expect(defaultSettings.editorLanguage).toBe('mongosh');
  });

  it('accepts the mongosh and sql editor languages', () => {
    const language = (editorLanguage: string) =>
      SettingsSchema.safeParse({ ...defaultSettings, editorLanguage }).success;
    expect(language('mongosh')).toBe(true);
    expect(language('sql')).toBe(true);
  });

  it('rejects an unknown editor language', () => {
    expect(SettingsSchema.safeParse({ ...defaultSettings, editorLanguage: 'tsql' }).success).toBe(
      false,
    );
  });

  it('rejects settings that omit the editor language', () => {
    const withoutLanguage = { ...defaultSettings, editorLanguage: undefined };
    expect(SettingsSchema.safeParse(withoutLanguage).success).toBe(false);
  });
});

describe('SettingsSchema mongoToolsVersion', () => {
  const tools = (mongoToolsVersion: string) =>
    SettingsSchema.safeParse({ ...defaultSettings, mongoToolsVersion }).success;

  it('accepts auto and a version number', () => {
    expect(tools('auto')).toBe(true);
    expect(tools('100.19.1')).toBe(true);
  });

  it('rejects anything else', () => {
    expect(tools('latest')).toBe(false);
    expect(tools('100.19')).toBe(false);
    expect(tools('100.19.1-rc1')).toBe(false);
  });
});

describe('SettingsPatchSchema', () => {
  it('accepts a partial patch', () => {
    expect(SettingsPatchSchema.safeParse({ theme: 'light' }).success).toBe(true);
  });

  it('accepts a patch that changes only the editor language', () => {
    expect(SettingsPatchSchema.parse({ editorLanguage: 'sql' })).toEqual({ editorLanguage: 'sql' });
  });

  it('rejects a patch with an unknown editor language', () => {
    expect(SettingsPatchSchema.safeParse({ editorLanguage: 'xml' }).success).toBe(false);
  });

  it('rejects a patch with an invalid value', () => {
    expect(SettingsPatchSchema.safeParse({ sampleSize: -5 }).success).toBe(false);
  });
});
