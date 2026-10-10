import { fork } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RpcEvent, RpcResult } from '@mongo-gui/core';
import { fromChildProcess, type ForkRequest } from '../shell/child';
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
const DATABASE = 'shop';
const DOCUMENT_COUNT = 60;
const PASSWORD = 'integration vault password';
const FAST_KDF = { N: 2 ** 10, r: 8, p: 1 };
const SUITE_TIMEOUT_MS = CONTAINER_STARTUP_TIMEOUT_MS + 120_000;
const CALL_TIMEOUT_MS = 30_000;
const CANCEL_BUDGET_MS = 1_000;
const WATCHDOG_BUDGET_MS = 6_000;
const BUNDLE_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../out/main/shell-runtime.cjs',
);
const SAMPLE_CONNECTION_ID = '00000000-0000-4000-8000-000000000000';

function valueOf(result: RpcResult): unknown {
  if (!result.ok) {
    throw new Error(`expected ok, got ${JSON.stringify(result.error)}`);
  }
  return result.value;
}

// Forks the built bundle with the supervisor's environment, as the packaged app does through a
// utility process.
function forkBundle(request: ForkRequest) {
  return fromChildProcess(
    fork(request.entryPath, [], {
      env: { ...request.env },
      execArgv: [...request.execArgv],
      silent: true,
    }),
  );
}

// A cursor batch is an EJSON object with the documents and whether more follow.
function documentsOf(printable: string): unknown[] {
  const parsed: unknown = JSON.parse(printable);
  const documents: unknown = Reflect.get(Object(parsed), 'documents');
  if (!Array.isArray(documents)) {
    throw new Error('expected a cursor batch with documents');
  }
  return documents;
}

