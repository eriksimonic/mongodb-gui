import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MongoClient } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ProfileEntry, RpcEvent, RpcResult } from '@mongo-gui/core';
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
const CALL_TIMEOUT_MS = 60_000;
const PASSWORD = 'integration vault password';
const FAST_KDF = { N: 2 ** 10, r: 8, p: 1 };
const SCRATCH_DB = 'mongogui_profiler_it';
const SLOW_FIND = { $where: 'sleep(100) || true' };

function valueOf(result: RpcResult): unknown {
  if (!result.ok) {
    throw new Error(`expected ok, got ${JSON.stringify(result.error)}`);
  }
  return result.value;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(condition: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error('condition not met before the timeout');
    }
    await delay(25);
  }
}

describe('profiler through the router against a real MongoDB 8.0 server', () => {
  let mongo: StartedMongo | undefined;
  let client: MongoClient | undefined;
  let services: AppServices | undefined;
  let router: Router;
  let dir: string | undefined;
  let connectionId = '';
  const events: RpcEvent[] = [];

  beforeAll(async () => {
    mongo = await startMongo(IMAGE);
    client = new MongoClient(mongo.rootUri);
    await client.connect();
    await client.db(SCRATCH_DB).collection('probe').insertOne({ value: 1 });

    dir = mkdtempSync(join(tmpdir(), 'profiler-integration-'));
    services = createAppServices({ userDataDir: dir, kdf: FAST_KDF, failureDelayMs: 0 });
    router = createRouter({
      ...services,
      onEvent: (event) => {
        events.push(event);
      },
    });
    valueOf(await router.handle('vault.initialise', { password: PASSWORD }));
    const created = valueOf(
      await router.handle('connections.create', { name: 'profiler', uri: mongo.rootUri }),
    ) as { id: string };
    connectionId = created.id;
    valueOf(await router.handle('connections.connect', { id: connectionId }));
  }, SUITE_TIMEOUT_MS);

  afterAll(async () => {
    await router?.handle('profiler.tail', {
      connectionId,
      database: SCRATCH_DB,
      enabled: false,
    });
    await client?.db(SCRATCH_DB).dropDatabase();
    await client?.close();
    await services?.dispose();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
    await mongo?.stop();
  }, SUITE_TIMEOUT_MS);

  it(
    'sets level 2, records a slow $where find, lists it and groups it into a shape',
    async () => {
      if (client === undefined) {
        throw new Error('client not connected');
      }
      const level = valueOf(
        await router.handle('profiler.setLevel', {
          connectionId,
          database: SCRATCH_DB,
          level: 2,
        }),
      ) as { level: number };
      expect(level.level).toBe(2);

      await client.db(SCRATCH_DB).collection('probe').find(SLOW_FIND).limit(5).toArray();

      const filter = { ns: `${SCRATCH_DB}.probe`, minMillis: 50, limit: 50 };
      const listed = valueOf(
        await router.handle('profiler.list', { connectionId, database: SCRATCH_DB, filter }),
      ) as ProfileEntry[];
      const slow = listed.find((entry) => JSON.stringify(entry.command).includes('sleep(100)'));
      expect(slow).toBeDefined();
      expect(slow?.op).toBe('query');
      expect(slow?.ns).toBe(`${SCRATCH_DB}.probe`);
      expect(slow?.millis).toBeGreaterThanOrEqual(50);
      // Values arrive as canonical extended JSON: the int32 limit is wrapped, not a bare number.
      expect(JSON.stringify(slow?.command)).toContain('"limit":{"$numberInt":"5"}');
      expect(JSON.stringify(slow?.raw)).toContain('"docsExamined":{"$numberInt":"1"}');
      expect(slow?.ts).toMatch(/Z$/);

      const shapes = valueOf(
        await router.handle('profiler.shapes', { connectionId, database: SCRATCH_DB, filter }),
      ) as { ns: string; count: number; key: string }[];
      const group = shapes.find((shape) => shape.ns === `${SCRATCH_DB}.probe`);
      expect(group?.count).toBeGreaterThanOrEqual(1);
      expect(group?.key.startsWith(`${SCRATCH_DB}.probe|query|`)).toBe(true);
    },
    CALL_TIMEOUT_MS,
  );

  it(
    'tail delivers a new slow entry as a profiler event, then stops',
    async () => {
      if (client === undefined) {
        throw new Error('client not connected');
      }
      valueOf(
        await router.handle('profiler.tail', {
          connectionId,
          database: SCRATCH_DB,
          enabled: true,
          pollMs: 100,
        }),
      );
      await delay(300);

      await client
        .db(SCRATCH_DB)
        .collection('probe')
        .find({ $where: 'sleep(120) || true' })
        .toArray();

      const delivered = (): boolean =>
        events.some(
          (event) =>
            event.type === 'profiler:entries' &&
            event.connectionId === connectionId &&
            event.database === SCRATCH_DB &&
            event.entries.some((entry) => JSON.stringify(entry.command).includes('sleep(120)')),
        );
      await waitUntil(delivered, 15_000);

      // The tail row has the same canonical form as a listed row.
      const tailed = events
        .flatMap((event) => (event.type === 'profiler:entries' ? event.entries : []))
        .find((entry) => JSON.stringify(entry.command).includes('sleep(120)'));
      expect(JSON.stringify(tailed?.raw)).toContain('"docsExamined":{"$numberInt":"1"}');
      expect(JSON.stringify(tailed?.raw)).toContain('"ts":{"$date":{"$numberLong"');

      valueOf(
        await router.handle('profiler.tail', {
          connectionId,
          database: SCRATCH_DB,
          enabled: false,
        }),
      );
      const countAfterStop = events.length;
      await delay(300);
      expect(events.length).toBe(countAfterStop);

      valueOf(
        await router.handle('profiler.setLevel', { connectionId, database: SCRATCH_DB, level: 0 }),
      );
    },
    CALL_TIMEOUT_MS,
  );
});
