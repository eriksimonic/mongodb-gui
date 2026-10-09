import { useComputedColorScheme } from '@mantine/core';
import Editor from '@monaco-editor/react';
import './monaco-setup';
import type { JsonEditorProps } from './JsonEditor';

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
  return (
    <Editor
      height={height}
      language="json"
      theme={scheme === 'dark' ? 'vs-dark' : 'vs'}
      value={value}
      onChange={(next) => onChange?.(next ?? '')}
      options={{
        ariaLabel: label,
        readOnly,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        fontSize: 13,
        tabSize: 2,
        wordWrap: 'on',
        automaticLayout: true,
        lineNumbersMinChars: 3,
      }}
    />
  );
}
