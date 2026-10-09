import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import {
  BSON,
  Binary,
  Decimal128,
  Double,
  Int32,
  Long,
  MongoClient,
  ObjectId,
  type Document,
} from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TransferProgress } from '@mongo-gui/core';
import {
  CONTAINER_STARTUP_TIMEOUT_MS,
  startMongo,
  type StartedMongo,
} from '../test/mongo-container';
import { exportCollection } from './export';
import { importFile, previewImport } from './import';

const DB = 'transfer_it';
const MAIN_IMAGE = 'mongo:8.0.17';
const OLD_IMAGE = 'mongo:4.4';
const SUITE_TIMEOUT_MS = 240_000;
const TEST_TIMEOUT_MS = 120_000;
const CSV_ROWS = 10_000;
const JSON_ROWS = 5_000;
const MEMORY_BUDGET_BYTES = 200 * 1024 * 1024;
const MB = 1024 * 1024;

let workDir = '';
let client: MongoClient;

// Runs a full garbage collection. The flag is set at runtime, so no node option is needed.
function collectGarbage(): void {
  setFlagsFromString('--expose_gc');
  const gc = runInNewContext('gc') as () => void;
  gc();
}

function uniqueName(prefix: string): string {
  return `${prefix}_${randomUUID().slice(0, 8)}`;
}

async function filePath(name: string): Promise<string> {
  return join(workDir, name);
}

// Always 24 hex characters with a letter first, so the value is never all digits and the auto
// type inference reads the whole column as ObjectId.
function hexId(index: number): string {
  return `a${index.toString(16).padStart(23, '0')}`;
}

function isoAt(index: number): string {
  return new Date(Date.UTC(2026, 0, 1) + index * 1000).toISOString();
}

// One row of the mixed-type CSV. Row 500 and its multiples carry a quoted multi-line note.
function csvLine(index: number): string {
  const note = index % 500 === 0 ? `"line one\nline ""two"", ok"` : `note ${index}`;
  const price = `${index % 1000}.${String(index % 100).padStart(2, '0')}`;
  const optional = index % 3 === 0 ? 'null' : String(index);
  return [
    index,
    index % 100,
    3_000_000_000 + index,
    price,
    index % 2 === 0 ? 'true' : 'FALSE',
    isoAt(index),
    hexId(index),
    note,
    '01234',
    optional,
    '',
  ].join(',');
}

const CSV_HEADER = 'id,count,big,price,active,createdAt,ref,note,zip,optional,empty';

async function writeCsv(name: string, rows: number): Promise<string> {
  const lines = [CSV_HEADER];
  for (let index = 1; index <= rows; index++) {
    lines.push(csvLine(index));
  }
  const path = await filePath(name);
  await writeFile(path, `${lines.join('\n')}\n`, 'utf8');
  return path;
}

async function countOf(collection: string): Promise<number> {
  return client.db(DB).collection(collection).countDocuments();
}

function expectClean(progress: TransferProgress): void {
  expect(progress.error).toBeUndefined();
  expect(progress.done).toBe(true);
  expect(progress.failed).toBe(0);
  expect(progress.errors).toEqual([]);
}

async function importCsvWithDefaults(path: string, collection: string): Promise<TransferProgress> {
  return importFile(client, {
    database: DB,
    collection,
    path,
    options: { format: 'csv', batchSize: 500 },
  });
}

