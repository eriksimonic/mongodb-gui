import { MongoOperationTimeoutError, type MongoClient } from 'mongodb';
import { describe, expect, it } from 'vitest';
import { silentClient, outcomeWithin, type CommandOptions } from '../test/silent-server';

import { killOperation, listOperations } from './operations';

// Resolves to rows after ms, the way a listing that runs longer than the bound would.
function slowRows(rows: unknown[], ms: number): Promise<unknown[]> {
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve(rows);
    }, ms);
  });
}

describe('monitor operations', () => {
  it('ends killOperation with an error when the server never answers', async () => {
    expect(await outcomeWithin(killOperation(silentClient(), 1), 1000)).toBe('rejected');
  });

  it('does not cut off the $currentOp listing, which can run longer than the bound', async () => {
    const row = { opid: 7, active: true, op: 'query', ns: 'shop.orders', desc: 'conn1' };
    // The driver ends a cursor that outlives its timeoutMS. The listing takes 50 ms here, so a bound
    // on the aggregate fails it.
    const client = {
      options: { serverSelectionTimeoutMS: 10_000 },
      db: () => ({
        aggregate: (_pipeline: unknown[], options?: CommandOptions) => ({
          toArray: () =>
            options?.timeoutMS === undefined
              ? slowRows([row], 50)
              : Promise.reject(new MongoOperationTimeoutError('Operation timed out')),
        }),
      }),
    } as unknown as MongoClient;

    expect(await listOperations(client)).toMatchObject([{ opid: 7 }]);
  });
});
