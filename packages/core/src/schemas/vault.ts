import { z } from 'zod';

export const VaultStatusSchema = z.object({
  state: z.enum(['uninitialised', 'locked', 'unlocked']),
});
