/**
 * Turns canonical EJSON results into what the result views show: BSON types, flattened columns,
 * cell text, one-line summaries, and the collection a statement reads. Everything here is pure.
 */

/** BSON types the views label. `number` is a plain JSON number, which canonical EJSON never sends. */
export type BsonType =
  | 'ObjectId'
  | 'Date'
  | 'String'
  | 'Int32'
  | 'Int64'
  | 'Double'
  | 'Decimal128'
  | 'Boolean'
  | 'Null'
  | 'Object'
  | 'Array'
  | 'Binary'
  | 'Timestamp'
  | 'Regex'
  | 'MinKey'
  | 'MaxKey'
  | 'Code'
  | 'Undefined'
  | 'Number';

export type JsonObject = Readonly<Record<string, unknown>>;

const WRAPPER_KEYS: Readonly<Record<string, BsonType>> = {
  $oid: 'ObjectId',
  $date: 'Date',
  $numberInt: 'Int32',
  $numberLong: 'Int64',
  $numberDouble: 'Double',
  $numberDecimal: 'Decimal128',
  $binary: 'Binary',
  $timestamp: 'Timestamp',
  $regularExpression: 'Regex',
  $minKey: 'MinKey',
  $maxKey: 'MaxKey',
  $code: 'Code',
  $symbol: 'String',
  $undefined: 'Undefined',
};

/** Short names for the type badges. */
export const BSON_TYPE_LABELS: Readonly<Record<BsonType, string>> = {
  ObjectId: 'ObjectId',
  Date: 'Date',
  String: 'string',
  Int32: 'int',
  Int64: 'long',
  Double: 'double',
  Decimal128: 'decimal',
  Boolean: 'bool',
  Null: 'null',
  Object: 'object',
  Array: 'array',
  Binary: 'binData',
  Timestamp: 'timestamp',
  Regex: 'regex',
  MinKey: 'minKey',
  MaxKey: 'maxKey',
  Code: 'code',
  Undefined: 'undefined',
  Number: 'number',
};

export function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The wrapper key of a canonical EJSON value, such as `$oid`, or undefined for an ordinary object. */
export function wrapperKey(value: unknown): string | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }
  const keys = Object.keys(value);
  const [key] = keys;
  return keys.length === 1 && key !== undefined && key in WRAPPER_KEYS ? key : undefined;
}

/** The BSON type of a canonical EJSON value. */
export function bsonTypeOf(value: unknown): BsonType {
  if (value === null) {
    return 'Null';
  }
  if (typeof value === 'string') {
    return 'String';
  }
  if (typeof value === 'boolean') {
    return 'Boolean';
  }
  if (typeof value === 'number') {
    return 'Number';
  }
  if (Array.isArray(value)) {
    return 'Array';
  }
  const key = wrapperKey(value);
  if (key !== undefined) {
    return WRAPPER_KEYS[key] ?? 'Object';
  }
  return isPlainObject(value) ? 'Object' : 'Undefined';
}

/** The value inside a numeric wrapper, or undefined when the value is not a number. */
export function numberOf(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return value;
  }
  if (!isPlainObject(value)) {
    return undefined;
  }
  const inner = value.$numberInt ?? value.$numberLong ?? value.$numberDouble;
  if (typeof inner !== 'string') {
    return undefined;
  }
  const parsed = Number(inner);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Parses canonical EJSON text. Returns undefined when the text is not JSON. */
export function parseEjson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** A flattened leaf of a document: its dotted path, its value, and its type. */
export interface FlatEntry {
  readonly path: string;
  readonly value: unknown;
  readonly type: BsonType;
}

/**
 * The leaves of a document. Plain objects are opened into dotted paths. Arrays, wrapped BSON
 * values and empty objects are leaves, so an array shows as one cell.
 */
