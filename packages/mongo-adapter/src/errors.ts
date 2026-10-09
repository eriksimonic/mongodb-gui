import { MongoNetworkTimeoutError, MongoServerError, MongoServerSelectionError } from 'mongodb';
import { AppErrorException, appError, redactUri, type AppError } from '@mongo-gui/core';

const AUTH_FAILED_CODE = 18;
const EMBEDDED_URI = /mongodb(?:\+srv)?:\/\/\S+/gi;

export function mapDriverError(error: unknown): AppError {
  if (error instanceof AppErrorException) {
    return error.error;
  }
  const detail = driverDetail(error);
  if (isTimeout(error)) {
    return appError('CONNECTION_TIMEOUT', 'Connection timed out', detail);
  }
  if (isAuthFailure(error)) {
    return appError('AUTH_FAILED', 'Authentication failed', detail);
  }
  return appError('CONNECTION_FAILED', 'Could not connect to the server', detail);
}

function driverDetail(error: unknown): string | undefined {
  if (!(error instanceof Error) || error.message === '') {
    return undefined;
  }
  return error.message.replace(EMBEDDED_URI, (uri) => redactUri(uri));
}

function isTimeout(error: unknown): boolean {
  if (error instanceof MongoNetworkTimeoutError) {
    return true;
  }
  return error instanceof MongoServerSelectionError && /timed out/i.test(error.message);
}

function isAuthFailure(error: unknown): boolean {
  return (
    error instanceof MongoServerError &&
    (error.code === AUTH_FAILED_CODE || error.codeName === 'AuthenticationFailed')
  );
}
