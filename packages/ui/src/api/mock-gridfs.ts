import {
  rpcContract,
  type GridFsFile,
  type GridFsListInput,
  type RpcClient,
} from '@mongo-gui/core';
import { objectIdHex } from './mock-catalog';
import { fail, method } from './mock-support';
import { GRIDFS_JOB_BYTES, type GridFsTransferKind } from './mock-transfer';

/** A file the local disk already holds in the mock. A download to it needs an overwrite. */
export const MOCK_EXISTING_FOLDER = '/mock/downloads';
export const MOCK_EXISTING_FILE = `${MOCK_EXISTING_FOLDER}/receipt-1001.pdf`;
/** The folder the mock folder dialog returns. */
export const MOCK_FOLDER_PATH = MOCK_EXISTING_FOLDER;

export interface MockGridFsContext {
  readonly latencyMs: number;
  /** Throws unless the vault is unlocked and the connection is connected. */
  guard(connectionId: string): void;
  /** Starts a scripted upload or download. `onDone` runs only when the job is not cancelled. */
  startTransfer(
    kind: GridFsTransferKind,
    database: string,
    bucket: string,
    path: string,
    onDone: () => void,
  ): string;
}

interface StoredFile {
  readonly idEjson: string;
  filename: string;
  readonly length: number;
  readonly chunkSize: number;
  readonly uploadDate: Date;
  /** Holds the content type too, as the adapter writes it. */
  metadata: Record<string, unknown>;
}

/** Files per bucket name, per database name. */
type Buckets = Map<string, StoredFile[]>;
type Databases = Map<string, Buckets>;

interface SeedFile {
  readonly filename: string;
  readonly length: number;
  readonly contentType: string;
  readonly daysAgo: number;
  readonly metadata?: Record<string, unknown>;
}

const MOCK_CHUNK_SIZE_BYTES = 261_120;
const DAY_MS = 86_400_000;
const SEED_NOW_MS = Date.parse('2026-09-01T09:00:00Z');
const FIRST_SEED_ID = 0x300000;
const SEEDED_DATABASE = 'shop';

const SEED_BUCKETS: ReadonlyArray<{ readonly bucket: string; readonly files: SeedFile[] }> = [
  {
    bucket: 'receipts',
    files: [
      {
        filename: 'receipt-1001.pdf',
        length: 84_512,
        contentType: 'application/pdf',
        daysAgo: 1,
        metadata: { orderId: 'ord-1001', customer: 'Ana Kern' },
      },
      {
        filename: 'receipt-1002.pdf',
        length: 91_230,
        contentType: 'application/pdf',
        daysAgo: 3,
        metadata: { orderId: 'ord-1002', customer: 'Luka Novak' },
      },
      {
        filename: 'receipt-1003.pdf',
        length: 77_004,
        contentType: 'application/pdf',
        daysAgo: 8,
        metadata: { orderId: 'ord-1003', customer: 'Mila Horvat' },
      },
      {
        filename: 'receipt-1004.pdf',
        length: 102_877,
        contentType: 'application/pdf',
        daysAgo: 20,
        metadata: { orderId: 'ord-1004', customer: 'Ana Kern' },
      },
    ],
  },
  {
    bucket: 'product_images',
    files: [
      {
        filename: 'hero-banner.jpg',
        length: 1_286_144,
        contentType: 'image/jpeg',
        daysAgo: 2,
        metadata: { campaign: 'spring' },
      },
      { filename: 'thumb-small.png', length: 48_213, contentType: 'image/png', daysAgo: 5 },
      { filename: 'logo-dark.svg', length: 12_480, contentType: 'image/svg+xml', daysAgo: 30 },
    ],
  },
];

