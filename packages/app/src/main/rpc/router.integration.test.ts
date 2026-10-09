import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RpcEvent, RpcResult } from '@mongo-gui/core';
import { createAppServices, createRouter, type AppServices, type Router } from './router';
// The Testcontainers harness lives with the adapter tests. It is not exported from the
// adapter package, so this test reads it from the workspace source.
import {
  CONTAINER_STARTUP_TIMEOUT_MS,
  SEED_DB,
  seedCatalog,
  startMongo,
  type StartedMongo,
} from '../../../../mongo-adapter/src/test/mongo-container';

// The floating mongo:8.0 tag refuses to start on Linux kernels 6.19 and newer (SERVER-121912).
const IMAGE = 'mongo:8.0.17';
const SUITE_TIMEOUT_MS = CONTAINER_STARTUP_TIMEOUT_MS + 60_000;
const CALL_TIMEOUT_MS = 60_000;
const PASSWORD = 'integration vault password';
const FAST_KDF = { N: 2 ** 10, r: 8, p: 1 };

function valueOf(result: RpcResult): unknown {
  if (!result.ok) {
    throw new Error(`expected ok, got ${JSON.stringify(result.error)}`);
  }
  return result.value;
}

describe('router against a real MongoDB 8.0 server', () => {
  let mongo: StartedMongo | undefined;
  let router: Router;
  let services: AppServices | undefined;
  let dir: string | undefined;
  const events: RpcEvent[] = [];

  beforeAll(async () => {
    mongo = await startMongo(IMAGE);
    await seedCatalog(mongo.rootUri, true);
    dir = mkdtempSync(join(tmpdir(), 'router-integration-'));
    services = createAppServices({ userDataDir: dir, kdf: FAST_KDF, failureDelayMs: 0 });
    router = createRouter({
      ...services,
      onEvent: (event) => {
        events.push(event);
      },
    });
    valueOf(await router.handle('vault.initialise', { password: PASSWORD }));
  }, SUITE_TIMEOUT_MS);

  afterAll(async () => {
    await services?.dispose();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
    await mongo?.stop();
  }, SUITE_TIMEOUT_MS);

  it(
    'creates a profile, connects, lists databases and collections, then disconnects',
    async () => {
      if (mongo === undefined) {
        throw new Error('container not started');
      }
      const created = valueOf(
        await router.handle('connections.create', {
          name: 'integration',
          uri: mongo.rootUri,
        }),
      ) as { id: string };
      const connectionId = created.id;

      const status = valueOf(await router.handle('connections.connect', { id: connectionId }));
      expect(status).toEqual(
        expect.objectContaining({ state: 'connected', topology: 'standalone' }),
      );

      const databases = valueOf(await router.handle('databases.list', { connectionId })) as {
        name: string;
      }[];
      expect(databases.map((database) => database.name)).toContain(SEED_DB);

      const collections = valueOf(
        await router.handle('collections.list', { connectionId, database: SEED_DB }),
      ) as { name: string; type: string }[];
      const names = collections.map((collection) => collection.name);
      expect(names).toEqual(expect.arrayContaining(['orders', 'events', 'paidOrders', 'metrics']));
      expect(collections.find((collection) => collection.name === 'paidOrders')?.type).toBe('view');

      const indexes = valueOf(
        await router.handle('collections.indexes', {
          connectionId,
          database: SEED_DB,
          collection: 'orders',
        }),
      ) as { name: string }[];
      expect(indexes.map((index) => index.name)).toContain('status_1_createdAt_-1');

      const listed = valueOf(await router.handle('connections.list', undefined));
      expect(JSON.stringify(listed)).not.toContain('integration-secret');

      valueOf(await router.handle('connections.disconnect', { id: connectionId }));
      expect(valueOf(await router.handle('connections.status', { id: connectionId }))).toEqual({
        state: 'disconnected',
      });
      const connectedEvent = events.some(
        (event) =>
          event.type === 'connection:status' &&
          event.connectionId === connectionId &&
          event.status.state === 'connected',
      );
      expect(connectedEvent).toBe(true);
    },
    CALL_TIMEOUT_MS,
  );
});
