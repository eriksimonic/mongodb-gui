import type { CompletionItem, CompletionKind } from '@mongo-gui/core';

// The mongosh completer returns plain strings, so the kind comes from the shape of each string:
// a $-operator, a collection under db, or a shell or JavaScript keyword. Methods and properties
// cannot be told apart without evaluating the expression, so they fall back to "other".
const KEYWORDS: ReadonlySet<string> = new Set([
  'show',
  'use',
  'it',
  'help',
  'exit',
  'quit',
  'print',
  'printjson',
  'load',
  'sleep',
  'cls',
  'clear',
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'default',
  'delete',
  'do',
  'else',
  'finally',
  'for',
  'function',
  'if',
  'import',
  'in',
  'instanceof',
  'let',
  'new',
  'return',
  'switch',
  'throw',
  'try',
  'typeof',
  'var',
  'void',
  'while',
  'yield',
  'await',
  'async',
]);

const TRAILING_WORD = /([$A-Za-z_][\w$]*)$/;
const DB_MEMBER = /^db\.([A-Za-z_][\w$]*)$/;

export function classifyCompletion(
  text: string,
  collectionNames: ReadonlySet<string>,
): CompletionKind {
  const word = TRAILING_WORD.exec(text)?.[1] ?? '';
  if (word.startsWith('$')) {
    return 'operator';
  }
  const member = databaseMemberName(text);
  if (member !== undefined && collectionNames.has(member)) {
    return 'collection';
  }
  if (KEYWORDS.has(text)) {
    return 'keyword';
  }
  return 'other';
}

// The name in a completion of the form db.<name>, or undefined for any other text.
export function databaseMemberName(text: string): string | undefined {
  return DB_MEMBER.exec(text)?.[1];
}

// The part of the line that holds the cursor. The completer works on one line at a time.
export function lineBeforeCursor(code: string, position: number): string {
  const end = Math.min(Math.max(position, 0), code.length);
  const before = code.slice(0, end);
  return before.slice(before.lastIndexOf('\n') + 1);
}

const DB_PREFIX = /(^|[^\w$.])db\.([A-Za-z_$][\w$]*)?$/;
const IDENTIFIER_NAME = /^[A-Za-z_$][\w$]*$/;

// True for a line that ends in db. and an optional identifier prefix, the form that completes
// collection names.
export function isDatabaseMemberLine(line: string): boolean {
  return DB_PREFIX.test(line);
}

// The last member after db. in a runtime text, when the text ends in one. "db.my-coll" ends in
// "my-coll", and "db.users.find" ends in "find" after a dot, so it has no db member at the end.
const TRAILING_DB_MEMBER = /(^|[^\w$.])db\.([^.]*)$/;

// True for a runtime text whose trailing db member is not a property name, such as "db.my-coll".
// Inserting that text makes invalid JavaScript, so the session drops it. collectionMemberItems
// offers the db.getCollection form for the collection instead.
export function hasInvalidDatabaseMember(text: string): boolean {
  const member = TRAILING_DB_MEMBER.exec(text)?.[2];
  return member !== undefined && member !== '' && !IDENTIFIER_NAME.test(member);
}

// Completions for a line that ends in db. and an optional identifier prefix. The mongosh completer
// may list collections late or not at all, so the session adds one whole-line item per collection.
// Names that are not identifiers go through db.getCollection. Texts the runtime already returned
// are skipped. Returns no items for any other line.
export function collectionMemberItems(
  line: string,
  collectionNames: readonly string[],
  runtimeTexts: ReadonlySet<string>,
): CompletionItem[] {
  const match = DB_PREFIX.exec(line);
  if (match === null) {
    return [];
  }
  const head = line.slice(0, match.index + (match[1] ?? '').length);
  const items: CompletionItem[] = [];
  const seen = new Set<string>();
  for (const name of collectionNames) {
    const text = IDENTIFIER_NAME.test(name)
      ? `${head}db.${name}`
      : `${head}db.getCollection(${JSON.stringify(name)})`;
    if (runtimeTexts.has(text) || seen.has(text)) {
      continue;
    }
    seen.add(text);
    items.push({ text, kind: 'collection' });
  }
  return items;
}
