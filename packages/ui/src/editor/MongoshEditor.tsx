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

export interface MongoshEditorProps {
  /** Names the tab. The insert events of the Output and history panels reach the tab by this id. */
  readonly tabId: string;
  readonly label: string;
  readonly value: string;
  readonly source: CompletionSource | undefined;
  readonly onChange: (value: string) => void;
  readonly onRun: (request: RunRequest) => void;
  readonly onRunAll: (code: string) => void;
  /** Explains the statement under the cursor, or the selection. */
  readonly onExplain: (request: RunRequest) => void;
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
