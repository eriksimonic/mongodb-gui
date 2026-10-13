import type * as Monaco from 'monaco-editor/editor/editor.api';

export const MONGOSH_LANGUAGE = 'mongosh';

const SHELL_GLOBALS = [
  'db',
  'rs',
  'sh',
  'use',
  'show',
  'it',
  'print',
  'printjson',
  'ObjectId',
  'NumberLong',
  'NumberInt',
  'NumberDecimal',
  'Double',
  'ISODate',
  'UUID',
  'BinData',
  'Timestamp',
  'MinKey',
  'MaxKey',
  'Code',
  'DBRef',
];

const KEYWORDS = [
  'var',
  'let',
  'const',
  'function',
  'return',
  'if',
  'else',
  'for',
  'while',
  'do',
  'break',
  'continue',
  'new',
  'typeof',
  'in',
  'of',
  'true',
  'false',
  'null',
  'undefined',
  'async',
  'await',
  'try',
  'catch',
  'throw',
];

/**
 * The mongosh tokenizer. Token names the themes in editor-theme.ts color:
 *
 * - `property`: a key before a colon inside an object literal (`status:`, `'a.b':`), and an
 *   identifier after a dot that is not a call (`doc.status`).
 * - `function`: an identifier after a dot that a parenthesis follows (`.find(`, `.sort(`).
 * - `type`: the identifier right after `db.`, which is a collection (`db.orders`).
 * - `type.identifier`: a shell global such as `db` or `ObjectId`.
 * - `predefined`: an operator such as `$gt`, or a quoted key that starts with a dollar sign.
 *
 * Monarch keeps a stack of states, so the tokenizer knows where it is without lookbehind. `object`
 * is inside braces, where a word before a colon is a key. `expr` is inside parentheses or
 * brackets, where it is not. `ternary` starts at a `?` and ends at the `:` that closes it, so the
 * `:` of `a ? b : c` never makes `b` a key. A label at the top level (`outer: for`) stays plain,
 * because only the `object` state looks for keys.
 */
const IDENT = String.raw`[A-Za-z_$][\w$]*`;

export const MONGOSH_MONARCH = {
  keywords: KEYWORDS,
  shellGlobals: SHELL_GLOBALS,
  tokenizer: {
    root: [{ include: '@opens' }, { include: '@code' }],
    object: [
      [/"\$(?:[^"\\]|\\.)*"(?=\s*:)/, 'predefined'],
      [/'\$(?:[^'\\]|\\.)*'(?=\s*:)/, 'predefined'],
      [/"(?:[^"\\]|\\.)*"(?=\s*:)/, 'property'],
      [/'(?:[^'\\]|\\.)*'(?=\s*:)/, 'property'],
      [/[A-Za-z_][\w$]*(?=\s*:)/, 'property'],
      [/\}/, { token: '@brackets', next: '@pop' }],
      { include: '@opens' },
      { include: '@code' },
    ],
    expr: [
      [/[)\]]/, { token: '@brackets', next: '@pop' }],
      { include: '@opens' },
      { include: '@code' },
    ],
    ternary: [
      [/:/, { token: 'delimiter', next: '@pop' }],
      // A statement or a bracket ends an unfinished ternary without consuming the character.
      [/(?=[;)\]}])/, { token: '@rematch', next: '@pop' }],
      { include: '@opens' },
      { include: '@code' },
    ],
    opens: [
      [/\{/, { token: '@brackets', next: '@object' }],
      [/[([]/, { token: '@brackets', next: '@expr' }],
    ],
    code: [
      [/\/\/.*$/, 'comment'],
      [/\/\*/, 'comment', '@blockComment'],
      [/"/, 'string', '@doubleString'],
      [/'/, 'string', '@singleString'],
      [/`/, 'string', '@templateString'],
      [/\.\.\./, 'delimiter'],
      [/\?\?=?/, 'operator'],
      [new RegExp(`(\\?\\.)(${IDENT})(?=\\s*\\()`), ['operator', 'function']],
      [new RegExp(`(\\?\\.)(${IDENT})`), ['operator', 'property']],
      [/\?/, { token: 'operator', next: '@ternary' }],
      [new RegExp(`(db)(\\.)(${IDENT})(?=\\s*\\()`), ['type.identifier', 'delimiter', 'function']],
      [new RegExp(`(db)(\\.)(${IDENT})`), ['type.identifier', 'delimiter', 'type']],
      [new RegExp(`(\\.)(${IDENT})(?=\\s*\\()`), ['delimiter', 'function']],
      [new RegExp(`(\\.)(${IDENT})`), ['delimiter', 'property']],
      [/\$[A-Za-z_][A-Za-z0-9_$]*/, 'predefined'],
      [
        /[A-Za-z_][A-Za-z0-9_$]*/,
        {
          cases: {
            '@keywords': 'keyword',
            '@shellGlobals': 'type.identifier',
            '@default': 'identifier',
          },
        },
      ],
      [/\d+(\.\d+)?([eE][+-]?\d+)?/, 'number'],
      [/[{}()[\]]/, '@brackets'],
      [/[;,.:]/, 'delimiter'],
      [/[+\-*/%=<>!&|^~]+/, 'operator'],
      [/\s+/, 'white'],
    ],
    blockComment: [
      [/[^/*]+/, 'comment'],
      [/\*\//, 'comment', '@pop'],
      [/[/*]/, 'comment'],
    ],
    doubleString: [
      [/[^\\"]+/, 'string'],
      [/\\./, 'string.escape'],
      [/"/, 'string', '@pop'],
    ],
    singleString: [
      [/[^\\']+/, 'string'],
      [/\\./, 'string.escape'],
      [/'/, 'string', '@pop'],
    ],
    templateString: [
      [/[^\\`]+/, 'string'],
      [/\\./, 'string.escape'],
      [/`/, 'string', '@pop'],
    ],
  },
} as Monaco.languages.IMonarchLanguage;

const registeredMonaco = new WeakSet<object>();

/**
 * Registers the mongosh language and its tokenizer, once per Monaco instance. The read-only viewer
 * needs only this. The editor adds completion and signature help on top.
 */
export function registerMongoshTokens(monaco: typeof Monaco): void {
  if (registeredMonaco.has(monaco)) {
    return;
  }
  registeredMonaco.add(monaco);
  monaco.languages.register({ id: MONGOSH_LANGUAGE });
  monaco.languages.setLanguageConfiguration(MONGOSH_LANGUAGE, {
    comments: { lineComment: '//', blockComment: ['/*', '*/'] },
    brackets: [
      ['{', '}'],
      ['[', ']'],
      ['(', ')'],
    ],
    autoClosingPairs: [
      { open: '{', close: '}' },
      { open: '[', close: ']' },
      { open: '(', close: ')' },
      { open: '"', close: '"', notIn: ['string'] },
      { open: "'", close: "'", notIn: ['string'] },
      { open: '`', close: '`', notIn: ['string'] },
    ],
    // A dollar sign is part of an operator name, so `$gt` is one word for completion.
    wordPattern: /\$?[A-Za-z_][A-Za-z0-9_$]*/,
  });
  monaco.languages.setMonarchTokensProvider(MONGOSH_LANGUAGE, MONGOSH_MONARCH);
}
