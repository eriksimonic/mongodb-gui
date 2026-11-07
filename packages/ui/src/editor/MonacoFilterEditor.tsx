import { useComputedColorScheme } from '@mantine/core';
import Editor from '@monaco-editor/react';
import type * as Monaco from 'monaco-editor/editor/editor.api';
import { useEffect, useId, useMemo, useState } from 'react';
import { useUiApi } from '../api/ui-api';
import '../kit/code/monaco-setup';
import { defineEditorThemes, themeFor } from '../kit/code/editor-theme';
import { useEditorFontSize } from '../kit/code/use-editor-font-size';
import { CODE_FONT } from '../theme/theme';
import { createCompletionSource } from './completion-source';
import {
  clearFilterFields,
  filterModelPath,
  registerFilterLanguage,
  setFilterFields,
  type FilterFieldLoader,
} from './filter-language';
import type { FilterEditorProps } from './FilterEditor';

interface MonacoFilterEditorProps extends Pick<
  FilterEditorProps,
  'value' | 'onChange' | 'ariaLabel' | 'error' | 'fields'
> {
  /** Readonly editors keep the text and drop the edits. */
  readonly readOnly: boolean;
  /** The id of the error text, which the textarea names in aria-describedby. */
  readonly errorId: string;
}

const MIN_LINES = 3;
const MAX_LINES = 8;
const LINE_HEIGHT_PX = 20;
const PADDING_PX = 12;
const MANTINE_STOP_ATTRIBUTE = 'data-mantine-stop-propagation';

/** The element that takes focus: Monaco's edit context, or its textarea when the context is missing. */
function focusTargetOf(root: HTMLElement | null | undefined): Element | null {
  return root?.querySelector('[role="textbox"]') ?? root?.querySelector('textarea') ?? null;
}

/** The elements that can receive a key press in the editor. Escape is checked on whichever has focus. */
function keyboardTargetsOf(root: HTMLElement | null | undefined): Element[] {
  return root ? [...root.querySelectorAll('[role="textbox"], textarea')] : [];
}

/**
 * The node for Monaco's suggestion list. Monaco styles it under `.monaco-editor` and colours it by
 * the theme class. It sits one step above the Mantine modal, which stacks at --mantine-z-index-modal.
 */
function createOverflowNode(theme: string): HTMLDivElement {
  const node = document.createElement('div');
  setOverflowTheme(node, theme);
  node.style.position = 'absolute';
  node.style.top = '0';
  node.style.left = '0';
  node.style.zIndex = 'calc(var(--mantine-z-index-modal) + 1)';
  return node;
}

function setOverflowTheme(node: HTMLElement, theme: string): void {
  node.className = `monaco-editor ${theme}`;
}

/**
 * Monaco in JSON mode, sized to the text: three lines, growing to eight. It completes the field
 * names of the `fields` collection and the Extended JSON forms. The registry keys its completions
 * by this editor's model, so no other JSON editor sees them.
 */
