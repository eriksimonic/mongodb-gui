import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AppErrorException,
  appError,
  type ConnectionProfile,
  type ConnectionStatus,
  type RpcEvent,
  type RpcResult,
  type ShellEvaluation,
} from '@mongo-gui/core';
import { createAppServices, createRouter, type AppServices, type Router } from './router';
import type { ConnectionRegistry, ShellRegistry } from './router';
import type { RuntimeEvent } from '../shell/supervisor';

const FAST_KDF = { N: 2 ** 10, r: 8, p: 1 };
const CONNECTION_ID = '3f2b8c1e-5d4a-4b7e-9c1f-2a6d8e0b7f10';
const REQUEST_ID = '9b1d4c7a-2e3f-4a6b-8c9d-0e1f2a3b4c5d';

function valueOf(result: RpcResult): unknown {
  if (!result.ok) {
    throw new Error(`expected ok, got ${JSON.stringify(result.error)}`);
  }
  return result.value;
}

function errorOf(result: RpcResult): unknown {
  if (result.ok) {
    throw new Error('expected a failure');
  }
  return result.error;
}

interface Calls {
  readonly evaluate: unknown[];
  readonly next: unknown[];
  readonly cancel: unknown[][];
  readonly complete: unknown[];
  readonly sampleSchema: unknown[];
  readonly restart: string[];
  readonly stop: string[];
}

interface FakeShell extends ShellRegistry {
  readonly calls: Calls;
  emit(event: RuntimeEvent): void;
}

