import { z } from 'zod';

/** Version strings shown on the About panel. */
export const AppVersionsSchema = z.object({
  app: z.string(),
  electron: z.string(),
  chrome: z.string(),
  node: z.string(),
});

export type AppVersions = z.infer<typeof AppVersionsSchema>;
