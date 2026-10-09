import { fork } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ExplainResult, RpcEvent, RpcResult } from '@mongo-gui/core';
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
const ORDER_COUNT = 2000;
// Orders with status "paid" are every third document, so 667 of them.
const PAID_COUNT = 667;
const PASSWORD = 'integration vault password';
const FAST_KDF = { N: 2 ** 10, r: 8, p: 1 };
const SUITE_TIMEOUT_MS = CONTAINER_STARTUP_TIMEOUT_MS + 120_000;
const CALL_TIMEOUT_MS = 60_000;
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

// A count arrives as canonical EJSON, for example {"$numberInt":"2000"}, or as a plain number.
function numberOf(printable: string): number {
  const parsed: unknown = JSON.parse(printable);
  if (typeof parsed === 'number') {
    return parsed;
  }
  if (typeof parsed === 'object' && parsed !== null) {
    const first = Object.values(parsed)[0];
    return Number(first);
  }
  throw new Error(`expected a number, got ${printable}`);
}

function errorOf(result: RpcResult): string {
  if (result.ok) {
    throw new Error('expected a refusal');
  }
  return result.error.code;
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

describe('explain namespace through the router against MongoDB 8.0', () => {
  let mongo: StartedMongo | undefined;
  let router: Router;
  let services: AppServices | undefined;
  let dir: string | undefined;
  let connectionId = SAMPLE_CONNECTION_ID;
  const events: RpcEvent[] = [];

  const call = async (method: string, input: unknown): Promise<RpcResult> =>
    router.handle(method, input);

  const shell = async (code: string): Promise<RpcResult> =>
    call('shell.evaluate', { connectionId, database: DATABASE, code });

  const explain = async (code: string, verbosity: string): Promise<ExplainResult> =>
    valueOf(
      await call('explain.run', { connectionId, database: DATABASE, code, verbosity }),
    ) as ExplainResult;

  const countWhere = async (filter: string): Promise<number> => {
    const evaluation = valueOf(await shell(`db.orders.countDocuments(${filter})`)) as {
      result?: { printableEjson: string };
      error?: unknown;
    };
    if (evaluation.result === undefined) {
      throw new Error(`count failed: ${JSON.stringify(evaluation.error)}`);
    }
    return numberOf(evaluation.result.printableEjson);
  };

  beforeAll(async () => {
    mongo = await startMongo(IMAGE);
    dir = mkdtempSync(join(tmpdir(), 'explain-integration-'));
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
      await call('connections.create', { name: 'explain', uri: mongo.rootUri }),
    ) as { id: string };
    connectionId = created.id;
    valueOf(await call('connections.connect', { id: connectionId }));
    valueOf(
      await shell(
        `db.orders.insertMany(Array.from({ length: ${ORDER_COUNT} }, (_, n) => ({ _id: n, status: ['paid', 'open', 'cancelled'][n % 3], total: (n * 37) % 1000, customerId: n % 100 })))`,
      ),
    );
    valueOf(await shell('db.orders.createIndex({ status: 1 })'));
  }, SUITE_TIMEOUT_MS);

  afterAll(async () => {
    await services?.dispose();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
    await mongo?.stop();
  }, SUITE_TIMEOUT_MS);

  it(
    'explains a find at queryPlanner with the index and no execution metrics',
    async () => {
      const result = await explain(
        'db.orders.find({ status: "paid" }).sort({ total: 1 })',
        'queryPlanner',
      );
      expect(result.tree.command).toBe('find');
      expect(result.tree.verbosity).toBe('queryPlanner');
      expect(result.tree.namespace).toBe(`${DATABASE}.orders`);
      expect(result.tree.summary.indexesUsed).toContain('status_1');
      expect(result.tree.summary.keysExamined).toBeUndefined();
      expect(result.tree.summary.docsExamined).toBeUndefined();
      expect(result.tree.summary.collectionScan).toBe(false);
      expect(result.tree.winning.name).toBeTruthy();
      expect(result.rawEjson).toContain('"winningPlan"');
      expect(result.requestId).toMatch(/^[0-9a-f-]{36}$/);
    },
    CALL_TIMEOUT_MS,
  );

  it(
    'explains a find at executionStats with metrics, the sort warning and the examined counts',
    async () => {
      const result = await explain(
        'db.orders.find({ status: "paid" }).sort({ total: 1 })',
        'executionStats',
      );
      expect(result.tree.verbosity).toBe('executionStats');
      expect(result.tree.summary.indexesUsed).toContain('status_1');
      expect(result.tree.summary.nReturned).toBe(PAID_COUNT);
      expect(result.tree.summary.keysExamined).toBe(PAID_COUNT);
      expect(result.tree.summary.docsExamined).toBe(PAID_COUNT);
      expect(result.tree.summary.inMemorySort).toBe(true);
      expect(result.tree.summary.executionTimeMs).toBeGreaterThanOrEqual(0);
      expect(result.tree.warnings.map((warning) => warning.code)).toContain('IN_MEMORY_SORT');
      expect(result.tree.engine).not.toBe('unknown');
      expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
    },
    CALL_TIMEOUT_MS,
  );

  it(
    'explains a find at allPlansExecution with the candidate plans',
    async () => {
      const result = await explain('db.orders.find({ status: "paid" })', 'allPlansExecution');
      expect(result.tree.verbosity).toBe('allPlansExecution');
      expect(result.tree.summary.nReturned).toBe(PAID_COUNT);
      expect(result.tree.summary.indexesUsed).toContain('status_1');
    },
    CALL_TIMEOUT_MS,
  );

  it(
    'explains an aggregate pipeline',
    async () => {
      const result = await explain(
        'db.orders.aggregate([{ $match: { status: "paid" } }, { $group: { _id: "$customerId", spent: { $sum: "$total" } } }])',
        'executionStats',
      );
      expect(result.tree.command).toBe('aggregate');
      expect(result.tree.summary.indexesUsed).toContain('status_1');
      expect(result.tree.winning.name).toBeTruthy();
    },
    CALL_TIMEOUT_MS,
  );

  it(
    'explains an updateMany without changing any document',
    async () => {
      const before = await countWhere('{ x: { $exists: true } }');
      const result = await explain(
        'db.orders.updateMany({ status: "paid" }, { $set: { x: 1 } })',
        'executionStats',
      );
      expect(result.tree.command).toBe('update');
      expect(await countWhere('{ x: { $exists: true } }')).toBe(before);
      expect(await countWhere('{ x: 1 }')).toBe(0);
      expect(await countWhere('{}')).toBe(ORDER_COUNT);
    },
    CALL_TIMEOUT_MS,
  );

  it.each([
    'db.orders.deleteMany({ status: "cancelled" })',
    'db.orders.deleteOne({ _id: 1 })',
    'db.orders.replaceOne({ _id: 2 }, { status: "paid" })',
    'db.orders.updateOne({ _id: 3 }, { $set: { x: 2 } })',
    'db.orders.count({ status: "paid" })',
    'db.orders.countDocuments({ status: "paid" })',
    'db.orders.distinct("customerId", { status: "paid" })',
    'db.orders.findOne({ _id: 4 })',
  ])(
    'explains %s and leaves the data unchanged',
    async (code) => {
      const explained = await explain(code, 'queryPlanner');
      expect(explained.tree.namespace).toBe(`${DATABASE}.orders`);
      expect(await countWhere('{}')).toBe(ORDER_COUNT);
      expect(await countWhere('{ x: { $exists: true } }')).toBe(0);
    },
    CALL_TIMEOUT_MS,
  );

  it(
    'explains a captured find command through runCommand and strips session fields',
    async () => {
      const command = JSON.stringify({
        find: 'orders',
        filter: { status: 'paid' },
        sort: { total: 1 },
        $db: DATABASE,
        lsid: { id: { $binary: { base64: 'AAAAAAAAAAAAAAAAAAAAAA==', subType: '04' } } },
      });
      const result = valueOf(
        await call('explain.runCommand', {
          connectionId,
          database: DATABASE,
          commandEjson: command,
          verbosity: 'executionStats',
        }),
      ) as ExplainResult;
      expect(result.tree.command).toBe('find');
      expect(result.tree.summary.inMemorySort).toBe(true);
      expect(result.tree.summary.nReturned).toBe(PAID_COUNT);
      expect(JSON.parse(result.rawEjson)).toEqual(
        expect.objectContaining({ queryPlanner: expect.anything() }),
      );
    },
    CALL_TIMEOUT_MS,
  );

  it(
    'refuses a statement that is not one collection query',
    async () => {
      expect(
        errorOf(
          await call('explain.run', {
            connectionId,
            database: DATABASE,
            code: 'db.orders.find({}).toArray()',
            verbosity: 'queryPlanner',
          }),
        ),
      ).toBe('VALIDATION');
      expect(
        errorOf(
          await call('explain.run', {
            connectionId,
            database: DATABASE,
            code: 'db.orders.find({}); db.orders.find({})',
            verbosity: 'queryPlanner',
          }),
        ),
      ).toBe('VALIDATION');
    },
    CALL_TIMEOUT_MS,
  );

  it(
    'explains a profiled update statement through runCommand without changing data',
    async () => {
      const before = await countWhere('{ x: { $exists: true } }');
      const result = valueOf(
        await call('explain.runCommand', {
          connectionId,
          database: DATABASE,
          commandEjson: JSON.stringify({
            q: { status: 'open' },
            u: { $set: { x: 5 } },
            multi: true,
          }),
          verbosity: 'executionStats',
          profileOp: 'update',
          collection: 'orders',
        }),
      ) as ExplainResult;
      expect(result.tree.command).toBe('update');
      expect(await countWhere('{ x: { $exists: true } }')).toBe(before);
      expect(await countWhere('{ x: 5 }')).toBe(0);
    },
    CALL_TIMEOUT_MS,
  );

  it(
    'explains a profiled remove statement through runCommand without deleting',
    async () => {
      const result = valueOf(
        await call('explain.runCommand', {
          connectionId,
          database: DATABASE,
          commandEjson: JSON.stringify({ q: { status: 'cancelled' }, limit: 0 }),
          verbosity: 'queryPlanner',
          profileOp: 'remove',
          collection: 'orders',
        }),
      ) as ExplainResult;
      expect(result.tree.command).toBe('delete');
      expect(await countWhere('{}')).toBe(ORDER_COUNT);
    },
    CALL_TIMEOUT_MS,
  );

  it('refuses a getMore command through runCommand', async () => {
    expect(
      errorOf(
        await call('explain.runCommand', {
          connectionId,
          database: DATABASE,
          commandEjson: '{"getMore": 1, "collection": "orders"}',
          verbosity: 'queryPlanner',
        }),
      ),
    ).toBe('VALIDATION');
  });

  it('keeps the event list free of explain side effects', () => {
    expect(events.filter((event) => event.type === 'profiler:error')).toHaveLength(0);
  });
});