/** The file name of a dialog path: the part after the last slash or backslash. */
function fileNameOf(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

function idEjsonOf(sequence: number): string {
  return JSON.stringify({ $oid: objectIdHex(sequence) });
}

function toFile(file: StoredFile): GridFsFile {
  const contentType =
    typeof file.metadata.contentType === 'string' ? file.metadata.contentType : undefined;
  const hasMetadata = Object.keys(file.metadata).length > 0;
  return {
    idEjson: file.idEjson,
    filename: file.filename,
    length: file.length,
    chunkSize: file.chunkSize,
    uploadDate: file.uploadDate.toISOString(),
    ...(contentType === undefined ? {} : { contentType }),
    ...(hasMetadata ? { metadataEjson: JSON.stringify(file.metadata) } : {}),
  };
}

/** Parses the metadata the user typed. The mock reads JSON, which is the EJSON it accepts. */
function parseMetadata(text: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw fail('VALIDATION', 'The metadata is not valid EJSON');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw fail('VALIDATION', 'The metadata must be a JSON object');
  }
  return value as Record<string, unknown>;
}

function seedStore(sequence: { next(): number }): Buckets {
  const buckets: Buckets = new Map();
  for (const seed of SEED_BUCKETS) {
    buckets.set(
      seed.bucket,
      seed.files.map((file) => ({
        idEjson: idEjsonOf(sequence.next()),
        filename: file.filename,
        length: file.length,
        chunkSize: MOCK_CHUNK_SIZE_BYTES,
        uploadDate: new Date(SEED_NOW_MS - file.daysAgo * DAY_MS),
        metadata: { ...(file.metadata ?? {}), contentType: file.contentType },
      })),
    );
  }
  return buckets;
}

function compareFiles(a: StoredFile, b: StoredFile, sort: GridFsListInput['sort']): number {
  if (sort === 'filename') {
    return a.filename.localeCompare(b.filename);
  }
  if (sort === 'length') {
    return a.length - b.length;
  }
  return a.uploadDate.getTime() - b.uploadDate.getTime();
}

/** Filters, sorts and limits the files the way the adapter does. Matching is case-insensitive. */
function listed(files: readonly StoredFile[], input: GridFsListInput): StoredFile[] {
  const needle = input.filter?.filenameContains?.toLowerCase() ?? '';
  const since = input.filter?.since === undefined ? undefined : Date.parse(input.filter.since);
  const until = input.filter?.until === undefined ? undefined : Date.parse(input.filter.until);
  const direction = input.direction === 'asc' ? 1 : -1;
  return files
    .filter((file) => file.filename.toLowerCase().includes(needle))
    .filter((file) => since === undefined || file.uploadDate.getTime() >= since)
    .filter((file) => until === undefined || file.uploadDate.getTime() <= until)
    .sort((a, b) => compareFiles(a, b, input.sort) * direction)
    .slice(0, input.limit);
}

/**
 * The GridFS calls of the mock backend. Each connection keeps its own buckets. A fresh connection
 * starts with two buckets in the `shop` database. Uploads and downloads run through the scripted
 * transfers, so they report progress and can be cancelled.
 */
