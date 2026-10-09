import { BSON, Timestamp, type Document } from 'mongodb';
import {
  AppErrorException,
  appError,
  MAX_CHANGE_EVENT_BYTES,
  type ChangeEvent,
  type ChangeNamespace,
} from '@mongo-gui/core';
import {
  definedEntry,
  isPlainObject,
  readDate,
  readField,
  readNumber,
  readString,
  type PlainObject,
} from '../documents';

const EJSON_OPTIONS = { relaxed: false } as const;
const UNKNOWN_OPERATION = 'unknown';
const TRUNCATED_FIELDS = ['_id', 'operationType', 'ns', 'documentKey'] as const;
const REFUSED_STAGES = ['$out', '$merge'] as const;

// Canonical EJSON of a driver value, or undefined when the field is absent.
export function toEjson(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return BSON.EJSON.stringify(value, EJSON_OPTIONS);
}

// Maps one raw change document from the driver to the typed event. Pure: the same input always
// gives the same output. Events over MAX_CHANGE_EVENT_BYTES keep only their key fields.
export function toChangeEvent(raw: unknown, seq: number): ChangeEvent {
  const source: PlainObject = isPlainObject(raw) ? raw : {};
  const sizeBytes = BSON.calculateObjectSize(source);
  if (sizeBytes > MAX_CHANGE_EVENT_BYTES) {
    return truncatedEvent(source, seq, sizeBytes);
  }
  const ns = namespaceOf(readField(source, 'ns'));
  const to = namespaceOf(readField(source, 'to'));
  const wallTime = readDate(source, 'wallTime');
  return {
    id: String(seq),
    operationType: readString(source, 'operationType') ?? UNKNOWN_OPERATION,
    resumeTokenEjson: resumeTokenOf(source),
    sizeBytes,
    rawEjson: stringifyOrThrow(source),
    ...definedEntry('clusterTimeEjson', toEjson(readField(source, 'clusterTime'))),
    ...definedEntry('wallTime', wallTime?.toISOString()),
    ...definedEntry('ns', ns),
    ...definedEntry('documentKeyEjson', toEjson(readField(source, 'documentKey'))),
    ...definedEntry('fullDocumentEjson', toEjson(readField(source, 'fullDocument'))),
    ...definedEntry(
      'fullDocumentBeforeChangeEjson',
      toEjson(readField(source, 'fullDocumentBeforeChange')),
    ),
    ...definedEntry('updateDescriptionEjson', toEjson(readField(source, 'updateDescription'))),
    ...definedEntry('to', to),
    ...definedEntry('txnNumber', readNumber(source, 'txnNumber')),
    ...definedEntry('lsidEjson', toEjson(readField(source, 'lsid'))),
  };
}

// Parses the pipeline text from the caller. The pipeline must be an array of plain objects, and
// it may not write to another collection, so $out and $merge are refused.
export function parsePipeline(ejson: string): Document[] {
  const parsed = parseEjson(ejson, 'The pipeline');
  if (!Array.isArray(parsed)) {
    throw validation('The pipeline must be an array of stages');
  }
  const stages: Document[] = [];
  for (const stage of parsed) {
    if (!isPlainObject(stage)) {
      throw validation('Every pipeline stage must be an object');
    }
    const refused = REFUSED_STAGES.find((name) => name in stage);
    if (refused !== undefined) {
      throw validation(`${refused} is not allowed in a change stream pipeline`);
    }
    stages.push(stage);
  }
  return stages;
}

// Parses a resume token. The token is a document, normally { _data: "..." }.
export function parseResumeToken(ejson: string): Document {
  const parsed = parseEjson(ejson, 'The resume token');
  if (!isPlainObject(parsed)) {
    throw validation('The resume token must be a document');
  }
  return parsed;
}

// Parses an operation time, the canonical form of a BSON timestamp.
export function parseOperationTime(ejson: string): Timestamp {
  const parsed = parseEjson(ejson, 'The operation time');
  if (!(parsed instanceof Timestamp)) {
    throw validation('The operation time must be a BSON timestamp, for example {"$timestamp":...}');
  }
  return parsed;
}

function truncatedEvent(source: PlainObject, seq: number, sizeBytes: number): ChangeEvent {
  const reduced: PlainObject = {};
  for (const key of TRUNCATED_FIELDS) {
    const value = readField(source, key);
    if (value !== undefined) {
      reduced[key] = value;
    }
  }
  const ns = namespaceOf(readField(source, 'ns'));
  return {
    id: String(seq),
    operationType: readString(source, 'operationType') ?? UNKNOWN_OPERATION,
    resumeTokenEjson: resumeTokenOf(source),
    sizeBytes,
    rawEjson: stringifyOrThrow(reduced),
    truncated: true,
    ...definedEntry('ns', ns),
    ...definedEntry('documentKeyEjson', toEjson(readField(source, 'documentKey'))),
  };
}

function resumeTokenOf(source: PlainObject): string {
  return toEjson(readField(source, '_id')) ?? 'null';
}

function namespaceOf(value: unknown): ChangeNamespace | undefined {
  const db = readString(value, 'db');
  if (db === undefined) {
    return undefined;
  }
  const coll = readString(value, 'coll');
  return coll === undefined ? { db } : { db, coll };
}

function stringifyOrThrow(value: PlainObject): string {
  const text = toEjson(value);
  if (text === undefined) {
    throw new AppErrorException(appError('INTERNAL', 'The change event could not be serialised'));
  }
  return text;
}

// Input is read relaxed so that plain JSON numbers stay numbers. Canonical wrappers such as
// {"$numberLong": "5"} still parse to their BSON types.
function parseEjson(text: string, subject: string): unknown {
  try {
    return BSON.EJSON.parse(text, { relaxed: true });
  } catch (error) {
    const detail = error instanceof Error ? error.message : undefined;
    throw validation(`${subject} is not valid extended JSON`, detail);
  }
}

function validation(message: string, detail?: string): AppErrorException {
  return new AppErrorException(appError('VALIDATION', message, detail));
}
