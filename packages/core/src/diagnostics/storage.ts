import { z } from 'zod';

// Read-only storage usage for the Storage panel. Sizes are bytes.
export const StorageDatabasesSchema = z.object({
  databases: z.array(
    z.object({
      name: z.string().min(1),
      sizeOnDisk: z.number().nonnegative(),
      empty: z.boolean(),
    }),
  ),
  fsUsedSize: z.number().nonnegative().nullable(),
  fsTotalSize: z.number().nonnegative().nullable(),
});

// One collection with its index sizes. A failed per-collection call sets `error` and zeros the numbers.
// `ops` and `since` are null when $indexStats failed or was denied.
export const StorageCollectionSchema = z.object({
  name: z.string().min(1),
  type: z.enum(['collection', 'timeseries']),
  count: z.number().int().nonnegative(),
  dataSize: z.number().nonnegative(),
  avgObjSize: z.number().nonnegative(),
  storageSize: z.number().nonnegative(),
  freeStorageSize: z.number().nonnegative().nullable(),
  totalIndexSize: z.number().nonnegative(),
  indexes: z.array(
    z.object({
      name: z.string().min(1),
      size: z.number().nonnegative(),
      ops: z.number().nonnegative().nullable(),
      since: z.string().nullable(),
    }),
  ),
  error: z.string().nullable(),
});

export const StorageCollectionsSchema = z.object({
  database: z.string().min(1),
  collections: z.array(StorageCollectionSchema),
});

export type StorageDatabases = z.infer<typeof StorageDatabasesSchema>;
export type StorageCollections = z.infer<typeof StorageCollectionsSchema>;
export type StorageCollection = z.infer<typeof StorageCollectionSchema>;
