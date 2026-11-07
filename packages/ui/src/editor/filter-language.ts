import type { SchemaField } from '@mongo-gui/core';
import type * as Monaco from 'monaco-editor/editor/editor.api';
import { jsonDefaults } from 'monaco-editor/languages/features/json/register';
import { filterCompletions } from './filter-completion';
import { toSuggestion } from './mongosh-language';

/** The sampled fields an editor offers. Resolves to none when the editor has no collection. */
export type FilterFieldLoader = () => Promise<readonly SchemaField[]>;

/** Where each filter editor's field loader lives, keyed by its model URI. */
const registeredMonaco = new WeakSet<object>();
const loaders = new Map<string, FilterFieldLoader>();

/** The folder of the filter models. Each filter editor gets one model file in it. */
const FILTER_MODEL_FOLDER = 'inmemory://mongo-gui/filter/';
const FILTER_SCHEMA_URI = 'inmemory://mongo-gui/filter-schema.json';

/** The model URI of a filter editor. The id holds letters and digits only. */
export function filterModelPath(id: string): string {
  return `${FILTER_MODEL_FOLDER}${id}.json`;
}

/**
 * Registers the completion provider for JSON models, once per Monaco instance. The provider answers
 * only for models that have a loader, so the other JSON editors get no suggestions from it.
 *
 * The filter models also get an empty schema. The JSON service then skips its schema-less
 * suggestions, which list `$schema` first. Only the filter models match the schema's file pattern.
 */
export function registerFilterLanguage(monaco: typeof Monaco): void {
  if (registeredMonaco.has(monaco)) {
    return;
  }
  registeredMonaco.add(monaco);
  // Monaco 0.57 has no json namespace on the editor API, so the defaults come from the JSON module.
  const options = jsonDefaults.diagnosticsOptions;
  jsonDefaults.setDiagnosticsOptions({
    ...options,
    schemas: [
      ...(options.schemas ?? []),
      { uri: FILTER_SCHEMA_URI, fileMatch: [`${FILTER_MODEL_FOLDER}*.json`], schema: {} },
    ],
  });
  monaco.languages.registerCompletionItemProvider('json', {
    triggerCharacters: ['"', '$', '.', ':', ',', '{'],
    provideCompletionItems: (model, position) => provideFilterCompletions(monaco, model, position),
  });
}

export function setFilterFields(uri: string, load: FilterFieldLoader): void {
  loaders.set(uri, load);
}

export function clearFilterFields(uri: string): void {
  loaders.delete(uri);
}

async function provideFilterCompletions(
  monaco: typeof Monaco,
  model: Monaco.editor.ITextModel,
  position: Monaco.Position,
): Promise<Monaco.languages.CompletionList> {
  const load = loaders.get(model.uri.toString());
  if (load === undefined) {
    return { suggestions: [] };
  }
  const offset = model.getOffsetAt(position);
  const head = model.getValue().slice(0, offset);
  const fields = await load();
  // The dialog can close while the field sample loads, and Monaco disposes the model with it.
  if (model.isDisposed()) {
    return { suggestions: [] };
  }
  const { replaceLength, items } = filterCompletions(head, fields);
  const start = model.getPositionAt(offset - replaceLength);
  const range = new monaco.Range(
    start.lineNumber,
    start.column,
    position.lineNumber,
    position.column,
  );
  return {
    // The first item of this list is selected, so Enter and Tab take it and never a built-in item.
    suggestions: items.map((item, index) => ({
      ...toSuggestion(monaco, item, range),
      ...(index === 0 ? { preselect: true } : {}),
    })),
    // Always incomplete, so Monaco asks again on each keystroke, as the mongosh provider does.
    incomplete: true,
  };
}
