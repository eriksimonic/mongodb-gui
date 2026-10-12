import { useComputedColorScheme } from '@mantine/core';
import Editor from '@monaco-editor/react';
import { useEffect, useRef } from 'react';
import './monaco-setup';
import { defineEditorThemes, themeFor } from './editor-theme';
import { registerMongoshLanguage } from './mongosh-language';
import type { ReadOnlyCodeProps } from './ReadOnlyCode';

/** Scrolling within this many pixels of the end asks for more. */
const NEAR_END_PX = 200;

/** Read-only Monaco with folding and find. Loaded lazily by ReadOnlyCode. */
export function ReadOnlyMonaco({ label, value, language, wrap, onNearEnd }: ReadOnlyCodeProps) {
  const scheme = useComputedColorScheme('dark');
  const nearEnd = useRef(onNearEnd);
  useEffect(() => {
    nearEnd.current = onNearEnd;
  }, [onNearEnd]);
  return (
    <Editor
      height="100%"
      language={language}
      theme={themeFor(scheme)}
      beforeMount={(monaco) => {
        defineEditorThemes(monaco);
        registerMongoshLanguage(monaco);
      }}
      value={value}
      onMount={(editor) => {
        editor.onDidScrollChange(() => {
          const bottom = editor.getScrollTop() + editor.getLayoutInfo().height;
          if (bottom >= editor.getScrollHeight() - NEAR_END_PX) {
            nearEnd.current?.();
          }
        });
      }}
      options={{
        ariaLabel: label,
        readOnly: true,
        domReadOnly: true,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        fontSize: 13,
        tabSize: 2,
        wordWrap: wrap === true ? 'on' : 'off',
        automaticLayout: true,
        folding: true,
        lineNumbersMinChars: 3,
      }}
    />
  );
}
