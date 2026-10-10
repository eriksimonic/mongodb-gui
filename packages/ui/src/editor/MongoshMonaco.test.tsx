// @vitest-environment jsdom
import '../test-support/browser-shims';
import type * as Monaco from 'monaco-editor/editor/editor.api';
import { useEffect, useRef, useState } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act } from '@testing-library/react';
import { renderWithApp } from '../test-support/render';
import type { MongoshEditorProps } from './MongoshEditor';

// Monaco needs a real layout engine, so the editor component is replaced by one that hands the
// props and a recording editor to the code under test. The Monaco namespace is the real one, so
// the key codes are real.
const captured = vi.hoisted(() => ({
  props: undefined as Record<string, unknown> | undefined,
  monaco: undefined as typeof Monaco | undefined,
  editor: undefined as unknown,
  order: [] as string[],
  /** The model-change handler the code under test registered, which the fake editor calls. */
  modelChanged: undefined as (() => void) | undefined,
}));

vi.mock('./monaco-setup', () => ({}));
vi.mock('@monaco-editor/react', () => {
  function FakeEditor(props: {
    readonly beforeMount?: (monaco: typeof Monaco) => void;
    readonly onMount?: (editor: unknown, monaco: typeof Monaco) => void;
  }) {
    const { beforeMount, onMount } = props;
    const mounted = useRef(false);
    captured.props = props as unknown as Record<string, unknown>;
    const path = (props as { readonly path?: string }).path;
    const lastPath = useRef(path);
    useEffect(() => {
      // Monaco swaps the model in an effect of its own when the path changes.
      if (lastPath.current !== path) {
        lastPath.current = path;
        captured.modelChanged?.();
      }
    }, [path]);
    useEffect(() => {
      // The component creates new handlers on each render, and Monaco mounts once.
      if (captured.monaco === undefined || mounted.current) {
        return;
      }
      mounted.current = true;
      beforeMount?.(captured.monaco);
      captured.order.push('beforeMount');
      onMount?.(captured.editor, captured.monaco);
      captured.order.push('onMount');
    }, [beforeMount, onMount]);
    return null;
  }
  return { default: FakeEditor };
});

interface RecordedAction {
  readonly id: string;
  readonly keybindings?: readonly number[];
  readonly run: () => void;
}

let monaco: typeof Monaco;
const actions: RecordedAction[] = [];

/** An editor that holds `text` and reports the given selection and cursor. */
function fakeEditor(
  text: string,
  cursor: number,
  selection?: { start: number; end: number },
  setValue: (value: string) => void = () => undefined,
) {
  const model = {
    uri: { toString: () => 'inmemory://mongo-gui/t1.mongosh' },
    getValue: () => text,
    getOffsetAt: (position: { offset: number }) => position.offset,
    setValue,
  };
  const point = (offset: number) => ({ offset });
  return {
    addAction: (action: RecordedAction) => {
      actions.push(action);
    },
    getModel: () => model,
    onDidChangeModel: (handler: () => void) => {
      captured.modelChanged = handler;
      return { dispose: () => undefined };
    },
    onDidDispose: () => undefined,
    getPosition: () => point(cursor),
    getSelection: () =>
      selection === undefined
        ? { isEmpty: () => true }
        : {
            isEmpty: () => false,
            getStartPosition: () => point(selection.start),
            getEndPosition: () => point(selection.end),
          },
    trigger: () => undefined,
  };
}

function props(overrides: Partial<MongoshEditorProps> = {}): MongoshEditorProps {
  return {
    tabId: 't1',
    label: 'Editor',
    language: 'mongosh',
    value: 'db.a.find()',
    source: undefined,
    onChange: () => undefined,
    onRun: () => undefined,
    onRunAll: () => undefined,
    onExplain: () => undefined,
    ...overrides,
  };
}

beforeAll(async () => {
  monaco = await import('monaco-editor/editor/editor.api');
  captured.monaco = monaco;
});

afterEach(() => {
  actions.length = 0;
  captured.order.length = 0;
  captured.props = undefined;
  captured.modelChanged = undefined;
});

