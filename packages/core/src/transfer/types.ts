import { z } from 'zod';
import { AppErrorSchema } from '../schemas/errors';
import { CollectionNameSchema, DatabaseNameSchema } from '../management/types';

export const MAX_IMPORT_BATCH_SIZE = 5000;
export const DEFAULT_IMPORT_BATCH_SIZE = 500;
export const MAX_REPORTED_ERRORS = 100;
export const PREVIEW_SAMPLE_ROWS = 20;

// Accepts POSIX and Windows absolute paths. Relative paths are refused so that the working
// directory of the utility process never decides where a file is read or written.
const ABSOLUTE_PATH_PATTERN = /^(\/|[A-Za-z]:[\\/]|\\\\)/;

export const AbsolutePathSchema = z
  .string()
  .min(1)
  .refine((value) => ABSOLUTE_PATH_PATTERN.test(value), {
    message: 'The file path must be absolute',
  })
  .refine((value) => !value.includes('\u0000'), {
    message: 'The file path may not contain a null byte',
  });

export const ImportFormatSchema = z.enum(['json-array', 'ndjson', 'csv']);
export const ExportFormatSchema = z.enum(['json-array', 'ndjson', 'csv']);

export const CsvDelimiterSchema = z.enum([',', ';', '\t', '|']);

export const CsvOptionsSchema = z.object({
  delimiter: CsvDelimiterSchema.default(','),
  quote: z.literal('"').default('"'),
  hasHeader: z.boolean().default(true),
  nullValues: z.array(z.string()).default(['', 'null', 'NULL']),
  trim: z.boolean().default(false),
});

export const FieldTypeSchema = z.enum([
  'auto',
  'string',
  'int',
  'long',
  'double',
  'decimal',
  'boolean',
  'date',
  'objectId',
  'null',
  'json',
]);

// A dotted target such as "address.city" creates a nested document. Empty segments are refused.
export const FieldPathSchema = z
  .string()
  .min(1)
  .refine((value) => value.split('.').every((segment) => segment.length > 0), {
    message: 'Field paths may not contain empty segments',
  });

export const FieldMappingSchema = z.object({
  source: z.string().min(1),
  target: FieldPathSchema,
  type: FieldTypeSchema.default('auto'),
  skip: z.boolean().optional(),
});

export const ImportModeSchema = z.enum(['insert', 'upsert']);

export const ImportOptionsSchema = z.object({
  format: ImportFormatSchema,
  csv: CsvOptionsSchema.optional(),
  mappings: z.array(FieldMappingSchema).optional(),
  mode: ImportModeSchema.default('insert'),
  upsertKey: FieldPathSchema.default('_id'),
  batchSize: z.number().int().min(1).max(MAX_IMPORT_BATCH_SIZE).default(DEFAULT_IMPORT_BATCH_SIZE),
  stopOnError: z.boolean().default(false),
});

export const ImportRequestSchema = z.object({
  database: DatabaseNameSchema,
  collection: CollectionNameSchema,
  path: AbsolutePathSchema,
  options: ImportOptionsSchema,
});

export const ImportPreviewRequestSchema = z.object({
  path: AbsolutePathSchema,
  format: ImportFormatSchema.optional(),
  csv: CsvOptionsSchema.optional(),
  sampleRows: z.number().int().min(1).max(1000).default(100),
});

export const ExportOptionsSchema = z.object({
  format: ExportFormatSchema,
  csv: z
    .object({
      delimiter: CsvDelimiterSchema.default(','),
      columns: z.array(z.string().min(1)).optional(),
      flattenArrays: z.enum(['json', 'join']).default('json'),
    })
    .optional(),
  filterEjson: z.string().optional(),
  projectionEjson: z.string().optional(),
  sortEjson: z.string().optional(),
  limit: z.number().int().positive().optional(),
  ejsonMode: z.enum(['canonical', 'relaxed']).default('canonical'),
});

export const ExportRequestSchema = z.object({
  database: DatabaseNameSchema,
  collection: CollectionNameSchema,
  path: AbsolutePathSchema,
  options: ExportOptionsSchema,
});

export const TransferRowErrorSchema = z.object({
  row: z.number().int().nonnegative(),
  message: z.string(),
});

// Progress of an import or export.
//
// Row numbers in `errors` are data records, not file lines: for CSV they count the records after
// the header, and blank lines are not counted. For JSON and NDJSON they count the array elements
// or the non-empty lines. A record that spans several physical lines (a quoted newline) is one row.
//
// `updated` is the number of existing documents whose content changed (modifiedCount). `matched`
// is every existing document that the upsert key found, changed or not.
export const TransferProgressSchema = z.object({
  processed: z.number().int().nonnegative(),
  inserted: z.number().int().nonnegative(),
  updated: z.number().int().nonnegative(),
  matched: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  bytesRead: z.number().int().nonnegative().optional(),
  bytesTotal: z.number().int().nonnegative().optional(),
  elapsedMs: z.number().nonnegative(),
  done: z.boolean(),
  error: AppErrorSchema.optional(),
  errors: z.array(TransferRowErrorSchema),
  warnings: z.array(z.string()),
});

export const ImportPreviewFieldSchema = z.object({
  name: z.string(),
  inferredType: FieldTypeSchema,
  examples: z.array(z.string()),
  nullCount: z.number().int().nonnegative(),
});

export const ImportPreviewSchema = z.object({
  detectedFormat: ImportFormatSchema,
  csv: CsvOptionsSchema.optional(),
  fields: z.array(ImportPreviewFieldSchema),
  sampleRows: z.array(z.record(z.string(), z.unknown())).max(PREVIEW_SAMPLE_ROWS),
  estimatedRows: z.number().int().nonnegative().optional(),
  warnings: z.array(z.string()),
});

export type ImportFormat = z.infer<typeof ImportFormatSchema>;
export type ExportFormat = z.infer<typeof ExportFormatSchema>;
export type CsvDelimiter = z.infer<typeof CsvDelimiterSchema>;
export type CsvOptions = z.infer<typeof CsvOptionsSchema>;
export type FieldType = z.infer<typeof FieldTypeSchema>;
export type FieldMapping = z.infer<typeof FieldMappingSchema>;
export type ImportMode = z.infer<typeof ImportModeSchema>;
export type ImportOptions = z.infer<typeof ImportOptionsSchema>;
export type ImportRequest = z.infer<typeof ImportRequestSchema>;
export type ImportPreviewRequest = z.infer<typeof ImportPreviewRequestSchema>;
export type ExportOptions = z.infer<typeof ExportOptionsSchema>;
export type ExportRequest = z.infer<typeof ExportRequestSchema>;
export type TransferRowError = z.infer<typeof TransferRowErrorSchema>;
export type TransferProgress = z.infer<typeof TransferProgressSchema>;
export type ImportPreviewField = z.infer<typeof ImportPreviewFieldSchema>;
export type ImportPreview = z.infer<typeof ImportPreviewSchema>;
