import {
  MongoBulkWriteError,
  type AnyBulkWriteOperation,
  type Collection,
  type Document,
  type Filter,
  type WithId,
} from 'mongodb';

export interface MergeCounts {
  readonly written: number;
  readonly failed: number;
}

export interface MergeOptions<TSchema extends Document> {
  readonly source: Collection<TSchema>;
  readonly target: Collection<TSchema>;
  // Selects the source documents to copy. Pass an empty object or leave it out to copy all.
  readonly filter?: Filter<TSchema>;
  readonly batchSize: number;
  // Called after each batch with the running counts.
  readonly onProgress?: (counts: MergeCounts) => void;
  // Checked between batches. An aborted merge returns the counts so far and writes no more batches.
  readonly signal?: AbortSignal;
}

// Copies source documents into the target. A document replaces the target document with the same
// _id, or inserts it when none exists. Writes are unordered, so one failed document does not stop
// the rest of its batch. Indexes on the target are not changed.
export async function mergeCollection<TSchema extends Document>(
  options: MergeOptions<TSchema>,
): Promise<MergeCounts> {
  const { source, target, batchSize, onProgress, signal } = options;
  const counts = { written: 0, failed: 0 };
  let batch: WithId<TSchema>[] = [];

  const flush = async (): Promise<void> => {
    const docs = batch;
    batch = [];
    const operations: AnyBulkWriteOperation<TSchema>[] = docs.map((doc) => ({
      replaceOne: { filter: { _id: doc._id } as Filter<TSchema>, replacement: doc, upsert: true },
    }));
    try {
      await target.bulkWrite(operations, { ordered: false });
      counts.written += docs.length;
    } catch (error) {
      if (!(error instanceof MongoBulkWriteError)) {
        throw error;
      }
      const failed = Array.isArray(error.writeErrors) ? error.writeErrors.length : 1;
      counts.failed += failed;
      counts.written += docs.length - failed;
    }
    onProgress?.({ ...counts });
  };

  // Leaving the for-await loop early, or throwing from it, closes the source cursor.
  for await (const doc of source.find(options.filter ?? {})) {
    batch.push(doc);
    if (batch.length < batchSize) {
      continue;
    }
    if (signal?.aborted === true) {
      return { ...counts };
    }
    await flush();
  }
  if (batch.length > 0 && signal?.aborted !== true) {
    await flush();
  }
  return { ...counts };
}
