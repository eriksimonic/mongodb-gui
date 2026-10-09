import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AppErrorException,
  appError,
  type ConnectionStatus,
  type ProfileEntry,
  type ProfileFilter,
  type ProfilingLevel,
  type RpcEvent,
  type RpcResult,
  type SetProfilingLevelInput,
  type TailProfileOptions,
} from '@mongo-gui/core';
import type { ProfileTail } from '@mongo-gui/mongo-adapter';
import {
  createAppServices,
  createRouter,
  type AppServices,
  type ConnectionRegistry,
  type DriverClient,
  type ProfilerPort,
  type Router,
} from './router';

const FAST_KDF = { N: 2 ** 10, r: 8, p: 1 };
const CONNECTION_ID = '3f2b8c1e-5d4a-4b7e-9c1f-2a6d8e0b7f10';
const OTHER_CONNECTION_ID = '7d1e9f04-2b3c-4d5e-8f60-a1b2c3d4e5f6';
const DATABASE = { connectionId: CONNECTION_ID, database: 'shop' };
const CLIENT = { fake: 'client' } as unknown as DriverClient;
const LEVEL: ProfilingLevel = { level: 1, slowMs: 100 };

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

function entry(id: string, overrides: Partial<ProfileEntry> = {}): ProfileEntry {
  return {
    id,
    ts: '2026-10-09T10:00:00.000Z',
    ns: 'shop.orders',
    op: 'query',
    millis: 120,
    queryHash: 'AB12',
    command: { find: 'orders', filter: { status: 'paid' } },
    raw: { op: 'query' },
    ...overrides,
  };
}

interface FakeTail extends ProfileTail {
  stopped: boolean;
  emit(entries: ProfileEntry[]): void;
  fail(error: { code: 'COMMAND_FAILED'; message: string }): void;
}

interface FakePort extends ProfilerPort {
  readonly setLevelCalls: {
    client: DriverClient;
    database: string;
    input: SetProfilingLevelInput;
  }[];
  readonly listCalls: ProfileFilter[];
  readonly tails: FakeTail[];
  readonly tailOptions: TailProfileOptions[];
  rows: ProfileEntry[];
}

