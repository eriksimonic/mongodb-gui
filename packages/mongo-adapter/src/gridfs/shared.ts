import {
  GridFSBucket,
  type GridFSBucketReadStream,
  MongoGridFSChunkError,
  MongoGridFSStreamError,
  MongoRuntimeError,
  type Collection,
  type Document,
  type MongoClient,
  type ObjectId,
} from 'mongodb';
import { appError, AppErrorException, type AppError, type GridFsFile } from '@mongo-gui/core';
import { definedEntry, readDate, readField, readNumber, readString } from '../documents';
import { parseEjson, stringifyEjson } from '../management/ejson';
import { toFailure } from '../transfer/progress';

export const NAMESPACE_MISSING_CODE = 26;
const NOT_FOUND_MESSAGE = 'No file with that id exists in the bucket';
const CHUNKS_DAMAGED_MESSAGE = "The file's chunks are missing or damaged";
// The driver's own not-found messages, for example "FileNotFound: file ... was not found" and
// "File with id ... not found". The driver reports this with the code ENOENT, so it is matched
// before any errno mapping.
const DRIVER_NOT_FOUND = /file ?not ?found|file .*not found/i;

export function validationError(message: string, detail?: string): AppErrorException {
  return new AppErrorException(
    detail === undefined
      ? appError('VALIDATION', message)
      : appError('VALIDATION', message, detail),
  );
}

export function notFoundError(): AppErrorException {
  return new AppErrorException(appError('NOT_FOUND', NOT_FOUND_MESSAGE));
}

export function filesCollection(
  client: MongoClient,
  database: string,
  bucket: string,
): Collection<Document> {
  return client.db(database).collection<Document>(`${bucket}.files`);
}

export function chunksCollection(
  client: MongoClient,
  database: string,
  bucket: string,
): Collection<Document> {
  return client.db(database).collection<Document>(`${bucket}.chunks`);
}

export function openBucket(client: MongoClient, database: string, bucket: string): GridFSBucket {
  return new GridFSBucket(client.db(database), { bucketName: bucket });
}

// The driver types the file id as ObjectId, but it queries the files and chunks collections by
// _id and files_id as given. Any BSON value therefore works at runtime, including files whose id
// is a string. This is the only place where a file id is cast for the driver.
export function openDownloadStreamFor(bucket: GridFSBucket, id: unknown): GridFSBucketReadStream {
  return bucket.openDownloadStream(id as ObjectId);
}

// Parses the canonical Extended JSON of a file _id. Any BSON value is accepted.
export function parseFileId(idEjson: string): unknown {
  return parseEjson(idEjson, 'The file id');
}

export function idQuery(id: unknown): Document {
  return { _id: id };
}

export async function requireFile(files: Collection<Document>, id: unknown): Promise<Document> {
  const doc = await files.findOne(idQuery(id));
  if (doc === null) {
    throw notFoundError();
  }
  return doc;
}

// Maps a files document to the public shape. The contentType is read from the top level, where
// older drivers wrote it, and from metadata, where this adapter writes it.
export function toGridFsFile(doc: Document): GridFsFile {
  const metadata = readField(doc, 'metadata');
  const contentType = readString(doc, 'contentType') ?? readString(metadata, 'contentType');
  const uploadDate = readDate(doc, 'uploadDate');
  return {
    idEjson: stringifyEjson(readField(doc, '_id')),
    filename: readString(doc, 'filename') ?? '',
    length: readNumber(doc, 'length') ?? 0,
    chunkSize: readNumber(doc, 'chunkSize') ?? 0,
    uploadDate: uploadDate === undefined ? '' : uploadDate.toISOString(),
    ...definedEntry('md5', readString(doc, 'md5')),
    ...definedEntry('contentType', contentType),
    ...definedEntry('metadataEjson', metadata === undefined ? undefined : stringifyEjson(metadata)),
  };
}

export function isMissingFileError(error: unknown): boolean {
  return readField(error, 'code') === 'ENOENT';
}

// Maps a GridFS failure to the public error. Driver errors that name a missing file become
// NOT_FOUND, and damaged or missing chunks become COMMAND_FAILED. Everything else goes through
// the transfer mapping.
export function toGridFsFailure(error: unknown): AppError {
  if (error instanceof AppErrorException) {
    return error.error;
  }
  if (error instanceof MongoGridFSChunkError || error instanceof MongoGridFSStreamError) {
    return appError('COMMAND_FAILED', CHUNKS_DAMAGED_MESSAGE, error.message);
  }
  if (error instanceof MongoRuntimeError && DRIVER_NOT_FOUND.test(error.message)) {
    return appError('NOT_FOUND', NOT_FOUND_MESSAGE);
  }
  return toFailure(error);
}
