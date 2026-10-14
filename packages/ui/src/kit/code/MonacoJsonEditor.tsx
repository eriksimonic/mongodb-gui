import { useComputedColorScheme } from '@mantine/core';
import Editor from '@monaco-editor/react';
import { useMemo } from 'react';
import './monaco-setup';
import { useEditorFontSize } from './use-editor-font-size';
import type { JsonEditorHandle, JsonEditorProps } from './JsonEditor';
import { CODE_FONT } from '../../theme/theme';
import { defineEditorThemes, themeFor } from './editor-theme';

/** Monaco in JSON mode. Loaded lazily by JsonEditor, so Monaco is not evaluated outside the editors. */
export function MonacoJsonEditor({
  value,
  onChange,
  label,
  readOnly = false,
  height = 200,
  onEditorReady,
}: JsonEditorProps) {
  // Follows the app's colour scheme. The dark theme is the default, as in the rest of the app.
  const scheme = useComputedColorScheme('dark');
  // The saved font size. Monaco applies a changed options object in place, so the editor keeps its text.
  const fontSize = useEditorFontSize();
  const options = useMemo(
    () => ({
      ariaLabel: label,
      readOnly,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      fontSize,
      fontFamily: CODE_FONT,
      tabSize: 2,
      wordWrap: 'on' as const,
      automaticLayout: true,
      lineNumbersMinChars: 3,
    }),
    [label, readOnly, fontSize],
  );
  return (
    <Editor
      height={height}
      language="json"
      theme={themeFor(scheme)}
      beforeMount={defineEditorThemes}
      value={value}
      onChange={(next) => onChange?.(next ?? '')}
      options={options}
      onMount={(editor) => {
        const handle: JsonEditorHandle = {
          reveal: (span) => {
            const range = {
              startLineNumber: span.line,
              startColumn: span.column,
              endLineNumber: span.line,
              endColumn: span.column + span.length,
            };
            editor.setSelection(range);
            editor.revealRangeInCenter(range);
          },
        };
        onEditorReady?.(handle);
      }}
    />
  );
}
