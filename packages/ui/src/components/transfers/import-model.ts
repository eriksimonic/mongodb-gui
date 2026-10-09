import {
  CollectionNameSchema,
  FieldTypeSchema,
  MAX_IMPORT_BATCH_SIZE,
  type CsvDelimiter,
  type CsvOptions,
  type FieldMapping,
  type FieldType,
  type ImportFormat,
  type ImportMode,
  type ImportOptions,
  type ImportPreview,
} from '@mongo-gui/core';

/** Every type a mapping can take, in the order the select shows them. */
export const FIELD_TYPES: readonly FieldType[] = FieldTypeSchema.options;

/** The format the wizard starts with: the backend decides from the file's first bytes. */
export type FormatChoice = 'auto' | ImportFormat;

export interface CsvDraft {
  readonly delimiter: CsvDelimiter;
  readonly hasHeader: boolean;
  readonly trim: boolean;
  /** Comma separated text. Empty cells are always null, so they need no entry here. */
  readonly nullText: string;
}

/** One source field of the file, with the target and type the user picked for it. */
export interface MappingRow {
  readonly source: string;
  readonly target: string;
  readonly type: FieldType;
  readonly inferredType: FieldType;
  readonly skip: boolean;
  readonly examples: readonly string[];
  readonly nullCount: number;
}

export interface ImportDraft {
  readonly path: string;
  readonly formatChoice: FormatChoice;
  readonly csv: CsvDraft;
  /** Name of the collection a new one is created as. Unused when the collection exists. */
  readonly newCollection: string;
  readonly mode: ImportMode;
  readonly upsertKey: string;
  readonly batchSize: number;
  readonly stopOnError: boolean;
}

export const DEFAULT_CSV_DRAFT: CsvDraft = {
  delimiter: ',',
  hasHeader: true,
  trim: false,
  nullText: 'null, NULL',
};

export const DEFAULT_IMPORT_DRAFT: ImportDraft = {
  path: '',
  formatChoice: 'auto',
  csv: DEFAULT_CSV_DRAFT,
  newCollection: '',
  mode: 'insert',
  upsertKey: '_id',
  batchSize: 500,
  stopOnError: false,
};

const ABSOLUTE_PATH = /^(\/|[A-Za-z]:[\\/]|\\\\)/;

export function isAbsolutePath(path: string): boolean {
  return ABSOLUTE_PATH.test(path) && !path.includes('\u0000');
}

/** Parses "null, NULL" into markers. Blank entries and duplicates are dropped. */
export function parseNullMarkers(text: string): string[] {
  const markers = text
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');
  return [...new Set(markers)];
}

/** The CSV options the backend reads. Empty cells are always null, as the backend does. */
export function csvOptionsFor(csv: CsvDraft): CsvOptions {
  return {
    delimiter: csv.delimiter,
    quote: '"',
    hasHeader: csv.hasHeader,
    nullValues: ['', ...parseNullMarkers(csv.nullText)],
    trim: csv.trim,
  };
}

/** The mapping rows the preview suggests: every column kept, its inferred type selected. */
export function mappingRowsFrom(preview: ImportPreview): MappingRow[] {
  return preview.fields.map((field) => ({
    source: field.name,
    target: field.name,
    type: field.inferredType,
    inferredType: field.inferredType,
    skip: false,
    examples: field.examples,
    nullCount: field.nullCount,
  }));
}

export interface ImportProblem {
  readonly field: 'path' | 'collection' | 'mapping' | 'upsertKey' | 'batchSize';
  readonly message: string;
}

/** Checks the path, the target and the mapping. A problem with a mapping row names its source. */
export function importProblemsOf(
  draft: ImportDraft,
  rows: readonly MappingRow[],
  collectionIsNew: boolean,
): ImportProblem[] {
  const problems: ImportProblem[] = [];
  if (!isAbsolutePath(draft.path)) {
    problems.push({ field: 'path', message: 'Choose a file or type its full path' });
  }
  if (collectionIsNew && !CollectionNameSchema.safeParse(draft.newCollection.trim()).success) {
    problems.push({ field: 'collection', message: 'Name the new collection' });
  }
  const mapped = rows.filter((row) => !row.skip);
  if (mapped.length === 0) {
    problems.push({ field: 'mapping', message: 'Map at least one field' });
  }
  const seen = new Set<string>();
  for (const row of mapped) {
    const target = row.target.trim();
    if (target === '' || target.split('.').some((segment) => segment === '')) {
      problems.push({
        field: 'mapping',
        message: `The target of "${row.source}" is not a valid field path`,
      });
    } else if (seen.has(target)) {
      problems.push({ field: 'mapping', message: `Two fields are mapped to "${target}"` });
    }
    seen.add(target);
  }
  if (draft.mode === 'upsert' && !isValidPath(draft.upsertKey)) {
    problems.push({ field: 'upsertKey', message: 'Give the field to match existing documents on' });
  }
  if (
    !Number.isInteger(draft.batchSize) ||
    draft.batchSize < 1 ||
    draft.batchSize > MAX_IMPORT_BATCH_SIZE
  ) {
    problems.push({
      field: 'batchSize',
      message: `The batch size is a whole number from 1 to ${MAX_IMPORT_BATCH_SIZE}`,
    });
  }
  return problems;
}

function isValidPath(value: string): boolean {
  return value.trim() !== '' && value.split('.').every((segment) => segment !== '');
}

/**
 * The options the backend receives. Mappings for skipped rows are sent with skip set, so the
 * backend drops them and the summary still names the same fields.
 */
export function importOptionsFor(
  draft: ImportDraft,
  format: ImportFormat,
  rows: readonly MappingRow[],
): ImportOptions {
  // JSON values already carry their BSON types. A field whose type was not changed is sent as
  // auto, so the backend keeps the parsed value (a Long stays a Long). CSV cells always convert.
  const mappings: FieldMapping[] = rows.map((row) => ({
    source: row.source,
    target: row.target.trim(),
    type: format !== 'csv' && row.type === row.inferredType ? 'auto' : row.type,
    skip: row.skip,
  }));
  return {
    format,
    ...(format === 'csv' ? { csv: csvOptionsFor(draft.csv) } : {}),
    mappings,
    mode: draft.mode,
    upsertKey: draft.upsertKey.trim(),
    batchSize: draft.batchSize,
    stopOnError: draft.stopOnError,
  };
}

/** Name of the collection the import writes to. */
export function targetCollection(draft: ImportDraft, existing: string | undefined): string {
  return existing ?? draft.newCollection.trim();
}
