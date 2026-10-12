import { z } from 'zod';

/** Version strings shown on the About panel. */
export const AppVersionsSchema = z.object({
  app: z.string(),
  electron: z.string(),
  chrome: z.string(),
  node: z.string(),
});

export type AppVersions = z.infer<typeof AppVersionsSchema>;

/** Options Electron reads before the vault opens, so they live in a plain file next to it. */
export const StartupSettingsSchema = z.object({ disableGpu: z.boolean() });
export type StartupSettings = z.infer<typeof StartupSettingsSchema>;
