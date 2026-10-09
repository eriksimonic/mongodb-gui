import type { ProfileEntry, ProfileOp } from './types';

type Plain = Record<string, unknown>;

const EPOCH_ISO = new Date(0).toISOString();
const RAW_OP_MAP: Readonly<Record<string, ProfileOp>> = {
  query: 'query',
  insert: 'insert',
  update: 'update',
  remove: 'remove',
  getmore: 'getmore',
};
const FNV_OFFSET_A = 0x811c9dc5;
const FNV_OFFSET_B = 0x9747b28c;
const FNV_PRIME = 0x01000193;

// Converts one document from system.profile into a ProfileEntry. It never throws. A document
// without a recognised shape becomes an entry with op 'other', and the original value stays in raw.
export function toProfileEntry(raw: unknown): ProfileEntry {
  try {
    return buildEntry(raw);
  } catch {
    return {
      id: stableHash(`unreadable|${safeStringify(raw)}`),
      ts: EPOCH_ISO,
      ns: '',
      op: 'other',
      millis: 0,
      raw,
    };
  }
}

function buildEntry(raw: unknown): ProfileEntry {
  const doc: Plain = isPlainDocument(raw) ? raw : {};
  const ts = toIsoTimestamp(doc.ts) ?? EPOCH_ISO;
  const ns = readText(doc, 'ns') ?? '';
  const command = readCommand(doc);
  const op = resolveOp(readText(doc, 'op'), command);
  const millis = Math.max(0, readNumber(doc, 'millis') ?? 0);
  const id = entryId(doc, ts);
  return {
    id,
    ts,
    ns,
    op,
    millis,
    ...optional('command', command),
    ...optional('planSummary', readText(doc, 'planSummary')),
    ...optional('keysExamined', readNumber(doc, 'keysExamined')),
    ...optional('docsExamined', readNumber(doc, 'docsExamined')),
    ...optional('nreturned', readNumber(doc, 'nreturned')),
    ...optional('nMatched', readNumber(doc, 'nMatched')),
    ...optional('nModified', readNumber(doc, 'nModified')),
    ...optional('hasSortStage', readBoolean(doc, 'hasSortStage')),
    ...optional('usedDisk', readBoolean(doc, 'usedDisk')),
    ...optional('queryHash', readText(doc, 'queryHash')),
    ...optional('planCacheKey', readText(doc, 'planCacheKey')),
    ...optional('client', readText(doc, 'client')),
    ...optional('appName', readText(doc, 'appName')),
    ...optional('user', readText(doc, 'user')),
    ...optional('locks', doc.locks),
    ...optional('storage', doc.storage),
    ...optional('responseLength', readNumber(doc, 'responseLength')),
    ...optional('errMsg', readText(doc, 'errMsg')),
    ...optional('errCode', readNumber(doc, 'errCode')),
    raw,
  };
}

// 4.4 reports find as op 'query' with the command in `command`. 6.0 and later report find,
// aggregate and getMore as op 'command'. Entries from before the command field existed carry the
// filter in `query` and the update document in `updateobj`; those are wrapped as a command.
function resolveOp(rawOp: string | undefined, command: unknown): ProfileOp {
  if (rawOp === undefined) {
    return 'other';
  }
  if (rawOp === 'command') {
    return opFromCommandName(commandName(command));
  }
  return RAW_OP_MAP[rawOp] ?? 'other';
}

function opFromCommandName(name: string | undefined): ProfileOp {
  switch (name) {
    case 'find':
    case 'aggregate':
      return 'query';
    case 'getMore':
      return 'getmore';
    case 'insert':
      return 'insert';
    case 'update':
      return 'update';
    case 'delete':
      return 'remove';
    default:
      return 'command';
  }
}

function readCommand(doc: Plain): unknown {
  if (doc.command !== undefined) {
    return doc.command;
  }
  const legacy: Plain = {};
  if (doc.query !== undefined) {
    legacy.query = doc.query;
  }
  if (doc.updateobj !== undefined) {
    legacy.updateobj = doc.updateobj;
  }
  return Object.keys(legacy).length > 0 ? legacy : undefined;
}

function commandName(command: unknown): string | undefined {
  if (!isPlainDocument(command)) {
    return undefined;
  }
  return Object.keys(command)[0];
}

// Profile documents carry neither opid nor _id on most versions, so the whole document is hashed
// in that case. Identical documents in the same millisecond still share an id. The adapter
// suffixes such repeats to keep ids unique within a listing.
function entryId(doc: Plain, ts: string): string {
  const parts = [ts];
  const opid = scalarText(doc.opid);
  const docId = scalarText(doc._id);
  if (opid !== undefined) {
    parts.push(`opid:${opid}`);
  }
  if (docId !== undefined) {
    parts.push(`_id:${docId}`);
  }
  if (parts.length === 1) {
    parts.push(`doc:${safeStringify(doc)}`);
  }
  return stableHash(parts.join('|'));
}

function scalarText(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'bigint') {
    return String(value);
  }
  if (hasHexString(value)) {
    return value.toHexString();
  }
  return undefined;
}

function hasHexString(value: unknown): value is { toHexString(): string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'toHexString' in value &&
    typeof value.toHexString === 'function'
  );
}

function toIsoTimestamp(value: unknown): string | undefined {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? undefined : value.toISOString();
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString();
  }
  return undefined;
}

function isPlainDocument(value: unknown): value is Plain {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function readText(doc: Plain, key: string): string | undefined {
  const value = doc[key];
  return typeof value === 'string' ? value : undefined;
}

function readBoolean(doc: Plain, key: string): boolean | undefined {
  const value = doc[key];
  return typeof value === 'boolean' ? value : undefined;
}

function readNumber(doc: Plain, key: string): number | undefined {
  const value = doc[key];
  if (typeof value === 'bigint') {
    return Number(value);
  }
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function optional<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, bigintAsText) ?? '';
  } catch {
    return '';
  }
}

function bigintAsText(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

// FNV-1a with two offsets. The result identifies an entry for list keys and deduplication;
// it is not a security measure.
function stableHash(input: string): string {
  return (
    fnv1a(input, FNV_OFFSET_A).toString(16).padStart(8, '0') +
    fnv1a(input, FNV_OFFSET_B).toString(16).padStart(8, '0')
  );
}

function fnv1a(input: string, offset: number): number {
  let hash = offset;
  for (let index = 0; index < input.length; index++) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, FNV_PRIME);
  }
  return hash >>> 0;
}
