import type { AnyBulkWriteOperation, Document } from 'mongodb';
import {
  AppErrorException,
  inferType,
  type ConcreteFieldType,
  type CsvOptions,
  type FieldMapping,
  type FieldType,
  type ImportMode,
} from '@mongo-gui/core';
import type { PlainObject } from '../documents';
import { parseEjson } from '../management/ejson';
import { validationError } from '../management/errors';
import { cellToBson, getPath, jsonValueToBson, setPath, splitPath } from './values';

// One record from the source file. CSV records are already split into fields. JSON and NDJSON
// records are the source text of one document, parsed when the row is converted.
export type SourceRecord =
  | { readonly kind: 'csv'; readonly fields: string[] }
  | { readonly kind: 'json'; readonly text: string };

export interface CsvField {
  readonly index: number;
  readonly source: string;
  readonly target: readonly string[];
  readonly type: ConcreteFieldType;
}

export interface JsonField {
  readonly source: readonly string[];
  readonly target: readonly string[];
  readonly type: FieldType;
}

export type RowPlan =
  | {
      readonly format: 'csv';
      readonly columns: readonly string[];
      readonly csv: CsvOptions;
      readonly fields: readonly CsvField[];
    }
  // fields undefined means no mappings: each parsed document is written as it is.
  | { readonly format: 'json'; readonly fields: readonly JsonField[] | undefined };

export type RowResult =
  | { readonly ok: true; readonly doc: PlainObject }
  | { readonly ok: false; readonly message: string };

export interface CsvHeader {
  readonly names: string[];
  readonly warnings: string[];
}

// Column names from the header row, or column_1..column_n when there is no header. Empty names
// get a placeholder. Duplicate names get _2, _3 and so on, with a warning for each rename.
export function csvColumnNames(
  header: string[] | undefined,
  width: number,
  trim: boolean,
): CsvHeader {
  const raw = header ?? Array.from({ length: width }, (_, index) => `column_${index + 1}`);
  const names: string[] = [];
  const seen = new Set<string>();
  const warnings: string[] = [];
  raw.forEach((cell, index) => {
    const base = trim ? cell.trim() : cell;
    if (base === '') {
      const placeholder = `column_${index + 1}`;
      warnings.push(`Column ${index + 1} has no name and is called ${placeholder}`);
      names.push(unique(placeholder, seen));
      return;
    }
    if (!seen.has(base)) {
      seen.add(base);
      names.push(base);
      return;
    }
    const renamed = unique(base, seen);
    warnings.push(`Duplicate column "${base}" is renamed to "${renamed}"`);
    names.push(renamed);
  });
  return { names, warnings };
}

function unique(name: string, seen: Set<string>): string {
  if (!seen.has(name)) {
    seen.add(name);
    return name;
  }
  let suffix = 2;
  while (seen.has(`${name}_${suffix}`)) {
    suffix += 1;
  }
  const next = `${name}_${suffix}`;
  seen.add(next);
  return next;
}

// The text of one CSV cell, or null when it is a null marker. Trimming happens first.
export function cellText(raw: string | undefined, csv: CsvOptions): string | null {
  const text = csv.trim ? (raw ?? '').trim() : (raw ?? '');
  return csv.nullValues.includes(text) ? null : text;
}

export function resolveCsvFields(
  columns: readonly string[],
  mappings: readonly FieldMapping[] | undefined,
  sample: readonly (readonly string[])[],
  csv: CsvOptions,
): CsvField[] {
  // Without mappings every column is kept. A dotted column name writes a nested field, the same
  // way a dotted target does, so that a file exported with dotted columns imports to the same shape.
  const declared: { index: number; source: string; target: string; type: FieldType }[] =
    mappings === undefined
      ? columns.map((name, index) => ({ index, source: name, target: name, type: 'auto' }))
      : mappings
          .filter((mapping) => mapping.skip !== true)
          .map((mapping) => {
            const index = columns.indexOf(mapping.source);
            if (index === -1) {
              throw validationError(`Column "${mapping.source}" is not in the file`);
            }
            return { index, source: mapping.source, target: mapping.target, type: mapping.type };
          });

  const targets = new Set<string>();
  for (const field of declared) {
    if (targets.has(field.target)) {
      throw validationError(`Two columns are mapped to ${field.target}`);
    }
    targets.add(field.target);
  }

  return declared.map((field) => ({
    index: field.index,
    source: field.source,
    target: splitPath(field.target),
    type:
      field.type === 'auto'
        ? inferType(sample.map((record) => cellText(record[field.index], csv)))
        : field.type,
  }));
}

