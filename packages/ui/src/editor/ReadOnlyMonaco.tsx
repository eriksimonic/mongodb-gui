import { useComputedColorScheme } from '@mantine/core';
import Editor from '@monaco-editor/react';
import './monaco-setup';
import type { ReadOnlyCodeProps } from './ReadOnlyCode';

/** Read-only Monaco with folding and find. Loaded lazily by ReadOnlyCode. */
export function ReadOnlyMonaco({ label, value, language }: ReadOnlyCodeProps) {
  const scheme = useComputedColorScheme('dark');
  return (
    <Editor
      height="100%"
      language={language}
      theme={scheme === 'dark' ? 'vs-dark' : 'vs'}
      value={value}
      options={{
        ariaLabel: label,
        readOnly: true,
        domReadOnly: true,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        fontSize: 13,
        tabSize: 2,
        wordWrap: 'off',
        automaticLayout: true,
        folding: true,
        lineNumbersMinChars: 3,
      }}
    />
  );
}
