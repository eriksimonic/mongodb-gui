import { z } from 'zod';
import { DockerMongoContainerSummarySchema } from '../docker/types';
import { MonitorSampleSchema } from '../monitor/schemas';
import { AppErrorSchema } from './errors';
import { ConnectionStatusSchema } from './connection';
import { UpdateStateSchema } from '../updates/types';
import { TransferIdSchema, TransferKindSchema } from '../transfer/calls';
import { TransferProgressSchema } from '../transfer/types';

export const RpcEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('connection:status'),
    connectionId: z.uuid(),
    status: ConnectionStatusSchema,
  }),
  z.object({ type: z.literal('vault:locked') }),
  z.object({
    type: z.literal('docker:containers'),
    containers: z.array(DockerMongoContainerSummarySchema),
  }),
  z.object({ type: z.literal('updates:state'), state: UpdateStateSchema }),
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
  z.object({
    type: z.literal('transfer:progress'),
    transferId: TransferIdSchema,
    kind: TransferKindSchema,
    progress: TransferProgressSchema,
  }),
]);
