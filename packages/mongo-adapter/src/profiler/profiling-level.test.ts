import { describe, expect, it } from 'vitest';
import { outcomeWithin, silentClient } from '../test/silent-server';
import { getProfilingLevel } from './profiler';

describe('getProfilingLevel', () => {
  it('ends with an error when the server never answers', async () => {
    expect(await outcomeWithin(getProfilingLevel(silentClient(), 'shop'), 1000)).toBe('rejected');
  });
});
