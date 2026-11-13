import { MongoOperationTimeoutError, type MongoClient } from 'mongodb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { freeze, stepDown } from './operations';

interface CommandOptions {
  timeoutMS?: number;
}

type Reply = (document: Record<string, unknown>, options?: CommandOptions) => Promise<unknown>;

// A command that never answers unless it has a timeoutMS. The driver fails a command that outlives
// its timeoutMS.
function silentUnlessBounded(options?: CommandOptions): Promise<never> {
  if (options?.timeoutMS === undefined) {
    return new Promise<never>(() => undefined);
  }
  return Promise.reject(new MongoOperationTimeoutError('Operation timed out'));
}

// Minimal stand-in for the admin database. Each command goes to reply.
function fakeClient(reply: Reply): MongoClient {
  const admin = {
    command: (document: Record<string, unknown>, options?: CommandOptions) =>
      reply(document, options),
  };
  const client = { options: { serverSelectionTimeoutMS: 10_000 }, db: () => admin };
  return client as unknown as MongoClient;
}

// Resolves to 'pending' when the promise has not settled after ms.
function outcomeWithin(
  promise: Promise<unknown>,
  ms: number,
): Promise<'pending' | 'resolved' | 'rejected'> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve('pending');
    }, ms);
    promise.then(
      () => {
        clearTimeout(timer);
        resolve('resolved');
      },
      () => {
        clearTimeout(timer);
        resolve('rejected');
      },
    );
  });
}

describe('replication operations', () => {
  it.each([
    [
      'freeze',
      () =>
        freeze(
          fakeClient((_document, options) => silentUnlessBounded(options)),
          5,
        ),
    ],
    [
      'stepDown',
      () =>
        stepDown(
          fakeClient((_document, options) => silentUnlessBounded(options)),
          {},
        ),
    ],
  ])('%s ends with an error when the server never answers', async (_name, run) => {
    expect(await outcomeWithin(run(), 1000)).toBe('rejected');
  });

  it('bounds replSetStepDown past its secondary catch-up wait', async () => {
    const bounds: Array<number | undefined> = [];
    const client = fakeClient((document, options) => {
      if ('hello' in document) {
        return Promise.resolve({ primary: 'a:27017' });
      }
      bounds.push(options?.timeoutMS);
      return Promise.reject(new MongoOperationTimeoutError('Operation timed out'));
    });

    // The server waits up to secondaryCatchUpPeriodSecs before it steps down, so the bound is that
    // wait plus the client's server selection timeout.
    await outcomeWithin(stepDown(client, { secondaryCatchUpSeconds: 30 }), 1000);

    expect(bounds).toEqual([30_000 + 10_000]);
  });
});

describe('stepDown: waiting for the new primary', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('ends the wait with an error when a hello never answers', async () => {
    let hellos = 0;
    const pollBounds: Array<number | undefined> = [];
    const client = fakeClient((document, options) => {
      if ('hello' in document) {
        hellos += 1;
        // The first hello reads the current primary. Later hellos are the new-primary poll.
        if (hellos === 1) {
          return Promise.resolve({ primary: 'a:27017' });
        }
        pollBounds.push(options?.timeoutMS);
        return silentUnlessBounded(options);
      }
      return Promise.resolve({ ok: 1 });
    });
    let outcome: unknown = 'pending';
    void stepDown(client, {}).then(
      () => {
        outcome = 'resolved';
      },
      (error: unknown) => {
        outcome = error;
      },
    );

    await vi.advanceTimersByTimeAsync(31_000);

    expect(outcome).not.toBe('pending');
    // Every poll carries a bound above zero. The driver reads a bound of 0 as no limit.
    expect(pollBounds.length).toBeGreaterThan(0);
    for (const bound of pollBounds) {
      expect(bound).toBeGreaterThan(0);
    }
  });
});
