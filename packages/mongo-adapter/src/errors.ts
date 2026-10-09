import { MongoNetworkTimeoutError, MongoServerError, MongoServerSelectionError } from 'mongodb';
import { AppErrorException, appError, redactUri, type AppError } from '@mongo-gui/core';
import { readField } from './documents';

const AUTH_FAILED_CODE = 18;
const REFUSED_CODE = 'ECONNREFUSED';
const SOCKET_TIMEOUT_CODE = 'ETIMEDOUT';
const EMBEDDED_URI = /mongodb(?:\+srv)?:\/\/\S+/gi;
const MAX_CAUSE_DEPTH = 10;

export function mapDriverError(error: unknown): AppError {
  if (error instanceof AppErrorException) {
    return error.error;
  }
  const detail = driverDetail(error);
  const serverErrors = readServerErrors(error);
  const failures = [...causeChain(error), ...serverErrors.flatMap(causeChain)];
  if (failures.some(isAuthFailure)) {
    return appError('AUTH_FAILED', 'Authentication failed', detail);
  }
  if (failures.some(isRefused)) {
    return appError('CONNECTION_FAILED', 'Could not connect to the server', detail);
  }
  if (isTimeout(error, serverErrors)) {
    return appError('CONNECTION_TIMEOUT', 'Connection timed out', detail);
  }
  // A server reply that is not an auth failure means the server answered and refused the command.
  if (error instanceof MongoServerError) {
    return appError('COMMAND_FAILED', 'The server rejected the command', detail);
  }
  return appError('CONNECTION_FAILED', 'Could not connect to the server', detail);
}

function driverDetail(error: unknown): string | undefined {
  if (!(error instanceof Error) || error.message === '') {
    return undefined;
  }
  return error.message.replace(EMBEDDED_URI, (uri) => redactUri(uri));
}

function isAuthFailure(failure: unknown): boolean {
  return (
    failure instanceof MongoServerError &&
    (failure.code === AUTH_FAILED_CODE || failure.codeName === 'AuthenticationFailed')
  );
}

function isRefused(failure: unknown): boolean {
  return readField(failure, 'code') === REFUSED_CODE;
}

function isSocketTimeout(failure: unknown): boolean {
  return (
    failure instanceof MongoNetworkTimeoutError ||
    readField(failure, 'code') === SOCKET_TIMEOUT_CODE
  );
}

// A selection error is a timeout when every server failed by timing out, or when no server
// reported a failure at all. Any other server failure (DNS, TLS, and so on) is a plain failure.
function isTimeout(error: unknown, serverErrors: unknown[]): boolean {
  if (causeChain(error).some(isSocketTimeout)) {
    return true;
  }
  if (!(error instanceof MongoServerSelectionError)) {
    return false;
  }
  return serverErrors.every((server) => causeChain(server).some(isSocketTimeout));
}

function readServerErrors(error: unknown): unknown[] {
  const servers = readField(readField(error, 'reason'), 'servers');
  if (!(servers instanceof Map)) {
    return [];
  }
  return [...servers.values()]
    .map((server: unknown) => readField(server, 'error'))
    .filter((value) => value !== undefined && value !== null);
}

function causeChain(value: unknown): unknown[] {
  const chain: unknown[] = [];
  let current: unknown = value;
  for (
    let depth = 0;
    depth < MAX_CAUSE_DEPTH && current !== undefined && current !== null;
    depth++
  ) {
    chain.push(current);
    current = readField(current, 'cause');
  }
  return chain;
}
