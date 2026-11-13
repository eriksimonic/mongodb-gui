import { describe, expect, it } from 'vitest';
import { outcomeWithin, silentClient } from '../test/silent-server';
import { connectionStatus } from './current';

describe('connectionStatus', () => {
  it('ends with an error when the server never answers', async () => {
    expect(await outcomeWithin(connectionStatus(silentClient()), 1000)).toBe('rejected');
  });
});
