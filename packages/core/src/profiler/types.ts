import { z } from 'zod';

export const DEFAULT_PROFILE_LIMIT = 200;
export const MAX_PROFILE_LIMIT = 5000;

export const ProfileOpSchema = z.enum([
  'query',
  'insert',
  'update',
  'remove',
  'getmore',
  'command',
  'other',
]);

export const ProfilingLevelValueSchema = z.union([z.literal(0), z.literal(1), z.literal(2)]);

export const ProfilingLevelSchema = z.object({
  level: ProfilingLevelValueSchema,
  slowMs: z.number().int().nonnegative(),
  sampleRate: z.number().min(0).max(1).optional(),
  filter: z.unknown().optional(),
});

// Input for setProfilingLevel. The level is validated at runtime because it may come from the UI.
export const SetProfilingLevelInputSchema = z.object({
  level: ProfilingLevelValueSchema,
  slowMs: z.number().int().nonnegative().optional(),
  sampleRate: z.number().min(0).max(1).optional(),
  filter: z.unknown().optional(),
});

export const ProfileEntrySchema = z.object({
  id: z.string().min(1),
  ts: z.iso.datetime(),
  ns: z.string(),
  op: ProfileOpSchema,
  millis: z.number().nonnegative(),
  command: z.unknown().optional(),
  planSummary: z.string().optional(),
  keysExamined: z.number().nonnegative().optional(),
  docsExamined: z.number().nonnegative().optional(),
  nreturned: z.number().nonnegative().optional(),
  nMatched: z.number().nonnegative().optional(),
  nModified: z.number().nonnegative().optional(),
  hasSortStage: z.boolean().optional(),
  usedDisk: z.boolean().optional(),
  queryHash: z.string().optional(),
  planCacheKey: z.string().optional(),
  client: z.string().optional(),
  appName: z.string().optional(),
  user: z.string().optional(),
  locks: z.unknown().optional(),
  storage: z.unknown().optional(),
  responseLength: z.number().nonnegative().optional(),
  errMsg: z.string().optional(),
  errCode: z.number().int().optional(),
  raw: z.unknown(),
});

export const ProfileFilterSchema = z.object({
  ns: z.string().optional(),
  op: ProfileOpSchema.optional(),
  minMillis: z.number().nonnegative().optional(),
  since: z.iso.datetime().optional(),
  until: z.iso.datetime().optional(),
  textSearch: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(MAX_PROFILE_LIMIT).optional(),
});

export const TailProfileOptionsSchema = z.object({
  since: z.iso.datetime(),
  pollMs: z.number().int().min(50).max(60_000),
  filter: ProfileFilterSchema.optional(),
});

export const QueryShapeSchema = z.object({
  key: z.string().min(1),
  ns: z.string(),
  op: ProfileOpSchema,
  count: z.number().int().positive(),
  totalMillis: z.number().nonnegative(),
  avgMillis: z.number().nonnegative(),
  maxMillis: z.number().nonnegative(),
  p95Millis: z.number().nonnegative(),
  example: ProfileEntrySchema,
  planSummaries: z.array(z.string()),
});

export type ProfileOp = z.infer<typeof ProfileOpSchema>;
export type ProfilingLevel = z.infer<typeof ProfilingLevelSchema>;
export type SetProfilingLevelInput = z.infer<typeof SetProfilingLevelInputSchema>;
export type ProfileEntry = z.infer<typeof ProfileEntrySchema>;
export type ProfileFilter = z.infer<typeof ProfileFilterSchema>;
export type TailProfileOptions = z.infer<typeof TailProfileOptionsSchema>;
export type QueryShape = z.infer<typeof QueryShapeSchema>;
