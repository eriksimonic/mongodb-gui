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
  /** The text inserted in place of the prefix. Defaults to the label. */
  readonly insertText?: string | undefined;
}

export interface CompletionContext {
  /** The word being typed, including a leading `$`. */
  readonly prefix: string;
  /** The collection of the nearest `db.<name>` in the same statement, when there is one. */
  readonly collection: string | undefined;
  /** The text of the line before the prefix. Runtime completion texts start with it. */
  readonly head: string;
  /** The cursor sits right after `db.<name>.`, where only the collection's methods apply. */
  readonly memberOfCollection: boolean;
  /** The cursor sits where an object key starts, after `{` or `,`. Operators and quoted keys apply here. */
  readonly objectKey: boolean;
}

const WORD_BEFORE = /[A-Za-z0-9_$]*$/;
// Matches db.getCollection("<name>"), db["<name>"] and db.<name>, in that order, because the
// identifier form also matches db.getCollection. Groups 2 and 4 hold the quoted names and group 5
// holds the identifier.
const COLLECTION_REF =
  /\bdb\.getCollection\(\s*(['"])([^'"]+)\1\s*\)|\bdb\[\s*(['"])([^'"]+)\3\s*\]|\bdb\.([A-Za-z_][A-Za-z0-9_]*)\b/g;

/** The word before the cursor, the line text before that word, and the collection the statement names. */
export function completionContext(code: string, offset: number): CompletionContext {
  const lineStart = offset > 0 ? code.lastIndexOf('\n', offset - 1) + 1 : 0;
  const lineBefore = code.slice(lineStart, offset);
  const prefix = WORD_BEFORE.exec(lineBefore)?.[0] ?? '';
  const head = lineBefore.slice(0, lineBefore.length - prefix.length);
  const statement = statementAt(code, offset);
  const scope =
    statement === undefined ? '' : code.slice(statement.start, Math.min(offset, statement.end));
  return {
    prefix,
    collection: lastCollection(scope),
    head,
    memberOfCollection: /\bdb\.[A-Za-z_][A-Za-z0-9_]*\.$/.test(head),
    objectKey: /[{,]\s*$/.test(head),
  };
}

/**
 * The collection named by the last `db.<name>`, `db.getCollection("<name>")` or `db["<name>"]` in
 * the text. Dotted database methods such as `db.getName` are skipped.
 */
export function lastCollection(text: string): string | undefined {
  let found: string | undefined;
  for (const match of text.matchAll(COLLECTION_REF)) {
    const quoted = match[2] ?? match[4];
    if (quoted !== undefined) {
      found = quoted;
      continue;
    }
    const name = match[5] ?? '';
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

/**
 * Field completions from a sample. Dotted paths keep their dots, and array elements are not split.
 * In an object key a dotted path is quoted, because `a.b` as a bare key is not valid JavaScript.
 */
export function fieldCompletions(
  fields: readonly SchemaField[],
  objectKey = false,
): EditorCompletion[] {
  return fields.map((field) => ({
    label: field.path,
    kind: 'property',
    detail: field.types.join(' | '),
    doc: `Present in ${Math.round(field.presence * 100)} percent of the sampled documents.`,
    rank: 2,
    ...(objectKey && field.path.includes('.') ? { insertText: `"${field.path}"` } : {}),
  }));
}

/**
 * Operator completions. They match a prefix that starts with `$`, and they appear where an object
 * key starts. Elsewhere they are noise.
 */
export function operatorCompletions(): EditorCompletion[] {
  return QUERY_OPERATORS.map((operator) => ({
    label: operator.name,
    kind: 'operator',
    doc: operator.doc,
    rank: 3,
  }));
}

/** The operators that fit the cursor: all of them after a `$`, and in an object key. */
export function operatorsFor(context: CompletionContext): EditorCompletion[] {
  return context.prefix.startsWith('$') || context.objectKey ? operatorCompletions() : [];
}

/**
 * Runtime completions turned into the part to insert. The runtime returns whole-line texts, such as
 * `db.orders.find` for `db.orders.fi`. The part after `head` is the completion. Texts that do not
 * start with `head` belong to another position, so they are dropped.
 */
export function runtimeCompletions(
  items: readonly CompletionItem[],
  head: string,
): EditorCompletion[] {
  const result: EditorCompletion[] = [];
  for (const item of items) {
    if (!item.text.startsWith(head)) {
      continue;
    }
    const label = item.text.slice(head.length);
    if (label.length > 0) {
      result.push({ label, kind: item.kind, rank: 1 });
    }
  }
  return result;
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
