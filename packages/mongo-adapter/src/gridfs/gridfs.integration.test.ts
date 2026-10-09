import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { MongoClient } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AppErrorException,
  type AppError,
  type GridFsFile,
  type TransferProgress,
} from '@mongo-gui/core';
import {
  CONTAINER_STARTUP_TIMEOUT_MS,
  startMongo,
  type StartedMongo,
} from '../test/mongo-container';
import { dropBucket, listBuckets } from './buckets';
import { deleteFiles, downloadFile, getFile, listFiles, renameFile, uploadFile } from './files';

const DB = 'gridfs_it';
const IMAGES = ['mongo:8.0.17', 'mongo:4.4'] as const;
const SUITE_TIMEOUT_MS = 300_000;
const TEST_TIMEOUT_MS = 120_000;
const MB = 1024 * 1024;
const CHUNK_SIZE = 255 * 1024;
const MEMORY_BUDGET_BYTES = 150 * MB;

let workDir = '';

function uniqueName(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 8)}`;
}

// Runs a full garbage collection. The flag is set at runtime, so no node option is needed.
function collectGarbage(): void {
  setFlagsFromString('--expose_gc');
  const gc = runInNewContext('gc') as () => void;
  gc();
}

async function makeFile(name: string, size: number): Promise<string> {
  const path = join(workDir, name);
  await writeFile(path, randomBytes(size));
  return path;
}

async function sha256Of(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}

// Resolves to the AppError that a rejected call throws. Fails the test when the call succeeds.
async function failureOf(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AppErrorException) {
      return error.error;
    }
    throw error;
  }
  throw new Error('The call was expected to fail');
}

async function countIn(client: MongoClient, name: string): Promise<number> {
  return client.db(DB).collection(name).countDocuments({});
}

function chunkCountFor(length: number, chunkSize: number): number {
  return Math.ceil(length / chunkSize);
}

for (const image of IMAGES) {
  describe(`GridFS on ${image}`, () => {
    let started: StartedMongo;
    let client: MongoClient;

    beforeAll(async () => {
      workDir = await mkdtemp(join(tmpdir(), 'gridfs-it-'));
      started = await startMongo(image);
      client = new MongoClient(started.rootUri);
      await client.connect();
    }, CONTAINER_STARTUP_TIMEOUT_MS);

    afterAll(async () => {
      await client?.close();
      await started?.stop();
      await rm(workDir, { recursive: true, force: true });
    });

    it(
      'uploads 5 MB in 255 KB chunks with metadata and lists it',
      async () => {
        const bucket = uniqueName('upload');
        const source = await makeFile('five.bin', 5 * MB);
        const file = await uploadFile(client, {
          database: DB,
          bucket,
          path: source,
          metadataEjson: '{"owner":"erik","revision":{"$numberInt":"2"}}',
          contentType: 'application/octet-stream',
          chunkSizeBytes: CHUNK_SIZE,
        });

        expect(file.filename).toBe('five.bin');
        expect(file.length).toBe(5 * MB);
        expect(file.chunkSize).toBe(CHUNK_SIZE);
        expect(file.contentType).toBe('application/octet-stream');
        expect(JSON.parse(file.metadataEjson ?? '{}')).toMatchObject({ owner: 'erik' });

        const listed = await listFiles(client, { database: DB, bucket });
        expect(listed).toHaveLength(1);
        expect(listed[0]).toEqual(file);
        expect(await countIn(client, `${bucket}.chunks`)).toBe(chunkCountFor(5 * MB, CHUNK_SIZE));
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'downloads a file whose bytes match the source',
      async () => {
        const bucket = uniqueName('roundtrip');
        const source = await makeFile(`${bucket}-source.bin`, 5 * MB + 17);
        const file = await uploadFile(client, {
          database: DB,
          bucket,
          path: source,
          chunkSizeBytes: CHUNK_SIZE,
        });
        const target = join(workDir, `${bucket}-copy.bin`);
        await downloadFile(client, { database: DB, bucket, idEjson: file.idEjson, path: target });

        expect(await sha256Of(target)).toBe(await sha256Of(source));
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'refuses an existing target unless overwrite is set and keeps the target intact',
      async () => {
        const bucket = uniqueName('overwrite');
        const source = await makeFile(`${bucket}-source.bin`, 300 * 1024);
        const file = await uploadFile(client, { database: DB, bucket, path: source });
        const target = join(workDir, `${bucket}-target.txt`);
        await writeFile(target, 'keep me');

        const refusal = await failureOf(
          downloadFile(client, { database: DB, bucket, idEjson: file.idEjson, path: target }),
        );
        expect(refusal.code).toBe('VALIDATION');
        expect(await readFile(target, 'utf8')).toBe('keep me');
        expect((await readdir(workDir)).filter((name) => name.endsWith('.part'))).toEqual([]);

        await downloadFile(client, {
          database: DB,
          bucket,
          idEjson: file.idEjson,
          path: target,
          overwrite: true,
        });
        expect(await sha256Of(target)).toBe(await sha256Of(source));
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'cancels an upload after the first progress event and leaves no file or chunks',
      async () => {
        const bucket = uniqueName('cancel_up');
        const source = await makeFile(`${bucket}.bin`, 50 * MB);
        const controller = new AbortController();
        const events: TransferProgress[] = [];
        const failure = await failureOf(
          uploadFile(
            client,
            { database: DB, bucket, path: source, chunkSizeBytes: CHUNK_SIZE },
            {
              signal: controller.signal,
              onProgress: (progress) => {
                events.push(progress);
                controller.abort();
              },
            },
          ),
        );

        expect(failure.code).toBe('CANCELLED');
        expect(events.length).toBeGreaterThan(0);
        expect(await listFiles(client, { database: DB, bucket })).toEqual([]);
        expect(await countIn(client, `${bucket}.files`)).toBe(0);
        expect(await countIn(client, `${bucket}.chunks`)).toBe(0);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'cancels a download and leaves neither the temporary file nor the target',
      async () => {
        const bucket = uniqueName('cancel_down');
        const source = await makeFile(`${bucket}.bin`, 5 * MB);
        const file = await uploadFile(client, {
          database: DB,
          bucket,
          path: source,
          chunkSizeBytes: CHUNK_SIZE,
        });
        const target = join(workDir, `${bucket}-out.bin`);
        const controller = new AbortController();
        const failure = await failureOf(
          downloadFile(
            client,
            { database: DB, bucket, idEjson: file.idEjson, path: target },
            {
              signal: controller.signal,
              onProgress: () => controller.abort(),
            },
          ),
        );

        expect(failure.code).toBe('CANCELLED');
        await expect(stat(target)).rejects.toThrow();
        const leftovers = (await readdir(workDir)).filter((name) => name.startsWith(bucket));
        expect(leftovers.filter((name) => name.endsWith('.part'))).toEqual([]);
        expect(leftovers).toEqual([`${bucket}.bin`]);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'renames a file and reports the new name',
      async () => {
        const bucket = uniqueName('rename');
        const source = await makeFile(`${bucket}.bin`, 1024);
        const file = await uploadFile(client, { database: DB, bucket, path: source });
        const renamed = await renameFile(client, {
          database: DB,
          bucket,
          idEjson: file.idEjson,
          filename: 'renamed.bin',
        });

        expect(renamed.filename).toBe('renamed.bin');
        expect((await getFile(client, DB, bucket, file.idEjson)).filename).toBe('renamed.bin');
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'deletes files and their chunks, and refuses the whole request when an id is missing',
      async () => {
        const bucket = uniqueName('delete');
        const first = await uploadFile(client, {
          database: DB,
          bucket,
          path: await makeFile(`${bucket}-a.bin`, 600 * 1024),
          chunkSizeBytes: CHUNK_SIZE,
        });
        const second = await uploadFile(client, {
          database: DB,
          bucket,
          path: await makeFile(`${bucket}-b.bin`, 1024),
          chunkSizeBytes: CHUNK_SIZE,
        });
        const missing = (
          await uploadFile(client, {
            database: DB,
            bucket,
            path: await makeFile(`${bucket}-c.bin`, 10),
          })
        ).idEjson;
        await deleteFiles(client, { database: DB, bucket, idsEjson: [missing] });

        const refusal = await failureOf(
          deleteFiles(client, {
            database: DB,
            bucket,
            idsEjson: [first.idEjson, missing],
          }),
        );
        expect(refusal.code).toBe('VALIDATION');
        expect(await listFiles(client, { database: DB, bucket })).toHaveLength(2);

        const removed = await deleteFiles(client, {
          database: DB,
          bucket,
          idsEjson: [first.idEjson, second.idEjson],
        });
        expect(removed).toBe(2);
        expect(await listFiles(client, { database: DB, bucket })).toEqual([]);
        expect(await countIn(client, `${bucket}.chunks`)).toBe(0);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'lists buckets with file counts and totals',
      async () => {
        const photos = uniqueName('photos');
        const docs = uniqueName('docs');
        await uploadFile(client, {
          database: DB,
          bucket: photos,
          path: await makeFile(`${photos}-1.bin`, 100 * 1024),
        });
        await uploadFile(client, {
          database: DB,
          bucket: photos,
          path: await makeFile(`${photos}-2.bin`, 200 * 1024),
        });
        await uploadFile(client, {
          database: DB,
          bucket: docs,
          path: await makeFile(`${docs}-1.bin`, 1024),
        });

        const buckets = await listBuckets(client, DB);
        const byName = new Map(buckets.map((bucket) => [bucket.name, bucket]));
        expect(byName.get(photos)).toEqual({
          name: photos,
          filesCollection: `${photos}.files`,
          chunksCollection: `${photos}.chunks`,
          fileCount: 2,
          totalBytes: 300 * 1024,
        });
        expect(byName.get(docs)).toMatchObject({ fileCount: 1, totalBytes: 1024 });
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'drops a bucket and its two collections',
      async () => {
        const bucket = uniqueName('dropme');
        await uploadFile(client, {
          database: DB,
          bucket,
          path: await makeFile(`${bucket}.bin`, 1024),
        });
        await dropBucket(client, DB, bucket);

        expect((await listBuckets(client, DB)).map((item) => item.name)).not.toContain(bucket);
        expect(await countIn(client, `${bucket}.files`)).toBe(0);
        await dropBucket(client, DB, bucket);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'refuses to drop a bucket in the admin database',
      async () => {
        const failure = await failureOf(dropBucket(client, 'admin', 'fs'));
        expect(failure.code).toBe('VALIDATION');
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'uploads 50 MB with the heap under 150 MB',
      async () => {
        const bucket = uniqueName('big_upload');
        const source = await makeFile(`${bucket}.bin`, 50 * MB);
        collectGarbage();
        let peakHeap = process.memoryUsage().heapUsed;
        const sampler = setInterval(() => {
          peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
        }, 5);
        let file: GridFsFile;
        try {
          file = await uploadFile(
            client,
            { database: DB, bucket, path: source, chunkSizeBytes: CHUNK_SIZE },
            {
              onProgress: () => {
                peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
              },
            },
          );
        } finally {
          clearInterval(sampler);
        }
        expect(file.length).toBe(50 * MB);
        expect(peakHeap).toBeLessThan(MEMORY_BUDGET_BYTES);
      },
      SUITE_TIMEOUT_MS,
    );
  });
}
