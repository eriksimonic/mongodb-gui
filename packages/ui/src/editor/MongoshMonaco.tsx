import { useComputedColorScheme } from '@mantine/core';
import Editor, { type BeforeMount, type OnMount } from '@monaco-editor/react';
import { useEffect, useRef } from 'react';
import type * as Monaco from 'monaco-editor/editor/editor.api';
import { editorUiEvents, insertionText, markerRanges } from './editor-events';
import { defineEditorThemes, themeFor } from './editor-theme';
import {
  clearCompletionSource,
  MONGOSH_LANGUAGE,
  registerMongoshLanguage,
  setCompletionSource,
} from './mongosh-language';
import { registerSqlLanguage, SQL_LANGUAGE } from './sql-language';
import type { CompletionSource } from './completion-source';
import type { MongoshEditorProps, RunRequest } from './MongoshEditor';

/** The owner of the error markers the run flow sets, so clearing them leaves other owners alone. */
const MARKER_OWNER = 'sql';

/**
 * The Monaco editor for one tab. Loaded lazily by MongoshEditor, so Monaco is not evaluated until
 * an editor opens. F5 and Ctrl+Enter run the selection or the statement, and Ctrl+Shift+Enter runs
 * all.
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
  language,
  value,
  source,
  onChange,
  onRun,
  onRunAll,
  onExplain,
}: MongoshEditorProps) {
  const scheme = useComputedColorScheme('dark');
  // Handlers read the latest props, because Monaco keeps the callbacks it got on mount.
  const latest = useRef({ onRun, onRunAll, onExplain, source, value });
  const modelUri = useRef<string | undefined>(undefined);
  useEffect(() => {
    latest.current = { onRun, onRunAll, onExplain, source, value };
  }, [onRun, onRunAll, onExplain, source, value]);

  // Keeps the editor's completion source in the registry. The registry reads the ref on each call.
  useEffect(() => {
    return () => {
      if (modelUri.current !== undefined) {
        clearCompletionSource(modelUri.current);
      }
    };
  }, []);

  // The themes must exist before the editor takes one by name.
  const handleBeforeMount: BeforeMount = (monaco) => {
    defineEditorThemes(monaco);
  };

  const handleMount: OnMount = (editor, monaco) => {
    registerMongoshLanguage(monaco);
    registerSqlLanguage(monaco);
    const relay: CompletionSource = {
      complete: (code, offset, signal) =>
        latest.current.source?.complete(code, offset, signal) ?? Promise.resolve([]),
      fieldsOf: (collection) => latest.current.source?.fieldsOf(collection) ?? Promise.resolve([]),
      collections: () => latest.current.source?.collections() ?? Promise.resolve([]),
      refreshFields: () => latest.current.source?.refreshFields(),
    };
    // A language change gives the editor a new model under a new path. The relay follows the
    // model, and a model reused from an earlier flip takes the tab's current text.
    const attach = (model: Monaco.editor.ITextModel | null): void => {
      if (modelUri.current !== undefined) {
        clearCompletionSource(modelUri.current);
        modelUri.current = undefined;
      }
      if (model === null) {
        return;
      }
      modelUri.current = model.uri.toString();
      setCompletionSource(modelUri.current, relay);
      if (model.getValue() !== latest.current.value) {
        model.setValue(latest.current.value);
      }
    };
    attach(editor.getModel());
    editor.onDidChangeModel(() => attach(editor.getModel()));
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
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, monaco.KeyCode.F5],
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
      if (event.type === 'editor:markers') {
        const model = editor.getModel();
        if (model === null) {
          return;
        }
        monaco.editor.setModelMarkers(
          model,
          MARKER_OWNER,
          markerRanges(model.getValue(), event.markers).map((range) => ({
            ...range,
            severity: monaco.MarkerSeverity.Error,
          })),
        );
        const clear = model.onDidChangeContent(() => {
          monaco.editor.setModelMarkers(model, MARKER_OWNER, []);
          clear.dispose();
        });
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
      path={`inmemory://mongo-gui/${tabId}.${language === 'sql' ? 'sql' : 'mongosh'}`}
      height="100%"
      language={language === 'sql' ? SQL_LANGUAGE : MONGOSH_LANGUAGE}
      theme={themeFor(scheme)}
      beforeMount={handleBeforeMount}
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
