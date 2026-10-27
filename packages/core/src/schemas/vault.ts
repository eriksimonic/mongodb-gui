import { z } from 'zod';

export const VaultModeSchema = z.enum(['password', 'device']);

export const VaultStatusSchema = z.object({
  state: z.enum(['uninitialised', 'locked', 'unlocked']),
  mode: VaultModeSchema.optional(), // present whenever state is not 'uninitialised'
});

export const DeviceKeyAvailabilitySchema = z.object({
  available: z.boolean(),
  reason: z.enum(['no-encryption', 'basic-text', 'unknown-backend']).optional(),
});
