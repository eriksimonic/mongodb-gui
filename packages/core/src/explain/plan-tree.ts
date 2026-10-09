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
  shard?: string;
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
}

export interface PlanTree {
  command: PlanCommand;
  namespace: string;
  verbosity: PlanVerbosity;
  engine: PlanEngine;
  serverVersion?: string;
  winning: PlanStage;
  rejected: PlanStage[];
  summary: PlanSummary;
  warnings: PlanWarning[];
  sharded: boolean;
}

export const PlanStageSchema: z.ZodType<PlanStage> = z.lazy(() =>
  z.object({
    name: z.string(),
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
    shard: z.exactOptional(z.string()),
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
});

export const PlanTreeSchema: z.ZodType<PlanTree> = z.object({
  command: PlanCommandSchema,
  namespace: z.string(),
  verbosity: PlanVerbositySchema,
  engine: PlanEngineSchema,
  serverVersion: z.exactOptional(z.string()),
  winning: PlanStageSchema,
  rejected: z.array(PlanStageSchema),
  summary: PlanSummarySchema,
  warnings: z.array(PlanWarningSchema),
  sharded: z.boolean(),
});
