import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MongoClient, type Document } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { RpcEvent, RpcResult, TransferProgress } from '@mongo-gui/core';
import { createAppServices, createRouter, type AppServices, type Router } from './router';
// The Testcontainers harness lives with the adapter tests. It is not exported from the
// adapter package, so this test reads it from the workspace source.
import {
  CONTAINER_STARTUP_TIMEOUT_MS,
  startMongo,
  type StartedMongo,
} from '../../../../mongo-adapter/src/test/mongo-container';

// The floating mongo:8.0 tag refuses to start on Linux kernels 6.19 and newer (SERVER-121912).
const IMAGE = 'mongo:8.0.17';
const SUITE_TIMEOUT_MS = CONTAINER_STARTUP_TIMEOUT_MS + 60_000;
const POLL_TIMEOUT_MS = 60_000;
const PASSWORD = 'integration vault password';
const FAST_KDF = { N: 2 ** 10, r: 8, p: 1 };
const DATABASE = 'transfer_it';
const SOURCE = 'orders';
const COPY = 'orders_copy';
const DOCUMENT_COUNT = 100;
const CANCEL_LINES = 40_000;

function valueOf(result: RpcResult): unknown {
  if (!result.ok) {
    throw new Error(`expected ok, got ${JSON.stringify(result.error)}`);
  }
  return result.value;
}

