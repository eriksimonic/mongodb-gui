import { describe, expect, it } from 'vitest';
import { AppErrorException, appError, toAppError } from './errors';

describe('appError', () => {
  it('builds an error without a detail key when none is given', () => {
    const error = appError('VALIDATION', 'Name is required');
    expect(error).toEqual({ code: 'VALIDATION', message: 'Name is required' });
    expect(Object.keys(error)).not.toContain('detail');
  });

  it('keeps the detail when one is given', () => {
    expect(appError('COMMAND_FAILED', 'Query failed', 'bad operator')).toEqual({
      code: 'COMMAND_FAILED',
      message: 'Query failed',
      detail: 'bad operator',
    });
  });
});

describe('AppErrorException', () => {
  it('carries the AppError and uses its message', () => {
    const payload = appError('NOT_CONNECTED', 'Not connected');
    const exception = new AppErrorException(payload);
    expect(exception).toBeInstanceOf(Error);
    expect(exception.message).toBe('Not connected');
    expect(exception.name).toBe('AppErrorException');
    expect(exception.error).toBe(payload);
  });
});

describe('toAppError', () => {
  it('returns the wrapped AppError from an AppErrorException unchanged', () => {
    const payload = appError('AUTH_FAILED', 'Bad credentials', 'user admin');
    expect(toAppError(new AppErrorException(payload))).toBe(payload);
  });

  it('maps a plain Error to INTERNAL with its message', () => {
    expect(toAppError(new Error('boom'))).toEqual({ code: 'INTERNAL', message: 'boom' });
  });

  it('maps other thrown values to INTERNAL with their string form', () => {
    expect(toAppError('plain text')).toEqual({ code: 'INTERNAL', message: 'plain text' });
    expect(toAppError(42)).toEqual({ code: 'INTERNAL', message: '42' });
    expect(toAppError(undefined)).toEqual({ code: 'INTERNAL', message: 'undefined' });
  });
});
