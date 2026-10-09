// Loads the editor core before anything else registers with it. See monaco-setup for the ordering.
import './monaco-setup';
import type * as Monaco from 'monaco-editor/editor/editor.api';
import type { EditorCompletion } from './completion-model';
import { mergeCompletions, completionContext, operatorCompletions } from './completion-model';
import type { CompletionSource } from './completion-source';
import { signatureAt } from './signature';

export const MONGOSH_LANGUAGE = 'mongosh';

/** How long completion waits after the last keystroke before it asks the backend. */
export const COMPLETION_DEBOUNCE_MS = 150;

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

/** Where each editor's completion source lives, keyed by its model URI. */

const registeredMonaco = new WeakSet<object>();
const sources = new Map<string, CompletionSource | undefined>();
let latestRequest = 0;

/**
 * Registers the mongosh language, its tokenizer, and the providers, once per Monaco instance. The
 * providers look up each model's completion source by its URI.
 */
export function registerMongoshLanguage(monaco: typeof Monaco): void {
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
  monaco.languages.setMonarchTokensProvider(MONGOSH_LANGUAGE, {
    keywords: KEYWORDS,
    shellGlobals: SHELL_GLOBALS,
    tokenizer: {
      root: [
        [/\/\/.*$/, 'comment'],
        [/\/\*/, 'comment', '@blockComment'],
        [/"/, 'string', '@doubleString'],
        [/'/, 'string', '@singleString'],
        [/`/, 'string', '@templateString'],
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
        [/[+\-*/%=<>!&|^~?]+/, 'operator'],
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
  } as Monaco.languages.IMonarchLanguage);

  monaco.languages.registerCompletionItemProvider(MONGOSH_LANGUAGE, {
    triggerCharacters: ['.', '(', '$'],
    provideCompletionItems: (model, position, _context, token) =>
      provideCompletions(monaco, model, position, token),
  });

  monaco.languages.registerSignatureHelpProvider(MONGOSH_LANGUAGE, {
    signatureHelpTriggerCharacters: ['(', ','],
    signatureHelpRetriggerCharacters: [','],
    provideSignatureHelp: (model, position) => {
      const help = signatureAt(model.getValue(), model.getOffsetAt(position));
      if (help === undefined) {
        return undefined;
      }
      return {
        value: {
          signatures: [
            {
              label: help.label,
              documentation: help.doc,
              parameters: help.parameters.map((name) => ({ label: name })),
            },
          ],
          activeSignature: 0,
          activeParameter: help.activeParameter,
        },
        dispose: () => undefined,
      };
    },
  });
}

/** Adds the completion source of one editor, or removes it when `source` is undefined. */
export function setCompletionSource(uri: string, source: CompletionSource | undefined): void {
  sources.set(uri, source);
}

export function clearCompletionSource(uri: string): void {
  sources.delete(uri);
}

/** Read-only view of the registry. Tests use it to check what an editor will ask for. */
export function completionSourceOf(uri: string): CompletionSource | undefined {
  return sources.get(uri);
}

/**
 * Asks the editor's source after the debounce. A newer request, or a cancelled token, drops this
 * one, so only the last request of a burst reaches the backend.
 */
async function provideCompletions(
  monaco: typeof Monaco,
  model: Monaco.editor.ITextModel,
  position: Monaco.Position,
  token: Monaco.CancellationToken,
): Promise<Monaco.languages.CompletionList> {
  const request = ++latestRequest;
  await delay(COMPLETION_DEBOUNCE_MS);
  const source = sources.get(model.uri.toString());
  if (token.isCancellationRequested || request !== latestRequest || source === undefined) {
    return { suggestions: [] };
  }
  const controller = new AbortController();
  const subscription = token.onCancellationRequested(() => controller.abort());
  const code = model.getValue();
  const offset = model.getOffsetAt(position);
  const remote = await source.complete(code, offset, controller.signal);
  subscription.dispose();
  if (token.isCancellationRequested || request !== latestRequest) {
    return { suggestions: [] };
  }
  const word = model.getWordUntilPosition(position);
  const range = new monaco.Range(
    position.lineNumber,
    word.startColumn,
    position.lineNumber,
    word.endColumn,
  );
  const { prefix } = completionContext(code, offset);
  const items = mergeCompletions(prefix, [remote, operatorCompletions()]);
  return { suggestions: items.map((item) => toSuggestion(monaco, item, range)) };
}

function toSuggestion(
  monaco: typeof Monaco,
  item: EditorCompletion,
  range: Monaco.IRange,
): Monaco.languages.CompletionItem {
  return {
    label: item.label,
    kind: kindOf(monaco, item.kind),
    insertText: item.label,
    ...(item.detail === undefined ? {} : { detail: item.detail }),
    ...(item.doc === undefined ? {} : { documentation: item.doc }),
    range,
    sortText: `${item.rank}-${item.label}`,
  };
}

function kindOf(
  monaco: typeof Monaco,
  kind: EditorCompletion['kind'],
): Monaco.languages.CompletionItemKind {
  const kinds = monaco.languages.CompletionItemKind;
  switch (kind) {
    case 'method':
      return kinds.Method;
    case 'property':
      return kinds.Field;
    case 'collection':
      return kinds.Module;
    case 'database':
      return kinds.Folder;
    case 'operator':
      return kinds.Operator;
    case 'keyword':
      return kinds.Keyword;
    default:
      return kinds.Text;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
