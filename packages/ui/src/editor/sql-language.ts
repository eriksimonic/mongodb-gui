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
  monaco.languages.setMonarchTokensProvider(SQL_LANGUAGE, {
    ignoreCase: true,
    keywords: [...SQL_KEYWORDS],
    functions: [...SQL_FUNCTIONS],
    types: [...SQL_TYPES],
    tokenizer: {
      root: [
        [/--.*$/, 'comment'],
        [/\/\*/, 'comment', '@blockComment'],
        [/N'/, 'string', '@string'],
        [/'/, 'string', '@string'],
        [/\[/, 'identifier', '@bracket'],
        [/"/, 'identifier', '@quoted'],
        [/@@?[A-Za-z_][A-Za-z0-9_]*/, 'variable'],
        [
          /[A-Za-z_][A-Za-z0-9_$]*/,
          {
            cases: {
              '@keywords': 'keyword',
              '@functions': 'predefined',
              '@types': 'type',
              '@default': 'identifier',
            },
          },
        ],
        [/\d+(\.\d*)?([eE][+-]?\d+)?|\.\d+([eE][+-]?\d+)?/, 'number'],
        [/[()]/, '@brackets'],
        [/[;,.]/, 'delimiter'],
        [/<>|<=|>=|!=|[=<>+\-*/%]/, 'operator'],
        [/\s+/, 'white'],
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
      bracket: [
        [/[^\]]+/, 'identifier'],
        [/\]\]/, 'identifier'],
        [/\]/, 'identifier', '@pop'],
      ],
      quoted: [
        [/[^"]+/, 'identifier'],
        [/""/, 'identifier'],
        [/"/, 'identifier', '@pop'],
      ],
    },
  } as Monaco.languages.IMonarchLanguage);

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
