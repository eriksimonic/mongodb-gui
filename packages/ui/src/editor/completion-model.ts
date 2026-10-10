import type { CompletionItem, CompletionKind, SchemaField } from '@mongo-gui/core';
import { BSON_CONSTRUCTORS, CURSOR_METHODS, QUERY_OPERATORS } from './operators';
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
  /** True when `insertText` is a snippet with `$1` placeholders. */
  readonly snippet?: boolean | undefined;
}

export interface CompletionContext {
  /** The word being typed, including a leading `$`. */
  readonly prefix: string;
  /** The collection of the nearest `db.<name>` in the same statement, when there is one. */
  readonly collection: string | undefined;
  /**
   * The statement text before the prefix, with line breaks folded to one space, so a statement
   * that spans lines reads as one line. Runtime completion texts start with it.
   */
  readonly head: string;
  /** The cursor sits right after `db.<name>.`, where only the collection's methods apply. */
  readonly memberOfCollection: boolean;
  /** The cursor sits where an object key starts, after `{` or `,`. Operators and quoted keys apply here. */
  readonly objectKey: boolean;
  /** The key being typed is already inside quotes, so a dotted path needs no quotes added. */
  readonly quotedKey: boolean;
  /** The dotted path typed before the prefix in a key, such as `customer` in `customer.na`. */
  readonly fieldParent: string | undefined;
  /** The cursor sits where a value starts: after `:`, `(` or `[`. Constructors apply here. */
  readonly valuePosition: boolean;
  /** The cursor follows `)` and a dot in a statement that opened a cursor, so cursor methods apply. */
  readonly cursorMember: boolean;
}

