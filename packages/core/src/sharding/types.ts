import { z } from 'zod';
import { DatabaseNameSchema, ExistingCollectionNameSchema } from '../management/types';

const SYSTEM_PREFIX = 'system.';
const HH_MM_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const HH_MM_MESSAGE = 'Times use the HH:MM form, 00:00 to 23:59';

const DocumentSchema = z.record(z.string(), z.unknown());

// Namespace in "database.collection" form. The collection part may contain dots.
export const ShardNamespaceSchema = z.string().superRefine((ns, context) => {
  const dot = ns.indexOf('.');
  if (dot <= 0 || !DatabaseNameSchema.safeParse(ns.slice(0, dot)).success) {
    context.addIssue({ code: 'custom', message: 'The namespace must be database.collection' });
    return;
  }
  const collection = ns.slice(dot + 1);
  if (collection.startsWith(SYSTEM_PREFIX)) {
    context.addIssue({
      code: 'custom',
      message: 'System collections cannot be sharded or moved',
    });
    return;
  }
  if (!ExistingCollectionNameSchema.safeParse(collection).success) {
    context.addIssue({ code: 'custom', message: 'The namespace must be database.collection' });
  }
});

export const ShardInfoSchema = z.object({
  id: z.string().min(1),
  host: z.string().min(1),
  state: z.number().int().optional(),
  tags: z.array(z.string()),
  draining: z.boolean().optional(),
});

export const ShardedDatabaseSchema = z.object({
  name: z.string().min(1),
  primaryShard: z.string(),
  partitioned: z.boolean(),
  version: z.unknown().optional(),
});

export const ShardedCollectionSchema = z.object({
  ns: z.string().min(1),
  key: DocumentSchema,
  unique: z.boolean(),
  chunkCount: z.number().int().nonnegative(),
  chunksPerShard: z.record(z.string(), z.number().int().nonnegative()),
  dropped: z.boolean().optional(),
  timestamp: z.string().optional(),
  balancing: z.boolean(),
  dataSizeBytes: z.number().nonnegative().optional(),
  docCount: z.number().int().nonnegative().optional(),
  avgChunkSizeBytes: z.number().nonnegative().optional(),
});

export const BalancerWindowSchema = z.object({
  start: z.string(),
  stop: z.string(),
});

export const BalancerStatusSchema = z.object({
  mode: z.enum(['full', 'off']),
  inBalancerRound: z.boolean(),
  numBalancerRounds: z.number().int().nonnegative().optional(),
  activeWindow: BalancerWindowSchema.optional(),
});

export const ZoneRangeSchema = z.object({
  ns: z.string().min(1),
  min: z.unknown(),
  max: z.unknown(),
});

export const ZoneInfoSchema = z.object({
  zone: z.string().min(1),
  shards: z.array(z.string()),
  ranges: z.array(ZoneRangeSchema),
});

export const ShardingOverviewSchema = z.object({
  isSharded: z.boolean(),
  mongosHost: z.string().optional(),
  shards: z.array(ShardInfoSchema),
  databases: z.array(ShardedDatabaseSchema),
  collections: z.array(ShardedCollectionSchema),
  balancer: BalancerStatusSchema.optional(),
  zones: z.array(ZoneInfoSchema),
  clusterId: z.string().optional(),
});

export const ShardDistributionShardSchema = z.object({
  shard: z.string().min(1),
  documents: z.number().int().nonnegative(),
  sizeBytes: z.number().nonnegative(),
  chunks: z.number().int().nonnegative(),
  documentPercent: z.number().min(0).max(100),
});

export const ShardDistributionSchema = z.object({
  ns: z.string().min(1),
  totalDocuments: z.number().int().nonnegative(),
  totalSizeBytes: z.number().nonnegative(),
  shards: z.array(ShardDistributionShardSchema),
});

export const EnableShardingInputSchema = z.object({
  database: DatabaseNameSchema,
  primaryShard: z.string().min(1).optional(),
});

// The key is Extended JSON, for example {"customerId": "hashed"}. The adapter checks its values.
export const ShardCollectionInputSchema = z.object({
  database: DatabaseNameSchema,
  collection: ExistingCollectionNameSchema,
  keyEjson: z.string().min(1),
  unique: z.boolean().optional(),
  numInitialChunks: z.number().int().positive().optional(),
  presplitHashedZones: z.boolean().optional(),
});

export const BalancerWindowInputSchema = z.object({
  start: z.string().regex(HH_MM_PATTERN, { message: HH_MM_MESSAGE }),
  stop: z.string().regex(HH_MM_PATTERN, { message: HH_MM_MESSAGE }),
});

export const MoveChunkInputSchema = z.object({
  ns: ShardNamespaceSchema,
  findEjson: z.string().min(1),
  toShard: z.string().min(1),
});

