import { z } from 'zod';

export const AppErrorCodeSchema = z.enum([
  'VAULT_LOCKED',
  'VAULT_BAD_PASSWORD',
  'VAULT_NOT_INITIALISED',
  'CONNECTION_NOT_FOUND',
  'CONNECTION_FAILED',
  'CONNECTION_TIMEOUT',
  'AUTH_FAILED',
  'NOT_CONNECTED',
  'COMMAND_FAILED',
  'VALIDATION',
  'CANCELLED',
  'INTERNAL',
]);

export const AppErrorSchema = z.object({
  code: AppErrorCodeSchema,
  message: z.string(),
  detail: z.string().optional(),
  cause: z.string().optional(),
});
