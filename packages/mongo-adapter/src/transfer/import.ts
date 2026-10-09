import { stat } from 'node:fs/promises';
import type {
  AnyBulkWriteOperation,
  BulkWriteResult,
  Collection,
  Document,
  MongoClient,
} from 'mongodb';
import {
  BSON,
  Decimal128,
  Double,
  Int32,
  Long,
  MongoAPIError,
  MongoBulkWriteError,
  ObjectId,
} from 'mongodb';
import {
  appError,
  createCsvParser,
  CsvOptionsSchema,
  ImportPreviewRequestSchema,
  ImportRequestSchema,
  inferType,
  PREVIEW_SAMPLE_ROWS,
  type AppError,
  type CsvOptions,
  type ImportFormat,
  type ImportPreview,
  type ImportPreviewField,
  type ImportPreviewRequest,
  type ImportRequest,
  type TransferProgress,
  type FieldType,
} from '@mongo-gui/core';
import { isPlainObject, type PlainObject } from '../documents';
import { EJSON, parseEjson, stringifyEjson } from '../management/ejson';
import { parseInput, refuseReservedDatabase, validationError } from '../management/errors';
import {
  cellText,
  convertRecord,
  csvColumnNames,
  resolveCsvFields,
  resolveJsonFields,
  writeOperation,
  type RowPlan,
  type SourceRecord,
} from './plan';
import {
  cancelledError,
  ProgressTracker,
  throwIfCancelled,
  toFailure,
  type Sizes,
  type TransferHooks,
} from './progress';
import {
  openTextSource,
  parseCsvRecords,
  readHead,
  splitJsonArray,
  splitLines,
  type TextSource,
} from './source';

const SNIFF_RECORDS = 10;
const TYPE_SAMPLE_RECORDS = 1000;
const DELIMITERS = [',', ';', '\t', '|'] as const;
const EXAMPLE_COUNT = 3;
const BYTE_ORDER_MARK = /^\uFEFF/;

export function detectFormat(text: string): ImportFormat {
  const first = text.replace(BYTE_ORDER_MARK, '').trimStart().charAt(0);
  if (first === '[') {
    return 'json-array';
  }
  if (first === '{') {
    return 'ndjson';
  }
  return 'csv';
}

// Picks the delimiter whose field count is most consistent over the first records. A delimiter
// that never splits the lines is not a candidate, so one-column files default to a comma.
export function sniffDelimiter(text: string, truncated: boolean): CsvOptions['delimiter'] {
  let best: { delimiter: CsvOptions['delimiter']; agreeing: number; width: number } | undefined;
  for (const delimiter of DELIMITERS) {
    const records = completeRecords(text, delimiter, truncated).slice(0, SNIFF_RECORDS);
    const counts = new Map<number, number>();
    for (const record of records) {
      counts.set(record.length, (counts.get(record.length) ?? 0) + 1);
    }
    for (const [width, agreeing] of counts) {
      if (width < 2) {
        continue;
      }
      const better =
        best === undefined ||
        agreeing > best.agreeing ||
        (agreeing === best.agreeing && width > best.width);
      if (better) {
        best = { delimiter, agreeing, width };
      }
    }
  }
  return best?.delimiter ?? ',';
}

// Records that are complete in the text. Parse errors in the head are ignored: the head is only
// a sample, so a record that cannot be parsed there simply does not count.
function completeRecords(text: string, delimiter: string, truncated: boolean): string[][] {
  const parser = createCsvParser({ delimiter });
  try {
    const records = parser.write(text);
    return truncated ? records : [...records, ...parser.flush()];
  } catch {
    return [];
  }
}

// Reads the head of a file and describes it: format, CSV options, field types, and a few rows.
export async function previewImport(request: unknown): Promise<ImportPreview> {
  const parsed: ImportPreviewRequest = parseInput(ImportPreviewRequestSchema, request);
  const head = await readHeadOrThrow(parsed.path);
  const format = parsed.format ?? detectFormat(head.text);
  if (format === 'csv') {
    return previewCsv(head, parsed);
  }
  return previewJson(head, format, parsed.sampleRows);
}

async function readHeadOrThrow(path: string): Promise<Awaited<ReturnType<typeof readHead>>> {
  try {
    return await readHead(path);
  } catch {
    throw validationError('The file could not be read');
  }
}

