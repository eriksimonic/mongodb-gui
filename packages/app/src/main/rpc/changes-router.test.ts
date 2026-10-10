import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AppErrorException,
  appError,
  type ChangeWatchState,
  type ConnectionStatus,
  type RpcEvent,
  type RpcResult,
} from '@mongo-gui/core';
import type { ChangeWatch } from '@mongo-gui/mongo-adapter';
import {
  createAppServices,
  createRouter,
  type AppServices,
  type ConnectionRegistry,
  type DriverClient,
  type Router,
} from './router';

const FAST_KDF = { N: 2 ** 10, r: 8, p: 1 };
const CONNECTION_ID = '3f2b8c1e-5d4a-4b7e-9c1f-2a6d8e0b7f10';
const WATCH_ID = '5c7d9e1f-2a3b-4c5d-8e9f-0a1b2c3d4e5f';
const TARGET = { kind: 'collection', database: 'shop', collection: 'orders' };
const CLIENT = { fake: 'client' } as unknown as DriverClient;

function codeOf(result: RpcResult): string {
  if (result.ok) {
    throw new Error('expected a failure');
  }
  return result.error.code;
}

/** A registry where only CONNECTION_ID is connected. The change calls never reach the driver. */
function registry(): ConnectionRegistry {
  const unused = (): never => {
    throw new Error('not used by the change stream tests');
  };
  return {
    connect: async () => unused(),
    disconnect: async () => {
      unused();
    },
    disconnectAll: async () => undefined,
    status: (): ConnectionStatus => ({ state: 'disconnected' }),
    test: async () => unused(),
    getClient(connectionId) {
      if (connectionId !== CONNECTION_ID) {
        throw new AppErrorException(appError('NOT_CONNECTED', 'Not connected'));
      }
      return CLIENT;
    },
    onStatusChange: () => () => undefined,
  };
}

describe('change stream routes', () => {
  let dir: string;
  let services: AppServices;
  let router: Router;
  let events: RpcEvent[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'changes-router-'));
    services = createAppServices({ userDataDir: dir, kdf: FAST_KDF, failureDelayMs: 0 });
    events = [];
    router = createRouter({
      ...services,
      connections: registry(),
      onEvent: (event) => {
        events.push(event);
      },
    });
  });

  afterEach(async () => {
    await services.dispose();
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses to start a watch on a connection that is not open', async () => {
    const result = await router.handle('changes.start', {
      connectionId: '7d1e9f04-2b3c-4d5e-8f60-a1b2c3d4e5f6',
      target: TARGET,
      options: {},
    });

    expect(codeOf(result)).toBe('NOT_CONNECTED');
  });

  it('refuses a pipeline that writes to another collection, with the adapter message', async () => {
    const result = await router.handle('changes.start', {
      connectionId: CONNECTION_ID,
      target: TARGET,
      options: { pipelineEjson: '[{"$out": "archive"}]' },
    });

    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.error.message).toBe(
      '$out is not allowed in a change stream pipeline',
    );
    expect(events).toHaveLength(0);
  });

  it('answers NOT_FOUND for a watch that is not open', async () => {
    expect(codeOf(await router.handle('changes.pause', { watchId: WATCH_ID }))).toBe('NOT_FOUND');
    expect(codeOf(await router.handle('changes.resume', { watchId: WATCH_ID }))).toBe('NOT_FOUND');
    expect(codeOf(await router.handle('changes.state', { watchId: WATCH_ID }))).toBe('NOT_FOUND');
    expect(codeOf(await router.handle('changes.stop', { watchId: WATCH_ID }))).toBe('NOT_FOUND');
  });
});

describe('change stream state errors', () => {
  it('redacts a URI in the error of a watch state before it reaches the renderer', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'changes-state-'));
    const services = createAppServices({ userDataDir: dir, kdf: FAST_KDF, failureDelayMs: 0 });
    const secretMessage = 'Connection failed for mongodb://u:secretpw@h:1/db';
    const fakeWatch: ChangeWatch = {
      pause() {},
      resume() {},
      async close() {},
      state: () => ({
        phase: 'error',
        eventsSeen: 0,
        eventsDropped: 0,
        openedAt: '2026-10-10T10:00:00.000Z',
        error: appError('NOT_CONNECTED', secretMessage),
      }),
    };
    const router = createRouter({
      ...services,
      connections: registry(),
      onEvent: () => undefined,
      openWatch: () => fakeWatch,
    });
    try {
      const started = await router.handle('changes.start', {
        connectionId: CONNECTION_ID,
        target: TARGET,
        options: {},
      });
      const watchId = started.ok ? (started.value as { watchId: string }).watchId : '';

      const state = await router.handle('changes.state', { watchId });

      expect(state.ok).toBe(true);
      const text = JSON.stringify(state);
      expect(text).not.toContain('secretpw');
      expect(text).toContain('***');
    } finally {
      await services.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
