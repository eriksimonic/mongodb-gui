import { GridFSBucket, ObjectId, type Collection, type Document, type MongoClient } from 'mongodb';
import { appError, AppErrorException, type GridFsFile } from '@mongo-gui/core';
import { definedEntry, readDate, readField, readNumber, readString } from '../documents';
import { parseEjson, stringifyEjson } from '../management/ejson';

export const NAMESPACE_MISSING_CODE = 26;

export function validationError(message: string, detail?: string): AppErrorException {
  return new AppErrorException(
    detail === undefined
      ? appError('VALIDATION', message)
      : appError('VALIDATION', message, detail),
  );
}

export function filesCollection(
  client: MongoClient,
  database: string,
  bucket: string,
): Collection<Document> {
  return client.db(database).collection<Document>(`${bucket}.files`);
}

export function openBucket(client: MongoClient, database: string, bucket: string): GridFSBucket {
  return new GridFSBucket(client.db(database), { bucketName: bucket });
}

// The driver's bucket methods take an ObjectId. Files with another _id type are listed, but they
// cannot be downloaded, renamed or deleted through the bucket API.
export function parseObjectId(idEjson: string): ObjectId {
  const value = parseEjson(idEjson, 'The file id');
  if (!(value instanceof ObjectId)) {
    throw validationError('The file id must be an ObjectId');
  }
  return value;
}

export async function requireFile(files: Collection<Document>, id: ObjectId): Promise<Document> {
  const doc = await files.findOne({ _id: id });
  if (doc === null) {
    throw validationError('No file with that id exists in the bucket');
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
