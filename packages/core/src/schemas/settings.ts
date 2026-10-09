import { z } from 'zod';

export const SettingsSchema = z.object({
  theme: z.enum(['dark', 'light', 'system']),
  idleLockMinutes: z.number().int().positive(),
  historyLimit: z.number().int().positive(),
  editorFontSize: z.number().positive(),
  sampleSize: z.number().int().positive(),
});

export const SettingsPatchSchema = SettingsSchema.partial();