async function importChecks(image: string): Promise<void> {
  const collection = uniqueName(`csv_${image.replace(/\W/g, '')}`);
  const path = await writeCsv(`${collection}.csv`, CSV_ROWS);

  const started = performance.now();
  const progress = await importCsvWithDefaults(path, collection);
  const seconds = (performance.now() - started) / 1000;
  expectClean(progress);
  expect(progress.processed).toBe(CSV_ROWS);
  expect(progress.inserted).toBe(CSV_ROWS);
  expect(progress.bytesTotal).toBe((await stat(path)).size);
  expect(progress.bytesRead).toBe(progress.bytesTotal);
  expect(seconds).toBeLessThan(120);
  expect(await countOf(collection)).toBe(CSV_ROWS);

  const row = await client
    .db(DB)
    .collection<Document>(collection)
    .findOne({ id: 42 }, { promoteValues: false });
  expect(row).not.toBeNull();
  expect(row?.id).toBeInstanceOf(Int32);
  expect(row?.count).toBeInstanceOf(Int32);
  expect(row?.big).toBeInstanceOf(Long);
  expect(row?.big.toString()).toBe('3000000042');
  expect(row?.price).toBeInstanceOf(Double);
  expect(row?.price.value).toBe(42.42);
  expect(row?.active).toBe(true);
  expect(row?.createdAt).toBeInstanceOf(Date);
  expect(row?.createdAt.toISOString()).toBe(isoAt(42));
  expect(row?.ref).toBeInstanceOf(ObjectId);
  expect(row?.ref.toHexString()).toBe(hexId(42));
  expect(row?.note).toBe('note 42');
  expect(row?.zip).toBe('01234');
  expect(row?.optional).toBeNull();
  const numbered = await client
    .db(DB)
    .collection<Document>(collection)
    .findOne({ id: 43 }, { promoteValues: false });
  expect(numbered?.optional).toBeInstanceOf(Int32);
  expect(row?.empty).toBeNull();

  const nullRow = await client
    .db(DB)
    .collection<Document>(collection)
    .findOne({ id: 3 }, { promoteValues: false });
  expect(nullRow?.optional).toBeNull();

  const multiline = await client
    .db(DB)
    .collection<Document>(collection)
    .findOne({ id: 500 }, { promoteValues: false });
  expect(multiline?.note).toBe('line one\nline "two", ok');
}

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'mongo-gui-transfer-'));
});

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe('streaming transfer on mongo 8.0', () => {
  let started: StartedMongo;

  beforeAll(async () => {
    started = await startMongo(MAIN_IMAGE);
    client = new MongoClient(started.rootUri);
    await client.connect();
  }, CONTAINER_STARTUP_TIMEOUT_MS);

  afterAll(async () => {
    await client?.close();
    await started?.stop();
  }, CONTAINER_STARTUP_TIMEOUT_MS);

  it(
    'imports a 10,000-row CSV with mixed types and a quoted multi-line field',
    async () => {
      await importChecks(MAIN_IMAGE);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'previews the CSV and reports the field types and the estimated row count',
    async () => {
      const path = await writeCsv(`${uniqueName('preview')}.csv`, CSV_ROWS);
      const preview = await previewImport({ path, sampleRows: 100 });
      expect(preview.detectedFormat).toBe('csv');
      expect(preview.csv?.delimiter).toBe(',');
      expect(preview.csv?.hasHeader).toBe(true);
      const types = Object.fromEntries(
        preview.fields.map((field) => [field.name, field.inferredType]),
      );
      expect(types).toEqual({
        id: 'int',
        count: 'int',
        big: 'long',
        price: 'double',
        active: 'boolean',
        createdAt: 'date',
        ref: 'objectId',
        note: 'string',
        zip: 'string',
        optional: 'int',
        empty: 'string',
      });
      expect(preview.fields.find((field) => field.name === 'optional')?.nullCount).toBe(
        Math.floor(100 / 3),
      );
      expect(preview.fields.find((field) => field.name === 'empty')?.nullCount).toBe(100);
      expect(preview.sampleRows).toHaveLength(20);
      const estimate = preview.estimatedRows ?? 0;
      expect(Math.abs(estimate - CSV_ROWS) / CSV_ROWS).toBeLessThan(0.05);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'detects the delimiter, the header, and duplicate column names',
    async () => {
      const path = await filePath(`${uniqueName('semi')}.csv`);
      await writeFile(path, 'a;a;b\n1;2;x\n3;4;y\n', 'utf8');
      const preview = await previewImport({ path, sampleRows: 10 });
      expect(preview.csv?.delimiter).toBe(';');
      expect(preview.fields.map((field) => field.name)).toEqual(['a', 'a_2', 'b']);
      expect(preview.warnings).toContain('Duplicate column "a" is renamed to "a_2"');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'imports NDJSON with EJSON types and keeps them',
    async () => {
      const collection = uniqueName('ndjson_types');
      const known =
        '{"_id":{"$oid":"64b000000000000000000001"},"n":{"$numberLong":"5"},"i":{"$numberInt":"7"},"d":{"$date":"2026-01-01T00:00:00Z"},"dec":{"$numberDecimal":"1.50"},"bin":{"$binary":{"base64":"AQI=","subType":"00"}},"plain":"x","nested":{"a":[1,2]}}';
      const lines = [known, ''];
      for (let index = 1; index <= 999; index++) {
        lines.push(
          `{"_id":{"$oid":"${hexId(index + 1000)}"},"n":{"$numberLong":"${index}"},"tag":"row ${index}"}`,
        );
      }
      const path = await filePath(`${collection}.ndjson`);
      await writeFile(path, lines.join('\r\n'), 'utf8');

      const progress = await importFile(client, {
        database: DB,
        collection,
        path,
        options: { format: 'ndjson' },
      });
      expectClean(progress);
      expect(progress.inserted).toBe(1000);
      expect(await countOf(collection)).toBe(1000);

      const row = await client
        .db(DB)
        .collection<Document>(collection)
        .findOne({ _id: new ObjectId('64b000000000000000000001') }, { promoteValues: false });
      expect(row?.n).toBeInstanceOf(Long);
      expect(row?.n.toString()).toBe('5');
      expect(row?.i).toBeInstanceOf(Int32);
      expect(row?.d).toBeInstanceOf(Date);
      expect(row?.d.toISOString()).toBe('2026-01-01T00:00:00.000Z');
      expect(row?.dec).toBeInstanceOf(Decimal128);
      expect(row?.dec.toString()).toBe('1.50');
      expect(row?.bin).toBeInstanceOf(Binary);
      expect(row?.plain).toBe('x');
      expect(row?.nested.a[0]).toBeInstanceOf(Int32);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'imports a JSON array of 5,000 documents in batches with progress',
    async () => {
      const collection = uniqueName('json_array');
      const docs = Array.from({ length: JSON_ROWS }, (_, index) => ({
        _id: { $oid: hexId(index + 1) },
        seq: { $numberInt: String(index) },
        label: `doc ${index}`,
      }));
      const path = await filePath(`${collection}.json`);
      await writeFile(
        path,
        `[\n${docs.map((doc) => JSON.stringify(doc)).join(',\n')}\n]\n`,
        'utf8',
      );

      const events: TransferProgress[] = [];
      const progress = await importFile(
        client,
        { database: DB, collection, path, options: { format: 'json-array', batchSize: 500 } },
        { onProgress: (event) => events.push(event) },
      );
      expectClean(progress);
      expect(progress.inserted).toBe(JSON_ROWS);
      expect(events).toHaveLength(JSON_ROWS / 500);
      expect(events.at(-1)?.inserted).toBe(JSON_ROWS);
      expect(await countOf(collection)).toBe(JSON_ROWS);
      const row = await client
        .db(DB)
        .collection<Document>(collection)
        .findOne({ label: 'doc 77' }, { promoteValues: false });
      expect(row?.seq).toBeInstanceOf(Int32);
      expect(row?.seq.value).toBe(77);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'previews JSON array and NDJSON input and detects the format',
    async () => {
      const jsonPath = await filePath(`${uniqueName('detect')}.json`);
      await writeFile(jsonPath, '[{"a":1},{"a":2}]', 'utf8');
      const jsonPreview = await previewImport({ path: jsonPath, sampleRows: 10 });
      expect(jsonPreview.detectedFormat).toBe('json-array');
      expect(jsonPreview.fields).toEqual([
        { name: 'a', inferredType: 'int', examples: ['1', '2'], nullCount: 0 },
      ]);

      const ndjsonPath = await filePath(`${uniqueName('detect')}.ndjson`);
      await writeFile(
        ndjsonPath,
        '{"a":{"$numberLong":"9"}}\n{"a":{"$numberLong":"10"}}\n',
        'utf8',
      );
      const ndjsonPreview = await previewImport({ path: ndjsonPath, sampleRows: 10 });
      expect(ndjsonPreview.detectedFormat).toBe('ndjson');
      expect(ndjsonPreview.fields[0]?.inferredType).toBe('long');
      expect(ndjsonPreview.sampleRows[0]).toEqual({ a: { $numberLong: '9' } });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'upserts on a key, updating existing documents and inserting the rest',
    async () => {
      const collection = uniqueName('upsert');
      await client
        .db(DB)
        .collection(collection)
        .insertMany([
          { sku: 'A', qty: 1 },
          { sku: 'B', qty: 2 },
          { sku: 'C', qty: 3 },
        ]);
      const lines = [
        '{"sku":"A","qty":10}',
        '{"sku":"B","qty":20}',
        '{"sku":"C","qty":30}',
        '{"sku":"D","qty":40}',
        '{"sku":"E","qty":50}',
        '{"qty":1}',
      ];
      const path = await filePath(`${collection}.ndjson`);
      await writeFile(path, `${lines.join('\n')}\n`, 'utf8');

      const progress = await importFile(client, {
        database: DB,
        collection,
        path,
        options: { format: 'ndjson', mode: 'upsert', upsertKey: 'sku' },
      });
      expect(progress.error).toBeUndefined();
      expect(progress.updated).toBe(3);
      expect(progress.inserted).toBe(2);
      expect(progress.failed).toBe(1);
      expect(progress.errors).toEqual([{ row: 6, message: 'The row has no sku to upsert on' }]);
      expect(await countOf(collection)).toBe(5);
      const updated = await client.db(DB).collection(collection).findOne({ sku: 'A' });
      expect(updated?.qty).toBe(10);
      expect(progress.matched).toBe(3);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'counts an upsert that changes nothing as matched, not updated',
    async () => {
      const collection = uniqueName('upsert_same');
      // _id comes first in the stored document, as a replacement writes it. Any other field order
      // would count as a modification on the server.
      await client
        .db(DB)
        .collection(collection)
        .insertOne({ _id: new ObjectId(), sku: 'A', qty: 1 });
      const path = await filePath(`${collection}.ndjson`);
      await writeFile(path, '{"sku":"A","qty":1}\n', 'utf8');
      const progress = await importFile(client, {
        database: DB,
        collection,
        path,
        options: { format: 'ndjson', mode: 'upsert', upsertKey: 'sku' },
      });
      expectClean(progress);
      expect(progress.matched).toBe(1);
      // The server counts every replacement as modified, even one that changes nothing, so the
      // unchanged match shows in updated as well as in matched.
      expect(progress.updated).toBe(1);
      expect(progress.inserted).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'refuses a null upsert key and never matches on an operator-shaped key',
    async () => {
      const collection = uniqueName('upsert_keys');
      await client
        .db(DB)
        .collection(collection)
        .insertMany([{ name: 'no key' }, { k: 99, v: 'original' }]);
      const path = await filePath(`${collection}.ndjson`);
      await writeFile(path, '{"k":null,"v":"null key"}\n{"k":{"$gt":50},"v":"query"}\n', 'utf8');
      const progress = await importFile(client, {
        database: DB,
        collection,
        path,
        options: { format: 'ndjson', mode: 'upsert', upsertKey: 'k' },
      });
      expect(progress.error).toBeUndefined();
      expect(progress.failed).toBe(1);
      expect(progress.errors).toEqual([{ row: 1, message: 'The row has an empty k' }]);
      expect(progress.inserted).toBe(1);
      expect(progress.updated).toBe(0);
      const untouched = await client.db(DB).collection(collection).findOne({ name: 'no key' });
      expect(untouched).not.toHaveProperty('v');
      const original = await client.db(DB).collection(collection).findOne({ k: 99 });
      expect(original?.v).toBe('original');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'refuses BSON values that are not documents and keeps the other rows',
    async () => {
      const collection = uniqueName('bson_rows');
      const path = await filePath(`${collection}.json`);
      await writeFile(path, '[{"a":1}, 5, {"$oid":"64b000000000000000000001"}, {"a":2}]', 'utf8');
      const progress = await importFile(client, {
        database: DB,
        collection,
        path,
        options: { format: 'json-array' },
      });
      expect(progress.error).toBeUndefined();
      expect(progress.inserted).toBe(2);
      expect(progress.errors).toEqual([
        { row: 2, message: 'The row is not a JSON object' },
        { row: 3, message: 'The row is not a JSON object' },
      ]);
      expect(await countOf(collection)).toBe(2);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'fails only the row whose document is over the 16 MB limit',
    async () => {
      const collection = uniqueName('oversized');
      const path = await filePath(`${collection}.json`);
      const big = 'x'.repeat(17 * MB);
      await writeFile(path, `[{"a":1},{"big":"${big}"},{"a":2}]`, 'utf8');
      const progress = await importFile(client, {
        database: DB,
        collection,
        path,
        options: { format: 'json-array' },
      });
      expect(progress.error).toBeUndefined();
      expect(progress.inserted).toBe(2);
      expect(progress.failed).toBe(1);
      expect(progress.errors.map((error) => error.row)).toEqual([2]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'reports a missing export directory as a progress error',
    async () => {
      const source = uniqueName('missing_dir');
      await client.db(DB).collection(source).insertOne({ a: 1 });
      const path = join(workDir, 'no-such-dir', `${source}.json`);
      const progress = await exportCollection(client, {
        database: DB,
        collection: source,
        path,
        options: { format: 'json-array' },
      });
      expect(progress.done).toBe(true);
      expect(progress.error?.code).toBe('VALIDATION');
      await expect(stat(path)).rejects.toThrow();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'leaves an existing file alone when the export options are invalid',
    async () => {
      const source = uniqueName('keep_file');
      await client.db(DB).collection(source).insertOne({ a: 1 });
      const path = await filePath(`${source}.json`);
      await writeFile(path, 'keep me', 'utf8');
      const progress = await exportCollection(client, {
        database: DB,
        collection: source,
        path,
        options: { format: 'json-array', filterEjson: '{bad' },
      });
      expect(progress.error?.code).toBe('VALIDATION');
      expect(await readFile(path, 'utf8')).toBe('keep me');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'warns once for each field that first appears after the discovery window',
    async () => {
      const source = uniqueName('late_fields');
      const docs = Array.from({ length: 1500 }, (_, index) =>
        index >= 1000 ? { n: index, early: 1, late: 'x' } : { n: index, early: 1 },
      );
      await client.db(DB).collection(source).insertMany(docs);
      const path = await filePath(`${source}.csv`);
      const progress = await exportCollection(client, {
        database: DB,
        collection: source,
        path,
        options: { format: 'csv', sortEjson: '{"n":1}' },
      });
      expectClean(progress);
      expect(progress.warnings).toEqual([
        'Field "late" first seen after document 1000 was not exported',
      ]);
      const header = (await readFile(path, 'utf8')).split('\n')[0] ?? '';
      expect(header.split(',').sort()).toEqual(['_id', 'early', 'n']);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'collects row errors and keeps going when stopOnError is false',
    async () => {
      const lines = ['oid,n,label'];
      for (let index = 1; index <= 20; index++) {
        const oid = index === 15 ? hexId(1) : hexId(index);
        const n = index === 3 ? 'abc' : index === 9 ? 'x1' : String(index);
        lines.push(`${oid},${n},row ${index}`);
      }
      const path = await filePath(`${uniqueName('errors')}.csv`);
      await writeFile(path, `${lines.join('\n')}\n`, 'utf8');
      const options = {
        format: 'csv',
        csv: {},
        mappings: [
          { source: 'oid', target: '_id', type: 'objectId' },
          { source: 'n', target: 'n', type: 'int' },
          { source: 'label', target: 'label', type: 'string' },
        ],
        batchSize: 500,
      };

      const collection = uniqueName('errors_continue');
      const progress = await importFile(client, {
        database: DB,
        collection,
        path,
        options: { ...options, stopOnError: false },
      });
      expect(progress.error).toBeUndefined();
      expect(progress.processed).toBe(20);
      expect(progress.inserted).toBe(17);
      expect(progress.failed).toBe(3);
      expect(progress.errors.map((error) => error.row)).toEqual([3, 9, 15]);
      expect(progress.errors[0]?.message).toMatch(/^Column "n": "abc" is not a 32-bit integer/);
      expect(progress.errors[2]?.message).toMatch(/duplicate key/);
      expect(await countOf(collection)).toBe(17);

      const stopped = uniqueName('errors_stop');
      const halted = await importFile(client, {
        database: DB,
        collection: stopped,
        path,
        options: { ...options, stopOnError: true },
      });
      expect(halted.error?.code).toBe('VALIDATION');
      expect(halted.error?.message).toBe('The import stopped at row 3');
      expect(halted.inserted).toBe(2);
      expect(halted.processed).toBe(3);
      expect(await countOf(stopped)).toBe(2);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'cancels after the first progress event and leaves the partial count',
    async () => {
      const collection = uniqueName('cancel');
      const path = await writeCsv(`${collection}.csv`, CSV_ROWS);
      const controller = new AbortController();
      const events: TransferProgress[] = [];
      const progress = await importFile(
        client,
        { database: DB, collection, path, options: { format: 'csv', batchSize: 500 } },
        {
          signal: controller.signal,
          onProgress: (event) => {
            events.push(event);
            if (events.length === 1) {
              controller.abort();
            }
          },
        },
      );
      expect(progress.error?.code).toBe('CANCELLED');
      expect(progress.done).toBe(true);
      expect(progress.inserted).toBe(500);
      expect(progress.processed).toBe(500);
      expect(await countOf(collection)).toBe(500);
    },
    TEST_TIMEOUT_MS,
  );

  it('reports a pre-aborted import as cancelled without writing anything', async () => {
    const collection = uniqueName('precancel');
    const path = await writeCsv(`${collection}.csv`, 10);
    const controller = new AbortController();
    controller.abort();
    const progress = await importFile(
      client,
      { database: DB, collection, path, options: { format: 'csv' } },
      { signal: controller.signal },
    );
    expect(progress.error?.code).toBe('CANCELLED');
    expect(progress.inserted).toBe(0);
  });

  it('refuses a relative path and a missing file with a progress error', async () => {
    const relative = await importFile(client, {
      database: DB,
      collection: 'x',
      path: 'relative.csv',
      options: { format: 'csv' },
    });
    expect(relative.error?.code).toBe('VALIDATION');
    const missing = await importFile(client, {
      database: DB,
      collection: uniqueName('missing'),
      path: join(workDir, 'does-not-exist.csv'),
      options: { format: 'csv' },
    });
    expect(missing.error?.code).toBe('VALIDATION');
    expect(missing.done).toBe(true);
  });

  it(
    'exports to every format and imports each back to the same documents',
    async () => {
      const source = uniqueName('roundtrip_source');
      const known = new ObjectId('64b000000000000000000042');
      const docs: Document[] = Array.from({ length: 2000 }, (_, index) => ({
        i: index,
        long: Long.fromNumber(3_000_000_000 + index),
        d1: new Double(index % 2 === 0 ? 1 : 2.5),
        dec: Decimal128.fromString('1.50'),
        when: new Date(Date.UTC(2026, 0, 1) + index * 60_000),
        s: `text, with "quotes"\nand newline ${index}`,
        flag: index % 2 === 0,
        nothing: null,
        nested: { address: { city: 'Ljubljana' } },
        arr: [1, 2, 3],
      }));
      docs[42] = { _id: known, ...docs[42] };
      await client.db(DB).collection(source).insertMany(docs);

      const formats = [
        { format: 'json-array' as const, file: 'roundtrip.json' },
        { format: 'ndjson' as const, file: 'roundtrip.ndjson' },
        { format: 'csv' as const, file: 'roundtrip.csv' },
      ];
      const original = await client
        .db(DB)
        .collection<Document>(source)
        .findOne({ _id: known }, { promoteValues: false });
      expect(original).not.toBeNull();

      for (const { format, file } of formats) {
        const path = await filePath(`${source}_${file}`);
        const exported = await exportCollection(client, {
          database: DB,
          collection: source,
          path,
          options: { format, sortEjson: '{"i":1}' },
        });
        expectClean(exported);
        expect(exported.processed).toBe(2000);

        const target = uniqueName(`roundtrip_${format.replace('-', '_')}`);
        const imported = await importFile(client, {
          database: DB,
          collection: target,
          path,
          options: { format, csv: {} },
        });
        expectClean(imported);
        expect(imported.inserted).toBe(2000);
        expect(await countOf(target)).toBe(2000);

        const reread = await client
          .db(DB)
          .collection<Document>(target)
          .findOne({ _id: known }, { promoteValues: false });
        expect(reread).not.toBeNull();
        if (format === 'csv') {
          // CSV has no types, so the values come back with the types the text suggests.
          expect(reread?._id).toBeInstanceOf(ObjectId);
          expect(reread?.i).toBeInstanceOf(Int32);
          expect(reread?.long).toBeInstanceOf(Long);
          expect(reread?.long.toString()).toBe('3000000042');
          expect(reread?.d1).toBeInstanceOf(Double);
          expect(reread?.d1.value).toBe(1);
          // A decimal is written as text and read back as a double.
          expect(reread?.dec).toBeInstanceOf(Double);
          expect(reread?.dec.value).toBe(1.5);
          expect(reread?.when).toBeInstanceOf(Date);
          expect(reread?.when.toISOString()).toBe(original?.when.toISOString());
          expect(reread?.s).toBe(original?.s);
          expect(reread?.flag).toBe(true);
          expect(reread?.nothing).toBeNull();
          expect(reread?.nested.address.city).toBe('Ljubljana');
          // Arrays are written as EJSON text and read back as arrays of int32.
          expect(reread?.arr[0]).toBeInstanceOf(Int32);
          expect(BSON.EJSON.stringify(reread?.arr, { relaxed: false })).toBe(
            BSON.EJSON.stringify(original?.arr, { relaxed: false }),
          );
        } else {
          expect(BSON.EJSON.stringify(reread, { relaxed: false })).toBe(
            BSON.EJSON.stringify(original, { relaxed: false }),
          );
        }
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'exports a filtered, projected, limited, and sorted query result',
    async () => {
      const source = uniqueName('query_source');
      await client
        .db(DB)
        .collection(source)
        .insertMany(
          Array.from({ length: 50 }, (_, index) => ({
            n: index,
            kind: index % 2 === 0 ? 'even' : 'odd',
            extra: 'x',
          })),
        );
      const path = await filePath(`${source}.ndjson`);
      const progress = await exportCollection(client, {
        database: DB,
        collection: source,
        path,
        options: {
          format: 'ndjson',
          filterEjson: '{"kind":"even"}',
          projectionEjson: '{"_id":0,"n":1}',
          sortEjson: '{"n":-1}',
          limit: 3,
        },
      });
      expectClean(progress);
      const lines = (await readFile(path, 'utf8')).trim().split('\n');
      expect(lines.map((line) => JSON.parse(line) as unknown)).toEqual([
        { n: { $numberInt: '48' } },
        { n: { $numberInt: '46' } },
        { n: { $numberInt: '44' } },
      ]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'exports CSV with explicit columns, join mode arrays, and the delimiter option',
    async () => {
      const source = uniqueName('csv_options');
      await client
        .db(DB)
        .collection(source)
        .insertMany([
          { a: 1, b: { c: 'x;y' }, tags: ['p', 'q'] },
          { a: 2, b: { c: 'z' }, tags: [] },
        ]);
      const path = await filePath(`${source}.csv`);
      const progress = await exportCollection(client, {
        database: DB,
        collection: source,
        path,
        options: {
          format: 'csv',
          csv: { delimiter: '|', columns: ['a', 'b.c', 'tags'], flattenArrays: 'join' },
          sortEjson: '{"a":1}',
        },
      });
      expectClean(progress);
      expect(await readFile(path, 'utf8')).toBe('a|b.c|tags\n1|x;y|p;q\n2|z|\n');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'removes the output file when an export is cancelled',
    async () => {
      const source = uniqueName('cancel_export');
      await client
        .db(DB)
        .collection(source)
        .insertMany(Array.from({ length: 3000 }, (_, index) => ({ index })));
      const path = await filePath(`${source}.json`);
      const controller = new AbortController();
      const progress = await exportCollection(
        client,
        { database: DB, collection: source, path, options: { format: 'json-array' } },
        {
          signal: controller.signal,
          onProgress: () => controller.abort(),
        },
      );
      expect(progress.error?.code).toBe('CANCELLED');
      await expect(stat(path)).rejects.toThrow();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'exports 50 MB of NDJSON with the heap under 200 MB',
    async () => {
      const source = uniqueName('big_export');
      const collection = client.db(DB).collection(source);
      const payload = 'x'.repeat(200);
      const DOCUMENTS = 153_000;
      for (let start = 0; start < DOCUMENTS; start += 5000) {
        const batch = Array.from({ length: Math.min(5000, DOCUMENTS - start) }, (_, offset) => ({
          n: start + offset,
          payload,
          tag: `t-${(start + offset) % 97}`,
          at: new Date(Date.UTC(2026, 0, 1) + (start + offset) * 1000),
        }));
        await collection.insertMany(batch);
      }

      const path = await filePath(`${source}.ndjson`);
      // Collect the garbage from the inserts first, so the peak below is the export's own.
      collectGarbage();
      let peakHeap = process.memoryUsage().heapUsed;
      const sampler = setInterval(() => {
        peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
      }, 5);
      let progress: TransferProgress;
      try {
        progress = await exportCollection(
          client,
          { database: DB, collection: source, path, options: { format: 'ndjson' } },
          {
            onProgress: () => {
              peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
            },
          },
        );
      } finally {
        clearInterval(sampler);
      }
      expectClean(progress);
      expect(progress.processed).toBe(DOCUMENTS);
      const size = (await stat(path)).size;
      expect(size).toBeGreaterThan(49 * MB);
      expect(peakHeap).toBeLessThan(MEMORY_BUDGET_BYTES);
    },
    SUITE_TIMEOUT_MS,
  );
});

describe('CSV import on mongo 4.4', () => {
  let started: StartedMongo;
  let oldClient: MongoClient;

  beforeAll(async () => {
    started = await startMongo(OLD_IMAGE);
    oldClient = new MongoClient(started.rootUri);
    await oldClient.connect();
  }, CONTAINER_STARTUP_TIMEOUT_MS);

  afterAll(async () => {
    await oldClient?.close();
    await started?.stop();
  }, CONTAINER_STARTUP_TIMEOUT_MS);

  it(
    'imports the same 10,000-row CSV',
    async () => {
      const collection = uniqueName('csv_44');
      const path = await writeCsv(`${collection}.csv`, CSV_ROWS);
      const progress = await importFile(oldClient, {
        database: DB,
        collection,
        path,
        options: { format: 'csv', batchSize: 500 },
      });
      expectClean(progress);
      expect(progress.inserted).toBe(CSV_ROWS);
      expect(await oldClient.db(DB).collection(collection).countDocuments()).toBe(CSV_ROWS);
      const multiline = await oldClient
        .db(DB)
        .collection<Document>(collection)
        .findOne({ id: 500 }, { promoteValues: false });
      expect(multiline?.big).toBeInstanceOf(Long);
      expect(multiline?.note).toBe('line one\nline "two", ok');
      const nullRow = await oldClient
        .db(DB)
        .collection<Document>(collection)
        .findOne({ id: 3 }, { promoteValues: false });
      expect(nullRow?.optional).toBeNull();
    },
    TEST_TIMEOUT_MS,
  );
});
