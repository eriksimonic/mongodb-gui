import { MongoOperationTimeoutError, type MongoClient } from 'mongodb';

export interface CommandOptions {
  timeoutMS?: number;
}

// A command that never answers unless it has a timeoutMS. The driver fails a command that outlives
// its timeoutMS, so a bounded command gets that failure here.
export function silentUnlessBounded(options?: CommandOptions): Promise<never> {
  if (options?.timeoutMS === undefined) {
    return new Promise<never>(() => undefined);
  }
  return Promise.reject(new MongoOperationTimeoutError('Operation timed out'));
}

// A client whose every database command is silent unless it is bounded. The server selection
// timeout is the client's bound, so commandTimeoutMs reads 10 s from it.
export function silentClient(): MongoClient {
  const database = {
    command: (_document: Record<string, unknown>, options?: CommandOptions) =>
      silentUnlessBounded(options),
  };
  const client = { options: { serverSelectionTimeoutMS: 10_000 }, db: () => database };
  return client as unknown as MongoClient;
}

// Resolves to 'pending' when the promise has not settled after ms.
export function outcomeWithin(
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
