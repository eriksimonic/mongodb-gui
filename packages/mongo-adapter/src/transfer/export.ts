import { once } from 'node:events';
import { createWriteStream, type WriteStream } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { finished } from 'node:stream/promises';
import {
  Binary,
  Decimal128,
  Double,
  Int32,
  Long,
  ObjectId,
  type Document,
  type FindCursor,
  type FindOptions,
  type MongoClient,
} from 'mongodb';
import {
  ExportRequestSchema,
  formatCsvRow,
  type AppError,
  type CsvDelimiter,
  type ExportOptions,
  type ExportRequest,
  type TransferProgress,
} from '@mongo-gui/core';
import { isPlainObject, type PlainObject } from '../documents';
import { EJSON, parseEjsonDocument, stringifyEjson } from '../management/ejson';
import { parseInput } from '../management/errors';
import { getPath } from './values';
import { ProgressTracker, throwIfCancelled, toFailure, type TransferHooks } from './progress';

const CURSOR_BATCH_SIZE = 1000;
const DISCOVERY_DOCUMENTS = 1000;
const PROGRESS_EVERY = 1000;
const FLUSH_CHARACTERS = 64 * 1024;

// Streams a collection or a query result to a file. The cursor is read in batches and each
// document is written as soon as it arrives. Writes wait for the stream to drain, so memory use
// does not depend on the size of the result. A file that was started is removed when the export
// fails or is cancelled.
export async function exportCollection(
  client: MongoClient,
  request: unknown,
  hooks: TransferHooks = {},
): Promise<TransferProgress> {
  const tracker = new ProgressTracker(hooks);
  let error: AppError | undefined;
  let path: string | undefined;
  let tempPath: string | undefined;
  let stream: WriteStream | undefined;
  let cursor: FindCursor<Document> | undefined;
  try {
    // Everything that can fail on the input is checked before the file is touched.
    const parsed: ExportRequest = parseInput(ExportRequestSchema, request);
    const find = findOptions(parsed.options);
    cursor = client
      .db(parsed.database)
      .collection<Document>(parsed.collection)
      .find(find.filter, find.options);
    throwIfCancelled(hooks.signal);
    // The text goes to a temporary file next to the target. It replaces the target only when the
    // whole export succeeded, so a cancelled or failed export never touches an existing file.
    tempPath = join(
      dirname(parsed.path),
      `${basename(parsed.path)}.${randomBytes(6).toString('hex')}.tmp`,
    );
    stream = createWriteStream(tempPath, { encoding: 'utf8' });
    // A listener is attached before anything else can fail. Without it, a write error such as
    // ENOSPC would be an uncaught exception. The error stays on stream.errored, where the write
    // loop checks it.
    stream.on('error', () => undefined);
    await once(stream, 'open');
    // Only a file this export opened is ever removed on failure, so an existing file survives a
    // failure that happens before the open.
    path = tempPath;
    await writeExport(cursor, stream, tracker, parsed.options, hooks.signal);
    await rename(tempPath, parsed.path);
    // The temporary file is now the target, so a later failure must not remove it.
    path = undefined;
  } catch (failure) {
    error = toFailure(failure);
    await discardFile(cursor, stream, path);
  }
  return tracker.snapshot({ done: true, ...(error === undefined ? {} : { error }) });
}

interface FindParts {
  readonly filter: Document;
  readonly options: FindOptions;
}

function findOptions(options: ExportOptions): FindParts {
  const filter: Document = parseEjsonDocument(options.filterEjson ?? '{}', 'The filter');
  const projection: Document | undefined =
    options.projectionEjson === undefined
      ? undefined
      : parseEjsonDocument(options.projectionEjson, 'The projection');
  const sort: Document | undefined =
    options.sortEjson === undefined ? undefined : parseEjsonDocument(options.sortEjson, 'The sort');
  return {
    filter,
    options: {
      batchSize: CURSOR_BATCH_SIZE,
      // Keep BSON wrappers, so that Int32, Long and Double survive the export without guessing.
      promoteValues: false,
      ...(projection === undefined ? {} : { projection }),
      ...(sort === undefined ? {} : { sort }),
      ...(options.limit === undefined ? {} : { limit: options.limit }),
    },
  };
}

