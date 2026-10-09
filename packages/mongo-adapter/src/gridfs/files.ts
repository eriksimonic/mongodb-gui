import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, rename as moveEntry, rm, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { Transform, type TransformCallback, type Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Document, GridFSBucket, GridFSBucketWriteStream, MongoClient } from 'mongodb';
import { ObjectId } from 'mongodb';
import {
  AppErrorException,
  GRIDFS_DEFAULT_CHUNK_SIZE_BYTES,
  GridFsDeleteInputSchema,
  GridFsDownloadInputSchema,
  GridFsFileRefSchema,
  GridFsListInputSchema,
  GridFsRenameInputSchema,
  GridFsUploadInputSchema,
  type GridFsFile,
  type GridFsListFilter,
  type GridFsUploadInput,
} from '@mongo-gui/core';
import { readNumber } from '../documents';
import { parseEjson, parseEjsonDocument } from '../management/ejson';
import { parseInput } from '../management/errors';
import {
  ProgressTracker,
  throwIfCancelled,
  toFailure,
  TransferCancelled,
  type TransferHooks,
} from '../transfer/progress';
import {
  filesCollection,
  isMissingFileError,
  openBucket,
  parseObjectId,
  requireFile,
  toGridFsFile,
  validationError,
} from './shared';

// Progress is reported each time this many bytes have moved.
const PROGRESS_STEP_BYTES = 1024 * 1024;

// Lists files of a bucket, newest first unless a sort and direction are given. The limit applies
// after the sort.
export async function listFiles(client: MongoClient, request: unknown): Promise<GridFsFile[]> {
  try {
    const input = parseInput(GridFsListInputSchema, request);
    const sort = input.sort ?? 'uploadDate';
    const order = input.direction === 'asc' ? 1 : -1;
    const docs = await filesCollection(client, input.database, input.bucket)
      .find(listQuery(input.filter), {
        sort: { [sort]: order, _id: order },
        limit: input.limit,
      })
      .toArray();
    return docs.map(toGridFsFile);
  } catch (error) {
    throw new AppErrorException(toFailure(error));
  }
}

// The filename match is a case-insensitive substring match. The upload date range is inclusive.
function listQuery(filter: GridFsListFilter | undefined): Document {
  const query: Document = {};
  if (filter?.filenameContains !== undefined && filter.filenameContains !== '') {
    query.filename = { $regex: escapeRegex(filter.filenameContains), $options: 'i' };
  }
  const range: Document = {};
  if (filter?.since !== undefined) {
    range.$gte = new Date(filter.since);
  }
  if (filter?.until !== undefined) {
    range.$lte = new Date(filter.until);
  }
  if (Object.keys(range).length > 0) {
    query.uploadDate = range;
  }
  return query;
}