export const AddShardToZoneInputSchema = z.object({
  shard: z.string().min(1),
  zone: z.string().min(1),
});

export const RemoveShardFromZoneInputSchema = AddShardToZoneInputSchema;

export const UpdateZoneKeyRangeInputSchema = z.object({
  ns: ShardNamespaceSchema,
  minEjson: z.string().min(1),
  maxEjson: z.string().min(1),
  zone: z.string().min(1).nullable(),
});

// Removing a shard drains its data. The adapter starts the drain only when confirmDraining is true.
export const RemoveShardInputSchema = z.object({
  shard: z.string().min(1),
  confirmDraining: z.boolean().optional(),
});

export const RemoveShardStatusSchema = z.object({
  shard: z.string().min(1),
  host: z.string().min(1),
  shardCount: z.number().int().positive(),
  dryRun: z.boolean(),
  wouldDrain: z.boolean(),
  state: z.enum(['started', 'ongoing', 'completed']).optional(),
  message: z.string().optional(),
  remainingChunks: z.number().int().nonnegative().optional(),
  remainingDatabases: z.number().int().nonnegative().optional(),
  remainingJumbo: z.number().int().nonnegative().optional(),
  databasesToMove: z.array(z.string()).optional(),
});

export type ShardInfo = z.infer<typeof ShardInfoSchema>;
export type ShardedDatabase = z.infer<typeof ShardedDatabaseSchema>;
export type ShardedCollection = z.infer<typeof ShardedCollectionSchema>;
export type BalancerWindow = z.infer<typeof BalancerWindowSchema>;
export type BalancerStatus = z.infer<typeof BalancerStatusSchema>;
export type ZoneRange = z.infer<typeof ZoneRangeSchema>;
export type ZoneInfo = z.infer<typeof ZoneInfoSchema>;
export type ShardingOverview = z.infer<typeof ShardingOverviewSchema>;
export type ShardDistributionShard = z.infer<typeof ShardDistributionShardSchema>;
export type ShardDistribution = z.infer<typeof ShardDistributionSchema>;
export type EnableShardingInput = z.infer<typeof EnableShardingInputSchema>;
export type ShardCollectionInput = z.infer<typeof ShardCollectionInputSchema>;
export type BalancerWindowInput = z.infer<typeof BalancerWindowInputSchema>;
export type MoveChunkInput = z.infer<typeof MoveChunkInputSchema>;
export type AddShardToZoneInput = z.infer<typeof AddShardToZoneInputSchema>;
export type RemoveShardFromZoneInput = z.infer<typeof RemoveShardFromZoneInputSchema>;
export type UpdateZoneKeyRangeInput = z.infer<typeof UpdateZoneKeyRangeInputSchema>;
export type RemoveShardInput = z.infer<typeof RemoveShardInputSchema>;
export type RemoveShardStatus = z.infer<typeof RemoveShardStatusSchema>;

/** One key field. 1 and -1 are ranged keys, "hashed" is a hashed key. */
export const ShardKeyValueSchema = z.union([z.literal(1), z.literal(-1), z.literal('hashed')]);

export const ShardKeySchema = z.record(z.string().min(1), ShardKeyValueSchema);

export const ShardCollectionSummarySchema = z.object({
  namespace: z.string().min(1),
  key: ShardKeySchema,
  keyText: z.string().min(1),
  unique: z.boolean(),
  presplitHashedZones: z.boolean(),
  numInitialChunks: z.number().int().positive().optional(),
  steps: z.array(z.string().min(1)),
  /** Problems the server would hit that do not refuse the dry run, such as a missing supporting index. */
  warnings: z.array(z.string().min(1)),
});

/** The dry run result always carries the summary. applied is true only after a confirmed call. */
export const ShardCollectionOutputSchema = z.object({
  applied: z.boolean(),
  summary: ShardCollectionSummarySchema,
});

/** The contract input for shardCollection. The summary is built first, and the server runs only when confirmed is true. */
export const ShardCollectionCallSchema = ShardCollectionInputSchema.extend({
  confirmed: z.boolean(),
});

export const SetBalancerInputSchema = z.object({ enabled: z.boolean() });

export type ShardKeyValue = z.infer<typeof ShardKeyValueSchema>;
export type ShardKey = z.infer<typeof ShardKeySchema>;
export type ShardCollectionSummary = z.infer<typeof ShardCollectionSummarySchema>;
export type ShardCollectionOutput = z.infer<typeof ShardCollectionOutputSchema>;
export type ShardCollectionCall = z.infer<typeof ShardCollectionCallSchema>;
export type SetBalancerInput = z.infer<typeof SetBalancerInputSchema>;
