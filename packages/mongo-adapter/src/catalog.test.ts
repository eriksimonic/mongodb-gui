import { describe, expect, it } from 'vitest';
import { listDatabases } from './catalog';
import { outcomeWithin, silentClient } from './test/silent-server';

describe('listDatabases', () => {
  it('ends with an error when the server never answers', async () => {
    expect(await outcomeWithin(listDatabases(silentClient()), 1000)).toBe('rejected');
  });
});
