// Loads the editor core before anything else registers with it. See monaco-setup for the ordering.
import './monaco-setup';
import type * as Monaco from 'monaco-editor/editor/editor.api';
import type { SchemaField } from '@mongo-gui/core';
import {
  COMPLETION_DEBOUNCE_MS,
  completionSourceOf,
  delay,
  toSuggestion,
} from './mongosh-language';
import {
  SQL_FUNCTIONS,
  SQL_KEYWORDS,
  SQL_TYPES,
  sqlCompletionContext,
  sqlCompletions,
  sqlTargetTable,
} from './sql-completion-model';

export const SQL_LANGUAGE = 'tsql';

/** Keywords that the completion list leaves out but the tokenizer colors and stops names at. */
const EXTRA_KEYWORDS = [
  'DECLARE',
  'EXCEPT',
  'INTERSECT',
  'OVER',
  'TABLE',
  'THEN',
  'TRUNCATE',
  'UNION',
];

/** The words after which a table name follows. */
const TABLE_INTRODUCERS = ['FROM', 'JOIN', 'UPDATE', 'INTO', 'TABLE'];

const WORD = String.raw`[A-Za-z_][\w$]*`;
const BRACKETED = String.raw`\[(?:[^\]]|\]\])*\]`;
const QUOTED = String.raw`"(?:[^"]|"")*"`;

/** The case table of a word. `fallback` is the token of a word that no list claims. */
function wordCases(fallback: string): Record<string, unknown> {
  return {
    cases: {
      '@introducers': { token: 'keyword', next: '@table' },
      '@keywords': 'keyword',
      '@functions': 'predefined',
      '@types': 'keyword.type',
      '@default': fallback,
    },
  };
}

/**
 * The T-SQL tokenizer. Token names the themes in editor-theme.ts color:
 *
 * - `type`: a table. That is the name after FROM, JOIN, UPDATE, INTO or TABLE (with its schema
 *   parts and an alias), and any name directly before a dot, which is a qualifier or an alias.
 * - `property`: a column. That is a plain name anywhere else, the part after a dot, and a
 *   bracketed or double-quoted name outside table position.
 * - `keyword.type`: a data type such as INT or NVARCHAR. It takes the keyword color by prefix, and
 *   its own name keeps it apart from the table token, which a theme colors by `type`.
 * - `predefined`: a built-in function that the translator knows. `function` is any other name
 *   that a parenthesis follows.
 * - `keyword`, `variable`, `string`, `number`, `comment`, `operator`, `delimiter` as usual.
 *
 * The `table` state starts after a table keyword. `afterTable` follows a table name and takes a
 * dot (the next part is a table name too), AS, or an alias. A bracketed or quoted name is one
 * token only when it closes on its line, so a name that spans lines is not supported.
 */
