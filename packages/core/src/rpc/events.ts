import type { z } from 'zod';
import type { RpcEventSchema } from '../schemas/events';

export type RpcEvent = z.infer<typeof RpcEventSchema>;
