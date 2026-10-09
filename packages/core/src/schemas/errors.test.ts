import { describe, expect, it } from 'vitest';
import { AppErrorSchema } from './errors';

describe('AppErrorSchema', () => {
  it('accepts an error with optional detail and cause', () => {
    const result = AppErrorSchema.safeParse({
      code: 'CONNECTION_TIMEOUT',
      message: 'Server selection timed out',
      detail: 'after 10000 ms',
      cause: 'ECONNREFUSED',
    });
    expect(result.success).toBe(true);
  });

  it('rejects an unknown error code', () => {
    const result = AppErrorSchema.safeParse({ code: 'SOMETHING_ELSE', message: 'nope' });
    expect(result.success).toBe(false);
  });
});