function errorOf(result: RpcResult): string {
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

describe('transfers through the router against a real MongoDB 8.0 server', () => {
  let mongo: StartedMongo | undefined;
  let router: Router;
  let services: AppServices | undefined;
  let dir: string | undefined;
  let connectionId = '';
  const events: RpcEvent[] = [];
  const showItemInFolder = vi.fn<(path: string) => void>();

  beforeAll(async () => {
    mongo = await startMongo(IMAGE);
    dir = mkdtempSync(join(tmpdir(), 'transfer-integration-'));
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
        showItemInFolder,
      },
    });
    valueOf(await router.handle('vault.initialise', { password: PASSWORD }));
    const created = valueOf(
      await router.handle('connections.create', { name: 'transfers', uri: mongo.rootUri }),
    ) as { id: string };
    connectionId = created.id;
    valueOf(await router.handle('connections.connect', { id: connectionId }));

    const seeder = new MongoClient(mongo.rootUri);
    try {
      const docs = Array.from({ length: DOCUMENT_COUNT }, (_, index): Document => ({
        _id: index,
        sku: `sku-${index}`,
        total: index * 2.5,
        placedAt: new Date(Date.UTC(2026, 0, 1 + (index % 28))),
      }));
      await seeder.db(DATABASE).collection(SOURCE).insertMany(docs);
    } finally {
      await seeder.close();
    }
  }, SUITE_TIMEOUT_MS);

  afterAll(async () => {
    await services?.dispose();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
    await mongo?.stop();
  }, SUITE_TIMEOUT_MS);

  async function countDocuments(collection: string): Promise<number> {
    if (mongo === undefined) {
      throw new Error('container not started');
    }
    const client = new MongoClient(mongo.rootUri);
    try {
      return await client.db(DATABASE).collection(collection).countDocuments();
    } finally {
      await client.close();
    }
  }

  it(
    'exports 100 documents, imports them into another collection, and the counts match',
    async () => {
      const exportPath = join(dir ?? '', 'orders.ndjson');
      const exported = valueOf(
        await router.handle('transfer.startExport', {
          connectionId,
          database: DATABASE,
          collection: SOURCE,
          path: exportPath,
          options: { format: 'ndjson', ejsonMode: 'canonical' },
        }),
      ) as { transferId: string };
      const exportDone = await waitForDone(router, exported.transferId);
      expect(exportDone.error).toBeUndefined();
      expect(exportDone.processed).toBe(DOCUMENT_COUNT);
      expect(readFileSync(exportPath, 'utf8').trim().split('\n')).toHaveLength(DOCUMENT_COUNT);

      const preview = valueOf(
        await router.handle('transfer.previewImport', {
          connectionId,
          path: exportPath,
          sampleRows: 5,
        }),
      ) as { detectedFormat: string; fields: { name: string }[]; sampleRows: unknown[] };
      expect(preview.detectedFormat).toBe('ndjson');
      expect(preview.fields.map((field) => field.name)).toEqual(
        expect.arrayContaining(['_id', 'sku', 'total', 'placedAt']),
      );
      expect(preview.sampleRows).toHaveLength(5);

      const imported = valueOf(
        await router.handle('transfer.startImport', {
          connectionId,
          database: DATABASE,
          collection: COPY,
          path: exportPath,
          options: { format: 'ndjson', mode: 'insert', batchSize: 10, stopOnError: false },
        }),
      ) as { transferId: string };
      const importDone = await waitForDone(router, imported.transferId);
      expect(importDone.error).toBeUndefined();
      expect(importDone.inserted).toBe(DOCUMENT_COUNT);
      expect(importDone.failed).toBe(0);
      expect(await countDocuments(COPY)).toBe(await countDocuments(SOURCE));

      const importEvents = events.filter(
        (event) => event.type === 'transfer:progress' && event.transferId === imported.transferId,
      );
      expect(importEvents.length).toBeGreaterThanOrEqual(2);
      const exportEvents = events.filter(
        (event) => event.type === 'transfer:progress' && event.transferId === exported.transferId,
      );
      expect(exportEvents.at(-1)).toEqual(
        expect.objectContaining({
          kind: 'export',
          progress: expect.objectContaining({ done: true }),
        }),
      );
    },
    SUITE_TIMEOUT_MS,
  );

  it(
    'cancels a running import and keeps the counts consistent',
    async () => {
      const path = join(dir ?? '', 'long.ndjson');
      const lines = Array.from({ length: CANCEL_LINES }, (_, index) =>
        JSON.stringify({ sku: `bulk-${index}`, qty: index }),
      );
      writeFileSync(path, `${lines.join('\n')}\n`);

      const started = valueOf(
        await router.handle('transfer.startImport', {
          connectionId,
          database: DATABASE,
          collection: 'bulk',
          path,
          options: { format: 'ndjson', mode: 'insert', batchSize: 5, stopOnError: false },
        }),
      ) as { transferId: string };

      const deadline = Date.now() + POLL_TIMEOUT_MS;
      for (;;) {
        const progress = valueOf(
          await router.handle('transfer.status', { transferId: started.transferId }),
        ) as TransferProgress;
        if (progress.processed > 0 || progress.done || Date.now() > deadline) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      valueOf(await router.handle('transfer.cancel', { transferId: started.transferId }));
      const cancelled = await waitForDone(router, started.transferId);

      expect(cancelled.error?.code).toBe('CANCELLED');
      expect(cancelled.processed).toBeLessThan(CANCEL_LINES);
      expect(await countDocuments('bulk')).toBe(cancelled.inserted);
    },
    SUITE_TIMEOUT_MS,
  );

  it('refuses an export into a folder that does not exist', async () => {
    const missing = join(dir ?? '', 'no-such-folder', 'orders.ndjson');
    expect(
      errorOf(
        await router.handle('transfer.startExport', {
          connectionId,
          database: DATABASE,
          collection: SOURCE,
          path: missing,
          options: { format: 'ndjson', ejsonMode: 'canonical' },
        }),
      ),
    ).toBe('VALIDATION');
  });

  it('reveals a file this session exported and refuses any other path', async () => {
    const exportPath = join(dir ?? '', 'orders.ndjson');
    expect(
      valueOf(await router.handle('app.showItemInFolder', { path: exportPath })),
    ).toBeUndefined();
    expect(showItemInFolder).toHaveBeenCalledWith(exportPath);

    const other = join(dir ?? '', 'not-exported.txt');
    expect(errorOf(await router.handle('app.showItemInFolder', { path: other }))).toBe(
      'VALIDATION',
    );
  });
});
