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

describe('AppErrorSchema codeName', () => {
  const base = { code: 'COMMAND_FAILED', message: 'The server rejected the command' };

  it('accepts a plain server error name', () => {
    expect(AppErrorSchema.safeParse({ ...base, codeName: 'NotYetInitialized' }).success).toBe(true);
  });

  it('refuses a name that could carry a message or a URI', () => {
    for (const codeName of [
      'bad name',
      'mongodb://u:p@h:1',
      'x'.repeat(65),
      '',
      'Name:with:colons',
    ]) {
      expect(AppErrorSchema.safeParse({ ...base, codeName }).success, codeName).toBe(false);
    }
  });
});
