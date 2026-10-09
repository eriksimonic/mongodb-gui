import { z } from 'zod';
import { DockerMongoContainerSummarySchema } from '../docker/types';
import { ConnectionStatusSchema } from './connection';

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
]);
