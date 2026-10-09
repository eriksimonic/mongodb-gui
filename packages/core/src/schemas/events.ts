import { z } from 'zod';
import { MonitorSampleSchema } from '../monitor/schemas';
import { AppErrorSchema } from './errors';
import { ConnectionStatusSchema } from './connection';

export const RpcEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('connection:status'),
    connectionId: z.uuid(),
    status: ConnectionStatusSchema,
  }),
  z.object({ type: z.literal('vault:locked') }),
  z.object({
    type: z.literal('monitor:sample'),
    connectionId: z.uuid(),
    sample: MonitorSampleSchema,
  }),
  z.object({
    type: z.literal('monitor:error'),
    connectionId: z.uuid(),
    error: AppErrorSchema,
  }),
]);
