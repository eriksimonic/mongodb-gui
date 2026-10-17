import { ActionIcon, Box, Loader, useComputedColorScheme } from '@mantine/core';
import Editor from '@monaco-editor/react';
import { IconChevronDown, IconChevronUp } from '@tabler/icons-react';
import { lazy, Suspense, useState } from 'react';
import '../kit/code/monaco-setup';
import { defineEditorThemes, themeFor } from '../kit/code/editor-theme';
import { MONGOSH_LANGUAGE, registerMongoshTokens } from '../kit/code/mongosh-tokens';
import { useEditorFontSize } from '../kit/code/use-editor-font-size';
import { CODE_FONT } from '../theme/theme';

export interface CommandEditorProps {
  readonly value: string;
  readonly language: 'mongosh' | 'json';
  readonly onChange: (value: string) => void;
  /** Ctrl+Enter or F5. */
  readonly onRun: () => void;
}

const COMPACT_HEIGHT_PX = 44;
const LINE_HEIGHT_PX = 20;
const EDITOR_PADDING_PX = 12;

function CommandMonaco({ value, language, onChange, onRun }: CommandEditorProps) {
  const scheme = useComputedColorScheme('dark');
  const fontSize = useEditorFontSize();
  return (
    <Editor
      height="100%"
      language={language === 'json' ? 'json' : MONGOSH_LANGUAGE}
      theme={themeFor(scheme)}
      beforeMount={(monaco) => {
        defineEditorThemes(monaco);
        registerMongoshTokens(monaco);
      }}
      value={value}
      onChange={(next) => onChange(next ?? '')}
      onMount={(editor, monaco) => {
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, onRun);
        editor.addCommand(monaco.KeyCode.F5, onRun);
      }}
      options={{
        ariaLabel: 'Explain command',
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        lineNumbers: 'off',
        glyphMargin: false,
        folding: false,
        lineDecorationsWidth: 0,
        overviewRulerLanes: 0,
        renderLineHighlight: 'none',
        scrollbar: { vertical: 'auto', horizontal: 'hidden' },
        padding: { top: 6, bottom: 6 },
        fontSize,
        fontFamily: CODE_FONT,
        wordWrap: 'on',
        automaticLayout: true,
      }}
    />
  );
}

const LazyCommandMonaco = lazy(() => Promise.resolve({ default: CommandMonaco }));

/**
 * The colour-coded editor of the explained command. Compact by default. A text of several lines
 * opens it to fit, up to 40% of the panel, until the user collapses it. Monaco loads on first use.
 */
export function CommandEditor(props: CommandEditorProps) {
  const [choice, setChoice] = useState<boolean | undefined>(undefined);
  const lines = props.value.split('\n').length;
  const expanded = choice ?? lines > 1;
  const height = expanded
    ? Math.max(COMPACT_HEIGHT_PX, lines * LINE_HEIGHT_PX + EDITOR_PADDING_PX)
    : COMPACT_HEIGHT_PX;
  return (
    <Box
      className="mg-explain-command"
      data-testid="explain-command"
      data-expanded={expanded ? 'true' : undefined}
      style={{ height, maxHeight: expanded ? '40%' : COMPACT_HEIGHT_PX }}
    >
      <Suspense fallback={<Loader size="xs" aria-label="Loading the command" m={8} />}>
        <LazyCommandMonaco {...props} />
      </Suspense>
      <ActionIcon
        className="mg-explain-command-toggle"
        size="sm"
        variant="subtle"
        aria-label={expanded ? 'Collapse the command' : 'Expand the command'}
        aria-expanded={expanded}
        onClick={() => setChoice(!expanded)}
      >
        {expanded ? <IconChevronUp size={14} /> : <IconChevronDown size={14} />}
      </ActionIcon>
    </Box>
  );
}
