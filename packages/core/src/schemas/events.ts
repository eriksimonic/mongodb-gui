import { z } from 'zod';
import { ConnectionStatusSchema } from './connection';
import { ProfileEntrySchema } from '../profiler/types';
import { AppErrorSchema } from './errors';

export const RpcEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('connection:status'),
    connectionId: z.uuid(),
    status: ConnectionStatusSchema,
  }),
  z.object({ type: z.literal('vault:locked') }),
  z.object({
    type: z.literal('profiler:entries'),
    connectionId: z.uuid(),
    database: z.string().min(1),
    entries: z.array(ProfileEntrySchema),
  }),
  z.object({
    type: z.literal('profiler:error'),
    connectionId: z.uuid(),
    database: z.string().min(1),
    error: AppErrorSchema,
  }),
]);
