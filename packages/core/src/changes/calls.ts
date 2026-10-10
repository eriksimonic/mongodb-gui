import { z } from 'zod';
import { AppErrorSchema } from '../schemas/errors';
import {
  ChangeEventSchema,
  ChangeTargetSchema,
  ChangeWatchOptionsSchema,
  ChangeWatchPhaseSchema,
} from './types';

// Events per changes:event push. The router flushes a batch when it is full or at the end of the tick.
export const CHANGE_EVENT_BATCH_LIMIT = 50;

// The phases the renderer sees. 'resuming' is sent while a paused watch flushes its buffer.
export const ChangeWatchPushPhaseSchema = z.enum([...ChangeWatchPhaseSchema.options, 'resuming']);

export const ChangeWatchStartInputSchema = z.object({
  connectionId: z.uuid(),
  target: ChangeTargetSchema,
  options: ChangeWatchOptionsSchema,
});

export const ChangeWatchStartedSchema = z.object({ watchId: z.uuid() });

export const ChangeWatchIdInputSchema = z.object({ watchId: z.uuid() });

// The payload of a changes:state push. It carries no URI: errors are redacted before they are sent.
export const ChangeWatchPushStateSchema = z.object({
  phase: ChangeWatchPushPhaseSchema,
  eventsSeen: z.number().int().nonnegative(),
  eventsDropped: z.number().int().nonnegative(),
  error: AppErrorSchema.optional(),
});

export const ChangeEventsPushSchema = z.object({
  watchId: z.uuid(),
  events: z.array(ChangeEventSchema).min(1).max(CHANGE_EVENT_BATCH_LIMIT),
});

export type ChangeWatchStartInput = z.input<typeof ChangeWatchStartInputSchema>;
export type ChangeWatchPushState = z.infer<typeof ChangeWatchPushStateSchema>;
export type ChangeWatchPushPhase = z.infer<typeof ChangeWatchPushPhaseSchema>;
