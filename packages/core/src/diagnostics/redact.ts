import { redactUri } from '../redact';

const URI_IN_TEXT = /mongodb(?:\+srv)?:\/\/[^\s"'<>]+/gi;

const MASK = '***';
// Field names whose values never leave the main process: passwords, key file contents and
// certificate contents.
const SECRET_KEY = /password|keyfilecontents?|certificatecontents?/i;

export function isSecretKey(key: string): boolean {
  return SECRET_KEY.test(key);
}

/** Redacts every MongoDB URI that appears inside a text, such as a log message. */
export function redactUriText(text: string): string {
  return text.replace(URI_IN_TEXT, (uri) => redactUri(uri));
}

/**
 * Masks secret-named fields and redacts the password in every string that is a MongoDB URI.
 * Other values pass through unchanged. Arrays and plain objects are copied, not edited.
 */
export function redactDiagnosticValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return redactUriText(value);
  }
  if (Array.isArray(value)) {
    return value.map((item: unknown) => redactDiagnosticValue(item));
  }
  if (isPlainObject(value)) {
    return redactDiagnosticRecord(value);
  }
  return value;
}

/** The record form of redactDiagnosticValue, for a value already known to be an object. */
export function redactDiagnosticRecord(value: DiagnosticRecord): DiagnosticRecord {
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      isSecretKey(key) && item !== null && item !== undefined ? MASK : redactDiagnosticValue(item),
    ]),
  );
}

type DiagnosticRecord = Record<string, unknown>;

function isPlainObject(value: unknown): value is DiagnosticRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
