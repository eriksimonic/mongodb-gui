// @vitest-environment jsdom
import { act, screen, waitFor } from '@testing-library/react';
import type { SchemaField } from '@mongo-gui/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppRoot } from '../AppRoot';
import { localConnectionId } from '../api/mock-fixtures';
import { renderWithApp } from '../test-support/render';
import { FilterEditor } from './FilterEditor';

// What the Monaco stand-in received on its last render. Monaco itself needs a real layout engine.
const monaco = vi.hoisted(() => ({
  props: undefined as
    | {
        readonly height: number;
        readonly options: Record<string, unknown>;
        readonly onMount: (editor: unknown, api: unknown) => void;
      }
    | undefined,
}));

vi.mock('@monaco-editor/react', () => ({
  default: (props: typeof monaco.props) => {
    monaco.props = props;
    return null;
  },
}));
vi.mock('../kit/code/monaco-setup', () => ({}));
vi.mock('monaco-editor/languages/features/json/register', () => ({
  jsonDefaults: { diagnosticsOptions: {}, setDiagnosticsOptions: vi.fn() },
}));

beforeEach(() => {
  monaco.props = undefined;
});

/** The parts of the Monaco API that the editor and its registry touch. */
function fakeMonacoApi() {
  const registerCompletionItemProvider = vi.fn();
  return {
    registerCompletionItemProvider,
    api: {
      Range: vi.fn(),
      languages: {
        registerCompletionItemProvider,
        CompletionItemKind: {},
        CompletionItemInsertTextRule: { InsertAsSnippet: 4 },
      },
    },
  };
}

/**
 * A code editor stand-in: its model URI and a DOM node that holds the focus target and the hidden
 * textarea, as Monaco builds them.
 */
function fakeEditor(uri: string) {
  const dom = document.createElement('div');
  dom.innerHTML = '<div role="textbox" aria-label="Filter"></div><textarea></textarea>';
  return {
    dom,
    editor: {
      getModel: () => ({ uri: { toString: () => uri } }),
      getDomNode: () => dom,
    },
  };
}

function field(path: string): SchemaField {
  return { path, types: ['string'], presence: 1 };
}

const SCOPE = { connectionId: localConnectionId, database: 'shop', collection: 'orders' };

