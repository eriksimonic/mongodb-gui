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

/** The attribute that tells Mantine's modal not to close on Escape. */
const GUARD = 'data-mantine-stop-propagation';

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

  it('marks both focus targets with the Escape guard as soon as the editor mounts', async () => {
    renderWithApp(<FilterEditor value="{}" onChange={() => undefined} ariaLabel="Filter" />);
    await waitFor(() => expect(monaco.props).toBeDefined());
    const { dom, editor } = fakeEditor('inmemory://filter-guard-mount');
    act(() => {
      monaco.props?.onMount(editor, fakeMonacoApi().api);
    });

    expect(dom.querySelector('[role="textbox"]')?.getAttribute(GUARD)).toBe('true');
    expect(dom.querySelector('textarea')?.getAttribute(GUARD)).toBe('true');
  });

  it('removes the Escape guard from the focus targets on unmount', async () => {
    const { unmount } = renderWithApp(
      <FilterEditor value="{}" onChange={() => undefined} ariaLabel="Filter" />,
    );
    await waitFor(() => expect(monaco.props).toBeDefined());
    const { dom, editor } = fakeEditor('inmemory://filter-guard-unmount');
    act(() => {
      monaco.props?.onMount(editor, fakeMonacoApi().api);
    });
    const textbox = dom.querySelector('[role="textbox"]');
    const textarea = dom.querySelector('textarea');

    unmount();

    expect(textbox?.hasAttribute(GUARD)).toBe(false);
    expect(textarea?.hasAttribute(GUARD)).toBe(false);
  });

  it('creates no MutationObserver for the Escape guard', async () => {
    const created = vi.fn();
    class CountingObserver extends MutationObserver {
      constructor(callback: MutationCallback) {
        super(callback);
        created();
      }
    }
    renderWithApp(<FilterEditor value="{}" onChange={() => undefined} ariaLabel="Filter" />);
    await waitFor(() => expect(monaco.props).toBeDefined());
    // Mantine's own hooks create observers while the app renders, so the count starts at the mount.
    vi.stubGlobal('MutationObserver', CountingObserver);
    try {
      const { editor } = fakeEditor('inmemory://filter-guard-observer');
      act(() => {
        monaco.props?.onMount(editor, fakeMonacoApi().api);
      });

      expect(created).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('guards a focus target that Monaco creates after mount, once it takes focus', async () => {
    renderWithApp(<FilterEditor value="{}" onChange={() => undefined} ariaLabel="Filter" />);
    await waitFor(() => expect(monaco.props).toBeDefined());
    const { dom, editor } = fakeEditor('inmemory://filter-guard-replaced');
    act(() => {
      monaco.props?.onMount(editor, fakeMonacoApi().api);
    });

    // Monaco replaces its edit context node. The new node takes focus before it gets a key press.
    dom.querySelector('[role="textbox"]')?.remove();
    const replacement = document.createElement('div');
    replacement.setAttribute('role', 'textbox');
    dom.prepend(replacement);
    replacement.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));

    expect(replacement.getAttribute(GUARD)).toBe('true');
  });

  it('keeps Escape from closing the modal while the suggestion list opens and closes', async () => {
    renderWithApp(<FilterEditor value="{}" onChange={() => undefined} ariaLabel="Filter" />);
    await waitFor(() => expect(monaco.props).toBeDefined());
    const node = monaco.props?.options.overflowWidgetsDomNode as HTMLElement;
    const { dom, editor } = fakeEditor('inmemory://filter-escape');
    act(() => {
      monaco.props?.onMount(editor, fakeMonacoApi().api);
    });
    document.body.append(dom);
    const textbox = dom.querySelector('[role="textbox"]') as HTMLElement;

    // Mantine closes its modal from a window capture listener unless the target has the guard.
    const closeModal = vi.fn();
    const onWindowKeydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && (event.target as Element).getAttribute(GUARD) !== 'true') {
        closeModal();
      }
    };
    window.addEventListener('keydown', onWindowKeydown, { capture: true });
    const pressEscape = (target: Element) =>
      target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    try {
      // The control shows that the listener sees Escape on an element without the guard.
      const control = document.createElement('input');
      document.body.append(control);
      pressEscape(control);
      expect(closeModal).toHaveBeenCalledTimes(1);
      control.remove();
      closeModal.mockClear();

      const list = document.createElement('div');
      list.className = 'suggest-widget';
      node.append(list);
      list.classList.add('visible');
      pressEscape(textbox);
      list.classList.remove('visible');
      pressEscape(textbox);

      expect(closeModal).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('keydown', onWindowKeydown, { capture: true });
      dom.remove();
    }
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