describe('shell namespace through the router against MongoDB 8.0', () => {
  let mongo: StartedMongo | undefined;
  let router: Router;
  let services: AppServices | undefined;
  let dir: string | undefined;
  let connectionId = SAMPLE_CONNECTION_ID;
  const events: RpcEvent[] = [];

  const call = async (method: string, input: unknown): Promise<RpcResult> =>
    router.handle(method, input);

  beforeAll(async () => {
    mongo = await startMongo(IMAGE);
    dir = mkdtempSync(join(tmpdir(), 'shell-integration-'));
    services = createAppServices({
      userDataDir: dir,
      kdf: FAST_KDF,
      failureDelayMs: 0,
      shell: { entryPath: BUNDLE_PATH, fork: forkBundle },
    });
    router = createRouter({
      ...services,
      onEvent: (event) => {
        events.push(event);
      },
    });
    valueOf(await call('vault.initialise', { password: PASSWORD }));
    const created = valueOf(
      await call('connections.create', { name: 'shell', uri: mongo.rootUri }),
    ) as { id: string };
    connectionId = created.id;
    valueOf(await call('connections.connect', { id: connectionId }));
    valueOf(
      await call('shell.evaluate', {
        connectionId,
        database: DATABASE,
        code: `db.orders.insertMany(Array.from({ length: ${DOCUMENT_COUNT} }, (_, n) => ({ n })))`,
      }),
    );
  }, SUITE_TIMEOUT_MS);

  afterAll(async () => {
    await services?.dispose();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
    await mongo?.stop();
  }, SUITE_TIMEOUT_MS);

  it(
    'pages a find with batchSize 25 and reads the rest with next',
    async () => {
      const first = valueOf(
        await call('shell.evaluate', {
          connectionId,
          database: DATABASE,
          code: 'db.orders.find({}).sort({ n: 1 })',
          batchSize: 25,
        }),
      ) as { requestId: string; result?: { printableEjson: string; hasMore: boolean } };
      expect(documentsOf(first.result?.printableEjson ?? '[]')).toHaveLength(25);
      expect(first.result?.hasMore).toBe(true);

      const second = valueOf(
        await call('shell.next', { connectionId, requestId: first.requestId, batchSize: 25 }),
      ) as { result?: { printableEjson: string; hasMore: boolean } };
      expect(documentsOf(second.result?.printableEjson ?? '[]')).toHaveLength(25);
      expect(second.result?.hasMore).toBe(true);

      const third = valueOf(
        await call('shell.next', { connectionId, requestId: first.requestId, batchSize: 25 }),
      ) as { result?: { printableEjson: string; hasMore: boolean } };
      expect(documentsOf(third.result?.printableEjson ?? '[]')).toHaveLength(10);
      expect(third.result?.hasMore).toBe(false);
    },
    CALL_TIMEOUT_MS,
  );

  it(
    'keeps the open cursor when a completion runs between pages',
    async () => {
      const first = valueOf(
        await call('shell.evaluate', {
          connectionId,
          database: DATABASE,
          code: 'db.orders.find({}).sort({ n: 1 })',
          batchSize: 25,
        }),
      ) as { requestId: string; result?: { hasMore: boolean } };
      expect(first.result?.hasMore).toBe(true);

      // Completing in the same database must not run use(), which would clear the cursor.
      const completed = valueOf(
        await call('shell.complete', {
          connectionId,
          database: DATABASE,
          code: 'db.orders.fi',
          position: 'db.orders.fi'.length,
        }),
      ) as { items: { text: string }[] };
      expect(completed.items.map((item) => item.text)).toContain('db.orders.find');

      const second = valueOf(
        await call('shell.next', { connectionId, requestId: first.requestId, batchSize: 25 }),
      ) as { result?: { printableEjson: string; hasMore: boolean } };
      expect(documentsOf(second.result?.printableEjson ?? '[]')).toHaveLength(25);
      expect(second.result?.hasMore).toBe(true);
    },
    CALL_TIMEOUT_MS,
  );

  it(
    'streams print output as shell:print events tagged with the request id',
    async () => {
      const requestId = '6f1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
      valueOf(
        await call('shell.evaluate', {
          connectionId,
          requestId,
          database: DATABASE,
          code: "print('x')",
        }),
      );
      expect(events).toContainEqual({
        type: 'shell:print',
        connectionId,
        requestId,
        text: 'x',
      });
    },
    CALL_TIMEOUT_MS,
  );

  it(
    'reports a syntax error as a VALIDATION error in the evaluation',
    async () => {
      const outcome = valueOf(
        await call('shell.evaluate', {
          connectionId,
          database: DATABASE,
          code: 'db.orders.find(',
        }),
      ) as { error?: { code: string } };
      expect(outcome.error?.code).toBe('VALIDATION');
    },
    CALL_TIMEOUT_MS,
  );

  it(
    'cancels a running sleep within the cancel budget and runs the next evaluation',
    async () => {
      const requestId = '7a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
      const running = call('shell.evaluate', {
        connectionId,
        requestId,
        database: DATABASE,
        code: 'sleep(5000)',
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      const cancelStarted = performance.now();
      valueOf(await call('shell.cancel', { connectionId, requestId }));
      const cancelMs = performance.now() - cancelStarted;
      expect(cancelMs).toBeLessThan(CANCEL_BUDGET_MS);

      const outcome = valueOf(await running) as { error?: { code: string } };
      expect(outcome.error?.code).toBe('CANCELLED');

      const after = valueOf(
        await call('shell.evaluate', { connectionId, database: DATABASE, code: '1 + 1' }),
      ) as { result?: { printableEjson: string } };
      // Canonical EJSON writes an int32 with its wrapper.
      expect(after.result?.printableEjson).toBe('{"$numberInt":"2"}');
      console.log(`cancel of sleep(5000) returned in ${cancelMs.toFixed(0)} ms`);
    },
    CALL_TIMEOUT_MS,
  );

  it(
    'recovers from a synchronous loop through the watchdog and evaluates again',
    async () => {
      const started = performance.now();
      const stuck = valueOf(
        await call('shell.evaluate', {
          connectionId,
          database: DATABASE,
          code: 'while (true) {}',
          timeoutMs: 1000,
        }),
      ) as { error?: { code: string; message: string } };
      const elapsedMs = performance.now() - started;
      expect(stuck.error?.code).toBe('CANCELLED');
      expect(elapsedMs).toBeLessThan(WATCHDOG_BUDGET_MS);

      const after = valueOf(
        await call('shell.evaluate', { connectionId, database: DATABASE, code: 'db.getName()' }),
      ) as { result?: { printableEjson: string } };
      expect(after.result?.printableEjson).toBe(JSON.stringify(DATABASE));
      console.log(
        `watchdog recovered a while(true) loop in ${elapsedMs.toFixed(0)} ms: ${stuck.error?.message ?? ''}`,
      );
    },
    CALL_TIMEOUT_MS,
  );

  it(
    'refuses shell calls for a connection that is not open',
    async () => {
      const refused = await call('shell.evaluate', {
        connectionId: SAMPLE_CONNECTION_ID,
        database: DATABASE,
        code: '1',
      });
      expect(refused.ok).toBe(false);
    },
    CALL_TIMEOUT_MS,
  );

  it(
    'analyses the schema with the sample from the shell and the total from the server',
    async () => {
      const report = valueOf(
        await call('schema.analyse', {
          connectionId,
          database: DATABASE,
          collection: 'orders',
          size: 25,
          strategy: 'first',
        }),
      ) as {
        database: string;
        collection: string;
        sampled: number;
        total: number;
        fields: { path: string; types: string[]; presence: number; numeric?: unknown }[];
      };
      expect(report).toMatchObject({
        database: DATABASE,
        collection: 'orders',
        sampled: 25,
        total: DOCUMENT_COUNT,
      });
      // The first strategy reads the earliest _id values, which were inserted with n from 0 up.
      expect(report.fields).toContainEqual(
        expect.objectContaining({ path: 'n', types: ['Int32'], presence: 1 }),
      );
      expect(report.fields.find((field) => field.path === 'n')?.numeric).toEqual({
        min: 0,
        max: 24,
      });
    },
    CALL_TIMEOUT_MS,
  );
});
