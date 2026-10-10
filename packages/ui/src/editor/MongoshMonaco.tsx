import { useComputedColorScheme } from '@mantine/core';
import Editor, { type OnMount } from '@monaco-editor/react';
import { useEffect, useRef } from 'react';
import type * as Monaco from 'monaco-editor/editor/editor.api';
import { editorUiEvents, insertionText } from './editor-events';
import {
  clearCompletionSource,
  MONGOSH_LANGUAGE,
  registerMongoshLanguage,
  setCompletionSource,
} from './mongosh-language';
import type { CompletionSource } from './completion-source';
import type { MongoshEditorProps, RunRequest } from './MongoshEditor';

/**
 * The Monaco editor for one tab. Loaded lazily by MongoshEditor, so Monaco is not evaluated until
 * an editor opens. Ctrl+Enter runs the selection or the statement, and Ctrl+Shift+Enter runs all.
 */
/** The text before the selection start and after its end, for an insert. */
function textAround(
  model: Monaco.editor.ITextModel | null,
  selection: Monaco.Selection,
): { before: string; after: string } {
  if (model === null) {
    return { before: '', after: '' };
  }
  const start = selection.getStartPosition();
  const end = selection.getEndPosition();
  const last = model.getLineCount();
  return {
    before: model.getValueInRange({
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: start.lineNumber,
      endColumn: start.column,
    }),
    after: model.getValueInRange({
      startLineNumber: end.lineNumber,
      startColumn: end.column,
      endLineNumber: last,
      endColumn: model.getLineMaxColumn(last),
    }),
  };
}

/** The editor action each toolbar command runs. */
const COMMAND_ACTIONS = {
  run: 'mongo-gui.run',
  runAll: 'mongo-gui.run-all',
  explain: 'mongo-gui.explain',
} as const;

export function MongoshMonaco({
  tabId,
  label,
  value,
  source,
  onChange,
  onRun,
  onRunAll,
  onExplain,
}: MongoshEditorProps) {
  const scheme = useComputedColorScheme('dark');
  // Handlers read the latest props, because Monaco keeps the callbacks it got on mount.
  const latest = useRef({ onRun, onRunAll, onExplain, source });
  const modelUri = useRef<string | undefined>(undefined);
  useEffect(() => {
    latest.current = { onRun, onRunAll, onExplain, source };
  }, [onRun, onRunAll, onExplain, source]);

  // Keeps the editor's completion source in the registry. The registry reads the ref on each call.
  useEffect(() => {
    return () => {
      if (modelUri.current !== undefined) {
        clearCompletionSource(modelUri.current);
      }
    };
  }, []);

  const handleMount: OnMount = (editor, monaco) => {
    registerMongoshLanguage(monaco);
    const model = editor.getModel();
    if (model !== null) {
      modelUri.current = model.uri.toString();
      const relay: CompletionSource = {
        complete: (code, offset, signal) =>
          latest.current.source?.complete(code, offset, signal) ?? Promise.resolve([]),
        refreshFields: () => latest.current.source?.refreshFields(),
      };
      setCompletionSource(model.uri.toString(), relay);
    }
    const runAt = (
      request: (value: string, cursor: number, selection: RunRequest['selection']) => void,
    ) => {
      const current = editor.getModel();
      if (current === null) {
        return;
      }
      const selection = editor.getSelection();
      const range =
        selection === null || selection.isEmpty()
          ? undefined
          : {
              start: current.getOffsetAt(selection.getStartPosition()),
              end: current.getOffsetAt(selection.getEndPosition()),
            };
      const position = editor.getPosition();
      const cursor = position === null ? 0 : current.getOffsetAt(position);
      request(current.getValue(), cursor, range);
    };
    editor.addAction({
      id: 'mongo-gui.run',
      label: 'Run statement',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter],
      run: () => {
        runAt((code, cursor, selection) => latest.current.onRun({ code, cursor, selection }));
      },
    });
    editor.addAction({
      id: 'mongo-gui.explain',
      label: 'Explain statement',
      run: () => {
        runAt((code, cursor, selection) => latest.current.onExplain({ code, cursor, selection }));
      },
    });
    editor.addAction({
      id: 'mongo-gui.run-all',
      label: 'Run all',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.Enter],
      run: () => {
        latest.current.onRunAll(editor.getModel()?.getValue() ?? '');
      },
    });
    const subscription = editorUiEvents.subscribe((event) => {
      if (event.tabId !== tabId) {
        return;
      }
      if (event.type === 'editor:command') {
        editor.trigger('toolbar', COMMAND_ACTIONS[event.command], null);
        return;
      }
      if (event.type !== 'editor:insert') {
        return;
      }
      const selection = editor.getSelection();
      if (selection !== null) {
        const { before, after } = textAround(editor.getModel(), selection);
        const text = insertionText(before, after, event.text);
        editor.executeEdits('mongo-gui.insert', [
          { range: selection, text, forceMoveMarkers: true },
        ]);
      }
      editor.focus();
    });
    editor.onDidDispose(() => subscription());
  };

  return (
    <Editor
      path={`inmemory://mongo-gui/${tabId}.mongosh`}
      height="100%"
      language={MONGOSH_LANGUAGE}
      theme={scheme === 'dark' ? 'vs-dark' : 'vs'}
      value={value}
      onChange={(next) => onChange(next ?? '')}
      onMount={handleMount}
      options={{
        ariaLabel: label,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        fontSize: 13,
        tabSize: 2,
        wordWrap: 'on',
        automaticLayout: true,
        lineNumbersMinChars: 3,
        suggestOnTriggerCharacters: true,
        parameterHints: { enabled: true },
        quickSuggestions: { other: true, comments: false, strings: false },
      }}
    />
  );
}
