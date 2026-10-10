import type { ChangeEvent, ChangeTarget } from '@mongo-gui/core';

/** Rows the renderer keeps. Past this, the oldest rows go. */
export const CHANGE_ROW_CAP = 5000;

export type FullDocumentMode = 'default' | 'updateLookup' | 'whenAvailable' | 'required';
export type FullDocumentBeforeMode = 'off' | 'whenAvailable' | 'required';
export type ChangeOrder = 'newest' | 'oldest';

export const FULL_DOCUMENT_LABELS: Readonly<Record<FullDocumentMode, string>> = {
  default: 'Default',
  updateLookup: 'Update lookup',
  whenAvailable: 'When available',
  required: 'Required',
};

export const FULL_DOCUMENT_BEFORE_LABELS: Readonly<Record<FullDocumentBeforeMode, string>> = {
  off: 'Off',
  whenAvailable: 'When available',
  required: 'Required',
};

/** One event as the list shows it. The key is unique across watches, because event ids restart. */
export interface ChangeRow {
  readonly key: string;
  readonly event: ChangeEvent;
}

export function rowKeyOf(watchId: string, event: ChangeEvent): string {
  return `${watchId}:${event.id}`;
}

/**
 * Appends rows in arrival order and keeps the newest `cap`. Returns how many oldest rows went
 * out of the list.
 */
export function appendRows(
  rows: readonly ChangeRow[],
  incoming: readonly ChangeRow[],
  cap: number = CHANGE_ROW_CAP,
): { readonly rows: readonly ChangeRow[]; readonly trimmed: number } {
  const all = incoming.length === 0 ? rows : [...rows, ...incoming];
  const trimmed = Math.max(0, all.length - cap);
  return { rows: trimmed === 0 ? all : all.slice(trimmed), trimmed };
}

/** Rows up to and including the one with the key. Used when a watch restarts from that row. */
export function rowsThrough(
  rows: readonly ChangeRow[],
  key: string,
): readonly ChangeRow[] | undefined {
  const index = rows.findIndex((row) => row.key === key);
  return index < 0 ? undefined : rows.slice(0, index + 1);
}

/** The rows in display order, filtered by the text. Matching is case insensitive. */
export function visibleRows(
  rows: readonly ChangeRow[],
  order: ChangeOrder,
  filter: string,
): readonly ChangeRow[] {
  const needle = filter.trim().toLowerCase();
  const matching =
    needle === ''
      ? rows
      : rows.filter((row) => searchTextOf(row.event).toLowerCase().includes(needle));
  return order === 'newest' ? [...matching].reverse() : matching;
}

/** The text the filter searches: namespace, operation and document key. */
export function searchTextOf(event: ChangeEvent): string {
  return [namespaceText(event), event.operationType, event.documentKeyEjson ?? ''].join(' ');
}

export function namespaceText(event: ChangeEvent): string {
  if (event.ns === undefined) {
    return '';
  }
  return event.ns.coll === undefined ? event.ns.db : `${event.ns.db}.${event.ns.coll}`;
}

export function targetKeyOf(target: ChangeTarget): string {
  switch (target.kind) {
    case 'deployment':
      return 'deployment';
    case 'database':
      return `database:${target.database}`;
    case 'collection':
      return `collection:${target.database}.${target.collection}`;
  }
}

export function targetLabelOf(target: ChangeTarget): string {
  switch (target.kind) {
    case 'deployment':
      return 'Deployment';
    case 'database':
      return `Database ${target.database}`;
    case 'collection':
      return `Collection ${target.database}.${target.collection}`;
  }
}

/** Why the pipeline text cannot start a watch, or undefined when it can. Empty means no stages. */
export function pipelineProblem(text: string): string | undefined {
  if (text.trim() === '') {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return 'The pipeline is not valid JSON.';
  }
  return Array.isArray(parsed) ? undefined : 'The pipeline must be an array of stages.';
}

/** Why the resume token text cannot be used, or undefined. Empty means start from now. */
export function resumeTokenProblem(text: string): string | undefined {
  if (text.trim() === '') {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? undefined
      : 'The resume token must be a JSON document, for example {"_data": "..."}.';
  } catch {
    return 'The resume token is not valid JSON.';
  }
}

/** Mantine colour of an operation badge. Unknown operations are grey. */
export function operationColor(operationType: string): string {
  switch (operationType) {
    case 'insert':
      return 'green';
    case 'update':
      return 'blue';
    case 'replace':
      return 'violet';
    case 'delete':
    case 'dropDatabase':
      return 'red';
    case 'drop':
    case 'rename':
      return 'orange';
    default:
      return 'gray';
  }
}

const SUMMARY_LIMIT = 80;

/** A short form of the document key for a row. Long keys end with an ellipsis. */
export function keySummaryOf(documentKeyEjson: string | undefined): string {
  if (documentKeyEjson === undefined) {
    return '';
  }
  const compact = documentKeyEjson.replace(/\s+/g, ' ');
  return compact.length <= SUMMARY_LIMIT ? compact : `${compact.slice(0, SUMMARY_LIMIT - 1)}…`;
}

/** Local time with milliseconds. An event without a wall time shows a dash. */
export function wallTimeText(wallTime: string | undefined): string {
  if (wallTime === undefined) {
    return '-';
  }
  const date = new Date(wallTime);
  if (Number.isNaN(date.getTime())) {
    return '-';
  }
  const time = date.toLocaleTimeString(undefined, { hour12: false });
  return `${time}.${String(date.getMilliseconds()).padStart(3, '0')}`;
}
