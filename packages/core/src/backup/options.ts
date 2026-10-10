import { z } from 'zod';
import { CollectionNameSchema, DatabaseNameSchema } from '../management/types';
import { AbsolutePathSchema } from '../transfer/types';
import { ToolsVersionSchema } from '../tools/types';
import { FindingCodeSchema } from './findings';

export const BackupScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('server') }),
  z.object({ kind: z.literal('database'), database: DatabaseNameSchema }),
  // Two or more databases. mongodump takes one --db, so the job runs one dump per database.
  z.object({
    kind: z.literal('databases'),
    databases: z.array(DatabaseNameSchema).min(2).max(1000),
  }),
  z.object({
    kind: z.literal('collection'),
    database: DatabaseNameSchema,
    collection: CollectionNameSchema,
  }),
]);
export const ReadPreferenceModeSchema = z.enum([
  'primary',
  'primaryPreferred',
  'secondary',
  'secondaryPreferred',
  'nearest',
]);
export const WireCompressorSchema = z.enum(['snappy', 'zstd', 'zlib']);
export const DumpOptionsSchema = z.object({
  output: z.enum(['archive', 'directory']).default('archive'),
  gzip: z.boolean().default(true),
  // Undefined keeps the connection's own.
  readPreference: ReadPreferenceModeSchema.optional(),
  // Canonical EJSON object, collection scope only.
  query: z
    .string()
    .max(64 * 1024)
    .optional(),
  excludeCollections: z.array(CollectionNameSchema).max(1000).default([]),
  excludeCollectionsWithPrefix: z.array(z.string().min(1).max(120)).max(100).default([]),
  oplog: z.boolean().default(false),
  dumpDbUsersAndRoles: z.boolean().default(false),
  viewsAsCollections: z.boolean().default(false),
  forceTableScan: z.boolean().default(false),
  numParallelCollections: z.number().int().min(1).max(16).default(4),
  compressors: z.array(WireCompressorSchema).max(3).default([]),
});
// One path segment. Windows-reserved characters and trailing dots or spaces are refused.
export const BackupNameSchema = z
  .string()
  .min(1)
  .max(200)
  // eslint-disable-next-line no-control-regex
  .regex(/^[^\\/:*?"<>|\u0000-\u001f]+$/)
  .refine((n) => n !== '.' && n !== '..' && !/[. ]$/.test(n));
// The server-independent option checks are added by option-problems.
export const BackupStartInputSchema = z
  .object({
    connectionId: z.uuid(),
    scope: BackupScopeSchema,
    options: DumpOptionsSchema,
    // Picked this session with a directory dialog.
    folder: AbsolutePathSchema,
    // Without extension.
    name: BackupNameSchema,
    toolsVersion: ToolsVersionSchema,
    acknowledged: z.array(FindingCodeSchema).default([]),
  })
  .superRefine(() => {});

export const DatabaseRenameSchema = z.object({ from: DatabaseNameSchema, to: DatabaseNameSchema });
// "db.*" selects a database, "db.coll" one collection. Source names, before any rename.
export const NamespaceSelectorSchema = z
  .string()
  .min(3)
  .max(400)
  .regex(/^[^.]+\.(\*|.+)$/);
export const RestoreOptionsSchema = z.object({
  // Undefined restores everything.
  include: z.array(NamespaceSelectorSchema).max(2000).optional(),
  renames: z.array(DatabaseRenameSchema).max(100).default([]),
  drop: z.boolean().default(false),
  dryRun: z.boolean().default(false),
  oplogReplay: z.boolean().default(false),
  oplogLimit: z
    .string()
    .regex(/^\d{1,10}(:\d{1,10})?$/)
    .optional(),
  restoreDbUsersAndRoles: z.boolean().default(false),
  preserveUUID: z.boolean().default(false),
  noIndexRestore: z.boolean().default(false),
  noOptionsRestore: z.boolean().default(false),
  convertLegacyIndexes: z.boolean().default(false),
  maintainInsertionOrder: z.boolean().default(false),
  stopOnError: z.boolean().default(false),
  bypassDocumentValidation: z.boolean().default(false),
  objcheck: z.boolean().default(false),
  writeConcern: z.enum(['majority', '1', '0']).default('majority'),
  numParallelCollections: z.number().int().min(1).max(16).default(4),
  numInsertionWorkersPerCollection: z.number().int().min(1).max(16).default(1),
  verifyChecksum: z.boolean().default(true),
});
export const RestoreStartInputSchema = z.object({
  connectionId: z.uuid(),
  // The path passed to backup.inspect this session.
  source: AbsolutePathSchema,
  toolsVersion: ToolsVersionSchema,
  options: RestoreOptionsSchema,
  acknowledged: z.array(FindingCodeSchema).default([]),
  // The typed connection name for a confirmable block.
  confirmation: z.string().max(200).optional(),
});
export const BackupJobKindSchema = z.enum(['dump', 'restore']);
export const BackupStartOutputSchema = z.object({ jobId: z.uuid() });
export const BackupCancelInputSchema = z.object({ jobId: z.uuid() });

export type BackupScope = z.infer<typeof BackupScopeSchema>;
export type ReadPreferenceMode = z.infer<typeof ReadPreferenceModeSchema>;
export type WireCompressor = z.infer<typeof WireCompressorSchema>;
export type DumpOptions = z.infer<typeof DumpOptionsSchema>;
export type BackupStartInput = z.infer<typeof BackupStartInputSchema>;
export type DatabaseRename = z.infer<typeof DatabaseRenameSchema>;
export type RestoreOptions = z.infer<typeof RestoreOptionsSchema>;
export type RestoreStartInput = z.infer<typeof RestoreStartInputSchema>;
export type BackupJobKind = z.infer<typeof BackupJobKindSchema>;
export type BackupStartOutput = z.infer<typeof BackupStartOutputSchema>;
export type BackupCancelInput = z.infer<typeof BackupCancelInputSchema>;
