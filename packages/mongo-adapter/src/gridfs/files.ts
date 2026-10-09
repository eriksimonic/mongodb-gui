import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createReadStream, createWriteStream } from 'node:fs';
import { link, lstat, rename as moveEntry, rm, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { Transform, type TransformCallback, type Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type {
  Document,
  GridFSBucket,
  GridFSBucketWriteStream,
  MongoClient,
  ObjectId,
} from 'mongodb';
import {
  appError,
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
import { readField, readNumber } from '../documents';
import { parseEjsonDocument, stringifyEjson } from '../management/ejson';
import { parseInput, refuseReservedDatabase } from '../management/errors';
import {
  ProgressTracker,
  throwIfCancelled,
  TransferCancelled,
  type TransferHooks,
} from '../transfer/progress';
import {
  chunksCollection,
  filesCollection,
  idQuery,
  isMissingFileError,
  notFoundError,
  openBucket,
  openDownloadStreamFor,
  parseFileId,
  requireFile,
  toGridFsFailure,
  toGridFsFile,
  validationError,
} from './shared';

// Progress is reported each time this many bytes have moved.
const PROGRESS_STEP_BYTES = 1024 * 1024;

export interface GridFsDeleteResult {
  readonly deleted: number;
}

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
    throw new AppErrorException(toGridFsFailure(error));
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

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function getFile(client: MongoClient, request: unknown): Promise<GridFsFile> {
  try {
    const input = parseInput(GridFsFileRefSchema, request);
    const id = parseFileId(input.idEjson);
    const doc = await requireFile(filesCollection(client, input.database, input.bucket), id);
    return toGridFsFile(doc);
  } catch (error) {
    throw new AppErrorException(toGridFsFailure(error));
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
    refuseReservedDatabase(input.database, 'upload to');
    throwIfCancelled(hooks.signal);
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
    // A cancel that arrived after the last chunk still stops the upload before the file document
    // is written.
    throwIfCancelled(hooks.signal);
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
    throw new AppErrorException(toGridFsFailure(cancellationAware(error, hooks.signal)));
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

// Writes the file to a temporary file beside the target. The temporary file replaces the target
// when overwrite is set. Without overwrite, a hard link creates the target and fails if it exists.
// A failed or cancelled download removes the temporary file and leaves the target untouched.
export async function downloadFile(
  client: MongoClient,
  request: unknown,
  hooks: TransferHooks = {},
): Promise<void> {
  let temp: string | undefined;
  try {
    const input = parseInput(GridFsDownloadInputSchema, request);
    const overwrite = input.overwrite === true;
    const id = parseFileId(input.idEjson);
    const doc = await requireFile(filesCollection(client, input.database, input.bucket), id);
    const total = readNumber(doc, 'length') ?? 0;
    await refuseExistingTarget(input.path, overwrite);
    throwIfCancelled(hooks.signal);
    temp = join(dirname(input.path), `.${basename(input.path)}.${randomUUID()}.part`);
    const tracker = new ProgressTracker(hooks);
    const source = openDownloadStreamFor(openBucket(client, input.database, input.bucket), id);
    await pipeline(
      source,
      progressCounter(tracker, total),
      createWriteStream(temp, { flags: 'wx' }),
      {
        signal: hooks.signal,
      },
    );
    // The driver ends the stream without an error when chunks are missing, so the byte count is
    // the only check that the whole file was read.
    if (tracker.processed !== total) {
      throw new AppErrorException(
        appError(
          'COMMAND_FAILED',
          "The file's chunks are missing or damaged",
          `The file is incomplete: read ${tracker.processed} of ${total} bytes`,
        ),
      );
    }
    throwIfCancelled(hooks.signal);
    if (overwrite) {
      await moveEntry(temp, input.path);
    } else {
      await linkExclusive(temp, input.path);
      await rm(temp, { force: true });
    }
    temp = undefined;
    hooks.onProgress?.(tracker.snapshot({ done: true, bytesRead: total, bytesTotal: total }));
  } catch (error) {
    if (temp !== undefined) {
      await rm(temp, { force: true }).catch(() => undefined);
    }
    throw new AppErrorException(toGridFsFailure(cancellationAware(error, hooks.signal)));
  }
}

// Refuses an existing target unless the caller allows overwriting it. This check fails fast
// before any bytes are read. The final step checks again atomically.
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

// Filesystems such as FAT, exFAT and some network shares refuse hard links. For those, the target
// is checked and then renamed into place. That check is not atomic, so it is the fallback only.
const NO_HARD_LINK_CODES: ReadonlySet<unknown> = new Set([
  'EPERM',
  'ENOTSUP',
  'EOPNOTSUPP',
  'ENOSYS',
]);

// A hard link fails with EEXIST when the target exists, so the check and the creation are one step.
// The temporary file is left in place for the caller to remove.
export async function linkExclusive(source: string, target: string): Promise<void> {
  try {
    await link(source, target);
  } catch (error) {
    if (readField(error, 'code') === 'EEXIST') {
      throw validationError('The target file already exists');
    }
    if (!NO_HARD_LINK_CODES.has(readField(error, 'code'))) {
      throw error;
    }
    await refuseExistingTarget(target, false);
    await moveEntry(source, target);
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

// Deletes files and their chunks. Every id must exist before anything is removed, so a stale id
// refuses the whole request with NOT_FOUND. Each file's chunks are deleted before its document, so
// a document never outlives its chunks. A file that disappears between the check and its delete
// already has the wanted result, so it counts as deleted. When a delete fails, the other files are
// still deleted, and the error is COMMAND_FAILED with the counts and the first error's message in
// the detail. A partial failure therefore throws and does not return a count.
export async function deleteFiles(
  client: MongoClient,
  request: unknown,
): Promise<GridFsDeleteResult> {
  try {
    const input = parseInput(GridFsDeleteInputSchema, request);
    refuseReservedDatabase(input.database, 'delete files in');
    const ids = uniqueIds(input.idsEjson.map(parseFileId));
    const files = filesCollection(client, input.database, input.bucket);
    const chunks = chunksCollection(client, input.database, input.bucket);
    const present = await files.countDocuments(idsQuery(ids));
    if (present !== ids.length) {
      throw notFoundError();
    }
    let deleted = 0;
    let failed = 0;
    let firstError: unknown;
    for (const id of ids) {
      try {
        await chunks.deleteMany({ files_id: id });
        await files.deleteOne(idQuery(id));
        deleted += 1;
      } catch (error) {
        failed += 1;
        firstError ??= error;
      }
    }
    if (failed > 0) {
      throw new AppErrorException(
        appError(
          'COMMAND_FAILED',
          'Some files could not be deleted',
          `deleted ${deleted}, failed ${failed}: ${errorText(firstError)}`,
        ),
      );
    }
    return { deleted };
  } catch (error) {
    throw new AppErrorException(toGridFsFailure(error));
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}

function idsQuery(ids: readonly unknown[]): Document {
  return { _id: { $in: ids } };
}

// Keeps one entry per file id. Ids are compared by their canonical Extended JSON.
function uniqueIds(ids: readonly unknown[]): unknown[] {
  const byText = new Map<string, unknown>();
  for (const id of ids) {
    byText.set(stringifyEjson(id), id);
  }
  return [...byText.values()];
}

// Renames a file by changing its filename field. Returns the file as it is after the rename.
export async function renameFile(client: MongoClient, request: unknown): Promise<GridFsFile> {
  try {
    const input = parseInput(GridFsRenameInputSchema, request);
    refuseReservedDatabase(input.database, 'rename files in');
    const id = parseFileId(input.idEjson);
    const files = filesCollection(client, input.database, input.bucket);
    const doc = await requireFile(files, id);
    const result = await files.updateOne(idQuery(id), { $set: { filename: input.filename } });
    if (result.matchedCount === 0) {
      throw notFoundError();
    }
    return toGridFsFile({ ...doc, filename: input.filename });
  } catch (error) {
    throw new AppErrorException(toGridFsFailure(error));
  }
}
