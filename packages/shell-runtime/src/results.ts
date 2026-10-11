import { inspect } from 'node:util';
import { EJSON } from 'bson';
import { docBudget, previewDocument, withPreviewInfo } from '@mongo-gui/core';

const INSPECT_DEPTH = 8;

// Canonical EJSON (relaxed: false) keeps ObjectId, Long, Decimal128, dates and binary intact.
// Values that EJSON cannot encode fall back to util.inspect. That covers cyclic objects, Maps,
// Sets, functions, and errors from the vm realm.
export function serializePrintable(value: unknown): string {
  if (value === undefined) {
    return 'null';
  }
  if (isInspectOnly(value)) {
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

// Where the full text of an oversized document goes. write returns the spill reference, or
// undefined when the text was not stored (size cap or file system error).
export interface SpillSink {
  write(text: string): string | undefined;
}

// Serialises one cursor batch document by document. A document that does not fit its share of the
// response budget is sent as a bounded preview and its full canonical EJSON goes to the sink, so
// the response stays small however large the documents are. The batch keeps its order and count,
// and printable is not changed because mongosh keeps it for the next "it". At most one document's
// text and tree are alive at a time.
// Precondition: isCursorResult(printable) and printable.documents is an array.
export function serializeCursorBatch(printable: object, sink: SpillSink): string {
  const documents: unknown = Reflect.get(printable, 'documents');
  const list: unknown[] = Array.isArray(documents) ? documents : [];
  const hasMore = Reflect.get(printable, 'cursorHasMore') === true;
  return `{"documents":[${serializeDocuments(list, sink).join(',')}],"cursorHasMore":${String(hasMore)}}`;
}

// A result that is not a cursor batch: toArray(), findOne(), an aggregate array. Documents and
// arrays of documents go through the same bounded path as a cursor batch, so a huge result never
// becomes one string in this process, in the IPC message or in the renderer. Any other value is
// small or has no size to bound, and is sent whole.
export function serializeResult(value: unknown, sink: SpillSink): string {
  if (Array.isArray(value) && value.length > 0 && value.every(isDocumentLike)) {
    return `[${serializeDocuments(value, sink).join(',')}]`;
  }
  if (isDocumentLike(value)) {
    return serializeDocument(value, docBudget(0, 1), sink);
  }
  return serializePrintable(value);
}

function serializeDocuments(list: readonly unknown[], sink: SpillSink): string[] {
  const parts: string[] = [];
  let used = 0;
  list.forEach((doc, index) => {
    const part = serializeDocument(doc, docBudget(used, list.length - index), sink);
    parts.push(part);
    used += part.length;
  });
  return parts;
}

function isDocumentLike(value: unknown): boolean {
  return (
    typeof value === 'object' && value !== null && !Array.isArray(value) && !isInspectOnly(value)
  );
}

function serializeDocument(doc: unknown, budget: number, sink: SpillSink): string {
  if (isInspectOnly(doc)) {
    return JSON.stringify(inspectValue(doc));
  }
  let text: string;
  try {
    text = EJSON.stringify(doc, { relaxed: false });
    if (text.length <= budget) {
      return text;
    }
  } catch {
    return JSON.stringify(inspectValue(doc));
  }
  const tree: unknown = JSON.parse(text);
  if (typeof tree !== 'object' || tree === null || Array.isArray(tree)) {
    return text;
  }
  const { value, cut } = previewDocument(tree as Record<string, unknown>, budget);
  if (!cut) {
    return text;
  }
  const ref = sink.write(text);
  return JSON.stringify(withPreviewInfo(value, { ref, chars: text.length }));
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

// EJSON turns these into an empty object, so they print through inspect instead.
function isInspectOnly(value: unknown): boolean {
  return value instanceof Map || value instanceof Set || isErrorLike(value);
}

// Checks the realm-independent tag, so an Error from the vm context counts too.
function isErrorLike(value: unknown): boolean {
  return Object.prototype.toString.call(value) === '[object Error]';
}

function inspectValue(value: unknown): string {
  return inspect(value, { depth: INSPECT_DEPTH, breakLength: Infinity });
}
