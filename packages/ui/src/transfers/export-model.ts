import type { CsvDelimiter, ExportFormat, ExportOptions } from '@mongo-gui/core';

export interface ExportDraft {
  readonly format: ExportFormat;
  readonly ejsonMode: 'canonical' | 'relaxed';
  readonly filter: string;
  readonly projection: string;
  readonly sort: string;
  /** Empty means no limit. */
  readonly limit: string;
  readonly delimiter: CsvDelimiter;
  readonly flattenArrays: 'json' | 'join';
  /** Column names, in order. Empty lets the export discover them from the documents. */
  readonly columns: readonly string[];
  readonly path: string;
}

export const DEFAULT_EXPORT_DRAFT: ExportDraft = {
  format: 'ndjson',
  ejsonMode: 'canonical',
  filter: '',
  projection: '',
  sort: '',
  limit: '',
  delimiter: ',',
  flattenArrays: 'json',
  columns: [],
  path: '',
};

export type FieldCheck =
  | { readonly ok: true; readonly value: string | undefined }
  | { readonly ok: false; readonly message: string };

/**
 * Checks an EJSON object field with a plain JSON parse. The backend reads the same text with its
 * EJSON parser, which also accepts $oid, $date and the other wrappers. Empty text means unset.
 */
export function checkEjsonObject(label: string, text: string): FieldCheck {
  const trimmed = text.trim();
  if (trimmed === '') {
    return { ok: true, value: undefined };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    const reason = error instanceof SyntaxError ? error.message : 'the text is not JSON';
    return { ok: false, message: `${label} is not valid extended JSON: ${reason}` };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, message: `${label} must be a JSON object` };
  }
  return { ok: true, value: trimmed };
}

/** A whole number above zero, or empty for no limit. */
export function checkLimit(text: string): FieldCheck {
  const trimmed = text.trim();
  if (trimmed === '') {
    return { ok: true, value: undefined };
  }
  const number = Number(trimmed);
  if (!Number.isInteger(number) || number < 1) {
    return { ok: false, message: 'The limit is a whole number above zero' };
  }
  return { ok: true, value: trimmed };
}

export interface ExportProblem {
  readonly field: 'filter' | 'projection' | 'sort' | 'limit' | 'path';
  readonly message: string;
}

/** Every problem with the draft, in the order the form shows the fields. */
export function exportProblemsOf(draft: ExportDraft): ExportProblem[] {
  const problems: ExportProblem[] = [];
  const checks: [ExportProblem['field'], FieldCheck][] = [
    ['filter', checkEjsonObject('The filter', draft.filter)],
    ['projection', checkEjsonObject('The projection', draft.projection)],
    ['sort', checkEjsonObject('The sort', draft.sort)],
    ['limit', checkLimit(draft.limit)],
  ];
  for (const [field, check] of checks) {
    if (!check.ok) {
      problems.push({ field, message: check.message });
    }
  }
  if (draft.path.trim() === '') {
    problems.push({ field: 'path', message: 'Choose where to save the file' });
  }
  return problems;
}

/**
 * The options the backend receives. Optional fields are left out when empty, so the backend
 * applies its own defaults.
 */
export function exportOptionsFor(draft: ExportDraft): ExportOptions {
  const columns = draft.columns.map((column) => column.trim()).filter((column) => column !== '');
  const limit = checkLimit(draft.limit);
  const filter = checkEjsonObject('The filter', draft.filter);
  const projection = checkEjsonObject('The projection', draft.projection);
  const sort = checkEjsonObject('The sort', draft.sort);
  return {
    format: draft.format,
    ejsonMode: draft.ejsonMode,
    ...(draft.format === 'csv'
      ? {
          csv: {
            delimiter: draft.delimiter,
            flattenArrays: draft.flattenArrays,
            ...(columns.length === 0 ? {} : { columns }),
          },
        }
      : {}),
    ...(filter.ok && filter.value !== undefined ? { filterEjson: filter.value } : {}),
    ...(projection.ok && projection.value !== undefined
      ? { projectionEjson: projection.value }
      : {}),
    ...(sort.ok && sort.value !== undefined ? { sortEjson: sort.value } : {}),
    ...(limit.ok && limit.value !== undefined ? { limit: Number(limit.value) } : {}),
  };
}
