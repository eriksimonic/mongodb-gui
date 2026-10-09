import { z } from 'zod';
import { ConnectionStatusSchema } from './connection';
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
]);
