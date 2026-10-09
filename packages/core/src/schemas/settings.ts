import { z } from 'zod';

export const SettingsSchema = z.object({
  theme: z.enum(['dark', 'light', 'system']),
  idleLockMinutes: z
    .number()
    .int()
    .positive()
    .max(24 * 60),
  historyLimit: z.number().int().positive(),
  editorFontSize: z.number().positive(),
  sampleSize: z.number().int().positive(),
  dockerAutoConnect: z.boolean(),
  checkForUpdates: z.boolean(),
});

export const SettingsPatchSchema = SettingsSchema.partial();
