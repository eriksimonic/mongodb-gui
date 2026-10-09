import type { CompletionItem, CompletionKind, SchemaField } from '@mongo-gui/core';
import { QUERY_OPERATORS } from './operators';
import { statementAt } from './statements';

/** An item the editor shows. The provider maps `kind` to the Monaco icon. */
export interface EditorCompletion {
  readonly label: string;
  readonly kind: CompletionKind;
  readonly detail?: string | undefined;
  readonly doc?: string | undefined;
  /** Lower sorts first. Items from the runtime come before the static lists. */
  readonly rank: number;
}

export interface CompletionContext {
  /** The word being typed, including a leading `$`. */
  readonly prefix: string;
  /** The collection of the nearest `db.<name>` in the same statement, when there is one. */
  readonly collection: string | undefined;
}

const WORD_BEFORE = /[A-Za-z0-9_$]*$/;
const COLLECTION_REF = /\bdb\.([A-Za-z_][A-Za-z0-9_]*)\b/g;

/** The word before the cursor and the collection the statement names. */
export function completionContext(code: string, offset: number): CompletionContext {
  const before = code.slice(0, offset);
  const prefix = WORD_BEFORE.exec(before)?.[0] ?? '';
  const statement = statementAt(code, offset);
  const scope =
    statement === undefined ? '' : code.slice(statement.start, Math.min(offset, statement.end));
  return { prefix, collection: lastCollection(scope) };
}

/** The collection named by the last `db.<name>` in the text, skipping the database's own methods. */
export function lastCollection(text: string): string | undefined {
  let found: string | undefined;
  for (const match of text.matchAll(COLLECTION_REF)) {
    const name = match[1] ?? '';
    if (!DATABASE_MEMBERS.has(name)) {
      found = name;
    }
  }
  return found;
}

/** Database members that are not collection names when they follow `db.`. */
const DATABASE_MEMBERS = new Set([
  'getCollection',
  'getName',
  'getSiblingDB',
  'runCommand',
  'adminCommand',
  'createCollection',
  'createView',
  'dropDatabase',
  'getCollectionNames',
  'getCollectionInfos',
  'stats',
  'serverStatus',
  'version',
]);

/** Field completions from a sample. Dotted paths keep their dots, and array elements are not split. */
export function fieldCompletions(fields: readonly SchemaField[]): EditorCompletion[] {
  return fields.map((field) => ({
    label: field.path,
    kind: 'property',
    detail: field.types.join(' | '),
    doc: `Present in ${Math.round(field.presence * 100)} percent of the sampled documents.`,
    rank: 2,
  }));
}

/** Operator completions. They match a prefix that starts with `$`, and every operator matches an empty prefix. */
export function operatorCompletions(): EditorCompletion[] {
  return QUERY_OPERATORS.map((operator) => ({
    label: operator.name,
    kind: 'operator',
    doc: operator.doc,
    rank: 3,
  }));
}

/** Items the runtime returned, in their own order. */
export function runtimeCompletions(items: readonly CompletionItem[]): EditorCompletion[] {
  return items.map((item) => ({ label: item.text, kind: item.kind, rank: 1 }));
}

/**
 * Merges the sources and keeps the ones that match the prefix. A prefix that starts with `$` shows
 * operators first. Labels that appear twice keep their first entry. Matching is case-insensitive
 * and prefix-based.
 */
export function mergeCompletions(
  prefix: string,
  sources: readonly (readonly EditorCompletion[])[],
  limit = 200,
): EditorCompletion[] {
  const needle = prefix.toLowerCase();
  const seen = new Set<string>();
  const matches: EditorCompletion[] = [];
  for (const item of sources.flat()) {
    if (!item.label.toLowerCase().startsWith(needle) || seen.has(item.label)) {
      continue;
    }
    seen.add(item.label);
    matches.push(item);
  }
  const dollar = prefix.startsWith('$');
  return matches
    .sort((a, b) => {
      const operatorA = a.kind === 'operator' ? 0 : 1;
      const operatorB = b.kind === 'operator' ? 0 : 1;
      if (dollar && operatorA !== operatorB) {
        return operatorA - operatorB;
      }
      return a.rank - b.rank || a.label.localeCompare(b.label);
    })
    .slice(0, limit);
}
