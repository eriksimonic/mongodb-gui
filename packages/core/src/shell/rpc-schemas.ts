import { z } from 'zod';
import { AppErrorSchema } from '../schemas/errors';
import { CompletionItemSchema, MAX_BATCH_SIZE } from './protocol';
import {
  SchemaFieldSchema,
  SchemaSampleSizeSchema,
  SchemaSampleStrategySchema,
} from '../schema/types';
import { ShellResultTypeSchema } from './result-type';

export const DEFAULT_BATCH_SIZE = 50;
export const DEFAULT_SAMPLE_SIZE = 100;
export const MAX_SHELL_TIMEOUT_MS = 600_000;

// The state of the runtime process that serves one connection. "stopped" means no process runs.
export const ShellRuntimeStateSchema = z.enum(['stopped', 'starting', 'ready', 'busy', 'crashed']);

export type ShellRuntimeState = z.infer<typeof ShellRuntimeStateSchema>;

const BatchSizeSchema = z.number().int().min(1).max(MAX_BATCH_SIZE);

export const ShellResultSchema = z.object({
  type: ShellResultTypeSchema,
  printableEjson: z.string(),
  hasMore: z.boolean(),
  // Set on cursor results. Pass it as the requestId of "next" to read the following batch.
  cursorRequestId: z.uuid().optional(),
});

export type ShellResult = z.infer<typeof ShellResultSchema>;

// The outcome of evaluate and next. A script error is reported in error, not thrown, so the
// caller can show it next to the statement that failed.
export const ShellEvaluationSchema = z.object({
  requestId: z.uuid(),
  result: ShellResultSchema.optional(),
  error: AppErrorSchema.optional(),
  elapsedMs: z.number().min(0),
});

export type ShellEvaluation = z.infer<typeof ShellEvaluationSchema>;

export const ShellEvaluateInputSchema = z.object({
  connectionId: z.uuid(),
  // Optional and chosen by the caller, so a cancel can name the request while it runs.
  requestId: z.uuid().optional(),
  database: z.string().min(1),
  code: z.string(),
  batchSize: BatchSizeSchema.default(DEFAULT_BATCH_SIZE),
  timeoutMs: z.number().int().min(100).max(MAX_SHELL_TIMEOUT_MS).optional(),
});

export const ShellNextInputSchema = z.object({
  connectionId: z.uuid(),
  requestId: z.uuid(),
  batchSize: BatchSizeSchema.default(DEFAULT_BATCH_SIZE),
});

export const ShellCancelInputSchema = z.object({
  connectionId: z.uuid(),
  requestId: z.uuid(),
});

export const ShellCompleteInputSchema = z.object({
  connectionId: z.uuid(),
  database: z.string().min(1),
  code: z.string(),
  position: z.number().int().min(0),
});

export const ShellCompletionsSchema = z.object({
  items: z.array(CompletionItemSchema),
});

export const ShellSampleSchemaInputSchema = z.object({
  connectionId: z.uuid(),
  database: z.string().min(1),
  collection: z.string().min(1),
  size: SchemaSampleSizeSchema.default(DEFAULT_SAMPLE_SIZE),
  strategy: SchemaSampleStrategySchema.default('random'),
});

export const ShellSchemaSampleSchema = z.object({
  fields: z.array(SchemaFieldSchema),
  sampled: z.number().int().min(0),
});

export const ShellConnectionInputSchema = z.object({
  connectionId: z.uuid(),
});

export const ShellStateSchema = z.object({
  state: ShellRuntimeStateSchema,
});
