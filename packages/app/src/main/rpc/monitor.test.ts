import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AppErrorException,
  appError,
  type AppError,
  type ConnectionProfile,
  type ConnectionStatus,
  type ConnectionTestResult,
  type MonitorConfig,
  type MonitorSample,
  type RpcEvent,
  type RpcResult,
} from '@mongo-gui/core';
import { createAppServices, createRouter, type ConnectionRegistry, type Router } from './router';
import type { MonitorClient, MonitorSampler, SamplerFactory } from './monitor-service';

const FAST_KDF = { N: 2 ** 10, r: 8, p: 1 };
const PASSWORD = 'correct horse battery';
const CONNECTION_ID = '3f2b8c1e-5d4a-4b7e-9c1f-2a6d8e0b7f10';
const OTHER_ID = '7d1e2f3a-4b5c-4d6e-8f70-112233445566';
const CONNECTED: ConnectionStatus = {
  state: 'connected',
  serverVersion: '8.0.17',
  topology: 'standalone',
  hosts: ['localhost:27017'],
};

function valueOf(result: RpcResult): unknown {
  if (!result.ok) {
    throw new Error(`expected ok, got ${JSON.stringify(result.error)}`);
  }
  return result.value;
}

function errorOf(result: RpcResult): AppError {
  if (result.ok) {
    throw new Error('expected a failure');
  }
  return result.error;
}

function sample(at: string): MonitorSample {
  return {
    at,
    uptimeSeconds: 42,
    opcounters: { insert: 1, query: 2, update: 0, delete: 0, getmore: 0, command: 9 },
    connections: { current: 3, available: 800 },
    network: { bytesInPerSec: 100, bytesOutPerSec: 200, requestsPerSec: 5 },
    memory: { residentMb: 64, virtualMb: 900 },
    series: {},
  };
}

/** Records what the service asks of a sampler and lets a test push samples and errors. */
class FakeSampler {
  started = false;
  stopped = false;
  readonly intervals: number[] = [];
  readonly buffer: MonitorSample[] = [];
  private readonly sampleListeners = new Set<(value: MonitorSample) => void>();
  private readonly errorListeners = new Set<(error: AppError) => void>();

  constructor(readonly config: MonitorConfig) {}

  start(): void {
    this.started = true;
  }

  stop(): void {
    this.stopped = true;
  }

  setInterval(intervalMs: number): void {
    this.intervals.push(intervalMs);
  }

  samples(): MonitorSample[] {
    return [...this.buffer];
  }

  onSample(listener: (value: MonitorSample) => void): () => void {
    this.sampleListeners.add(listener);
    return () => {
      this.sampleListeners.delete(listener);
    };
  }

  onError(listener: (error: AppError) => void): () => void {
    this.errorListeners.add(listener);
    return () => {
      this.errorListeners.delete(listener);
    };
  }

  emitSample(value: MonitorSample): void {
    this.buffer.push(value);
    for (const listener of this.sampleListeners) {
      listener(value);
    }
  }

  emitError(error: AppError): void {
    for (const listener of this.errorListeners) {
      listener(error);
    }
  }

  listenerCount(): number {
    return this.sampleListeners.size + this.errorListeners.size;
  }
}

interface Harness {
  readonly router: Router;
  readonly events: RpcEvent[];
  readonly created: FakeSampler[];
  readonly commands: unknown[];
  readonly operationRows: unknown[];
  setStatus(connectionId: string, status: ConnectionStatus): void;
  dispose(): Promise<void>;
}

