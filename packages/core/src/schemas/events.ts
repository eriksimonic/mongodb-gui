import { z } from 'zod';
import { ConnectionStatusSchema } from './connection';

export const RpcEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('connection:status'),
    connectionId: z.uuid(),
    status: ConnectionStatusSchema,
  }),
  z.object({ type: z.literal('vault:locked') }),
]);
