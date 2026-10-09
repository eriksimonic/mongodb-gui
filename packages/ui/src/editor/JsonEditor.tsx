import { Box, Loader } from '@mantine/core';
import { lazy, Suspense } from 'react';

export interface JsonEditorProps {
  readonly value: string;
  /** Called with the new text on every edit. Read-only editors omit it. */
  readonly onChange?: ((value: string) => void) | undefined;
  readonly label: string;
  readonly readOnly?: boolean;
  readonly height?: number | string;
}

// Monaco is large and touches the DOM when it loads, so it loads on first use.
const MonacoJsonEditor = lazy(() =>
  import('./MonacoJsonEditor').then((module) => ({ default: module.MonacoJsonEditor })),
);

const DEFAULT_HEIGHT_PX = 200;

/** Monaco in JSON mode. The text is EJSON, so it is shown and edited as plain JSON. */
export function JsonEditor(props: JsonEditorProps) {
  const height = props.height ?? DEFAULT_HEIGHT_PX;
  return (
    <Suspense
      fallback={
        <Box h={height} style={{ display: 'grid', placeItems: 'center' }}>
          <Loader size="xs" aria-label={`Loading ${props.label}`} />
        </Box>
      }
    >
      <MonacoJsonEditor {...props} height={height} />
    </Suspense>
  );
}