export const SQL_MONARCH = {
  ignoreCase: true,
  keywords: [...SQL_KEYWORDS, ...EXTRA_KEYWORDS],
  functions: [...SQL_FUNCTIONS],
  types: [...SQL_TYPES],
  introducers: TABLE_INTRODUCERS,
  aliasKeywords: ['AS'],
  tokenizer: {
    root: [
      { include: '@trivia' },
      [/N'/, 'string', '@string'],
      [/'/, 'string', '@string'],
      [new RegExp(`${BRACKETED}(?=\\.)`), 'type'],
      [new RegExp(QUOTED + '(?=\\.)'), 'type'],
      [new RegExp(BRACKETED), 'property'],
      [new RegExp(QUOTED), 'property'],
      [/\[[^\]]*$/, 'property'],
      [/"[^"]*$/, 'property'],
      // Monarch reads a doubled at sign in a rule as one literal at sign, so `@@@?` is the regular
      // expression `@@?`. Written with two, the rule matched every word and colored it a variable.
      [/@@@?[A-Za-z_][A-Za-z0-9_]*/, 'variable'],
      [/#{1,2}[A-Za-z_][\w$]*/, 'type'],
      [new RegExp(`(\\.)(${WORD})(?=\\s*\\()`), ['delimiter', 'function']],
      [new RegExp(`(\\.)(${WORD})(?=\\.)`), ['delimiter', 'type']],
      [new RegExp(`(\\.)(${WORD})`), ['delimiter', 'property']],
      [new RegExp(`${WORD}(?=\\.)`), 'type'],
      [new RegExp(`${WORD}(?=\\s*\\()`), wordCases('function')],
      [new RegExp(WORD), wordCases('property')],
      [/\d+(\.\d*)?([eE][+-]?\d+)?|\.\d+([eE][+-]?\d+)?/, 'number'],
      [/[()]/, '@brackets'],
      [/[;,.]/, 'delimiter'],
      [/<>|<=|>=|!=|[=<>+\-*/%]/, 'operator'],
      [/\s+/, 'white'],
    ],
    trivia: [
      [/--.*$/, 'comment'],
      [/\/\*/, 'comment', '@blockComment'],
    ],
    // Right after a table keyword. Anything that is not a name ends the state without a token.
    table: [
      [/\s+/, 'white'],
      { include: '@trivia' },
      [new RegExp(BRACKETED), { token: 'type', switchTo: '@afterTable' }],
      [new RegExp(QUOTED), { token: 'type', switchTo: '@afterTable' }],
      [/\[[^\]]*$/, { token: 'type', next: '@pop' }],
      [/"[^"]*$/, { token: 'type', next: '@pop' }],
      [
        /#{0,2}[A-Za-z_][\w$]*/,
        {
          cases: {
            '@keywords': { token: '@rematch', next: '@pop' },
            '@default': { token: 'type', switchTo: '@afterTable' },
          },
        },
      ],
      [/(?=\S)/, { token: '@rematch', next: '@pop' }],
    ],
    // After a table name: a dot continues the name, AS or a bare word is an alias.
    afterTable: [
      [/\./, { token: 'delimiter', switchTo: '@table' }],
      [/\s+/, 'white'],
      { include: '@trivia' },
      [
        new RegExp(WORD),
        {
          cases: {
            '@aliasKeywords': { token: 'keyword', switchTo: '@alias' },
            '@keywords': { token: '@rematch', next: '@pop' },
            '@default': { token: 'type', next: '@pop' },
          },
        },
      ],
      [new RegExp(BRACKETED), { token: 'type', next: '@pop' }],
      [new RegExp(QUOTED), { token: 'type', next: '@pop' }],
      [/(?=\S)/, { token: '@rematch', next: '@pop' }],
    ],
    alias: [
      [/\s+/, 'white'],
      { include: '@trivia' },
      [
        new RegExp(WORD),
        {
          cases: {
            '@keywords': { token: '@rematch', next: '@pop' },
            '@default': { token: 'type', next: '@pop' },
          },
        },
      ],
      [new RegExp(BRACKETED), { token: 'type', next: '@pop' }],
      [new RegExp(QUOTED), { token: 'type', next: '@pop' }],
      [/(?=\S)/, { token: '@rematch', next: '@pop' }],
    ],
    blockComment: [
      [/[^/*]+/, 'comment'],
      [/\*\//, 'comment', '@pop'],
      [/[/*]/, 'comment'],
    ],
    // A doubled quote stands for itself inside the string.
    string: [
      [/[^']+/, 'string'],
      [/''/, 'string.escape'],
      [/'/, 'string', '@pop'],
    ],
  },
} as Monaco.languages.IMonarchLanguage;

const registeredMonaco = new WeakSet<object>();
let latestRequest = 0;

/**
 * Registers the T-SQL language, its tokenizer and its completion provider, once per Monaco
 * instance. The provider finds each model's completion source in the registry that the mongosh
 * language keeps, so a tab that flips its language keeps its source.
 */
export function registerSqlLanguage(monaco: typeof Monaco): void {
  if (registeredMonaco.has(monaco)) {
    return;
  }
  registeredMonaco.add(monaco);
  monaco.languages.register({ id: SQL_LANGUAGE });
  monaco.languages.setLanguageConfiguration(SQL_LANGUAGE, {
    comments: { lineComment: '--', blockComment: ['/*', '*/'] },
    brackets: [
      ['(', ')'],
      ['[', ']'],
    ],
    autoClosingPairs: [
      { open: '(', close: ')' },
      { open: '[', close: ']', notIn: ['string', 'comment'] },
      { open: "'", close: "'", notIn: ['string', 'comment'] },
    ],
    surroundingPairs: [
      { open: '(', close: ')' },
      { open: '[', close: ']' },
      { open: "'", close: "'" },
    ],
    // The same shape as the word the completion model reads, so an accepted item replaces it.
    wordPattern: /[A-Za-z_@#][A-Za-z0-9_$]*/,
  });
  monaco.languages.setMonarchTokensProvider(SQL_LANGUAGE, SQL_MONARCH);

  monaco.languages.registerCompletionItemProvider(SQL_LANGUAGE, {
    triggerCharacters: ['.'],
    provideCompletionItems: (model, position, _context, token) =>
      provideCompletions(monaco, model, position, token),
  });
}

/**
 * Builds the items for the cursor after the debounce. The catalog and the field sample come from
 * the editor's completion source. A newer request or a cancelled token drops this one and answers
 * with an incomplete empty list, for the reason given in the mongosh provider.
 */
async function provideCompletions(
  monaco: typeof Monaco,
  model: Monaco.editor.ITextModel,
  position: Monaco.Position,
  token: Monaco.CancellationToken,
): Promise<Monaco.languages.CompletionList> {
  const request = ++latestRequest;
  await delay(COMPLETION_DEBOUNCE_MS);
  const source = completionSourceOf(model.uri.toString());
  if (token.isCancellationRequested || request !== latestRequest || source === undefined) {
    return { suggestions: [], incomplete: true };
  }
  const code = model.getValue();
  const offset = model.getOffsetAt(position);
  const context = sqlCompletionContext(code, offset);
  let collections: string[] = [];
  const samples = new Map<string, SchemaField[]>();
  if (context.kind === 'table') {
    collections = await source.collections();
  } else if (context.kind === 'column') {
    const target = sqlTargetTable(context);
    if (target !== undefined) {
      samples.set(target, await source.fieldsOf(target));
    }
  }
  if (token.isCancellationRequested || request !== latestRequest) {
    return { suggestions: [], incomplete: true };
  }
  const items = sqlCompletions(context, {
    collections,
    fieldsOf: (collection) => samples.get(collection),
    keywords: SQL_KEYWORDS,
    functions: SQL_FUNCTIONS,
  });
  const word = model.getWordUntilPosition(position);
  const range = new monaco.Range(
    position.lineNumber,
    word.startColumn,
    position.lineNumber,
    word.endColumn,
  );
  return {
    suggestions: items.map((item) => toSuggestion(monaco, item, range)),
    incomplete: true,
  };
}
