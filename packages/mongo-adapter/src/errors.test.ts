import { describe, expect, it } from 'vitest';
import {
  MongoNetworkError,
  MongoNetworkTimeoutError,
  MongoServerError,
  MongoServerSelectionError,
  type TopologyDescription,
} from 'mongodb';
import { AppErrorException, appError } from '@mongo-gui/core';
import { mapDriverError } from './errors';

function serverError(code: number, codeName: string): MongoServerError {
  return new MongoServerError({ message: 'driver says no', code, codeName });
}

function withCode(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

function selectionError(message: string, serverErrors: Error[] = []): MongoServerSelectionError {
  const servers = new Map(
    serverErrors.map((error, index) => [`host${index}:27017`, { error }] as const),
  );
  return new MongoServerSelectionError(message, { servers } as unknown as TopologyDescription);
}

describe('mapDriverError', () => {
  it('maps a server selection timeout with no server errors to CONNECTION_TIMEOUT', () => {
    const error = selectionError('Server selection timed out after 2000 ms');
    expect(mapDriverError(error)).toEqual({
      code: 'CONNECTION_TIMEOUT',
      message: 'Connection timed out',
      detail: 'Server selection timed out after 2000 ms',
    });
  });

  it('maps a socket timeout reported by a server to CONNECTION_TIMEOUT', () => {
    const error = selectionError('Server selection timed out after 2000 ms', [
      withCode('connect ETIMEDOUT 10.255.255.1:27017', 'ETIMEDOUT'),
    ]);
    expect(mapDriverError(error).code).toBe('CONNECTION_TIMEOUT');
  });

  it('maps a network timeout to CONNECTION_TIMEOUT', () => {
    const error = new MongoNetworkTimeoutError('connection timed out');
    expect(mapDriverError(error).code).toBe('CONNECTION_TIMEOUT');
  });

  it('maps a refused connection reported by a server to CONNECTION_FAILED exactly', () => {
    const error = selectionError('Server selection timed out after 2000 ms', [
      withCode('connect ECONNREFUSED 127.0.0.1:1', 'ECONNREFUSED'),
    ]);
    expect(mapDriverError(error).code).toBe('CONNECTION_FAILED');
  });

  it('finds a refused connection in the cause of a network error', () => {
    const cause = withCode('connect ECONNREFUSED 127.0.0.1:1', 'ECONNREFUSED');
    const error = new MongoNetworkError('connection failed', { cause });
    expect(mapDriverError(error).code).toBe('CONNECTION_FAILED');
  });

  it('gives refusal priority over a timeout in the same failure', () => {
    const error = selectionError('Server selection timed out after 2000 ms', [
      withCode('connect ECONNREFUSED 127.0.0.1:1', 'ECONNREFUSED'),
      withCode('connect ETIMEDOUT 10.0.0.1:27017', 'ETIMEDOUT'),
    ]);
    expect(mapDriverError(error).code).toBe('CONNECTION_FAILED');
  });

  it('maps a network error without refusal or timeout to CONNECTION_FAILED', () => {
    const error = new MongoNetworkError('socket closed');
    expect(mapDriverError(error).code).toBe('CONNECTION_FAILED');
  });

  it('maps error code 18 to AUTH_FAILED', () => {
    const error = serverError(18, 'AuthenticationFailed');
    expect(mapDriverError(error)).toEqual({
      code: 'AUTH_FAILED',
      message: 'Authentication failed',
      detail: 'driver says no',
    });
  });

  it('maps the AuthenticationFailed code name to AUTH_FAILED even without code 18', () => {
    const error = serverError(99, 'AuthenticationFailed');
    expect(mapDriverError(error).code).toBe('AUTH_FAILED');
  });

  it('maps other server errors to CONNECTION_FAILED', () => {
    const error = serverError(13, 'Unauthorized');
    expect(mapDriverError(error).code).toBe('CONNECTION_FAILED');
  });

  it('redacts a connection string that appears in the driver message', () => {
    const error = new Error('Invalid URI mongodb://admin:secret@db.example.com/app');
    const mapped = mapDriverError(error);
    expect(mapped.code).toBe('CONNECTION_FAILED');
    expect(mapped.detail).toBe('Invalid URI mongodb://admin:***@db.example.com/app');
    expect(JSON.stringify(mapped)).not.toContain('secret');
  });

  it('omits detail for an error with an empty message', () => {
    expect(Object.keys(mapDriverError(new Error('')))).not.toContain('detail');
  });

  it('omits detail for a non-Error value', () => {
    expect(mapDriverError('boom')).toEqual({
      code: 'CONNECTION_FAILED',
      message: 'Could not connect to the server',
    });
  });

  it('passes an AppErrorException through unchanged', () => {
    const payload = appError('NOT_CONNECTED', 'Not connected');
    expect(mapDriverError(new AppErrorException(payload))).toBe(payload);
  });
});
