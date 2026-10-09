/**
 * Formats canonical extended JSON (the form the router sends, for example `{"$numberInt":"20"}`)
 * as mongosh source, so a copied command runs with the same types it had on the server.
 * A value that is not JSON comes back unchanged.
 */
export interface MongoshFormatOptions {
  /** Spaces per level. Zero writes one line. */
  readonly indent: number;
}

// Mongosh writes operator keys such as $match without quotes, so $ is part of an identifier here.
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const HEX_UUID_LENGTH = 32;
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

type Plain = Record<string, unknown>;

/** Canonical extended JSON to mongosh syntax. */
export function formatMongoshSyntax(canonicalEjson: string, options: MongoshFormatOptions): string {
  const parsed = parseJson(canonicalEjson);
  if (parsed === undefined) {
    return canonicalEjson;
  }
  return writeValue(parsed, options.indent, 0);
}

/** Canonical extended JSON to relaxed extended JSON, for a JSON view. Numbers and dates become JSON. */
export function formatRelaxedJson(canonicalEjson: string): string {
  const parsed = parseJson(canonicalEjson);
  if (parsed === undefined) {
    return canonicalEjson;
  }
  return JSON.stringify(relax(parsed), null, 2) ?? canonicalEjson;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function writeValue(value: unknown, indent: number, depth: number): string {
  if (Array.isArray(value)) {
    return writeArray(value, indent, depth);
  }
  if (isPlain(value)) {
    const special = writeSpecial(value);
    return special ?? writeObject(value, indent, depth);
  }
  return writeScalar(value);
}

function writeScalar(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : 'NaN';
  }
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  return 'undefined';
}

function writeArray(items: readonly unknown[], indent: number, depth: number): string {
  if (items.length === 0) {
    return '[]';
  }
  const parts = items.map((item) => writeValue(item, indent, depth + 1));
  return wrap(parts, '[', ']', indent, depth);
}

function writeObject(object: Plain, indent: number, depth: number): string {
  const keys = Object.keys(object);
  if (keys.length === 0) {
    return '{}';
  }
  const parts = keys.map(
    (key) => `${writeKey(key)}: ${writeValue(object[key], indent, depth + 1)}`,
  );
  return wrap(parts, '{', '}', indent, depth);
}

function writeKey(key: string): string {
  return IDENTIFIER.test(key) ? key : JSON.stringify(key);
}

function wrap(
  parts: readonly string[],
  open: string,
  close: string,
  indent: number,
  depth: number,
): string {
  if (indent === 0) {
    return `${open}${parts.join(', ')}${close}`;
  }
  const inner = ' '.repeat(indent * (depth + 1));
  const outer = ' '.repeat(indent * depth);
  return `${open}\n${parts.map((part) => `${inner}${part}`).join(',\n')}\n${outer}${close}`;
}

/** The wrapper objects of canonical extended JSON. Returns undefined for an ordinary document. */
function writeSpecial(value: Plain): string | undefined {
  const keys = Object.keys(value);
  if (keys.length !== 1) {
    return undefined;
  }
  const key = keys[0] ?? '';
  const inner = value[key];
  switch (key) {
    case '$oid':
      return typeof inner === 'string' ? `ObjectId(${JSON.stringify(inner)})` : undefined;
    case '$date':
      return writeDate(inner);
    case '$numberInt':
      return typeof inner === 'string' ? inner : undefined;
    case '$numberLong':
      return typeof inner === 'string' ? `NumberLong(${JSON.stringify(inner)})` : undefined;
    case '$numberDouble':
      return typeof inner === 'string' ? doubleText(inner) : undefined;
    case '$numberDecimal':
      return typeof inner === 'string' ? `NumberDecimal(${JSON.stringify(inner)})` : undefined;
    case '$timestamp':
      return writeTimestamp(inner);
    case '$binary':
      return writeBinary(inner);
    case '$regularExpression':
      return writeRegex(inner);
    case '$minKey':
      return 'MinKey';
    case '$maxKey':
      return 'MaxKey';
    case '$code':
      return typeof inner === 'string' ? `Code(${JSON.stringify(inner)})` : undefined;
    case '$undefined':
      return 'undefined';
    default:
      return undefined;
  }
}

