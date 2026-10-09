import { z } from 'zod';
import { DatabaseNameSchema, ExistingCollectionNameSchema } from '../management/types';
import { AbsolutePathSchema } from '../transfer/types';

export const GRIDFS_DEFAULT_LIST_LIMIT = 200;
export const GRIDFS_MAX_LIST_LIMIT = 5000;
export const GRIDFS_MAX_BATCH_IDS = 5000;
export const GRIDFS_MIN_CHUNK_SIZE_BYTES = 1024;
export const GRIDFS_MAX_CHUNK_SIZE_BYTES = 15 * 1024 * 1024;
export const GRIDFS_DEFAULT_CHUNK_SIZE_BYTES = 255 * 1024;
export const GRIDFS_MAX_FILENAME_CHARS = 1024;

// A collection name must stay within 255 bytes after the ".files" or ".chunks" suffix is added.
const MAX_BUCKET_NAME_BYTES = 245;
const SYSTEM_PREFIX = 'system.';
const RESERVED_SUFFIX = /\.(files|chunks)$/;
const NULL_BYTE = '\u0000';

// UTF-8 length, counted per code point so the core package needs no DOM or Node types.
function byteLength(value: string): number {
  let bytes = 0;
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

// A GridFS bucket is a pair of collections, "<name>.files" and "<name>.chunks".
export const GridFsBucketNameSchema = ExistingCollectionNameSchema.refine(
  (value) => byteLength(value) <= MAX_BUCKET_NAME_BYTES,
  { message: `Bucket names are at most ${MAX_BUCKET_NAME_BYTES} bytes` },
)
  .refine((value) => !value.startsWith(SYSTEM_PREFIX), {
    message: 'Bucket names may not start with system.',
  })
  .refine((value) => !RESERVED_SUFFIX.test(value), {
    message: 'Bucket names may not end with .files or .chunks',
  });

export const GridFsFilenameSchema = z
  .string()
  .min(1)
  .max(GRIDFS_MAX_FILENAME_CHARS)
  .refine((value) => !value.includes(NULL_BYTE), {
    message: 'Filenames may not contain a null byte',
  });

// Canonical Extended JSON of an _id value, for example {"$oid":"..."}.
export const GridFsIdEjsonSchema = z.string().min(1);

const IsoDateStringSchema = z.string().refine((value) => !Number.isNaN(Date.parse(value)), {
  message: 'Dates must be ISO 8601 strings',
});

export const GridFsBucketSchema = z.object({
  name: z.string().min(1),
  filesCollection: z.string().min(1),
  chunksCollection: z.string().min(1),
  fileCount: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
});

export const GridFsFileSchema = z.object({
  idEjson: GridFsIdEjsonSchema,
  filename: z.string(),
  length: z.number().int().nonnegative(),
  chunkSize: z.number().int().positive(),
  uploadDate: z.string(),
  md5: z.string().optional(),
  contentType: z.string().optional(),
  metadataEjson: z.string().optional(),
});

export const GridFsListSortSchema = z.enum(['uploadDate', 'filename', 'length']);
export const GridFsSortDirectionSchema = z.enum(['asc', 'desc']);

export const GridFsListFilterSchema = z.object({
  filenameContains: z.string().max(GRIDFS_MAX_FILENAME_CHARS).optional(),
  since: IsoDateStringSchema.optional(),
  until: IsoDateStringSchema.optional(),
});

export const GridFsListInputSchema = z.object({
  database: DatabaseNameSchema,
  bucket: GridFsBucketNameSchema,
  filter: GridFsListFilterSchema.optional(),
  limit: z.number().int().min(1).max(GRIDFS_MAX_LIST_LIMIT).default(GRIDFS_DEFAULT_LIST_LIMIT),
  sort: GridFsListSortSchema.optional(),
  direction: GridFsSortDirectionSchema.optional(),
});

export const GridFsUploadInputSchema = z.object({
  database: DatabaseNameSchema,
  bucket: GridFsBucketNameSchema,
  path: AbsolutePathSchema,
  filename: GridFsFilenameSchema.optional(),
  contentType: z.string().min(1).optional(),
  metadataEjson: z.string().optional(),
  chunkSizeBytes: z
    .number()
    .int()
    .min(GRIDFS_MIN_CHUNK_SIZE_BYTES)
    .max(GRIDFS_MAX_CHUNK_SIZE_BYTES)
    .optional(),
});

export const GridFsDownloadInputSchema = z.object({
  database: DatabaseNameSchema,
  bucket: GridFsBucketNameSchema,
  idEjson: GridFsIdEjsonSchema,
  path: AbsolutePathSchema,
  overwrite: z.boolean().optional(),
});

export const GridFsDeleteInputSchema = z.object({
  database: DatabaseNameSchema,
  bucket: GridFsBucketNameSchema,
  idsEjson: z.array(GridFsIdEjsonSchema).min(1).max(GRIDFS_MAX_BATCH_IDS),
});

export const GridFsRenameInputSchema = z.object({
  database: DatabaseNameSchema,
  bucket: GridFsBucketNameSchema,
  idEjson: GridFsIdEjsonSchema,
  filename: GridFsFilenameSchema,
});

export const GridFsListBucketsInputSchema = z.object({
  database: DatabaseNameSchema,
});

export const GridFsFileRefSchema = z.object({
  database: DatabaseNameSchema,
  bucket: GridFsBucketNameSchema,
  idEjson: GridFsIdEjsonSchema,
});

export const GridFsDropBucketInputSchema = z.object({
  database: DatabaseNameSchema,
  bucket: GridFsBucketNameSchema,
});

export type GridFsBucket = z.infer<typeof GridFsBucketSchema>;
export type GridFsFile = z.infer<typeof GridFsFileSchema>;
export type GridFsListSort = z.infer<typeof GridFsListSortSchema>;
export type GridFsSortDirection = z.infer<typeof GridFsSortDirectionSchema>;
export type GridFsListFilter = z.infer<typeof GridFsListFilterSchema>;
export type GridFsListInput = z.infer<typeof GridFsListInputSchema>;
export type GridFsUploadInput = z.infer<typeof GridFsUploadInputSchema>;
export type GridFsDownloadInput = z.infer<typeof GridFsDownloadInputSchema>;
export type GridFsDeleteInput = z.infer<typeof GridFsDeleteInputSchema>;
export type GridFsRenameInput = z.infer<typeof GridFsRenameInputSchema>;
export type GridFsFileRef = z.infer<typeof GridFsFileRefSchema>;
export type GridFsListBucketsInput = z.infer<typeof GridFsListBucketsInputSchema>;
export type GridFsDropBucketInput = z.infer<typeof GridFsDropBucketInputSchema>;
