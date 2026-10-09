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
  return (
    <Editor
      height={height}
      language="json"
      theme="vs-dark"
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