// A RuntimeSupervisor stand-in that records each call and answers with fixed values.
function fakeShell(): FakeShell {
  const listeners = new Set<(event: RuntimeEvent) => void>();
  const calls: Calls = {
    evaluate: [],
    next: [],
    cancel: [],
    complete: [],
    sampleSchema: [],
    restart: [],
    stop: [],
  };
  const evaluation = (requestId: string): ShellEvaluation => ({
    requestId,
    result: { type: 'number', printableEjson: '2', hasMore: false },
    elapsedMs: 1,
  });
  return {
    calls,
    emit(event) {
      for (const listener of listeners) {
        listener(event);
      }
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    state: () => 'ready',
    async evaluate(input) {
      calls.evaluate.push(input);
      return evaluation(input.requestId ?? REQUEST_ID);
    },
    async next(input) {
      calls.next.push(input);
      return evaluation(input.requestId);
    },
    async cancel(connectionId, requestId) {
      calls.cancel.push([connectionId, requestId]);
    },
    async complete(input) {
      calls.complete.push(input);
      return { items: [{ text: 'find', kind: 'method' }] };
    },
    async sampleSchema(input) {
      calls.sampleSchema.push(input);
      return { fields: [], sampled: 0 };
    },
    async restart(connectionId) {
      calls.restart.push(connectionId);
    },
    async stop(connectionId) {
      calls.stop.push(connectionId);
    },
    async stopAll() {
      return undefined;
    },
  };
}

interface FakeConnections extends ConnectionRegistry {
  setStatus(connectionId: string, status: ConnectionStatus): void;
}

function fakeConnections(): FakeConnections {
  const statuses = new Map<string, ConnectionStatus>();
  const listeners = new Set<(connectionId: string, status: ConnectionStatus) => void>();
  return {
    setStatus(connectionId, status) {
      statuses.set(connectionId, status);
      for (const listener of listeners) {
        listener(connectionId, status);
      }
    },
    async connect(profile: ConnectionProfile) {
      void profile;
      throw new AppErrorException(appError('INTERNAL', 'not used'));
    },
    async disconnect() {
      return undefined;
    },
    async disconnectAll() {
      return undefined;
    },
    status(connectionId) {
      return statuses.get(connectionId) ?? { state: 'disconnected' };
    },
    getClient(): never {
      throw new AppErrorException(appError('NOT_CONNECTED', 'Not connected'));
    },
    async test() {
      return { ok: false, error: appError('INTERNAL', 'not used') };
    },
    onStatusChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

const CONNECTED: ConnectionStatus = {
  state: 'connected',
  serverVersion: '8.0.17',
  topology: 'standalone',
  hosts: ['localhost:27017'],
};

describe('router shell namespace', () => {
  let dir: string;
  let services: AppServices;
  let router: Router;
  let shell: FakeShell;
  let connections: FakeConnections;
  let events: RpcEvent[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'router-shell-'));
    services = createAppServices({
      userDataDir: dir,
      kdf: FAST_KDF,
      failureDelayMs: 0,
    });
    shell = fakeShell();
    connections = fakeConnections();
    events = [];
    router = createRouter({
      ...services,
      connections,
      shell,
      onEvent: (event) => {
        events.push(event);
      },
    });
  });

  afterEach(async () => {
    await services.dispose();
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses evaluate for a connection that is not open, before any process starts', async () => {
    const result = await router.handle('shell.evaluate', {
      connectionId: CONNECTION_ID,
      database: 'shop',
      code: '1 + 1',
    });
    expect(errorOf(result)).toMatchObject({ code: 'NOT_CONNECTED' });
    expect(shell.calls.evaluate).toHaveLength(0);
  });

  it('passes an open connection evaluate through with the default batch size', async () => {
    connections.setStatus(CONNECTION_ID, CONNECTED);
    const result = await router.handle('shell.evaluate', {
      connectionId: CONNECTION_ID,
      database: 'shop',
      code: 'db.orders.find()',
    });
    expect(valueOf(result)).toMatchObject({ result: { printableEjson: '2' } });
    expect(shell.calls.evaluate[0]).toMatchObject({ batchSize: 50, database: 'shop' });
  });

  it('rejects a batch size above 1000 before reaching the shell', async () => {
    connections.setStatus(CONNECTION_ID, CONNECTED);
    const result = await router.handle('shell.evaluate', {
      connectionId: CONNECTION_ID,
      database: 'shop',
      code: '1',
      batchSize: 1001,
    });
    expect(errorOf(result)).toMatchObject({ code: 'VALIDATION' });
    expect(shell.calls.evaluate).toHaveLength(0);
  });

  it('forwards next, complete and sampleSchema for an open connection', async () => {
    connections.setStatus(CONNECTION_ID, CONNECTED);
    expect(
      valueOf(
        await router.handle('shell.next', {
          connectionId: CONNECTION_ID,
          requestId: REQUEST_ID,
          batchSize: 25,
        }),
      ),
    ).toMatchObject({ requestId: REQUEST_ID });
    expect(shell.calls.next[0]).toMatchObject({ batchSize: 25 });

    expect(
      valueOf(
        await router.handle('shell.complete', {
          connectionId: CONNECTION_ID,
          database: 'shop',
          code: 'db.',
          position: 3,
        }),
      ),
    ).toEqual({ items: [{ text: 'find', kind: 'method' }] });

    expect(
      valueOf(
        await router.handle('shell.sampleSchema', {
          connectionId: CONNECTION_ID,
          database: 'shop',
          collection: 'orders',
        }),
      ),
    ).toEqual({ fields: [], sampled: 0 });
    expect(shell.calls.sampleSchema[0]).toMatchObject({ size: 100 });
  });

  it('cancels a request without requiring the connection to be open', async () => {
    const result = await router.handle('shell.cancel', {
      connectionId: CONNECTION_ID,
      requestId: REQUEST_ID,
    });
    expect(valueOf(result)).toBeUndefined();
    expect(shell.calls.cancel).toEqual([[CONNECTION_ID, REQUEST_ID]]);
  });

  it('reports the runtime state and restarts only an open connection', async () => {
    expect(valueOf(await router.handle('shell.state', { connectionId: CONNECTION_ID }))).toEqual({
      state: 'ready',
    });
    expect(
      errorOf(await router.handle('shell.restart', { connectionId: CONNECTION_ID })),
    ).toMatchObject({ code: 'NOT_CONNECTED' });
    connections.setStatus(CONNECTION_ID, CONNECTED);
    expect(valueOf(await router.handle('shell.restart', { connectionId: CONNECTION_ID }))).toBe(
      undefined,
    );
    expect(shell.calls.restart).toEqual([CONNECTION_ID]);
  });

  it('stops the runtime when the connection leaves the connected state', async () => {
    connections.setStatus(CONNECTION_ID, CONNECTED);
    expect(shell.calls.stop).toEqual([]);
    connections.setStatus(CONNECTION_ID, { state: 'disconnected' });
    expect(shell.calls.stop).toEqual([CONNECTION_ID]);
  });

  it('forwards shell events to the window', () => {
    shell.emit({ type: 'shell:state', connectionId: CONNECTION_ID, state: 'starting' });
    shell.emit({
      type: 'shell:print',
      connectionId: CONNECTION_ID,
      requestId: REQUEST_ID,
      text: 'x',
    });
    expect(events).toEqual([
      { type: 'shell:state', connectionId: CONNECTION_ID, state: 'starting' },
      { type: 'shell:print', connectionId: CONNECTION_ID, requestId: REQUEST_ID, text: 'x' },
    ]);
  });
});
