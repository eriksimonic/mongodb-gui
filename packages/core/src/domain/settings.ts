import type { z } from 'zod';
import type { SettingsPatchSchema, SettingsSchema } from '../schemas/settings';

export type Settings = z.infer<typeof SettingsSchema>;
export type SettingsPatch = z.infer<typeof SettingsPatchSchema>;

export const defaultSettings: Settings = {
  theme: 'dark',
  idleLockMinutes: 30,
  historyLimit: 20000,
  editorFontSize: 13,
  sampleSize: 100,
  dockerAutoConnect: false,
  checkForUpdates: true,
};
