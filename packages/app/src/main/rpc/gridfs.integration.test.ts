import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  GridFsBucket,
  GridFsFile,
  RpcEvent,
  RpcResult,
  TransferProgress,
} from '@mongo-gui/core';
import { createAppServices, createRouter, type AppServices, type Router } from './router';
// The Testcontainers harness lives with the adapter tests. It is not exported from the adapter
// package, so this test reads it from the workspace source.
import {
  CONTAINER_STARTUP_TIMEOUT_MS,
  startMongo,
  type StartedMongo,
} from '../../../../mongo-adapter/src/test/mongo-container';

// The floating mongo:8.0 tag refuses to start on Linux kernels 6.19 and newer (SERVER-121912).
const IMAGE = 'mongo:8.0.17';
const SUITE_TIMEOUT_MS = CONTAINER_STARTUP_TIMEOUT_MS + 60_000;
const TEST_TIMEOUT_MS = 120_000;
const POLL_TIMEOUT_MS = 60_000;
const PASSWORD = 'gridfs integration vault';
const FAST_KDF = { N: 2 ** 10, r: 8, p: 1 };
const DATABASE = 'gridfs_router_it';
const BUCKET = 'invoices';
const FILE_BYTES = 5 * 1024 * 1024;

function valueOf(result: RpcResult): unknown {
  if (!result.ok) {
    throw new Error(`expected ok, got ${result.error.code}`);
  }
  return result.value;
}

function errorCodeOf(result: RpcResult): string {
  if (result.ok) {
    throw new Error('expected a failure');
  }
  return result.error.code;
}

async function waitForDone(router: Router, transferId: string): Promise<TransferProgress> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  for (;;) {
    const progress = valueOf(
      await router.handle('transfer.status', { transferId }),
    ) as TransferProgress;
    if (progress.done) {
      return progress;
    }
    if (Date.now() > deadline) {
      throw new Error('the transfer did not finish in time');
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function sha256Of(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

describe('GridFS through the router against a real MongoDB 8.0.17 server', () => {
  let mongo: StartedMongo | undefined;
  let router: Router;
  let services: AppServices | undefined;
  let dir = '';
  let connectionId = '';
  const events: RpcEvent[] = [];

  beforeAll(async () => {
    mongo = await startMongo(IMAGE);
    dir = mkdtempSync(join(tmpdir(), 'gridfs-integration-'));
    services = createAppServices({
      userDataDir: join(dir, 'userdata'),
      kdf: FAST_KDF,
      failureDelayMs: 0,
      dockerSocketPath: join(dir, 'no-docker.sock'),
    });
    router = createRouter({
      ...services,
      onEvent: (event) => {
        events.push(event);
      },
      dialogs: {
        showOpenDialog: async () => ({}),
        showSaveDialog: async () => ({}),
        showItemInFolder: () => undefined,
      },
    });
    valueOf(await router.handle('vault.initialise', { password: PASSWORD }));
    const created = valueOf(
      await router.handle('connections.create', { name: 'gridfs', uri: mongo.rootUri }),
    ) as { id: string };
    connectionId = created.id;
    valueOf(await router.handle('connections.connect', { id: connectionId }));
  }, SUITE_TIMEOUT_MS);

  afterAll(async () => {
    await services?.dispose();
    if (dir !== '') {
      rmSync(dir, { recursive: true, force: true });
    }
    await mongo?.stop();
  }, SUITE_TIMEOUT_MS);

  it(
    'uploads, lists, downloads with equal bytes, refuses an existing target, renames, edits metadata, deletes and drops',
    async () => {
      const source = join(dir, 'invoice.bin');
      const target = join(dir, 'downloaded.bin');
      writeFileSync(source, randomBytes(FILE_BYTES));
      const sourceHash = sha256Of(source);

      // Upload streams the file into the bucket and reports its progress as a transfer.
      const uploaded = valueOf(
        await router.handle('gridfs.startUpload', {
          connectionId,
          database: DATABASE,
          bucket: BUCKET,
          path: source,
        }),
      ) as { transferId: string };
      const uploadProgress = await waitForDone(router, uploaded.transferId);
      expect(uploadProgress.error).toBeUndefined();
      expect(uploadProgress.bytesRead).toBe(FILE_BYTES);

      const buckets = valueOf(
        await router.handle('gridfs.listBuckets', { connectionId, database: DATABASE }),
      ) as GridFsBucket[];
      expect(buckets).toEqual([
        expect.objectContaining({ name: BUCKET, fileCount: 1, totalBytes: FILE_BYTES }),
      ]);

      const files = valueOf(
        await router.handle('gridfs.listFiles', {
          connectionId,
          database: DATABASE,
          bucket: BUCKET,
          limit: 10,
        }),
      ) as GridFsFile[];
      expect(files).toHaveLength(1);
      const file = files[0];
      expect(file?.filename).toBe('invoice.bin');
      expect(file?.length).toBe(FILE_BYTES);
      const ref = { connectionId, database: DATABASE, bucket: BUCKET, idEjson: file?.idEjson };

      // Download writes a new file. The bytes must match the upload.
      const downloaded = valueOf(
        await router.handle('gridfs.startDownload', { ...ref, path: target }),
      ) as { transferId: string };
      expect((await waitForDone(router, downloaded.transferId)).error).toBeUndefined();
      expect(sha256Of(target)).toBe(sourceHash);

      // A download without overwrite refuses the file that now exists, before any transfer starts.
      expect(
        errorCodeOf(await router.handle('gridfs.startDownload', { ...ref, path: target })),
      ).toBe('ALREADY_EXISTS');

      const renamed = valueOf(
        await router.handle('gridfs.renameFile', { ...ref, filename: 'invoice-renamed.bin' }),
      ) as GridFsFile;
      expect(renamed.filename).toBe('invoice-renamed.bin');

      const edited = valueOf(
        await router.handle('gridfs.setMetadata', {
          ...ref,
          metadataEjson: '{"customer":"Ana Kern","paid":true}',
        }),
      ) as GridFsFile;
      expect(edited.metadataEjson).toContain('Ana Kern');

      const deleted = valueOf(
        await router.handle('gridfs.deleteFiles', { ...ref, idsEjson: [file?.idEjson ?? ''] }),
      ) as { deleted: number };
      expect(deleted.deleted).toBe(1);

      const remaining = valueOf(
        await router.handle('gridfs.listFiles', {
          connectionId,
          database: DATABASE,
          bucket: BUCKET,
          limit: 10,
        }),
      ) as GridFsFile[];
      expect(remaining).toEqual([]);

      valueOf(
        await router.handle('gridfs.dropBucket', {
          connectionId,
          database: DATABASE,
          bucket: BUCKET,
        }),
      );
      const afterDrop = valueOf(
        await router.handle('gridfs.listBuckets', { connectionId, database: DATABASE }),
      ) as GridFsBucket[];
      expect(afterDrop).toEqual([]);
      expect(existsSync(target)).toBe(true);
      expect(events.some((event) => event.type === 'transfer:progress')).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );
});
