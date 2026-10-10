import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Decimal128, Long, MongoClient, type Document } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ImportPreview, RpcEvent, RpcResult, TransferProgress } from '@mongo-gui/core';
import {
  DEFAULT_IMPORT_DRAFT,
  importOptionsFor,
  mappingRowsFrom,
} from '../../../../ui/src/components/transfers/import-model';
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
  // The path the save dialog returns next. Undefined means the user cancelled.
  let savePick: string | undefined;
  // The file the mocked open dialog returns. An import reads only a file the dialog returned.
  let openPick: string | undefined;

  /** Picks a file in the open dialog, the step the renderer takes before a preview or an import. */
  async function pickImportFile(path: string): Promise<void> {
    openPick = path;
    await router.handle('app.showOpenDialog', { title: 'Choose a file', filters: [] });
  }

  /** Picks the file in the open dialog and starts the import, the order the renderer uses. */
  async function startImportOf(input: { path: string } & Record<string, unknown>) {
    await pickImportFile(input.path);
    return router.handle('transfer.startImport', input);
  }

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
        showOpenDialog: async () => (openPick === undefined ? {} : { path: openPick }),
        showSaveDialog: async () => (savePick === undefined ? {} : { path: savePick }),
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

      await pickImportFile(exportPath);
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
        await startImportOf({
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
        await startImportOf({
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

  it(
    'round trips typed values: export, preview, the wizard options, import',
    async () => {
      if (mongo === undefined) {
        throw new Error('container not started');
      }
      const seeder = new MongoClient(mongo.rootUri);
      try {
        const typedDocs: Document[] = [
          {
            _id: 1,
            big: Long.fromString('9007199254740993'),
            price: Decimal128.fromString('19.99'),
            placed: new Date('2026-03-01T09:15:00.000Z'),
            count: 7,
          },
          {
            _id: 2,
            big: Long.fromString('-42'),
            price: Decimal128.fromString('0.5'),
            placed: new Date('2026-03-02T09:15:00.000Z'),
            count: 8,
          },
        ];
        await seeder.db(DATABASE).collection('typed').insertMany(typedDocs);
      } finally {
        await seeder.close();
      }
      const path = join(dir ?? '', 'typed.ndjson');
      const exported = valueOf(
        await router.handle('transfer.startExport', {
          connectionId,
          database: DATABASE,
          collection: 'typed',
          path,
          options: { format: 'ndjson', ejsonMode: 'canonical' },
        }),
      ) as { transferId: string };
      expect((await waitForDone(router, exported.transferId)).error).toBeUndefined();

      await pickImportFile(path);
      const preview = valueOf(
        await router.handle('transfer.previewImport', { connectionId, path, sampleRows: 5 }),
      ) as ImportPreview;
      const big = preview.fields.find((field) => field.name === 'big');
      expect(big?.inferredType).toBe('long');
      expect(big?.examples).toContain('9007199254740993');

      const draft = { ...DEFAULT_IMPORT_DRAFT, path, mode: 'insert' as const, batchSize: 10 };
      const options = importOptionsFor(draft, 'ndjson', mappingRowsFrom(preview));
      expect(options.mappings?.every((mapping) => mapping.type === 'auto')).toBe(true);
      const imported = valueOf(
        await startImportOf({
          connectionId,
          database: DATABASE,
          collection: 'typed_copy',
          path,
          options,
        }),
      ) as { transferId: string };
      const done = await waitForDone(router, imported.transferId);
      expect(done.error).toBeUndefined();
      expect(done.inserted).toBe(2);
      expect(done.failed).toBe(0);

      const copy = new MongoClient(mongo.rootUri);
      try {
        const stored = await copy
          .db(DATABASE)
          .collection('typed_copy')
          .find({}, { sort: { _id: 1 } })
          .toArray();
        expect(stored).toHaveLength(2);
        const first = stored[0];
        expect(first?.big).toBeInstanceOf(Long);
        expect((first?.big as Long).equals(Long.fromString('9007199254740993'))).toBe(true);
        expect(first?.price).toBeInstanceOf(Decimal128);
        expect(first?.placed).toBeInstanceOf(Date);
      } finally {
        await copy.close();
      }
    },
    SUITE_TIMEOUT_MS,
  );

  it(
    'refuses an existing file the user did not pick, and replaces a picked one only on success',
    async () => {
      const target = join(dir ?? '', 'picked.ndjson');
      writeFileSync(target, 'keep me\n');

      expect(
        errorOf(
          await router.handle('transfer.startExport', {
            connectionId,
            database: DATABASE,
            collection: SOURCE,
            path: target,
            options: { format: 'ndjson', ejsonMode: 'canonical' },
          }),
        ),
      ).toBe('VALIDATION');
      expect(readFileSync(target, 'utf8')).toBe('keep me\n');

      savePick = target;
      const picked = valueOf(
        await router.handle('app.showSaveDialog', {
          title: 'Save export as',
          filters: [{ name: 'NDJSON', extensions: ['ndjson'] }],
        }),
      ) as { path?: string };
      savePick = undefined;
      expect(picked.path).toBe(target);

      // A filter the server rejects makes the export fail after the temporary file is open.
      const failing = valueOf(
        await router.handle('transfer.startExport', {
          connectionId,
          database: DATABASE,
          collection: SOURCE,
          path: target,
          options: {
            format: 'ndjson',
            ejsonMode: 'canonical',
            filterEjson: '{"$bogusOperator": 1}',
          },
        }),
      ) as { transferId: string };
      const failed = await waitForDone(router, failing.transferId);
      expect(failed.error).toBeDefined();
      expect(readFileSync(target, 'utf8')).toBe('keep me\n');
      expect(readdirSync(dir ?? '').filter((name) => name.endsWith('.tmp'))).toEqual([]);
      expect(errorOf(await router.handle('app.showItemInFolder', { path: target }))).toBe(
        'VALIDATION',
      );

      const replaced = valueOf(
        await router.handle('transfer.startExport', {
          connectionId,
          database: DATABASE,
          collection: SOURCE,
          path: target,
          options: { format: 'ndjson', ejsonMode: 'canonical' },
        }),
      ) as { transferId: string };
      expect((await waitForDone(router, replaced.transferId)).error).toBeUndefined();
      expect(readFileSync(target, 'utf8').trim().split('\n')).toHaveLength(DOCUMENT_COUNT);
      expect(readdirSync(dir ?? '').filter((name) => name.endsWith('.tmp'))).toEqual([]);
    },
    SUITE_TIMEOUT_MS,
  );

  it(
    'a renderer reset cancels the transfers the page started',
    async () => {
      const started = valueOf(
        await startImportOf({
          connectionId,
          database: DATABASE,
          collection: 'bulk_reset',
          path: join(dir ?? '', 'long.ndjson'),
          options: { format: 'ndjson', mode: 'insert', batchSize: 5, stopOnError: false },
        }),
      ) as { transferId: string };

      // A reload or a closed window calls resetRenderer, which must end the page's transfers.
      router.resetRenderer();
      const ended = await waitForDone(router, started.transferId);
      expect(ended.error?.code).toBe('CANCELLED');
      expect(ended.inserted).toBeLessThan(CANCEL_LINES);
    },
    SUITE_TIMEOUT_MS,
  );
});
