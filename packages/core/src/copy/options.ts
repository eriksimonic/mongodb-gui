import { z } from 'zod';
import { CollectionNameSchema, DatabaseNameSchema } from '../management/types';
import { AppErrorSchema } from '../schemas/errors';
import { CopyFindingCodeSchema } from './assess';

// Replace drops the target collection first. Merge upserts by _id. Insert only skips existing _ids.
export const CopyModeSchema = z.enum(['replace', 'merge', 'insertOnly']);
export const CopyItemSchema = z.object({
  // Collection names in the source and target databases.
  source: CollectionNameSchema,
  target: CollectionNameSchema,
  // Canonical EJSON object that selects the documents. Undefined copies all of them.
  filter: z
    .string()
    .max(64 * 1024)
    .optional(),
});
export const CopyOptionsSchema = z
  .object({
    sourceConnectionId: z.uuid(),
    targetConnectionId: z.uuid(),
    sourceDatabase: DatabaseNameSchema,
    targetDatabase: DatabaseNameSchema,
    items: z.array(CopyItemSchema).min(1).max(5000),
    mode: CopyModeSchema,
    // Finding codes the user accepted in the dialog. A confirmable finding needs its code here.
    acknowledged: z.array(CopyFindingCodeSchema).default([]),
    // The typed target database name when the target connection is production. The main process
    // checks it before the copy starts.
    confirmation: z.string().max(200).optional(),
  })
  .superRefine((input, ctx) => {
    // Both items would write the same target collection. Names compare exactly.
    const seen = new Set<string>();
    input.items.forEach((item, index) => {
      if (seen.has(item.target)) {
        ctx.addIssue({
          code: 'custom',
          message: `Two items write to the collection ${item.target}`,
          path: ['items', index, 'target'],
        });
      }
      seen.add(item.target);
    });
  });
export const CopyProgressSchema = z.object({
  phase: z.enum(['preparing', 'copying', 'finished']),
  documents: z.number().int().min(0),
  totalDocuments: z.number().int().min(0).optional(),
  collectionsDone: z.number().int().min(0),
  collectionsTotal: z.number().int().min(0),
  // Target name of the collection being written.
  current: z.string().max(400).optional(),
  failedDocuments: z.number().int().min(0),
  // Insert only: documents whose _id already existed in the target.
  skippedDocuments: z.number().int().min(0),
  // New redacted tool lines since the previous event.
  lines: z.array(z.string().max(2000)).max(100),
  // Facts the user needs to read at the end, such as a time series collection filled in place.
  notes: z.array(z.string().max(400)).max(50).optional(),
  elapsedMs: z.number().min(0),
  done: z.boolean(),
  cancelled: z.boolean(),
  error: AppErrorSchema.optional(),
});

export type CopyMode = z.infer<typeof CopyModeSchema>;
export type CopyItem = z.infer<typeof CopyItemSchema>;
export type CopyOptions = z.infer<typeof CopyOptionsSchema>;
export type CopyProgress = z.infer<typeof CopyProgressSchema>;
