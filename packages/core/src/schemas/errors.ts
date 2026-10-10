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
  'NOT_FOUND',
  'CANCELLED',
  'INTERNAL',
]);

export const AppErrorSchema = z.object({
  code: AppErrorCodeSchema,
  message: z.string(),
  detail: z.string().optional(),
  cause: z.string().optional(),
  // The server's error name, such as NotYetInitialized, when the server rejected a command.
  // Only a plain identifier, so the field can never carry a message or a URI.
  codeName: z
    .string()
    .regex(/^[A-Za-z0-9_]{1,64}$/)
    .optional(),
});