async function writeExport(
  cursor: FindCursor<Document>,
  stream: WriteStream,
  tracker: ProgressTracker,
  options: ExportOptions,
  signal: AbortSignal | undefined,
): Promise<void> {
  const sink = new Sink(stream);
  const writeDocument = documentWriter(sink, options);
  // Only CSV without explicit columns needs documents ahead of the write, to find the columns.
  const head: Document[] = [];
  if (options.format === 'csv' && options.csv?.columns === undefined) {
    while (head.length < DISCOVERY_DOCUMENTS) {
      const next = await cursor.next();
      if (next === null) {
        break;
      }
      head.push(next);
    }
  }
  const csv = options.format === 'csv' ? csvLayout(options, head) : undefined;
  if (csv !== undefined) {
    await sink.write(`${formatCsvRow(csv.columns, csv.delimiter)}\n`);
  }
  if (options.format === 'json-array') {
    await sink.write('[\n');
  }
  // Columns found by discovery are fixed. A field that first appears later is not exported, and
  // the caller is told once per field.
  const discovered =
    csv !== undefined && options.csv?.columns === undefined ? new Set(csv.columns) : undefined;
  const emit = async (doc: Document): Promise<void> => {
    throwIfCancelled(signal);
    if (stream.errored !== null) {
      throw stream.errored;
    }
    if (discovered !== undefined && tracker.processed >= DISCOVERY_DOCUMENTS) {
      for (const path of flatten(doc).keys()) {
        if (!discovered.has(path)) {
          discovered.add(path);
          tracker.addWarning(
            `Field "${path}" first seen after document ${DISCOVERY_DOCUMENTS} was not exported`,
          );
        }
      }
    }
    await writeDocument(doc, csv);
    tracker.processed += 1;
    if (tracker.processed % PROGRESS_EVERY === 0) {
      tracker.emit({});
    }
  };
  // splice empties the buffer, so the discovered documents are not kept alive for the whole export.
  for (const doc of head.splice(0)) {
    await emit(doc);
  }
  for await (const doc of cursor) {
    await emit(doc);
  }
  if (options.format === 'json-array') {
    await sink.write(tracker.processed === 0 ? ']\n' : '\n]\n');
  }
  await sink.end();
  await finished(stream);
}

type CsvLayout = {
  readonly columns: string[];
  readonly delimiter: CsvDelimiter;
  readonly flatten: 'json' | 'join';
};

function csvLayout(options: ExportOptions, head: readonly Document[]): CsvLayout {
  const csv = options.csv;
  const columns = csv?.columns ?? discoverColumns(head);
  return { columns, delimiter: csv?.delimiter ?? ',', flatten: csv?.flattenArrays ?? 'json' };
}

type DocumentWriter = (doc: Document, csv: CsvLayout | undefined) => Promise<void>;

// Writes one document in the chosen format. The first json-array element gets no leading comma.
function documentWriter(sink: Sink, options: ExportOptions): DocumentWriter {
  let written = 0;
  return async (doc, csv) => {
    written += 1;
    if (csv !== undefined) {
      await sink.write(`${formatCsvRow(csvCells(doc, csv), csv.delimiter)}\n`);
      return;
    }
    const text = renderDocument(doc, options.ejsonMode);
    if (options.format === 'ndjson') {
      await sink.write(`${text}\n`);
      return;
    }
    await sink.write(written === 1 ? text : `,\n${text}`);
  };
}

function renderDocument(doc: Document, mode: 'canonical' | 'relaxed'): string {
  return mode === 'relaxed' ? EJSON.stringify(doc, { relaxed: true }) : stringifyEjson(doc);
}

// Writes are buffered into large strings. A write waits for the stream to drain when the stream
// reports that its buffer is full.
class Sink {
  private buffer = '';

