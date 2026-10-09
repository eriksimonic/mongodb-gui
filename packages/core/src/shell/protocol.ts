import { z } from 'zod';
import { AppErrorSchema } from '../schemas/errors';
import { ClusterTopologySchema } from '../schemas/connection';
import { ShellResultTypeSchema } from './result-type';
import {
  SchemaFieldSchema,
  SchemaSampleSizeSchema,
  SchemaSampleStrategySchema,
} from '../schema/types';

// Process-level messages (ready, unparseable input without an id, uncaught errors) use this id.
export const PROCESS_MESSAGE_ID = 'process';

export const MAX_BATCH_SIZE = 1000;

const RequestIdSchema = z.string().min(1);
const BatchSizeSchema = z.number().int().min(1).max(MAX_BATCH_SIZE);

export const ConnectRequestSchema = z.object({
  id: RequestIdSchema,
  kind: z.literal('connect'),
  uri: z.string().regex(/^mongodb(\+srv)?:\/\/.+/i),
  driverOptions: z.record(z.string(), z.unknown()).optional(),
  database: z.string().min(1).optional(),
});

export const EvaluateRequestSchema = z.object({
  id: RequestIdSchema,
  kind: z.literal('evaluate'),
  code: z.string(),
  batchSize: BatchSizeSchema,
  timeoutMs: z.number().int().positive().optional(),
});

export const NextRequestSchema = z.object({
  id: RequestIdSchema,
  kind: z.literal('next'),
  batchSize: BatchSizeSchema,
});

export const CancelRequestSchema = z.object({
  id: RequestIdSchema,
  kind: z.literal('cancel'),
  targetId: RequestIdSchema,
});

export const CompleteRequestSchema = z.object({
  id: RequestIdSchema,
  kind: z.literal('complete'),
  code: z.string(),
  position: z.number().int().min(0),
});

export const SampleSchemaRequestSchema = z.object({
  id: RequestIdSchema,
  kind: z.literal('sampleSchema'),
  database: z.string().min(1),
  collection: z.string().min(1),
  size: SchemaSampleSizeSchema,
  // Older requests carry no strategy. They sampled at random.
  strategy: SchemaSampleStrategySchema.default('random'),
});

export const DisconnectRequestSchema = z.object({
  id: RequestIdSchema,
  kind: z.literal('disconnect'),
});

export const ShellRequestSchema = z.discriminatedUnion('kind', [
  ConnectRequestSchema,
  EvaluateRequestSchema,
  NextRequestSchema,
  CancelRequestSchema,
  CompleteRequestSchema,
  SampleSchemaRequestSchema,
  DisconnectRequestSchema,
]);

export type ConnectRequest = z.infer<typeof ConnectRequestSchema>;
export type EvaluateRequest = z.infer<typeof EvaluateRequestSchema>;
export type NextRequest = z.infer<typeof NextRequestSchema>;
export type CancelRequest = z.infer<typeof CancelRequestSchema>;
export type CompleteRequest = z.infer<typeof CompleteRequestSchema>;
export type SampleSchemaRequest = z.infer<typeof SampleSchemaRequestSchema>;
export type DisconnectRequest = z.infer<typeof DisconnectRequestSchema>;
export type ShellRequest = z.infer<typeof ShellRequestSchema>;

export const CompletionKindSchema = z.enum([
  'method',
  'property',
  'collection',
  'database',
  'operator',
  'keyword',
  'other',
]);

export type CompletionKind = z.infer<typeof CompletionKindSchema>;

const ResponseBase = { id: RequestIdSchema };

export const ReadyResponseSchema = z.object({
  ...ResponseBase,
  kind: z.literal('ready'),
});

export const ConnectedResponseSchema = z.object({
  ...ResponseBase,
  kind: z.literal('connected'),
  serverVersion: z.string(),
  topology: ClusterTopologySchema,
});

export const PrintResponseSchema = z.object({
  ...ResponseBase,
  kind: z.literal('print'),
  text: z.string(),
});

export const ResultResponseSchema = z.object({
  ...ResponseBase,
  kind: z.literal('result'),
  type: ShellResultTypeSchema,
  printableEjson: z.string(),
  hasMore: z.boolean(),
  // Set on cursor results. It is the id of the evaluate that opened the cursor, so "next" is offered
  // only for that cursor.
  cursorRequestId: RequestIdSchema.optional(),
  elapsedMs: z.number().min(0),
});

export const CompletionItemSchema = z.object({
  text: z.string(),
  kind: CompletionKindSchema,
});

export const CompletionsResponseSchema = z.object({
  ...ResponseBase,
  kind: z.literal('completions'),
  items: z.array(CompletionItemSchema),
});

export const SchemaResponseSchema = z.object({
  ...ResponseBase,
  kind: z.literal('schema'),
  fields: z.array(SchemaFieldSchema),
  sampled: z.number().int().min(0),
});

export const ErrorResponseSchema = z.object({
  ...ResponseBase,
  kind: z.literal('error'),
  error: AppErrorSchema,
});

export const DoneResponseSchema = z.object({
  ...ResponseBase,
  kind: z.literal('done'),
});

export const ShellResponseSchema = z.discriminatedUnion('kind', [
  ReadyResponseSchema,
  ConnectedResponseSchema,
  PrintResponseSchema,
  ResultResponseSchema,
  CompletionsResponseSchema,
  SchemaResponseSchema,
  ErrorResponseSchema,
  DoneResponseSchema,
]);

export type ReadyResponse = z.infer<typeof ReadyResponseSchema>;
export type ConnectedResponse = z.infer<typeof ConnectedResponseSchema>;
export type PrintResponse = z.infer<typeof PrintResponseSchema>;
export type ResultResponse = z.infer<typeof ResultResponseSchema>;
export type CompletionItem = z.infer<typeof CompletionItemSchema>;
export type CompletionsResponse = z.infer<typeof CompletionsResponseSchema>;
export type SchemaResponse = z.infer<typeof SchemaResponseSchema>;
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;
export type DoneResponse = z.infer<typeof DoneResponseSchema>;
export type ShellResponse = z.infer<typeof ShellResponseSchema>;