export function flattenDocument(document: JsonObject): FlatEntry[] {
  const entries: FlatEntry[] = [];
  const visit = (value: JsonObject, prefix: string): void => {
    for (const [key, child] of Object.entries(value)) {
      const path = prefix === '' ? key : `${prefix}.${key}`;
      const type = bsonTypeOf(child);
      if (type === 'Object' && isPlainObject(child) && Object.keys(child).length > 0) {
        visit(child, path);
      } else {
        entries.push({ path, value: child, type });
      }
    }
  };
  visit(document, '');
  return entries;
}

/** One table column: the dotted path and the types seen at that path, first seen first. */
export interface ColumnDef {
  readonly path: string;
  readonly types: readonly BsonType[];
}

/**
 * The union of the flattened paths of the documents, in first-seen order. `_id` comes first when
 * any document has one.
 */
export function discoverColumns(documents: readonly JsonObject[]): ColumnDef[] {
  const types = new Map<string, BsonType[]>();
  for (const document of documents) {
    for (const entry of flattenDocument(document)) {
      const seen = types.get(entry.path);
      if (seen === undefined) {
        types.set(entry.path, [entry.type]);
      } else if (!seen.includes(entry.type)) {
        seen.push(entry.type);
      }
    }
  }
  const paths = [...types.keys()];
  const ordered = paths.includes('_id')
    ? ['_id', ...paths.filter((path) => path !== '_id')]
    : paths;
  return ordered.map((path) => ({ path, types: types.get(path) ?? [] }));
}

/** The leaf value at a dotted path, or undefined when the document has none. */
export function valueAtPath(document: JsonObject, path: string): unknown {
  let current: unknown = document;
  for (const key of path.split('.')) {
    if (!isPlainObject(current) || !(key in current)) {
      return undefined;
    }
    current = current[key];
  }
  return current;
}

