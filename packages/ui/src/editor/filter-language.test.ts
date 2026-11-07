import type { SchemaField } from '@mongo-gui/core';
import { describe, expect, it, vi } from 'vitest';
import {
  clearFilterFields,
  filterModelPath,
  registerFilterLanguage,
  setFilterFields,
  type FilterFieldLoader,
} from './filter-language';

// Monaco needs a real layout engine, so the editor core is not loaded here.
vi.mock('../kit/code/monaco-setup', () => ({}));

// The JSON defaults are the module's own object. The fake records what the registry sets on it.
const json = vi.hoisted(() => ({
  diagnosticsOptions: {} as Record<string, unknown>,
  setDiagnosticsOptions: vi.fn(),
}));
vi.mock('monaco-editor/languages/features/json/register', () => ({ jsonDefaults: json }));

type Monaco = Parameters<typeof registerFilterLanguage>[0];

class FakeRange {
  constructor(
    readonly startLineNumber: number,
    readonly startColumn: number,
    readonly endLineNumber: number,
    readonly endColumn: number,
  ) {}
}

interface Suggestion {
  readonly label: string;
  readonly range: FakeRange;
}

interface Provider {
  readonly provideCompletionItems: (
    model: unknown,
    position: unknown,
  ) => Promise<{ readonly suggestions: readonly Suggestion[] }>;
}

function fakeMonaco() {
  const registerCompletionItemProvider = vi.fn();
  const monaco = {
    Range: FakeRange,
    languages: {
      registerCompletionItemProvider,
      CompletionItemKind: { Method: 0, Field: 1, Operator: 2, Keyword: 3, Text: 4 },
      CompletionItemInsertTextRule: { InsertAsSnippet: 4 },
    },
  };
  return { monaco, registerCompletionItemProvider };
}

/** The provider registered for JSON, as Monaco would call it. */
function providerOf(registerCompletionItemProvider: ReturnType<typeof vi.fn>): Provider {
  const call = registerCompletionItemProvider.mock.calls.find(([language]) => language === 'json');
  return call?.[1] as Provider;
}

/** A model stand-in with one line, which is all the completion needs. */
function modelOf(uri: string, text: string, isDisposed: () => boolean = () => false) {
  return {
    uri: { toString: () => uri },
    isDisposed,
    getValue: () => text,
    getOffsetAt: (position: { readonly column: number }) => position.column - 1,
    getPositionAt: (offset: number) => ({ lineNumber: 1, column: offset + 1 }),
  };
}

function atEnd(text: string) {
  return { lineNumber: 1, column: text.length + 1 };
}

function field(path: string): SchemaField {
  return { path, types: ['string'], presence: 1 };
}

const STATUS_LOADER: FilterFieldLoader = () => Promise.resolve([field('status')]);

