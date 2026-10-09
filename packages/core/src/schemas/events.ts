import { z } from 'zod';
import { ConnectionStatusSchema } from './connection';

export const RpcEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('connection:status'),
    connectionId: z.uuid(),
    status: ConnectionStatusSchema,
  }),
  z.object({ type: z.literal('vault:locked') }),
  // Sent after a successful mutating call. The tree and open panels reload what the scope names.
  z.object({
    type: z.literal('catalog:changed'),
    connectionId: z.uuid(),
    database: z.string().min(1).optional(),
    collection: z.string().min(1).optional(),
  }),
]);