const WORD_BEFORE = /[A-Za-z0-9_$]*$/;
// Matches db.getCollection("<name>"), db["<name>"] and db.<name>, in that order, because the
// identifier form also matches db.getCollection. Groups 2 and 4 hold the quoted names and group 5
// holds the identifier.
const COLLECTION_REF =
  /\bdb\.getCollection\(\s*(['"])([^'"]+)\1\s*\)|\bdb\[\s*(['"])([^'"]+)\3\s*\]|\bdb\.([A-Za-z_][A-Za-z0-9_]*)\b/g;

const KEY_START = /[{,]\s*$/;
const QUOTED_KEY_START = /[{,]\s*["']$/;
// A dotted path before the prefix, such as `customer.address.`, where it starts a key.
const DOTTED_KEY = /[{,]\s*["']?([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\.$/;
const CURSOR_CALL = /\.(?:find|aggregate|listCollections|listIndexes|watch)\s*\(/;

/**
 * The word before the cursor, the statement text before that word on one line, and what the
 * cursor position accepts. The statement text is used instead of the current line so a
 * statement that spans lines, such as a chained `.sort({` on its own line, keeps its context.
 */
export function completionContext(code: string, offset: number): CompletionContext {
  const lineStart = offset > 0 ? code.lastIndexOf('\n', offset - 1) + 1 : 0;
  const lineBefore = code.slice(lineStart, offset);
  const prefix = WORD_BEFORE.exec(lineBefore)?.[0] ?? '';
  const statement = statementAt(code, offset);
  const scope =
    statement === undefined
      ? lineBefore
      : code.slice(statement.start, Math.min(offset, statement.end));
  // Earlier lines join the head only while they leave a bracket open or end in a chain dot.
  // Otherwise a line such as `use shop` above the cursor would read as part of the statement.
  const earlier = scope.slice(0, Math.max(0, scope.length - lineBefore.length));
  const joined = continuesOnNextLine(earlier) ? scope : lineBefore;
  const head = foldLines(joined.slice(0, Math.max(0, joined.length - prefix.length)));
  const dotted = DOTTED_KEY.exec(head);
  const objectKey = KEY_START.test(head) || QUOTED_KEY_START.test(head) || dotted !== null;
  return {
    prefix,
    collection: lastCollection(scope),
    head,
    memberOfCollection: /\bdb\.[A-Za-z_][A-Za-z0-9_]*\.$/.test(head),
    objectKey,
    quotedKey: QUOTED_KEY_START.test(head) || /["'][\w$.]*\.$/.test(head),
    fieldParent: dotted?.[1],
    valuePosition: /[:([]\s*$/.test(head),
    cursorMember: /\)\s*\.\s*$/.test(head) && CURSOR_CALL.test(head),
  };
}

/** True when text leaves a `(`, `{` or `[` open, or ends with a `.` or `,`, so the next line continues it. */
function continuesOnNextLine(text: string): boolean {
  let depth = 0;
  for (const char of text) {
    if (char === '(' || char === '{' || char === '[') {
      depth += 1;
    } else if (char === ')' || char === '}' || char === ']') {
      depth -= 1;
    }
  }
  return depth > 0 || /[.,]\s*$/.test(text);
}

/** One line from text that may span lines: each line break and its surrounding spaces become one space. */
function foldLines(text: string): string {
  return text.replace(/\s*\n\s*/g, ' ');
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

/** The rank of a top-level field. Each level of nesting adds one, so shallow paths list first. */
const FIELD_RANK = 2;

/**
 * Field completions from a sample. Dotted paths keep their dots, and array elements are not split.
 * In an object key a dotted path is quoted, because `a.b` as a bare key is not valid JavaScript.
 * A deeper path ranks below a shallower one, so a collection with a large map, such as thousands
 * of `definitions.<id>.*` paths, still lists its top-level fields before the cap cuts the list.
 */
export function fieldCompletions(
  fields: readonly SchemaField[],
  objectKey = false,
  options: { readonly parent?: string | undefined; readonly quoted?: boolean } = {},
): EditorCompletion[] {
  const parentPrefix = options.parent === undefined ? undefined : `${options.parent}.`;
  const result: EditorCompletion[] = [];
  for (const field of fields) {
    if (parentPrefix !== undefined && !field.path.startsWith(parentPrefix)) {
      continue;
    }
    const label = parentPrefix === undefined ? field.path : field.path.slice(parentPrefix.length);
    const quote =
      objectKey && parentPrefix === undefined && options.quoted !== true && label.includes('.');
    result.push({
      label,
      kind: 'property',
      detail: field.types.join(' | '),
      doc: `Present in ${Math.round(field.presence * 100)} percent of the sampled documents.`,
      rank: FIELD_RANK + pathDepth(label),
      ...(quote ? { insertText: `"${label}"` } : {}),
    });
  }
  return result;
}

/**
 * Completions that do not depend on the runtime or on a sample: the cursor methods after a
 * `find(...)` or `aggregate(...)` chain, and the BSON constructors where a value starts. The
 * runtime completer sees one line and no cursor type, so these fill what it misses.
 */
export function staticCompletionsFor(context: CompletionContext): EditorCompletion[] {
  const result: EditorCompletion[] = [];
  if (context.cursorMember) {
    for (const method of CURSOR_METHODS) {
      result.push({ label: method.name, kind: 'method', doc: method.doc, rank: 1 });
    }
  }
  if (context.valuePosition && !context.objectKey) {
    for (const constructor of BSON_CONSTRUCTORS) {
      result.push({
        label: constructor.name,
        kind: 'method',
        detail: 'BSON',
        doc: constructor.doc,
        rank: 3,
        insertText: constructor.snippet,
        snippet: true,
      });
    }
  }
  return result;
}

/** The number of dots in a path, so `a.b.c` is 2 and `a` is 0. */
function pathDepth(path: string): number {
  let depth = 0;
  for (const char of path) {
    if (char === '.') {
      depth += 1;
    }
  }
  return depth;
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
 * The most completions one request returns. The editor filters the list as the user types, without
 * asking again, so a list cut here hides fields for the rest of the word. The cap stays above the
 * field count of most collections and below what makes the suggest widget slow.
 */
export const COMPLETION_LIMIT = 1000;

/**
 * Merges the sources and keeps the ones that match the prefix. A prefix that starts with `$` shows
 * operators first. Labels that appear twice keep their first entry. Matching is case-insensitive
 * and prefix-based. Items with a lower rank come first, then the labels sort alphabetically.
 */
export function mergeCompletions(
  prefix: string,
  sources: readonly (readonly EditorCompletion[])[],
  limit = COMPLETION_LIMIT,
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