async function mount(overrides: Partial<MongoshEditorProps> = {}, editor = fakeEditor('', 0)) {
  captured.editor = editor;
  const { MongoshMonaco } = await import('./MongoshMonaco');
  renderWithApp(<MongoshMonaco {...props(overrides)} />);
}

function action(id: string): RecordedAction {
  const found = actions.find((candidate) => candidate.id === id);
  if (found === undefined) {
    throw new Error(`no action ${id}`);
  }
  return found;
}

describe('MongoshMonaco run keys', () => {
  it('binds the run action to Ctrl+Enter and F5', async () => {
    await mount();
    expect(action('mongo-gui.run').keybindings).toEqual([
      monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter,
      monaco.KeyCode.F5,
    ]);
  });

  it('does not bind F5 to run all or explain', async () => {
    await mount();
    expect(action('mongo-gui.run-all').keybindings).not.toContain(monaco.KeyCode.F5);
    expect(action('mongo-gui.explain').keybindings ?? []).not.toContain(monaco.KeyCode.F5);
  });

  it('keeps Run all on Ctrl+Shift+Enter', async () => {
    await mount();
    expect(action('mongo-gui.run-all').keybindings).toEqual([
      monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.Enter,
    ]);
  });

  it('runs the statement under the cursor when nothing is selected', async () => {
    const onRun = vi.fn();
    await mount({ onRun }, fakeEditor('db.a.find()\ndb.b.find()', 14));
    action('mongo-gui.run').run();
    expect(onRun).toHaveBeenCalledWith({
      code: 'db.a.find()\ndb.b.find()',
      cursor: 14,
      selection: undefined,
    });
  });

  it('runs the selection when there is one', async () => {
    const onRun = vi.fn();
    await mount({ onRun }, fakeEditor('db.a.find()\ndb.b.find()', 14, { start: 12, end: 23 }));
    action('mongo-gui.run').run();
    expect(onRun).toHaveBeenCalledWith({
      code: 'db.a.find()\ndb.b.find()',
      cursor: 14,
      selection: { start: 12, end: 23 },
    });
  });

  it('runs all the text from the run all action', async () => {
    const onRunAll = vi.fn();
    await mount({ onRunAll }, fakeEditor('a;\nb;', 0));
    action('mongo-gui.run-all').run();
    expect(onRunAll).toHaveBeenCalledWith('a;\nb;');
  });

  it('binds the same keys in SQL mode', async () => {
    await mount({ language: 'sql' });
    expect(action('mongo-gui.run').keybindings).toContain(monaco.KeyCode.F5);
    expect((captured.props as { language: string }).language).toBe('tsql');
  });
});

describe('MongoshMonaco language switch', () => {
  it('gives the new model the text of the tab, not the text of the language it left', async () => {
    const setValue = vi.fn();
    captured.editor = fakeEditor('db.a.find()', 0, undefined, setValue);
    const { MongoshMonaco } = await import('./MongoshMonaco');
    let switchTo: (language: 'mongosh' | 'sql', value: string) => void = () => undefined;
    function Host() {
      const [state, setState] = useState<{ language: 'mongosh' | 'sql'; value: string }>({
        language: 'mongosh',
        value: 'db.a.find()',
      });
      switchTo = (language, value) => setState({ language, value });
      return <MongoshMonaco {...props(state)} />;
    }
    renderWithApp(<Host />);

    act(() => switchTo('sql', 'SELECT * FROM a'));

    expect(setValue).toHaveBeenCalledWith('SELECT * FROM a');
  });
});

describe('MongoshMonaco themes', () => {
  it('defines the themes before the editor mounts', async () => {
    await mount();
    expect(captured.order).toEqual(['beforeMount', 'onMount']);
  });

  it('gives the editor one of the app themes', async () => {
    await mount();
    expect(['mongo-gui-dark', 'mongo-gui-light']).toContain(
      (captured.props as { theme: string }).theme,
    );
  });
});