// The _id may be any BSON value, so the query is built from unknown and checked by the server.
function idQuery(id: unknown): Document {
  return { _id: id };
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function getFile(
  client: MongoClient,
  database: string,
  bucket: string,
  idEjson: string,
): Promise<GridFsFile> {
  try {
    const input = parseInput(GridFsFileRefSchema, { database, bucket, idEjson });
    const id = parseEjson(input.idEjson, 'The file id');
    const doc = await filesCollection(client, input.database, input.bucket).findOne(idQuery(id));
    if (doc === null) {
      throw validationError('No file with that id exists in the bucket');
    }
    return toGridFsFile(doc);
  } catch (error) {
    throw new AppErrorException(toFailure(error));
  }
}

// Streams a local file into the bucket in chunks of chunkSizeBytes. The upload waits for each
// chunk to be stored before it reads the next one, so memory use does not depend on the file size.
// A cancelled or failed upload removes the partial file document and its chunks. Nothing is left
// behind, and the file that was read is never changed.
export async function uploadFile(
  client: MongoClient,
  request: unknown,
  hooks: TransferHooks = {},
): Promise<GridFsFile> {
  let bucket: GridFSBucket | undefined;
  let upload: GridFSBucketWriteStream | undefined;
  let id: ObjectId | undefined;
  try {
    const input = parseInput(GridFsUploadInputSchema, request);
    const info = await stat(input.path);
    if (!info.isFile()) {
      throw validationError('The path is not a regular file');
    }
    bucket = openBucket(client, input.database, input.bucket);
    const metadata = uploadMetadata(input);
    upload = bucket.openUploadStream(input.filename ?? basename(input.path), {
      chunkSizeBytes: input.chunkSizeBytes ?? GRIDFS_DEFAULT_CHUNK_SIZE_BYTES,
      ...(metadata === undefined ? {} : { metadata }),
    });
    // Write errors also reach the write callbacks. This listener stops an unhandled error event.
    upload.on('error', () => undefined);
    id = upload.id;
    const tracker = new ProgressTracker(hooks);
    await copyIntoUpload(input.path, upload, tracker, info.size, hooks.signal);
    const finished = once(upload, 'finish');
    upload.end();
    await finished;
    const doc = await requireFile(filesCollection(client, input.database, input.bucket), id);
    hooks.onProgress?.(
      tracker.snapshot({ done: true, bytesRead: info.size, bytesTotal: info.size }),
    );
    return toGridFsFile(doc);
  } catch (error) {
    await discardUpload(bucket, upload, id);
    throw new AppErrorException(toFailure(cancellationAware(error, hooks.signal)));
  }
}

function uploadMetadata(input: GridFsUploadInput): Document | undefined {
  const base =
    input.metadataEjson === undefined
      ? undefined
      : parseEjsonDocument(input.metadataEjson, 'The metadata');
  if (input.contentType === undefined) {
    return base;
  }
  return { ...(base ?? {}), contentType: input.contentType };
}

async function copyIntoUpload(
  path: string,
  upload: Writable,
  tracker: ProgressTracker,
  total: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  const source: AsyncIterable<Buffer> = createReadStream(path);
  let nextReport = PROGRESS_STEP_BYTES;
  for await (const chunk of source) {
    throwIfCancelled(signal);
    await writeChunk(upload, chunk);
    tracker.processed += chunk.length;
    if (tracker.processed >= nextReport) {
      nextReport = tracker.processed + PROGRESS_STEP_BYTES;
      tracker.emit({ bytesRead: tracker.processed, bytesTotal: total });
    }
  }
}

// Resolves when the driver has stored the chunk. Waiting here means no insert is still running
// when a failed upload is cleaned up.
function writeChunk(stream: Writable, chunk: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(chunk, (error) => {
      if (error === null || error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    });
  });
}

async function discardUpload(
  bucket: GridFSBucket | undefined,
  upload: GridFSBucketWriteStream | undefined,
  id: ObjectId | undefined,
): Promise<void> {
  upload?.destroy();
  if (bucket !== undefined && id !== undefined) {
    // delete() removes the chunks even when no file document exists, and it throws when the file
    // document is missing. Both outcomes leave the bucket clean, so the error is ignored.
    await bucket.delete(id).catch(() => undefined);
  }
}

