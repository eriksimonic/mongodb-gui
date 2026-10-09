import { appError, redactUri, toAppError, type AppError } from '@mongo-gui/core';
import { mapDriverError } from '@mongo-gui/mongo-adapter';

const EMBEDDED_URI = /mongodb(?:\+srv)?:\/\/\S+/gi;
const AUTH_FAILED_CODE = 18;
const CONNECTION_ERROR_NAMES: ReadonlySet<string> = new Set([
  'MongoNetworkError',
  'MongoNetworkTimeoutError',
  'MongoServerSelectionError',
]);
const SCRIPT_ERROR_NAMES: ReadonlySet<string> = new Set([
  'SyntaxError',
  'ReferenceError',
  'TypeError',
  'RangeError',
]);

// Masks credentials in any URI that appears in free text, such as a driver message.
export function redactText(text: string): string {
  return text.replace(EMBEDDED_URI, (uri) => redactUri(uri));
}

// Errors from evaluating user code. A server command failure is COMMAND_FAILED, a parse or
// runtime error in the script is VALIDATION, and a lost connection maps through mapDriverError.
export function toEvaluationError(error: unknown): AppError {
  const name = errorName(error);
  if (error instanceof Error && name === 'MongoServerError') {
    return withMessage('COMMAND_FAILED', error.message);
  }
  if (name !== undefined && CONNECTION_ERROR_NAMES.has(name)) {
    return redactAppError(mapDriverError(error));
  }
  if (
    error instanceof Error &&
    (SCRIPT_ERROR_NAMES.has(error.name) || error.name.startsWith('Mongosh'))
  ) {
    return withMessage('VALIDATION', error.message);
  }
  return redactAppError(toAppError(error));
}

// Errors from opening the connection. Authentication failures are reported as AUTH_FAILED even
// when the driver error class does not match the one mapDriverError checks.
export function toConnectError(error: unknown): AppError {
  if (
    error instanceof Error &&
    errorName(error) === 'MongoServerError' &&
    errorCode(error) === AUTH_FAILED_CODE
  ) {
    return redactAppError(
      appError('AUTH_FAILED', 'Authentication failed', firstLine(error.message)),
    );
  }
  return redactAppError(mapDriverError(error));
}

// A mongosh syntax error carries a code frame after the first line. The first line is the
// message and the rest becomes the detail.
function withMessage(code: 'COMMAND_FAILED' | 'VALIDATION', text: string): AppError {
  const redacted = redactText(text);
  const detail = redacted.split('\n').slice(1).join('\n').trim();
  const message = firstLine(redacted);
  return detail === '' ? appError(code, message) : appError(code, message, detail);
}

export function redactAppError(error: AppError): AppError {
  const next: AppError = { code: error.code, message: redactText(error.message) };
  if (error.detail !== undefined) {
    next.detail = redactText(error.detail);
  }
  if (error.cause !== undefined) {
    next.cause = redactText(error.cause);
  }
  return next;
}

function errorName(error: unknown): string | undefined {
  return error instanceof Error ? error.name : undefined;
}

function errorCode(error: Error): unknown {
  return 'code' in error ? error.code : undefined;
}

function firstLine(text: string): string {
  return text.split('\n')[0] ?? '';
}
