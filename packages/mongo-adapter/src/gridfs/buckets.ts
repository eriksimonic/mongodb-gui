import type { Db, MongoClient } from 'mongodb';
import {
  AppErrorException,
  GridFsDropBucketInputSchema,
  GridFsListBucketsInputSchema,
  type GridFsBucket,
} from '@mongo-gui/core';
import { readField, readNumber } from '../documents';
import { parseInput, refuseReservedDatabase } from '../management/errors';
import { toFailure } from '../transfer/progress';
import { NAMESPACE_MISSING_CODE } from './shared';

const FILES_SUFFIX = '.files';
const CHUNKS_SUFFIX = '.chunks';

// A bucket exists when both of its collections exist. Buckets are not created explicitly: the
// first upload creates "<name>.files" and "<name>.chunks" together, with the chunks index.
// Any bucket name works, and "fs" is the driver's default name.
export async function listBuckets(client: MongoClient, request: unknown): Promise<GridFsBucket[]> {
  try {
    const { database: name } = parseInput(GridFsListBucketsInputSchema, request);
    const db = client.db(name);
    const collections = await db.listCollections({}, { nameOnly: true }).toArray();
    const names = new Set(collections.map((collection) => collection.name));
    const buckets = [...names]
      .filter((collection) => collection.endsWith(FILES_SUFFIX))
      .map((collection) => collection.slice(0, -FILES_SUFFIX.length))
      .filter((bucket) => names.has(`${bucket}${CHUNKS_SUFFIX}`))
      .sort();
    return await Promise.all(buckets.map((bucket) => bucketTotals(db, bucket)));
  } catch (error) {
    throw new AppErrorException(toFailure(error));
  }
}

async function bucketTotals(db: Db, bucket: string): Promise<GridFsBucket> {
  const rows = await db
    .collection(`${bucket}${FILES_SUFFIX}`)
    .aggregate([{ $group: { _id: null, count: { $sum: 1 }, bytes: { $sum: '$length' } } }])
    .toArray();
  const row = rows[0];
  return {
    name: bucket,
    filesCollection: `${bucket}${FILES_SUFFIX}`,
    chunksCollection: `${bucket}${CHUNKS_SUFFIX}`,
    fileCount: readNumber(row, 'count') ?? 0,
    totalBytes: readNumber(row, 'bytes') ?? 0,
  };
}

// Drops the files and chunks collections of a bucket. A missing collection is not an error,
// so a repeated drop succeeds. The reserved databases (admin, local, config) are refused.
export async function dropBucket(
  client: MongoClient,
  database: string,
  bucket: string,
): Promise<void> {
  try {
    const input = parseInput(GridFsDropBucketInputSchema, { database, bucket });
    refuseReservedDatabase(input.database, 'drop a bucket in');
    const db = client.db(input.database);
    await dropIfExists(db, `${input.bucket}${FILES_SUFFIX}`);
    await dropIfExists(db, `${input.bucket}${CHUNKS_SUFFIX}`);
  } catch (error) {
    throw new AppErrorException(toFailure(error));
  }
}

async function dropIfExists(db: Db, name: string): Promise<void> {
  try {
    await db.collection(name).drop();
  } catch (error) {
    if (readField(error, 'code') !== NAMESPACE_MISSING_CODE) {
      throw error;
    }
  }
}