// Writes the file to a temporary file beside the target, then renames it over the target. A
// failed or cancelled download removes the temporary file and leaves the target untouched.
export async function downloadFile(
  client: MongoClient,
  request: unknown,
  hooks: TransferHooks = {},
): Promise<void> {
  let temp: string | undefined;
  try {
    const input = parseInput(GridFsDownloadInputSchema, request);
    const id = parseObjectId(input.idEjson);
    const doc = await requireFile(filesCollection(client, input.database, input.bucket), id);
    const total = readNumber(doc, 'length') ?? 0;
    await refuseExistingTarget(input.path, input.overwrite === true);
    throwIfCancelled(hooks.signal);
    temp = join(dirname(input.path), `.${basename(input.path)}.${randomUUID()}.part`);
    const tracker = new ProgressTracker(hooks);
    const source = openBucket(client, input.database, input.bucket).openDownloadStream(id);
    await pipeline(
      source,
      progressCounter(tracker, total),
      createWriteStream(temp, { flags: 'wx' }),
      {
        signal: hooks.signal,
      },
    );
    throwIfCancelled(hooks.signal);
    await refuseExistingTarget(input.path, input.overwrite === true);
    await moveEntry(temp, input.path);
    temp = undefined;
    hooks.onProgress?.(
      tracker.snapshot({ done: true, bytesRead: tracker.processed, bytesTotal: total }),
    );
  } catch (error) {
    if (temp !== undefined) {
      await rm(temp, { force: true }).catch(() => undefined);
    }
    throw new AppErrorException(toFailure(cancellationAware(error, hooks.signal)));
  }
}

// Refuses an existing target unless the caller allows overwriting it. The check runs again just
// before the rename, which narrows the window for a file that appears during the download.
async function refuseExistingTarget(path: string, overwrite: boolean): Promise<void> {
  if (overwrite) {
    return;
  }
  const exists = await lstat(path).then(
    () => true,
    (error: unknown) => {
      if (isMissingFileError(error)) {
        return false;
      }
      throw error;
    },
  );
  if (exists) {
    throw validationError('The target file already exists');
  }
}

function progressCounter(tracker: ProgressTracker, total: number): Transform {
  let nextReport = PROGRESS_STEP_BYTES;
  return new Transform({
    transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
      tracker.processed += chunk.length;
      if (tracker.processed >= nextReport) {
        nextReport = tracker.processed + PROGRESS_STEP_BYTES;
        tracker.emit({ bytesRead: tracker.processed, bytesTotal: total });
      }
      callback(null, chunk);
    },
  });
}

// A pipeline aborted by the signal rejects with an AbortError. Report it as a cancellation.
function cancellationAware(error: unknown, signal: AbortSignal | undefined): unknown {
  return signal?.aborted === true ? new TransferCancelled() : error;
}

// Deletes the files in one request. Every id must exist before anything is removed, so a stale
// id refuses the whole request. Returns the number of files removed.
export async function deleteFiles(client: MongoClient, request: unknown): Promise<number> {
  try {
    const input = parseInput(GridFsDeleteInputSchema, request);
    const ids = uniqueIds(input.idsEjson.map(parseObjectId));
    const files = filesCollection(client, input.database, input.bucket);
    const present = await files.countDocuments({ _id: { $in: ids } });
    if (present !== ids.length) {
      throw validationError('Some of the files do not exist in the bucket');
    }
    const bucket = openBucket(client, input.database, input.bucket);
    let deleted = 0;
    for (const id of ids) {
      try {
        await bucket.delete(id);
        deleted += 1;
      } catch (error) {
        // A file that another session removed in the meantime is not a failure.
        if ((await files.countDocuments({ _id: id })) > 0) {
          throw error;
        }
      }
    }
    return deleted;
  } catch (error) {
    throw new AppErrorException(toFailure(error));
  }
}

function uniqueIds(ids: readonly ObjectId[]): ObjectId[] {
  const byHex = new Map<string, ObjectId>();
  for (const id of ids) {
    byHex.set(id.toHexString(), id);
  }
  return [...byHex.values()];
}

// Renames a file by changing its filename field. Returns the file as it is after the rename.
export async function renameFile(client: MongoClient, request: unknown): Promise<GridFsFile> {
  try {
    const input = parseInput(GridFsRenameInputSchema, request);
    const id = parseObjectId(input.idEjson);
    const files = filesCollection(client, input.database, input.bucket);
    const doc = await requireFile(files, id);
    await openBucket(client, input.database, input.bucket).rename(id, input.filename);
    return toGridFsFile({ ...doc, filename: input.filename });
  } catch (error) {
    throw new AppErrorException(toFailure(error));
  }
}