function writeDate(inner: unknown): string | undefined {
  if (typeof inner === 'string') {
    return `ISODate(${JSON.stringify(inner)})`;
  }
  const millis = isPlain(inner) ? inner.$numberLong : undefined;
  if (typeof millis !== 'string') {
    return undefined;
  }
  return `ISODate(${JSON.stringify(new Date(Number(millis)).toISOString())})`;
}

function doubleText(text: string): string {
  if (text === 'NaN' || text === 'Infinity' || text === '-Infinity') {
    return text;
  }
  const value = Number(text);
  return Number.isFinite(value) ? String(value) : text;
}

function writeTimestamp(inner: unknown): string | undefined {
  if (!isPlain(inner)) {
    return undefined;
  }
  const t = numberText(inner.t);
  const i = numberText(inner.i);
  return t === undefined || i === undefined ? undefined : `Timestamp(${t}, ${i})`;
}

function numberText(value: unknown): string | undefined {
  if (typeof value === 'number') {
    return String(value);
  }
  if (isPlain(value) && typeof value.$numberInt === 'string') {
    return value.$numberInt;
  }
  return undefined;
}

function writeBinary(inner: unknown): string | undefined {
  if (!isPlain(inner) || typeof inner.base64 !== 'string' || typeof inner.subType !== 'string') {
    return undefined;
  }
  const subtype = inner.subType;
  if (subtype === '04') {
    const hex = base64ToHex(inner.base64);
    if (hex !== undefined && hex.length === HEX_UUID_LENGTH) {
      return `UUID(${JSON.stringify(dashUuid(hex))})`;
    }
  }
  const code = Number.parseInt(subtype, 16);
  return `BinData(${Number.isNaN(code) ? 0 : code}, ${JSON.stringify(inner.base64)})`;
}

function dashUuid(hex: string): string {
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function writeRegex(inner: unknown): string | undefined {
  if (!isPlain(inner) || typeof inner.pattern !== 'string') {
    return undefined;
  }
  const options = typeof inner.options === 'string' ? inner.options : '';
  return `/${inner.pattern.replace(/\//g, '\\/')}/${options}`;
}

function relax(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => relax(item));
  }
  if (!isPlain(value)) {
    return value;
  }
  const keys = Object.keys(value);
  if (keys.length === 1) {
    const key = keys[0] ?? '';
    const inner = value[key];
    if (key === '$numberInt' || key === '$numberLong' || key === '$numberDouble') {
      const parsed = typeof inner === 'string' ? Number(inner) : Number.NaN;
      return Number.isFinite(parsed) ? parsed : value;
    }
    if (key === '$date' && isPlain(inner) && typeof inner.$numberLong === 'string') {
      return new Date(Number(inner.$numberLong)).toISOString();
    }
  }
  const out: Plain = {};
  for (const key of keys) {
    out[key] = relax(value[key]);
  }
  return out;
}

/** Decodes standard base64 to lowercase hex. Returns undefined for text that is not base64. */
function base64ToHex(text: string): string | undefined {
  const clean = text.replace(/=+$/, '');
  let bits = 0;
  let bitCount = 0;
  let hex = '';
  for (const char of clean) {
    const index = BASE64_ALPHABET.indexOf(char);
    if (index === -1) {
      return undefined;
    }
    bits = (bits << 6) | index;
    bitCount += 6;
    if (bitCount >= 8) {
      bitCount -= 8;
      hex += ((bits >> bitCount) & 0xff).toString(16).padStart(2, '0');
    }
  }
  return hex;
}

function isPlain(value: unknown): value is Plain {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
