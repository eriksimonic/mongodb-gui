import type {
  CsvDelimiter,
  ExportFormat,
  ImportFormat,
  TransferKind,
  TransferProgress,
} from '@mongo-gui/core';
import { formatBytes, formatDuration } from '../../monitor/format';

/** Format names for the selects. Labels are plain sentence case. */
export const FORMAT_LABELS: Record<ImportFormat, string> = {
  'json-array': 'JSON array',
  ndjson: 'NDJSON (one document per line)',
  csv: 'CSV',
};

export const EXPORT_FORMAT_LABELS: Record<ExportFormat, string> = {
  'json-array': 'JSON array',
  ndjson: 'NDJSON (one document per line)',
  csv: 'CSV',
};

export const DELIMITER_LABELS: Record<CsvDelimiter, string> = {
  ',': 'Comma',
  ';': 'Semicolon',
  '\t': 'Tab',
  '|': 'Pipe',
};

export const DELIMITERS: readonly CsvDelimiter[] = [',', ';', '\t', '|'];

/** The extension a saved file gets for each format. */
export function extensionOf(format: ExportFormat): string {
  switch (format) {
    case 'json-array':
      return 'json';
    case 'ndjson':
      return 'ndjson';
    case 'csv':
      return 'csv';
  }
}

/** A file dialog filter that names the format and its extension. */
export function filterFor(format: ExportFormat): { name: string; extensions: string[] } {
  return { name: EXPORT_FORMAT_LABELS[format], extensions: [extensionOf(format)] };
}

/** `<db>.<coll>.<ext>`, the default name of an export. */
export function defaultExportFileName(
  database: string,
  collection: string,
  format: ExportFormat,
): string {
  return `${database}.${collection}.${extensionOf(format)}`;
}

/** Rows the list shows: values are counted in data records, the same as the backend. */
export function countLine(progress: TransferProgress): string {
  return `${progress.processed.toLocaleString('en-US')} processed`;
}

/**
 * The progress count of a row. A GridFS job counts bytes, so it shows the bytes read of the file.
 * Imports and exports count data records.
 */
export function progressLine(kind: TransferKind, progress: TransferProgress): string {
  if (kind === 'gridfs-upload' || kind === 'gridfs-download') {
    return bytesLine(progress) ?? `${formatBytes(progress.processed)} processed`;
  }
  return countLine(progress);
}

export function elapsedLine(progress: TransferProgress): string {
  return formatDuration(progress.elapsedMs / 1000);
}

export function bytesLine(progress: TransferProgress): string | undefined {
  if (progress.bytesRead === undefined || progress.bytesTotal === undefined) {
    return undefined;
  }
  return `${formatBytes(progress.bytesRead)} of ${formatBytes(progress.bytesTotal)}`;
}

/** Plain text for the first errors table, one line per row error. */
export function errorsAsText(progress: TransferProgress): string {
  return progress.errors.map((error) => `Row ${error.row}: ${error.message}`).join('\n');
}

/** The short status line for a finished or running transfer. */
export function statusLine(progress: TransferProgress): string {
  if (!progress.done) {
    return 'Running';
  }
  if (progress.error?.code === 'CANCELLED') {
    return 'Cancelled';
  }
  return progress.error === undefined ? 'Done' : 'Failed';
}

/**
 * A sample cell as text. Canonical EJSON wrappers show as the plain value, so a number or a date
 * reads the way it does in the file. Other objects show as JSON.
 */
export function cellText(value: unknown): string {
  if (value === undefined) {
    return '';
  }
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'object' && !Array.isArray(value)) {
    const unwrapped = unwrapEjson(value as Record<string, unknown>);
    if (unwrapped !== undefined) {
      return unwrapped;
    }
  }
  return JSON.stringify(value);
}

const NUMBER_WRAPPERS = ['$numberDouble', '$numberInt', '$numberLong', '$numberDecimal', '$oid'];

function unwrapEjson(value: Record<string, unknown>): string | undefined {
  const entries = Object.entries(value);
  const [entry] = entries;
  if (entries.length !== 1 || entry === undefined) {
    return undefined;
  }
  const [key, inner] = entry;
  if (NUMBER_WRAPPERS.includes(key) && typeof inner === 'string') {
    return inner;
  }
  if (key !== '$date') {
    return undefined;
  }
  if (typeof inner === 'string') {
    return inner;
  }
  const millis =
    typeof inner === 'object' && inner !== null
      ? (inner as Record<string, unknown>)['$numberLong']
      : undefined;
  if (typeof millis === 'string' && Number.isFinite(Number(millis))) {
    return new Date(Number(millis)).toISOString();
  }
  return undefined;
}
