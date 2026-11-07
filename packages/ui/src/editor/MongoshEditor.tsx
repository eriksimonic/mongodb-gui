import type { EditorLanguage, TextRange } from '@mongo-gui/core';
import { Box, Loader } from '@mantine/core';
import { lazy, Suspense } from 'react';
import type { CompletionSource } from './completion-source';
import type { Selection } from './statements';

/** What Run sends: the code, the cursor offset, and the selection when there is one. */
export interface RunRequest {
  readonly code: string;
  readonly cursor: number;
  readonly selection: Selection | undefined;
}

/** Replaces a range of the text as one undo step, and puts the cursor at the start of the range. */
export type ReplaceRange = (range: TextRange, replacement: string) => void;

export interface MongoshEditorProps {
  /** Names the tab. The insert events of the Output and history panels reach the tab by this id. */
  readonly tabId: string;
  readonly label: string;
  /** Picks the Monaco language and the completion provider. A change gives the tab a new model. */
  readonly language: EditorLanguage;
  readonly value: string;
  readonly source: CompletionSource | undefined;
  readonly onChange: (value: string) => void;
  readonly onRun: (request: RunRequest) => void;
  readonly onRunAll: (code: string) => void;
  /** Explains the statement under the cursor, or the selection. */
  readonly onExplain: (request: RunRequest) => void;
  /** Reports the cursor offset on mount and after each cursor move. */
  readonly onCursor?: (offset: number) => void;
  /** Gets the replace function on mount, and loses it when the editor is disposed. */
  readonly replaceRef?: { current: ReplaceRange | undefined };
}

// Monaco is large and touches the DOM when it loads, so it loads on first use.
const MongoshMonaco = lazy(() =>
  import('./MongoshMonaco').then((module) => ({ default: module.MongoshMonaco })),
);

/** The mongosh editor. Fills its parent, which must have a height. */
export function MongoshEditor(props: MongoshEditorProps) {
  return (
    <Suspense
      fallback={
        <Box h="100%" style={{ display: 'grid', placeItems: 'center' }}>
          <Loader size="xs" aria-label={`Loading ${props.label}`} />
        </Box>
      }
    >
      <Box h="100%" style={{ minHeight: 0 }}>
        <MongoshMonaco {...props} />
      </Box>
    </Suspense>
  );
}
