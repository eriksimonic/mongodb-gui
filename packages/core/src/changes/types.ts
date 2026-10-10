import { z } from 'zod';
import { AppErrorSchema } from '../schemas/errors';

// The server holds an idle getMore for up to this long, and closing a watch cannot end that
// getMore early. The cap keeps close and server-side cursor cleanup under two seconds.
// Events are still delivered as soon as they arrive, so the cap only sets the idle poll rate.
export const DEFAULT_CHANGE_MAX_AWAIT_MS = 1000;
export const MAX_CHANGE_MAX_AWAIT_MS = 1000;
export const DEFAULT_CHANGE_BATCH_SIZE = 100;
export const MAX_CHANGE_BATCH_SIZE = 1000;
// Events whose BSON size exceeds this keep only their key fields and are flagged as truncated.
export const MAX_CHANGE_EVENT_BYTES = 1024 * 1024;
// Events buffered while a watch is paused. Older events are dropped first.
export const CHANGE_PAUSE_BUFFER_LIMIT = 1000;
// Byte cap for the same buffer, so paused watches on large documents stay bounded.
export const CHANGE_PAUSE_BUFFER_MAX_BYTES = 32 * 1024 * 1024;

const NameSchema = z.string().min(1);

export const ChangeTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('collection'), database: NameSchema, collection: NameSchema }),
  z.object({ kind: z.literal('database'), database: NameSchema }),
  z.object({ kind: z.literal('deployment') }),
]);

export const ChangeWatchOptionsSchema = z
  .object({
    pipelineEjson: z.string().optional(),
    fullDocument: z.enum(['default', 'updateLookup', 'whenAvailable', 'required']).optional(),
    fullDocumentBeforeChange: z.enum(['off', 'whenAvailable', 'required']).optional(),
    resumeAfterEjson: z.string().optional(),
    startAtOperationTimeEjson: z.string().optional(),
    maxAwaitTimeMs: z.number().int().min(1).max(MAX_CHANGE_MAX_AWAIT_MS).optional(),
    batchSize: z.number().int().min(1).max(MAX_CHANGE_BATCH_SIZE).optional(),
    showExpandedEvents: z.boolean().optional(),
  })
  .refine(
    (options) =>
      options.resumeAfterEjson === undefined || options.startAtOperationTimeEjson === undefined,
    { message: 'Resume from a token or from an operation time, not both' },
  );

export const ChangeNamespaceSchema = z.object({
  db: z.string(),
  coll: z.string().optional(),
});

export const ChangeEventSchema = z.object({
  id: z.string().min(1),
  clusterTimeEjson: z.string().optional(),
  wallTime: z.iso.datetime().optional(),
  operationType: z.string().min(1),
  ns: ChangeNamespaceSchema.optional(),
  documentKeyEjson: z.string().optional(),
  fullDocumentEjson: z.string().optional(),
  fullDocumentBeforeChangeEjson: z.string().optional(),
  updateDescriptionEjson: z.string().optional(),
  to: ChangeNamespaceSchema.optional(),
  txnNumber: z.number().int().nonnegative().optional(),
  lsidEjson: z.string().optional(),
  resumeTokenEjson: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  rawEjson: z.string(),
  truncated: z.boolean().optional(),
});

export const ChangeWatchPhaseSchema = z.enum(['opening', 'live', 'paused', 'closed', 'error']);

export const ChangeWatchStateSchema = z.object({
  phase: ChangeWatchPhaseSchema,
  eventsSeen: z.number().int().nonnegative(),
  eventsDropped: z.number().int().nonnegative(),
  lastResumeTokenEjson: z.string().optional(),
  error: AppErrorSchema.optional(),
  openedAt: z.iso.datetime(),
});

export type ChangeTarget = z.infer<typeof ChangeTargetSchema>;
export type ChangeWatchOptions = z.input<typeof ChangeWatchOptionsSchema>;
export type ChangeNamespace = z.infer<typeof ChangeNamespaceSchema>;
export type ChangeEvent = z.infer<typeof ChangeEventSchema>;
export type ChangeWatchPhase = z.infer<typeof ChangeWatchPhaseSchema>;
export type ChangeWatchState = z.infer<typeof ChangeWatchStateSchema>;
