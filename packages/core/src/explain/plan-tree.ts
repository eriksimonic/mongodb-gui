import { z } from 'zod';

export const PlanCommandSchema = z.enum([
  'find',
  'aggregate',
  'count',
  'distinct',
  'update',
  'delete',
  'unknown',
]);

export const PlanVerbositySchema = z.enum(['queryPlanner', 'executionStats', 'allPlansExecution']);

export const PlanEngineSchema = z.enum(['classic', 'sbe', 'unknown']);

export const PlanDirectionSchema = z.enum(['forward', 'backward']);

export const PlanWarningCodeSchema = z.enum([
  'COLLSCAN',
  'IN_MEMORY_SORT',
  'HIGH_EXAMINED_RATIO',
  'SORT_SPILLED',
  'FETCH_AFTER_COVERED_INDEX',
  'MANY_REJECTED_PLANS',
  'MULTIKEY_INDEX',
  'NO_EXECUTION_STATS',
  'GROUP_SPILLED',
  'ORPHANS_FILTERED',
  'LOOKUP_WITHOUT_INDEX',
  'BLOCKING_STAGE_BEFORE_MATCH',
  'UNBOUNDED_FACET',
]);

export const PlanWarningSeveritySchema = z.enum(['info', 'warning', 'critical']);

export type PlanCommand = z.infer<typeof PlanCommandSchema>;
export type PlanVerbosity = z.infer<typeof PlanVerbositySchema>;
export type PlanEngine = z.infer<typeof PlanEngineSchema>;
export type PlanDirection = z.infer<typeof PlanDirectionSchema>;
export type PlanWarningCode = z.infer<typeof PlanWarningCodeSchema>;
export type PlanWarningSeverity = z.infer<typeof PlanWarningSeveritySchema>;

// One node of the plan. `children` holds the input stages (or shard subtrees, or pipeline
// inputs). `raw` keeps the server's JSON for this node, so nothing is lost in normalisation.
export interface PlanStage {
  name: string;
  // What a sub-tree node is, for example "inner pipeline of $lookup from customers" or "shard
  // shard01". Absent on the main chain of stages.
  label?: string;
  index?: string;
  indexBounds?: Record<string, string[]>;
  direction?: PlanDirection;
  isMultiKey?: boolean;
  filter?: unknown;
  keysExamined?: number;
  docsExamined?: number;
  nReturned?: number;
  executionTimeMs?: number;
  works?: number;
  memUsageBytes?: number;
  memLimitBytes?: number;
  usedDisk?: boolean;
  // Spill counters of a sort or group, as the server reports them.
  spills?: number;
  spilledBytes?: number;
  // Documents a SHARDING_FILTER dropped because they belong to another shard's chunk.
  chunkSkips?: number;
  shard?: string;
  // Field names of the index key pattern, in order.
  indexKeys?: string[];
  // Projection of a PROJECTION_* stage, as the server reports it (transformBy).
  projection?: Record<string, unknown>;
  // Sort keys of a SORT stage or of an aggregate $sort, with directions (1 or -1).
  sortPattern?: Record<string, number>;
  children: PlanStage[];
  raw: unknown;
}

export interface PlanSummary {
  indexesUsed: string[];
  keysExamined?: number;
  docsExamined?: number;
  nReturned?: number;
  executionTimeMs?: number;
  totalDocsExaminedToReturnedRatio?: number;
  inMemorySort: boolean;
  collectionScan: boolean;
  covered?: boolean;
}

export interface PlanWarning {
  code: PlanWarningCode;
  severity: PlanWarningSeverity;
  message: string;
  stageName?: string;
  // What to do about the warning, from the stage catalogue. Absent when the stage has no advice.
  advice?: string;
}

export interface PlanTree {
  command: PlanCommand;
  namespace: string;
  verbosity: PlanVerbosity;
  engine: PlanEngine;
  serverVersion?: string;
  // The query filter, from parsedQuery or the command. For aggregates, the first $match.
  filter?: unknown;
  winning: PlanStage;
  rejected: PlanStage[];
  summary: PlanSummary;
  warnings: PlanWarning[];
  sharded: boolean;
}

export const PlanStageSchema: z.ZodType<PlanStage> = z.lazy(() =>
  z.object({
    name: z.string(),
    label: z.exactOptional(z.string()),
    index: z.exactOptional(z.string()),
    indexBounds: z.exactOptional(z.record(z.string(), z.array(z.string()))),
    direction: z.exactOptional(PlanDirectionSchema),
    isMultiKey: z.exactOptional(z.boolean()),
    filter: z.exactOptional(z.unknown()),
    keysExamined: z.exactOptional(z.number()),
    docsExamined: z.exactOptional(z.number()),
    nReturned: z.exactOptional(z.number()),
    executionTimeMs: z.exactOptional(z.number()),
    works: z.exactOptional(z.number()),
    memUsageBytes: z.exactOptional(z.number()),
    memLimitBytes: z.exactOptional(z.number()),
    usedDisk: z.exactOptional(z.boolean()),
    spills: z.exactOptional(z.number()),
    spilledBytes: z.exactOptional(z.number()),
    chunkSkips: z.exactOptional(z.number()),
    shard: z.exactOptional(z.string()),
    indexKeys: z.exactOptional(z.array(z.string())),
    projection: z.exactOptional(z.record(z.string(), z.unknown())),
    sortPattern: z.exactOptional(z.record(z.string(), z.number())),
    children: z.array(PlanStageSchema),
    raw: z.unknown(),
  }),
);

export const PlanSummarySchema: z.ZodType<PlanSummary> = z.object({
  indexesUsed: z.array(z.string()),
  keysExamined: z.exactOptional(z.number()),
  docsExamined: z.exactOptional(z.number()),
  nReturned: z.exactOptional(z.number()),
  executionTimeMs: z.exactOptional(z.number()),
  totalDocsExaminedToReturnedRatio: z.exactOptional(z.number()),
  inMemorySort: z.boolean(),
  collectionScan: z.boolean(),
  covered: z.exactOptional(z.boolean()),
});

export const PlanWarningSchema: z.ZodType<PlanWarning> = z.object({
  code: PlanWarningCodeSchema,
  severity: PlanWarningSeveritySchema,
  message: z.string(),
  stageName: z.exactOptional(z.string()),
  advice: z.exactOptional(z.string()),
});

export const PlanTreeSchema: z.ZodType<PlanTree> = z.object({
  command: PlanCommandSchema,
  namespace: z.string(),
  verbosity: PlanVerbositySchema,
  engine: PlanEngineSchema,
  serverVersion: z.exactOptional(z.string()),
  filter: z.exactOptional(z.unknown()),
  winning: PlanStageSchema,
  rejected: z.array(PlanStageSchema),
  summary: PlanSummarySchema,
  warnings: z.array(PlanWarningSchema),
  sharded: z.boolean(),
});
