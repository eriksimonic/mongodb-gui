import { MongoOperationTimeoutError, type MongoClient } from 'mongodb';
import { describe, expect, it } from 'vitest';
import { getReplicaSetConfig, getReplicaSetStatus, getSelfHost, isReplicaSet } from './status';

interface CommandOptions {
  timeoutMS?: number;
}

type Command = (document: Record<string, unknown>, options?: CommandOptions) => Promise<unknown>;
type OplogRead = (options?: CommandOptions) => Promise<unknown[]>;

// A command that never answers unless it has a timeoutMS. The driver fails a command that outlives
// its timeoutMS.
function silentUnlessBounded(options?: CommandOptions): Promise<never> {
  if (options?.timeoutMS === undefined) {
    return new Promise<never>(() => undefined);
  }
  return Promise.reject(new MongoOperationTimeoutError('Operation timed out'));
}

// Minimal stand-in for the parts of MongoClient the status reads touch. oplogRead answers the oplog
// find and receives the options the status read passed to it.
function fakeClient(command: Command, oplogRead: OplogRead): MongoClient {
  const database = {
    command: (document: Record<string, unknown>, options?: CommandOptions) =>
      command(document, options),
    collection: () => ({
      find: (_filter: unknown, options?: CommandOptions) => ({
        sort: () => ({ limit: () => ({ toArray: () => oplogRead(options) }) }),
      }),
    }),
  };
  const client = { options: { serverSelectionTimeoutMS: 10_000 }, db: () => database };
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

describe('replication status reads', () => {
  it.each([
    ['getReplicaSetConfig', getReplicaSetConfig],
    ['getReplicaSetStatus', getReplicaSetStatus],
    ['isReplicaSet', isReplicaSet],
    ['getSelfHost', getSelfHost],
  ])('%s ends with an error when the server never answers', async (_name, read) => {
    const client = fakeClient(
      (_document, options) => silentUnlessBounded(options),
      silentUnlessBounded,
    );

    expect(await outcomeWithin(read(client), 1000)).toBe('rejected');
  });

  it('bounds the oplog reads, so a silent oplog cannot hold the status', async () => {
    const oplogBounds: Array<number | undefined> = [];
    // The status and config replies are empty, so the status is refused once the reads return.
    const client = fakeClient(
      () => Promise.resolve({}),
      (options) => {
        oplogBounds.push(options?.timeoutMS);
        return silentUnlessBounded(options);
      },
    );

    expect(await outcomeWithin(getReplicaSetStatus(client), 1000)).not.toBe('pending');
    expect(oplogBounds.length).toBeGreaterThan(0);
    expect(oplogBounds.every((bound) => bound !== undefined)).toBe(true);
  });
});
