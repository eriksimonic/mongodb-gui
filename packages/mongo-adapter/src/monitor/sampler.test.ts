import type { MongoClient } from 'mongodb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MonitorSample } from '@mongo-gui/core';
import { Sampler } from './sampler';

type Handler = (command: Record<string, unknown>) => Promise<unknown>;

const INTERVAL_MS = 1000;

// Minimal stand-in for the parts of MongoClient the sampler touches.
function stubClient(handler: Handler): { client: MongoClient; calls: Record<string, unknown>[] } {
  const calls: Record<string, unknown>[] = [];
  const admin = {
    command: (command: Record<string, unknown>) => {
      calls.push(command);
      return handler(command);
    },
  };
  const local = {
    collection: () => ({
      find: () => ({
        sort: () => ({ limit: () => ({ toArray: () => Promise.resolve([]) }) }),
      }),
    }),
  };
  const client = { db: (name: string) => (name === 'local' ? local : admin) };
  return { client: client as unknown as MongoClient, calls };
}

function serverStatus(insert: number): unknown {
  return {
    uptime: 100,
    opcounters: { insert, query: 0, update: 0, delete: 0, getmore: 0, command: 0 },
    connections: { current: 1, available: 100 },
    network: { bytesIn: 0, bytesOut: 0, numRequests: 0 },
    mem: { resident: 10, virtual: 20 },
  };
}

function serverStatusCalls(calls: Record<string, unknown>[]): number {
  return calls.filter((call) => 'serverStatus' in call).length;
}

function config() {
  return { intervalMs: INTERVAL_MS, retentionMs: 60_000 };
}

describe('Sampler scheduling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('backs off after five consecutive errors and keeps running', async () => {
    const { client } = stubClient((command) =>
      'serverStatus' in command ? Promise.reject(new Error('boom')) : Promise.resolve({}),
    );
    const sampler = new Sampler({ client, config: config() });
    let errors = 0;
    sampler.onError(() => {
      errors += 1;
    });

    sampler.start();
    await vi.advanceTimersByTimeAsync(4000);
    expect(errors).toBe(5);

    // The fifth error doubles the delay to 2 s, so the sixth attempt lands at 6 s.
    await vi.advanceTimersByTimeAsync(1999);
    expect(errors).toBe(5);
    await vi.advanceTimersByTimeAsync(1);
    expect(errors).toBe(6);

    // The sixth error quadruples the delay to 4 s, so the seventh attempt lands at 10 s.
    await vi.advanceTimersByTimeAsync(3999);
    expect(errors).toBe(6);
    await vi.advanceTimersByTimeAsync(1);
    expect(errors).toBe(7);
    expect(sampler.isRunning()).toBe(true);

    sampler.stop();
  });

  it('caps the backoff delay at 30 seconds', async () => {
    const { client } = stubClient((command) =>
      'serverStatus' in command ? Promise.reject(new Error('boom')) : Promise.resolve({}),
    );
    const sampler = new Sampler({ client, config: config() });
    let errors = 0;
    sampler.onError(() => {
      errors += 1;
    });

    sampler.start();
    // Errors at 0, 1, 2, 3 and 4 s, then delays of 2, 4, 8, 16 and then 30 s (capped).
    await vi.advanceTimersByTimeAsync(4000 + 2000 + 4000 + 8000 + 16000);
    const before = errors;
    await vi.advanceTimersByTimeAsync(29_999);
    expect(errors).toBe(before);
    await vi.advanceTimersByTimeAsync(1);
    expect(errors).toBe(before + 1);

    sampler.stop();
  });

  it('returns to the normal interval after a successful sample', async () => {
    let attempts = 0;
    const { client } = stubClient((command) => {
      if (!('serverStatus' in command)) {
        return Promise.resolve({});
      }
      attempts += 1;
      return attempts <= 5 ? Promise.reject(new Error('boom')) : Promise.resolve(serverStatus(0));
    });
    const sampler = new Sampler({ client, config: config() });

    sampler.start();
    await vi.advanceTimersByTimeAsync(4000);
    expect(sampler.samples()).toHaveLength(0);

    // The fifth error set a 2 s delay, so the sixth attempt succeeds at 6 s.
    await vi.advanceTimersByTimeAsync(1999);
    expect(sampler.samples()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(sampler.samples()).toHaveLength(1);

    // The success resets the delay to the 1 s interval, so samples follow each second.
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(sampler.samples()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(sampler.samples()).toHaveLength(3);

    sampler.stop();
  });

  it('schedules nothing when stopped while a tick is in flight', async () => {
    let release: (value: unknown) => void = () => undefined;
    const pending = new Promise<unknown>((resolve) => {
      release = resolve;
    });
    const { client, calls } = stubClient((command) =>
      'serverStatus' in command ? pending : Promise.resolve({}),
    );
    const sampler = new Sampler({ client, config: config() });

    sampler.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(serverStatusCalls(calls)).toBe(1);

    sampler.stop();
    release(serverStatus(0));
    await vi.advanceTimersByTimeAsync(10 * INTERVAL_MS);

    expect(serverStatusCalls(calls)).toBe(1);
    expect(sampler.isRunning()).toBe(false);
  });

  it('reschedules a pending tick when the interval changes', async () => {
    const { client, calls } = stubClient((command) =>
      'serverStatus' in command ? Promise.resolve(serverStatus(0)) : Promise.resolve({}),
    );
    const sampler = new Sampler({ client, config: config() });

    sampler.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(serverStatusCalls(calls)).toBe(1);

    // The next tick was due at 1 s. Moving to 5 s from now defers it to 5 s after the change.
    sampler.setInterval(5000);
    await vi.advanceTimersByTimeAsync(4999);
    expect(serverStatusCalls(calls)).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(serverStatusCalls(calls)).toBe(2);

    sampler.stop();
  });

  it('gives the first sample after a restart zero rates', async () => {
    let insert = 100;
    const { client } = stubClient((command) =>
      'serverStatus' in command ? Promise.resolve(serverStatus(insert)) : Promise.resolve({}),
    );
    const sampler = new Sampler({ client, config: config() });

    sampler.start();
    await vi.advanceTimersByTimeAsync(0);
    insert = 300;
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    const beforeRestart = sampler.samples();
    expect(beforeRestart.at(-1)?.opcounters.insert).toBe(200);

    sampler.stop();
    insert = 900;
    sampler.start();
    await vi.advanceTimersByTimeAsync(0);
    const restarted: MonitorSample | undefined = sampler.samples().at(-1);
    expect(restarted?.opcounters.insert).toBe(0);

    sampler.stop();
  });
});