function estimateRows(
  count: number,
  head: { truncated: boolean; size: number; text: string },
): number | undefined {
  if (!head.truncated) {
    return count;
  }
  const headBytes = Buffer.byteLength(head.text, 'utf8');
  return headBytes === 0 ? undefined : Math.round((count * head.size) / headBytes);
}

async function previewCsv(
  head: Awaited<ReturnType<typeof readHead>>,
  request: ImportPreviewRequest,
): Promise<ImportPreview> {
  const warnings: string[] = [];
  const delimiter = request.csv?.delimiter ?? sniffDelimiter(head.text, head.truncated);
  const records = completeRecords(head.text, delimiter, head.truncated);
  const csv: CsvOptions = request.csv ?? {
    ...CsvOptionsSchema.parse({}),
    delimiter,
  };
  const hasHeader = request.csv?.hasHeader ?? guessHeader(records);
  const csvUsed: CsvOptions = { ...csv, hasHeader };
  const header = hasHeader ? records[0] : undefined;
  const data = records.slice(hasHeader ? 1 : 0, (hasHeader ? 1 : 0) + request.sampleRows);
  const width = header?.length ?? data[0]?.length ?? 0;
  const names = csvColumnNames(header, width, csv.trim);
  warnings.push(...names.warnings);
  if (records.length === 0) {
    warnings.push('The file has no rows');
  }
  const fields = resolveCsvFields(names.names, undefined, data, csvUsed);
  const plan: RowPlan = { format: 'csv', columns: names.names, csv: csvUsed, fields };
  const sampleRows = data.slice(0, PREVIEW_SAMPLE_ROWS).map((record) => {
    const result = convertRecord({ kind: 'csv', fields: record }, plan);
    return result.ok ? toJsonSafe(result.doc) : rawRow(names.names, record);
  });
  const previewFields: ImportPreviewField[] = names.names.map((name, index) => {
    const cells = data.map((record) => cellText(record[index], csvUsed));
    const present = cells.filter((cell): cell is string => cell !== null);
    return {
      name,
      inferredType: inferType(cells),
      examples: [...new Set(present)].slice(0, EXAMPLE_COUNT),
      nullCount: cells.length - present.length,
    };
  });
  const estimated = estimateRows(records.length - (hasHeader ? 1 : 0), head);
  return {
    detectedFormat: 'csv',
    csv: csvUsed,
    fields: previewFields,
    sampleRows,
    ...(estimated === undefined ? {} : { estimatedRows: Math.max(0, estimated) }),
    warnings,
  };
}

// A header is assumed unless every cell of the first record reads as a number, a date, or
// another non-text value. Such a first record is data.
function guessHeader(records: readonly string[][]): boolean {
  const first = records[0];
  if (first === undefined || records.length < 2) {
    return true;
  }
  return !first.every((cell) => inferType([cell]) !== 'string');
}

function rawRow(names: readonly string[], record: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(names.map((name, index) => [name, record[index] ?? null]));
}

