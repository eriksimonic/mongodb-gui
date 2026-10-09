import { formatJson } from './input-rules';

const CELL_LIMIT = 80;
const ID_FIELD = '_id';

/** One sampled document, ready for the table and the editor. */
export interface DocumentRow {
  /** Canonical EJSON of the `_id`. Sent back as-is to replace, delete or find the document. */
  readonly idEjson: string;
  /** Top-level fields other than `_id`, as display text, keyed by field name. */
  readonly fields: Readonly<Record<string, string>>;
  /** The whole document as pretty EJSON, for the editor. */
  readonly text: string;
  readonly document: Readonly<Record<string, unknown>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Text for a table cell. Long values are cut so one row stays on one line. */
export function cellText(value: unknown): string {
  if (value === undefined) {
    return '';
  }
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text === undefined) {
    return '';
  }
  return text.length > CELL_LIMIT ? `${text.slice(0, CELL_LIMIT - 1)}…` : text;
}

/** Reads one EJSON document string. Returns undefined when the text is not a JSON object. */
export function toDocumentRow(documentEjson: string): DocumentRow | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(documentEjson);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || !(ID_FIELD in parsed)) {
    return undefined;
  }
  const fields = Object.fromEntries(
    Object.entries(parsed)
      .filter(([key]) => key !== ID_FIELD)
      .map(([key, value]) => [key, cellText(value)]),
  );
  return {
    idEjson: JSON.stringify(parsed[ID_FIELD]),
    fields,
    text: formatJson(parsed),
    document: parsed,
  };
}

/** Top-level field names across the rows, in first-seen order, without `_id`. */
export function columnsOf(rows: readonly DocumentRow[]): string[] {
  const seen = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row.fields)) {
      seen.add(key);
    }
  }
  return [...seen];
}

/** Top-level field names of raw documents, with `_id` removed. Used for field suggestions. */
export function topLevelKeys(documentEjsons: readonly string[]): string[] {
  const keys = new Set<string>();
  for (const text of documentEjsons) {
    const row = toDocumentRow(text);
    if (row !== undefined) {
      for (const key of Object.keys(row.document)) {
        if (key !== ID_FIELD) {
          keys.add(key);
        }
      }
    }
  }
  return [...keys].sort();
}

/** The editor text for a duplicate: the document without its `_id`, so the server makes a new one. */
export function duplicateText(row: DocumentRow): string {
  const withoutId = Object.fromEntries(
    Object.entries(row.document).filter(([key]) => key !== ID_FIELD),
  );
  return formatJson(withoutId);
}