export function resolveJsonFields(
  mappings: readonly FieldMapping[] | undefined,
): JsonField[] | undefined {
  if (mappings === undefined) {
    return undefined;
  }
  const fields = mappings
    .filter((mapping) => mapping.skip !== true)
    .map((mapping) => ({
      source: splitPath(mapping.source),
      target: splitPath(mapping.target),
      type: mapping.type,
    }));
  const targets = new Set<string>();
  for (const field of fields) {
    const key = field.target.join('.');
    if (targets.has(key)) {
      throw validationError(`Two fields are mapped to ${key}`);
    }
    targets.add(key);
  }
  return fields;
}

export function convertRecord(record: SourceRecord, plan: RowPlan): RowResult {
  if (plan.format === 'csv') {
    return record.kind === 'csv'
      ? convertCsv(record.fields, plan)
      : fail('The row is not a CSV record');
  }
  return record.kind === 'json'
    ? convertJson(record.text, plan.fields)
    : fail('The row is not a JSON record');
}

function convertCsv(
  fields: readonly string[],
  plan: Extract<RowPlan, { format: 'csv' }>,
): RowResult {
  if (fields.length !== plan.columns.length) {
    return fail(`Expected ${plan.columns.length} fields but found ${fields.length}`);
  }
  const doc: PlainObject = {};
  for (const field of plan.fields) {
    try {
      setPath(doc, field.target, cellToBson(cellText(fields[field.index], plan.csv), field.type));
    } catch (error) {
      return fail(`Column "${field.source}": ${messageOf(error)}`);
    }
  }
  return { ok: true, doc };
}

function convertJson(text: string, fields: readonly JsonField[] | undefined): RowResult {
  let value: unknown;
  try {
    value = parseEjson(text, 'The row');
  } catch (error) {
    return fail(messageOf(error));
  }
  if (!isDocumentValue(value)) {
    return fail('The row is not a JSON object');
  }
  if (fields === undefined) {
    return { ok: true, doc: value };
  }
  const doc: PlainObject = {};
  for (const field of fields) {
    const raw = getPath(value, field.source);
    if (raw === undefined) {
      continue;
    }
    try {
      setPath(doc, field.target, jsonValueToBson(raw, field.type));
    } catch (error) {
      return fail(`Field ${field.source.join('.')}: ${messageOf(error)}`);
    }
  }
  return { ok: true, doc };
}

// Builds the bulk write for one converted document. Upsert needs the key to be present.
export function writeOperation(
  doc: PlainObject,
  mode: ImportMode,
  upsertKey: string,
): { ok: true; op: AnyBulkWriteOperation<Document> } | { ok: false; message: string } {
  if (mode === 'insert') {
    return { ok: true, op: { insertOne: { document: doc } } };
  }
  const key = getPath(doc, splitPath(upsertKey));
  if (key === undefined) {
    return { ok: false, message: `The row has no ${upsertKey} to upsert on` };
  }
  // A null key is refused: it would match every document that lacks the field. The filter uses
  // $eq, so a document-valued key is compared as a value and never read as query operators.
  if (key === null) {
    return { ok: false, message: `The row has an empty ${upsertKey}` };
  }
  return {
    ok: true,
    op: { replaceOne: { filter: { [upsertKey]: { $eq: key } }, replacement: doc, upsert: true } },
  };
}

// A document as the importer means it: a plain object, not a BSON class instance such as an
// ObjectId or a Date, which must never be written as a row.
export function isDocumentValue(value: unknown): value is PlainObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function fail(message: string): RowResult {
  return { ok: false, message };
}

export function messageOf(error: unknown): string {
  if (error instanceof AppErrorException) {
    return error.error.detail === undefined
      ? error.error.message
      : `${error.error.message}: ${error.error.detail}`;
  }
  return error instanceof Error ? error.message : 'The value could not be converted';
}
