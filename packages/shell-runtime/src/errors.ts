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

export interface ErrorFields {
  name: string;
  message: string;
  code: unknown;
}

// Masks credentials in any URI that appears in free text, such as a driver message.
export function redactText(text: string): string {
  return text.replace(EMBEDDED_URI, (uri) => redactUri(uri));
}

// Reads name and message by duck typing. Errors thrown inside the mongosh vm context come from
// another realm, so "instanceof Error" is false for them.
export function errorFields(value: unknown): ErrorFields | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const name: unknown = Reflect.get(value, 'name');
  const message: unknown = Reflect.get(value, 'message');
  if (typeof name !== 'string' || typeof message !== 'string') {
    return undefined;
  }
  return { name, message, code: Reflect.get(value, 'code') };
}

// Errors from evaluating user code. A server command failure is COMMAND_FAILED, a parse or
// runtime error in the script is VALIDATION, and a lost connection maps through mapDriverError.
export function toEvaluationError(error: unknown): AppError {
  const fields = errorFields(error);
  if (fields !== undefined) {
    if (isRequireUnavailable(fields.message)) {
      return appError('VALIDATION', REQUIRE_UNAVAILABLE_MESSAGE);
    }
    if (fields.name === 'MongoServerError') {
      return withMessage('COMMAND_FAILED', fields.message);
    }
    if (CONNECTION_ERROR_NAMES.has(fields.name)) {
      return redactAppError(mapDriverError(error));
    }
    if (SCRIPT_ERROR_NAMES.has(fields.name) || fields.name.startsWith('Mongosh')) {
      return withMessage('VALIDATION', fields.message);
    }
  }
  return redactAppError(toAppError(error));
}

// The query editor has no module loader. A script that calls require gets this message, whichever
// way the runtime reports the missing binding (a ReferenceError, or the bundler's dynamic require
// stub).
const REQUIRE_UNAVAILABLE_MESSAGE = 'require is not available in the query editor';

function isRequireUnavailable(message: string): boolean {
  return /\brequire\b/.test(message) && /is not defined|dynamic(ally)? require/i.test(message);
}

// Errors from opening the connection. Authentication failures are reported as AUTH_FAILED even
// when the driver error class does not match the one mapDriverError checks.
export function toConnectError(error: unknown): AppError {
  const fields = errorFields(error);
  if (
    fields !== undefined &&
    fields.name === 'MongoServerError' &&
    fields.code === AUTH_FAILED_CODE
  ) {
    return redactAppError(
      appError('AUTH_FAILED', 'Authentication failed', firstLine(fields.message)),
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

function firstLine(text: string): string {
  return text.split('\n')[0] ?? '';
}
