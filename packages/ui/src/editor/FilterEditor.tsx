import { Box, Input, Loader, Stack } from '@mantine/core';
import { lazy, Suspense, useId } from 'react';

/** The collection whose fields the editor offers as keys. Without it the editor offers operators only. */
interface FilterFieldScope {
  readonly connectionId: string;
  readonly database: string;
  readonly collection: string;
}

export interface FilterEditorProps {
  readonly value: string;
  /** Called with the new text on every edit. */
  readonly onChange: (value: string) => void;
  /** The accessible name, for example "Filter". */
  readonly ariaLabel: string;
  /** Shown under the editor, and marks the editor invalid for assistive technology. */
  readonly error?: string | undefined;
  readonly fields?: FilterFieldScope | undefined;
  readonly readOnly?: boolean | undefined;
}

// Monaco is large and touches the DOM when it loads, so it loads on first use, as JsonEditor does.
const MonacoFilterEditor = lazy(() =>
  import('./MonacoFilterEditor').then((module) => ({ default: module.MonacoFilterEditor })),
);

// The height of three lines, which is where the editor starts.
const FALLBACK_HEIGHT_PX = 72;

/**
 * A compact Extended JSON editor for a filter. Typing a key offers the fields of `fields`, and
 * typing a value offers the Extended JSON forms. Tab leaves the field, and Escape closes a
 * suggestion list before it reaches a surrounding modal.
 */
export function FilterEditor({
  value,
  onChange,
  ariaLabel,
  error,
  fields,
  readOnly = false,
}: FilterEditorProps) {
  const errorId = useId();
  return (
    <Stack gap={4}>
      <Box
        style={{
          border: '1px solid',
          borderColor:
            error === undefined
              ? 'var(--mantine-color-default-border)'
              : 'var(--mantine-color-error)',
          borderRadius: 'var(--mantine-radius-sm)',
          overflow: 'hidden',
        }}
      >
        <Suspense
          fallback={
            <Box h={FALLBACK_HEIGHT_PX} style={{ display: 'grid', placeItems: 'center' }}>
              <Loader size="xs" aria-label={`Loading ${ariaLabel}`} />
            </Box>
          }
        >
          <MonacoFilterEditor
            value={value}
            onChange={onChange}
            ariaLabel={ariaLabel}
            error={error}
            errorId={errorId}
            fields={fields}
            readOnly={readOnly}
          />
        </Suspense>
      </Box>
      {error === undefined ? null : <Input.Error id={errorId}>{error}</Input.Error>}
    </Stack>
  );
}
