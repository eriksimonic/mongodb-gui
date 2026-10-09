import { Box, Loader } from '@mantine/core';
import { lazy, Suspense } from 'react';

export interface ReadOnlyCodeProps {
  readonly label: string;
  readonly value: string;
  /** `json` for canonical and relaxed text, `javascript` for mongosh syntax. */
  readonly language: 'json' | 'javascript';
}

// Monaco loads on first use, as in the other editors.
const ReadOnlyMonaco = lazy(() =>
  import('./ReadOnlyMonaco').then((module) => ({ default: module.ReadOnlyMonaco })),
);

/** Read-only Monaco with folding and find. Fills its parent, which must have a height. */
export function ReadOnlyCode(props: ReadOnlyCodeProps) {
  return (
    <Suspense
      fallback={
        <Box h="100%" style={{ display: 'grid', placeItems: 'center' }}>
          <Loader size="xs" aria-label={`Loading ${props.label}`} />
        </Box>
      }
    >
      <Box h="100%" style={{ minHeight: 0 }}>
        <ReadOnlyMonaco {...props} />
      </Box>
    </Suspense>
  );
}
