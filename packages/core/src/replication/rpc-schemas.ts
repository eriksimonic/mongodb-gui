import { z } from 'zod';
import {
  FreezeInputSchema,
  InitiateInputSchema,
  ReconfigChangeSchema,
  ReconfigPlanSchema,
  ReplicaSetConfigSchema,
  ReplicaSetStatusSchema,
} from './types';

const connectionId = z.uuid();

// The server refuses a step-down that is not longer than the secondary catch-up period, which it
// defaults to 10 seconds. The shortest step-down the UI offers is therefore 11 seconds.
export const MIN_STEP_DOWN_SECONDS = 11;
// The longest step-down the UI offers. A step-down that long leaves the set without a primary for
// most of an hour.
export const MAX_STEP_DOWN_SECONDS = 3600;

export const ReplicationConnectionInputSchema = z.object({ connectionId });

export const ReplicationStepDownInputSchema = z.object({
  connectionId,
  stepDownSeconds: z
    .number()
    .int()
    .min(MIN_STEP_DOWN_SECONDS)
    .max(MAX_STEP_DOWN_SECONDS)
    .default(60),
});

export const ReplicationStepDownOutputSchema = z.object({
  // The member that became primary, as the set reports it.
  primary: z.string().min(1),
});

export const ReplicationFreezeInputSchema = z.object({
  connectionId,
  seconds: FreezeInputSchema.shape.seconds,
});

export const ReplicationPlanInputSchema = z.object({
  connectionId,
  change: ReconfigChangeSchema,
});

export const ReplicationPlanOutputSchema = z.object({
  // Identifies the plan in the main process. Applying it sends the id, never the plan itself.
  planId: z.uuid(),
  plan: ReconfigPlanSchema,
});

export const ReplicationApplyInputSchema = z.object({
  connectionId,
  planId: z.uuid(),
  // The configuration version the plan was made from. A mismatch refuses the apply.
  expectedVersion: z.number().int().positive(),
});

export const ReplicationInitiateInputSchema = z.object({ connectionId }).and(InitiateInputSchema);

export const ReplicationStatusOutputSchema = ReplicaSetStatusSchema;

export const ReplicationSelfOutputSchema = z.object({
  // The host the node names itself by, or null when the reply does not name one.
  host: z.string().min(1).nullable(),
});
export const ReplicationConfigOutputSchema = ReplicaSetConfigSchema;