/** Records every call. Tails are plain objects the test drives by hand. */
function fakePort(): FakePort {
  const port: FakePort = {
    setLevelCalls: [],
    listCalls: [],
    tails: [],
    tailOptions: [],
    rows: [],
    async level() {
      return LEVEL;
    },
    async setLevel(client, database, input) {
      port.setLevelCalls.push({ client, database, input });
      return { level: input.level, slowMs: input.slowMs ?? 100 };
    },
    async list(_client, _database, filter) {
      port.listCalls.push(filter);
      return port.rows;
    },
    async info() {
      return { exists: true, sizeBytes: 1024, count: 3 };
    },
    tail(_client, _database, options) {
      port.tailOptions.push(options);
      const listeners = new Set<(entries: ProfileEntry[]) => void>();
      const errors = new Set<(error: { code: 'COMMAND_FAILED'; message: string }) => void>();
      const tail: FakeTail = {
        stopped: false,
        stop() {
          tail.stopped = true;
        },
        onEntries(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        onError(listener) {
          errors.add(listener);
          return () => errors.delete(listener);
        },
        emit(entries) {
          for (const listener of listeners) {
            listener(entries);
          }
        },
        fail(error) {
          for (const listener of errors) {
            listener(error);
          }
        },
      };
      port.tails.push(tail);
      return tail;
    },
  };
  return port;
}

interface FakeConnections extends ConnectionRegistry {
  setConnected(connectionId: string, connected: boolean): void;
  emitStatus(connectionId: string, status: ConnectionStatus): void;
}

/** A ConnectionManager stand-in. getClient fails with NOT_CONNECTED until a connection is marked connected. */
function fakeConnections(): FakeConnections {
  const connected = new Set<string>();
  const listeners = new Set<(connectionId: string, status: ConnectionStatus) => void>();
  const unused = (): never => {
    throw new Error('not used by the profiler tests');
  };
  return {
    connect: async () => unused(),
    disconnect: async () => {
      unused();
    },
    disconnectAll: async () => undefined,
    status: () => ({ state: 'disconnected' }),
    test: async () => unused(),
    getClient(connectionId) {
      if (!connected.has(connectionId)) {
        throw new AppErrorException(appError('NOT_CONNECTED', 'Not connected'));
      }
      return CLIENT;
    },
    onStatusChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setConnected(connectionId, value) {
      if (value) {
        connected.add(connectionId);
      } else {
        connected.delete(connectionId);
      }
    },
    emitStatus(connectionId, status) {
      for (const listener of listeners) {
        listener(connectionId, status);
      }
    },
  };
}

describe('profiler routes', () => {
  let dir: string;
  let services: AppServices;
  let connections: FakeConnections;
  let port: FakePort;
  let router: Router;
  let events: RpcEvent[];
  let lockListeners: (() => void)[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'profiler-router-'));
    services = createAppServices({ userDataDir: dir, kdf: FAST_KDF, failureDelayMs: 0 });
    connections = fakeConnections();
    connections.setConnected(CONNECTION_ID, true);
    port = fakePort();
    events = [];
    lockListeners = [];
    router = createRouter({
      ...services,
      connections,
      profiler: port,
      onEvent: (event) => {
        events.push(event);
      },
      lockEvents: {
        subscribe(listener) {
          lockListeners.push(listener);
          return () => undefined;
        },
      },
    });
  });

  afterEach(async () => {
    await services.dispose();
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads the level and passes slowMs and sampleRate to setLevel', async () => {
    expect(valueOf(await router.handle('profiler.level', DATABASE))).toEqual(LEVEL);
    const set = await router.handle('profiler.setLevel', {
      ...DATABASE,
      level: 1,
      slowMs: 50,
      sampleRate: 0.5,
    });
    expect(valueOf(set)).toEqual({ level: 1, slowMs: 50 });
    expect(port.setLevelCalls[0]?.input).toEqual({ level: 1, slowMs: 50, sampleRate: 0.5 });
  });

  it('omits unset optional fields when it forwards setLevel', async () => {
    await router.handle('profiler.setLevel', { ...DATABASE, level: 2 });
    expect(port.setLevelCalls[0]?.input).toEqual({ level: 2 });
  });

  it('rejects a level outside 0 to 2 before it reaches the port', async () => {
    const result = await router.handle('profiler.setLevel', { ...DATABASE, level: 3 });
    expect(errorOf(result)).toBe('VALIDATION');
    expect(port.setLevelCalls).toHaveLength(0);
  });

  it('reports NOT_CONNECTED for a connection that is not open', async () => {
    const result = await router.handle('profiler.list', {
      connectionId: OTHER_CONNECTION_ID,
      database: 'shop',
      filter: {},
    });
    expect(errorOf(result)).toBe('NOT_CONNECTED');
  });

  it('returns entries with BSON values in canonical extended JSON', async () => {
    port.rows = [entry('a', { command: { find: 'orders', at: new Date(0) } })];
    const listed = valueOf(
      await router.handle('profiler.list', { ...DATABASE, filter: { limit: 10 } }),
    ) as ProfileEntry[];
    expect(listed[0]?.command).toEqual({
      find: 'orders',
      at: { $date: { $numberLong: '0' } },
    });
    expect(port.listCalls[0]).toEqual({ limit: 10 });
  });

  it('groups the listed entries into shapes by the server query hash', async () => {
    port.rows = [
      entry('a', { millis: 100 }),
      entry('b', { millis: 300 }),
      entry('c', { ns: 'shop.customers', millis: 50 }),
    ];
    const shapes = valueOf(await router.handle('profiler.shapes', { ...DATABASE, filter: {} })) as {
      count: number;
      ns: string;
      totalMillis: number;
    }[];
    expect(shapes.map((shape) => [shape.ns, shape.count, shape.totalMillis])).toEqual([
      ['shop.orders', 2, 400],
      ['shop.customers', 1, 50],
    ]);
  });

  it('returns the info of system.profile', async () => {
    expect(valueOf(await router.handle('profiler.info', DATABASE))).toEqual({
      exists: true,
      sizeBytes: 1024,
      count: 3,
    });
  });

  it('starts a tail from now with the poll interval and forwards its entries as events', async () => {
    const before = Date.now();
    await router.handle('profiler.tail', { ...DATABASE, enabled: true, pollMs: 500 });
    expect(port.tailOptions).toHaveLength(1);
    const options = port.tailOptions[0];
    expect(options?.pollMs).toBe(500);
    expect(Date.parse(options?.since ?? '')).toBeGreaterThanOrEqual(before);

    port.tails[0]?.emit([entry('new', { command: { find: 'orders', at: new Date(0) } })]);
    expect(events).toEqual([
      {
        type: 'profiler:entries',
        connectionId: CONNECTION_ID,
        database: 'shop',
        entries: [
          expect.objectContaining({
            id: 'new',
            command: { find: 'orders', at: { $date: { $numberLong: '0' } } },
          }),
        ],
      },
    ]);
  });

  it('defaults the tail poll interval to 2000 ms', async () => {
    await router.handle('profiler.tail', {
      connectionId: CONNECTION_ID,
      database: 'shop',
      enabled: true,
    });
    expect(port.tailOptions[0]?.pollMs).toBe(2000);
  });

  it('keeps one tail per connection and database by replacing the previous one', async () => {
    await router.handle('profiler.tail', { ...DATABASE, enabled: true, pollMs: 500 });
    await router.handle('profiler.tail', { ...DATABASE, enabled: true, pollMs: 800 });
    expect(port.tails).toHaveLength(2);
    expect(port.tails[0]?.stopped).toBe(true);
    expect(port.tails[1]?.stopped).toBe(false);
  });

  it('stops the tail on enabled false and leaves other databases running', async () => {
    await router.handle('profiler.tail', { ...DATABASE, enabled: true, pollMs: 500 });
    await router.handle('profiler.tail', {
      ...DATABASE,
      database: 'logs',
      enabled: true,
      pollMs: 500,
    });
    await router.handle('profiler.tail', { ...DATABASE, enabled: false });
    expect(port.tails[0]?.stopped).toBe(true);
    expect(port.tails[1]?.stopped).toBe(false);
  });

  it('stops a connection tails when that connection disconnects', async () => {
    await router.handle('profiler.tail', { ...DATABASE, enabled: true, pollMs: 500 });
    connections.emitStatus(CONNECTION_ID, { state: 'disconnected' });
    expect(port.tails[0]?.stopped).toBe(true);
  });

  it('stops every tail when the vault locks', async () => {
    await router.handle('profiler.tail', { ...DATABASE, enabled: true, pollMs: 500 });
    await router.handle('profiler.tail', {
      ...DATABASE,
      database: 'logs',
      enabled: true,
      pollMs: 500,
    });
    for (const listener of lockListeners) {
      listener();
    }
    expect(port.tails.every((tail) => tail.stopped)).toBe(true);
  });

  it('forwards a tail failure as a profiler error event', async () => {
    await router.handle('profiler.tail', { ...DATABASE, enabled: true, pollMs: 500 });
    port.tails[0]?.fail({
      code: 'COMMAND_FAILED',
      message: 'The server refused the profiler command',
    });
    expect(events).toEqual([
      {
        type: 'profiler:error',
        connectionId: CONNECTION_ID,
        database: 'shop',
        error: { code: 'COMMAND_FAILED', message: 'The server refused the profiler command' },
      },
    ]);
  });

  it('does not start a tail for a connection that is not open', async () => {
    const result = await router.handle('profiler.tail', {
      connectionId: OTHER_CONNECTION_ID,
      database: 'shop',
      enabled: true,
      pollMs: 500,
    });
    expect(errorOf(result)).toBe('NOT_CONNECTED');
    expect(port.tails).toHaveLength(0);
  });

  it('resetRenderer stops every tail, so a reloaded page starts clean', async () => {
    await router.handle('profiler.tail', { ...DATABASE, enabled: true, pollMs: 500 });
    await router.handle('profiler.tail', {
      ...DATABASE,
      database: 'logs',
      enabled: true,
      pollMs: 500,
    });
    router.resetRenderer();
    expect(port.tails.every((tail) => tail.stopped)).toBe(true);
  });

  it('runs the cleanups registered with onRendererReset and no others', async () => {
    let kept = 0;
    let dropped = 0;
    router.onRendererReset(() => {
      kept += 1;
    });
    const unregister = router.onRendererReset(() => {
      dropped += 1;
    });
    unregister();
    router.resetRenderer();
    router.resetRenderer();
    expect(kept).toBe(2);
    expect(dropped).toBe(0);
  });

  it('keeps running the other cleanups when one of them throws', async () => {
    let ran = 0;
    router.onRendererReset(() => {
      throw new Error('cleanup failed');
    });
    router.onRendererReset(() => {
      ran += 1;
    });
    router.resetRenderer();
    expect(ran).toBe(1);
  });

  it('rejects a poll interval under 50 ms', async () => {
    const result = await router.handle('profiler.tail', { ...DATABASE, enabled: true, pollMs: 10 });
    expect(errorOf(result)).toBe('VALIDATION');
  });
});
