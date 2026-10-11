import {
  cellView,
  discoverColumns,
  isPlainObject,
  valueAtPath,
  wrapperKey,
  type ColumnDef,
  type JsonObject,
} from './result-model';

export type ExportFormat = 'json' | 'csv';

/** The file extension and the dialog name of each export format. */
export const EXPORT_FORMATS: Readonly<Record<ExportFormat, { extension: string; name: string }>> = {
  json: { extension: 'json', name: 'JSON' },
  csv: { extension: 'csv', name: 'CSV' },
};

/**
 * The export text in pieces, so a stream can write one document at a time. JSON is a canonical
 * EJSON array, so every number keeps its type. CSV has one column per flattened path, in
 * first-seen order, and one row per document. The head comes first, then one row per document in
 * order, then the tail. `count` is the number of documents the export holds.
 */
export function exportHead(format: ExportFormat, columns: readonly ColumnDef[], count: number) {
  if (format === 'json') {
    return count === 0 ? '[]' : '[\n';
  }
  return `${columns.map((column) => csvCell(column.path)).join(',')}\n`;
}

/** The text of the document at `index`: an indented array element, or a CSV line. */
export function exportRow(
  format: ExportFormat,
  columns: readonly ColumnDef[],
  document: JsonObject,
  index: number,
): string {
  if (format === 'json') {
    const element = `  ${JSON.stringify(document, null, 2).replaceAll('\n', '\n  ')}`;
    return index === 0 ? element : `,\n${element}`;
  }
  const cells = columns.map((column) => csvCell(cellTextOf(valueAtPath(document, column.path))));
  return `${cells.join(',')}\n`;
}

export function exportTail(format: ExportFormat, count: number): string {
  return format === 'json' && count > 0 ? '\n]' : '';
}

/** The documents as one text: the head, every row and the tail joined. */
export function exportText(documents: readonly JsonObject[], format: ExportFormat): string {
  const columns = format === 'csv' ? discoverColumns(documents) : [];
  const count = documents.length;
  return (
    exportHead(format, columns, count) +
    documents.map((document, index) => exportRow(format, columns, document, index)).join('') +
    exportTail(format, count)
  );
}

/** The text of a streamed export goes out in parts of about this many characters. */
export const EXPORT_PART_CHARS = 1024 * 1024;

export type ExportPart = 'only' | 'first' | 'next' | 'last';

/**
 * Collects text and hands it to `write` in parts of `EXPORT_PART_CHARS`, so no string of the whole
 * file exists. A part is held back until the next one arrives, because only then is it known
 * whether it is the last. A text that fits one part is written as 'only'. After a failed `write`,
 * call `abort` so the half-written file is removed.
 */
export function createExportSink(write: (content: string, part: ExportPart) => Promise<void>) {
  let buffer = '';
  let held: string | undefined;
  let started = false;

  async function release(next: string): Promise<void> {
    if (held !== undefined) {
      const part = started ? 'next' : 'first';
      started = true;
      await write(held, part);
    }
    held = next;
  }

  return {
    async push(text: string): Promise<void> {
      buffer += text;
      let offset = 0;
      while (buffer.length - offset >= EXPORT_PART_CHARS) {
        let end = offset + EXPORT_PART_CHARS;
        // A cut between the halves of a surrogate pair would corrupt the character on disk.
        const lastUnit = buffer.charCodeAt(end - 1);
        if (lastUnit >= 0xd800 && lastUnit <= 0xdbff) {
          end -= 1;
        }
        await release(buffer.slice(offset, end));
        offset = end;
      }
      buffer = buffer.slice(offset);
    },
    async finish(): Promise<void> {
      if (buffer !== '' || held === undefined) {
        await release(buffer);
      }
      buffer = '';
      if (held !== undefined) {
        const content = held;
        held = undefined;
        await write(content, started ? 'last' : 'only');
      }
    },
    /** True once the main process holds a part, so a failure must remove the partial file. */
    get started(): boolean {
      return started;
    },
  };
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
