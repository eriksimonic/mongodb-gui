// Loads the editor core before anything else registers with it. See monaco-setup for the ordering.
import '../kit/code/monaco-setup';
import type * as Monaco from 'monaco-editor/editor/editor.api';
import type { EditorCompletion } from './completion-model';
import {
  completionGroup,
  mergeCompletions,
  completionContext,
  operatorsFor,
  staticCompletionsFor,
} from './completion-model';
import type { CompletionSource } from './completion-source';
import { signatureAt } from './signature';
import { MONGOSH_LANGUAGE, registerMongoshTokens } from '../kit/code/mongosh-tokens';

/** How long completion waits after the last keystroke before it asks the backend. */
export const COMPLETION_DEBOUNCE_MS = 40;

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
  registerMongoshTokens(monaco);
  monaco.languages.registerCompletionItemProvider(MONGOSH_LANGUAGE, {
    triggerCharacters: ['.', '(', '$', '{', ','],
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
    // Monaco sorts by this text, so the group and the rank are zero padded to compare as numbers.
    sortText: `${completionGroup(item.kind)}-${String(item.rank).padStart(3, '0')}-${item.label}`,
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
