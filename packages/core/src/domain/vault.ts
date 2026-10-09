import type { z } from 'zod';
import type { VaultStatusSchema } from '../schemas/vault';

export type VaultStatus = z.infer<typeof VaultStatusSchema>;
