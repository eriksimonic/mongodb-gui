import { AppErrorException, type AppErrorCode } from '@mongo-gui/core';
import { describe, expect, it } from 'vitest';
import { parseInput, parseStored, type PayloadSchema } from './validation';

const accepting: PayloadSchema<number> = {
  safeParse: (data) => (typeof data === 'number' ? { success: true, data } : { success: false }),
};

function codeOf(action: () => unknown): AppErrorCode | undefined {
  try {
    action();
    return undefined;
  } catch (error) {
    return error instanceof AppErrorException ? error.error.code : undefined;
  }
}

describe('parseInput', () => {
  it('returns the parsed value when it matches', () => {
    expect(parseInput(accepting, 4, 'number')).toBe(4);
  });

  it('throws VALIDATION and names the input kind without echoing the value', () => {
    let caught: unknown;
    try {
      parseInput(accepting, 'secret-value', 'connection');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AppErrorException);
    expect(caught).toMatchObject({
      error: { code: 'VALIDATION', message: 'The connection is invalid.' },
    });
    expect(JSON.stringify(caught)).not.toContain('secret-value');
  });
});

describe('parseStored', () => {
  it('returns the parsed value when it matches', () => {
    expect(parseStored(accepting, 7, 'number')).toBe(7);
  });

  it('throws INTERNAL when the stored value does not match', () => {
    expect(codeOf(() => parseStored(accepting, 'text', 'number'))).toBe('INTERNAL');
  });
});