export function MonacoFilterEditor({
  value,
  onChange,
  ariaLabel,
  error,
  errorId,
  fields,
  readOnly,
}: MonacoFilterEditorProps) {
  const scheme = useComputedColorScheme('dark');
  const theme = themeFor(scheme);
  const fontSize = useEditorFontSize();
  const id = useId();
  const modelPath = filterModelPath(id.replace(/\W/g, ''));
  // Monaco puts its suggestion list in this node. It sits on the body, because the transform of the
  // Mantine modal would place the list relative to the modal and clip it at the modal edges.
  const [overflow] = useState(() => createOverflowNode(theme));
  useEffect(() => {
    setOverflowTheme(overflow, theme);
  }, [overflow, theme]);
  useEffect(() => {
    document.body.append(overflow);
    return () => {
      overflow.remove();
    };
  }, [overflow]);
  const { rpc } = useUiApi();
  const connectionId = fields?.connectionId;
  const database = fields?.database;
  const collection = fields?.collection;
  // The sample cache of the completion source serves this editor. Monaco has no other fields source.
  const source = useMemo(() => {
    if (connectionId === undefined || database === undefined) {
      return undefined;
    }
    return createCompletionSource({
      rpc,
      connectionId,
      database: () => database,
      isBusy: () => false,
    });
  }, [rpc, connectionId, database]);
  const loadFields = useMemo<FilterFieldLoader>(
    () => () =>
      source !== undefined && collection !== undefined
        ? source.fieldsOf(collection)
        : Promise.resolve([]),
    [source, collection],
  );
  const [mounted, setMounted] = useState<
    { readonly uri: string; readonly editor: Monaco.editor.IStandaloneCodeEditor } | undefined
  >(undefined);

  useEffect(() => {
    if (mounted === undefined) {
      return undefined;
    }
    setFilterFields(mounted.uri, loadFields);
    return () => {
      clearFilterFields(mounted.uri);
    };
  }, [mounted, loadFields]);

  // Monaco takes no ARIA attributes as options, so they go on the element that takes focus.
  useEffect(() => {
    const target = focusTargetOf(mounted?.editor.getDomNode());
    if (target === null) {
      return;
    }
    if (error === undefined) {
      target.removeAttribute('aria-invalid');
      target.removeAttribute('aria-describedby');
    } else {
      target.setAttribute('aria-invalid', 'true');
      target.setAttribute('aria-describedby', errorId);
    }
  }, [mounted, error, errorId]);

  // Mantine closes a modal on Escape from a capture listener on the window, before any element sees
  // the key. Mantine skips that close when the event target has data-mantine-stop-propagation="true".
  // The attribute stays on the focus targets while the editor exists, so Escape never closes the
  // dialog from the editor. Monaco can replace its edit context node, so the guard also goes on a
  // focus target when it takes focus.
  useEffect(() => {
    const editorDom = mounted?.editor.getDomNode();
    if (editorDom === undefined || editorDom === null) {
      return undefined;
    }
    const guard = () => {
      for (const input of keyboardTargetsOf(editorDom)) {
        input.setAttribute(MANTINE_STOP_ATTRIBUTE, 'true');
      }
    };
    guard();
    editorDom.addEventListener('focusin', guard);
    return () => {
      editorDom.removeEventListener('focusin', guard);
      for (const input of keyboardTargetsOf(editorDom)) {
        input.removeAttribute(MANTINE_STOP_ATTRIBUTE);
      }
    };
  }, [mounted]);

  const lines = Math.min(MAX_LINES, Math.max(MIN_LINES, value.split('\n').length));
  const options = useMemo(
    () => ({
      ariaLabel,
      readOnly,
      fontSize,
      fontFamily: CODE_FONT,
      lineHeight: LINE_HEIGHT_PX,
      tabSize: 2,
      minimap: { enabled: false },
      lineNumbers: 'off' as const,
      glyphMargin: false,
      folding: false,
      lineDecorationsWidth: 0,
      overviewRulerLanes: 0,
      renderLineHighlight: 'none' as const,
      scrollBeyondLastLine: false,
      scrollbar: { vertical: 'auto' as const, horizontal: 'hidden' as const },
      padding: { top: 6, bottom: 6 },
      wordWrap: 'on' as const,
      automaticLayout: true,
      // The suggestion list opens over the dialog instead of being cut at this small box.
      overflowWidgetsDomNode: overflow,
      fixedOverflowWidgets: true,
      wordBasedSuggestions: 'off' as const,
      // Tab moves to the next field, unless a suggestion is open and Tab accepts it.
      tabFocusMode: true,
      // Keys are JSON strings, and Monaco does not suggest inside strings by default.
      quickSuggestions: { other: 'on' as const, strings: 'on' as const, comments: 'off' as const },
    }),
    [ariaLabel, readOnly, fontSize, overflow],
  );

  return (
    <Editor
      height={lines * LINE_HEIGHT_PX + PADDING_PX}
      language="json"
      path={modelPath}
      theme={theme}
      beforeMount={defineEditorThemes}
      value={value}
      onChange={(next) => {
        onChange(next ?? '');
      }}
      onMount={(editor, monaco) => {
        registerFilterLanguage(monaco);
        const uri = editor.getModel()?.uri.toString();
        if (uri !== undefined) {
          setMounted({ uri, editor });
        }
      }}
      options={options}
    />
  );
}
