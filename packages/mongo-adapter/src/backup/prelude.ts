import { BSON } from 'mongodb';
import type { BackupNamespaceInfo } from '@mongo-gui/core';
import { readString } from '../documents';

// The first four bytes of every mongodump archive (0x8199e26d, little endian).
const ARCHIVE_MAGIC = [0x6d, 0xe2, 0x99, 0x81];
const TERMINATOR = -1;
const SIZE_BYTES = 4;
const MIN_DOCUMENT_BYTES = 5;

export type PreludeNamespace = Pick<BackupNamespaceInfo, 'database' | 'collection' | 'type'>;

export interface ArchivePrelude {
  readonly serverVersion?: string;
  readonly toolsVersion?: string;
  readonly namespaces: PreludeNamespace[];
  // True when the bytes ended before the terminator, so the namespace list may be incomplete.
  readonly truncated: boolean;
}

/**
 * Reads the header and the namespace list at the start of an uncompressed archive. A gzip archive
 * must be inflated by the caller. The bytes may be only a prefix of the file, in which case
 * `truncated` is set. Bad magic or a header that is cut off throws.
 */
export function readArchivePrelude(bytes: Uint8Array): ArchivePrelude {
  if (!ARCHIVE_MAGIC.every((byte, index) => bytes[index] === byte)) {
    throw new Error('Not a mongodump archive: the magic number does not match');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = ARCHIVE_MAGIC.length;

  const header = nextDocument(bytes, view, offset);
  if (header === undefined || header.document === undefined) {
    throw new Error('The archive header is missing or cut off');
  }
  offset = header.next;

  const namespaces: PreludeNamespace[] = [];
  for (;;) {
    const entry = nextDocument(bytes, view, offset);
    if (entry === undefined) {
      return toPrelude(header.document, namespaces, true);
    }
    if (entry.document === undefined) {
      return toPrelude(header.document, namespaces, false);
    }
    offset = entry.next;
    const namespace = toNamespace(entry.document);
    if (namespace !== undefined) {
      namespaces.push(namespace);
    }
  }
}

interface NextDocument {
  // Undefined for the terminator.
  readonly document: BSON.Document | undefined;
  readonly next: number;
}

function nextDocument(bytes: Uint8Array, view: DataView, offset: number): NextDocument | undefined {
  if (offset + SIZE_BYTES > bytes.byteLength) {
    return undefined;
  }
  const size = view.getInt32(offset, true);
  if (size === TERMINATOR) {
    return { document: undefined, next: offset + SIZE_BYTES };
  }
  if (size < MIN_DOCUMENT_BYTES) {
    throw new Error('The archive has a corrupt document size');
  }
  if (offset + size > bytes.byteLength) {
    return undefined;
  }
  return {
    document: BSON.deserialize(bytes.subarray(offset, offset + size)),
    next: offset + size,
  };
}

function toPrelude(
  header: BSON.Document,
  namespaces: PreludeNamespace[],
  truncated: boolean,
): ArchivePrelude {
  const serverVersion = readString(header, 'server_version');
  const toolsVersion = readString(header, 'tool_version');
  return {
    ...(serverVersion === undefined ? {} : { serverVersion }),
    ...(toolsVersion === undefined ? {} : { toolsVersion }),
    namespaces,
    truncated,
  };
}

function toNamespace(document: BSON.Document): PreludeNamespace | undefined {
  const database = readString(document, 'db');
  const collection = readString(document, 'collection');
  if (database === undefined || collection === undefined) {
    return undefined;
  }
  const type = readString(document, 'type');
  return {
    database,
    collection,
    type: type === 'view' || type === 'timeseries' ? type : 'collection',
  };
}
