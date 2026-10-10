import { z } from 'zod';
import { DatabaseNameSchema } from '../management/types';
import { AppErrorSchema } from '../schemas/errors';
import { AbsolutePathSchema } from '../transfer/types';
import { Sha256Schema } from '../tools/types';

export const BackupNamespaceProgressSchema = z.object({
  namespace: z.string().max(400),
  documents: z.number().int().min(0),
  total: z.number().int().min(0).optional(),
});
export const BackupResultSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('dump'),
    outputPath: AbsolutePathSchema,
    sidecarPath: AbsolutePathSchema,
    bytes: z.number().int().min(0),
    // Archive only.
    sha256: Sha256Schema.optional(),
    documents: z.number().int().min(0),
    namespaces: z.number().int().min(0),
  }),
  z.object({
    kind: z.literal('restore'),
    dryRun: z.boolean(),
    restored: z.number().int().min(0),
    failed: z.number().int().min(0),
    // Target names.
    databases: z.array(DatabaseNameSchema),
    // Dry run only.
    plan: z.array(z.object({ from: z.string(), to: z.string() })).max(5000),
  }),
]);
export const BackupProgressSchema = z.object({
  phase: z.enum(['preparing', 'verifying', 'running', 'hashing', 'writing-sidecar', 'finished']),
  documents: z.number().int().min(0),
  totalDocuments: z.number().int().min(0).optional(),
  bytes: z.number().int().min(0),
  totalBytes: z.number().int().min(0).optional(),
  fraction: z.number().min(0).max(1).optional(),
  active: z.array(BackupNamespaceProgressSchema).max(32),
  finishedNamespaces: z.number().int().min(0),
  totalNamespaces: z.number().int().min(0).optional(),
  // Several-database dumps run one mongodump per database. These name the current one.
  currentDatabase: z.string().max(255).optional(),
  databaseIndex: z.number().int().min(1).optional(),
  databaseCount: z.number().int().min(1).optional(),
  failedDocuments: z.number().int().min(0),
  // New redacted lines since the previous event.
  lines: z.array(z.string().max(2000)).max(100),
  // New WARNING lines since the previous event.
  warnings: z.array(z.string().max(2000)).max(20),
  elapsedMs: z.number().min(0),
  done: z.boolean(),
  cancelled: z.boolean(),
  error: AppErrorSchema.optional(),
  result: BackupResultSchema.optional(),
});

export type BackupNamespaceProgress = z.infer<typeof BackupNamespaceProgressSchema>;
export type BackupResult = z.infer<typeof BackupResultSchema>;
export type BackupProgress = z.infer<typeof BackupProgressSchema>;
