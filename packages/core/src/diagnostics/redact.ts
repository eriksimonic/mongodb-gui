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

/** The longest text a parameter value or a raw log line may carry before it is cut short. */
export const MAX_DIAGNOSTIC_TEXT_LENGTH = 65536;

const TRUNCATION_MARK = ' [truncated]';

/** The text, cut to the cap with a marker when it is longer. */
export function capDiagnosticText(text: string): {
  readonly text: string;
  readonly truncated: boolean;
} {
  if (text.length <= MAX_DIAGNOSTIC_TEXT_LENGTH) {
    return { text, truncated: false };
  }
  return { text: text.slice(0, MAX_DIAGNOSTIC_TEXT_LENGTH) + TRUNCATION_MARK, truncated: true };
}

/**
 * A raw log line with its secrets masked. A JSON line is parsed and masked by key, so a password
 * attribute stays hidden. Any other line only has its URIs redacted.
 */
export function redactRawLine(raw: string): string {
  try {
    const value: unknown = JSON.parse(raw);
    if (isPlainObject(value)) {
      return JSON.stringify(redactDiagnosticRecord(value));
    }
  } catch {
    // Not JSON. The text fallback below still applies.
  }
  return redactUriText(raw);
}

// mongod flags whose values are secrets, in addition to any flag whose name matches the patterns.
const SECRET_FLAGS: ReadonlySet<string> = new Set(
  [
    'tlsCertificateKeyFilePassword',
    'tlsClusterPassword',
    'sslPEMKeyPassword',
    'sslClusterPassword',
    'ldapQueryPassword',
    'ldapBindPassword',
    'kmipClientCertificatePassword',
  ].map((name) => name.toLowerCase()),
);
const SECRET_FLAG_PATTERN = /password|passwd|secret|token/i;
const KEY_FLAG_PATTERN = /key/i;
const FILE_FLAG_PATTERN = /file|path|dir/i;

/** True when a command line flag, without its dashes, names a secret. Key file paths are kept. */
export function isSecretFlag(name: string): boolean {
  const lower = name.toLowerCase();
  if (SECRET_FLAGS.has(lower) || SECRET_FLAG_PATTERN.test(name)) {
    return true;
  }
  return KEY_FLAG_PATTERN.test(name) && !FILE_FLAG_PATTERN.test(name);
}

/**
 * The command line with secret values masked. A secret flag hides the next argument, as in
 * "--flag value", or the text after "=", as in "--flag=value". URIs are redacted everywhere.
 */
export function redactArgv(argv: readonly string[]): string[] {
  const out: string[] = [];
  let maskNext = false;
  for (const arg of argv) {
    if (maskNext) {
      out.push(MASK);
      maskNext = false;
      continue;
    }
    const flag = /^--?([^=]+)(=.*)?$/.exec(arg);
    if (flag === null || flag[1] === undefined) {
      out.push(redactUriText(arg));
      continue;
    }
    const name = flag[1];
    const hasValue = flag[2] !== undefined;
    if (isSecretFlag(name)) {
      if (hasValue) {
        out.push(`${arg.slice(0, arg.indexOf('=') + 1)}${MASK}`);
      } else {
        out.push(arg);
        maskNext = true;
      }
      continue;
    }
    out.push(redactUriText(arg));
  }
  return out;
}
