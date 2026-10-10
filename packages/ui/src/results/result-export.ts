import {
  cellView,
  discoverColumns,
  isPlainObject,
  valueAtPath,
  wrapperKey,
  type JsonObject,
} from './result-model';
import { jsonTextFor } from './json-text';

export type ExportFormat = 'json' | 'csv';

/** The file extension and the dialog name of each export format. */
export const EXPORT_FORMATS: Readonly<Record<ExportFormat, { extension: string; name: string }>> = {
  json: { extension: 'json', name: 'JSON' },
  csv: { extension: 'csv', name: 'CSV' },
};

/**
 * The documents as text. JSON is a canonical EJSON array, so every number keeps its type. CSV has
 * one column per flattened path, in first-seen order, and one row per document.
 */
export function exportText(documents: readonly JsonObject[], format: ExportFormat): string {
  if (format === 'json') {
    return jsonTextFor({ documents }, 'canonical');
  }
  const columns = discoverColumns(documents);
  const lines = [columns.map((column) => csvCell(column.path)).join(',')];
  for (const document of documents) {
    lines.push(
      columns.map((column) => csvCell(cellTextOf(valueAtPath(document, column.path)))).join(','),
    );
  }
  return `${lines.join('\n')}\n`;
}

/** A value as one CSV cell: the mongosh form for BSON values, JSON for arrays and objects. */
function cellTextOf(value: unknown): string {
  if (value === undefined) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value) || (isPlainObject(value) && wrapperKey(value) === undefined)) {
    return JSON.stringify(value);
  }
  // The shown text may be shortened, so the full text comes from the title when there is one.
  const view = cellView(value);
  return view.title ?? view.text;
}

/** Quotes a cell that holds a comma, a quote or a line break. Quotes inside double up. */
function csvCell(text: string): string {
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