describe('FilterEditor', () => {
  it('shows a loader named after the editor until Monaco loads', async () => {
    renderWithApp(<FilterEditor value="{}" onChange={() => undefined} ariaLabel="Filter" />);

    expect(screen.getByLabelText('Loading Filter')).toBeInTheDocument();
    await waitFor(() => expect(monaco.props).toBeDefined());
  });

  it('gives Monaco the compact, keyboard-friendly options', async () => {
    renderWithApp(
      <FilterEditor value="{}" onChange={() => undefined} ariaLabel="Query" readOnly />,
    );

    await waitFor(() => expect(monaco.props).toBeDefined());
    const options = monaco.props?.options ?? {};
    expect(options).toMatchObject({
      ariaLabel: 'Query',
      readOnly: true,
      lineNumbers: 'off',
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      tabFocusMode: true,
      wordBasedSuggestions: 'off',
      fixedOverflowWidgets: true,
      quickSuggestions: { strings: 'on', other: 'on', comments: 'off' },
    });
  });

  it('starts at three lines and grows to eight', async () => {
    const { unmount } = renderWithApp(
      <FilterEditor value="{}" onChange={() => undefined} ariaLabel="Filter" />,
    );
    await waitFor(() => expect(monaco.props).toBeDefined());
    expect(monaco.props?.height).toBe(72);
    unmount();

    renderWithApp(
      <FilterEditor value={'{\n'.repeat(19)} onChange={() => undefined} ariaLabel="Filter" />,
    );
    await waitFor(() => expect(monaco.props?.height).toBe(172));
  });

  it('shows the error under the editor and marks the focus target invalid', async () => {
    const { rerender, api } = renderWithApp(
      <FilterEditor
        value='{"status": '
        onChange={() => undefined}
        ariaLabel="Filter"
        error="The filter is not valid extended JSON."
      />,
    );
    await waitFor(() => expect(monaco.props).toBeDefined());
    const { dom, editor } = fakeEditor('inmemory://filter-invalid');
    act(() => {
      monaco.props?.onMount(editor, fakeMonacoApi().api);
    });

    const message = screen.getByText('The filter is not valid extended JSON.');
    const textbox = dom.querySelector('[role="textbox"]');
    expect(textbox?.getAttribute('aria-invalid')).toBe('true');
    expect(textbox?.getAttribute('aria-describedby')).toBe(message.id);
    expect(dom.querySelector('textarea')?.hasAttribute('aria-invalid')).toBe(false);

    // The rerender keeps the providers, so the editor receives the same api.
    rerender(
      <AppRoot api={api}>
        <FilterEditor value="{}" onChange={() => undefined} ariaLabel="Filter" />
      </AppRoot>,
    );
    expect(textbox?.hasAttribute('aria-invalid')).toBe(false);
    expect(textbox?.hasAttribute('aria-describedby')).toBe(false);
  });

  it('puts Monaco suggestions on a node on the body, and removes it on unmount', async () => {
    const { unmount } = renderWithApp(
      <FilterEditor value="{}" onChange={() => undefined} ariaLabel="Filter" />,
    );
    await waitFor(() => expect(monaco.props).toBeDefined());
    const node = monaco.props?.options.overflowWidgetsDomNode as HTMLElement | undefined;

    expect(node).toBeInstanceOf(HTMLElement);
    expect(node?.classList.contains('monaco-editor')).toBe(true);
    expect(node?.parentElement).toBe(document.body);
    unmount();
    expect(node?.isConnected).toBe(false);
  });

  it('holds the Escape guard while a suggestion list is open', async () => {
    renderWithApp(<FilterEditor value="{}" onChange={() => undefined} ariaLabel="Filter" />);
    await waitFor(() => expect(monaco.props).toBeDefined());
    const node = monaco.props?.options.overflowWidgetsDomNode as HTMLElement;
    const { dom, editor } = fakeEditor('inmemory://filter-escape');
    act(() => {
      monaco.props?.onMount(editor, fakeMonacoApi().api);
    });
    const textbox = dom.querySelector('[role="textbox"]');
    const guard = 'data-mantine-stop-propagation';

    const list = document.createElement('div');
    list.className = 'suggest-widget';
    node.append(list);
    list.classList.add('visible');
    await waitFor(() => expect(textbox?.getAttribute(guard)).toBe('true'));

    list.classList.remove('visible');
    await waitFor(() => expect(textbox?.hasAttribute(guard)).toBe(false));
  });

  it('registers its model, and completes the fields of its collection', async () => {
    const { api, unmount } = renderWithApp(
      <FilterEditor value="" onChange={() => undefined} ariaLabel="Filter" fields={SCOPE} />,
    );
    const sample = vi
      .spyOn(api.rpc.shell, 'sampleSchema')
      .mockResolvedValue({ fields: [field('status')] } as never);
    await waitFor(() => expect(monaco.props).toBeDefined());
    const uri = 'inmemory://filter-registered';
    const { editor } = fakeEditor(uri);
    const { registerCompletionItemProvider, api: monacoApi } = fakeMonacoApi();
    act(() => {
      monaco.props?.onMount(editor, monacoApi);
    });
    const provider = registerCompletionItemProvider.mock.calls[0]?.[1] as {
      readonly provideCompletionItems: (
        model: unknown,
        position: unknown,
      ) => Promise<{ readonly suggestions: readonly { readonly label: string }[] }>;
    };
    const model = {
      uri: { toString: () => uri },
      isDisposed: () => false,
      getValue: () => '{"sta',
      getOffsetAt: () => 5,
      getPositionAt: (offset: number) => ({ lineNumber: 1, column: offset + 1 }),
    };

    const result = await provider.provideCompletionItems(model, { lineNumber: 1, column: 6 });

    expect(sample).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: localConnectionId,
        database: 'shop',
        collection: 'orders',
      }),
    );
    expect(result.suggestions.map((suggestion) => suggestion.label)).toContain('status');

    unmount();
    const after = await provider.provideCompletionItems(model, { lineNumber: 1, column: 6 });
    expect(after.suggestions).toEqual([]);
  });
});
