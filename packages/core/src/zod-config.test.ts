import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import './zod-config';

describe('zod configuration', () => {
  it('turns off the eval fast path so a strict CSP sees no eval attempt', () => {
    expect(z.config().jitless).toBe(true);
  });

  it('still parses with the fast path off', () => {
    const schema = z.object({ name: z.string(), count: z.number().int() });
    expect(schema.safeParse({ name: 'orders', count: 2 }).success).toBe(true);
    expect(schema.safeParse({ name: 'orders', count: 2.5 }).success).toBe(false);
  });
});
