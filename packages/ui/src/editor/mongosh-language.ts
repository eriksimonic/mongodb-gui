// Loads the editor core before anything else registers with it. See monaco-setup for the ordering.
import './monaco-setup';
import type * as Monaco from 'monaco-editor/editor/editor.api';
import type { EditorCompletion } from './completion-model';
import {
  mergeCompletions,
  completionContext,
  operatorsFor,
  staticCompletionsFor,
} from './completion-model';
import type { CompletionSource } from './completion-source';
import { signatureAt } from './signature';

export const MONGOSH_LANGUAGE = 'mongosh';

/** How long completion waits after the last keystroke before it asks the backend. */
export const COMPLETION_DEBOUNCE_MS = 40;

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
  monaco.languages.setMonarchTokensProvider(MONGOSH_LANGUAGE, MONGOSH_MONARCH);

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
 * one, so only the last request of a burst reaches the backend. A dropped request answers with an
 * incomplete empty list: a final empty list would make Monaco close the session and stop asking
 * for the rest of the word, which is what happened when two letters arrived within the debounce.
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
    return { suggestions: [], incomplete: true };
  }
  const controller = new AbortController();
  const subscription = token.onCancellationRequested(() => controller.abort());
  const code = model.getValue();
  const offset = model.getOffsetAt(position);
  const remote = await source.complete(code, offset, controller.signal);
  subscription.dispose();
  if (token.isCancellationRequested || request !== latestRequest) {
    return { suggestions: [], incomplete: true };
  }
  const word = model.getWordUntilPosition(position);
  const range = new monaco.Range(
    position.lineNumber,
    word.startColumn,
    position.lineNumber,
    word.endColumn,
  );
  const context = completionContext(code, offset);
  const items = mergeCompletions(context.prefix, [
    remote,
    staticCompletionsFor(context),
    operatorsFor(context),
  ]);
  return {
    suggestions: items.map((item) => toSuggestion(monaco, item, range)),
    // Always incomplete, so Monaco asks again on each keystroke instead of filtering a list
    // that an earlier trigger character produced for another position. The debounce above
    // keeps a fast burst down to one backend call.
    incomplete: true,
  };
}

/** The Monaco item for an editor completion. The SQL provider uses the same mapping. */
export function toSuggestion(
  monaco: typeof Monaco,
  item: EditorCompletion,
  range: Monaco.IRange,
): Monaco.languages.CompletionItem {
  return {
    label: item.label,
    kind: kindOf(monaco, item.kind),
    insertText: item.insertText ?? item.label,
    ...(item.snippet === true
      ? { insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet }
      : {}),
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

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