function buildHarness(): Harness & { readonly dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'monitor-router-'));
  const services = createAppServices({ userDataDir: dir, kdf: FAST_KDF, failureDelayMs: 0 });
  const events: RpcEvent[] = [];
  const created: FakeSampler[] = [];
  const commands: unknown[] = [];
  const operationRows: unknown[] = [];
  const statuses = new Map<string, ConnectionStatus>([[CONNECTION_ID, CONNECTED]]);
  const statusListeners = new Set<(connectionId: string, status: ConnectionStatus) => void>();

  // The admin database answers $currentOp with operationRows and records every command.
  const client = {
    db: () => ({
      aggregate: () => ({ toArray: async () => operationRows }),
      command: async (command: unknown) => {
        commands.push(command);
        return { ok: 1 };
      },
    }),
  } as unknown as MonitorClient;

  const connections: ConnectionRegistry = {
    async connect(profile: ConnectionProfile) {
      return statuses.get(profile.id) ?? { state: 'disconnected' };
    },
    async disconnect() {},
    async disconnectAll() {},
    status(connectionId) {
      return statuses.get(connectionId) ?? { state: 'disconnected' };
    },
    getClient(connectionId) {
      if (statuses.get(connectionId)?.state !== 'connected') {
        throw new AppErrorException(appError('NOT_CONNECTED', 'Not connected'));
      }
      return client;
    },
    async test(): Promise<ConnectionTestResult> {
      return { ok: true, serverVersion: '8.0.17', topology: 'standalone' };
    },
    onStatusChange(listener) {
      statusListeners.add(listener);
      return () => {
        statusListeners.delete(listener);
      };
    },
  };

  const createSampler: SamplerFactory = (_client, config) => {
    const sampler = new FakeSampler(config);
    created.push(sampler);
    return sampler as MonitorSampler;
  };

  const router = createRouter({
    ...services,
    connections,
    createSampler,
    onEvent: (event) => {
      events.push(event);
    },
  });

  return {
    dir,
    router,
    events,
    created,
    commands,
    operationRows,
    setStatus(connectionId, status) {
      statuses.set(connectionId, status);
      for (const listener of statusListeners) {
        listener(connectionId, status);
      }
    },
    async dispose() {
      await services.dispose();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe('monitor RPC calls', () => {
  let harness: Harness & { readonly dir: string };

  beforeEach(async () => {
    harness = buildHarness();
    valueOf(await harness.router.handle('vault.initialise', { password: PASSWORD }));
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it('starts one sampler per connection with the default interval and reuses it', async () => {
    const first = valueOf(
      await harness.router.handle('monitor.start', { connectionId: CONNECTION_ID }),
    );
    const second = valueOf(
      await harness.router.handle('monitor.start', { connectionId: CONNECTION_ID }),
    );
    expect(first).toEqual({ intervalMs: 2000, retentionMs: 3_600_000 });
    expect(second).toEqual(first);
    expect(harness.created).toHaveLength(1);
    expect(harness.created[0]?.started).toBe(true);
  });

  it('applies a start interval and rejects one outside 1 to 10 seconds', async () => {
    const config = valueOf(
      await harness.router.handle('monitor.start', {
        connectionId: CONNECTION_ID,
        intervalMs: 5000,
      }),
    );
    expect(config).toMatchObject({ intervalMs: 5000 });
    const rejected = errorOf(
      await harness.router.handle('monitor.start', { connectionId: OTHER_ID, intervalMs: 500 }),
    );
    expect(rejected.code).toBe('VALIDATION');
  });

  it('refuses to start for a connection without a live client', async () => {
    const result = errorOf(
      await harness.router.handle('monitor.start', { connectionId: OTHER_ID }),
    );
    expect(result.code).toBe('NOT_CONNECTED');
    expect(harness.created).toHaveLength(0);
  });

  it('forwards samples and sampler errors as events', async () => {
    valueOf(await harness.router.handle('monitor.start', { connectionId: CONNECTION_ID }));
    const sampler = harness.created[0];
    const value = sample('2026-10-09T10:00:00.000Z');
    sampler?.emitSample(value);
    sampler?.emitError({ code: 'CONNECTION_FAILED', message: 'Server unreachable' });
    expect(harness.events).toEqual([
      { type: 'monitor:sample', connectionId: CONNECTION_ID, sample: value },
      {
        type: 'monitor:error',
        connectionId: CONNECTION_ID,
        error: { code: 'CONNECTION_FAILED', message: 'Server unreachable' },
      },
    ]);
  });

  it('returns buffered samples and filters them by sinceIso', async () => {
    valueOf(await harness.router.handle('monitor.start', { connectionId: CONNECTION_ID }));
    const sampler = harness.created[0];
    sampler?.emitSample(sample('2026-10-09T10:00:00.000Z'));
    sampler?.emitSample(sample('2026-10-09T10:00:02.000Z'));
    const all = valueOf(
      await harness.router.handle('monitor.samples', { connectionId: CONNECTION_ID }),
    ) as MonitorSample[];
    const later = valueOf(
      await harness.router.handle('monitor.samples', {
        connectionId: CONNECTION_ID,
        sinceIso: '2026-10-09T10:00:00.000Z',
      }),
    ) as MonitorSample[];
    expect(all).toHaveLength(2);
    expect(later.map((item) => item.at)).toEqual(['2026-10-09T10:00:02.000Z']);
  });

  it('changes the interval on the running sampler', async () => {
    valueOf(await harness.router.handle('monitor.start', { connectionId: CONNECTION_ID }));
    const config = valueOf(
      await harness.router.handle('monitor.setInterval', {
        connectionId: CONNECTION_ID,
        intervalMs: 10_000,
      }),
    );
    expect(config).toMatchObject({ intervalMs: 10_000 });
    expect(harness.created[0]?.intervals).toEqual([10_000]);
  });

  it('refuses setInterval when monitoring is not running', async () => {
    const result = errorOf(
      await harness.router.handle('monitor.setInterval', {
        connectionId: CONNECTION_ID,
        intervalMs: 1000,
      }),
    );
    expect(result.code).toBe('VALIDATION');
  });

  it('stops the sampler, stops forwarding and clears the buffer', async () => {
    valueOf(await harness.router.handle('monitor.start', { connectionId: CONNECTION_ID }));
    const sampler = harness.created[0];
    valueOf(await harness.router.handle('monitor.stop', { connectionId: CONNECTION_ID }));
    expect(sampler?.stopped).toBe(true);
    expect(sampler?.listenerCount()).toBe(0);
    sampler?.emitSample(sample('2026-10-09T10:00:04.000Z'));
    expect(harness.events).toHaveLength(0);
    expect(
      valueOf(await harness.router.handle('monitor.samples', { connectionId: CONNECTION_ID })),
    ).toEqual([]);
  });

  it('stops monitoring when the connection leaves the connected state', async () => {
    valueOf(await harness.router.handle('monitor.start', { connectionId: CONNECTION_ID }));
    harness.setStatus(CONNECTION_ID, { state: 'disconnected' });
    expect(harness.created[0]?.stopped).toBe(true);
  });

  it('stops every sampler when the vault locks', async () => {
    valueOf(await harness.router.handle('monitor.start', { connectionId: CONNECTION_ID }));
    harness.setStatus(OTHER_ID, CONNECTED);
    valueOf(await harness.router.handle('monitor.start', { connectionId: OTHER_ID }));
    valueOf(await harness.router.handle('vault.lock', undefined));
    expect(harness.created.map((item) => item.stopped)).toEqual([true, true]);
  });

  it('stops every sampler when the renderer resets, so a reload leaves no sampling behind', async () => {
    valueOf(await harness.router.handle('monitor.start', { connectionId: CONNECTION_ID }));
    harness.setStatus(OTHER_ID, CONNECTED);
    valueOf(await harness.router.handle('monitor.start', { connectionId: OTHER_ID }));
    harness.router.resetRenderer();
    expect(harness.created.map((item) => item.stopped)).toEqual([true, true]);
  });

  it('lists operations through the adapter and hides background threads by default', async () => {
    harness.operationRows.push(
      {
        opid: 10,
        active: true,
        op: 'query',
        ns: 'shop.orders',
        secs_running: 3,
        desc: 'conn5',
        client: '127.0.0.1:5555',
        planSummary: 'COLLSCAN',
      },
      { opid: 11, active: false, op: 'none', ns: '', desc: 'Checkpointer' },
    );
    const operations = valueOf(
      await harness.router.handle('monitor.operations', { connectionId: CONNECTION_ID }),
    ) as { opid: number; ns: string; planSummary?: string }[];
    expect(operations).toEqual([
      expect.objectContaining({ opid: 10, ns: 'shop.orders', planSummary: 'COLLSCAN' }),
    ]);
    const withSystem = valueOf(
      await harness.router.handle('monitor.operations', {
        connectionId: CONNECTION_ID,
        includeSystem: true,
      }),
    ) as unknown[];
    expect(withSystem).toHaveLength(2);
  });

  it('kills a real opid through killOp', async () => {
    valueOf(
      await harness.router.handle('monitor.killOperation', {
        connectionId: CONNECTION_ID,
        opid: 10,
      }),
    );
    expect(harness.commands).toEqual([{ killOp: 1, op: 10 }]);
  });

  it('rejects a synthetic idle opid with VALIDATION and sends nothing to the server', async () => {
    const result = errorOf(
      await harness.router.handle('monitor.killOperation', {
        connectionId: CONNECTION_ID,
        opid: 'conn:7',
      }),
    );
    expect(result.code).toBe('VALIDATION');
    expect(harness.commands).toEqual([]);
  });

  it('reports NOT_CONNECTED for operations on a disconnected connection', async () => {
    const result = errorOf(
      await harness.router.handle('monitor.operations', { connectionId: OTHER_ID }),
    );
    expect(result.code).toBe('NOT_CONNECTED');
  });
});
