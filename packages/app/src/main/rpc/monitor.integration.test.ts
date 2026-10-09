import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MonitorSample, RpcEvent, RpcResult } from '@mongo-gui/core';
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
const SAMPLE_WAIT_MS = 15_000;
const PASSWORD = 'integration vault password';
const FAST_KDF = { N: 2 ** 10, r: 8, p: 1 };
const INTERVAL_MS = 1000;

function valueOf(result: RpcResult): unknown {
  if (!result.ok) {
    throw new Error(`expected ok, got ${JSON.stringify(result.error)}`);
  }
  return result.value;
}

describe('monitor router against a real MongoDB 8.0 server', () => {
  let mongo: StartedMongo | undefined;
  let router: Router;
  let services: AppServices | undefined;
  let dir: string | undefined;
  const events: RpcEvent[] = [];

  beforeAll(async () => {
    mongo = await startMongo(IMAGE);
    dir = mkdtempSync(join(tmpdir(), 'monitor-integration-'));
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
    'starts monitoring through the router and receives two samples',
    async () => {
      if (mongo === undefined) {
        throw new Error('container not started');
      }
      const created = valueOf(
        await router.handle('connections.create', { name: 'monitor', uri: mongo.rootUri }),
      ) as { id: string };
      const connectionId = created.id;
      valueOf(await router.handle('connections.connect', { id: connectionId }));

      const config = valueOf(
        await router.handle('monitor.start', { connectionId, intervalMs: INTERVAL_MS }),
      );
      expect(config).toMatchObject({ intervalMs: INTERVAL_MS });

      const received = await waitForSamples(events, connectionId, 2, SAMPLE_WAIT_MS);
      expect(received.map((sample) => sample.at)).toHaveLength(2);
      expect(received[1]?.uptimeSeconds).toBeGreaterThan(0);

      const buffered = valueOf(
        await router.handle('monitor.samples', { connectionId }),
      ) as MonitorSample[];
      expect(buffered.length).toBeGreaterThanOrEqual(2);

      const operations = valueOf(await router.handle('monitor.operations', { connectionId }));
      expect(Array.isArray(operations)).toBe(true);

      const idle = await router.handle('monitor.killOperation', {
        connectionId,
        opid: 'conn:1',
      });
      expect(idle.ok).toBe(false);

      valueOf(await router.handle('monitor.stop', { connectionId }));
      valueOf(await router.handle('connections.disconnect', { id: connectionId }));
    },
    CALL_TIMEOUT_MS,
  );

  it(
    'stops the real sampler when the connection disconnects',
    async () => {
      if (mongo === undefined) {
        throw new Error('container not started');
      }
      const created = valueOf(
        await router.handle('connections.create', { name: 'disconnect', uri: mongo.rootUri }),
      ) as { id: string };
      const connectionId = created.id;
      valueOf(await router.handle('connections.connect', { id: connectionId }));
      valueOf(await router.handle('monitor.start', { connectionId, intervalMs: INTERVAL_MS }));
      await waitForSamples(events, connectionId, 1, SAMPLE_WAIT_MS);

      valueOf(await router.handle('connections.disconnect', { id: connectionId }));
      const mark = events.length;
      // Three intervals of silence, plus a margin for a sample that was already in flight.
      await new Promise((resolve) => setTimeout(resolve, INTERVAL_MS * 3 + 500));

      const after = events
        .slice(mark)
        .filter((event) => event.type === 'monitor:sample' && event.connectionId === connectionId);
      expect(after).toHaveLength(0);
      expect(valueOf(await router.handle('monitor.samples', { connectionId }))).toEqual([]);
    },
    CALL_TIMEOUT_MS,
  );
});

/** Resolves once the event list holds the wanted number of samples for one connection. */
async function waitForSamples(
  events: RpcEvent[],
  connectionId: string,
  count: number,
  timeoutMs: number,
): Promise<MonitorSample[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = events.flatMap((event) =>
      event.type === 'monitor:sample' && event.connectionId === connectionId ? [event.sample] : [],
    );
    if (found.length >= count) {
      return found;
    }
    if (Date.now() > deadline) {
      throw new Error(`only ${found.length} samples within ${timeoutMs} ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
