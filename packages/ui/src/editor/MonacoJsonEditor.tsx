import { useComputedColorScheme } from '@mantine/core';
import Editor from '@monaco-editor/react';
import { useMemo } from 'react';
import { useAppStore } from '../state/app-store-context';
import './monaco-setup';
import type { JsonEditorProps } from './JsonEditor';

/** Used before the saved settings load, and while the vault is locked. */
const DEFAULT_EDITOR_FONT_SIZE = 13;

/** Monaco in JSON mode. Loaded lazily by JsonEditor, so Monaco is not evaluated outside the editors. */
export function MonacoJsonEditor({
  value,
  onChange,
  label,
  readOnly = false,
  height = 200,
}: JsonEditorProps) {
  // Follows the app's colour scheme. The dark theme is the default, as in the rest of the app.
  const scheme = useComputedColorScheme('dark');
  // The saved font size. Monaco applies a changed options object in place, so the editor keeps its text.
  const fontSize = useAppStore(
    (state) => state.settings?.editorFontSize ?? DEFAULT_EDITOR_FONT_SIZE,
  );
  const options = useMemo(
    () => ({
      ariaLabel: label,
      readOnly,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      fontSize,
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
      theme={scheme === 'dark' ? 'vs-dark' : 'vs'}
      value={value}
      onChange={(next) => onChange?.(next ?? '')}
      options={options}
    />
  );
}