  constructor(private readonly stream: WriteStream) {}

  async write(text: string): Promise<void> {
    this.buffer += text;
    if (this.buffer.length >= FLUSH_CHARACTERS) {
      await this.flush();
    }
  }

  async end(): Promise<void> {
    await this.flush();
    this.stream.end();
  }

  private async flush(): Promise<void> {
    if (this.buffer === '') {
      return;
    }
    const chunk = this.buffer;
    this.buffer = '';
    // A failed stream never emits drain again, so the failure is raised here instead of waiting.
    if (this.stream.errored !== null) {
      throw this.stream.errored;
    }
    if (!this.stream.write(chunk)) {
      await once(this.stream, 'drain');
    }
  }
}

// Field names of the top-level and nested fields, in the order they first appear. Nested
// documents are flattened to dotted paths. Arrays and other values are leaves.
export function discoverColumns(docs: readonly Document[]): string[] {
  const seen = new Set<string>();
  for (const doc of docs) {
    for (const path of flatten(doc).keys()) {
      seen.add(path);
    }
  }
  return [...seen];
}

function flatten(
  doc: PlainObject,
  prefix = '',
  out = new Map<string, unknown>(),
): Map<string, unknown> {
  for (const [key, value] of Object.entries(doc)) {
    const path = prefix === '' ? key : `${prefix}.${key}`;
    if (isNestedDocument(value) && Object.keys(value).length > 0) {
      flatten(value, path, out);
    } else {
      out.set(path, value);
    }
  }
  return out;
}

function isNestedDocument(value: unknown): value is PlainObject {
  return isPlainObject(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function csvCells(doc: Document, csv: CsvLayout): string[] {
  const flat = flatten(doc);
  return csv.columns.map((column) => {
    if (flat.has(column)) {
      return renderCell(flat.get(column), csv.flatten);
    }
    // A column named after a nested document renders that document as EJSON text.
    return renderCell(getPath(doc, column.split('.')), csv.flatten);
  });
}

// Arrays are JSON text in json mode, which the importer reads back as a json cell. In join mode
// the elements are joined with a semicolon.
export function renderCell(value: unknown, flattenArrays: 'json' | 'join'): string {
  if (Array.isArray(value)) {
    return flattenArrays === 'join'
      ? value.map((item) => renderScalar(item)).join(';')
      : stringifyEjson(value);
  }
  return renderScalar(value);
}

// A single value as text. Numbers keep their BSON type visible: a double always has a decimal
// point, so it is read back as a double and not as an int32.
export function renderScalar(value: unknown): string {
  if (value === undefined || value === null) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  if (typeof value === 'number') {
    return formatDouble(value);
  }
  if (value instanceof Int32) {
    return String(value.value);
  }
  if (value instanceof Double) {
    return formatDouble(value.value);
  }
  if (value instanceof Long || value instanceof Decimal128) {
    return value.toString();
  }
  if (value instanceof ObjectId) {
    return value.toHexString();
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? '' : value.toISOString();
  }
  if (value instanceof Binary) {
    return Buffer.from(value.buffer.subarray(0, value.position)).toString('base64');
  }
  return stringifyEjson(value);
}

function formatDouble(value: number): string {
  if (Number.isNaN(value)) {
    return 'NaN';
  }
  if (!Number.isFinite(value)) {
    return value > 0 ? 'Infinity' : '-Infinity';
  }
  const text = String(value);
  return /^-?\d+$/.test(text) ? `${text}.0` : text;
}

// Removes a partial export. Errors are ignored, because the export has already failed.
async function discardFile(
  cursor: FindCursor<Document> | undefined,
  stream: WriteStream | undefined,
  path: string | undefined,
): Promise<void> {
  await cursor?.close().catch(() => undefined);
  if (stream !== undefined && !stream.closed) {
    stream.destroy();
    await finished(stream).catch(() => undefined);
  }
  if (path !== undefined) {
    await rm(path, { force: true }).catch(() => undefined);
  }
}
