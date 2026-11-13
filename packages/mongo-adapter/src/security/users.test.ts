import { describe, expect, it } from 'vitest';
import { outcomeWithin, silentClient } from '../test/silent-server';
import { getUser, listUsers } from './users';

describe('user reads', () => {
  it.each([
    ['listUsers', () => listUsers(silentClient())],
    ['getUser', () => getUser(silentClient(), 'shop', 'ann')],
  ])('%s ends with an error when the server never answers', async (_name, run) => {
    expect(await outcomeWithin(run(), 1000)).toBe('rejected');
  });
});