describe('registerFilterLanguage', () => {
  it('registers one JSON provider for each Monaco instance', () => {
    const { monaco, registerCompletionItemProvider } = fakeMonaco();

    registerFilterLanguage(monaco as unknown as Monaco);
    registerFilterLanguage(monaco as unknown as Monaco);

    expect(registerCompletionItemProvider).toHaveBeenCalledTimes(1);
    expect(registerCompletionItemProvider.mock.calls[0]?.[0]).toBe('json');
  });

  it('gives the filter models an empty schema, and keeps the other JSON options', () => {
    const { monaco } = fakeMonaco();
    json.setDiagnosticsOptions.mockClear();
    json.diagnosticsOptions = {
      validate: true,
      schemas: [{ uri: 'inmemory://other.json', schema: {} }],
    };

    registerFilterLanguage(monaco as unknown as Monaco);

    expect(json.setDiagnosticsOptions).toHaveBeenCalledTimes(1);
    const options = json.setDiagnosticsOptions.mock.calls[0]?.[0] as {
      readonly validate: boolean;
      readonly schemas: readonly { readonly uri: string; readonly fileMatch?: readonly string[] }[];
    };
    expect(options.validate).toBe(true);
    expect(options.schemas[0]?.uri).toBe('inmemory://other.json');
    const filter = options.schemas.find((entry) => entry.fileMatch !== undefined);
    expect(filter?.fileMatch).toEqual(['inmemory://mongo-gui/filter/*.json']);
    expect(filterModelPath('abc')).toBe('inmemory://mongo-gui/filter/abc.json');
  });

  it('preselects the first suggestion only', async () => {
    const { monaco, registerCompletionItemProvider } = fakeMonaco();
    registerFilterLanguage(monaco as unknown as Monaco);
    const provider = providerOf(registerCompletionItemProvider);
    setFilterFields('inmemory://filter-preselect', STATUS_LOADER);
    const text = '{';

    const result = await provider.provideCompletionItems(
      modelOf('inmemory://filter-preselect', text),
      atEnd(text),
    );

    const [first, ...rest] = result.suggestions as (Suggestion & {
      readonly preselect?: boolean;
    })[];
    expect(first).toMatchObject({ label: 'status', preselect: true });
    expect(rest.every((suggestion) => suggestion.preselect === undefined)).toBe(true);
  });

  it('suggests fields only for the model that has a loader', async () => {
    const { monaco, registerCompletionItemProvider } = fakeMonaco();
    registerFilterLanguage(monaco as unknown as Monaco);
    const provider = providerOf(registerCompletionItemProvider);
    setFilterFields('inmemory://filter-scoped', STATUS_LOADER);
    const text = '{"sta';

    const own = await provider.provideCompletionItems(
      modelOf('inmemory://filter-scoped', text),
      atEnd(text),
    );
    const other = await provider.provideCompletionItems(
      modelOf('inmemory://json-elsewhere', text),
      atEnd(text),
    );

    expect(own.suggestions.map((suggestion) => suggestion.label)).toContain('status');
    expect(other.suggestions).toEqual([]);
    clearFilterFields('inmemory://filter-scoped');
  });

  it('stops suggesting once the editor clears its loader', async () => {
    const { monaco, registerCompletionItemProvider } = fakeMonaco();
    registerFilterLanguage(monaco as unknown as Monaco);
    const provider = providerOf(registerCompletionItemProvider);
    const uri = 'inmemory://filter-cleared';
    setFilterFields(uri, STATUS_LOADER);
    clearFilterFields(uri);
    const text = '{"sta';

    const result = await provider.provideCompletionItems(modelOf(uri, text), atEnd(text));

    expect(result.suggestions).toEqual([]);
  });

  it('suggests nothing when the model is disposed while the fields load', async () => {
    const { monaco, registerCompletionItemProvider } = fakeMonaco();
    registerFilterLanguage(monaco as unknown as Monaco);
    const provider = providerOf(registerCompletionItemProvider);
    const uri = 'inmemory://filter-disposed';
    let disposed = false;
    setFilterFields(uri, () => {
      disposed = true;
      return Promise.resolve([field('status')]);
    });
    const text = '{"sta';

    const result = await provider.provideCompletionItems(
      modelOf(uri, text, () => disposed),
      atEnd(text),
    );

    expect(result.suggestions).toEqual([]);
  });

  it('replaces the typed key, from its first character to the cursor', async () => {
    const { monaco, registerCompletionItemProvider } = fakeMonaco();
    registerFilterLanguage(monaco as unknown as Monaco);
    const provider = providerOf(registerCompletionItemProvider);
    const uri = 'inmemory://filter-range';
    setFilterFields(uri, STATUS_LOADER);
    const text = '{"sta';

    const result = await provider.provideCompletionItems(modelOf(uri, text), atEnd(text));
    const status = result.suggestions.find((suggestion) => suggestion.label === 'status');

    expect(status?.range).toMatchObject({
      startLineNumber: 1,
      startColumn: 3,
      endLineNumber: 1,
      endColumn: 6,
    });
    clearFilterFields(uri);
  });
});