/** ISO text for a Date value, or undefined when the value is not a date. */
export function isoDateText(value: unknown): string | undefined {
  if (!isPlainObject(value) || !('$date' in value)) {
    return undefined;
  }
  const inner = value.$date;
  if (typeof inner === 'string') {
    return inner;
  }
  const millis = numberOf(inner);
  if (millis === undefined) {
    return undefined;
  }
  const date = new Date(millis);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/** The hex text of an ObjectId value, or undefined. */
export function objectIdHex(value: unknown): string | undefined {
  if (!isPlainObject(value) || typeof value.$oid !== 'string') {
    return undefined;
  }
  return value.$oid;
}

const SHORT_OBJECT_ID = 8;
const TOOLTIP_LIMIT = 600;
const CELL_TEXT_LIMIT = 120;

/** What one table cell or tree value shows. */
export interface CellView {
  readonly text: string;
  readonly type: BsonType;
  readonly align: 'left' | 'right';
  /** Full text for a tooltip, when the shown text is shortened. */
  readonly title?: string;
}

/**
 * The text of a leaf value. Collections are summarised in one line, with the relaxed JSON in the
 * title. Long strings are cut for the cell, and the title keeps the whole string.
 */
export function cellView(value: unknown): CellView {
  const type = bsonTypeOf(value);
  switch (type) {
    case 'ObjectId': {
      const hex = objectIdHex(value) ?? '';
      return { text: `${hex.slice(0, SHORT_OBJECT_ID)}…`, type, align: 'left', title: hex };
    }
    case 'Date': {
      const iso = isoDateText(value) ?? '';
      return { text: iso, type, align: 'left' };
    }
    case 'Int32':
    case 'Int64':
    case 'Double':
    case 'Decimal128':
    case 'Number': {
      const text = numberText(value);
      return { text, type, align: 'right' };
    }
    case 'String': {
      const text = typeof value === 'string' ? value : String(wrapperValue(value));
      return text.length > CELL_TEXT_LIMIT
        ? { text: `${text.slice(0, CELL_TEXT_LIMIT - 1)}…`, type, align: 'left', title: text }
        : { text, type, align: 'left' };
    }
    case 'Boolean':
      return { text: value === true ? 'true' : 'false', type, align: 'left' };
    case 'Null':
      return { text: 'null', type, align: 'left' };
    case 'Array': {
      const items = Array.isArray(value) ? value.length : 0;
      return {
        text: `[…] ${items} ${items === 1 ? 'item' : 'items'}`,
        type,
        align: 'left',
        title: relaxedTitle(value),
      };
    }
    case 'Object': {
      const fields = isPlainObject(value) ? Object.keys(value).length : 0;
      return {
        text: `{…} ${fields} ${fields === 1 ? 'field' : 'fields'}`,
        type,
        align: 'left',
        title: relaxedTitle(value),
      };
    }
    default:
      return { text: wrapperText(type, value), type, align: 'left' };
  }
}

function relaxedTitle(value: unknown): string {
  const text = JSON.stringify(value, null, 2) ?? '';
  return text.length > TOOLTIP_LIMIT ? `${text.slice(0, TOOLTIP_LIMIT - 1)}…` : text;
}

function wrapperValue(value: unknown): unknown {
  return isPlainObject(value) ? Object.values(value)[0] : value;
}

function numberText(value: unknown): string {
  if (typeof value === 'number') {
    return String(value);
  }
  if (!isPlainObject(value)) {
    return '';
  }
  const inner =
    value.$numberInt ?? value.$numberLong ?? value.$numberDouble ?? value.$numberDecimal;
  return typeof inner === 'string' ? inner : '';
}

function wrapperText(type: BsonType, value: unknown): string {
  if (!isPlainObject(value)) {
    return '';
  }
  switch (type) {
    case 'Binary': {
      const binary = isPlainObject(value.$binary) ? value.$binary : {};
      return `Binary(${String(binary.subType ?? '')}, ${String(binary.base64 ?? '').length} bytes base64)`;
    }
    case 'Timestamp': {
      const stamp = isPlainObject(value.$timestamp) ? value.$timestamp : {};
      return `Timestamp(${String(stamp.t ?? '')}, ${String(stamp.i ?? '')})`;
    }
    case 'Regex': {
      const regex = isPlainObject(value.$regularExpression) ? value.$regularExpression : {};
      return `/${String(regex.pattern ?? '')}/${String(regex.options ?? '')}`;
    }
    case 'MinKey':
      return 'MinKey';
    case 'MaxKey':
      return 'MaxKey';
    case 'Code':
      return String(value.$code ?? '');
    case 'Undefined':
      return 'undefined';
    default:
      return '';
  }
}

/** The count line of a cursor page, such as "1 to 50 of ?" while more documents may follow. */
export function formatCount(count: number, hasMore: boolean): string {
  if (count === 0) {
    return 'No documents';
  }
  return `1 to ${count} of ${hasMore ? '?' : String(count)}`;
}

/** A cursor batch as the runtime prints it: the documents of the batch and whether more follow. */
export interface CursorBatch {
  readonly documents: JsonObject[];
  readonly hasMore: boolean;
}

/** Reads a cursor batch. Returns undefined when the text is not a batch. */
export function parseCursorBatch(printableEjson: string): CursorBatch | undefined {
  const parsed = parseEjson(printableEjson);
  if (!isPlainObject(parsed) || !Array.isArray(parsed.documents)) {
    return undefined;
  }
  const documents = parsed.documents.filter(isPlainObject);
  return { documents, hasMore: parsed.cursorHasMore === true };
}

/**
 * One-line summary of a non-cursor result, for example "Inserted 3" or "Matched 10, modified 10".
 * Returns undefined for results with no summary, such as a number or a string.
 */
export function summariseResult(typeName: string, printableEjson: string): string | undefined {
  const parsed = parseEjson(printableEjson);
  if (!isPlainObject(parsed)) {
    return undefined;
  }
  switch (typeName) {
    case 'InsertOneResult':
      return 'Inserted 1';
    case 'InsertManyResult':
      return `Inserted ${countEntries(parsed.insertedIds)}`;
    case 'UpdateResult':
      return updateSummary(parsed);
    case 'DeleteResult':
      return `Deleted ${numberOf(parsed.deletedCount) ?? 0}`;
    case 'BulkWriteResult':
      return bulkSummary(parsed);
    default:
      return undefined;
  }
}

function countEntries(value: unknown): number {
  return isPlainObject(value) ? Object.keys(value).length : 0;
}

function updateSummary(result: JsonObject): string {
  const matched = numberOf(result.matchedCount) ?? 0;
  const modified = numberOf(result.modifiedCount) ?? 0;
  const upserted = numberOf(result.upsertedCount) ?? 0;
  const parts = [`Matched ${matched}`, `modified ${modified}`];
  if (upserted > 0) {
    parts.push(`upserted ${upserted}`);
  }
  return parts.join(', ');
}

function bulkSummary(result: JsonObject): string {
  const labels: [string, string][] = [
    ['insertedCount', 'Inserted'],
    ['matchedCount', 'matched'],
    ['modifiedCount', 'modified'],
    ['deletedCount', 'deleted'],
    ['upsertedCount', 'upserted'],
  ];
  const parts: string[] = [];
  for (const [key, label] of labels) {
    const count = numberOf(result[key]) ?? 0;
    if (count > 0) {
      parts.push(`${label} ${count}`);
    }
  }
  return parts.length === 0 ? 'No changes' : parts.join(', ');
}

/** Cursor methods a `find` chain may end with. Each one keeps the documents of the same collection. */
const FIND_CHAIN_METHODS = new Set([
  'sort',
  'limit',
  'skip',
  'project',
  'hint',
  'collation',
  'comment',
  'maxTimeMS',
  'batchSize',
  'readPref',
]);

const FIND_START = /^db\.([A-Za-z_][A-Za-z0-9_]*)\.find\(/;
const WHITESPACE = /\s/;
const IDENTIFIER_PART = /[A-Za-z0-9_]/;

/**
 * The collection a statement reads with a plain `db.<coll>.find(...)`, optionally followed by
 * cursor methods such as sort and limit. Any other statement returns undefined, so the result
 * is never edited against a collection it may not come from.
 */
export function collectionOfFind(statement: string): string | undefined {
  const text = statement.trim();
  const start = FIND_START.exec(text);
  if (start === null) {
    return undefined;
  }
  let index = skipCall(text, start[0].length - 1);
  if (index === undefined) {
    return undefined;
  }
  for (;;) {
    index = skipWhitespace(text, index);
    if (index === text.length) {
      return start[1];
    }
    if (text.charAt(index) !== '.') {
      return undefined;
    }
    index = skipWhitespace(text, index + 1);
    const nameStart = index;
    while (index < text.length && IDENTIFIER_PART.test(text.charAt(index))) {
      index += 1;
    }
    const name = text.slice(nameStart, index);
    if (!FIND_CHAIN_METHODS.has(name)) {
      return undefined;
    }
    index = skipWhitespace(text, index);
    if (text.charAt(index) !== '(') {
      return undefined;
    }
    const next = skipCall(text, index);
    if (next === undefined) {
      return undefined;
    }
    index = next;
  }
}

function skipWhitespace(text: string, from: number): number {
  let index = from;
  while (index < text.length && WHITESPACE.test(text.charAt(index))) {
    index += 1;
  }
  return index;
}

/** The index just past the parenthesis that closes the one at `open`, honouring strings. */
function skipCall(text: string, open: number): number | undefined {
  let depth = 0;
  let quote: string | undefined;
  for (let index = open; index < text.length; index += 1) {
    const char = text.charAt(index);
    if (quote !== undefined) {
      if (char === '\\') {
        index += 1;
      } else if (char === quote) {
        quote = undefined;
      }
    } else if (char === '"' || char === "'" || char === '`') {
      quote = char;
    } else if (char === '(' || char === '[' || char === '{') {
      depth += 1;
    } else if (char === ')' || char === ']' || char === '}') {
      depth -= 1;
      if (depth === 0) {
        return char === ')' ? index + 1 : undefined;
      }
    }
  }
  return undefined;
}

/** The field types a tree editor offers. */
export const EDIT_TYPES = [
  'string',
  'int',
  'long',
  'double',
  'decimal',
  'boolean',
  'date',
  'objectId',
  'null',
] as const;

export type EditType = (typeof EDIT_TYPES)[number];

export type EditValueResult =
  { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly message: string };

const INT32_MIN = -2_147_483_648;
const INT32_MAX = 2_147_483_647;
const INTEGER_TEXT = /^[+-]?\d+$/;
const DECIMAL_TEXT = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;
const OBJECT_ID_TEXT = /^[0-9a-fA-F]{24}$/;

/**
 * Converts the text the user typed in the tree editor into canonical EJSON for the chosen type.
 * Returns a message when the text does not fit the type.
 */
export function valueFromEdit(type: EditType, text: string): EditValueResult {
  switch (type) {
    case 'string':
      return { ok: true, value: text };
    case 'null':
      return { ok: true, value: null };
    case 'boolean': {
      const lower = text.trim().toLowerCase();
      if (lower === 'true' || lower === 'false') {
        return { ok: true, value: lower === 'true' };
      }
      return { ok: false, message: 'Enter true or false.' };
    }
    case 'int': {
      const trimmed = text.trim();
      const number = Number(trimmed);
      if (!INTEGER_TEXT.test(trimmed) || number < INT32_MIN || number > INT32_MAX) {
        return { ok: false, message: 'Enter a whole number between -2147483648 and 2147483647.' };
      }
      return { ok: true, value: { $numberInt: String(number) } };
    }
    case 'long': {
      const trimmed = text.trim();
      if (!INTEGER_TEXT.test(trimmed) || !Number.isSafeInteger(Number(trimmed))) {
        return { ok: false, message: 'Enter a whole number that fits in 53 bits.' };
      }
      return { ok: true, value: { $numberLong: String(Number(trimmed)) } };
    }
    case 'double': {
      const number = Number(text.trim());
      if (text.trim() === '' || !Number.isFinite(number)) {
        return { ok: false, message: 'Enter a finite number.' };
      }
      return { ok: true, value: { $numberDouble: String(number) } };
    }
    case 'decimal': {
      const trimmed = text.trim();
      if (!DECIMAL_TEXT.test(trimmed)) {
        return { ok: false, message: 'Enter a decimal number, for example 12.50.' };
      }
      return { ok: true, value: { $numberDecimal: trimmed } };
    }
    case 'date': {
      const trimmed = text.trim();
      const millis = Date.parse(trimmed);
      if (trimmed === '' || Number.isNaN(millis)) {
        return { ok: false, message: 'Enter a date, for example 2026-01-31T12:00:00Z.' };
      }
      return { ok: true, value: { $date: new Date(millis).toISOString() } };
    }
    case 'objectId': {
      const trimmed = text.trim();
      if (!OBJECT_ID_TEXT.test(trimmed)) {
        return { ok: false, message: 'Enter 24 hexadecimal characters.' };
      }
      return { ok: true, value: { $oid: trimmed.toLowerCase() } };
    }
  }
}

/** The text an edit field starts with: the value as the user would type it. */
export function editTextOf(value: unknown): string {
  const type = bsonTypeOf(value);
  if (type === 'String') {
    return typeof value === 'string' ? value : '';
  }
  if (type === 'ObjectId') {
    return objectIdHex(value) ?? '';
  }
  if (type === 'Date') {
    return isoDateText(value) ?? '';
  }
  if (type === 'Null') {
    return '';
  }
  if (type === 'Boolean') {
    return value === true ? 'true' : 'false';
  }
  return numberText(value);
}

/** The type picker value that matches a leaf, or undefined when it has no editable type. */
export function editTypeOf(value: unknown): EditType | undefined {
  switch (bsonTypeOf(value)) {
    case 'String':
      return 'string';
    case 'Int32':
      return 'int';
    case 'Int64':
      return 'long';
    case 'Double':
    case 'Number':
      return 'double';
    case 'Decimal128':
      return 'decimal';
    case 'Boolean':
      return 'boolean';
    case 'Date':
      return 'date';
    case 'ObjectId':
      return 'objectId';
    case 'Null':
      return 'null';
    default:
      return undefined;
  }
}
