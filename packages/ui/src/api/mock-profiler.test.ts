import { describe, expect, it } from 'vitest';
import { AppErrorException, groupByShape, type RpcEvent } from '@mongo-gui/core';
import { localConnectionId } from './mock-fixtures';
import { createMockUiApi } from './mock-rpc-client';

const SHOP = { connectionId: localConnectionId, database: 'shop' };
const ANALYTICS = { connectionId: localConnectionId, database: 'analytics' };

function failureCode(error: unknown): string | undefined {
  return error instanceof AppErrorException ? error.error.code : undefined;
}

/** Resolves with the error code of a call that must fail. Fails the test when it succeeds. */
async function codeOf(attempt: Promise<unknown>): Promise<string | undefined> {
  try {
    await attempt;
  } catch (error) {
    return failureCode(error);
  }
  throw new Error('expected the call to fail');
}

async function connected() {
  const api = createMockUiApi({ preset: 'unlocked' });
  await api.rpc.connections.connect({ id: localConnectionId });
  return api;
}

describe('mock profiler', () => {
  it('starts shop and analytics at level 1 and logs at level 0', async () => {
    const api = await connected();
    expect(await api.rpc.profiler.level(SHOP)).toEqual({
      level: 1,
      slowMs: 100,
      sampleRate: 1,
    });
    expect((await api.rpc.profiler.level({ ...SHOP, database: 'logs' })).level).toBe(0);
  });

  it('stores the level it is given, with the threshold for level 1 only', async () => {
    const api = await connected();
    const set = await api.rpc.profiler.setLevel({ ...SHOP, level: 1, slowMs: 250 });
    expect(set).toEqual({ level: 1, slowMs: 250, sampleRate: 1 });
    expect(await api.rpc.profiler.setLevel({ ...SHOP, level: 2 })).toEqual({
      level: 2,
      slowMs: 250,
    });
  });

  it('rejects a level outside 0 to 2 with a validation error', async () => {
    const api = await connected();
    const code = await codeOf(api.rpc.profiler.setLevel({ ...SHOP, level: 3 as 0 }));
    expect(code).toBe('VALIDATION');
  });

  it('refuses profiler calls while not connected', async () => {
    const api = createMockUiApi({ preset: 'unlocked' });
    const code = await codeOf(api.rpc.profiler.list({ ...SHOP, filter: {} }));
    expect(code).toBe('NOT_CONNECTED');
  });

  it('lists newest first and filters by namespace, operation and text', async () => {
    const api = await connected();
    const all = await api.rpc.profiler.list({ ...SHOP, filter: { limit: 200 } });
    expect(all.length).toBeGreaterThan(5);
    const times = all.map((entry) => entry.ts);
    expect([...times].sort().reverse()).toEqual(times);

    const orders = await api.rpc.profiler.list({
      ...SHOP,
      filter: { limit: 200, ns: 'shop.orders' },
    });
    expect(orders.every((entry) => entry.ns === 'shop.orders')).toBe(true);

    const updates = await api.rpc.profiler.list({
      ...SHOP,
      filter: { limit: 200, op: 'update' },
    });
    expect(updates.length).toBeGreaterThan(0);
    expect(updates.every((entry) => entry.op === 'update')).toBe(true);

    const limited = await api.rpc.profiler.list({ ...SHOP, filter: { limit: 3 } });
    expect(limited).toHaveLength(3);
  });

  it('groups the rows into shapes with the real grouping of core', async () => {
    const api = await connected();
    const filter = { limit: 200 };
    const rows = await api.rpc.profiler.list({ ...SHOP, filter });
    const shapes = await api.rpc.profiler.shapes({ ...SHOP, filter });
    expect(shapes).toEqual(groupByShape(rows));
    expect(shapes.reduce((sum, shape) => sum + shape.count, 0)).toBe(rows.length);
  });

  it('keeps fixture rows with an error message', async () => {
    const api = await connected();
    const rows = await api.rpc.profiler.list({ ...ANALYTICS, filter: { limit: 200 } });
    expect(rows.some((entry) => entry.errMsg !== undefined)).toBe(true);
  });

  it('reports the size and count of system.profile', async () => {
    const api = await connected();
    const info = await api.rpc.profiler.info(SHOP);
    expect(info.exists).toBe(true);
    expect(info.count).toBeGreaterThan(0);
  });

  it('delivers one new entry per tail poll while the level is above 0, then stops', async () => {
    const api = await connected();
    const batches: number[] = [];
    const unsubscribe = api.onEvent((event: RpcEvent) => {
      if (event.type === 'profiler:entries') {
        batches.push(event.entries.length);
      }
    });
    try {
      await api.rpc.profiler.tail({ ...SHOP, enabled: true, pollMs: 50 });
      await waitFor(() => batches.length >= 2);
      await api.rpc.profiler.tail({ ...SHOP, enabled: false });
      const settled = batches.length;
      await delay(150);
      expect(batches.length).toBe(settled);
      expect(batches.every((size) => size === 1)).toBe(true);
    } finally {
      unsubscribe();
    }
  });
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error('condition not met in time');
    }
    await delay(10);
  }
}
