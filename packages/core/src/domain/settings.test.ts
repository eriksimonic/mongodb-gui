import { describe, expect, it } from 'vitest';
import { SettingsSchema } from '../schemas/settings';
import { defaultSettings } from './settings';

describe('defaultSettings', () => {
  it('uses the defaults from the plan', () => {
    expect(defaultSettings).toEqual({
      theme: 'dark',
      idleLockMinutes: 30,
      historyLimit: 20000,
      editorFontSize: 13,
      sampleSize: 100,
      dockerAutoConnect: false,
      checkForUpdates: true,
      treeDensity: 'compact',
      editorLanguage: 'mongosh',
      mongoToolsVersion: 'auto',
    });
  });

  it('defaults the editor language to mongosh', () => {
    expect(defaultSettings.editorLanguage).toBe('mongosh');
  });

  it('passes its own schema', () => {
    expect(SettingsSchema.parse(defaultSettings)).toEqual(defaultSettings);
  });
});
