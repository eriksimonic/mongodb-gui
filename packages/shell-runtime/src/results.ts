import { inspect } from 'node:util';
import { EJSON } from 'bson';

const INSPECT_DEPTH = 8;

// Canonical EJSON (relaxed: false) keeps ObjectId, Long, Decimal128, dates and binary intact.
// Values EJSON cannot encode (functions, for example) fall back to their string form.
export function serializePrintable(value: unknown): string {
  if (value === undefined) {
    return 'null';
  }
  const source = value instanceof Error ? { name: value.name, message: value.message } : value;
  try {
    const text = EJSON.stringify(source, { relaxed: false });
    if (text !== undefined) {
      return text;
    }
  } catch {
    // Fall through to the string form below.
  }
  return JSON.stringify(String(value));
}

// Text for one print or printjson call. Strings print bare, everything else prints the way the
// mongosh shell shows it.
export function formatPrintText(values: readonly unknown[]): string {
  return values.map(formatOne).join(' ');
}

function formatOne(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  return inspect(value, { depth: INSPECT_DEPTH, breakLength: Infinity });
}

// A cursor result carries cursorHasMore, which the mongosh runtime sets to false once the cursor
// is exhausted. Any other result has no more pages.
export function hasMoreResults(printable: unknown): boolean {
  return (
    typeof printable === 'object' &&
    printable !== null &&
    'cursorHasMore' in printable &&
    printable.cursorHasMore === true
  );
}
