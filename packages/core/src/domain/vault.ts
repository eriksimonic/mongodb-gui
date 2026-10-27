import type { z } from 'zod';
import type {
  DeviceKeyAvailabilitySchema,
  VaultModeSchema,
  VaultStatusSchema,
} from '../schemas/vault';

export type VaultStatus = z.infer<typeof VaultStatusSchema>;
export type VaultMode = z.infer<typeof VaultModeSchema>;
export type DeviceKeyAvailability = z.infer<typeof DeviceKeyAvailabilitySchema>;