export function createMockGridFs(context: MockGridFsContext): RpcClient['gridfs'] {
  const latencyMs = context.latencyMs;
  const stores = new Map<string, Databases>();
  // Local paths that already hold a file in the mock. A download without overwrite refuses them.
  const existingPaths = new Set<string>([MOCK_EXISTING_FILE]);
  let sequence = FIRST_SEED_ID;
  const nextId = (): number => {
    sequence += 1;
    return sequence;
  };

  function databasesOf(connectionId: string): Databases {
    let databases = stores.get(connectionId);
    if (databases === undefined) {
      databases = new Map([[SEEDED_DATABASE, seedStore({ next: nextId })]]);
      stores.set(connectionId, databases);
    }
    return databases;
  }

  function bucketsOf(connectionId: string, database: string): Buckets {
    const databases = databasesOf(connectionId);
    let buckets = databases.get(database);
    if (buckets === undefined) {
      buckets = new Map();
      databases.set(database, buckets);
    }
    return buckets;
  }

  function filesOf(connectionId: string, database: string, bucket: string): StoredFile[] {
    const buckets = bucketsOf(connectionId, database);
    let files = buckets.get(bucket);
    if (files === undefined) {
      files = [];
      buckets.set(bucket, files);
    }
    return files;
  }

  function requireFile(files: StoredFile[], idEjson: string): StoredFile {
    const found = files.find((file) => file.idEjson === idEjson);
    if (found === undefined) {
      throw fail('NOT_FOUND', 'No file with that id exists in the bucket');
    }
    return found;
  }

  return {
    listBuckets: method(rpcContract.gridfs.listBuckets, latencyMs, (input) => {
      context.guard(input.connectionId);
      const buckets = bucketsOf(input.connectionId, input.database);
      return [...buckets.entries()]
        .map(([name, files]) => ({
          name,
          filesCollection: `${name}.files`,
          chunksCollection: `${name}.chunks`,
          fileCount: files.length,
          totalBytes: files.reduce((total, file) => total + file.length, 0),
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
    }),
    listFiles: method(rpcContract.gridfs.listFiles, latencyMs, (input) => {
      context.guard(input.connectionId);
      const files = filesOf(input.connectionId, input.database, input.bucket);
      return listed(files, input).map(toFile);
    }),
    getFile: method(rpcContract.gridfs.getFile, latencyMs, (input) => {
      context.guard(input.connectionId);
      const files = filesOf(input.connectionId, input.database, input.bucket);
      return toFile(requireFile(files, input.idEjson));
    }),
    startUpload: method(rpcContract.gridfs.startUpload, latencyMs, (input) => {
      context.guard(input.connectionId);
      const metadata = input.metadataEjson === undefined ? {} : parseMetadata(input.metadataEjson);
      if (input.contentType !== undefined) {
        metadata.contentType = input.contentType;
      }
      const { connectionId, database, bucket } = input;
      const filename = input.filename ?? fileNameOf(input.path);
      const transferId = context.startTransfer(
        'gridfs-upload',
        database,
        bucket,
        input.path,
        () => {
          filesOf(connectionId, database, bucket).push({
            idEjson: idEjsonOf(nextId()),
            filename,
            length: GRIDFS_JOB_BYTES,
            chunkSize: input.chunkSizeBytes ?? MOCK_CHUNK_SIZE_BYTES,
            uploadDate: new Date(),
            metadata,
          });
        },
      );
      return { transferId };
    }),
    startDownload: method(rpcContract.gridfs.startDownload, latencyMs, (input) => {
      context.guard(input.connectionId);
      const files = filesOf(input.connectionId, input.database, input.bucket);
      requireFile(files, input.idEjson);
      if (input.overwrite !== true && existingPaths.has(input.path)) {
        throw fail('ALREADY_EXISTS', 'The file exists. Replace it to overwrite.');
      }
      const transferId = context.startTransfer(
        'gridfs-download',
        input.database,
        input.bucket,
        input.path,
        () => {
          existingPaths.add(input.path);
        },
      );
      return { transferId };
    }),
    deleteFiles: method(rpcContract.gridfs.deleteFiles, latencyMs, (input) => {
      context.guard(input.connectionId);
      const files = filesOf(input.connectionId, input.database, input.bucket);
      for (const idEjson of input.idsEjson) {
        requireFile(files, idEjson);
      }
      const remove = new Set(input.idsEjson);
      const kept = files.filter((file) => !remove.has(file.idEjson));
      const deleted = files.length - kept.length;
      files.splice(0, files.length, ...kept);
      return { deleted };
    }),
    renameFile: method(rpcContract.gridfs.renameFile, latencyMs, (input) => {
      context.guard(input.connectionId);
      const file = requireFile(
        filesOf(input.connectionId, input.database, input.bucket),
        input.idEjson,
      );
      file.filename = input.filename;
      return toFile(file);
    }),
    setMetadata: method(rpcContract.gridfs.setMetadata, latencyMs, (input) => {
      context.guard(input.connectionId);
      const file = requireFile(
        filesOf(input.connectionId, input.database, input.bucket),
        input.idEjson,
      );
      file.metadata = parseMetadata(input.metadataEjson);
      return toFile(file);
    }),
    dropBucket: method(rpcContract.gridfs.dropBucket, latencyMs, (input) => {
      context.guard(input.connectionId);
      bucketsOf(input.connectionId, input.database).delete(input.bucket);
    }),
  };
}
