import { useComputedColorScheme } from '@mantine/core';
import Editor from '@monaco-editor/react';
import { useEffect, useRef } from 'react';
import './monaco-setup';
import { defineEditorThemes, themeFor } from './editor-theme';
import { registerMongoshTokens } from './mongosh-tokens';
import { useEditorFontSize } from './use-editor-font-size';
import type { ReadOnlyCodeProps } from './ReadOnlyCode';
import { readOnlyLanguage } from './read-only-language';
import { APP_FONT } from '../../theme/theme';

/** Scrolling within this many pixels of the end asks for more. */
const NEAR_END_PX = 200;

/** Read-only Monaco with folding and find. Loaded lazily by ReadOnlyCode. */
export function ReadOnlyMonaco({ label, value, language, wrap, onNearEnd }: ReadOnlyCodeProps) {
  const scheme = useComputedColorScheme('dark');
  const fontSize = useEditorFontSize();
  const nearEnd = useRef(onNearEnd);
  useEffect(() => {
    nearEnd.current = onNearEnd;
  }, [onNearEnd]);
  return (
    <Editor
      height="100%"
      language={readOnlyLanguage(language, value.length)}
      theme={themeFor(scheme)}
      beforeMount={(monaco) => {
        defineEditorThemes(monaco);
        registerMongoshTokens(monaco);
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
        fontSize,
        fontFamily: APP_FONT,
        tabSize: 2,
        wordWrap: wrap === true ? 'on' : 'off',
        automaticLayout: true,
        folding: true,
        lineNumbersMinChars: 3,
        // Each of these sends the whole text to the editor worker, which keeps a second copy.
        links: false,
        occurrencesHighlight: 'off',
        matchBrackets: 'never',
        colorDecorators: false,
        quickSuggestions: false,
      }}
    />
  );
}
