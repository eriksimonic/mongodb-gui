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
  if (isAuthFailure(error)) {
    return appError('AUTH_FAILED', 'Authentication failed', detail);
  }
  const failures = collectFailures(error);
  if (failures.some(isRefused)) {
    return appError('CONNECTION_FAILED', 'Could not connect to the server', detail);
  }
  if (isTimeout(error, failures)) {
    return appError('CONNECTION_TIMEOUT', 'Connection timed out', detail);
  }
  return appError('CONNECTION_FAILED', 'Could not connect to the server', detail);
}

function driverDetail(error: unknown): string | undefined {
  if (!(error instanceof Error) || error.message === '') {
    return undefined;
  }
  return error.message.replace(EMBEDDED_URI, (uri) => redactUri(uri));
}

function isAuthFailure(error: unknown): boolean {
  return (
    error instanceof MongoServerError &&
    (error.code === AUTH_FAILED_CODE || error.codeName === 'AuthenticationFailed')
  );
}

function isTimeout(error: unknown, failures: unknown[]): boolean {
  // The driver throws MongoServerSelectionError only when serverSelectionTimeoutMS expires.
  if (error instanceof MongoServerSelectionError) {
    return true;
  }
  return error instanceof MongoNetworkTimeoutError || failures.some(isSocketTimeout);
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

// Collects the error, its cause chain and the errors each server reported during selection.
function collectFailures(error: unknown): unknown[] {
  const serverErrors = readServerErrors(error);
  return [...causeChain(error), ...serverErrors.flatMap(causeChain)];
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
