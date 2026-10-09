import { inspect } from 'node:util';
import { EJSON } from 'bson';

const INSPECT_DEPTH = 8;

// Canonical EJSON (relaxed: false) keeps ObjectId, Long, Decimal128, dates and binary intact.
// Values that EJSON cannot encode fall back to util.inspect. That covers cyclic objects, Maps,
// Sets, functions, and errors from the vm realm.
export function serializePrintable(value: unknown): string {
  if (value === undefined) {
    return 'null';
  }
  if (value instanceof Map || value instanceof Set || isErrorLike(value)) {
    return JSON.stringify(inspectValue(value));
  }
  try {
    const text = EJSON.stringify(value, { relaxed: false });
    if (text !== undefined) {
      return text;
    }
  } catch {
    // Cyclic or otherwise unencodable values fall through to inspect below.
  }
  return JSON.stringify(inspectValue(value));
}

// Text for one print or printjson call. Strings print bare, everything else prints the way the
// mongosh shell shows it.
export function formatPrintText(values: readonly unknown[]): string {
  return values.map((value) => (typeof value === 'string' ? value : inspectValue(value))).join(' ');
}

// A cursor result carries cursorHasMore. A batch with no documents has nothing to page through,
// so it reports no more pages even when the cursor is still open.
export function hasMoreResults(printable: unknown): boolean {
  if (!isCursorResult(printable)) {
    return false;
  }
  const documents: unknown = Reflect.get(printable, 'documents');
  return (
    Reflect.get(printable, 'cursorHasMore') === true &&
    Array.isArray(documents) &&
    documents.length > 0
  );
}

// Cursor batches (find, aggregate, it) carry a boolean cursorHasMore field.
export function isCursorResult(printable: unknown): printable is object {
  return (
    typeof printable === 'object' &&
    printable !== null &&
    typeof Reflect.get(printable, 'cursorHasMore') === 'boolean'
  );
}

// Checks the realm-independent tag, so an Error from the vm context counts too.
function isErrorLike(value: unknown): boolean {
  return Object.prototype.toString.call(value) === '[object Error]';
}

function inspectValue(value: unknown): string {
  return inspect(value, { depth: INSPECT_DEPTH, breakLength: Infinity });
}
