import type { CompletionKind } from '@mongo-gui/core';

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