async function previewJson(
  head: Awaited<ReturnType<typeof readHead>>,
  format: 'json-array' | 'ndjson',
  sampleRows: number,
): Promise<ImportPreview> {
  const warnings: string[] = [];
  const texts: string[] = [];
  let count = 0;
  if (format === 'json-array') {
    for await (const text of splitJsonArray(oneChunk(head.text), head.truncated)) {
      count += 1;
      if (texts.length < sampleRows) {
        texts.push(text);
      }
    }
  } else {
    const lines = head.text.split('\n');
    const complete = head.truncated ? lines.slice(0, -1) : lines;
    for (const line of complete) {
      if (line.trim() === '') {
        continue;
      }
      count += 1;
      if (texts.length < sampleRows) {
        texts.push(line.replace(/\r$/, ''));
      }
    }
  }
  const docs: PlainObject[] = [];
  texts.forEach((text, index) => {
    try {
      const value = parseEjson(text, 'The row');
      if (isPlainObject(value)) {
        docs.push(value);
      } else {
        warnings.push(`Row ${index + 1} is not a JSON object and is skipped`);
      }
    } catch (error) {
      warnings.push(
        `Row ${index + 1} is not valid: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
  });
  if (count === 0) {
    warnings.push('The file has no rows');
  }
  const estimated = estimateRows(count, head);
  return {
    detectedFormat: format,
    fields: previewJsonFields(docs),
    sampleRows: docs.slice(0, PREVIEW_SAMPLE_ROWS).map(toJsonSafe),
    ...(estimated === undefined ? {} : { estimatedRows: estimated }),
    warnings,
  };
}

async function* oneChunk(text: string): AsyncGenerator<string> {
  yield text;
}

function previewJsonFields(docs: readonly PlainObject[]): ImportPreviewField[] {
  const names = [...new Set(docs.flatMap((doc) => Object.keys(doc)))];
  return names.map((name) => {
    const values = docs.map((doc) => doc[name]);
    const present = values.filter((value) => value !== undefined && value !== null);
    const types = new Set(present.map(jsonFieldType));
    return {
      name,
      inferredType: summariseTypes(types),
      examples: [...new Set(present.map(displayExample))].slice(0, EXAMPLE_COUNT),
      nullCount: values.length - present.length,
    };
  });
}

function summariseTypes(types: ReadonlySet<FieldType>): FieldType {
  if (types.size === 0) {
    return 'null';
  }
  if (types.size === 1) {
    return [...types][0] ?? 'string';
  }
  if ([...types].every((type) => type === 'int' || type === 'long' || type === 'double')) {
    return types.has('double') ? 'double' : types.has('long') ? 'long' : 'int';
  }
  return 'string';
}

function jsonFieldType(value: unknown): FieldType {
  if (typeof value === 'string') {
    return 'string';
  }
  if (typeof value === 'boolean') {
    return 'boolean';
  }
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= -2147483648 && value <= 2147483647
      ? 'int'
      : 'double';
  }
  if (value instanceof Int32) {
    return 'int';
  }
  if (value instanceof Long) {
    return 'long';
  }
  if (value instanceof Double) {
    return 'double';
  }
  if (value instanceof Decimal128) {
    return 'decimal';
  }
  if (value instanceof Date) {
    return 'date';
  }
  if (value instanceof ObjectId) {
    return 'objectId';
  }
  return 'json';
}

// Long and Decimal128 print their exact digits. Relaxed EJSON would pass them through a JavaScript
// number and lose precision, so the preview shows them as the driver's exact text.
function displayExample(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value instanceof Long || value instanceof Decimal128) {
    return value.toString();
  }
  return EJSON.stringify(value, { relaxed: true });
}

// The canonical EJSON form of a document as plain JSON, so that it can cross the RPC boundary.
export function toJsonSafe(doc: PlainObject): Record<string, unknown> {
  const parsed: unknown = JSON.parse(stringifyEjson(doc));
  return isPlainObject(parsed) ? parsed : {};
}

const WRITE_FAILED = 'The server rejected the document';

interface Prepared {
  readonly plan: RowPlan;
  readonly records: AsyncIterable<SourceRecord>;
}

interface WriteSettings {
  readonly batchSize: number;
  readonly stopOnError: boolean;
  readonly mode: 'insert' | 'upsert';
  readonly upsertKey: string;
}

// Streams a file into a collection. Failures are reported in the progress event, not thrown:
// a row that does not convert is a row error, and a failure of the whole transfer ends it with
// an error. Writes already made stay in the collection, and the final progress says how far it
// got. Cancellation is honoured between records; the batch in progress is written first, so the
// counts always match the documents in the collection.
export async function importFile(
  client: MongoClient,
  request: unknown,
  hooks: TransferHooks = {},
): Promise<TransferProgress> {
  const tracker = new ProgressTracker(hooks);
  let source: TextSource | undefined;
  let fileSize: number | undefined;
  let error: AppError | undefined;
  const sizes = (): Sizes => ({
    bytesRead: source?.bytesRead(),
    bytesTotal: fileSize,
  });
  try {
    const parsed: ImportRequest = parseInput(ImportRequestSchema, request);
    refuseReservedDatabase(parsed.database, 'import into');
    throwIfCancelled(hooks.signal);
    fileSize = (await stat(parsed.path)).size;
    const { options } = parsed;
    const csv = options.format === 'csv' ? (options.csv ?? CsvOptionsSchema.parse({})) : undefined;
    source = openTextSource(parsed.path);
    const iterator = asRecords(options.format, source.chunks, csv)[Symbol.asyncIterator]();
    const prepared = await prepare(iterator, csv, options.mappings);
    const collection = client.db(parsed.database).collection<Document>(parsed.collection);
    error = await writeRecords(
      collection,
      tracker,
      prepared,
      {
        batchSize: options.batchSize,
        stopOnError: options.stopOnError,
        mode: options.mode,
        upsertKey: options.upsertKey,
      },
      hooks.signal,
      sizes,
    );
  } catch (failure) {
    error = toFailure(failure);
  } finally {
    source?.close();
  }
  return tracker.snapshot({ ...sizes(), done: true, ...(error === undefined ? {} : { error }) });
}

async function* asRecords(
  format: ImportFormat,
  chunks: AsyncIterable<string>,
  csv: CsvOptions | undefined,
): AsyncGenerator<SourceRecord> {
  if (format === 'csv') {
    for await (const fields of parseCsvRecords(chunks, csv ?? CsvOptionsSchema.parse({}))) {
      // A record made only of empty cells is an empty row.
      if (fields.some((field) => field.trim() !== '')) {
        yield { kind: 'csv', fields };
      }
    }
    return;
  }
  const texts = format === 'json-array' ? splitJsonArray(chunks) : splitLines(chunks);
  for await (const text of texts) {
    if (format === 'ndjson' && text.trim() === '') {
      continue;
    }
    yield { kind: 'json', text };
  }
}

// Reads the CSV header, samples the first records to infer auto types, and resolves the plan.
// The sampled records are handed back in front of the rest, so nothing is read twice.
async function prepare(
  iterator: AsyncIterator<SourceRecord>,
  csv: CsvOptions | undefined,
  mappings: ImportRequest['options']['mappings'],
): Promise<Prepared> {
  if (csv === undefined) {
    return {
      plan: { format: 'json', fields: resolveJsonFields(mappings) },
      records: resume([], iterator),
    };
  }
  let header: string[] | undefined;
  if (csv.hasHeader) {
    const first = await iterator.next();
    if (!first.done && first.value.kind === 'csv') {
      header = first.value.fields;
    }
  }
  const sample: SourceRecord[] = [];
  while (sample.length < TYPE_SAMPLE_RECORDS) {
    const next = await iterator.next();
    if (next.done) {
      break;
    }
    sample.push(next.value);
  }
  const sampleFields = sample.flatMap((record) => (record.kind === 'csv' ? [record.fields] : []));
  const width = header?.length ?? sampleFields[0]?.length ?? 0;
  const columns = csvColumnNames(header, width, csv.trim).names;
  const plan: RowPlan = {
    format: 'csv',
    columns,
    csv,
    fields: resolveCsvFields(columns, mappings, sampleFields, csv),
  };
  return { plan, records: resume(sample, iterator) };
}

async function* resume(
  head: readonly SourceRecord[],
  rest: AsyncIterator<SourceRecord>,
): AsyncGenerator<SourceRecord> {
  yield* head;
  for (;;) {
    const next = await rest.next();
    if (next.done) {
      return;
    }
    yield next.value;
  }
}

// Converts and writes the records in batches. Returns the error that ends the transfer early,
// or undefined when every record was handled.
async function writeRecords(
  collection: Collection<Document>,
  tracker: ProgressTracker,
  prepared: Prepared,
  settings: WriteSettings,
  signal: AbortSignal | undefined,
  sizes: () => Sizes,
): Promise<AppError | undefined> {
  let ops: AnyBulkWriteOperation<Document>[] = [];
  let rows: number[] = [];
  let queued = 0;
  let row = 0;

  const flush = async (): Promise<{ row: number; message: string } | undefined> => {
    const failure = ops.length > 0 ? await writeBatch(collection, ops, rows, tracker) : undefined;
    ops = [];
    rows = [];
    queued = 0;
    tracker.emit(sizes());
    return failure;
  };

  for await (const record of prepared.records) {
    if (signal?.aborted === true) {
      await flush();
      return cancelledError();
    }
    // Row numbers count data records (CSV) or elements and non-empty lines (JSON, NDJSON), not
    // physical lines of the file. See TransferProgressSchema.
    row += 1;
    tracker.processed += 1;
    queued += 1;
    const converted = convertRecord(record, prepared.plan);
    const write = converted.ok
      ? writeOperation(converted.doc, settings.mode, settings.upsertKey)
      : undefined;
    if (converted.ok && write?.ok === true) {
      ops.push(write.op);
      rows.push(row);
    } else {
      const message = converted.ok
        ? write?.ok === false
          ? write.message
          : WRITE_FAILED
        : converted.message;
      tracker.addRowError(row, message);
      if (settings.stopOnError) {
        await flush();
        return appError('VALIDATION', `The import stopped at row ${row}`, message);
      }
    }
    if (queued >= settings.batchSize) {
      const failure = await flush();
      if (settings.stopOnError && failure !== undefined) {
        return appError(
          'COMMAND_FAILED',
          `The import stopped at row ${failure.row}`,
          failure.message,
        );
      }
    }
  }
  if (queued > 0) {
    const failure = await flush();
    if (settings.stopOnError && failure !== undefined) {
      return appError(
        'COMMAND_FAILED',
        `The import stopped at row ${failure.row}`,
        failure.message,
      );
    }
  }
  return undefined;
}

// Writes one batch with ordered: false, so one bad document does not stop the rest. Returns the
// first write failure, if any, for the stop-on-error decision.
type Failure = { row: number; message: string } | undefined;

async function writeBatch(
  collection: Collection<Document>,
  ops: AnyBulkWriteOperation<Document>[],
  rows: readonly number[],
  tracker: ProgressTracker,
): Promise<Failure> {
  try {
    countResult(tracker, await collection.bulkWrite(ops, { ordered: false }));
    return undefined;
  } catch (error) {
    if (error instanceof MongoBulkWriteError) {
      return recordBulkError(error, rows, tracker);
    }
    if (isClientSideRefusal(error)) {
      // The driver refuses a document (for example one over the 16 MB limit) before anything is
      // sent, so nothing was written. The documents are written one at a time, which names the one
      // that was refused.
      return writeEach(collection, ops, rows, tracker);
    }
    throw error;
  }
}

async function writeEach(
  collection: Collection<Document>,
  ops: AnyBulkWriteOperation<Document>[],
  rows: readonly number[],
  tracker: ProgressTracker,
): Promise<Failure> {
  let first: Failure;
  for (const [index, op] of ops.entries()) {
    const row = rows[index] ?? 0;
    try {
      countResult(tracker, await collection.bulkWrite([op], { ordered: false }));
    } catch (error) {
      if (isClientSideRefusal(error)) {
        tracker.addRowError(row, error.message);
        first ??= { row, message: error.message };
      } else if (error instanceof MongoBulkWriteError) {
        first ??= recordBulkError(error, rows.slice(index), tracker);
      } else {
        throw error;
      }
    }
  }
  return first;
}

// A failure raised by the driver or the BSON encoder before the server was asked anything. A
// document the encoder cannot represent is the usual case.
// The encoder reports an oversize string as a RangeError (ERR_OUT_OF_RANGE), so that counts too.
function isClientSideRefusal(error: unknown): error is Error {
  return (
    error instanceof BSON.BSONError || error instanceof MongoAPIError || error instanceof RangeError
  );
}

function countResult(tracker: ProgressTracker, result: BulkWriteResult): void {
  tracker.inserted += result.insertedCount + result.upsertedCount;
  tracker.updated += result.modifiedCount;
  tracker.matched += result.matchedCount;
}

function recordBulkError(
  error: MongoBulkWriteError,
  rows: readonly number[],
  tracker: ProgressTracker,
): Failure {
  countResult(tracker, error.result);
  const writeErrors = Array.isArray(error.writeErrors) ? error.writeErrors : [error.writeErrors];
  let first: Failure;
  for (const writeError of writeErrors) {
    const failedRow = rows[writeError.index] ?? 0;
    const message = writeError.errmsg ?? WRITE_FAILED;
    tracker.addRowError(failedRow, message);
    first ??= { row: failedRow, message };
  }
  return first;
}
