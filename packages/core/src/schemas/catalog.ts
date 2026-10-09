import { z } from 'zod';

const documentSchema = z.record(z.string(), z.unknown());

export const DatabaseInfoSchema = z.object({
  name: z.string().min(1),
  sizeOnDisk: z.number().nonnegative().optional(),
  empty: z.boolean().optional(),
});

export const CollectionInfoSchema = z.object({
  name: z.string().min(1),
  type: z.enum(['collection', 'view', 'timeseries']),
  options: documentSchema.optional(),
  info: z
    .object({
      readOnly: z.boolean().optional(),
      uuid: z.string().optional(),
    })
    .optional(),
});

export const CollectionStatsSchema = z.object({
  ns: z.string(),
  count: z.number().int().nonnegative(),
  size: z.number().nonnegative(),
  storageSize: z.number().nonnegative(),
  avgObjSize: z.number().nonnegative(),
  nindexes: z.number().int().nonnegative(),
  totalIndexSize: z.number().nonnegative(),
  capped: z.boolean(),
  indexSizes: z.record(z.string(), z.number().nonnegative()),
});

export const DatabaseStatsSchema = z.object({
  db: z.string(),
  collections: z.number().int().nonnegative(),
  views: z.number().int().nonnegative(),
  objects: z.number().int().nonnegative(),
  dataSize: z.number().nonnegative(),
  storageSize: z.number().nonnegative(),
  indexes: z.number().int().nonnegative(),
  indexSize: z.number().nonnegative(),
});

export const IndexInfoSchema = z.object({
  name: z.string().min(1),
  key: z.record(z.string(), z.union([z.literal(1), z.literal(-1), z.string()])),
  unique: z.boolean().optional(),
  sparse: z.boolean().optional(),
  hidden: z.boolean().optional(),
  expireAfterSeconds: z.number().nonnegative().optional(),
  partialFilterExpression: documentSchema.optional(),
  collation: documentSchema.optional(),
  wildcardProjection: documentSchema.optional(),
  size: z.number().nonnegative().optional(),
  usage: z
    .object({
      ops: z.number().int().nonnegative(),
      since: z.string(),
    })
    .optional(),
});
