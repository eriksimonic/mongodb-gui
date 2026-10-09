import { z } from 'zod';
import { DockerMongoContainerSummarySchema } from '../docker/types';
import { MonitorSampleSchema } from '../monitor/schemas';
import { ProfileEntrySchema } from '../profiler/types';
import { UpdateStateSchema } from '../updates/types';
import { AppErrorSchema } from './errors';
import { ConnectionStatusSchema } from './connection';
import { TransferIdSchema, TransferKindSchema } from '../transfer/calls';
import { TransferProgressSchema } from '../transfer/types';
import { ShellRuntimeStateSchema } from '../shell/rpc-schemas';

export const RpcEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('connection:status'),
    connectionId: z.uuid(),
    status: ConnectionStatusSchema,
  }),
  z.object({ type: z.literal('vault:locked') }),
  // One line of printed output from a running shell evaluation. The text is user data.
  z.object({
    type: z.literal('shell:print'),
    connectionId: z.uuid(),
    requestId: z.uuid(),
    text: z.string(),
  }),
  z.object({
    type: z.literal('shell:state'),
    connectionId: z.uuid(),
    state: ShellRuntimeStateSchema,
  }),
  // Sent after a successful mutating call. The tree and open panels reload what the scope names.
  z.object({
    type: z.literal('catalog:changed'),
    connectionId: z.uuid(),
    database: z.string().min(1).optional(),
    collection: z.string().min(1).optional(),
  }),
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
