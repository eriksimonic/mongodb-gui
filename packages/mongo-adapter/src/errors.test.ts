import { describe, expect, it } from 'vitest';
import {
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

function selectionError(message: string): MongoServerSelectionError {
  return new MongoServerSelectionError(message, {} as TopologyDescription);
}

describe('mapDriverError', () => {
  it('maps a server selection timeout to CONNECTION_TIMEOUT', () => {
    const error = selectionError('Server selection timed out after 2000 ms');
    expect(mapDriverError(error)).toEqual({
      code: 'CONNECTION_TIMEOUT',
      message: 'Connection timed out',
      detail: 'Server selection timed out after 2000 ms',
    });
  });

  it('maps a network timeout to CONNECTION_TIMEOUT', () => {
    const error = new MongoNetworkTimeoutError('connection timed out');
    expect(mapDriverError(error).code).toBe('CONNECTION_TIMEOUT');
  });

  it('maps a server selection failure without a timeout to CONNECTION_FAILED', () => {
    const error = selectionError('connect ECONNREFUSED 127.0.0.1:1');
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
