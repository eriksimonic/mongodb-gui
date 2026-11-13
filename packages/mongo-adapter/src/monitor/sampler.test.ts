import { MongoOperationTimeoutError, type MongoClient } from 'mongodb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MonitorSample } from '@mongo-gui/core';
import { Sampler } from './sampler';

interface CommandOptions {
  timeoutMS?: number;
}

type Handler = (command: Record<string, unknown>, options?: CommandOptions) => Promise<unknown>;

const INTERVAL_MS = 1000;
const SERVER_SELECTION_TIMEOUT_MS = 10_000;

// Minimal stand-in for the parts of MongoClient the sampler touches. oplogRead answers the oplog
// find, and receives the options the sampler passed to find.
function stubClient(
  handler: Handler,
  oplogRead: (options?: CommandOptions) => Promise<unknown[]> = () => Promise.resolve([]),
): { client: MongoClient; calls: Record<string, unknown>[] } {
  const calls: Record<string, unknown>[] = [];
  const admin = {
    command: (command: Record<string, unknown>, options?: CommandOptions) => {
      calls.push(command);
      return handler(command, options);
    },
  };
  const local = {
    collection: () => ({
      find: (_filter: unknown, options?: CommandOptions) => ({
        sort: () => ({ limit: () => ({ toArray: () => oplogRead(options) }) }),
      }),
    }),
  };
  const client = {
    options: { serverSelectionTimeoutMS: SERVER_SELECTION_TIMEOUT_MS },
    db: (name: string) => (name === 'local' ? local : admin),
  };
  return { client: client as unknown as MongoClient, calls };
}

// A server that never answers. A command with a timeoutMS fails the way the driver fails it.
function silentUnlessBounded(options?: CommandOptions): Promise<never> {
  if (options?.timeoutMS === undefined) {
    return new Promise<never>(() => undefined);
  }
  return Promise.reject(new MongoOperationTimeoutError('Operation timed out'));
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

  it('ends a hung sampling command with an error and schedules the next tick', async () => {
    const { client } = stubClient((_command, options) => silentUnlessBounded(options));
    const sampler = new Sampler({ client, config: config() });
    let errors = 0;
    sampler.onError(() => {
      errors += 1;
    });

    // The first tick fails at 0 s, then the ticks at 1 s and 2 s fail the same way.
    sampler.start();
    await vi.advanceTimersByTimeAsync(2 * INTERVAL_MS);
    expect(errors).toBe(3);
    expect(sampler.isRunning()).toBe(true);

    sampler.stop();
  });

  it('ends a hung oplog read and still records the sample', async () => {
    const { client } = stubClient(
      (command) =>
        'hello' in command
          ? Promise.resolve({ setName: 'rs0' })
          : Promise.resolve(command.serverStatus === undefined ? {} : serverStatus(0)),
      silentUnlessBounded,
    );
    const sampler = new Sampler({ client, config: config() });

    // The oplog window is left out of each sample, and the samples keep coming every second.
    sampler.start();
    await vi.advanceTimersByTimeAsync(2 * INTERVAL_MS);
    expect(sampler.samples()).toHaveLength(3);

    sampler.stop();
  });
});
