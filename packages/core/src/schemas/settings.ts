import { z } from 'zod';
import { EditorLanguageSchema } from '../domain/editor-language';

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
  treeDensity: z.enum(['compact', 'comfortable']),
  editorLanguage: EditorLanguageSchema,
  mongoToolsVersion: z.string().regex(/^(auto|\d{1,4}\.\d{1,4}\.\d{1,4})$/),
});

export const SettingsPatchSchema = SettingsSchema.partial();
